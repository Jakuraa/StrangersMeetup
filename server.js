// server.js - Local dev server: serves public/ statically, everything else through the same
// router used on Vercel. Usage: npm run dev
import './lib/config.js'; // loads .env first
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);

const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (serveStatic(req, res)) return;
    handle(req, res);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createServer().listen(PORT, () => console.log(`StrangersMeetup dev server on http://localhost:${PORT}`));
}
