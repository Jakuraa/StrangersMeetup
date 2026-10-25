// server.js - Lightweight zero-dependency server compatible with Hatchable conventions
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './lib/logger.js';
import { getConfig } from './lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_DIR = path.join(__dirname, 'api');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

// Route cache for dynamic API endpoints
const apiHandlers = new Map();

async function getApiHandler(pathname) {
  const normalized = pathname.replace(/^\/api\/?/, '').replace(/\/$/, '') || 'index';
  if (apiHandlers.has(normalized)) {
    return apiHandlers.get(normalized);
  }

  const possiblePaths = [
    path.join(API_DIR, `${normalized}.js`),
    path.join(API_DIR, normalized, 'index.js')
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const mod = await import(`file://${filePath}`);
        const handler = mod.default || mod;
        apiHandlers.set(normalized, handler);
        return handler;
      } catch (err) {
        logger.error(`Error importing API module ${filePath}`, err);
        return null;
      }
    }
  }

  return null;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Standard Security Headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // 1. API Route Dispatch
    if (pathname.startsWith('/api/')) {
      const handler = await getApiHandler(pathname);
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
      }

      // Collect request body for POST/PUT/PATCH
      let rawBody = '';
      req.on('data', (chunk) => {
        rawBody += chunk;
        if (rawBody.length > 1e6) {
          req.destroy(); // Protect against payload flood (1MB limit)
        }
      });

      req.on('end', async () => {
        if (rawBody && req.headers['content-type']?.includes('application/json')) {
          try {
            req.body = JSON.parse(rawBody);
          } catch {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: 'Invalid JSON Body' }));
          }
        } else {
          req.body = {};
        }

        try {
          await handler(req, res);
        } catch (err) {
          logger.error(`Unhandled API exception on ${pathname}`, err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal Server Error' }));
          }
        }
      });
      return;
    }

    // 2. Static File Serving (Direct serving from public/)
    let safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    if (safePath === '/' || safePath === '') {
      safePath = '/index.html';
    }

    let filePath = path.join(PUBLIC_DIR, safePath);

    // If request has no extension and is not found, check for corresponding .html
    if (!path.extname(filePath) && !fs.existsSync(filePath)) {
      if (fs.existsSync(`${filePath}.html`)) {
        filePath = `${filePath}.html`;
      }
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Fallback to index.html or 404
        const notFoundPath = path.join(PUBLIC_DIR, '404.html');
        if (fs.existsSync(notFoundPath)) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          fs.createReadStream(notFoundPath).pipe(res);
        } else {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('404 Not Found');
        }
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600');
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

// Start standalone server when executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  server.listen(PORT, async () => {
    logger.info(`StrangersMeetup server active on port ${PORT}`, {
      port: PORT,
      env: await getConfig('NODE_ENV', 'development'),
      mode: 'zero-build-hatchable-compatible'
    });
    console.log(`\n✨ StrangersMeetup server running at http://localhost:${PORT}`);
  });
}
