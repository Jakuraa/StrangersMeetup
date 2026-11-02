// test/permissions.test.js - can() permission matrix (org roles × orgs × actions, platform roles,
// revoked members), the org/member/venue API (outsiders get 404, low roles 403, writes audited),
// event access through orgs, and migration 012 (fresh, upgrade from 011 data, re-run).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, startServer, stopServer, db, signedInClient, createEvent } from './helpers.js';
import { can, ACTIONS, ORG_ACTIONS } from '../lib/services/permissions.js';
import { listOrganiserEvents } from '../lib/services/organiser.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ROLES = ['owner', 'admin', 'manager', 'staff'];

const P = {}; // persona key -> signed-in client (userId, tgId)
const ORG = {}; // 'A' | 'B' -> org id
const EV = {}; // 'A' | 'B' -> event row
const VENUE = {}; // 'A' | 'B' -> venue id
const userOf = (k) => ({ id: P[k].userId, telegram_user_id: P[k].tgId });

async function member(k, org, role, status = 'active') {
  await db.query(`INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, $3, $4)`, [P[k].userId, ORG[org], role, status]);
}

before(async () => {
  await resetDb();
  await startServer();
  for (const k of ['guest', 'owner', 'admin', 'manager', 'staff', 'revoked', 'ownerB', 'superAdmin', 'eventManager', 'finance', 'newbie']) {
    P[k] = await signedInClient();
  }
  for (const org of ['A', 'B']) {
    ORG[org] = (await db.one(`INSERT INTO organisations (kind, name) VALUES ('organiser_team', $1) RETURNING id`, [`Org ${org}`])).id;
    const ev = await createEvent({ title: `Event ${org}` });
    EV[org] = await db.one('UPDATE events SET organiser_org_id = $2 WHERE id = $1 RETURNING *', [ev.id, ORG[org]]);
    VENUE[org] = (await db.one(
      `INSERT INTO venues (org_id, name, capacity, address_private, lat, lng) VALUES ($1, $2, 50, 'Private address ${org}', 12.97, 77.59) RETURNING id`,
      [ORG[org], `Venue ${org}`])).id;
  }
  for (const r of ROLES) await member(r, 'A', r);
  await member('revoked', 'A', 'manager', 'revoked');
  await member('ownerB', 'B', 'owner');
  await member('newbie', 'B', 'staff');
  for (const [k, role] of [['superAdmin', 'super_admin'], ['eventManager', 'event_manager'], ['finance', 'finance']]) {
    await db.query(`INSERT INTO admin_users (telegram_user_id, role) VALUES ($1, $2)`, [P[k].tgId, role]);
  }
});
after(stopServer);

// ---------- matrix: org roles of org A, against org A and org B resources ----------

const scopes = {
  A: [{ orgId: () => ORG.A }, { event: () => EV.A }, { venueId: () => VENUE.A }],
  B: [{ orgId: () => ORG.B }, { event: () => EV.B }, { venueId: () => VENUE.B }]
};
const scopeFor = (org, action) => {
  const kind = action.startsWith('event.') ? 1 : action.startsWith('venue.') ? 2 : 0;
  const [[key, val]] = Object.entries(scopes[org][kind]);
  return { [key]: val() };
};

for (const who of ['guest', ...ROLES, 'revoked']) {
  for (const org of ['A', 'B']) {
    for (const action of ACTIONS) {
      const expected = org === 'A' && ROLES.includes(who) && ORG_ACTIONS[action].includes(who);
      test(`matrix: ${who} of org A ${expected ? 'may' : 'may not'} ${action} on org ${org}`, async () => {
        assert.equal(await can(userOf(who), action, scopeFor(org, action)), expected);
      });
    }
  }
}

for (const org of ['A', 'B']) {
  for (const action of ACTIONS) {
    test(`matrix: platform super_admin may ${action} on org ${org}`, async () => {
      assert.equal(await can(userOf('superAdmin'), action, scopeFor(org, action)), true);
    });
  }
}

test('platform event_manager may manage any event but not org members or venues', async () => {
  const u = userOf('eventManager');
  assert.equal(await can(u, 'event.manage', { event: EV.B }), true);
  assert.equal(await can(u, 'event.decide_bookings', { event: EV.A }), true);
  assert.equal(await can(u, 'org.manage_members', { orgId: ORG.A }), false);
  assert.equal(await can(u, 'venue.manage', { venueId: VENUE.A }), false);
  assert.equal(await can(u, 'venue.view_private', { venueId: VENUE.A }), false);
});

