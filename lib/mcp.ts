// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 via
// server/discover (with the legacy initialize handshake as a fallback). The six tools
// act on the same store as REST, so a repository or issue created here reads back
// over /api/v3 as the same object.

import { resolveToCommit } from './gitobj.ts';
import { VIEWER_LOGIN } from './gitproto.ts';
import { squashMerge } from './rest.ts';
import { type Issue, type PullRequest, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The six tools, in a fixed order: two tools/list calls answer this byte for byte. */
export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

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
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
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
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
  };
}

/** A tool result: a text block carrying the JSON, plus the same value structured. */
function toolOk(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Run one tool by name with its arguments; returns its result object. */
function callTool(store: Store, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  const missing = (fields: string[]): { error: { code: number; message: string } } | null => {
    const absent = fields.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
    if (absent.length === 0) return null;
    return { error: { code: -32602, message: `Missing required argument(s): ${absent.join(', ')}` } };
  };
  switch (name) {
    case 'create_repo': {
      const absent = missing(['name']);
      if (absent !== null) return absent;
      const repoOwner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
      const repoNameArg = String(args.name);
      if (store.getRepo(repoOwner, repoNameArg) !== undefined) {
        return { result: toolError(`Repository ${repoOwner}/${repoNameArg} already exists`) };
      }
      const repo = store.createRepo(
        repoOwner,
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { result: toolOk(repoJson(repo)) };
    }
    case 'get_repo': {
      const absent = missing(['owner', 'repo']);
      if (absent !== null) return absent;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      return { result: toolOk(repoJson(repo)) };
    }
    case 'create_issue': {
      const absent = missing(['owner', 'repo', 'title']);
      if (absent !== null) return absent;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const now = store.clock.iso();
      const issue: Issue = {
        id: store.restId(),
        number: repo.nextIssueNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      return { result: toolOk(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const absent = missing(['owner', 'repo']);
      if (absent !== null) return absent;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { result: toolOk(issues.map((issue) => issueJson(repo, issue))) };
    }
    case 'create_pull_request': {
      const absent = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (absent !== null) return absent;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const head = String(args.head);
      const base = String(args.base);
      const headSha = resolveToCommit(repo, head);
      const baseSha = resolveToCommit(repo, base);
      if (headSha === null) return { result: toolError(`head branch ${head} does not exist`) };
      if (baseSha === null) return { result: toolError(`base branch ${base} does not exist`) };
      const now = store.clock.iso();
      const pull: PullRequest = {
        id: store.restId(),
        number: repo.nextPullNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
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
      return { result: toolOk(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const absent = missing(['owner', 'repo', 'pull_number']);
      if (absent !== null) return absent;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return { result: toolError(`Repository ${owner}/${repoName} not found`) };
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { result: toolError(`Pull request #${number} not found`) };
      if (pull.merged || pull.state !== 'open') return { result: toolError(`Pull request #${number} is already merged`) };
      const merged = squashMerge(store, repo, pull);
      if ('error' in merged) return { result: toolError(merged.error) };
      return { result: toolOk(pullJson(repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

// -----------------------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// -----------------------------------------------------------------------------------------------------------

export interface McpResult {
  status: number;
  body: unknown;
}

/**
 * Handle one POST /mcp body (the raw text). A body that is not JSON is an HTTP 400
 * with JSON-RPC -32700. A notification (no id) is answered with HTTP 202 and no body.
 */
export function handleMcp(store: Store, rawBody: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  // A notification carries no id and expects no JSON-RPC answer.
  if (id === null || id === undefined) {
    return { status: 202, body: null };
  }
  const ok = (result: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });
  if (method === 'server/discover') {
    return ok({
      supportedVersions: [PREFERRED_REVISION],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? PREFERRED_REVISION;
    return ok({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return ok({ tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, name, args);
    if (outcome.error !== undefined) return fail(outcome.error.code, outcome.error.message);
    return ok(outcome.result);
  }
  if (method === 'ping') {
    return ok({});
  }
  return fail(-32601, `Method not found: ${method}`);
}
