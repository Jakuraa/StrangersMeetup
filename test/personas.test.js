// test/personas.test.js - M8: local seed + test personas. The seed and persona sign-in are refused
// anywhere but a local database on a non-production, non-Vercel machine; each persona is a distinct
// identity whose allowed and denied permissions are checked against the real routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, db } from './helpers.js';
import { PERSONAS, PERSONA_KEYS, PERSONA_TG_MIN, PERSONA_TG_MAX, devLoginEnabled } from '../lib/dev-personas.js';
import { seedLocal, countLocal, LOCAL_EVENTS } from '../scripts/seed-local.js';
import { assertSeedAllowed, SeedRefused } from '../scripts/seed-guard.js';

const LOCAL = 'postgres://localhost/sm_local';
const REMOTE = 'postgres://u:p@ep-cool-name.aws.neon.tech/neondb?sslmode=require';

let ev; // slug -> event row
let bk; // `${persona}:${slug}` -> booking id

/** Event rows by slug and persona booking ids by `${persona}:${slug}` (ids change on every re-seed). */
async function loadIds() {
  ev = Object.fromEntries((await db.query(`SELECT * FROM events WHERE slug LIKE 'local-%'`)).rows.map((r) => [r.slug, r]));
  bk = Object.fromEntries((await db.query(
    `SELECT b.id, e.slug, u.telegram_user_id FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id
      WHERE u.telegram_user_id BETWEEN $1 AND $2`, [PERSONA_TG_MIN, PERSONA_TG_MAX])).rows
    .map((r) => [`${PERSONA_KEYS.find((k) => PERSONAS[k].tg === r.telegram_user_id)}:${r.slug}`, r.id]));
}

before(async () => {
  await resetDb();
  await startServer();
  process.env.DEV_LOGIN = 'true';
  await seedLocal();
  await loadIds();
});
after(async () => { delete process.env.DEV_LOGIN; await stopServer(); });

async function as(persona) {
  const c = new Client();
  const r = await c.post('/api/auth/dev', { persona });
  assert.equal(r.status, 200, `${persona} sign-in: ${r.text}`);
  c.csrf = r.json.csrf;
  c.persona = persona;
  return c;
}

// ---------- guards ----------

test('persona sign-in gate: only local, opted in, non-production, local database', () => {
  const ok = { DEV_LOGIN: 'true', DATABASE_URL: LOCAL };
  assert.equal(devLoginEnabled(ok), true);
  assert.equal(devLoginEnabled({ ...ok, DEV_LOGIN: undefined }), false, 'not opted in');
  assert.equal(devLoginEnabled({ ...ok, DEV_LOGIN: '1' }), false, 'only the literal "true"');
  assert.equal(devLoginEnabled({ ...ok, VERCEL: '1' }), false, 'any Vercel deployment');
  assert.equal(devLoginEnabled({ ...ok, VERCEL_ENV: 'production' }), false);
  assert.equal(devLoginEnabled({ ...ok, NODE_ENV: 'production' }), false);
  assert.equal(devLoginEnabled({ ...ok, DATABASE_URL: REMOTE }), false, 'remote database');
  assert.equal(devLoginEnabled({ DEV_LOGIN: 'true' }), false, 'no database');
});

test('POST /api/auth/dev returns 404 on Vercel, in production, with a remote DB, or when not opted in', async () => {
  const cases = [['VERCEL', '1'], ['NODE_ENV', 'production'], ['VERCEL_ENV', 'production'], ['DEV_LOGIN', 'false'], ['DATABASE_URL', REMOTE]];
  for (const [k, v] of cases) {
    const prev = process.env[k];
    process.env[k] = v;
    try {
      const r = await new Client().post('/api/auth/dev', { persona: 'admin' });
      assert.equal(r.status, 404, `${k}=${v}`);
      assert.equal(r.headers.get('set-cookie'), null, `${k}=${v}: no session issued`);
      const page = await new Client().get('/signin');
      assert.doesNotMatch(page.text, /data-dev-login/, `${k}=${v}: picker hidden`);
    } finally {
      if (prev === undefined) delete process.env[k]; else process.env[k] = prev;
    }
  }
});

