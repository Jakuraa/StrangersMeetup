// test/safety.test.js - M1 safety rails: migration policy on Vercel, seed/reset guards, server-side
// session revocation, fail-closed payment amounts, quantity-based fill in admin insights.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  resetDb, startServer, stopServer, Client, db, clearCalls, createEvent, signedInClient
} from './helpers.js';
import { migrationPolicy, isLocalDatabaseUrl, databaseName } from '../lib/db.js';
import { assertSeedAllowed, SeedRefused } from '../scripts/seed-guard.js';
import { planReset, assertResettable } from '../scripts/db-reset-local.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { createSessionToken } from '../lib/session.js';

const LOCAL = 'postgres://postgres@localhost:5432/sm_local';
const REMOTE = 'postgres://u:p@ep-cool-name.aws.neon.tech/neondb?sslmode=require';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);
beforeEach(clearCalls);

// ---------- migrations on Vercel ----------

test('migration policy: Vercel previews never migrate unless explicitly given their own DB', () => {
  assert.equal(migrationPolicy({}).run, false, 'no DATABASE_URL');
  assert.equal(migrationPolicy({ DATABASE_URL: LOCAL }).run, true, 'local dev migrates');
  assert.equal(migrationPolicy({ DATABASE_URL: REMOTE, VERCEL: '1', VERCEL_ENV: 'production' }).run, true);
  const preview = migrationPolicy({ DATABASE_URL: REMOTE, VERCEL: '1', VERCEL_ENV: 'preview' });
  assert.equal(preview.run, false);
  assert.match(preview.reason, /MIGRATE_ON_PREVIEW/);
  assert.equal(migrationPolicy({ DATABASE_URL: REMOTE, VERCEL: '1', VERCEL_ENV: 'development' }).run, false);
  assert.equal(migrationPolicy({ DATABASE_URL: REMOTE, VERCEL: '1' }).run, false, 'unknown Vercel env is not production');
  assert.equal(migrationPolicy({ DATABASE_URL: REMOTE, VERCEL: '1', VERCEL_ENV: 'preview', MIGRATE_ON_PREVIEW: 'true' }).run, true);
  assert.equal(migrationPolicy({ DATABASE_URL: REMOTE, VERCEL: '1', VERCEL_ENV: 'preview', MIGRATE_ON_PREVIEW: '1' }).run, false, 'only the literal "true" opts in');
});

test('local database detection only accepts loopback hosts and Unix sockets', () => {
  for (const u of [LOCAL, 'postgres://localhost/sm_test', 'postgresql://127.0.0.1:54329/x', 'postgres:///sm_local?host=/tmp',
    'postgres://[::1]/x', 'postgres:///x']) assert.equal(isLocalDatabaseUrl(u), true, u);
  for (const u of [REMOTE, 'postgres://db.example.com/x', 'postgres:///x?host=db.example.com', 'postgres://localhost.evil.com/x',
    'mysql://localhost/x', 'not a url', '', undefined]) assert.equal(isLocalDatabaseUrl(u), false, String(u));
  assert.equal(databaseName('postgres:///sm_local?host=/tmp'), 'sm_local');
});

// ---------- seed and reset guards ----------

test('seed guard: refuses production, refuses remote DBs without explicit opt-in', () => {
  assert.throws(() => assertSeedAllowed({ kind: 'demo', e: {} }), SeedRefused);
  assert.equal(assertSeedAllowed({ kind: 'demo', e: { DATABASE_URL: LOCAL } }).local, true);
  assert.throws(() => assertSeedAllowed({ kind: 'demo', e: { DATABASE_URL: REMOTE } }), /SEED_ALLOW_REMOTE/);
  assert.equal(assertSeedAllowed({ kind: 'demo', e: { DATABASE_URL: REMOTE, SEED_ALLOW_REMOTE: 'true' } }).local, false);
  for (const prod of [{ VERCEL_ENV: 'production' }, { NODE_ENV: 'production' }]) {
    assert.throws(() => assertSeedAllowed({ kind: 'demo', e: { DATABASE_URL: LOCAL, SEED_ALLOW_REMOTE: 'true', ...prod } }), /production/);
  }
});

test('reset guard: local only, never on Vercel, and --yes must name the exact database', () => {
  assert.throws(() => planReset({ argv: ['--yes=neondb'], e: { DATABASE_URL: REMOTE, SEED_ALLOW_REMOTE: 'true' } }), /only a database on this machine/);
  assert.throws(() => planReset({ argv: ['--yes=sm_local'], e: { DATABASE_URL: LOCAL, VERCEL: '1' } }), SeedRefused);
  assert.throws(() => planReset({ argv: ['--yes=sm_local'], e: { DATABASE_URL: LOCAL, NODE_ENV: 'production' } }), /production/);
  assert.throws(() => planReset({ argv: [], e: { DATABASE_URL: LOCAL } }), /--yes=sm_local/);
  assert.throws(() => planReset({ argv: ['--yes=other_db'], e: { DATABASE_URL: LOCAL } }), /--yes=sm_local/);
  assert.deepEqual(planReset({ argv: ['--yes=sm_local', '--seed-demo'], e: { DATABASE_URL: LOCAL } }), { database: 'sm_local', seedDemo: true });
});

