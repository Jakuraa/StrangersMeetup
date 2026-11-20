// test/migrations.test.js - M3: Database migration architecture, idempotency,
// concurrency locking, and schema verification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, resetDb } from './helpers.js';
import { migrate, migrationPolicy } from '../lib/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

before(async () => {
  await resetDb();
});

test('migration files inventory: sequential numbering, correct naming, and sorted order', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  // Exactly 24 migrations currently exist: 003 through 026
  assert.equal(files.length, 24, `expected 24 migration files, got ${files.length}: ${files.join(', ')}`);

  // Verify sequential ordering
  const expectedPrefixes = [
    '003_', '004_', '005_', '006_', '007_', '008_',
    '009_', '010_', '011_', '012_', '013_', '014_', '015_', '016_', '017_', '018_', '019_', '020_', '021_', '022_', '023_', '024_', '025_', '026_'
  ];
  for (let i = 0; i < expectedPrefixes.length; i++) {
    assert.ok(
      files[i].startsWith(expectedPrefixes[i]),
      `expected migration ${i} to start with ${expectedPrefixes[i]}, got ${files[i]}`
    );
  }
});

test('migration idempotency: re-running migrate() on an up-to-date database applies 0 migrations', async () => {
  // Database is already reset and migrated by before()
  const secondRun = await migrate({ log: false });
  assert.deepEqual(secondRun, [], 'expected zero migrations applied on re-run');

  const thirdRun = await migrate({ log: false });
  assert.deepEqual(thirdRun, [], 'expected zero migrations applied on third run');
});

test('schema_migrations table records all 24 migrations in correct order', async () => {
  const { rows } = await db.query('SELECT name, applied_at FROM schema_migrations ORDER BY name ASC');
  assert.equal(rows.length, 24);

  const appliedNames = rows.map((r) => r.name);
  const filesOnDisk = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  assert.deepEqual(appliedNames, filesOnDisk);

  for (const r of rows) {
    assert.ok(r.applied_at instanceof Date, `expected applied_at to be Date, got ${typeof r.applied_at}`);
  }
});

