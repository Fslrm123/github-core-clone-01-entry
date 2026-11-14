// The forge's whole state, in memory. Nothing here touches the disk, the clock or
// Math.random: every timestamp comes from a deterministic counter, so two runs that
// make the same requests in the same order produce byte-identical answers.

import { createHash } from 'node:crypto';

/** The Unix base for the deterministic clock (2023-11-14T22:13:20Z). */
export const CLOCK_BASE = 1_700_000_000;

/** SHA-1 of a git object header plus its bytes. */
export function sha1Object(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The all-zero object id, used for unborn refs and deletions. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Whether a string is a 40-hex object id. */
export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** A Relay-style global id: base64 of a prefixed key. Opaque, stable, decodable. */
export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join('/')}`, 'utf8').toString('base64');
}

/** Decode a global id made by encodeGlobalId; null when it is not one. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon < 1) return null;
  const kind = text.slice(0, colon);
  if (!/^[A-Z]$/.test(kind)) return null;
  return { kind, parts: text.slice(colon + 1).split('/') };
}

// -----------------------------------------------------------------------------------------------------------
// The deterministic clock: a counter, not the wall clock. Every timestamp an answer
// carries (created_at, updated_at, git author/committer dates) comes from here, so a
// replay of the same requests answers the same bytes.
// -----------------------------------------------------------------------------------------------------------

export class Clock {
  private seq = 0;

  /** The next tick, as Unix seconds. */
  tick(): number {
    this.seq += 1;
    return CLOCK_BASE + this.seq;
  }

  /** The next tick, as an ISO-8601 string. */
  iso(): string {
    return new Date(this.tick() * 1000).toISOString();
  }
}

// -----------------------------------------------------------------------------------------------------------
// The objects a repository holds.
// -----------------------------------------------------------------------------------------------------------

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

/** One repository: its refs, its objects, and its issues, pull requests and labels. */
export class Repo {
  readonly owner: string;
  readonly name: string;
  readonly databaseId: number;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly issues: Issue[] = [];
  readonly pulls: PullRequest[] = [];
  readonly labels = new Map<string, Label>();
  nextIssueNumber = 1;
  nextPullNumber = 1;
  nextCommentId = 1;
  readonly createdAt: string;
  updatedAt: string;

  constructor(owner: string, name: string, databaseId: number, description: string, isPrivate: boolean, now: string) {
    this.owner = owner;
    this.name = name;
    this.databaseId = databaseId;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = now;
    this.updatedAt = now;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The commit a ref points at, or null when the ref does not exist. */
  ref(name: string): string | null {
    return this.refs.get(name) ?? null;
  }

  /** Every branch name (without the refs/heads/ prefix), sorted. */
  branches(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Every tag name (without the refs/tags/ prefix), sorted. */
  tags(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/tags/')) names.push(ref.slice('refs/tags/'.length));
    }
    return names.sort();
  }
}

/** The whole forge: every repository, keyed by owner/name. */
export class Store {
  readonly clock = new Clock();
  private readonly repos = new Map<string, Repo>();
  private nextDatabaseId = 1;
  private nextRestId = 1;

  /** The next globally unique numeric REST id (for issues, pull requests, comments). */
  restId(): number {
    const id = this.nextRestId;
    this.nextRestId += 1;
    return id;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = this.clock.iso();
    const repo = new Repo(owner, name, this.nextDatabaseId, description, isPrivate, now);
    this.nextDatabaseId += 1;
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository the login owns, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }
}
