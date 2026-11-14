// REST v3 under /api/v3: repositories, branches, commits, refs, contents, labels,
// issues and pull requests. Every reply is JSON with a non-empty X-GitHub-Request-Id;
// an unknown route is a JSON 404; a malformed JSON body is a 400 (the HTTP layer
// turns a body-parse failure into that before this runs).

import {
  buildCommit,
  buildTree,
  diffTrees,
  EMPTY_TREE,
  getObject,
  isAncestor,
  listFiles,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  readPath,
  resolveToCommit,
  writePath,
} from './gitobj.ts';
import { VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME } from './gitproto.ts';
import { type Issue, type PullRequest, type Repo, type Store, ZERO_OID } from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(body: unknown, headers?: Record<string, string>): RestResult {
  return { status: 200, body, headers };
}

function created(body: unknown): RestResult {
  return { status: 201, body };
}

function noContent(): RestResult {
  return { status: 204, body: null };
}

function notFound(message = 'Not Found'): RestResult {
  return { status: 404, body: { message } };
}

function unprocessable(message: string): RestResult {
  return { status: 422, body: { message } };
}

function conflict(message: string): RestResult {
  return { status: 405, body: { message } };
}

/** Parse a Link-header page: `?page=` and `?per_page=` (defaults 1 and 30). */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/**
 * Slice a list to one page and build the Link header (rel="next" when more follow).
 * The Link URL is absolute: the suite's sameOrigin check does `new URL(a).origin`,
 * which throws on a relative URL and fails the pagination check.
 */