test('persona sign-in rejects unknown personas and never creates accounts', async () => {
  const before = (await db.one('SELECT count(*)::int AS n FROM users')).n;
  assert.equal((await new Client().post('/api/auth/dev', { persona: 'root' })).status, 400);
  assert.equal((await new Client().post('/api/auth/dev', { persona: 'guest', telegramId: 1 })).status, 400, 'strict body');
  await db.query(`UPDATE users SET telegram_user_id = telegram_user_id + 500000 WHERE telegram_user_id = $1`, [PERSONAS.guest2.tg]);
  try {
    const r = await new Client().post('/api/auth/dev', { persona: 'guest2' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'not_seeded');
  } finally {
    await db.query(`UPDATE users SET telegram_user_id = $1 WHERE telegram_user_id = $2`, [PERSONAS.guest2.tg, PERSONAS.guest2.tg + 500000]);
  }
  assert.equal((await db.one('SELECT count(*)::int AS n FROM users')).n, before);
});

test('seed:local refuses production, Vercel, remote databases (no override) and a missing URL', () => {
  const refuse = (e) => assert.throws(() => assertSeedAllowed({ kind: 'local', e }), SeedRefused, JSON.stringify(e));
  refuse({});
  refuse({ DATABASE_URL: LOCAL, NODE_ENV: 'production' });
  refuse({ DATABASE_URL: LOCAL, VERCEL_ENV: 'production' });
  refuse({ DATABASE_URL: LOCAL, VERCEL: '1' });
  refuse({ DATABASE_URL: REMOTE });
  refuse({ DATABASE_URL: REMOTE, SEED_ALLOW_REMOTE: 'true' });
  assert.equal(assertSeedAllowed({ kind: 'local', e: { DATABASE_URL: LOCAL } }).database, 'sm_local');
});

test('seed:local refuses before touching the database when the target is not local', async () => {
  const before = await countLocal();
  await assert.rejects(seedLocal({ e: { DATABASE_URL: REMOTE } }), SeedRefused);
  assert.deepEqual(await countLocal(), before);
});

test('seed:local is idempotent and resets what tests changed', async () => {
  const first = await countLocal();
  assert.deepEqual(first, { users: 6, admins: 2, events: LOCAL_EVENTS.length, ticket_types: 8, bookings: 7, drafts: 2, analytics: 50, leads: 2, reports: 1 });
  const c = await as('guest2');
  assert.equal((await c.post(`/api/events/${ev['local-sunday-picnic'].id}/book`, { ticketTypeId: await tierId('local-sunday-picnic') })).status, 200);
  assert.equal((await countLocal()).bookings, 8);
  assert.deepEqual(await seedLocal(), first);
  assert.deepEqual(await seedLocal(), first);
  await loadIds(); // re-seeding rebuilds ids
  assert.equal((await c.get('/api/me/bookings')).status, 401, 'old persona session revoked by re-seed');
});

test('seed:local leaves non-persona data alone', async () => {
  const real = await db.one(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21) VALUES (123123123, 'Real Person', true) RETURNING id`);
  const realEvent = await db.one(
    `INSERT INTO events (slug, category, title, city, start_at, capacity, status) VALUES ('real-event', 'meetup', 'Real', 'Chennai', now() + interval '3 days', 5, 'published') RETURNING id`);
  await db.query(`INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed')`, [realEvent.id, real.id]);
  await seedLocal();
  assert.equal((await db.one('SELECT count(*)::int AS n FROM bookings WHERE user_id = $1', [real.id])).n, 1);
  assert.ok(await db.one(`SELECT 1 FROM events WHERE slug = 'real-event'`));
  await loadIds();
});

// ---------- identities ----------

test('each persona is a distinct identity with a distinct role, inside the reserved id range', async () => {
  const rows = (await db.query(
    `SELECT u.id, u.telegram_user_id, u.alias, u.organiser_enabled, a.role AS admin_role
       FROM users u LEFT JOIN admin_users a ON a.telegram_user_id = u.telegram_user_id AND a.active
      WHERE u.telegram_user_id BETWEEN $1 AND $2 ORDER BY u.telegram_user_id`, [PERSONA_TG_MIN, PERSONA_TG_MAX])).rows;
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((r) => r.id)).size, 6);
  assert.equal(new Set(rows.map((r) => r.alias)).size, 6);
  for (const r of rows) assert.match(r.alias, /^Test /);
  const byKey = Object.fromEntries(PERSONA_KEYS.map((k) => [k, rows.find((r) => r.telegram_user_id === PERSONAS[k].tg)]));
  assert.deepEqual(PERSONA_KEYS.map((k) => [k, byKey[k].organiser_enabled, byKey[k].admin_role]), [
    ['guest', false, null], ['guest2', false, null], ['organiser', true, null], ['organiser2', true, null],
    ['staff', false, 'support'], ['admin', false, 'super_admin']
  ]);
  // Sessions resolve to the right person.
  for (const k of PERSONA_KEYS) {
    const me = await (await as(k)).get('/api/me');
    assert.equal(me.json.user.alias, PERSONAS[k].alias);
  }
});

