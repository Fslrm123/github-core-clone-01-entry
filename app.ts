// The server the entry runs: one in-memory store behind the four surfaces (git smart
// HTTP, REST v3, GraphQL v4, MCP). main.ts owns the lifecycle; this file owns the app.

import { createServer, type Server } from 'node:http';
import { createServerWithStore } from './lib/http.ts';
import { Store } from './lib/store.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServerWithStore(store);
}

export { createServer };
