// test/admin.test.js - Admin authz (allowlist + roles), CSRF, audit, core workflows.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, startServer, stopServer, Client, db, signedInClient, createEvent, callsTo, clearCalls } from './helpers.js';

let owner;
let finance;
let manager;
let outsider;

const eventBody = (over = {}) => ({
  slug: `admin-${crypto.randomBytes(3).toString('hex')}`, category: 'dinner_club', title: 'Real Dinner Club', city: 'Chennai',
  venue_privacy: 'disclosed_after_booking', venue_private: 'Hidden Bistro', start_at: new Date(Date.now() + 9 * 864e5).toISOString(),
  capacity: 12, ticket_price_paise: null, inclusions: ['Set menu'], exclusions: [], is_demo: false, ...over
});

before(async () => {
  await resetDb();
  await startServer();
  owner = await signedInClient({ tgId: 900000001 }); // ADMIN_BOOTSTRAP_TELEGRAM_ID
  finance = await signedInClient();
  manager = await signedInClient();
  outsider = await signedInClient();
  // Bootstrap happens on first admin request.
  assert.equal((await owner.get('/api/admin/session')).json.role, 'super_admin');
  assert.equal((await owner.post('/api/admin/admins', { telegram_user_id: finance.tgId, role: 'finance' })).status, 200);
  assert.equal((await owner.post('/api/admin/admins', { telegram_user_id: manager.tgId, role: 'event_manager' })).status, 200);
});
after(stopServer);
beforeEach(clearCalls);

test('signed-out and non-admin users are rejected on every admin API', async () => {
  const anon = new Client();
  for (const p of ['/api/admin/overview', '/api/admin/events', '/api/admin/bookings', '/api/admin/leads', '/api/admin/audit']) {
    assert.equal((await anon.get(p)).status, 401, p);
    assert.equal((await outsider.get(p)).status, 403, p);
  }
  assert.equal((await outsider.post('/api/admin/events', eventBody())).status, 403);
  assert.equal((await new Client().get('/admin')).status, 401);
  assert.equal((await outsider.get('/admin')).status, 403);
});

test('wrong role is rejected', async () => {
  assert.equal((await finance.post('/api/admin/events', eventBody())).status, 403);
  assert.equal((await manager.get('/api/admin/audit')).status, 403);
  const tier = await db.one(`SELECT id FROM membership_tiers WHERE code = 'tier_1'`);
  assert.equal((await manager.patch(`/api/admin/tiers/${tier.id}`, { stars_amount: 100 })).status, 403);
  assert.equal((await finance.post('/api/admin/admins', { telegram_user_id: 1, role: 'super_admin' })).status, 403);
});

test('mutations require a CSRF token', async () => {
  const r = await manager.post('/api/admin/events', eventBody(), { 'x-csrf-token': 'bad' });
  assert.equal(r.status, 403);
});

test('event manager creates a draft (price TBD), publishes it, and every write is audited', async () => {
  const r = await manager.post('/api/admin/events', eventBody({ slug: 'real-dinner-club' }));
  assert.equal(r.status, 201, r.text);
  const ev = await db.one(`SELECT * FROM events WHERE slug = 'real-dinner-club'`);
  assert.equal(ev.status, 'draft');
  assert.equal(ev.price_status, 'tbd');
  assert.equal((await new Client().get('/events/real-dinner-club')).status, 404); // drafts are not public
  assert.equal((await manager.post(`/api/admin/events/${ev.id}/status`, { status: 'published' })).status, 200);
  const page = await new Client().get('/events/real-dinner-club');
  assert.equal(page.status, 200);
  assert.match(page.text, /Price to be announced/);
  assert.match(page.text, /"@type":"Event"/); // real published event gets JSON-LD
  assert.doesNotMatch(page.text, /Hidden Bistro/); // private venue never public
  const actions = (await db.query(`SELECT action FROM audit_log WHERE target = $1 ORDER BY at`, [ev.id])).rows.map((x) => x.action);
  assert.deepEqual(actions, ['event.create', 'event.status']);
});

test('invalid event payloads are rejected with field errors', async () => {
  const r = await manager.post('/api/admin/events', eventBody({ slug: 'Bad Slug!', capacity: 0, bookmyshow_url: 'http://insecure' }));
  assert.equal(r.status, 400);
  const fields = r.json.fields.map((f) => f.field);
  assert.ok(fields.includes('slug') && fields.includes('capacity') && fields.includes('bookmyshow_url'));
});

test('finance can refund a paid ticket; booking becomes refunded and member is told', async () => {
  const ev = await createEvent();
  const member = await signedInClient();
  const bk = await member.post('/api/bookings', { eventId: ev.id });
  const pay = await db.one('SELECT * FROM payments WHERE booking_id = $1', [bk.json.bookingId]);
  await db.query(`UPDATE payments SET status = 'paid', provider_payment_id = 'pay_REAL1' WHERE id = $1`, [pay.id]);
  await db.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bk.json.bookingId]);
  assert.equal((await manager.post(`/api/admin/payments/${pay.id}/refund`, {})).status, 403);
  const r = await finance.post(`/api/admin/payments/${pay.id}/refund`, {});
  assert.equal(r.status, 200, r.text);
  const call = callsTo('POST').find((c) => c.path === '/v1/payments/pay_REAL1/refund');
  assert.equal(call.params.amount, Number(pay.amount));
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [bk.json.bookingId])).status, 'refunded');
  assert.equal((await finance.post(`/api/admin/payments/${pay.id}/refund`, {})).status, 409); // no double refund
  assert.ok(callsTo('sendMessage').some((m) => /refunded/.test(m.params.text)));
});

test('only super_admin can set tier Stars prices; change is audited', async () => {
  const tier = await db.one(`SELECT id FROM membership_tiers WHERE code = 'tier_3'`);
  assert.equal((await owner.patch(`/api/admin/tiers/${tier.id}`, { stars_amount: 750 })).status, 200);
  assert.equal((await db.one('SELECT stars_amount FROM membership_tiers WHERE id = $1', [tier.id])).stars_amount, 750);
  assert.ok(await db.one(`SELECT 1 AS x FROM audit_log WHERE action = 'tier.update' AND target = $1`, [tier.id]));
  assert.equal((await owner.patch(`/api/admin/tiers/${tier.id}`, { stars_amount: 20000 })).status, 400); // Stars cap
});

test('media must be owner-authorised before it can be visible', async () => {
  const mod = await signedInClient();
  await owner.post('/api/admin/admins', { telegram_user_id: mod.tgId, role: 'moderator' });
  assert.equal((await mod.post('/api/admin/media', { type: 'review', caption: 'Lovely evening', authorized_by_owner: true })).status, 403);
  const created = await mod.post('/api/admin/media', { type: 'review', caption: 'Lovely evening', author_alias: 'Asha' });
  assert.equal(created.status, 201);
  const id = created.json.media.id;
  assert.equal((await mod.patch(`/api/admin/media/${id}`, { visible: true })).status, 409);
  assert.equal((await owner.patch(`/api/admin/media/${id}`, { authorized_by_owner: true })).status, 200);
  assert.equal((await mod.patch(`/api/admin/media/${id}`, { visible: true })).status, 200);
});

test('overview KPIs come from real queries', async () => {
  const r = await owner.get('/api/admin/overview');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.kpis.confirmed_bookings, 'number');
  assert.equal(r.json.config.database, 'configured');
});

test('admin cannot demote themselves', async () => {
  assert.equal((await owner.post('/api/admin/admins', { telegram_user_id: 900000001, role: 'support' })).status, 409);
});
