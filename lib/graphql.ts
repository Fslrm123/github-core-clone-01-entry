// GraphQL v4 at /api/graphql: a small recursive-descent parser plus an executor over
// the same store REST uses. It answers the documents gh and github-mcp-server send:
// viewer, repository, node, __type introspection, the issue and pull-request queries
// and mutations, cursor pagination, and two operation documents in one body.

import { getObject, listFiles, mergeBase, parseCommit, resolveToCommit } from './gitobj.ts';
import { VIEWER_LOGIN } from './gitproto.ts';
import { diffTrees } from './gitobj.ts';
import { squashMerge } from './rest.ts';
import {
  decodeGlobalId,
  encodeGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// -----------------------------------------------------------------------------------------------------------
// Tokenizer
// -----------------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if ('{}()[]:!=$@'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          const next = source[index + 1]!;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let text = '';
      while (index < source.length && /[0-9]/.test(source[index]!)) {
        text += source[index];
        index += 1;
      }
      tokens.push({ kind: 'int', value: parseInt(text, 10) });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let text = '';
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) {
        text += source[index];
        index += 1;
      }
      tokens.push({ kind: 'name', value: text });
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

// -----------------------------------------------------------------------------------------------------------
// Parser: operations, selection sets, fields, arguments, fragments
// -----------------------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selection: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('graphql: unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`graphql: expected ${value}, got ${token.kind} ${'value' in token ? token.value : ''}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`graphql: expected a name, got ${token.kind}`);
    return token.value;
  }

  parseOperation(): Operation {
    const first = this.peek();
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (first !== null && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      this.next();
      type = first.value;
      const maybeName = this.peek();
      if (maybeName !== null && maybeName.kind === 'name') {
        name = this.next().value as string;
      }
    }
    const variables: Record<string, ValueNode | undefined> = {};
    const open = this.peek();
    if (open !== null && open.kind === 'punct' && open.value === '(') {
      this.next();
      while (this.peek() !== null && !(this.peek()!.kind === 'punct' && this.peek()!.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // The type (a name, possibly with [] and !); we only need the variable's name.
        this.skipType();
        if (this.peek() !== null && this.peek()!.kind === 'punct' && this.peek()!.value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = undefined;
        }
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }

  private skipType(): void {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (token.kind !== 'name') {
      throw new Error('graphql: expected a type name');
    }
    if (this.peek() !== null && this.peek()!.kind === 'punct' && this.peek()!.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== null && !(this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== null && token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      let typeCondition: string | null = null;
      if (next !== null && next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next !== null && next.kind === 'name') {
        // A named fragment spread: the suite never sends one; treat it as an error
        // the executor reports rather than a crash.
        throw new Error(`graphql: named fragment ${next.value} is not supported`);
      }
      const selection = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selection };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    const colon = this.peek();
    if (colon !== null && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    const open = this.peek();
    if (open !== null && open.kind === 'punct' && open.value === '(') {
      this.next();
      while (this.peek() !== null && !(this.peek()!.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | null = null;
    const brace = this.peek();
    if (brace !== null && brace.kind === 'punct' && brace.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== null && !(this.peek()!.kind === 'punct' && this.peek()!.value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== null && !(this.peek()!.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`graphql: unexpected value token ${token.kind}`);
  }
}

/** Parse one operation document; throws on a syntax error. */
export function parseDocument(source: string): Operation {
  return new Parser(source).parseOperation();
}

// -----------------------------------------------------------------------------------------------------------
// Values, introspection, and the executor
// -----------------------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

/** Resolve an argument value node against the operation's variables. */
function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'string':
      return node.value;
    case 'int':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'variable':
      return variables[node.name] ?? null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

/** The fields each type exposes (for introspection and for unknown-field errors). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'files', 'body', 'createdAt', 'updatedAt',
  ],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestFile: ['path'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER'];

type Source = { __typename: string; [key: string]: unknown };

interface ExecContext {
  store: Store;
  errors: Array<{ message: string }>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = parseInt(text.slice('cursor:'.length), 10);
    return Number.isNaN(number) ? null : number;
  } catch {
    return null;
  }
}

/** A connection page over a list already sorted in the requested order. */
function connectionPage<T extends { number: number }>(
  items: T[],
  first: number | null,
  after: string | null | undefined,
): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let start = 0;
  const afterNumber = numberFromCursor(after);
  if (afterNumber !== null) {
    const index = items.findIndex((item) => item.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const limit = first === null || first === undefined ? items.length : Math.max(0, first);
  const nodes = items.slice(start, start + limit);
  const hasNextPage = start + nodes.length < items.length;
  const endCursor = nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.number) : null;
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function issueStateFilter(states: unknown): Array<'open' | 'closed'> | null {
  if (!Array.isArray(states)) return null;
  const out: Array<'open' | 'closed'> = [];
  for (const state of states) {
    if (state === 'OPEN') out.push('open');
    else if (state === 'CLOSED') out.push('closed');
  }
  return out;
}

/** The mergeability of a pull request, computed without writing any objects. */
function computeMergeable(repo: Repo, pull: PullRequest): string {
  if (pull.merged) return 'UNKNOWN';
  const baseTip = resolveToCommit(repo, pull.base);
  if (baseTip === null) return 'UNKNOWN';
  const baseCommit = getObject(repo, baseTip);
  const headCommit = getObject(repo, pull.headSha);
  if (baseCommit === null || headCommit === null) return 'UNKNOWN';
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const ancestorSha = mergeBase(repo, baseTip, pull.headSha);
  const ancestorTree = ancestorSha === null ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : parseCommit(getObject(repo, ancestorSha)!.data).tree;
  const baseFiles = listFiles(repo, baseTree);
  const headFiles = listFiles(repo, headTree);
  const ancestorFiles = listFiles(repo, ancestorTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (head === ancestor) continue;
    if (base === ancestor) continue;
    if (head === base) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Resolve a global id to the object it names (a repo, an issue or a pull request). */
function resolveGlobalId(store: Store, id: string): Source | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'R' && decoded.parts.length === 2) {
    const repo = store.getRepo(decoded.parts[0]!, decoded.parts[1]!);
    return repo === undefined ? null : { __typename: 'Repository', repo };
  }
  if (decoded.kind === 'I' && decoded.parts.length === 3) {
    const repo = store.getRepo(decoded.parts[0]!, decoded.parts[1]!);
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === parseInt(decoded.parts[2]!, 10));
    return issue === undefined ? null : { __typename: 'Issue', repo, issue };
  }
  if (decoded.kind === 'P' && decoded.parts.length === 3) {
    const repo = store.getRepo(decoded.parts[0]!, decoded.parts[1]!);
    if (repo === undefined) return null;
    const pull = repo.pulls.find((entry) => entry.number === parseInt(decoded.parts[2]!, 10));
    return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
  }
  return null;
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('I', repo.owner, repo.name, issue.number);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return encodeGlobalId('P', repo.owner, repo.name, pull.number);
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('R', repo.owner, repo.name);
}

// -----------------------------------------------------------------------------------------------------------
// Field resolution
// -----------------------------------------------------------------------------------------------------------

function resolveField(source: Source, field: FieldNode, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const store = ctx.store;
  const typeName = source.__typename;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER_LOGIN };
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : { __typename: 'Repository', repo };
      }
      if (field.name === 'node') {
        return resolveGlobalId(store, String(args.id ?? ''));
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (name === 'SearchType') return { __typename: '__Type', name, isEnum: true };
        if (TYPE_FIELDS[name] !== undefined) return { __typename: '__Type', name, isEnum: false };
        return null;
      }
      if (field.name === '__schema') return { __typename: '__Schema' };
      return undefined;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(source, args, ctx);
      if (field.name === 'closeIssue') return mutateCloseIssue(source, args, ctx);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(source, args, ctx);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(source, args, ctx);
      if (field.name === 'addComment') return mutateAddComment(source, args, ctx);
      return undefined;
    }
    case 'User': {
      if (field.name === 'login') return source.login as string;
      if (field.name === 'id') return 1000;
      if (field.name === 'name') return 'ada iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      return undefined;
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.databaseId;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.fullName;
      if (field.name === 'owner') return { __typename: 'User', login: repo.owner };
      if (field.name === 'defaultBranchRef') {
        const sha = repo.ref(`refs/heads/${repo.defaultBranch}`);
        return sha === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.isPrivate;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'issue') {
        const number = Number(args.number);
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : { __typename: 'Issue', repo, issue };
      }
      if (field.name === 'issues') {
        const states = issueStateFilter(args.states);
        let issues = states === null ? [...repo.issues] : repo.issues.filter((issue) => states.includes(issue.state));
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC');
        issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        const page = connectionPage(issues, typeof args.first === 'number' ? args.first : null, typeof args.after === 'string' ? args.after : null);
        return {
          __typename: 'IssueConnection',
          repo,
          nodes: page.nodes.map((issue) => ({ __typename: 'Issue', repo, issue })),
          pageInfo: page.pageInfo,
        };
      }
      if (field.name === 'pullRequests') {
        const states = issueStateFilter(args.states);
        let pulls = states === null ? [...repo.pulls] : repo.pulls.filter((pull) => states.includes(pull.state));
        pulls.sort((a, b) => b.number - a.number);
        const page = connectionPage(pulls, typeof args.first === 'number' ? args.first : null, typeof args.after === 'string' ? args.after : null);
        return {
          __typename: 'PullRequestConnection',
          repo,
          nodes: page.nodes.map((pull) => ({ __typename: 'PullRequest', repo, pull })),
          pageInfo: page.pageInfo,
        };
      }
      if (field.name === 'pullRequest') {
        const number = Number(args.number);
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
      }
      return undefined;
    }
    case 'Issue': {
      const issue = source.issue as Issue;
      const repo = source.repo as Repo;
      if (field.name === 'id') return issueGlobalId(repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      return undefined;
    }
    case 'PullRequest': {
      const pull = source.pull as PullRequest;
      const repo = source.repo as Repo;
      if (field.name === 'id') return pullGlobalId(repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'state') return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'headRefName') return pull.head;
      if (field.name === 'baseRefName') return pull.base;
      if (field.name === 'mergeable') return computeMergeable(repo, pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'body') return pull.body;
      if (field.name === 'createdAt') return pull.createdAt;
      if (field.name === 'updatedAt') return pull.updatedAt;
      if (field.name === 'files') {
        const baseCommit = getObject(repo, pull.baseSha);
        const headCommit = getObject(repo, pull.headSha);
        if (baseCommit === null || headCommit === null) {
          return { __typename: 'PullRequestFileConnection', nodes: [] };
        }
        const changes = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
        const first = typeof args.first === 'number' ? args.first : changes.length;
        return {
          __typename: 'PullRequestFileConnection',
          nodes: changes.slice(0, first).map((change) => ({ __typename: 'PullRequestFile', path: change.path })),
        };
      }
      return undefined;
    }
    case 'Ref': {
      if (field.name === 'name') return source.name as string;
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return source.nodes as Source[];
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', ...(source.pageInfo as Record<string, unknown>) };
      if (field.name === 'totalCount') return (source.nodes as Source[]).length;
      return undefined;
    }
    case 'PullRequestFileConnection': {
      if (field.name === 'nodes') return source.nodes as Source[];
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: false, endCursor: null };
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return source.hasNextPage as boolean;
      if (field.name === 'endCursor') return (source.endCursor as string | null) ?? null;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return undefined;
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return source.path as string;
      return undefined;
    }
    case 'IssueCommentEdge': {
      if (field.name === 'node') return source.node as Source;
      return undefined;
    }
    case 'IssueComment': {
      if (field.name === 'id') return source.id as string;
      if (field.name === 'body') return source.body as string;
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return source.issue as Source;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return source.pullRequest as Source;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return source.commentEdge as Source;
      return undefined;
    }
    case '__Type': {
      if (field.name === 'name') return source.name as string;
      if (field.name === 'fields') {
        if (source.isEnum === true) return null;
        return (TYPE_FIELDS[source.name as string] ?? []).map((name) => ({ __typename: '__Field', name }));
      }
      if (field.name === 'enumValues') {
        if (source.isEnum === true && source.name === 'SearchType') {
          return SEARCH_TYPE_VALUES.map((name) => ({ __typename: '__EnumValue', name }));
        }
        return null;
      }
      return undefined;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return source.name as string;
      return undefined;
    }
    case '__Schema': {
      return undefined;
    }
    default:
      return undefined;
  }
}

// -----------------------------------------------------------------------------------------------------------
// Mutations (they write to the same store REST uses)
// -----------------------------------------------------------------------------------------------------------

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function mutateCreateIssue(_source: Source, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = inputOf(args);
  const repoSource = resolveGlobalId(ctx.store, String(input.repositoryId ?? ''));
  if (repoSource === null || repoSource.__typename !== 'Repository') return { __typename: 'CreateIssuePayload', issue: null };
  const repo = repoSource.repo as Repo;
  const now = ctx.store.clock.iso();
  const issue: Issue = {
    id: ctx.store.restId(),
    number: repo.nextIssueNumber,
    title: String(input.title ?? ''),
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } };
}

function mutateCloseIssue(_source: Source, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = inputOf(args);
  const target = resolveGlobalId(ctx.store, String(input.issueId ?? ''));
  if (target === null || target.__typename !== 'Issue') return { __typename: 'CloseIssuePayload', issue: null };
  const issue = target.issue as Issue;
  issue.state = 'closed';
  issue.updatedAt = ctx.store.clock.iso();
  return { __typename: 'CloseIssuePayload', issue: target };
}

function mutateCreatePullRequest(_source: Source, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = inputOf(args);
  const repoSource = resolveGlobalId(ctx.store, String(input.repositoryId ?? ''));
  if (repoSource === null || repoSource.__typename !== 'Repository') {
    return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  }
  const repo = repoSource.repo as Repo;
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? repo.defaultBranch);
  const headSha = resolveToCommit(repo, head);
  const baseSha = resolveToCommit(repo, base);
  if (headSha === null || baseSha === null) {
    return { __typename: 'CreatePullRequestPayload', pullRequest: null };
  }
  const now = ctx.store.clock.iso();
  const pull: PullRequest = {
    id: ctx.store.restId(),
    number: repo.nextPullNumber,
    title: String(input.title ?? ''),
    body: typeof input.body === 'string' ? input.body : '',
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
  return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
}

function mutateMergePullRequest(_source: Source, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = inputOf(args);
  const target = resolveGlobalId(ctx.store, String(input.pullRequestId ?? ''));
  if (target === null || target.__typename !== 'PullRequest') {
    return { __typename: 'MergePullRequestPayload', pullRequest: null };
  }
  const pull = target.pull as PullRequest;
  const repo = target.repo as Repo;
  if (!pull.merged && pull.state === 'open') squashMerge(ctx.store, repo, pull);
  return { __typename: 'MergePullRequestPayload', pullRequest: target };
}

function mutateAddComment(_source: Source, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const input = inputOf(args);
  const target = resolveGlobalId(ctx.store, String(input.subjectId ?? ''));
  if (target === null || target.__typename !== 'Issue') {
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  const issue = target.issue as Issue;
  const repo = target.repo as Repo;
  const body = typeof input.body === 'string' ? input.body : '';
  const now = ctx.store.clock.iso();
  const comment = { id: ctx.store.restId(), body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  const commentId = encodeGlobalId('C', repo.owner, repo.name, issue.number, comment.id);
  return {
    __typename: 'AddCommentPayload',
    commentEdge: {
      __typename: 'IssueCommentEdge',
      node: { __typename: 'IssueComment', id: commentId, body },
    },
  };
}

// -----------------------------------------------------------------------------------------------------------
// The executor
// -----------------------------------------------------------------------------------------------------------

function executeSelection(
  source: Source,
  selection: SelectionNode[],
  variables: Variables,
  ctx: ExecContext,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition !== null && node.typeCondition !== source.__typename) continue;
      const inner = executeSelection(source, node.selection, variables, ctx);
      if (inner !== null) Object.assign(out, inner);
      continue;
    }
    const fieldName = node.name;
    if (fieldName.startsWith('__') && fieldName !== '__type' && fieldName !== '__schema') {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${source.__typename}".` });
      out[node.alias ?? fieldName] = null;
      continue;
    }
    const known = TYPE_FIELDS[source.__typename] ?? [];
    if (!known.includes(fieldName)) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${source.__typename}".` });
      out[node.alias ?? fieldName] = null;
      continue;
    }
    const args = argsMap(node, variables);
    const value = resolveField(source, node, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${source.__typename}".` });
      out[node.alias ?? fieldName] = null;
      continue;
    }
    out[node.alias ?? fieldName] = executeValue(value, node.selection, variables, ctx);
  }
  return out;
}

function executeValue(value: unknown, selection: SelectionNode[] | null, variables: Variables, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (selection === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)
        ? executeSelection(entry as Source, selection, variables, ctx)
        : entry,
    );
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return executeSelection(value as Source, selection, variables, ctx);
  }
  return value;
}

/** Execute one operation document against the store. */
export function executeGraphQL(
  store: Store,
  operation: Operation,
  variables: Variables,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { store, errors: [] };
  const root: Source = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, operation.selection, variables, ctx);
  const result: { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// -----------------------------------------------------------------------------------------------------------
// The HTTP entry point: one operation, or an array of them (batched, answered in order)
// -----------------------------------------------------------------------------------------------------------

/**
 * Handle a POST /api/graphql body (already parsed JSON). Returns the response body:
 * one result object, or an array of them for a batched request.
 */
export function handleGraphQL(store: Store, body: unknown): unknown {
  const runOne = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'A GraphQL operation object is required.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables ?? {}) as Variables;
    let operation: Operation;
    try {
      operation = parseDocument(query);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    return executeGraphQL(store, operation, variables);
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}
