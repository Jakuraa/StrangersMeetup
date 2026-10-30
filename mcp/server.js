// mcp/server.js - Local-only Model Context Protocol server for StrangersMeetup Control.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { MCP_PORT, MCP_HOST, MCP_API_KEY, IS_CLOUD_HOSTED } from './config.js';
import { validateBearerToken, RateLimiter } from './security.js';
import { logMcpAudit } from './audit.js';
import { registerAllTools, REGISTERED_TOOL_NAMES } from './tools/index.js';

export function createMcpServerInstance() {
  const server = new McpServer({
    name: 'strangersmeetup-control-mcp',
    version: '1.0.0'
  });

  registerAllTools(server);
  return server;
}

const rateLimiter = new RateLimiter({ maxRequests: 60, windowMs: 60_000 });

/**
 * Creates and starts the HTTP MCP server binding strictly to 127.0.0.1.
 */
export async function startHttpServer(port = MCP_PORT) {
  const mcpServer = createMcpServerInstance();

  // Primary transport: Streamable HTTP
  const streamableTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });

  await mcpServer.connect(streamableTransport);

  // Map for SSE sessions
  const sseTransports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const forwarded = req.headers['x-forwarded-for'];
    const clientIp = (forwarded ? forwarded.split(',')[0].trim() : null) || req.socket.remoteAddress || '127.0.0.1';
    const startTime = Date.now();

    // In local mode, enforce strict loopback-only binding
    if (!IS_CLOUD_HOSTED) {
      const socketIp = req.socket.remoteAddress || '127.0.0.1';
      if (socketIp !== '127.0.0.1' && socketIp !== '::1' && socketIp !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Connections permitted from localhost only in local mode' }));
        return;
      }
    } else {
      // In cloud mode, verify HTTPS forwarding if behind an edge router
      const proto = req.headers['x-forwarded-proto'];
      if (proto && proto !== 'https') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: HTTPS required' }));
        return;
      }
    }

    // Rate limiting check
    if (!rateLimiter.check(clientIp)) {
      logMcpAudit({
        tool: 'HTTP_REQUEST',
        args: { url: req.url, method: req.method },
        status: 'RATE_LIMITED',
        clientIp
      });
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too Many Requests' }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const authHeader = req.headers['authorization'];
    const isAuthenticated = validateBearerToken(authHeader);

    // Platform Health Check: Safe unauthenticated ping for Render health checks (/health or /healthz)
    // Reveals no operational details, tool lists, or secrets to unauthenticated callers
    if ((url.pathname === '/health' || url.pathname === '/healthz') && req.method === 'GET') {
      if (isAuthenticated) {
        // Authenticated clients receive full discovery details
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          mcp: 'StrangersMeetup Control MCP',
          version: '1.0.0',
          tools_count: REGISTERED_TOOL_NAMES.length,
          tools: REGISTERED_TOOL_NAMES
        }));
      } else {
        // Unauthenticated health probes (e.g. Render edge monitor) receive minimal status
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      }
      return;
    }

    // Bearer token authentication required on every operational MCP endpoint
    if (!isAuthenticated) {
      logMcpAudit({
        tool: 'HTTP_AUTH',
        args: { url: req.url, method: req.method },
        status: 'UNAUTHORIZED',
        clientIp
      });
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer error="invalid_token"'
      });
      res.end(JSON.stringify({ error: 'Unauthorized: Valid Bearer token required' }));
      return;
    }

    // Streamable HTTP endpoint: /mcp
    if (url.pathname === '/mcp' || url.pathname === '/') {
      logMcpAudit({
        tool: 'MCP_STREAMABLE_HTTP',
        args: { method: req.method, pathname: url.pathname },
        status: 'SUCCESS',
        durationMs: Date.now() - startTime,
        clientIp
      });
      return streamableTransport.handleRequest(req, res);
    }

    // Classic SSE endpoint: GET /sse
    if (url.pathname === '/sse' && req.method === 'GET') {
      const sseTransport = new SSEServerTransport('/messages', res);
      sseTransports.set(sseTransport.sessionId, sseTransport);

      const sseMcpServer = createMcpServerInstance();
      await sseMcpServer.connect(sseTransport);

      sseTransport.onclose = () => {
        sseTransports.delete(sseTransport.sessionId);
      };

      await sseTransport.start();
      logMcpAudit({
        tool: 'MCP_SSE_CONNECT',
        args: { sessionId: sseTransport.sessionId },
        status: 'SUCCESS',
        durationMs: Date.now() - startTime,
        clientIp
      });
      return;
    }

    // Classic SSE message endpoint: POST /messages
    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      const transport = sseTransports.get(sessionId);

      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found or expired' }));
        return;
      }

      await transport.handlePostMessage(req, res);
      logMcpAudit({
        tool: 'MCP_SSE_MESSAGE',
        args: { sessionId },
        status: 'SUCCESS',
        durationMs: Date.now() - startTime,
        clientIp
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  // Setup graceful shutdown handlers
  setupGracefulShutdown(httpServer, sseTransports);

  return new Promise((resolve) => {
    httpServer.listen(port, MCP_HOST, () => {
      resolve(httpServer);
    });
  });
}

/**
 * Handles graceful shutdown on SIGTERM / SIGINT for containerized deployments.
 */
export function setupGracefulShutdown(httpServer, sseTransports = new Map()) {
  const shutdown = (signal) => {
    logMcpAudit({ tool: 'SERVER_SHUTDOWN', args: { signal }, status: 'SUCCESS' });
    for (const [id, transport] of sseTransports.entries()) {
      try {
        transport.close?.();
      } catch {}
    }
    sseTransports.clear();
    httpServer.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(1);
    }, 5000).unref();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Starts the MCP server in Stdio mode for local CLI / desktop hosts.
 */
export async function startStdioServer() {
  const mcpServer = createMcpServerInstance();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logMcpAudit({ tool: 'MCP_STDIO_START', status: 'SUCCESS' });
}

// Direct execution entrypoint
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  if (process.argv.includes('--stdio')) {
    startStdioServer().catch((err) => {
      console.error('Fatal MCP Stdio server error:', err);
      process.exit(1);
    });
  } else {
    startHttpServer(MCP_PORT).then((server) => {
      console.log(`StrangersMeetup Control MCP listening on http://${MCP_HOST}:${MCP_PORT}`);
      console.log(`MCP Auth Key: ${MCP_API_KEY}`);
      console.log(`Streamable HTTP endpoint: http://${MCP_HOST}:${MCP_PORT}/mcp`);
      console.log(`SSE endpoint: http://${MCP_HOST}:${MCP_PORT}/sse`);
    }).catch((err) => {
      console.error('Fatal MCP HTTP server error:', err);
      process.exit(1);
    });
  }
}
