// Git object formats: parsing commits, trees and tags, building new ones, walking the
// object graph, and diffing two trees. Everything here is pure over the store's buffers.

import { sha1Object, type GitObject, type ObjectType, type Repo, ZERO_OID } from './store.ts';

// -----------------------------------------------------------------------------------------------------------
// Commits
// -----------------------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's raw bytes into its headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit's raw bytes. `when` is Unix seconds; the timezone is +0000. */
export function buildCommit(
  tree: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
  when: number,
): Buffer {
  const ident = `${authorName} <${authorEmail}> ${when} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

// -----------------------------------------------------------------------------------------------------------
// Trees
// -----------------------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree's raw bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree's raw bytes from entries, sorted the way git sorts them (dirs as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The empty tree's sha (the well-known constant). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// -----------------------------------------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------------------------------------

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag's raw bytes. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = ZERO_OID;
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// -----------------------------------------------------------------------------------------------------------
// Object helpers on a repository
// -----------------------------------------------------------------------------------------------------------

/** Store an object and return its sha. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const sha = sha1Object(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

/** Read an object by sha; null when absent. */
export function getObject(repo: Repo, sha: string): GitObject | null {
  return repo.objects.get(sha) ?? null;
}

/** The type of an object; null when absent. */
export function objectType(repo: Repo, sha: string): ObjectType | null {
  return repo.objects.get(sha)?.type ?? null;
}

/**
 * Resolve a ref name, a branch name or a raw sha to a commit sha. A ref that points at an
 * annotated tag is peeled to the tag's target commit.
 */
export function resolveToCommit(repo: Repo, ref: string): string | null {
  let sha: string | null = null;
  if (/^[0-9a-f]{40}$/.test(ref)) sha = ref;
  else if (repo.refs.has(ref)) sha = repo.refs.get(ref) ?? null;
  else if (repo.refs.has(`refs/heads/${ref}`)) sha = repo.refs.get(`refs/heads/${ref}`) ?? null;
  else if (ref === 'HEAD') sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (sha === null) return null;
  for (let depth = 0; depth < 8; depth += 1) {
    const obj = getObject(repo, sha);
    if (obj === null) return null;
    if (obj.type === 'commit') return sha;
    if (obj.type === 'tag') {
      sha = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// -----------------------------------------------------------------------------------------------------------
// Trees: reading a path, and writing one path into a tree (building intermediate trees)
// -----------------------------------------------------------------------------------------------------------

/** Read a blob's sha and bytes at a path under a tree; null when the path is absent or a dir. */
export function readPath(repo: Repo, treeSha: string, path: string): { sha: string; data: Buffer } | null {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return null;
  let current = treeSha;
  for (let index = 0; index < parts.length; index += 1) {
    const obj = getObject(repo, current);
    if (obj === null || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((item) => item.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) {
      if (entry.mode === '40000') return null;
      const blob = getObject(repo, entry.sha);
      if (blob === null || blob.type !== 'blob') return null;
      return { sha: entry.sha, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

/**
 * Write one path into a tree, returning the new tree's sha. `blobSha` is null to delete the
 * path. Intermediate directories are created as needed; empty directories are pruned.
 */
export function writePath(repo: Repo, treeSha: string, path: string, blobSha: string | null): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return treeSha;
  const recurse = (currentSha: string, depth: number): string | null => {
    const obj = currentSha === EMPTY_TREE ? null : getObject(repo, currentSha);
    const entries: TreeEntry[] = obj !== null && obj.type === 'tree' ? parseTree(obj.data) : [];
    const name = parts[depth]!;
    const atLeaf = depth === parts.length - 1;
    const index = entries.findIndex((item) => item.name === name);
    if (atLeaf) {
      if (blobSha === null) {
        if (index < 0) return currentSha;
        entries.splice(index, 1);
      } else {
        const entry: TreeEntry = { mode: '100644', name, sha: blobSha };
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      }
    } else {
      const child = index < 0 ? EMPTY_TREE : entries[index]!.sha;
      const next = recurse(child, depth + 1);
      if (next === null) {
        if (index >= 0) entries.splice(index, 1);
      } else {
        const entry: TreeEntry = { mode: '40000', name, sha: next };
        if (index < 0) entries.push(entry);
        else entries[index] = entry;
      }
    }
    if (entries.length === 0) return null;
    return putObject(repo, 'tree', buildTree(entries));
  };
  return recurse(treeSha, 0) ?? EMPTY_TREE;
}

/** List every file path under a tree (recursively), as path -> blob sha. */
export function listFiles(repo: Repo, treeSha: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (sha: string, base: string): void => {
    const obj = getObject(repo, sha);
    if (obj === null || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.sha, path);
      else out.set(path, entry.sha);
    }
  };
  walk(treeSha, prefix);
  return out;
}

// -----------------------------------------------------------------------------------------------------------
// Reachability: the objects a set of tips needs, minus the objects a set of haves already has
// -----------------------------------------------------------------------------------------------------------

/** Every object sha reachable from `tips` (commits, their trees, blobs, and peeled tags). */
export function reachableFrom(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const obj = getObject(repo, sha);
    if (obj === null) continue;
    seen.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge base of two commits: the first common ancestor found by a breadth-first walk. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const sha = queueA.shift()!;
    if (ancestorsA.has(sha)) continue;
    ancestorsA.add(sha);
    const obj = getObject(repo, sha);
    if (obj !== null && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queueA.push(parent);
    }
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const sha = queueB.shift()!;
    if (ancestorsA.has(sha)) return sha;
    if (seenB.has(sha)) continue;
    seenB.add(sha);
    const obj = getObject(repo, sha);
    if (obj !== null && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queueB.push(parent);
    }
  }
  return null;
}

// -----------------------------------------------------------------------------------------------------------
// Diffing two trees, for pull-request files
// -----------------------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

/** A line-level change count between two blob texts (set difference, not a full diff). */
function changeCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  if (oldText === null && newText === null) return { additions: 0, deletions: 0 };
  if (oldText === null) {
    const lines = newText!.split('\n');
    return { additions: newText === '' ? 0 : lines.length, deletions: 0 };
  }
  if (newText === null) {
    const lines = oldText.split('\n');
    return { additions: 0, deletions: oldText === '' ? 0 : lines.length };
  }
  const oldLines = lineCounts(oldText);
  const newLines = lineCounts(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) {
    const before = oldLines.get(line) ?? 0;
    if (count > before) additions += count - before;
  }
  for (const [line, count] of oldLines) {
    const after = newLines.get(line) ?? 0;
    if (count > after) deletions += count - after;
  }
  return { additions, deletions };
}

/** The file-level changes between two trees (added, modified, removed). */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = listFiles(repo, baseTree);
  const head = listFiles(repo, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const baseSha = base.get(path);
    const headSha = head.get(path);
    if (baseSha === headSha) continue;
    if (baseSha === undefined) {
      const blob = getObject(repo, headSha!);
      const text = blob !== null ? blob.data.toString('utf8') : '';
      const counts = changeCounts(null, text);
      changes.push({ path, status: 'added', additions: counts.additions, deletions: 0 });
    } else if (headSha === undefined) {
      const blob = getObject(repo, baseSha);
      const text = blob !== null ? blob.data.toString('utf8') : '';
      const counts = changeCounts(text, null);
      changes.push({ path, status: 'removed', additions: 0, deletions: counts.deletions });
    } else {
      const oldBlob = getObject(repo, baseSha);
      const newBlob = getObject(repo, headSha);
      const counts = changeCounts(
        oldBlob !== null ? oldBlob.data.toString('utf8') : '',
        newBlob !== null ? newBlob.data.toString('utf8') : '',
      );
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}
