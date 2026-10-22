import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';

// Stateless Streamable HTTP entrypoint (MCP_TRANSPORT=http).
//
// Each POST /mcp gets a fresh server + transport, so requests are independent and nothing needs
// sticky sessions behind a reverse proxy. Responses are plain JSON (no SSE).
//
// Env:
//   MCP_HTTP_HOST   bind address (default 0.0.0.0)
//   MCP_HTTP_PORT   port (default 3000)
//   MCP_HTTP_TOKEN  required static bearer token; requests without it get 401. The process refuses
//                   to start without one, so the tools are never exposed unauthenticated.

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    // Stateless server: no SSE stream (GET) and no sessions to delete (DELETE).
    res.setHeader('allow', 'POST');
    rpcError(res, 405, 'Method not allowed');
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (err) {
    rpcError(res, 400, (err as Error).message);
    return;
  }

  const { server } = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error('[http] request failed:', (err as Error).message);
    if (!res.headersSent) rpcError(res, 500, 'Internal server error');
  }
}

export async function startHttp(): Promise<void> {
  const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
  const port = Number(process.env.MCP_HTTP_PORT || 3000);
  const token = process.env.MCP_HTTP_TOKEN || '';
  if (!token) {
    throw new Error('MCP_HTTP_TOKEN is required when MCP_TRANSPORT=http');
  }

  const httpServer = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];

    if (path === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path !== '/mcp') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      res.setHeader('www-authenticate', 'Bearer');
      rpcError(res, 401, 'Unauthorized');
      return;
    }
    void handleMcp(req, res);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));

  const { readonly, registeredCount, skippedDestructive } = buildServer();
  const modeLabel = readonly ? 'READONLY' : 'full';
  console.error(
    `Datto RMM MCP Server listening on http://${host}:${port}/mcp (mode: ${modeLabel}, ${registeredCount} tools registered, ${skippedDestructive} destructive skipped)`,
  );
}