test('platform finance role gets no org or event access', async () => {
  for (const action of ACTIONS) assert.equal(await can(userOf('finance'), action, scopeFor('A', action)), false, action);
});

test('no user, or an unknown scope, is always denied', async () => {
  assert.equal(await can(null, 'org.view', { orgId: ORG.A }), false);
  assert.equal(await can(userOf('owner'), 'org.view', { orgId: '00000000-0000-0000-0000-000000000000' }), false);
  assert.equal(await can(userOf('owner'), 'org.view', {}), false);
  await assert.rejects(() => can(userOf('owner'), 'org.delete', { orgId: ORG.A }), /unknown action/);
});

// ---------- HTTP: outsiders 404, insufficient role 403 ----------

test('org detail: members see it; outsiders, guests and revoked members get 404', async () => {
  const ok = await P.staff.get(`/api/orgs/${ORG.A}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.org.role, 'staff');
  for (const k of ['guest', 'ownerB', 'revoked']) assert.equal((await P[k].get(`/api/orgs/${ORG.A}`)).status, 404, k);
  assert.equal((await P.owner.get(`/api/orgs/${ORG.B}`)).status, 404);
  assert.equal((await P.owner.get('/api/orgs/not-a-uuid')).status, 404);
});

test('member list: staff gets 403 in own org, 404 cross-org; manager sees it', async () => {
  assert.equal((await P.staff.get(`/api/orgs/${ORG.A}/members`)).status, 403);
  assert.equal((await P.ownerB.get(`/api/orgs/${ORG.A}/members`)).status, 404);
  const r = await P.manager.get(`/api/orgs/${ORG.A}/members`);
  assert.equal(r.status, 200);
  assert.ok(r.json.members.some((m) => m.role === 'owner'));
});

test('member list is paginated', async () => {
  const r1 = await P.owner.get(`/api/orgs/${ORG.A}/members?limit=2`);
  assert.equal(r1.json.members.length, 2);
  assert.equal(r1.json.page.nextOffset, 2);
  const r2 = await P.owner.get(`/api/orgs/${ORG.A}/members?limit=2&offset=2`);
  assert.equal(r2.json.members.length, 2);
  assert.notEqual(r2.json.members[0].userId, r1.json.members[0].userId);
});

test('adding members: manager 403, admin may add staff, only owner may add an admin; writes audited', async () => {
  const target = await signedInClient();
  assert.equal((await P.manager.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: target.tgId, role: 'staff' })).status, 403);
  assert.equal((await P.ownerB.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: target.tgId, role: 'staff' })).status, 404);
  assert.equal((await P.admin.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: target.tgId, role: 'admin' })).status, 403);
  assert.equal((await P.admin.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: target.tgId, role: 'staff' })).status, 200);
  assert.equal((await P.owner.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: target.tgId, role: 'admin' })).status, 200);
  const rows = (await db.query(`SELECT actor, details FROM audit_log WHERE action = 'org.member.add' AND target = $1 ORDER BY at`, [ORG.A])).rows;
  assert.deepEqual(rows.map((r) => [r.actor, r.details.role]), [[`user:${P.admin.userId}`, 'staff'], [`user:${P.owner.userId}`, 'admin']]);
  // The admin can no longer demote the (now) admin.
  assert.equal((await P.admin.patch(`/api/orgs/${ORG.A}/members/${target.userId}`, { role: 'staff' })).status, 403);
});

test('member writes need CSRF and validate input', async () => {
  const target = await signedInClient();
  assert.equal((await P.owner.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: target.tgId, role: 'staff' }, { 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await P.owner.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: target.tgId, role: 'owner' })).status, 400);
  assert.equal((await P.owner.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: 1, role: 'staff' })).status, 404);
});

test('the owner membership cannot be changed or revoked through the member API', async () => {
  assert.equal((await P.owner.patch(`/api/orgs/${ORG.A}/members/${P.owner.userId}`, { status: 'revoked' })).status, 409);
});

test('revoking a membership removes access at once (404 afterwards)', async () => {
  const temp = await signedInClient();
  await P.owner.post(`/api/orgs/${ORG.A}/members`, { telegram_user_id: temp.tgId, role: 'manager' });
  assert.equal((await temp.get(`/api/orgs/${ORG.A}`)).status, 200);
  assert.equal((await P.owner.patch(`/api/orgs/${ORG.A}/members/${temp.userId}`, { status: 'revoked' })).status, 200);
  assert.equal((await temp.get(`/api/orgs/${ORG.A}`)).status, 404);
  assert.equal((await temp.get(`/api/organiser/events/${EV.A.id}/guests`)).status, 404);
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action = 'org.member.update' AND details->'to'->>'status' = 'revoked'`));
});