function paginate<T>(items: T[], query: URLSearchParams, basePath: string, baseUrl: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    link = `<${baseUrl}${basePath}?${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

// -----------------------------------------------------------------------------------------------------------
// Object shapes
// -----------------------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    user: { login: VIEWER_LOGIN, id: 1000 },
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: { login: VIEWER_LOGIN, id: 1000 },
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

// -----------------------------------------------------------------------------------------------------------
// Repositories
// -----------------------------------------------------------------------------------------------------------

/** Resolve owner/repo to a repository the viewer owns; a stranger's name is a 404. */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

function createRepo(store: Store, body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return unprocessable('name is required');
  if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
    return unprocessable('Repository already exists');
  }
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  return created(repoJson(repo));
}

function listUserRepos(store: Store, query: URLSearchParams, baseUrl: string): RestResult {
  const repos = store.reposOf(VIEWER_LOGIN);
  const { page, link } = paginate(repos.map(repoJson), query, '/api/v3/user/repos', baseUrl);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return ok(page, headers);
}

// -----------------------------------------------------------------------------------------------------------
// Branches, commits and refs
// -----------------------------------------------------------------------------------------------------------

function listBranches(repo: Repo): RestResult {
  const branches = repo.branches().map((name) => ({
    name,
    commit: { sha: repo.ref(`refs/heads/${name}`) },
  }));
  return ok(branches);
}

function getBranch(repo: Repo, name: string): RestResult {
  const sha = repo.ref(`refs/heads/${name}`);
  if (sha === null) return notFound('Branch not found');
  return ok({ name, commit: { sha } });
}

function listCommits(repo: Repo, query: URLSearchParams): RestResult {
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveToCommit(repo, ref);
  if (tip === null) return ok([]);
  const commits: Array<{ sha: string; commit: { message: string } }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = getObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    commits.push({ sha, commit: { message: commit.message } });
    for (const parent of commit.parents) stack.push(parent);
  }
  return ok(commits);
}

function createRef(repo: Repo, body: Record<string, unknown>): RestResult {
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || sha === '') return unprocessable('ref and sha are required');
  if (repo.ref(ref) !== null) return unprocessable('Reference already exists');
  const target = resolveToCommit(repo, sha);
  if (target === null) return unprocessable('Invalid sha');
  repo.refs.set(ref, target);
  return created({ ref, object: { sha: target, type: 'commit' } });
}

function getRef(repo: Repo, ref: string): RestResult {
  const sha = repo.ref(ref);
  if (sha === null) return notFound('Reference not found');
  return ok({ ref, object: { sha, type: 'commit' } });
}

// -----------------------------------------------------------------------------------------------------------
// Contents: read and write files through commits
// -----------------------------------------------------------------------------------------------------------

/** The commit a contents operation works on: the branch tip, or null when it has none. */
function contentsTip(repo: Repo, branch: string | undefined): string | null {
  if (branch !== undefined) return resolveToCommit(repo, branch);
  return resolveToCommit(repo, repo.defaultBranch);
}

/** Create a commit on `branch` that writes `path` to `blobSha` (or deletes it). */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  blobSha: string | null,
  message: string,
): string {
  const tip = resolveToCommit(repo, branch);
  const baseTree = tip === null ? EMPTY_TREE : parseCommit(getObject(repo, tip)!.data).tree;
  const tree = writePath(repo, baseTree, path, blobSha);
  const when = store.clock.tick();
  const commitData = buildCommit(tree, tip === null ? [] : [tip], message, VIEWER_NAME, VIEWER_EMAIL, when);
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = store.clock.iso();
  return commitSha;
}

function putContents(
  store: Store,
  repo: Repo,
  path: string,
  body: Record<string, unknown>,
  query: URLSearchParams,
): RestResult {
  const message = typeof body.message === 'string' ? body.message : 'update';
  const content = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  // A branch that does not exist yet is created from the default branch's tip.
  if (repo.ref(`refs/heads/${branch}`) === null && branch !== repo.defaultBranch) {
    const defaultTip = resolveToCommit(repo, repo.defaultBranch);
    if (defaultTip !== null) repo.refs.set(`refs/heads/${branch}`, defaultTip);
  }
  const tip = resolveToCommit(repo, branch);
  const baseTree = tip === null ? EMPTY_TREE : parseCommit(getObject(repo, tip)!.data).tree;
  const existing = tip === null ? null : readPath(repo, baseTree, path);
  const contentBytes = Buffer.from(content, 'base64');
  if (existing !== null) {
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (sha === '') return unprocessable('sha is required to update a file');
    if (sha !== existing.sha) {
      return { status: 409, body: { message: 'sha does not match the current file' } };
    }
    const blobSha = putObject(repo, 'blob', contentBytes);
    const commitSha = commitFile(store, repo, branch, path, blobSha, message);
    return ok({
      content: { name: path.split('/').pop(), path, sha: blobSha, size: contentBytes.length, encoding: 'base64' },
      commit: { sha: commitSha },
    });
  }
  const blobSha = putObject(repo, 'blob', contentBytes);
  const commitSha = commitFile(store, repo, branch, path, blobSha, message);
  return created({
    content: { name: path.split('/').pop(), path, sha: blobSha, size: contentBytes.length, encoding: 'base64' },
    commit: { sha: commitSha },
  });
}

function getContents(repo: Repo, path: string, query: URLSearchParams): RestResult {
  const ref = query.get('ref') ?? undefined;
  const tip = contentsTip(repo, ref);
  if (tip === null) return notFound('Not Found');
  const tree = parseCommit(getObject(repo, tip)!.data).tree;
  const file = readPath(repo, tree, path);
  if (file !== null) {
    return ok({
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: file.sha,
      size: file.data.length,
      encoding: 'base64',
      content: file.data.toString('base64'),
    });
  }
  // A directory: list its immediate entries.
  const files = listFiles(repo, tree);
  const prefix = path === '' ? '' : `${path}/`;
  const entries = new Map<string, { type: string; sha: string }>();
  for (const [filePath, sha] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) entries.set(rest, { type: 'file', sha });
    else entries.set(rest.slice(0, slash), { type: 'dir', sha: '' });
  }
  if (entries.size === 0) return notFound('Not Found');
  const listing = [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.sha,
    }));
  return ok(listing);
}

function deleteContents(
  store: Store,
  repo: Repo,
  path: string,
  body: Record<string, unknown>,
): RestResult {
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : 'delete';
  const tip = resolveToCommit(repo, branch);
  if (tip === null) return notFound('Not Found');
  const tree = parseCommit(getObject(repo, tip)!.data).tree;
  const existing = readPath(repo, tree, path);
  if (existing === null) return notFound('Not Found');
  const commitSha = commitFile(store, repo, branch, path, null, message);
  return ok({ commit: { sha: commitSha } });
}

// -----------------------------------------------------------------------------------------------------------
// Labels
// -----------------------------------------------------------------------------------------------------------

function createLabel(repo: Repo, body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return unprocessable('name is required');
  if (repo.labels.has(name)) return unprocessable('Label already exists');
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  repo.labels.set(name, { name, color });
  return created({ name, color });
}

// -----------------------------------------------------------------------------------------------------------
// Issues
// -----------------------------------------------------------------------------------------------------------

function createIssue(store: Store, repo: Repo, body: Record<string, unknown>): RestResult {
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return unprocessable('title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return unprocessable(`Label ${label} does not exist`);
  }
  const now = store.clock.iso();
  const issue: Issue = {
    id: store.restId(),
    number: repo.nextIssueNumber,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  return created(issueJson(repo, issue));
}

function listIssues(repo: Repo, query: URLSearchParams, baseUrl: string): RestResult {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  if (sort === 'created') {
    issues = [...issues].sort((a, b) =>
      direction === 'asc' ? a.number - b.number : b.number - a.number,
    );
  }
  const { page, link } = paginate(issues.map((issue) => issueJson(repo, issue)), query, `/api/v3/repos/${repo.fullName}/issues`, baseUrl);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return ok(page, headers);
}

function getIssue(repo: Repo, number: number): RestResult {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound('Not Found');
  return ok(issueJson(repo, issue));
}

function patchIssue(store: Store, repo: Repo, number: number, body: Record<string, unknown>): RestResult {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound('Not Found');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  issue.updatedAt = store.clock.iso();
  return ok(issueJson(repo, issue));
}

function createComment(store: Store, repo: Repo, number: number, body: Record<string, unknown>): RestResult {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound('Not Found');
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') return unprocessable('body is required');
  const now = store.clock.iso();
  const comment = { id: store.restId(), body: text, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  repo.nextCommentId += 1;
  return created({ id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt });
}

function listComments(repo: Repo, number: number): RestResult {
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound('Not Found');
  return ok(
    issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    })),
  );
}

// -----------------------------------------------------------------------------------------------------------
// Pull requests
// -----------------------------------------------------------------------------------------------------------

function createPull(store: Store, repo: Repo, body: Record<string, unknown>): RestResult {
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '') return unprocessable('title and head are required');
  const headSha = resolveToCommit(repo, head);
  const baseSha = resolveToCommit(repo, base);
  if (headSha === null) return unprocessable(`head branch ${head} does not exist`);
  if (baseSha === null) return unprocessable(`base branch ${base} does not exist`);
  const now = store.clock.iso();
  const pull: PullRequest = {
    id: store.restId(),
    number: repo.nextPullNumber,
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeSha: null,
    head,
    base,
    headSha,
    baseSha,
    createdAt: now,
    updatedAt: now,
  };
  repo.nextPullNumber += 1;
  repo.pulls.push(pull);
  return created(pullJson(repo, pull));
}

function listPulls(repo: Repo, query: URLSearchParams, baseUrl: string): RestResult {
  const state = query.get('state') ?? 'open';
  const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  const { page, link } = paginate(pulls.map((pull) => pullJson(repo, pull)), query, `/api/v3/repos/${repo.fullName}/pulls`, baseUrl);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return ok(page, headers);
}

function getPull(repo: Repo, number: number): RestResult {
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return notFound('Not Found');
  return ok(pullJson(repo, pull));
}

function listPullFiles(repo: Repo, number: number): RestResult {
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return notFound('Not Found');
  const baseCommit = getObject(repo, pull.baseSha);
  const headCommit = getObject(repo, pull.headSha);
  if (baseCommit === null || headCommit === null) return ok([]);
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const changes = diffTrees(repo, baseTree, headTree);
  return ok(
    changes.map((change) => ({
      filename: change.path,
      status: change.status === 'removed' ? 'removed' : change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })),
  );
}

/**
 * A three-way merge of the base branch tree and the head tree over their merge base.
 * Returns the merged tree's sha, or null when a file changed differently on both sides.
 */
function threeWayMerge(repo: Repo, baseSha: string, headSha: string): string | null {
  const baseTree = parseCommit(getObject(repo, baseSha)!.data).tree;
  const headTree = parseCommit(getObject(repo, headSha)!.data).tree;
  const mergeBaseSha = mergeBase(repo, baseSha, headSha);
  const ancestorTree = mergeBaseSha === null ? EMPTY_TREE : parseCommit(getObject(repo, mergeBaseSha)!.data).tree;
  const baseFiles = listFiles(repo, baseTree);
  const headFiles = listFiles(repo, headTree);
  const ancestorFiles = listFiles(repo, ancestorTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  let mergedTree = baseTree;
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (head === ancestor) continue; // head did not change it: keep base
    if (base === ancestor) {
      // base did not change it: take head (or delete when head removed it)
      mergedTree = writePath(repo, mergedTree, path, head === undefined ? null : head);
      continue;
    }
    if (head === base) continue; // both changed it the same way
    return null; // both changed it differently: a conflict
  }
  return mergedTree;
}

function mergePull(store: Store, repo: Repo, number: number, body: Record<string, unknown>): RestResult {
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return notFound('Not Found');
  if (pull.merged || pull.state !== 'open') return conflict('Pull request is already merged');
  const result = squashMerge(store, repo, pull);
  if ('error' in result) return conflict(result.error);
  void body;
  return ok({ sha: result.sha, merged: true, message: `Merge pull request #${pull.number}` });
}

