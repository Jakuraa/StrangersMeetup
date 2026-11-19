// lib/handlers/auth.js - Telegram sign-in (Mini App initData, Telegram Login OIDC, legacy widget),
// session cookie issue/clear, current user, age confirmation.
import crypto from 'node:crypto';
import { HttpError, readJson, readForm, sendJson, redirect, parseCookies, serializeCookie, appendHeader, hashIp, safeEqual } from '../http.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import { botToken, siteUrl, env } from '../config.js';
import { logger } from '../logger.js';
import { db } from '../db.js';
import { PERSONAS, PERSONA_KEYS, devLoginEnabled, previewReviewerEnabled, REVIEWER_TG_ID, REVIEWER_ALIAS } from '../dev-personas.js';
import {
  validateInitData, validateLoginWidget, consumeNonce,
  oidcConfigured, pkcePair, authorizeUrl, exchangeCode, verifyIdToken
} from '../telegram/auth.js';
import {
  upsertTelegramUser, confirmAge as confirmAgeSvc,
  createAccountLinkToken, getAccountLinkStatus,
  getNotificationPreferences, updateNotificationPreferences
} from '../services/users.js';
import {
  createSession, setSessionCookie, clearSessionCookie, csrfTokenFor, getSessionUser, requireUser, requireCsrf,
  revokeSession, revokeUserSessions
} from '../session.js';
import {
  requestWhatsAppOtp,
  verifyWhatsAppOtpAndResolveUser,
  unlinkWhatsAppIdentity,
  getLinkedIdentities
} from '../services/whatsapp-auth.js';
import { getConsents, recordConsent } from '../services/communication-consent.js';
import {
  registerTelegramOnboarding,
  registerWhatsAppOnboarding,
  trackOnboardingAction,
  getOnboardingState
} from '../services/community-onboarding.js';
import { whatsappChannelUrl, telegramCommunityUrl } from '../config.js';

const AuthBody = z.object({
  initData: z.string().max(4096).optional(),
  widget: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  ageConfirmed: z.boolean().optional()
}).strict().refine((b) => Boolean(b.initData) !== Boolean(b.widget), 'Provide initData or widget');

async function startSession(req, res, user) {
  const token = await createSession(user.id);
  setSessionCookie(req, res, token);
  return { token, csrf: csrfTokenFor(token) };
}

const DevAuthBody = z.object({
  persona: z.enum(PERSONA_KEYS).default('guest'),
  ageConfirmed: z.boolean().optional()
}).strict();

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
  await registerTelegramOnboarding({
    userId: user.id,
    telegramUserId: user.telegram_user_id,
    botStarted: false
  }).catch((err) => logger.warn('telegram onboarding registration failed', { error: err.message }));
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
    await registerTelegramOnboarding({
      userId: user.id,
      telegramUserId: user.telegram_user_id,
      botStarted: true
    }).catch((err) => logger.warn('telegram onboarding registration on oidc failed', { error: err.message }));
    await startSession(req, res, user);
    redirect(res, sealed.next);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.warn('oidc login failed', { reason: err.message });
    redirect(res, '/signin?error=failed');
  }
}

const TG_STATE_COOKIE = 'sm_tg_state';
const TG_CONTROL_PARAMS = new Set(['state', 'next', '__path']);
const TG_REQUIRED_FIELDS = ['id', 'auth_date', 'hash'];

