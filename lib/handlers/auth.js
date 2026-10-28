// lib/handlers/auth.js - Telegram sign-in (Mini App initData, Telegram Login OIDC, legacy widget),
// session cookie issue/clear, current user, age confirmation.
import crypto from 'node:crypto';
import { HttpError, readJson, sendJson, redirect, parseCookies, serializeCookie, appendHeader, hashIp, safeEqual } from '../http.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import { botToken, siteUrl, env } from '../config.js';
import { logger } from '../logger.js';
import {
  validateInitData, validateLoginWidget, consumeNonce,
  oidcConfigured, pkcePair, authorizeUrl, exchangeCode, verifyIdToken
} from '../telegram/auth.js';
import { upsertTelegramUser, confirmAge as confirmAgeSvc } from '../services/users.js';
import {
  createSession, setSessionCookie, clearSessionCookie, csrfTokenFor, getSessionUser, requireUser, requireCsrf,
  revokeSession, revokeUserSessions
} from '../session.js';

const AuthBody = z.object({
  initData: z.string().max(4096).optional(),
  widget: z.record(z.union([z.string(), z.number()])).optional(),
  ageConfirmed: z.boolean().optional()
}).strict().refine((b) => Boolean(b.initData) !== Boolean(b.widget), 'Provide initData or widget');

async function startSession(req, res, user) {
  const token = await createSession(user.id);
  setSessionCookie(req, res, token);
  return { token, csrf: csrfTokenFor(token) };
}

function publicUser(u) {
  return { alias: u.alias, ageConfirmed: u.age_confirmed_21 };
}

/** POST /api/auth/telegram — Mini App initData or legacy Login Widget payload. */
export async function telegramAuth({ req, res, ip }) {
  await rateLimit(`auth:${hashIp(ip)}`, 20, 600);
  const body = parse(AuthBody, await readJson(req));
  const token = botToken();
  if (!token) throw new HttpError(503, 'not_configured', 'Telegram sign-in is not configured yet');

  const v = body.initData ? validateInitData(body.initData, token) : validateLoginWidget(body.widget, token);
  if (!v.ok) {
    logger.warn('telegram auth rejected', { reason: v.reason, source: body.initData ? 'initData' : 'widget' });
    throw new HttpError(401, 'invalid_telegram_auth', 'Telegram sign-in could not be verified. Please try again.');
  }
  if (!(await consumeNonce(v.hash))) {
    logger.warn('telegram auth replay rejected');
    throw new HttpError(401, 'replay', 'This sign-in link was already used. Please try again.');
  }
  // Opening the Mini App from the bot implies the user has started the bot.
  const user = await upsertTelegramUser(v.user, { ageConfirmed: body.ageConfirmed === true, botStarted: Boolean(body.initData) });
  const { csrf } = await startSession(req, res, user);
  sendJson(res, 200, { ok: true, csrf, user: publicUser(user), startParam: v.startParam || null });
}

// ---------- Telegram Login (OpenID Connect, Authorization Code + PKCE) ----------

const OIDC_COOKIE = 'sm_oidc';

function oidcSecret() {
  const s = env('SESSION_SECRET');
  if (s.length < 32) throw new HttpError(503, 'not_configured', 'Sign-in is not configured yet');
  return s;
}

function sealOidc(data) {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', oidcSecret()).update(`oidc:${body}`).digest('base64url')}`;
}

function unsealOidc(value) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', oidcSecret()).update(`oidc:${body}`).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return d.exp > Date.now() ? d : null;
  } catch {
    return null;
  }
}

function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)[\w\-./?=&#%]*$/.test(next) ? next : '/me';
}

function redirectUri() {
  return `${siteUrl()}/auth/telegram/callback`;
}

