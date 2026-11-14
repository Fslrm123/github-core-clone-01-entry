// pkt-line framing and packfile reading/writing. Packfiles are written without deltas
// (plain objects only); reading handles OFS_DELTA and REF_DELTA, including thin packs
// whose bases live in the repository.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { sha1Object, type ObjectType } from './store.ts';

// -----------------------------------------------------------------------------------------------------------
// pkt-line: a 4-hex length (counting itself) plus payload; 0000 flush, 0001 delim, 0002 end.
// -----------------------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines into packets. Stops at the first malformed line. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + length > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** Encode a list of lines (strings), 'flush' and 'delim' markers into one buffer. */
export function encodePktLines(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** A sideband packet: band byte (1 pack, 2 progress, 3 error) plus data, pkt-lined. */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split a buffer into sideband band-1 packets of at most `maxData` bytes of payload each. */
export function sidebandChunks(data: Buffer, maxData = 65515): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += maxData) {
    out.push(sideband(1, data.subarray(offset, Math.min(offset + maxData, data.length))));
  }
  if (data.length === 0) out.push(sideband(1, Buffer.alloc(0)));
  return out;
}

// -----------------------------------------------------------------------------------------------------------
// Packfile writing (no deltas)
// -----------------------------------------------------------------------------------------------------------

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The varint type+size header git puts before each object's zlib stream. */
function objectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining >>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a version-2 packfile of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(objects: Array<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(objectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -----------------------------------------------------------------------------------------------------------
// Packfile reading (deltas included)
// -----------------------------------------------------------------------------------------------------------

export interface PackObject {
  type: ObjectType;
  data: Buffer;
}

export interface PackRead {
  objects: Map<string, PackObject>;
  deltaCount: number;
}

/** Read a plain 7-bit varint from `buf` at `offset`; returns the value and bytes consumed. */
function readVarint(buf: Buffer, offset: number): { value: number; bytes: number } {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    const byte = buf[index]!;
    value |= (byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value, bytes: index - offset };
}

/**
 * Read an OFS_DELTA negative offset. The encoding is not a plain varint: the first byte
 * holds the low 7 bits, and each following byte adds one and then shifts by 7.
 */
function readOfsOffset(buf: Buffer, offset: number): { value: number; bytes: number } {
  let value = buf[offset]! & 0x7f;
  let index = offset + 1;
  while ((buf[index - 1]! & 0x80) !== 0) {
    value = ((value + 1) << 7) | (buf[index]! & 0x7f);
    index += 1;
  }
  return { value, bytes: index - offset };
}

/**
 * Inflate the zlib stream starting at `offset`, finding its exact length by binary search.
 * inflateSync ignores trailing bytes and throws on a truncated stream. A binary
 * search for the exact compressed length costs ~11 inflates per object; instead,
 * inflate the whole remainder once (one call), then anchor the end: a zlib stream
 * is [2-byte header][DEFLATE][4-byte Adler-32 of the plaintext, big-endian], so the
 * Adler-32 of the inflated data marks the stream's end. A candidate is verified by
 * inflating exactly that slice; a binary search is the fallback if no anchor is found.
 */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function inflateExact(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; length: number } {
  const data = inflateSync(buf.subarray(offset));
  if (data.length !== expectedSize) throw new Error('packfile: inflated size mismatch');
  // The Adler-32 trailer sits at the end of the zlib stream; find it.
  const adler = adler32(data);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler, 0);
  // The compressed stream is at most the plaintext size plus a small overhead.
  const searchEnd = Math.min(buf.length, offset + expectedSize + 64);
  let pos = buf.indexOf(needle, offset + 2);
  while (pos >= 0 && pos + 4 <= searchEnd) {
    const length = pos + 4 - offset;
    try {
      const check = inflateSync(buf.subarray(offset, offset + length));
      if (check.length === expectedSize && check.equals(data)) return { data, length };
    } catch {
      // Not the real trailer; keep searching.
    }
    pos = buf.indexOf(needle, pos + 1);
  }
  // Fallback: binary search for the smallest prefix that inflates to the size.
  let lo = 1;
  let hi = buf.length - offset;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const trial = inflateSync(buf.subarray(offset, offset + mid));
      if (trial.length === expectedSize) {
        best = mid;
        hi = mid - 1;
      } else {
        hi = mid - 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (best < 0) throw new Error('packfile: cannot inflate object');
  return { data: inflateSync(buf.subarray(offset, offset + best)), length: best };
}

/** Apply a git delta to a base object, returning the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const source = readVarint(delta, offset);
  offset += source.bytes;
  if (source.value !== base.length) throw new Error('packfile: delta base size mismatch');
  const target = readVarint(delta, offset);
  offset += target.bytes;
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let used = 0;
      if ((op & 0x01) !== 0) {
        copyOffset = delta[offset + used]!;
        used += 1;
      }
      if ((op & 0x02) !== 0) {
        copyOffset |= delta[offset + used]! << 8;
        used += 1;
      }
      if ((op & 0x04) !== 0) {
        copyOffset |= delta[offset + used]! << 16;
        used += 1;
      }
      if ((op & 0x08) !== 0) {
        copyOffset |= delta[offset + used]! << 24;
        used += 1;
      }
      if ((op & 0x10) !== 0) {
        copySize = delta[offset + used]!;
        used += 1;
      }
      if ((op & 0x20) !== 0) {
        copySize |= delta[offset + used]! << 8;
        used += 1;
      }
      if ((op & 0x40) !== 0) {
        copySize |= delta[offset + used]! << 16;
        used += 1;
      }
      offset += used;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('packfile: zero delta opcode');
    }
  }
  if (produced !== target.value) throw new Error('packfile: delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Read a packfile. `resolveBase` finds a base object by sha (for REF_DELTA thin packs):
 * the pack's own objects are consulted first, then the repository.
 */
export function readPack(buf: Buffer, resolveBase?: (sha: string) => PackObject | null): PackRead {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('packfile: bad header');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`packfile: version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, PackObject>();
  const byOffset = new Map<number, PackObject>();
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let headerByte = buf[offset]!;
    offset += 1;
    const typeCode = (headerByte >> 4) & 0x07;
    let size = headerByte & 0x0f;
    let shift = 4;
    while ((headerByte & 0x80) !== 0) {
      headerByte = buf[offset]!;
      offset += 1;
      size |= (headerByte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset, then the delta stream. The base sits earlier in the pack.
      const ofs = readOfsOffset(buf, offset);
      offset += ofs.bytes;
      const baseObject = byOffset.get(start - ofs.value);
      if (baseObject === undefined) throw new Error('packfile: ofs-delta base not in pack');
      const inflated = inflateExact(buf, offset, size);
      offset += inflated.length;
      const data = applyDelta(baseObject.data, inflated.data);
      const object: PackObject = { type: baseObject.type, data };
      objects.set(sha1Object(object.type, data), object);
      byOffset.set(start, object);
      deltaCount += 1;
    } else if (typeCode === 7) {
      // REF_DELTA: a 20-byte base sha, then the delta stream.
      const baseSha = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateExact(buf, offset, size);
      offset += inflated.length;
      let baseObject = objects.get(baseSha);
      if (baseObject === undefined && resolveBase !== undefined) {
        baseObject = resolveBase(baseSha) ?? undefined;
      }
      if (baseObject === undefined) throw new Error('packfile: ref-delta base not found');
      const data = applyDelta(baseObject.data, inflated.data);
      const object: PackObject = { type: baseObject.type, data };
      objects.set(sha1Object(object.type, data), object);
      byOffset.set(start, object);
      deltaCount += 1;
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`packfile: unknown type ${typeCode}`);
      const inflated = inflateExact(buf, offset, size);
      offset += inflated.length;
      const object: PackObject = { type, data: inflated.data };
      objects.set(sha1Object(type, inflated.data), object);
      byOffset.set(start, object);
    }
  }
  return { objects, deltaCount };
}

/** Verify a packfile's SHA-1 trailer (the raw SHA-1 of every byte before it). */
export function verifyPackTrailer(buf: Buffer): boolean {
  if (buf.length < 20) return false;
  const body = buf.subarray(0, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  return createHash('sha1').update(body).digest('hex') === trailer;
}
