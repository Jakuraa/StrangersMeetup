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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sign a cookie value for an existing user_sessions row. */
export function createSessionToken(userId, sessionId, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({
    u: userId,
    s: sessionId,
    exp: Math.floor(now / 1000) + SESSION_TTL_S,
    n: crypto.randomBytes(8).toString('base64url')
  })).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Record a new server-side session and return its signed cookie value. */
export async function createSession(userId, q = db) {
  secret(); // refuse (503) before writing a row we could never sign a cookie for
  const { rows } = await q.query(
    `INSERT INTO user_sessions (user_id, expires_at) VALUES ($1, now() + make_interval(secs => $2)) RETURNING id`,
    [userId, SESSION_TTL_S]);
  return createSessionToken(userId, rows[0].id);
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
    // Cookies from before server-side sessions (no session id) are no longer accepted.
    if (typeof data.s !== 'string' || !UUID_RE.test(data.s)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Revoke one session (sign out on this device). */
export async function revokeSession(sessionId, reason = 'logout') {
  await db.query(`UPDATE user_sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
}

/** Revoke every live session of a user (sign out everywhere / admin action). Returns how many. */
export async function revokeUserSessions(userId, reason = 'logout_all', q = db) {
  const r = await q.query(`UPDATE user_sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, reason]);
  return r.rowCount;
}

/** Cron cleanup: drop sessions that expired or were revoked more than 30 days ago. */
export async function pruneSessions() {
  const r = await db.query(
    `DELETE FROM user_sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`);
  return r.rowCount;
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
      `SELECT u.id, u.telegram_user_id, u.alias, u.city, u.age_confirmed_21, u.status, u.bot_started, u.organiser_enabled
         FROM users u JOIN user_sessions s ON s.user_id = u.id
        WHERE u.id = $1 AND s.id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`, [data.u, data.s]);
    if (user && user.status !== 'active') user = null;
    if (user) {
      user.sessionToken = token;
      user.sessionId = data.s;
    }
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
