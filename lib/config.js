// lib/config.js - Environment access. Secrets come only from env vars; there are no fallbacks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Local development convenience: load .env (never committed) without overriding real env.
if (!process.env.VERCEL) {
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
  const explicit = env('PUBLIC_SITE_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${env('PORT', '3000')}`;
}

export function livePayments() {
  return env('ENABLE_LIVE_PAYMENTS', 'false') === 'true';
}

export function socialProofMin() {
  const n = parseInt(env('SOCIAL_PROOF_MIN', '5'), 10);
  return Number.isFinite(n) && n >= 5 ? n : 5;
}

export function isProductionRuntime() {
  return process.env.VERCEL_ENV === 'production';
}

/** Chat id env vars per tier code; a DB value on the tier row takes precedence. */
export const TIER_CHAT_ENV = { tier_1: 'TG_CHAT_ID_TIER_1', tier_2: 'TG_CHAT_ID_TIER_2', tier_3: 'TG_CHAT_ID_TIER_3' };

export function chatIdFromEnv(name) {
  const v = env(name);
  return /^-?\d+$/.test(v) ? Number(v) : null;
}

/** Configuration status for /api/health and admin. Names only — never values. */
export function configStatus() {
  const provider = env('PAYMENT_PROVIDER', 'razorpay');
  const has = (n) => Boolean(env(n));
  const ok = (cond) => (cond ? 'configured' : 'NOT CONFIGURED');
  return {
    database: ok(has('DATABASE_URL')),
    session: ok(env('SESSION_SECRET').length >= 32),
    cron: ok(env('CRON_SECRET').length >= 16),
    telegramBot: ok(Boolean(botToken()) && Boolean(botUsername())),
    telegramWebhookSecret: ok(/^[A-Za-z0-9_-]{16,256}$/.test(env('TELEGRAM_WEBHOOK_SECRET'))),
    telegramEventsChat: ok(chatIdFromEnv('TG_CHAT_ID_EVENTS') !== null),
    paymentProvider: provider,
    paymentKeys: ok(provider === 'cashfree'
      ? has('CASHFREE_APP_ID') && has('CASHFREE_SECRET_KEY')
      : has('RAZORPAY_KEY_ID') && has('RAZORPAY_KEY_SECRET') && has('RAZORPAY_WEBHOOK_SECRET')),
    livePayments: livePayments(),
    adminBootstrap: ok(/^\d+$/.test(env('ADMIN_BOOTSTRAP_TELEGRAM_ID')))
  };
}
