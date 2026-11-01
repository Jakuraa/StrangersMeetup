// lib/telegram/auth.js - Server-side validation of Telegram identities.
//  - Mini App initData:  secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
//  - Legacy Login Widget: secret = SHA256(bot_token)
//  - Telegram Login (OpenID Connect): RS256/ES256 ID token verified against Telegram's JWKS
import crypto from 'node:crypto';
import { db } from '../db.js';
import { env } from '../config.js';

export const INIT_DATA_MAX_AGE_S = 300;

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function hexEqual(a, b) {
  if (typeof a !== 'string' || !/^[0-9a-f]{64}$/i.test(a)) return false;
  const ba = Buffer.from(a.toLowerCase(), 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkAge(authDate, now, maxAge) {
  if (!Number.isInteger(authDate) || authDate <= 0) return 'missing auth_date';
  if (authDate - now > 30) return 'auth_date in the future';
  if (now - authDate > maxAge) return 'stale';
  return null;
}

/**
 * Validate Mini App initData. Returns { ok, user, authDate, hash, startParam } or { ok:false, reason }.
 * Does not check replay — call consumeNonce(hash) afterwards.
 */
export function validateInitData(initData, botToken, { now = Math.floor(Date.now() / 1000), maxAge = INIT_DATA_MAX_AGE_S } = {}) {
  if (!botToken) return { ok: false, reason: 'not configured' };
  if (typeof initData !== 'string' || initData.length > 4096) return { ok: false, reason: 'malformed' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  if (!hexEqual(hash, hmacHex(secret, dataCheckString))) return { ok: false, reason: 'bad hash' };
  const authDate = Number(params.get('auth_date'));
  const ageErr = checkAge(authDate, now, maxAge);
  if (ageErr) return { ok: false, reason: ageErr };
  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, reason: 'bad user' };
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return { ok: false, reason: 'bad user' };
  return { ok: true, user, authDate, hash: hash.toLowerCase(), startParam: params.get('start_param') || null };
}

/** Validate legacy Login Widget payload ({id, first_name, ..., auth_date, hash}). */
export function validateLoginWidget(data, botToken, { now = Math.floor(Date.now() / 1000), maxAge = INIT_DATA_MAX_AGE_S } = {}) {
  if (!botToken) return { ok: false, reason: 'not configured' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'malformed' };
  const fields = Object.keys(data).filter((k) => k !== 'hash' && data[k] !== undefined && data[k] !== null);
  const dataCheckString = fields.sort().map((k) => `${k}=${data[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  if (!hexEqual(data.hash, hmacHex(secret, dataCheckString))) return { ok: false, reason: 'bad hash' };
  const authDate = Number(data.auth_date);
  const ageErr = checkAge(authDate, now, maxAge);
  if (ageErr) return { ok: false, reason: ageErr };
  const id = Number(data.id);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: 'bad user' };
  return {
    ok: true,
    user: { id, first_name: data.first_name, last_name: data.last_name, username: data.username, photo_url: data.photo_url },
    authDate,
    hash: String(data.hash).toLowerCase()
  };
}

/**
 * Replay protection: record a hash for ttlSeconds. Returns true the first time, false on replay.
 */
export async function consumeNonce(hash, ttlSeconds = INIT_DATA_MAX_AGE_S + 60) {
  const r = await db.query(
    `INSERT INTO auth_nonces (hash, expires_at) VALUES ($1, now() + make_interval(secs => $2))
     ON CONFLICT (hash) DO NOTHING`,
    [`tg:${hash}`, ttlSeconds]
  );
  return r.rowCount === 1;
}

export async function pruneNonces() {
  return (await db.query('DELETE FROM auth_nonces WHERE expires_at < now()')).rowCount;
}

// ---------------- OpenID Connect (Telegram Login) ----------------

export const OIDC = {
  issuer: 'https://oauth.telegram.org',
  authorize: 'https://oauth.telegram.org/auth',
  token: 'https://oauth.telegram.org/token',
  jwks: 'https://oauth.telegram.org/.well-known/jwks.json'
};

export function oidcConfigured() {
  return /^\d+$/.test(env('TELEGRAM_LOGIN_CLIENT_ID')) && Boolean(env('TELEGRAM_LOGIN_CLIENT_SECRET'));
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl({ redirectUri, state, challenge, nonce }) {
  const u = new URL(OIDC.authorize);
  u.search = new URLSearchParams({
    client_id: env('TELEGRAM_LOGIN_CLIENT_ID'),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid profile telegram:bot_access',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString();
  return u.toString();
}

export async function exchangeCode({ code, redirectUri, verifier }) {
  const clientId = env('TELEGRAM_LOGIN_CLIENT_ID');
  const basic = Buffer.from(`${clientId}:${env('TELEGRAM_LOGIN_CLIENT_SECRET')}`).toString('base64');
  const res = await fetch(OIDC.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const data = await res.json();
  if (!data.id_token) throw new Error('no id_token');
  return data.id_token;
}

let jwksCache = { at: 0, keys: [] };

async function getJwks(force = false) {
  if (!force && Date.now() - jwksCache.at < 3600_000 && jwksCache.keys.length) return jwksCache.keys;
  const res = await fetch(OIDC.jwks, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return jwksCache.keys;
}

/** Test hook: inject JWKS keys. */
export function _setJwks(keys) {
  jwksCache = { at: Date.now(), keys };
}

const ALGS = {
  RS256: { hash: 'sha256', dsa: false },
  ES256: { hash: 'sha256', dsa: true }
};

/** Verify an OIDC ID token. Returns claims or throws. */
export async function verifyIdToken(idToken, { nonce, now = Math.floor(Date.now() / 1000) } = {}) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const alg = ALGS[header.alg];
  if (!alg) throw new Error('unsupported alg');
  let keys = await getJwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getJwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('unknown key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), alg.dsa ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('bad signature');
  if (claims.iss !== OIDC.issuer) throw new Error('bad iss');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.map(String).includes(env('TELEGRAM_LOGIN_CLIENT_ID'))) throw new Error('bad aud');
  if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new Error('expired');
  if (nonce && claims.nonce !== undefined && claims.nonce !== nonce) throw new Error('bad nonce');
  const id = Number(claims.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('no telegram id claim');
  return claims;
}
