// lib/http.js - Request/response helpers shared by the router and handlers.
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const MAX_BODY_BYTES = 64 * 1024;

/** Read the raw request body once (needed for webhook signature checks). */
export function readRawBody(req, limit = MAX_BODY_BYTES) {
  if (req._rawBody !== undefined) return Promise.resolve(req._rawBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      req._rawBody = Buffer.concat(chunks).toString('utf8');
      resolve(req._rawBody);
    });
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'invalid_json', 'Invalid JSON body');
  }
}

export async function readForm(req) {
  const raw = await readRawBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (!prev) res.setHeader(name, value);
  else res.setHeader(name, Array.isArray(prev) ? [...prev, value] : [prev, value]);
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

export function hashIp(ip) {
  const salt = process.env.SESSION_SECRET || 'no-salt';
  return crypto.createHmac('sha256', salt).update(String(ip)).digest('hex').slice(0, 32);
}

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function sendHtml(res, status, html, { cache = 'no-store', headers = {} } = {}) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(html);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', cache = 'public, max-age=300') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.end(text);
}

export function redirect(res, location, status = 302) {
  res.statusCode = status;
  res.setHeader('Location', location);
  res.end();
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Public HTML cache: CDN caches briefly; browsers revalidate. */
export const PUBLIC_CACHE = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