/** GET /auth/telegram/widget-callback — Telegram Login Widget redirect flow with CSRF state validation. */
export async function widgetCallback({ req, res, query, ip }) {
  await rateLimit(`auth:${hashIp(ip)}`, 20, 600);
  const nextPath = safeNext(query.get('next'));
  const token = botToken();
  if (!token) {
    logger.warn('telegram widget callback rejected: bot token not configured');
    return redirect(res, '/signin?error=not_configured');
  }

  const cookies = parseCookies(req.headers.cookie || '');
  const stateCookie = cookies[TG_STATE_COOKIE];
  const stateQuery = query.get('state');
  const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
  appendHeader(res, 'Set-Cookie', serializeCookie(TG_STATE_COOKIE, '', { maxAge: 0, secure, path: '/auth/telegram' }));

  if (!stateCookie || !stateQuery || !safeEqual(stateCookie, stateQuery)) {
    logger.warn('telegram widget callback rejected: state mismatch or expired');
    return redirect(res, `/signin?error=expired&next=${encodeURIComponent(nextPath)}`);
  }

  // Reject duplicate parameters (HTTP Parameter Pollution defense)
  for (const key of query.keys()) {
    if (query.getAll(key).length > 1) {
      logger.warn('telegram widget callback rejected: duplicate parameter', { key });
      return redirect(res, `/signin?error=invalid_telegram_auth&next=${encodeURIComponent(nextPath)}`);
    }
  }

  // Reject missing required Telegram fields
  for (const field of TG_REQUIRED_FIELDS) {
    if (!query.has(field) || !query.get(field)) {
      logger.warn('telegram widget callback rejected: missing required field', { field });
      return redirect(res, `/signin?error=invalid_telegram_auth&next=${encodeURIComponent(nextPath)}`);
    }
  }

  const hashVal = query.get('hash');
  const idVal = query.get('id');
  const authDateVal = query.get('auth_date');

  // Reject malformed required fields
  if (!/^[0-9a-fA-F]{64}$/.test(hashVal) || !/^\d{1,16}$/.test(idVal) || !/^\d{9,12}$/.test(authDateVal)) {
    logger.warn('telegram widget callback rejected: malformed required fields');
    return redirect(res, `/signin?error=invalid_telegram_auth&next=${encodeURIComponent(nextPath)}`);
  }

  // Preserve all Telegram-signed fields, explicitly excluding application control parameters
  const widgetData = {};
  for (const [key, val] of query.entries()) {
    if (!TG_CONTROL_PARAMS.has(key) && val !== null && val !== undefined) {
      widgetData[key] = val;
    }
  }

  const v = validateLoginWidget(widgetData, token);
  if (!v.ok) {
    logger.warn('telegram widget callback rejected: validation failed', { reason: v.reason });
    return redirect(res, `/signin?error=invalid_telegram_auth&next=${encodeURIComponent(nextPath)}`);
  }

  if (!(await consumeNonce(v.hash, 86400))) {
    logger.warn('telegram widget callback rejected: replay attempt');
    return redirect(res, `/signin?error=replay&next=${encodeURIComponent(nextPath)}`);
  }

  try {
    const user = await upsertTelegramUser(v.user, { ageConfirmed: true, botStarted: false });
    await registerTelegramOnboarding({
      userId: user.id,
      telegramUserId: user.telegram_user_id,
      botStarted: false
    }).catch((err) => logger.warn('telegram onboarding registration on widget failed', { error: err.message }));
    await startSession(req, res, user);
    return redirect(res, nextPath);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    logger.warn('telegram widget callback login failed', { reason: err.message });
    return redirect(res, '/signin?error=failed');
  }
}

/** POST /api/auth/dev {persona} — sign in as a seeded local persona. 404 unless devLoginEnabled(). */
export async function devAuth({ req, res }) {
  if (!devLoginEnabled()) throw new HttpError(404, 'not_found', 'Not found');
  const body = parse(DevAuthBody, await readJson(req));
  const p = PERSONAS[body.persona];
  // Only users created by `npm run seed:local`; this endpoint never creates an account.
  const user = await db.one('SELECT * FROM users WHERE telegram_user_id = $1', [p.tg]);
  if (!user) throw new HttpError(409, 'not_seeded', 'Test personas are not seeded. Run: npm run seed:local');
  if (user.status !== 'active') throw new HttpError(403, 'account_restricted', 'This persona is not active');
  const { csrf } = await startSession(req, res, user);
  sendJson(res, 200, { ok: true, csrf, user: publicUser(user), persona: body.persona, landing: p.landing });
}