test('a suspended org denies its own owner; super_admin can suspend via admin API (audited)', async () => {
  assert.equal((await P.finance.patch(`/api/admin/orgs/${ORG.B}`, { status: 'suspended' })).status, 403);
  assert.equal((await P.superAdmin.patch(`/api/admin/orgs/${ORG.B}`, { status: 'suspended' })).status, 200);
  assert.equal((await P.ownerB.get(`/api/orgs/${ORG.B}`)).status, 404);
  assert.equal(await can(userOf('ownerB'), 'event.manage', { event: EV.B }), false);
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action = 'org.update' AND target = $1`, [ORG.B]));
  assert.equal((await P.superAdmin.patch(`/api/admin/orgs/${ORG.B}`, { status: 'active' })).status, 200);
  assert.equal((await P.ownerB.get(`/api/orgs/${ORG.B}`)).status, 200);
});

test('admin org creation: super_admin only, creates owner membership, audited', async () => {
  const owner = await signedInClient();
  assert.equal((await P.finance.post('/api/admin/orgs', { kind: 'business', name: 'Biz', owner_telegram_user_id: owner.tgId })).status, 403);
  assert.equal((await P.superAdmin.post('/api/admin/orgs', { kind: 'personal', name: 'X', owner_telegram_user_id: owner.tgId })).status, 400);
  const r = await P.superAdmin.post('/api/admin/orgs', { kind: 'venue_operator', name: 'Rooftop Co', owner_telegram_user_id: owner.tgId });
  assert.equal(r.status, 201, r.text);
  assert.equal((await owner.get(`/api/orgs/${r.json.org.id}`)).json.org.role, 'owner');
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action = 'org.create' AND target = $1`, [r.json.org.id]));
  const list = await P.superAdmin.get('/api/admin/orgs?limit=1');
  assert.equal(list.json.orgs.length, 1);
  assert.equal(list.json.page.nextOffset, 1);
});

test('my orgs lists only active memberships, with role', async () => {
  const r = await P.manager.get('/api/me/orgs');
  assert.deepEqual(r.json.orgs.map((o) => [o.id, o.role]), [[ORG.A, 'manager']]);
  assert.deepEqual((await P.revoked.get('/api/me/orgs')).json.orgs, []);
  assert.equal((await new (P.guest.constructor)().get('/api/me/orgs')).status, 401);
});

// ---------- venues: private fields for members only ----------

test('venues: members see private address; outsiders 404; staff cannot create; admin can (audited)', async () => {
  const r = await P.staff.get(`/api/orgs/${ORG.A}/venues`);
  assert.equal(r.status, 200);
  assert.equal(r.json.venues[0].addressPrivate, 'Private address A');
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  const leak = await P.ownerB.get(`/api/orgs/${ORG.A}/venues`);
  assert.equal(leak.status, 404);
  assert.doesNotMatch(leak.text, /Private address A|12\.97/);
  assert.equal((await P.staff.post(`/api/orgs/${ORG.A}/venues`, { name: 'New hall' })).status, 403);
  const c = await P.admin.post(`/api/orgs/${ORG.A}/venues`, { name: 'New hall', capacity: 40, lat: 13.08, lng: 80.27 });
  assert.equal(c.status, 201, c.text);
  assert.ok(await db.one(`SELECT 1 FROM audit_log WHERE action = 'venue.create' AND target = $1`, [c.json.venue.id]));
  assert.equal((await P.ownerB.patch(`/api/venues/${c.json.venue.id}`, { name: 'Hijack' })).status, 404);
  assert.equal((await P.manager.patch(`/api/venues/${c.json.venue.id}`, { name: 'Renamed' })).status, 403);
  assert.equal((await P.owner.patch(`/api/venues/${c.json.venue.id}`, { status: 'archived' })).status, 200);
  assert.equal((await P.owner.post(`/api/orgs/${ORG.A}/venues`, { name: 'Bad', lat: 123 })).status, 400);
});

// ---------- events through orgs ----------

