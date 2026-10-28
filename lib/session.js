// lib/session.js - Stateless HMAC-signed session cookie + CSRF token derived from it.
import crypto from 'node:crypto';
import { env } from './config.js';
import { HttpError, parseCookies, serializeCookie, appendHeader, safeEqual } from './http.js';
import { db } from './db.js';

export const SESSION_COOKIE = 'sm_session';
const SESSION_TTL_S = 7 * 24 * 3600;

function secret() {
  const s = env('SESSION_SECRET');
  if (s.length < 32) throw new HttpError(503, 'not_configured', 'Sign-in is not configured yet (SESSION_SECRET)');
  return s;
}

function sign(data) {
  return crypto.createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createSessionToken(userId, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    u: userId,
    exp: Math.floor(now / 1000) + SESSION_TTL_S,
    n: crypto.randomBytes(8).toString('base64url')
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  let expected;
  try {
    expected = sign(body);
  } catch {
    return null;
  }
  if (!safeEqual(mac, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.u || typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function csrfTokenFor(sessionToken) {
  return crypto.createHmac('sha256', secret()).update(`csrf:${sessionToken}`).digest('base64url').slice(0, 32);
}

function isSecureRequest(req) {
  return Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
}

export function setSessionCookie(req, res, token) {
  appendHeader(res, 'Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_S, secure: isSecureRequest(req) }));
}

export function clearSessionCookie(req, res) {
  appendHeader(res, 'Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isSecureRequest(req) }));
}

/** Resolve the current user from the cookie. Returns null when signed out or user not active. */
export async function getSessionUser(req) {
  if (req._sessionUser !== undefined) return req._sessionUser;
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  const data = token ? verifySessionToken(token) : null;
  let user = null;
  if (data) {
    user = await db.one(
      `SELECT id, telegram_user_id, alias, city, age_confirmed_21, status, bot_started, organiser_enabled
         FROM users WHERE id = $1`, [data.u]);
    if (user && user.status !== 'active') user = null;
    if (user) user.sessionToken = token;
  }
  req._sessionUser = user;
  return user;
}

export async function requireUser(req) {
  const user = await getSessionUser(req);
  if (!user) throw new HttpError(401, 'auth_required', 'Please continue with Telegram first');
  return user;
}

/** Double-check CSRF on state-changing session-authenticated requests. */
export function requireCsrf(req, user) {
  const header = req.headers['x-csrf-token'];
  if (!header || !safeEqual(header, csrfTokenFor(user.sessionToken))) {
    throw new HttpError(403, 'csrf', 'Security check failed. Refresh the page and try again.');
  }
  // Defence in depth: reject cross-site Origin when present.
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try {
      if (new URL(origin).host !== host) throw new Error('x');
    } catch {
      throw new HttpError(403, 'csrf', 'Cross-site request rejected');
    }
  }
}