/** POST /api/auth/preview-reviewer — restricted synthetic reviewer sign-in for preview only. 404 in production. */
export async function previewReviewerAuth({ req, res, query, ip }) {
  if (!previewReviewerEnabled()) throw new HttpError(404, 'not_found', 'Not found');
  await rateLimit(`reviewer:${hashIp(ip)}`, 30, 600);
  let next = '/me';
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const form = await readForm(req).catch(() => ({}));
    if (form && form.next) next = safeNext(form.next);
  } else if (ct.includes('application/json')) {
    const raw = await readJson(req).catch(() => ({}));
    if (raw && raw.next) next = safeNext(raw.next);
  }
  if (query && query.get('next')) next = safeNext(query.get('next'));

  // Ensure or fetch the synthetic reviewer user (guaranteed guest role, no admin/organiser escalation)
  let user = await db.one('SELECT * FROM users WHERE telegram_user_id = $1', [REVIEWER_TG_ID]);
  if (!user) {
    user = (await db.query(
      `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status, bot_started)
       VALUES ($1, $2, true, now(), 'active', true)
       ON CONFLICT (telegram_user_id) DO UPDATE SET age_confirmed_21 = true, status = 'active'
       RETURNING *`,
      [REVIEWER_TG_ID, REVIEWER_ALIAS]
    )).rows[0];
  }
  if (user.status !== 'active') throw new HttpError(403, 'account_restricted', 'Reviewer account is not active');

  const { csrf } = await startSession(req, res, user);
  const accept = req.headers['accept'] || '';
  if (accept.includes('application/json')) {
    sendJson(res, 200, { ok: true, csrf, user: publicUser(user), redirect: next });
  } else {
    redirect(res, next);
  }
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

export async function createTelegramLinkToken({ req, res }) {
  const user = await getSessionUser(req).catch(() => null);
  const { token, linkUrl, expiresAt } = await createAccountLinkToken(user?.id || null);
  sendJson(res, 200, { ok: true, token, linkUrl, expiresAt });
}

export async function getTelegramLinkStatus({ res, query }) {
  const token = query?.get?.('token');
  if (!token) throw new HttpError(400, 'validation', 'token is required');
  const status = await getAccountLinkStatus(token);
  if (!status) throw new HttpError(404, 'not_found', 'Token not found');
  sendJson(res, 200, { ok: true, ...status });
}

export async function getMyNotificationPreferences({ req, res }) {
  const user = await requireUser(req);
  const prefs = await getNotificationPreferences(user.id);
  sendJson(res, 200, {
    ok: true,
    preferences: prefs ? {
      ...prefs,
      remindersEnabled: prefs.reminders_enabled,
      quietHoursEnabled: prefs.quiet_hours_enabled,
      quietHoursStart: prefs.quiet_hours_start,
      quietHoursEnd: prefs.quiet_hours_end
    } : null
  });
}

