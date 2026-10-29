// test/helpers.js - Shared harness: real Postgres, in-process server, stubbed external APIs.
import crypto from 'node:crypto';

export const BOT_TOKEN = '123456789:TEST_ONLY_token_abcdefghijklmnopqrstuvwxyz';

Object.assign(process.env, {
  SKIP_DOTENV: 'true',
  DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:54329/sm_test',
  SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
  CRON_SECRET: 'test-cron-secret-0123456789',
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_BOT_USERNAME: 'SmTestBot',
  TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret_123456',
  TG_CHAT_ID_EVENTS: '-1001111111111',
  TG_CHAT_ID_TIER_1: '-1002222222221',
  TG_CHAT_ID_TIER_2: '-1002222222222',
  TG_CHAT_ID_TIER_3: '-1002222222223',
  SUPERPROFILE_WEBHOOK_SECRET: 'test_sp_webhook_secret_0123456789',
  ENABLE_LIVE_PAYMENTS: 'false',
  PUBLIC_SITE_URL: 'https://sm.test',
  ADMIN_BOOTSTRAP_TELEGRAM_ID: '900000001',
  LOG_SILENT: 'true'
});
delete process.env.Telegram_HTTP_API;
delete process.env.DEV_LOGIN;

const { db, migrate } = await import('../lib/db.js');
const { createServer } = await import('../server.js');
export { db };

export async function resetDb() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: false });
}

// ---------- external API stub ----------
const realFetch = globalThis.fetch;
export const calls = [];
let linkSeq = 0;
const overrides = new Map();

/** Override one external method for the next N calls: fn(params) => result | throws */
export function stubOnce(key, fn) {
  overrides.set(key, fn);
}

/** Serve any https URL starting with `prefix`: fn(url, init) => { status, body, headers } | Response. */
const urlStubs = new Map();
export function stubUrl(prefix, fn) {
  if (fn) urlStubs.set(prefix, fn); else urlStubs.delete(prefix);
}

function telegramResult(method, params) {
  switch (method) {
    case 'createChatInviteLink': return { invite_link: `https://t.me/+test${++linkSeq}`, member_limit: params.member_limit, expire_date: params.expire_date };
    case 'createInvoiceLink': return `https://t.me/$testinvoice${++linkSeq}`;
    case 'sendMessage': return { message_id: ++linkSeq, chat: { id: params.chat_id } };
    case 'getMe': return { id: 123456789, username: 'SmTestBot' };
    case 'getWebhookInfo': return { url: 'https://sm.test/api/telegram/webhook', pending_update_count: 0, max_connections: 40, allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'chat_member'] };
    case 'getChat': return { id: params.chat_id, type: 'supergroup', title: `Chat ${params.chat_id}` };
    case 'getChatMember': return { status: 'administrator', can_invite_users: true, can_restrict_members: true, user: { id: params.user_id } };
    default: return true;
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return realFetch(input, init);
  const body = init.body ? (typeof init.body === 'string' ? safeJson(init.body) : Object.fromEntries(init.body)) : null;
  const tgm = /api\.telegram\.org\/bot[^/]+\/(?:test\/)?(\w+)$/.exec(url);
  if (tgm) {
    const method = tgm[1];
    calls.push({ api: 'telegram', method, params: body });
    const o = overrides.get(`tg:${method}`);
    if (o) {
      overrides.delete(`tg:${method}`);
      try {
        return jsonResponse({ ok: true, result: await o(body) });
      } catch (err) {
        return jsonResponse({ ok: false, error_code: err.code || 400, description: err.message }, 200);
      }
    }
    return jsonResponse({ ok: true, result: telegramResult(method, body) });
  }
  for (const [prefix, fn] of urlStubs) {
    if (url.startsWith(prefix)) {
      calls.push({ api: 'url', method: init.method || 'GET', path: url, headers: init.headers });
      const r = await fn(url, init);
      if (r instanceof Response) return r;
      const status = r.status ?? 200;
      return new Response([204, 304].includes(status) ? null : (r.body ?? ''), { status, headers: r.headers || {} });
    }
  }
  throw new Error(`Unexpected external fetch in tests: ${url}`);
};

