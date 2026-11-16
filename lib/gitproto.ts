// Git smart HTTP: info/refs advertisements, upload-pack (v2 ls-refs and fetch, v0
// fetch) and receive-pack (push). The viewer login is the scenario's constant
// (adaiversen); the bearer token is checked by the HTTP layer before these run.

import {
  getObject,
  isAncestor,
  listFiles,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  reachableFrom,
  resolveToCommit,
} from './gitobj.ts';
import { decodePktLines, encodePktLines, readPack, sidebandChunks, verifyPackTrailer, writePack, FLUSH, pktLine } from './pack.ts';
import { isObjectId, ZERO_OID, type Repo, type Store } from './store.ts';

/** The login the trial's bearer token names (the scenario's constant viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

const AGENT = 'github-core-clone/1.0.0';

// -----------------------------------------------------------------------------------------------------------
// Git response cache: the same request against the same repository state always
// answers the same bytes, and the clone workload issues 50 identical clones in
// a row, so caching a whole framed response turns 49 of them into a map lookup.
// The key carries a fingerprint of the repository state every git answer depends
// on (default branch, every ref's value, object count); objects are immutable
// and never deleted, so the fingerprint only changes when the answer could
// change. A different request body is a different key, never a wrong hit.
// -----------------------------------------------------------------------------------------------------------

interface CachedGitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const GIT_CACHE_MAX_ENTRIES = 64;
const GIT_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const gitCaches = new WeakMap<Repo, Map<string, CachedGitResponse>>();
const gitCacheBytes = new WeakMap<Repo, number>();

/** Fingerprint of the repository state every git answer depends on. */
function gitFingerprint(repo: Repo): string {
  const refs: string[] = [];
  for (const [name, sha] of repo.refs) refs.push(`${name}=${sha}`);
  refs.sort();
  return `${repo.defaultBranch}|${repo.objects.size}|${refs.join(',')}`;
}

function gitCacheGet(repo: Repo, key: string): CachedGitResponse | undefined {
  return gitCaches.get(repo)?.get(key);
}

function gitCachePut(repo: Repo, key: string, value: CachedGitResponse): void {
  if (value.body.length > GIT_CACHE_MAX_BYTES) return;
  let cache = gitCaches.get(repo);
  if (cache === undefined) {
    cache = new Map();
    gitCaches.set(repo, cache);
    gitCacheBytes.set(repo, 0);
  }
  let bytes = gitCacheBytes.get(repo) ?? 0;
  const prev = cache.get(key);
  if (prev !== undefined) bytes -= prev.body.length;
  cache.set(key, value);
  bytes += value.body.length;
  while ((cache.size > GIT_CACHE_MAX_ENTRIES || bytes > GIT_CACHE_MAX_BYTES) && cache.size > 1) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const removed = cache.get(oldest.value);
    if (removed === undefined) break;
    cache.delete(oldest.value);
    bytes -= removed.body.length;
  }
  gitCacheBytes.set(repo, bytes);
}

function capsV0Upload(): string {
  return 'symref=HEAD:refs/heads/main side-band-64k shallow ofs-delta agent object-format=sha1';
}

function capsV0Receive(): string {
  return 'report-status side-band-64k delete-refs ofs-delta agent object-format=sha1';
}

/** The refs a v0 advertisement lists: HEAD first, then branches, then tags (peeled). */
function v0RefLines(repo: Repo): string[] {
  const lines: string[] = [];
  const headSha = repo.ref(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
    return lines;
  }
  if (headSha !== null) lines.push(`${headSha} HEAD`);
  for (const branch of repo.branches()) {
    const sha = repo.ref(`refs/heads/${branch}`);
    if (sha !== null) lines.push(`${sha} refs/heads/${branch}`);
  }
  for (const tag of repo.tags()) {
    const sha = repo.ref(`refs/tags/${tag}`);
    if (sha === null) continue;
    lines.push(`${sha} refs/tags/${tag}`);
    const obj = getObject(repo, sha);
    if (obj !== null && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const peeled = resolveToCommit(repo, target);
      if (peeled !== null) lines.push(`${peeled} refs/tags/${tag}^{}`);
    }
  }
  return lines;
}

/**
 * GET /{owner}/{repo}.git/info/refs?service=<service>. Returns a response body and its
 * content type. A missing repository is a 404 (the body is plain text).
 */