export async function updateMyNotificationPreferences({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  const body = await readJson(req);
  const prefs = await updateNotificationPreferences(user.id, {
    remindersEnabled: body.remindersEnabled !== undefined ? body.remindersEnabled : body.reminders_enabled,
    quietHoursEnabled: body.quietHoursEnabled !== undefined ? body.quietHoursEnabled : body.quiet_hours_enabled,
    quietHoursStart: body.quietHoursStart !== undefined ? body.quietHoursStart : body.quiet_hours_start,
    quietHoursEnd: body.quietHoursEnd !== undefined ? body.quietHoursEnd : body.quiet_hours_end
  });
  sendJson(res, 200, {
    ok: true,
    preferences: prefs ? {
      ...prefs,
      remindersEnabled: prefs.reminders_enabled,
      quietHoursEnabled: prefs.quiet_hours_enabled,
      quietHoursStart: prefs.quiet_hours_start,
      quietHoursEnd: prefs.quiet_hours_end
    } : null
  });
}

// ---------- WhatsApp Authentication & Identity Linking ----------

const WhatsAppOtpRequestBody = z.object({
  phone: z.string().min(5).max(30),
  promotionalOptIn: z.boolean().optional().default(false)
}).strict();

const WhatsAppOtpVerifyBody = z.object({
  challengeId: z.string().uuid(),
  phone: z.string().min(5).max(30),
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  promotionalOptIn: z.boolean().optional().default(false)
}).strict();

const WhatsAppLinkBody = z.object({
  challengeId: z.string().uuid(),
  phone: z.string().min(5).max(30),
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  promotionalOptIn: z.boolean().optional().default(false)
}).strict();

const WhatsAppUnlinkBody = z.object({
  phone: z.string().min(5).max(30).optional()
}).strict();

const CommunicationPreferencesPatchBody = z.object({
  channel: z.enum(['whatsapp', 'telegram', 'email', 'sms']),
  purpose: z.enum(['transactional', 'promotional']),
  status: z.enum(['opted_in', 'opted_out'])
}).strict();

/** POST /api/auth/whatsapp/otp — Request WhatsApp OTP. */
export async function requestWhatsAppOtpHandler({ req, res, ip }) {
  await rateLimit(`wa_otp_ip:${hashIp(ip)}`, 10, 300);

  const ct = req.headers['content-type'] || '';
  const isFormUrlEncoded = ct.includes('application/x-www-form-urlencoded');
  const isHtmlAccept = (req.headers['accept'] || '').includes('text/html') && !ct.includes('application/json');

  let rawBody;
  let nextUrl = '/me';
  let enteredPhone = '';
  if (isFormUrlEncoded) {
    const form = await readForm(req);
    nextUrl = safeNext(form.next);
    enteredPhone = form.phone ? String(form.phone).trim() : '';
    const promoOptIn = form.promotionalOptIn === 'on' || form.promotionalOptIn === 'true' || form.promotionalOptIn === true;
    rawBody = {
      phone: enteredPhone,
      promotionalOptIn: promoOptIn
    };
    if (form.ageConfirmed !== 'on' && form.ageConfirmed !== 'true' && form.ageConfirmed !== true) {
      if (isHtmlAccept) {
        const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
        if (enteredPhone) {
          appendHeader(res, 'Set-Cookie', serializeCookie('sm_wa_last_phone', enteredPhone, { maxAge: 600, secure, path: '/' }));
        }
        return redirect(res, `/signin?error=age&next=${encodeURIComponent(nextUrl)}`);
      }
      throw new HttpError(400, 'age_required', 'Please confirm you are 21 or older');
    }
  } else {
    rawBody = await readJson(req);
    enteredPhone = rawBody?.phone ? String(rawBody.phone).trim() : '';
  }

  let body;
  try {
    body = parse(WhatsAppOtpRequestBody, rawBody);
  } catch (err) {
    if (isHtmlAccept) {
      const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
      if (enteredPhone) {
        appendHeader(res, 'Set-Cookie', serializeCookie('sm_wa_last_phone', enteredPhone, { maxAge: 600, secure, path: '/' }));
      }
      return redirect(res, `/signin?error=invalid_phone&next=${encodeURIComponent(nextUrl)}`);
    }
    throw err;
  }

  const userAgent = req.headers['user-agent'] || null;

  let result;
  try {
    result = await requestWhatsAppOtp({
      phone: body.phone,
      ip,
      userAgent,
      promotionalOptIn: body.promotionalOptIn
    });
  } catch (err) {
    if (isHtmlAccept) {
      const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
      if (enteredPhone) {
        appendHeader(res, 'Set-Cookie', serializeCookie('sm_wa_last_phone', enteredPhone, { maxAge: 600, secure, path: '/' }));
      }
      const errCode = err.code === 'whatsapp_unavailable' ? 'whatsapp_unavailable' : (err.code || 'failed');
      return redirect(res, `/signin?error=${encodeURIComponent(errCode)}&next=${encodeURIComponent(nextUrl)}`);
    }
    throw err;
  }

  if (isHtmlAccept) {
    const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
    appendHeader(res, 'Set-Cookie', serializeCookie('sm_wa_step', JSON.stringify({
      challengeId: result.challengeId,
      phoneMasked: result.phoneMasked,
      phone: body.phone,
      next: nextUrl,
      promoOptIn: body.promotionalOptIn,
      createdAt: Date.now()
    }), { maxAge: 600, secure, path: '/' }));
    appendHeader(res, 'Set-Cookie', serializeCookie('sm_wa_last_phone', body.phone, { maxAge: 600, secure, path: '/' }));
    return redirect(res, `/signin?step=otp&next=${encodeURIComponent(nextUrl)}`);
  }

  sendJson(res, 200, {
    ok: true,
    challengeId: result.challengeId,
    phoneMasked: result.phoneMasked,
    resendAfterSeconds: result.resendAfterSeconds,
    expiresInSeconds: result.expiresInSeconds,
    ...(process.env.DEV_LOGIN === 'true' || process.env.NODE_ENV === 'test' ? { devOtp: result.devOtp } : {})
  });
}

/** POST /api/auth/whatsapp/verify — Verify OTP & start session. */
export async function verifyWhatsAppOtpHandler({ req, res, ip }) {
  await rateLimit(`wa_verify_ip:${hashIp(ip)}`, 25, 300);

  const ct = req.headers['content-type'] || '';
  const isFormUrlEncoded = ct.includes('application/x-www-form-urlencoded');
  const isHtmlAccept = (req.headers['accept'] || '').includes('text/html') && !ct.includes('application/json');

  let rawBody;
  let nextUrl = '/me';
  if (isFormUrlEncoded) {
    const form = await readForm(req);
    nextUrl = safeNext(form.next);
    const cookies = parseCookies(req.headers.cookie || '');
    let cookieStep = null;
    try { cookieStep = JSON.parse(cookies['sm_wa_step'] || '{}'); } catch {}

    rawBody = {
      challengeId: form.challengeId || cookieStep?.challengeId,
      phone: form.phone || cookieStep?.phone,
      code: form.otp || form.code,
      promotionalOptIn: form.promotionalOptIn === 'on' || form.promotionalOptIn === 'true' || Boolean(cookieStep?.promoOptIn)
    };
  } else {
    rawBody = await readJson(req);
  }

  let body;
  try {
    body = parse(WhatsAppOtpVerifyBody, rawBody);
  } catch (err) {
    if (isHtmlAccept) {
      return redirect(res, `/signin?step=otp&error=invalid_otp&next=${encodeURIComponent(nextUrl)}`);
    }
    throw err;
  }

  const userAgent = req.headers['user-agent'] || null;

  let auth;
  try {
    auth = await verifyWhatsAppOtpAndResolveUser({
      challengeId: body.challengeId,
      phone: body.phone,
      code: body.code,
      ip,
      userAgent,
      promotionalOptIn: body.promotionalOptIn
    });
  } catch (err) {
    if (isHtmlAccept) {
      const errCode = err.code || 'invalid_otp';
      return redirect(res, `/signin?step=otp&error=${encodeURIComponent(errCode)}&next=${encodeURIComponent(nextUrl)}`);
    }
    throw err;
  }

  const { csrf } = await startSession(req, res, auth.user);
  await registerWhatsAppOnboarding({
    userId: auth.user.id,
    phone: auth.user.phone
  }).catch((err) => logger.warn('whatsapp onboarding registration failed', { error: err.message }));

  if (isHtmlAccept) {
    const secure = Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
    appendHeader(res, 'Set-Cookie', serializeCookie('sm_wa_step', '', { maxAge: 0, secure, path: '/' }));
    appendHeader(res, 'Set-Cookie', serializeCookie('sm_wa_last_phone', '', { maxAge: 0, secure, path: '/' }));
    return redirect(res, nextUrl);
  }

  sendJson(res, 200, {
    ok: true,
    csrf,
    user: publicUser(auth.user),
    isNewUser: auth.isNewUser,
    onboarding: {
      channel: 'whatsapp',
      channelUrl: whatsappChannelUrl(),
      offered: true
    }
  });
}

/** POST /api/auth/whatsapp/link — Link WhatsApp to current signed-in user. */
export async function linkWhatsAppHandler({ req, res, ip }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const body = parse(WhatsAppLinkBody, await readJson(req));
  const userAgent = req.headers['user-agent'] || null;

  const auth = await verifyWhatsAppOtpAndResolveUser({
    challengeId: body.challengeId,
    phone: body.phone,
    code: body.code,
    ip,
    userAgent,
    existingUserId: user.id,
    promotionalOptIn: body.promotionalOptIn
  });

  await registerWhatsAppOnboarding({
    userId: user.id,
    phone: body.phone
  }).catch((err) => logger.warn('whatsapp onboarding registration on link failed', { error: err.message }));

  sendJson(res, 200, {
    ok: true,
    message: 'WhatsApp connected successfully',
    user: publicUser(auth.user),
    onboarding: {
      channel: 'whatsapp',
      channelUrl: whatsappChannelUrl(),
      offered: true
    }
  });
}

/** POST /api/auth/whatsapp/unlink — Unlink WhatsApp identity (sole-provider protected). */
export async function unlinkWhatsAppHandler({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const body = parse(WhatsAppUnlinkBody, await readJson(req).catch(() => ({})));
  const phoneToUnlink = body?.phone || user.phone;

  if (!phoneToUnlink) {
    throw new HttpError(400, 'validation', 'No phone number associated with this account');
  }

  await unlinkWhatsAppIdentity({
    userId: user.id,
    phone: phoneToUnlink
  });

  sendJson(res, 200, {
    ok: true,
    message: 'WhatsApp disconnected successfully'
  });
}

/** GET /api/me/identities — Returns all linked authentication identities. */
export async function getMyIdentitiesHandler({ req, res }) {
  const user = await requireUser(req);
  const identities = await getLinkedIdentities(user.id);
  sendJson(res, 200, { ok: true, identities });
}

/** GET /api/me/communication-preferences — Returns granular communication consents. */
export async function getMyCommunicationPreferences({ req, res }) {
  const user = await requireUser(req);
  const preferences = await getConsents(user.id);
  sendJson(res, 200, { ok: true, preferences });
}

/** PATCH /api/me/communication-preferences — Updates consent status. */
export async function updateMyCommunicationPreferences({ req, res, ip }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const body = parse(CommunicationPreferencesPatchBody, await readJson(req));
  const userAgent = req.headers['user-agent'] || null;

  await recordConsent({
    userId: user.id,
    channel: body.channel,
    purpose: body.purpose,
    status: body.status,
    ip,
    userAgent
  });

  const preferences = await getConsents(user.id);
  sendJson(res, 200, { ok: true, preferences });
}

const TrackOnboardingBody = z.object({
  channel: z.enum(['telegram', 'whatsapp']),
  action: z.enum(['channel_clicked', 'channel_dismissed']),
  metadata: z.record(z.unknown()).optional()
}).strict();

/** POST /api/onboarding/track — Record channel follow/join action without false membership claim. */
export async function trackOnboardingHandler({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  const body = parse(TrackOnboardingBody, await readJson(req));
  const result = await trackOnboardingAction({
    userId: user.id,
    channel: body.channel,
    action: body.action,
    metadata: body.metadata || {}
  });
  sendJson(res, 200, { ok: true, ...result });
}

/** GET /api/me/onboarding — Current attendee onboarding progress across channels. */
export async function getMyOnboardingHandler({ req, res }) {
  const user = await requireUser(req);
  const onboarding = await getOnboardingState(user.id);
  sendJson(res, 200, { ok: true, onboarding });
}