/**
 * Perform a squash merge of a pull request onto its base branch. Returns the merge
 * commit's sha, or an error string when the merge cannot proceed.
 */
export function squashMerge(
  store: Store,
  repo: Repo,
  pull: PullRequest,
): { sha: string } | { error: string } {
  const baseTip = resolveToCommit(repo, pull.base);
  if (baseTip === null) return { error: 'Base branch is gone' };
  const mergedTree = threeWayMerge(repo, baseTip, pull.headSha);
  if (mergedTree === null) return { error: 'Merge conflict' };
  const when = store.clock.tick();
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
  const commitData = buildCommit(mergedTree, [baseTip], message, VIEWER_NAME, VIEWER_EMAIL, when);
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeSha = mergeSha;
  pull.mergedAt = store.clock.iso();
  pull.updatedAt = pull.mergedAt;
  return { sha: mergeSha };
}

// -----------------------------------------------------------------------------------------------------------
// The router
// -----------------------------------------------------------------------------------------------------------

/**
 * Handle one REST request. `segments` is the path after /api/v3, split on '/'.
 * `body` is the parsed JSON body (or null when there is none).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  baseUrl = '',
): RestResult {
  const json = body ?? {};
  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return ok({ installed_version: '1.0.0' });
  }
  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound();
    return ok({ login: VIEWER_LOGIN, id: 1000, name: VIEWER_NAME, email: VIEWER_EMAIL });
  }
  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') return listUserRepos(store, query, baseUrl);
    if (method === 'POST') return createRepo(store, json);
    return notFound();
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    const repo = resolveRepo(store, owner, name);
    if (repo === null) return notFound('Not Found');
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(repo));
      if (method === 'PATCH') {
        if (typeof json.description === 'string') repo.description = json.description;
        if (typeof json.default_branch === 'string') repo.defaultBranch = json.default_branch;
        repo.updatedAt = store.clock.iso();
        return ok(repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return noContent();
      }
      return notFound();
    }
    // /branches
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') return listBranches(repo);
    if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
      return getBranch(repo, decodeURIComponent(rest[1]!));
    }
    // /commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(repo, query);
    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      return createRef(repo, json);
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length > 2 && method === 'GET') {
      return getRef(repo, rest.slice(2).map(decodeURIComponent).join('/'));
    }
    // /contents/{path}
    if (rest[0] === 'contents' && rest.length >= 2) {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'PUT') return putContents(store, repo, path, json, query);
      if (method === 'GET') return getContents(repo, path, query);
      if (method === 'DELETE') return deleteContents(store, repo, path, json);
      return notFound();
    }
    // /labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') return createLabel(repo, json);
      if (method === 'GET') {
        return ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
      }
      return notFound();
    }
    // /issues
    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'POST') return createIssue(store, repo, json);
      if (method === 'GET') return listIssues(repo, query, baseUrl);
      return notFound();
    }
    if (rest[0] === 'issues' && rest.length >= 2) {
      const number = parseInt(rest[1]!, 10);
      if (Number.isNaN(number)) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') return getIssue(repo, number);
        if (method === 'PATCH') return patchIssue(store, repo, number, json);
        return notFound();
      }
      if (rest[2] === 'comments') {
        if (method === 'POST') return createComment(store, repo, number, json);
        if (method === 'GET') return listComments(repo, number);
        return notFound();
      }
      return notFound();
    }
    // /pulls
    if (rest[0] === 'pulls' && rest.length === 1) {
      if (method === 'POST') return createPull(store, repo, json);
      if (method === 'GET') return listPulls(repo, query, baseUrl);
      return notFound();
    }
    if (rest[0] === 'pulls' && rest.length >= 2) {
      const number = parseInt(rest[1]!, 10);
      if (Number.isNaN(number)) return notFound();
      if (rest.length === 2 && method === 'GET') return getPull(repo, number);
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return listPullFiles(repo, number);
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(store, repo, number, json);
      return notFound();
    }
    return notFound();
  }
  return notFound();
}