test('sign-in response points each persona at its own landing page', async () => {
  for (const k of PERSONA_KEYS) {
    const r = await new Client().post('/api/auth/dev', { persona: k });
    assert.equal(r.json.landing, PERSONAS[k].landing);
  }
});

// ---------- guest ----------

const tierId = async (slug) => (await db.one('SELECT id FROM ticket_types WHERE event_id = (SELECT id FROM events WHERE slug = $1)', [slug])).id;

test('guest: allowed — own bookings, private venue on own confirmed booking, book a free ticket', async () => {
  const c = await as('guest');
  const mine = await c.get('/api/me/bookings');
  assert.equal(mine.status, 200);
  assert.equal(mine.json.bookings.length, 3);
  const own = await c.get(`/api/bookings/${bk['guest:local-board-games-night']}`);
  assert.equal(own.status, 200);
  assert.match(own.json.booking.venue, /Elliot’s Beach Rd/);
  const book = await c.post(`/api/events/${ev['local-sunday-picnic'].id}/book`, { ticketTypeId: await tierId('local-sunday-picnic') });
  assert.equal(book.status, 200);
  assert.equal(book.json.status, 'confirmed');
});

test('guest: denied — another guest’s booking, paid tickets while payments are off, organiser and admin areas', async () => {
  const c = await as('guest');
  assert.equal((await c.get(`/api/bookings/${bk['guest2:local-low-seats-trek']}`)).status, 404);
  const paid = await c.post(`/api/events/${ev['local-paid-workshop'].id}/book`, { ticketTypeId: await tierId('local-paid-workshop') });
  assert.equal(paid.status, 409);
  assert.equal(paid.json.error, 'paid_on_superprofile');
  assert.equal((await c.get('/api/organiser/drafts')).status, 403);
  assert.equal((await c.get(`/api/organiser/events/${ev['local-board-games-night'].id}/guests`)).status, 404, 'object route: existence not leaked');
  assert.equal((await c.get('/api/admin/session')).status, 403);
  assert.equal((await c.get(`/api/admin/events/${ev['local-board-games-night'].id}/attendees`)).status, 403);
});

