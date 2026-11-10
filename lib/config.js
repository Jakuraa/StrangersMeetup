// lib/config.js - Environment access. Secrets come only from env vars; there are no fallbacks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local development convenience: load .env (never committed) without overriding real env.
if (!process.env.VERCEL && process.env.SKIP_DOTENV !== 'true') {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

export function env(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const BOT_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/**
 * Bot token. TELEGRAM_BOT_TOKEN is canonical. The Vercel project currently has a var named
 * `Telegram_HTTP_API`; it is accepted only if it has the exact shape of a bot token.
 */
export function botToken() {
  if (process.env.VERCEL_ENV === 'preview') {
    // Preview must use a dedicated test Telegram bot token.
    // If unavailable or unverified, Telegram sending is disabled in Preview.
    const previewToken = env('PREVIEW_TELEGRAM_BOT_TOKEN') || env('TELEGRAM_TEST_BOT_TOKEN');
    if (BOT_TOKEN_RE.test(previewToken)) return previewToken;
    if (env('ALLOW_PREVIEW_TELEGRAM') === 'true') {
      const primary = env('TELEGRAM_BOT_TOKEN');
      if (BOT_TOKEN_RE.test(primary)) return primary;
    }
    return ''; // Disabled by default in Preview to protect real users
  }
  const primary = env('TELEGRAM_BOT_TOKEN');
  if (BOT_TOKEN_RE.test(primary)) return primary;
  const legacy = env('Telegram_HTTP_API');
  if (BOT_TOKEN_RE.test(legacy)) return legacy;
  return '';
}

export function botUsername() {
  return env('TELEGRAM_BOT_USERNAME').replace(/^@/, '');
}

export function siteUrl() {
  if (process.env.VERCEL_ENV === 'preview') {
    const previewExplicit = env('PREVIEW_PUBLIC_SITE_URL');
    if (previewExplicit) return previewExplicit.replace(/\/$/, '');
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  }
  const explicit = env('PUBLIC_SITE_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${env('PORT', '3000')}`;
}

/** Gates only the SuperProfile hosted link-out. UPI/PhonePe has its own flag below. */
export function livePayments() {
  return env('ENABLE_LIVE_PAYMENTS', 'false') === 'true';
}

/** Gates every UPI/PhonePe route, page, intent, claim and webhook. Off unless explicitly 'true'. */
export function upiCheckoutEnabled() {
  return env('UPI_CHECKOUT_ENABLED', 'false') === 'true';
}

export function socialProofMin() {
  const n = parseInt(env('SOCIAL_PROOF_MIN', '5'), 10);
  return Number.isFinite(n) && n >= 5 ? n : 5;
}

export function isProductionRuntime() {
  return process.env.VERCEL_ENV === 'production';
}

/**
 * Suspected or known production endpoints.
 * ep-dawn-glitter-b4mkwxkl is the historical/unconfirmed Neon compute endpoint from earlier docs.
 * Until the owner provides the confirmed Production endpoint ID from Vercel -> Storage,
 * this endpoint remains blocked from non-production use (e.g. preview reviewers, seed/reset).
 */
export const DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS = [
  'ep-dawn-glitter-b4mkwxkl'
];

/**
 * Returns the full list of blocked production endpoints.
 * Combines DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS with any IDs listed in the
 * BLOCKED_PRODUCTION_ENDPOINTS env var (comma-separated or whitespace-separated).
 */
export function getBlockedProductionEndpoints(e = process.env) {
  const set = new Set(DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS);
  const extra = e?.BLOCKED_PRODUCTION_ENDPOINTS;
  if (typeof extra === 'string') {
    for (const part of extra.split(/[,\s]+/)) {
      const trimmed = part.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return Array.from(set);
}

/**
 * Checks if a connection string / URL points at any blocked production database endpoint.
 */
export function isBlockedProductionDatabaseUrl(url, e = process.env) {
  if (!url || typeof url !== 'string') return false;
  const blocked = getBlockedProductionEndpoints(e);
  return blocked.some((endpoint) => url.includes(endpoint));
}

/** Chat id env vars per tier code; a DB value on the tier row takes precedence. */
export const TIER_CHAT_ENV = { tier_1: 'TG_CHAT_ID_TIER_1', tier_2: 'TG_CHAT_ID_TIER_2', tier_3: 'TG_CHAT_ID_TIER_3' };

export function chatIdFromEnv(name) {
  const v = env(name);
  return /^-?\d+$/.test(v) ? Number(v) : null;
}

/** Configuration status for /api/health and admin. Names only — never values. */
export function configStatus() {
  const has = (n) => Boolean(env(n));
  const ok = (cond) => (cond ? 'configured' : 'NOT CONFIGURED');
  return {
    database: ok(has('DATABASE_URL')),
    session: ok(env('SESSION_SECRET').length >= 32),
    cron: ok(env('CRON_SECRET').length >= 16),
    telegramBot: ok(Boolean(botToken()) && Boolean(botUsername())),
    telegramWebhookSecret: ok(/^[A-Za-z0-9_-]{16,256}$/.test(env('TELEGRAM_WEBHOOK_SECRET'))),
    telegramEventsChat: ok(chatIdFromEnv('TG_CHAT_ID_EVENTS') !== null),
    ticketCheckout: 'superprofile_link',
    livePayments: livePayments(),
    upiCheckout: upiCheckoutEnabled(),
    adminBootstrap: ok(/^\d+$/.test(env('ADMIN_BOOTSTRAP_TELEGRAM_ID'))),
    telegramLogin: ok(has('TELEGRAM_LOGIN_CLIENT_ID') && has('TELEGRAM_LOGIN_CLIENT_SECRET')),
    superprofileWebhook: ok(env('SUPERPROFILE_WEBHOOK_SECRET').length >= 24)
  };
}