test('advisory lock serializes concurrent migrate() calls', async () => {
  // Test that running multiple concurrent migrate() calls does not fail or produce duplicate rows
  const [res1, res2, res3] = await Promise.all([
    migrate({ log: false }),
    migrate({ log: false }),
    migrate({ log: false })
  ]);

  // All should complete cleanly with 0 applied (since all already applied)
  assert.deepEqual(res1, []);
  assert.deepEqual(res2, []);
  assert.deepEqual(res3, []);

  // Total count in schema_migrations must remain exactly 24
  const countRes = await db.one('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(countRes.n, 24);
});

test('migration policy respects environment boundaries', () => {
  // Local development (no VERCEL env)
  assert.equal(migrationPolicy({ DATABASE_URL: 'postgres://localhost/sm_test' }).run, true);

  // Vercel Production
  assert.equal(migrationPolicy({
    DATABASE_URL: 'postgres://u:p@ep-prod.aws.neon.tech/neondb',
    VERCEL: '1',
    VERCEL_ENV: 'production'
  }).run, true);

  // Vercel Preview without isolated database is refused
  const previewShared = migrationPolicy({
    DATABASE_URL: 'postgres://u:p@ep-preview.aws.neon.tech/neondb',
    VERCEL: '1',
    VERCEL_ENV: 'preview'
  });
  assert.equal(previewShared.run, false);

  // Vercel Preview with MIGRATE_ON_PREVIEW and ISOLATED_PREVIEW_DB
  const previewIsolated = migrationPolicy({
    DATABASE_URL: 'postgres://u:p@ep-preview.aws.neon.tech/neondb',
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    MIGRATE_ON_PREVIEW: 'true',
    ISOLATED_PREVIEW_DB: 'true'
  });
  assert.equal(previewIsolated.run, true);

  // Blocked production endpoint is refused even in preview with isolated flag
  const previewBlocked = migrationPolicy({
    DATABASE_URL: 'postgres://u:p@ep-dawn-glitter-b4mkwxkl.aws.neon.tech/neondb',
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    MIGRATE_ON_PREVIEW: 'true',
    ISOLATED_PREVIEW_DB: 'true'
  });
  assert.equal(previewBlocked.run, false);
  assert.match(previewBlocked.reason, /blocked production endpoint/);
});

test('core schema integrity: all tables, custom types, and location intelligence structures exist', async () => {
  // Check tables
  const expectedTables = [
    'schema_migrations', 'users', 'events', 'bookings',
    'reports', 'event_drafts', 'user_sessions',
    'organisations', 'org_memberships', 'user_blocks',
    'location_states', 'location_districts', 'location_cities', 'location_localities',
    'payment_audits', 'saved_events'
  ];

  for (const table of expectedTables) {
    const r = await db.one(
      `SELECT to_regclass('public.' || $1)::text AS tbl`,
      [table]
    );
    assert.ok(r.tbl, `expected table public.${table} to exist`);
  }

  // Check custom enum types
  const expectedTypes = [
    'user_status', 'event_category', 'booking_status', 'checkout_mode',
    'state_kind', 'location_provenance'
  ];

  for (const typeName of expectedTypes) {
    const r = await db.one(
      `SELECT to_regtype('public.' || $1)::text AS typ`,
      [typeName]
    );
    assert.ok(r.typ, `expected custom type public.${typeName} to exist`);
  }

  // Verify coordinates provenance column on events table
  const col = await db.one(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_name = 'events' AND column_name = 'coords_provenance'`
  );
  assert.ok(col, 'expected coords_provenance column on events');
  assert.equal(col.udt_name, 'location_provenance');
});

test('payment_audits is immutable append-only ledger (DB-01)', async () => {
  const ins = await db.one(
    `INSERT INTO payment_audits (order_id, to_status, actor)
     VALUES ('ORD-TEST-IMMUTABLE', 'pending', 'test:migration')
     RETURNING id`
  );
  assert.ok(ins.id);

  // Attempt UPDATE -> must fail with append-only trigger exception
  await assert.rejects(
    () => db.query(`UPDATE payment_audits SET actor = 'hacked' WHERE id = $1`, [ins.id]),
    /payment_audits is an append-only ledger/
  );

  // Attempt DELETE -> must fail with append-only trigger exception
  await assert.rejects(
    () => db.query(`DELETE FROM payment_audits WHERE id = $1`, [ins.id]),
    /payment_audits is an append-only ledger/
  );
});

test('REV-07: ticket-tier active hold index (idx_payments_active_tier_holds) and query plan improvement', async () => {
  // 1. Verify index exists in pg_indexes
  const idx = await db.one(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'payments' AND indexname = 'idx_payments_active_tier_holds'`
  );
  assert.ok(idx, 'expected idx_payments_active_tier_holds to exist');
  assert.ok(
    idx.indexdef.includes("raw_ref ->> 'ticketTypeId'"),
    `expected index definition to reference ticketTypeId expression, got: ${idx.indexdef}`
  );

  // 2. Insert dummy rows and verify EXPLAIN query plan uses index scan
  const sampleTierId = 'a1111111-1111-4111-8111-111111111111';
  await db.query(`SET enable_seqscan = OFF;`);
  try {
    const explain = await db.query(
      `EXPLAIN (FORMAT JSON)
       SELECT COALESCE(sum((p.raw_ref->>'qty')::int), 0)::int AS n
       FROM payments p
       WHERE (p.raw_ref->>'ticketTypeId')::uuid = $1::uuid
         AND p.status IN ('created', 'pending', 'processing')
         AND p.expires_at > now()`,
      [sampleTierId]
    );
    const planStr = JSON.stringify(explain.rows[0]);
    assert.ok(
      planStr.includes('idx_payments_active_tier_holds'),
      `expected EXPLAIN query plan to use idx_payments_active_tier_holds, got: ${planStr}`
    );
  } finally {
    await db.query(`SET enable_seqscan = ON;`);
  }
});

test('migration 026: safe grandfathering of pre-existing accounts without bookings, idempotent re-runs, and isolation from new registrations', async () => {
  // 1. Insert pre-existing accounts created before migration cutoff
  const past = new Date(Date.now() - 48 * 3600 * 1000); // 2 days ago

  // Pre-existing WhatsApp user with NO bookings
  const uWhatsApp = (await db.query(
    `INSERT INTO users (phone, alias, created_at, status, age_confirmed_21, onboarding_completed, onboarding_step)
     VALUES ('+919811111111', 'PreWhatsAppNoBookings', $1, 'active', true, false, 0)
     RETURNING id, phone, alias, onboarding_completed`,
    [past]
  )).rows[0];

  // Pre-existing Telegram user with NO bookings
  const uTelegram = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, age_confirmed_21, onboarding_completed, onboarding_step)
     VALUES (770001, 'PreTgNoBookings', $1, 'active', true, false, 0)
     RETURNING id, telegram_user_id, alias, onboarding_completed`,
    [past]
  )).rows[0];

  // Pre-existing suspended account
  const uInactive = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, age_confirmed_21, onboarding_completed, onboarding_step)
     VALUES (770002, 'PreInactiveUser', $1, 'suspended', true, false, 0)
     RETURNING id, telegram_user_id, alias, onboarding_completed`,
    [past]
  )).rows[0];

  // Pre-existing admin account
  const uAdmin = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, age_confirmed_21, onboarding_completed, onboarding_step)
     VALUES (770003, 'PreAdminUser', $1, 'active', true, false, 0)
     RETURNING id, telegram_user_id, alias, onboarding_completed`,
    [past]
  )).rows[0];
  await db.query(
    `INSERT INTO admin_users (telegram_user_id, role, active) VALUES (770003, 'event_manager', true)
     ON CONFLICT (telegram_user_id) DO UPDATE SET active = true`
  );

  // Pre-existing user WITH an event booking
  const uWithBooking = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, age_confirmed_21, onboarding_completed, onboarding_step)
     VALUES (770004, 'PreUserWithBooking', $1, 'active', true, false, 0)
     RETURNING id, telegram_user_id, alias, onboarding_completed`,
    [past]
  )).rows[0];
  const ev = (await db.query(`SELECT id FROM events LIMIT 1`)).rows[0];
  if (ev) {
    await db.query(
      `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed')`,
      [ev.id, uWithBooking.id]
    );
  }

  // 2. Execute migration 026 SQL logic
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '026_member_onboarding_profile.sql'), 'utf8');
  await db.tx(async (c) => {
    await c.query(sql);
  });

  // 3. Verify all pre-existing accounts are safely grandfathered:
  // - WhatsApp user without bookings:
  const checkWa = (await db.query('SELECT * FROM users WHERE id = $1', [uWhatsApp.id])).rows[0];
  assert.equal(checkWa.onboarding_completed, true);
  assert.equal(checkWa.onboarding_step, 6);
  assert.equal(checkWa.display_name, 'PreWhatsAppNoBookings');
  assert.equal(checkWa.age_confirmed_21, true);

  // - Telegram user without bookings:
  const checkTg = (await db.query('SELECT * FROM users WHERE id = $1', [uTelegram.id])).rows[0];
  assert.equal(checkTg.onboarding_completed, true);
  assert.equal(checkTg.onboarding_step, 6);
  assert.equal(checkTg.display_name, 'PreTgNoBookings');
  assert.equal(checkTg.age_confirmed_21, true);

  // - Inactive user:
  const checkInact = (await db.query('SELECT * FROM users WHERE id = $1', [uInactive.id])).rows[0];
  assert.equal(checkInact.onboarding_completed, true);
  assert.equal(checkInact.onboarding_step, 6);

  // - Admin user:
  const checkAdm = (await db.query('SELECT * FROM users WHERE id = $1', [uAdmin.id])).rows[0];
  assert.equal(checkAdm.onboarding_completed, true);
  assert.equal(checkAdm.onboarding_step, 6);

  // - User with booking:
  const checkBk = (await db.query('SELECT * FROM users WHERE id = $1', [uWithBooking.id])).rows[0];
  assert.equal(checkBk.onboarding_completed, true);
  assert.equal(checkBk.onboarding_step, 6);

  // 4. Verify historical consent audit rows were created
  const consents = (await db.query(
    `SELECT user_id, consent_type, confirmed, policy_version FROM onboarding_consents
     WHERE user_id IN ($1, $2, $3, $4, $5)`,
    [uWhatsApp.id, uTelegram.id, uInactive.id, uAdmin.id, uWithBooking.id]
  )).rows;
  assert.equal(consents.length, 5);
  for (const c of consents) {
    assert.equal(c.consent_type, 'age_21_plus');
    assert.equal(c.confirmed, true);
    assert.equal(c.policy_version, 'historical');
  }

  // 5. Test genuinely new registration created AFTER migration:
  // Must NOT be marked as onboarded, even if migration 026 is executed again!
  const uNew = (await db.query(
    `INSERT INTO users (phone, alias, created_at, status, onboarding_completed, onboarding_step)
     VALUES ('+919822222222', 'NewUserPostMig', now() + interval '10 seconds', 'active', false, 0)
     RETURNING id, onboarding_completed, onboarding_step`
  )).rows[0];

  // Re-run migration 026 (idempotency test)
  await db.tx(async (c) => {
    await c.query(sql);
  });

  const checkNew = (await db.query('SELECT * FROM users WHERE id = $1', [uNew.id])).rows[0];
  assert.equal(checkNew.onboarding_completed, false, 'genuinely new user must NOT be grandfathered');
  assert.equal(checkNew.onboarding_step, 0, 'genuinely new user onboarding step must remain 0');

  const newConsent = (await db.query(
    `SELECT * FROM onboarding_consents WHERE user_id = $1`, [uNew.id]
  )).rows;
  assert.equal(newConsent.length, 0, 'genuinely new user must not have grandfathered consent');
});