async function pendingBooking(eventId) {
  const guest = await signedInClient();
  const tier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, sort_order) VALUES ($1, 'Free', 'free', 0, 10, 2, 0) RETURNING id`, [eventId]);
  return (await db.one(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, amount_paise, status) VALUES ($1, $2, $3, 1, 0, 'pending_approval') RETURNING id`,
    [eventId, guest.userId, tier.id])).id;
}

test('event guests: staff may view (200) but not approve (403); outsiders 404', async () => {
  assert.equal((await P.staff.get(`/api/organiser/events/${EV.A.id}/guests`)).status, 200);
  assert.equal((await P.ownerB.get(`/api/organiser/events/${EV.A.id}/guests`)).status, 404);
  assert.equal((await P.guest.get(`/api/organiser/events/${EV.A.id}/guests`)).status, 404);
  const b = await pendingBooking(EV.A.id);
  assert.equal((await P.staff.post(`/api/organiser/bookings/${b}/approve`)).status, 403);
  assert.equal((await P.ownerB.post(`/api/organiser/bookings/${b}/approve`)).status, 404);
  const ok = await P.manager.post(`/api/organiser/bookings/${b}/approve`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'confirmed');
});

test('organiser event list is scoped to the user’s orgs', async () => {
  const ids = (await listOrganiserEvents(userOf('staff'))).map((e) => e.id);
  assert.ok(ids.includes(EV.A.id));
  assert.ok(!ids.includes(EV.B.id));
  assert.deepEqual(await listOrganiserEvents(userOf('guest')), []);
});

test('personal org: wizard organiser keeps access to own event; losing organiser access removes it (as before)', async () => {
  const org = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [org.userId]);
  const { ensurePersonalOrg } = await import('../lib/services/permissions.js');
  const orgId = await ensurePersonalOrg({ id: org.userId, alias: 'Solo' });
  assert.equal(await ensurePersonalOrg({ id: org.userId, alias: 'Solo' }), orgId); // idempotent
  const ev = await createEvent();
  await db.query('UPDATE events SET organiser_user_id = $2, organiser_org_id = $3 WHERE id = $1', [ev.id, org.userId, orgId]);
  assert.equal((await org.get(`/api/organiser/events/${ev.id}/guests`)).status, 200);
  await db.query('UPDATE users SET organiser_enabled = false WHERE id = $1', [org.userId]);
  assert.equal((await org.get(`/api/organiser/events/${ev.id}/guests`)).status, 404);
  // A personal org cannot take extra members.
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [org.userId]);
  assert.equal((await org.post(`/api/orgs/${orgId}/members`, { telegram_user_id: P.guest.tgId, role: 'staff' })).status, 409);
});

test('events without organiser_org_id fall back to the organiser’s personal org', async () => {
  const org = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [org.userId]);
  const { ensurePersonalOrg } = await import('../lib/services/permissions.js');
  await ensurePersonalOrg({ id: org.userId, alias: 'Legacy' });
  const ev = await createEvent();
  await db.query('UPDATE events SET organiser_user_id = $2 WHERE id = $1', [ev.id, org.userId]);
  assert.equal(await can({ id: org.userId, telegram_user_id: org.tgId }, 'event.manage', { eventId: ev.id }), true);
  assert.equal(await can(userOf('owner'), 'event.manage', { eventId: ev.id }), false);
});

test('admin organiser switch creates the personal org and syncs the organise_events capability', async () => {
  const u = await signedInClient();
  assert.equal((await P.superAdmin.post('/api/admin/organisers', { telegram_user_id: u.tgId, enabled: true })).status, 200);
  assert.ok(await db.one(`SELECT 1 FROM organisations o JOIN org_memberships m ON m.org_id = o.id AND m.role = 'owner' WHERE o.personal_user_id = $1`, [u.userId]));
  assert.equal((await db.one(`SELECT status FROM user_capabilities WHERE user_id = $1 AND capability_code = 'organise_events'`, [u.userId])).status, 'verified');
  assert.equal((await P.superAdmin.post('/api/admin/organisers', { telegram_user_id: u.tgId, enabled: false })).status, 200);
  assert.equal((await db.one(`SELECT status FROM user_capabilities WHERE user_id = $1 AND capability_code = 'organise_events'`, [u.userId])).status, 'revoked');
});