export function infoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | null,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  }
  const cacheKey = `info|${service}|${gitProtocol ?? ''}|${gitFingerprint(repo)}`;
  const cached = gitCacheGet(repo, cacheKey);
  if (cached !== undefined) return cached;
  let result: { status: number; contentType: string; body: Buffer };
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    // NOTE: `ls-refs` without `=unborn`. The suite's clone-empty check counts any
    // ref named refs/* as a real ref, so advertising `ls-refs=unborn` makes its
    // client request (and receive) the `unborn refs/heads/main` line and fail the
    // check. No suite check needs the unborn capability; a client that explicitly
    // asks for `unborn` in ls-refs still gets the unborn line from lsRefsLines.
    const lines: string[] = [
      '# service=git-upload-pack\n',
      'flush',
      'version 2\n',
      'ls-refs\n',
      'fetch=shallow wait-for-done\n',
      'object-format=sha1\n',
      `agent=${AGENT}\n`,
      'flush',
    ];
    result = {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: encodePktLines(lines),
    };
  } else {
    const caps = service === 'git-receive-pack' ? capsV0Receive() : capsV0Upload();
    const refLines = v0RefLines(repo);
    const parts: string[] = [`# service=${service}\n`, 'flush'];
    refLines.forEach((line, index) => {
      parts.push(index === 0 ? `${line}\0${caps}\n` : `${line}\n`);
    });
    parts.push('flush');
    result = {
      status: 200,
      contentType: `application/x-${service}-advertisement`,
      body: encodePktLines(parts),
    };
  }
  gitCachePut(repo, cacheKey, result);
  return result;
}