test('guest2: allowed — own pending request and booking; denied — sold-out event, other bookings, private venue', async () => {
  const c = await as('guest2');
  const mine = await c.get('/api/me/bookings');
  assert.deepEqual(mine.json.bookings.map((b) => b.status).sort(), ['confirmed', 'confirmed', 'pending_approval']);
  const sold = await c.post(`/api/events/${ev['local-sold-out-mixer'].id}/book`, { ticketTypeId: await tierId('local-sold-out-mixer') });
  assert.equal(sold.status, 409);
  assert.equal(sold.json.error, 'sold_out');
  assert.equal((await c.get(`/api/bookings/${bk['guest:local-board-games-night']}`)).status, 404);
  const pending = await c.get(`/api/bookings/${bk['guest2:local-approval-dinner']}`);
  assert.equal(pending.status, 200);
  assert.equal(pending.json.booking.venue, null, 'no venue until approved and confirmed');
  const page = await c.get('/events/local-board-games-night');
  assert.doesNotMatch(page.text, /Elliot’s Beach Rd|Elliot&#39;s|Elliot&rsquo;s/);
  assert.equal((await c.get('/api/admin/session')).status, 403);
  assert.equal((await c.post('/api/organiser/drafts', { template: 'social' })).status, 403);
});

test('signed out: no private venue anywhere, member APIs need sign-in', async () => {
  const c = new Client();
  for (const e of LOCAL_EVENTS) {
    const page = await c.get(`/events/${e.slug}`);
    assert.ok(!page.text.includes(e.venue.split(' — ')[1].slice(0, 12)), `${e.slug} page leaks venue`);
  }
  const api = await c.get('/api/events');
  for (const e of api.json.events) assert.equal(e.venue, '');
  assert.equal((await c.get('/api/me/bookings')).status, 401);
  assert.equal((await c.get(`/api/bookings/${bk['guest:local-board-games-night']}`)).status, 401);
});

// ---------- organisers ----------

test('organiser: allowed — own drafts, own guest list, approve a request on own event', async () => {
  const c = await as('organiser');
  const drafts = await c.get('/api/organiser/drafts');
  assert.equal(drafts.status, 200);
  assert.deepEqual(drafts.json.drafts.map((d) => d.data.title), ['Test draft: Book swap brunch']);
  const guests = await c.get(`/api/organiser/events/${ev['local-board-games-night'].id}/guests`);
  assert.equal(guests.status, 200);
  assert.equal((await c.get('/api/organiser/events')).status, 200);
  const approve = await c.post(`/api/organiser/bookings/${bk['guest2:local-approval-dinner']}/approve`, {});
  assert.equal(approve.status, 200, approve.text);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [bk['guest2:local-approval-dinner']])).status, 'confirmed');
});

test('organiser: denied — another organiser’s events and drafts, admin API', async () => {
  const c = await as('organiser');
  assert.equal((await c.get(`/api/organiser/events/${ev['local-low-seats-trek'].id}/guests`)).status, 404);
  const other = await db.one(`SELECT d.id FROM event_drafts d JOIN users u ON u.id = d.organiser_user_id WHERE u.telegram_user_id = $1`, [PERSONAS.organiser2.tg]);
  assert.equal((await c.get(`/api/organiser/drafts/${other.id}`)).status, 404);
  assert.equal((await c.req('DELETE', `/api/organiser/drafts/${other.id}`)).status, 404);
  assert.equal((await c.get('/api/admin/session')).status, 403);
  assert.equal((await c.post('/api/admin/organisers', { telegram_user_id: PERSONAS.guest.tg, enabled: true })).status, 403);
});

test('organiser2: allowed — own event guests; denied — organiser 1’s guests, requests and drafts', async () => {
  const c = await as('organiser2');
  assert.equal((await c.get(`/api/organiser/events/${ev['local-low-seats-trek'].id}/guests`)).status, 200);
  const drafts = await c.get('/api/organiser/drafts');
  assert.deepEqual(drafts.json.drafts.map((d) => d.data.title), ['Test draft: Night cycling tour']);
  assert.equal((await c.get(`/api/organiser/events/${ev['local-board-games-night'].id}/guests`)).status, 404);
  assert.equal((await c.post(`/api/organiser/bookings/${bk['guest:local-board-games-night']}/decline`, {})).status, 404);
  assert.equal((await c.get(`/organiser/events/${ev['local-board-games-night'].id}`)).text.includes('Elliot'), false);
});