function safeJson(s) {
  try { return JSON.parse(s); } catch { return Object.fromEntries(new URLSearchParams(s)); }
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export function callsTo(method) {
  return calls.filter((c) => c.method === method);
}
export function clearCalls() {
  calls.length = 0;
}

// ---------- server ----------
let server;
export let BASE = '';
export async function startServer() {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  return BASE;
}
export async function stopServer() {
  await new Promise((r) => server.close(r));
  await db.close();
}

/** Minimal client with a cookie jar and CSRF header. */
export class Client {
  constructor({ ip } = {}) {
    this.cookies = {};
    this.csrf = null;
    this.ip = ip || `10.${crypto.randomInt(255)}.${crypto.randomInt(255)}.${crypto.randomInt(1, 255)}`;
  }
  async req(method, path, body, headers = {}) {
    const h = { 'x-forwarded-for': this.ip, ...headers };
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.cookie = cookie;
    if (this.csrf && method !== 'GET' && !h['x-csrf-token']) h['x-csrf-token'] = this.csrf;
    let payload;
    if (body !== undefined) {
      if (typeof body === 'string' || Buffer.isBuffer(body)) payload = body;
      else { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    }
    const res = await realFetch(`${BASE}${path}`, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const v = pair.slice(i + 1);
      if (v === '') delete this.cookies[pair.slice(0, i)]; else this.cookies[pair.slice(0, i)] = v;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p, h) { return this.req('GET', p, undefined, h); }
  post(p, b, h) { return this.req('POST', p, b ?? {}, h); }
  patch(p, b, h) { return this.req('PATCH', p, b ?? {}, h); }
}

// ---------- Telegram identity helpers ----------
export function makeInitData(user, { authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN, extra = {} } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: `AAH${crypto.randomBytes(6).toString('hex')}`, user: JSON.stringify(user), ...extra });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

export function makeWidgetData(user, { authDate = Math.floor(Date.now() / 1000), token = BOT_TOKEN } = {}) {
  const data = { id: user.id, first_name: user.first_name, auth_date: authDate };
  const dcs = Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(token).digest();
  return { ...data, hash: crypto.createHmac('sha256', secret).update(dcs).digest('hex') };
}

let tgIdSeq = 700000000;
export async function signedInClient({ ageConfirmed = true, tgId } = {}) {
  const c = new Client();
  const id = tgId ?? ++tgIdSeq;
  const r = await c.post('/api/auth/telegram', { initData: makeInitData({ id, first_name: `User${id}` }) });
  if (r.status !== 200) throw new Error(`sign-in failed ${r.status} ${r.text}`);
  c.csrf = r.json.csrf;
  c.tgId = id;
  if (ageConfirmed) await c.post('/api/auth/confirm-age', {});
  c.userId = (await db.one('SELECT id FROM users WHERE telegram_user_id = $1', [id])).id;
  return c;
}

export async function createEvent(overrides = {}) {
  const slug = overrides.slug || `test-event-${crypto.randomBytes(4).toString('hex')}`;
  const row = await db.one(
    `INSERT INTO events (slug, category, title, city, start_at, end_at, capacity, ticket_price_paise, price_status, status, is_demo, published_at, venue_private, venue_privacy)
     VALUES ($1, $2, $3, $4, now() + interval '10 days', now() + interval '10 days 3 hours', $5, $6, $7, $8, $9, now(), $10, $11) RETURNING *`,
    [slug, overrides.category || 'meetup', overrides.title || 'Test Meetup', overrides.city || 'Chennai',
      overrides.capacity ?? 10, overrides.price === null ? null : (overrides.price ?? 49900),
      overrides.price === null ? 'tbd' : 'set', overrides.status || 'published', overrides.isDemo ?? false,
      overrides.venue || 'Secret Cafe, 12 Beach Rd', overrides.venuePrivacy || 'disclosed_after_booking']);
  return row;
}