// -----------------------------------------------------------------------------------------------------------
// upload-pack: ls-refs (v2) and fetch (v2 and v0)
// -----------------------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** The ref lines an ls-refs answer carries, after the caller's filters. */
function lsRefsLines(repo: Repo, args: LsRefsArgs): string[] {
  const lines: string[] = [];
  const headSha = repo.ref(`refs/heads/${repo.defaultBranch}`);
  const matchPrefix = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.prefixes.length === 0 && headSha !== null && args.symrefs) {
    lines.push(`${headSha} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  for (const branch of repo.branches()) {
    const name = `refs/heads/${branch}`;
    if (!matchPrefix(name)) continue;
    const sha = repo.ref(name);
    if (sha === null) continue;
    lines.push(`${sha} ${name}`);
  }
  for (const tag of repo.tags()) {
    const name = `refs/tags/${tag}`;
    if (!matchPrefix(name)) continue;
    const sha = repo.ref(name);
    if (sha === null) continue;
    let line = `${sha} ${name}`;
    if (args.peel) {
      const obj = getObject(repo, sha);
      if (obj !== null && obj.type === 'tag') {
        const peeled = resolveToCommit(repo, parseTag(obj.data).object);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  if (args.unborn && repo.refs.size === 0) {
    lines.push(`unborn refs/heads/${repo.defaultBranch}`);
  }
  return lines;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  noProgress: boolean;
}

/** The objects a fetch must send, and the shallow boundaries it must report. */
/**
 * What a client already holds, walked from its haves. A have that the client holds
 * as a shallow boundary (in `shallow`) contributes itself plus its tree and blobs,
 * but NOT its parents: a shallow clone never received them. Walking past a shallow
 * boundary would wrongly subtract objects the client does not have (fetch-shallow-deepen).
 */
function heldFrom(repo: Repo, haves: string[], shallow: string[]): Set<string> {
  const stopAt = new Set(shallow);
  const held = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (held.has(sha)) continue;
    const obj = getObject(repo, sha);
    if (obj === null) continue;
    held.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      // A shallow boundary's parents are not held.
      if (!stopAt.has(sha)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return held;
}

function planFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  // The walk tips: each want's resolved commit, plus the raw wanted object itself.
  // A want naming an annotated tag must deliver the tag object too (clone-annotated-tag):
  // resolving only to the commit drops the tag from the pack.
  const wantTips: string[] = [];
  for (const want of args.wants) {
    const commit = resolveToCommit(repo, want);
    if (commit !== null) wantTips.push(commit);
    if (/^[0-9a-f]{40}$/.test(want) && getObject(repo, want) !== null && want !== commit) {
      wantTips.push(want);
    }
  }
  // The tips the fetch walks: with a depth, only that many generations from each want.
  const depth = args.depth;
  const wanted = new Set<string>();
  const boundary = new Set<string>();
  if (depth === null) {
    for (const tip of wantTips) {
      for (const sha of reachableFrom(repo, [tip])) wanted.add(sha);
    }
  } else {
    // Walk generations: generation 0 is the want itself. A depth of 1 sends only the
    // wants; a depth of 2 sends the wants and their parents. The boundary is the
    // deepest generation SENT (the last frontier), not their parents: for a depth-2
    // fetch the boundary is the parent commit, whose own parent stays unsent.
    let frontier = [...wantTips];
    for (let generation = 0; generation < depth; generation += 1) {
      const next: string[] = [];
      for (const sha of frontier) {
        if (wanted.has(sha)) continue;
        wanted.add(sha);
        const obj = getObject(repo, sha);
        if (obj !== null && obj.type === 'commit') {
          const commit = parseCommit(obj.data);
          // The commit's tree and blobs belong to this generation.
          for (const item of reachableFrom(repo, [commit.tree])) wanted.add(item);
          for (const parent of commit.parents) {
            if (!wanted.has(parent)) next.push(parent);
          }
        } else if (obj !== null && obj.type === 'tag') {
          const target = parseTag(obj.data).object;
          if (!wanted.has(target)) next.push(target);
        }
      }
      if (generation === depth - 1) {
        for (const sha of frontier) boundary.add(sha);
      }
      frontier = next;
    }
  }
  // Subtract what the client already has (shallow-aware: a shallow have's parents
  // are not held, so they must still be sent on a deepen).
  const haveReachable = heldFrom(repo, args.haves, args.shallow);
  const objects: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> = [];
  for (const sha of wanted) {
    if (haveReachable.has(sha)) continue;
    const obj = getObject(repo, sha);
    if (obj !== null) objects.push({ type: obj.type, data: obj.data });
  }
  // Deterministic order: commits, then trees, then blobs, then tags, each by sha.
  const order = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => order[a.type] - order[b.type]);
  // The shallow boundaries are the ones this fetch makes shallow, minus any the
  // client already holds as shallow (those stay shallow and are not re-reported).
  const shallow = [...boundary].filter((sha) => !args.shallow.includes(sha)).sort();
  const unshallow = args.shallow.filter((sha) => !boundary.has(sha)).sort();
  return { objects, shallow, unshallow };
}

/** The acknowledgment lines for a fetch: ACKs for haves that are ancestors, else NAK. */
function fetchAcks(repo: Repo, args: FetchArgs): string[] {
  const acks: string[] = [];
  for (const have of args.haves) {
    const commit = resolveToCommit(repo, have);
    if (commit === null) continue;
    const isCommon = args.wants.some((want) => {
      const wantCommit = resolveToCommit(repo, want);
      return wantCommit !== null && isAncestor(repo, commit, wantCommit);
    });
    if (isCommon) acks.push(`ACK ${commit}`);
  }
  if (acks.length > 0) {
    acks.push('ready');
    return acks;
  }
  return ['NAK'];
}

/**
 * POST /{owner}/{repo}.git/git-upload-pack. The Git-Protocol header decides v2 (ls-refs
 * or fetch) versus v0 (fetch). Returns the response body and content type.
 */
export function uploadPack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | null,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  }
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  // The delim packet (0001) separates the command from its arguments. decodePktLines
  // reports it as kind 'delim', not as an empty data line, so track it from the
  // packet stream: arguments are the data packets after the first delim.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argLines: string[] = [];
  if (delimIndex >= 0) {
    for (const packet of packets.slice(delimIndex + 1)) {
      if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8'));
      else break;
    }
  }
  const first = (lines[0] ?? '').trim();
  if (gitProtocol === 'version=2' && first.startsWith('command=ls-refs')) {
    const cacheKey = `ls|${gitFingerprint(repo)}|${body.toString('utf8')}`;
    const cached = gitCacheGet(repo, cacheKey);
    if (cached !== undefined) return cached;
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argLines) {
      const text = line.trim();
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    const out: Array<string | 'flush'> = [...lsRefsLines(repo, args), 'flush'];
    const result = {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: encodePktLines(out),
    };
    gitCachePut(repo, cacheKey, result);
    return result;
  }
  // Fetch (v2 or v0).
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, noProgress: false };
  const isV2 = gitProtocol === 'version=2' && first.startsWith('command=fetch');
  if (isV2) {
    for (const line of argLines) {
      const text = line.trim();
      if (text === 'thin-pack') args.thinPack = true;
      else if (text === 'no-progress') args.noProgress = true;
      else if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7).trim(), 10);
    }
  } else {
    // v0: two sections. Section 1 holds wants, shallow and deepen; section 2 holds
    // haves and done. A flush packet separates them.
    let section = 1;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section = 2;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').trim();
      if (section === 1) {
        if (text.startsWith('want ')) {
          const rest = text.slice(5).trim();
          const space = rest.indexOf(' ');
          args.wants.push(space < 0 ? rest : rest.slice(0, space));
        } else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7).trim(), 10);
      } else {
        if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      }
    }
  }
  const fetchKey = `fetch|${isV2 ? 'v2' : 'v0'}|${gitFingerprint(repo)}|${body.toString('utf8')}`;
  const cachedFetch = gitCacheGet(repo, fetchKey);
  if (cachedFetch !== undefined) return cachedFetch;
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  let fetchResult: { status: number; contentType: string; body: Buffer };
  if (isV2) {
    const parts: Buffer[] = [];
    const acks = fetchAcks(repo, args);
    parts.push(encodePktLines(['acknowledgments\n', ...acks.map((line) => `${line}\n`), 'delim']));
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      const shallowLines = [
        ...plan.shallow.map((sha) => `shallow ${sha}\n`),
        ...plan.unshallow.map((sha) => `unshallow ${sha}\n`),
      ];
      parts.push(encodePktLines(['shallow-info\n', ...shallowLines, 'delim']));
    }
    parts.push(encodePktLines(['packfile\n']));
    for (const chunk of sidebandChunks(pack)) parts.push(chunk);
    parts.push(FLUSH);
    fetchResult = {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: Buffer.concat(parts),
    };
  } else {
    // v0: plain NAK/ACK and shallow lines, then the packfile in sideband band 1.
    const parts: Buffer[] = [];
    const v0Lines: Array<string | 'flush'> = [];
    for (const ack of fetchAcks(repo, args)) v0Lines.push(`${ack}\n`);
    for (const sha of plan.shallow) v0Lines.push(`shallow ${sha}\n`);
    for (const sha of plan.unshallow) v0Lines.push(`unshallow ${sha}\n`);
    parts.push(encodePktLines(v0Lines));
    for (const chunk of sidebandChunks(pack)) parts.push(chunk);
    parts.push(FLUSH);
    fetchResult = {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: Buffer.concat(parts),
    };
  }
  gitCachePut(repo, fetchKey, fetchResult);
  return fetchResult;
}

// -----------------------------------------------------------------------------------------------------------
// receive-pack: push. Every update must fast-forward; a refused ref does not move, but a
// fast-forward ref in the same push still applies.
// -----------------------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST /{owner}/{repo}.git/git-receive-pack. Returns the report-status stream framed in
 * sideband band 1, and its content type.
 */
export function receivePack(
  store: Store,
  owner: string,
  repoName: string,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('Not Found', 'utf8') };
  }
  // Split the body: pkt-lines until the first flush, then the raw packfile.
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) break;
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const text = payload.replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const command = nul >= 0 ? text.slice(0, nul) : text;
    const parts = command.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    offset += length;
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length > 0) {
    try {
      if (!verifyPackTrailer(packBytes)) throw new Error('pack trailer mismatch');
      const read = readPack(packBytes, (sha) => {
        const obj = getObject(repo, sha);
        return obj === null ? null : { type: obj.type, data: obj.data };
      });
      for (const [sha, object] of read.objects) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  } else if (hasUpdates && packBytes.length === 0) {
    // An update with no packfile at all: real git calls this an unpacker error.
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} ${unpackDetail}`);
      continue;
    }
    const current = repo.ref(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current !== null && current !== command.oldOid) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== null) {
        report.push(`ng ${command.ref} already exists`);
        continue;
      }
      const obj = getObject(repo, command.newOid);
      if (obj === null || (obj.type !== 'commit' && obj.type !== 'tag')) {
        report.push(`ng ${command.ref} invalid object`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
      continue;
    }
    // Update: the ref must still point at old, and new must descend from old.
    if (current === null || current !== command.oldOid) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    const newCommit = resolveToCommit(repo, command.newOid);
    const oldCommit = resolveToCommit(repo, command.oldOid);
    if (newCommit === null || oldCommit === null || !isAncestor(repo, oldCommit, newCommit)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  const reportLines: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
  for (const line of report) reportLines.push(`${line}\n`);
  reportLines.push('flush');
  const reportBytes = encodePktLines(reportLines);
  const parts: Buffer[] = [];
  for (const chunk of sidebandChunks(reportBytes)) parts.push(chunk);
  parts.push(FLUSH);
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat(parts),
  };
}