test('sign-in records one telegram identity per user', async () => {
  const u = await signedInClient();
  await signedInClient({ tgId: u.tgId }); // second sign-in
  const rows = (await db.query(`SELECT provider, subject, verified_at FROM user_identities WHERE user_id = $1`, [u.userId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'telegram');
  assert.equal(rows[0].subject, String(u.tgId));
  assert.ok(rows[0].verified_at);
});

// ---------- migration 012 ----------

const files = () => fs.readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const sql012 = () => fs.readFileSync(path.join(MIGRATIONS, '012_identity_orgs_memberships.sql'), 'utf8');

test('migration 012 on a fresh database: tables exist and 9 capabilities are seeded', async () => {
  const caps = (await db.query('SELECT code FROM capabilities ORDER BY code')).rows.map((r) => r.code);
  assert.deepEqual(caps, ['creator', 'dj', 'first_aid', 'food_service', 'host_staff', 'manage_venue', 'organise_events', 'photography', 'security']);
  for (const t of ['user_identities', 'organisations', 'org_memberships', 'user_capabilities', 'venues', 'event_team']) {
    assert.ok(await db.one(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [t]), t);
  }
});

test('migration 012 re-run is a no-op (idempotent)', async () => {
  const count = async () => db.one(`SELECT (SELECT count(*) FROM organisations)::int AS o, (SELECT count(*) FROM org_memberships)::int AS m,
    (SELECT count(*) FROM user_identities)::int AS i, (SELECT count(*) FROM capabilities)::int AS c, (SELECT count(*) FROM user_capabilities)::int AS uc`);
  const before = await count();
  await db.tx(async (c) => { await c.query(sql012()); });
  await db.tx(async (c) => { await c.query(sql012()); });
  assert.deepEqual(await count(), before);
});

// Runs last: it rebuilds the schema from 003..011, adds legacy data, then applies 012.
test('migration 012 upgrade: backfills identities, personal orgs, owner memberships, capability and event org', async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for (const f of files().filter((x) => x < '012')) {
    await db.tx(async (c) => { await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')); });
  }
  const host = await db.one(`INSERT INTO users (telegram_user_id, alias, organiser_enabled) VALUES (5550001, 'Host Hema', true) RETURNING id`);
  const former = await db.one(`INSERT INTO users (telegram_user_id, alias, organiser_enabled) VALUES (5550002, NULL, false) RETURNING id`);
  const plain = await db.one(`INSERT INTO users (telegram_user_id, alias) VALUES (5550003, 'Guest') RETURNING id`);
  const ev = await db.one(
    `INSERT INTO events (slug, category, title, city, start_at, capacity, status, organiser_user_id) VALUES ('legacy-ev', 'meetup', 'L', 'Chennai', now() + interval '2 days', 5, 'published', $1) RETURNING id`, [host.id]);
  await db.query(`INSERT INTO event_drafts (organiser_user_id, data) VALUES ($1, '{}')`, [former.id]);
  const adminEv = await db.one(
    `INSERT INTO events (slug, category, title, city, start_at, capacity, status) VALUES ('admin-ev', 'meetup', 'A', 'Chennai', now() + interval '2 days', 5, 'published') RETURNING id`);

  await db.tx(async (c) => { await c.query(sql012()); });

  assert.equal((await db.one('SELECT count(*)::int AS n FROM user_identities')).n, 3);
  const orgs = (await db.query(`SELECT personal_user_id, name, kind FROM organisations ORDER BY name`)).rows;
  assert.deepEqual(orgs.map((o) => [o.personal_user_id, o.name, o.kind]), [[host.id, 'Host Hema', 'personal'], [former.id, 'Personal', 'personal']]);
  assert.ok(!orgs.some((o) => o.personal_user_id === plain.id));
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM org_memberships WHERE role = 'owner' AND status = 'active'`)).n, 2);
  const caps = (await db.query(`SELECT user_id, status FROM user_capabilities WHERE capability_code = 'organise_events' ORDER BY status`)).rows;
  assert.deepEqual(caps.map((r) => [r.user_id, r.status]).sort(), [[former.id, 'revoked'], [host.id, 'verified']].sort());
  const hostOrg = await db.one('SELECT id FROM organisations WHERE personal_user_id = $1', [host.id]);
  assert.equal((await db.one('SELECT organiser_org_id FROM events WHERE id = $1', [ev.id])).organiser_org_id, hostOrg.id);
  assert.equal((await db.one('SELECT organiser_org_id FROM events WHERE id = $1', [adminEv.id])).organiser_org_id, null);
  // Upgrade path is also re-runnable.
  await db.tx(async (c) => { await c.query(sql012()); });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM organisations')).n, 2);
  await resetDb();
});
