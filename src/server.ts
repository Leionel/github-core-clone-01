// The one process: an http server routing git smart HTTP, REST v3, GraphQL v4 and MCP to the one
// store, with the bearer-token gate in front of every surface but /healthz and the public API
// root/meta. No disk, no clock in stored state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitRequest } from './git-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? 'test-token';
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length) === expectedToken();
}

export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void handleRequest(store, req, res, () => {
      requestCounter += 1;
      return requestCounter.toString(16).padStart(16, '0');
    });
  });
  // Keep-alive is what the read benchmark rides on; the default 5s window is fine.
  server.keepAliveTimeout = 5000;
  return server;
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  extraHeaders: Record<string, string>,
  requestId: string,
): void {
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    'content-type': contentType,
    'content-length': String(body.length),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string>,
  requestId: string,
): void {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  send(res, status, JSON_TYPE, body, extraHeaders, requestId);
}

async function handleRequest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  nextRequestId: () => string,
): Promise<void> {
  const requestId = nextRequestId();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    sendJson(res, 400, { message: 'bad request URL' }, {}, requestId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = url.pathname;

  // Public: health.
  if (pathname === '/healthz') {
    if (method === 'GET') {
      sendJson(res, 200, { ok: true }, {}, requestId);
    } else {
      sendJson(res, 405, { message: 'Method not allowed' }, {}, requestId);
    }
    return;
  }

  // Read the body (needed by every write endpoint).
  const body = await readBody(req);
  if (body === null) {
    sendJson(res, 413, { message: 'request body too large' }, {}, requestId);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, {}, requestId);
      return;
    }
    const owner = decodeURIComponent(gitMatch[1]!);
    const repo = decodeURIComponent(gitMatch[2]!);
    const tail = gitMatch[3]!;
    if (tail === 'info/refs') {
      const serviceName = url.searchParams.get('service');
      if (serviceName !== 'git-upload-pack' && serviceName !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' }, {}, requestId);
        return;
      }
      const result = handleInfoRefs(store, {
        owner,
        repo,
        service: serviceName,
        gitProtocolVersion: req.headers['git-protocol'] === 'version=2' ? 2 : 0,
        body,
      });
      send(res, result.status, result.contentType, result.body, {}, requestId);
      return;
    }
    const service = tail as 'git-upload-pack' | 'git-receive-pack';
    const result = service === 'git-upload-pack'
      ? handleUploadPack(store, { owner, repo, service, gitProtocolVersion: req.headers['git-protocol'] === 'version=2' ? 2 : 0, body })
      : handleReceivePack(store, { owner, repo, service, gitProtocolVersion: 0, body });
    send(res, result.status, result.contentType, result.body, {}, requestId);
    return;
  }

  // MCP.
  if (pathname === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, {}, requestId);
      return;
    }
    const result = handleMcp(store, method, body);
    send(res, result.status, result.contentType, result.body, {}, requestId);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, {}, requestId);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method not allowed' }, {}, requestId);
      return;
    }
    let parsed: unknown;
    try {
      parsed = body.length ? JSON.parse(body.toString('utf8')) : {};
    } catch {
      sendJson(res, 400, { message: 'request body is not valid JSON' }, {}, requestId);
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => {
        if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'operation must be an object' }] };
        const query = typeof (entry as Record<string, unknown>).query === 'string' ? ((entry as Record<string, unknown>).query as string) : '';
        const variables = ((entry as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
        return executeGraphQL(store, query, variables);
      });
      sendJson(res, 200, results, {}, requestId);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') {
      sendJson(res, 400, { message: 'request body must be a JSON object' }, {}, requestId);
      return;
    }
    const query = typeof (parsed as Record<string, unknown>).query === 'string' ? ((parsed as Record<string, unknown>).query as string) : '';
    const variables = ((parsed as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    sendJson(res, 200, executeGraphQL(store, query, variables), {}, requestId);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const isPublic = pathname === '/api/v3' || pathname === '/api/v3/' || pathname === '/api/v3/meta';
    if (!isPublic && !authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, {}, requestId);
      return;
    }
    const restPath = pathname === '/api/v3' ? '/' : pathname.slice('/api/v3'.length);
    const segments = restPath.split('/').filter((s) => s.length > 0);
    // The root path ('/api/v3' or '/api/v3/') is segments [] but must read as '/'.
    let parsedBody: unknown;
    if (body.length === 0) {
      parsedBody = undefined;
    } else {
      try {
        parsedBody = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'request body is not valid JSON' }, {}, requestId);
        return;
      }
    }
    const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
    const result = handleRest(store, method, segments, url.searchParams, parsedBody, baseUrl);
    const headers: Record<string, string> = { ...(result.headers ?? {}), 'x-oauth-scopes': 'repo, read:org' };
    if (result.status === 204 || result.body === undefined) {
      send(res, result.status, JSON_TYPE, Buffer.alloc(0), headers, requestId);
      return;
    }
    sendJson(res, result.status, result.body, headers, requestId);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, {}, requestId);
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}