test('organiser writes need the CSRF token', async () => {
  const c = await as('organiser');
  c.csrf = null;
  assert.equal((await c.post('/api/organiser/drafts', { template: 'social' })).status, 403);
});

// ---------- event staff (admin role: support) ----------

test('staff: allowed — attendee list, bookings list, check-in', async () => {
  const c = await as('staff');
  assert.equal((await c.get('/api/admin/session')).json.role, 'support');
  const att = await c.get(`/api/admin/events/${ev['local-board-games-night'].id}/attendees`);
  assert.equal(att.status, 200);
  assert.equal(att.json.attendees.length, 1);
  assert.equal((await c.get('/api/admin/bookings')).status, 200);
  const ci = await c.post(`/api/admin/bookings/${bk['guest:local-board-games-night']}/check-in`, {});
  assert.equal(ci.status, 200, ci.text);
});

test('staff: denied — event edits, refunds, roles, insights, audit, organiser tools', async () => {
  const c = await as('staff');
  assert.equal((await c.post('/api/admin/events', { title: 'x' })).status, 403);
  assert.equal((await c.post(`/api/admin/events/${ev['local-board-games-night'].id}/status`, { status: 'cancelled' })).status, 403);
  assert.equal((await c.post('/api/admin/payments/00000000-0000-4000-8000-000000000000/refund', {})).status, 403);
  assert.equal((await c.post('/api/admin/admins', { telegram_user_id: PERSONAS.staff.tg, role: 'super_admin', active: true })).status, 403);
  assert.equal((await c.get('/api/admin/insights')).status, 403);
  assert.equal((await c.get('/api/admin/audit')).status, 403);
  assert.equal((await c.get('/api/organiser/drafts')).status, 403);
  assert.equal((await c.get(`/api/organiser/events/${ev['local-board-games-night'].id}/guests`)).status, 404);
  assert.equal((await db.one('SELECT role FROM admin_users WHERE telegram_user_id = $1', [PERSONAS.staff.tg])).role, 'support');
});

// ---------- admin ----------

test('admin: allowed — admin session, audit, insights, roles, any event’s guests, grant organiser', async () => {
  const c = await as('admin');
  assert.equal((await c.get('/api/admin/session')).json.role, 'super_admin');
  for (const p of ['/api/admin/audit', '/api/admin/insights', '/api/admin/admins', '/api/admin/organisers', '/api/admin/bookings']) {
    assert.equal((await c.get(p)).status, 200, p);
  }
  assert.equal((await c.get(`/api/organiser/events/${ev['local-low-seats-trek'].id}/guests`)).status, 200);
  const grant = await c.post('/api/admin/organisers', { telegram_user_id: PERSONAS.guest.tg, enabled: true });
  assert.equal(grant.status, 200, grant.text);
  assert.equal((await c.post('/api/admin/organisers', { telegram_user_id: PERSONAS.guest.tg, enabled: false })).status, 200);
});

test('admin: denied — demoting themselves, writes without CSRF', async () => {
  const c = await as('admin');
  const self = await c.post('/api/admin/admins', { telegram_user_id: PERSONAS.admin.tg, role: 'support', active: true });
  assert.equal(self.status, 409);
  c.csrf = null;
  assert.equal((await c.post('/api/admin/organisers', { telegram_user_id: PERSONAS.guest.tg, enabled: true })).status, 403);
});

test('admin console renders only the tabs each role can load', async () => {
  const tabs = async (p) => [...(await (await as(p)).get('/admin')).text.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(await tabs('admin'),
    ['overview', 'insights', 'discovery', 'events', 'bookings', 'orders', 'memberships', 'leads', 'media', 'tiers', 'integrations', 'admins']);
  assert.deepEqual(await tabs('staff'), ['overview', 'events', 'bookings', 'orders', 'memberships', 'leads', 'tiers']);
  assert.deepEqual(await tabs('organiser'), [], 'not an admin: no console');
});