test('reset guard: only an empty or StrangersMeetup database can be wiped', async () => {
  assert.equal(await assertResettable(db), 'strangersmeetup');
  const fake = (rows, marker = 0) => ({ query: async (sql) => (sql.includes('information_schema') ? { rows } : { rowCount: marker }) });
  assert.equal(await assertResettable(fake([{ tables: 0, has_migrations: null }])), 'empty');
  await assert.rejects(assertResettable(fake([{ tables: 12, has_migrations: false }])), /no StrangersMeetup migration history/);
  await assert.rejects(assertResettable(fake([{ tables: 12, has_migrations: true }], 0)), /no StrangersMeetup migration history/,
    'another project that also uses a schema_migrations table');
});

test('demo seed refuses a remote database that already holds real events', async () => {
  await createEvent({ isDemo: false });
  await assert.rejects(seedDemo({ e: { DATABASE_URL: REMOTE, SEED_ALLOW_REMOTE: 'true' } }), /real event/);
  await assert.rejects(seedDemo({ e: { DATABASE_URL: LOCAL, NODE_ENV: 'production' } }), /production/);
  const n = await seedDemo({ e: { DATABASE_URL: LOCAL } });
  assert.equal(n, 4);
  assert.equal((await db.one(`SELECT count(*)::int n FROM events WHERE is_demo AND slug LIKE 'sample-%'`)).n, 4);
});

// ---------- sessions ----------

const meUser = async (c) => (await c.get('/api/me')).json.user;

test('sign-out revokes the session server-side: the old cookie stops working', async () => {
  const c = await signedInClient();
  const stolen = c.cookies.sm_session;
  assert.ok(await meUser(c));
  const r = await c.post('/api/auth/logout', {});
  assert.equal(r.status, 200);
  assert.equal(await meUser(c), null, 'cookie cleared');
  const replay = new Client();
  replay.cookies.sm_session = stolen;
  assert.equal(await meUser(replay), null, 'a copied cookie is dead after sign-out');
  const row = await db.one('SELECT revoked_at, revoke_reason FROM user_sessions WHERE user_id = $1', [c.userId]);
  assert.ok(row.revoked_at);
  assert.equal(row.revoke_reason, 'logout');
});

test('sign-out needs the CSRF token when signed in; signed-out sign-out is a harmless no-op', async () => {
  const c = await signedInClient();
  const r = await c.req('POST', '/api/auth/logout', {}, { 'x-csrf-token': 'wrong' });
  assert.equal(r.status, 403);
  assert.ok(await meUser(c), 'still signed in');
  assert.equal((await new Client().post('/api/auth/logout', {})).status, 200);
});

test('sign out everywhere revokes every device of that user only', async () => {
  const a = await signedInClient();
  const other = new Client();
  other.cookies.sm_session = a.cookies.sm_session;
  // A second device of the same user signs in separately.
  const second = await signedInClient({ tgId: a.tgId });
  const bystander = await signedInClient();
  assert.equal((await second.req('POST', '/api/auth/logout-all', {}, { 'x-csrf-token': 'bad' })).status, 403);
  const r = await second.post('/api/auth/logout-all', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.revoked, 2);
  assert.equal(await meUser(other), null);
  assert.equal(await meUser(second), null);
  assert.ok(await meUser(bystander), 'other users are unaffected');
  assert.equal((await new Client().post('/api/auth/logout-all', {})).status, 401);
});

test('expired, unknown and pre-migration session cookies are rejected', async () => {
  const c = await signedInClient();
  await db.query(`UPDATE user_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [c.userId]);
  assert.equal(await meUser(c), null, 'server-side expiry wins even though the cookie exp is in the future');

  const forged = new Client();
  forged.cookies.sm_session = createSessionToken(c.userId, crypto.randomUUID());
  assert.equal(await meUser(forged), null, 'validly signed but no such session row');

  const legacy = new Client();
  const body = Buffer.from(JSON.stringify({ u: c.userId, exp: Math.floor(Date.now() / 1000) + 3600, n: 'x' })).toString('base64url');
  legacy.cookies.sm_session = `${body}.${crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url')}`;
  assert.equal(await meUser(legacy), null, 'old cookie format without a session id');
});

test('cron cleanup prunes long-dead sessions only', async () => {
  const c = await signedInClient();
  await db.query(`UPDATE user_sessions SET expires_at = now() - interval '31 days' WHERE user_id = $1`, [c.userId]);
  const live = await signedInClient();
  const r = await new Client().get('/api/cron/cleanup', { authorization: 'Bearer test-cron-secret-0123456789' });
  assert.equal(r.status, 200);
  assert.ok(r.json.results.cleanup.sessions >= 1);
  assert.equal((await db.one('SELECT count(*)::int n FROM user_sessions WHERE user_id = $1', [c.userId])).n, 0);
  assert.ok(await meUser(live));
});

// ---------- insights ----------

test('admin upcoming fill counts tickets (quantity), not booking rows', async () => {
  const owner = await signedInClient({ tgId: 900000001 });
  await owner.get('/api/admin/session');
  const ev = await createEvent({ capacity: 20, title: 'Fill check' });
  const g1 = await signedInClient();
  const g2 = await signedInClient();
  await db.query(
    `INSERT INTO bookings (event_id, user_id, status, quantity, confirmed_at) VALUES ($1, $2, 'confirmed', 3, now()), ($1, $3, 'confirmed', 2, now())`,
    [ev.id, g1.userId, g2.userId]);
  const r = await owner.get('/api/admin/insights?days=30');
  assert.equal(r.status, 200, r.text);
  const row = r.json.insights.bookings.upcomingFill.value.find((x) => x.id === ev.id);
  assert.equal(row.confirmed, 5);
});