/** GET /auth/telegram/start?age=1&next=/events/x — redirects to Telegram's authorize endpoint. */
export async function oidcStart({ req, res, query, ip }) {
  await rateLimit(`auth:${hashIp(ip)}`, 20, 600);
  if (!oidcConfigured()) return redirect(res, '/signin?error=not_configured');
  if (query.get('age') !== '1') return redirect(res, `/signin?error=age&next=${encodeURIComponent(safeNext(query.get('next')))}`);
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
  appendHeader(res, 'Set-Cookie', serializeCookie(OIDC_COOKIE,
    sealOidc({ state, nonce, verifier, next: safeNext(query.get('next')), age: true, exp: Date.now() + 600_000 }),
    { maxAge: 600, secure, path: '/auth/telegram' }));
  redirect(res, authorizeUrl({ redirectUri: redirectUri(), state, challenge, nonce }));
}

/** GET /auth/telegram/callback?code&state */
export async function oidcCallback({ req, res, query }) {
  const sealed = unsealOidc(parseCookies(req.headers.cookie || '')[OIDC_COOKIE]);
  const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
  appendHeader(res, 'Set-Cookie', serializeCookie(OIDC_COOKIE, '', { maxAge: 0, secure, path: '/auth/telegram' }));
  const code = query.get('code');
  const state = query.get('state');
  if (!sealed || !code || !state || !safeEqual(state, sealed.state)) {
    logger.warn('oidc callback rejected', { reason: !sealed ? 'no state cookie' : 'state mismatch' });
    return redirect(res, '/signin?error=expired');
  }
  try {
    const idToken = await exchangeCode({ code, redirectUri: redirectUri(), verifier: sealed.verifier });
    const claims = await verifyIdToken(idToken, { nonce: sealed.nonce });
    const tokenHash = crypto.createHash('sha256').update(idToken).digest('hex');
    if (!(await consumeNonce(tokenHash, 3600))) throw new Error('id_token replay');
    // telegram:bot_access scope means the bot may DM this user.
    const user = await upsertTelegramUser({ id: Number(claims.id), name: claims.name, username: claims.preferred_username },
      { ageConfirmed: sealed.age === true, botStarted: true });
    await startSession(req, res, user);
    redirect(res, sealed.next);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.warn('oidc login failed', { reason: err.message });
    redirect(res, '/signin?error=failed');
  }
}

/** POST /api/auth/dev — local development only; refused on any Vercel deployment. */
export async function devAuth({ req, res }) {
  if (process.env.VERCEL || env('DEV_LOGIN') !== 'true' || env('NODE_ENV') === 'production') {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  const user = await upsertTelegramUser({ id: 100000001, first_name: 'Local Tester' }, { ageConfirmed: true });
  const { csrf } = await startSession(req, res, user);
  sendJson(res, 200, { ok: true, csrf, user: publicUser(user) });
}

/** Sign out this browser: revoke its server-side session (CSRF-checked when signed in) and clear the cookie. */
export async function logout({ req, res }) {
  let user = null;
  try {
    user = await getSessionUser(req);
  } catch (err) {
    if (err.code !== 'DB_NOT_CONFIGURED' && !(err instanceof HttpError)) throw err;
  }
  if (user) {
    requireCsrf(req, user);
    await revokeSession(user.sessionId, 'logout');
  }
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}

/** Sign out on every device: revoke all of this user's sessions. */
export async function logoutAll({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  const revoked = await revokeUserSessions(user.id, 'logout_all');
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true, revoked });
}

export async function me({ req, res }) {
  let user = null;
  try {
    user = await getSessionUser(req);
  } catch (err) {
    if (err.code !== 'DB_NOT_CONFIGURED' && !(err instanceof HttpError)) throw err;
  }
  if (!user) return sendJson(res, 200, { ok: true, user: null });
  sendJson(res, 200, { ok: true, user: publicUser(user), csrf: csrfTokenFor(user.sessionToken) });
}

export async function confirmAge({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await confirmAgeSvc(user.id);
  sendJson(res, 200, { ok: true });
}
