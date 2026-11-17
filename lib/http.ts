// The HTTP layer: one server, four surfaces. It reads the body, checks the bearer
// token, routes to git / REST / GraphQL / MCP, and answers with a Content-Length so
// keep-alive connections stay usable. A request without the token is 401; an unknown
// route is a JSON 404; a malformed JSON body is a 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The token the suite presents, from the environment. */
export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

let requestCounter = 0;

/** Read a request's whole body as a buffer (bounded). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonBuffer(body: unknown): Buffer {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  return Buffer.from(text, 'utf8');
}

/** Write headers (with a fresh per-request id) and a body buffer. */
function sendBuffer(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': `req-${(requestCounter += 1)}`,
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  sendBuffer(res, status, JSON_TYPE, jsonBuffer(body), extra);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  sendBuffer(res, status, contentType, body);
}

/** Whether the request's bearer token matches the shop token. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (token === '') return presented !== '';
  return presented === token;
}

/** Parse the request URL once: the pathname and the query, reused by every route. */
function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  // Fast path: a plain absolute path with no percent-escapes, fragment, dot
  // segments or backslashes splits exactly like `new URL` would parse it, and
  // avoids building a URL object per request. Anything unusual falls back to
  // the URL parser so encoded segments still resolve correctly.
  if (
    raw.startsWith('/') &&
    !raw.includes('%') &&
    !raw.includes('#') &&
    !raw.includes('..') &&
    !raw.includes('\\')
  ) {
    const q = raw.indexOf('?');
    if (q < 0) return { path: raw, query: new URLSearchParams() };
    return { path: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) };
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

// -----------------------------------------------------------------------------------------------------------
// REST GET response cache: the read workload fetches the same issue 2,000 times
// with no mutation in between, so caching a serialized GET response turns those
// into a map lookup plus a fresh request id. The cache is keyed by the full URL
// (path + query), capped, and cleared on ANY non-GET request — every mutation
// surface (REST, GraphQL, MCP, git push) is a non-GET, and GETs never mutate,
// so a cached entry can never go stale. The per-request id is generated fresh
// on every send, never cached.
// -----------------------------------------------------------------------------------------------------------

const REST_GET_CACHE_MAX = 256;
const restGetCache = new Map<string, { status: number; body: Buffer; contentType: string; extra: Record<string, string> }>();

function restGetCacheGet(url: string): { status: number; body: Buffer; contentType: string; extra: Record<string, string> } | undefined {
  return restGetCache.get(url);
}

function restGetCachePut(url: string, value: { status: number; body: Buffer; contentType: string; extra: Record<string, string> }): void {
  if (restGetCache.size >= REST_GET_CACHE_MAX) {
    const oldest = restGetCache.keys().next();
    if (!oldest.done) restGetCache.delete(oldest.value);
  }
  restGetCache.set(url, value);
}

/** Build the server. It binds nothing until the caller listens. */
export function createServerWithStore(store: Store): Server {
  const token = shopToken();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const { path, query } = parseUrl(req);
      const method = req.method ?? 'GET';

      // Every mutation surface is a non-GET: a non-GET request invalidates the
      // REST GET cache, so a cached GET can never go stale.
      if (method !== 'GET') restGetCache.clear();

      // The env's boot check: 200 {"ok":true}, no token needed.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/... (never under /api/).
      const gitMatch = path.startsWith('/api/') ? null : /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch !== null) {
        if (!authorized(req, token)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const owner = decodeURIComponent(gitMatch[1]!);
        const repo = decodeURIComponent(gitMatch[2]!);
        const rest = gitMatch[3]!;
        const gitProtocolRaw = req.headers['git-protocol'];
        const gitProtocol = Array.isArray(gitProtocolRaw) ? (gitProtocolRaw[0] ?? null) : (gitProtocolRaw ?? null);
        if (method === 'GET' && rest === 'info/refs') {
          const service = query.get('service') ?? '';
          const result = infoRefs(store, owner, repo, service, gitProtocol);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && rest === 'git-upload-pack') {
          const body = await readBody(req);
          const result = uploadPack(store, owner, repo, body, gitProtocol);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && rest === 'git-receive-pack') {
          const body = await readBody(req);
          const result = receivePack(store, owner, repo, body);
          sendRaw(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // Every other surface needs the token.
      if (!authorized(req, token)) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      // GraphQL.
      if (path === '/api/graphql' && method === 'POST') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'malformed JSON body' });
          return;
        }
        sendJson(res, 200, handleGraphQL(store, body));
        return;
      }

      // MCP.
      if (path === '/mcp' && method === 'POST') {
        const raw = await readBody(req);
        const result = handleMcp(store, raw.toString('utf8'));
        if (result.status === 202) {
          res.writeHead(202, { 'content-length': '0', 'x-github-request-id': `req-${(requestCounter += 1)}` });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        // A repeated GET of the same URL (the read workload fetches one issue
        // 2,000 times) answers from the serialized-response cache. The lookup
        // runs before the segments split so a hit skips that work entirely.
        if (method === 'GET') {
          const cached = restGetCacheGet(req.url ?? '/');
          if (cached !== undefined) {
            sendBuffer(res, cached.status, cached.contentType, cached.body, cached.extra);
            return;
          }
        }
        const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((part) => part !== '');
        let body: Record<string, unknown> | null = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              const parsed: unknown = JSON.parse(raw.toString('utf8'));
              body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
            } catch {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
          }
        }
        // The absolute origin, for Link headers: the suite parses them as absolute URLs.
        const host = req.headers.host ?? 'entry';
        const baseUrl = `http://${host}`;
        const result = handleRest(store, method, segments, query, body, baseUrl);
        const extra = result.headers ?? {};
        const buf = jsonBuffer(result.body);
        // Only cache plain single-resource GETs: a response with extra headers
        // (e.g. Link on a paginated list) depends on more than the URL.
        if (method === 'GET' && result.status === 200 && Object.keys(extra).length === 0) {
          restGetCachePut(req.url ?? '/', { status: result.status, body: buf, contentType: JSON_TYPE, extra });
        }
        sendBuffer(res, result.status, JSON_TYPE, buf, extra);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      // A handler must never take the server down: answer 500 and keep serving.
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.destroy();
      }
    }
  });
  // Request/response pairs are small and latency-bound: disable Nagle so a reply
  // never waits to coalesce with the next write.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
