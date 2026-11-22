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

  // Exactly 27 migrations currently exist: 003 through 029
  assert.equal(files.length, 27, `expected 27 migration files, got ${files.length}: ${files.join(', ')}`);

  // Verify sequential ordering
  const expectedPrefixes = [
    '003_', '004_', '005_', '006_', '007_', '008_',
    '009_', '010_', '011_', '012_', '013_', '014_', '015_', '016_', '017_', '018_', '019_', '020_', '021_', '022_', '023_', '024_', '025_', '026_', '027_', '028_', '029_'
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

test('schema_migrations table records all 27 migrations in correct order', async () => {
  const { rows } = await db.query('SELECT name, applied_at FROM schema_migrations ORDER BY name ASC');
  assert.equal(rows.length, 27);

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

  // Total count in schema_migrations must remain exactly 27
  const countRes = await db.one('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(countRes.n, 27);
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

test('migration 026: safe grandfathering of pre-existing accounts without bookings, consent integrity, and isolation from new registrations', async () => {
  // 1. Insert pre-existing accounts created before migration cutoff
  const past = new Date(Date.now() - 48 * 3600 * 1000); // 2 days ago

  // Existing WhatsApp member WITH historical age confirmation
  const uWhatsAppWithAge = (await db.query(
    `INSERT INTO users (phone, alias, created_at, status, age_confirmed_21, age_confirmed_at, onboarding_completed, onboarding_step)
     VALUES ('+919811111111', 'PreWaWithAge', $1, 'active', true, $1, false, 0)
     RETURNING id, phone, alias, onboarding_completed, age_confirmed_21`,
    [past]
  )).rows[0];

  // Existing Telegram member WITH historical age confirmation
  const uTelegramWithAge = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, age_confirmed_21, age_confirmed_at, onboarding_completed, onboarding_step)
     VALUES (770001, 'PreTgWithAge', $1, 'active', true, $1, false, 0)
     RETURNING id, telegram_user_id, alias, onboarding_completed, age_confirmed_21`,
    [past]
  )).rows[0];

  // Existing member WITHOUT historical age confirmation (age_confirmed_21 = false)
  const uExistingWithoutAge = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, age_confirmed_21, age_confirmed_at, onboarding_completed, onboarding_step)
     VALUES (770002, 'PreTgNoAgeConsent', $1, 'active', false, null, false, 0)
     RETURNING id, telegram_user_id, alias, onboarding_completed, age_confirmed_21`,
    [past]
  )).rows[0];

  // Existing member without bookings (phone identity)
  const uWithoutBookings = (await db.query(
    `INSERT INTO users (phone, alias, created_at, status, age_confirmed_21, age_confirmed_at, onboarding_completed, onboarding_step)
     VALUES ('+919822222222', 'PreWaNoBookings', $1, 'active', true, $1, false, 0)
     RETURNING id, phone, alias, onboarding_completed`,
    [past]
  )).rows[0];

  // Existing admin account
  const uAdmin = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, age_confirmed_21, age_confirmed_at, onboarding_completed, onboarding_step)
     VALUES (770003, 'PreAdminUser', $1, 'active', true, $1, false, 0)
     RETURNING id, telegram_user_id, alias, onboarding_completed`,
    [past]
  )).rows[0];
  await db.query(
    `INSERT INTO admin_users (telegram_user_id, role, active) VALUES (770003, 'event_manager', true)
     ON CONFLICT (telegram_user_id) DO UPDATE SET active = true`
  );

  // Ghost user with alias ONLY (NO phone, NO telegram_user_id, NO user_identities, NO admin, NO bookings)
  const uAliasOnly = (await db.query(
    `INSERT INTO users (alias, created_at, status, age_confirmed_21, onboarding_completed, onboarding_step)
     VALUES ('AliasOnlyGhost', $1, 'active', false, false, 0)
     RETURNING id, alias, onboarding_completed`,
    [past]
  )).rows[0];

  // 2. Execute migration 026 SQL logic
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '026_member_onboarding_profile.sql'), 'utf8');
  await db.tx(async (c) => {
    await c.query(sql);
  });

  // 3. Verify grandfathering and consent integrity:
  // - WhatsApp member with age confirmation: grandfathered, age preserved, historical consent recorded
  const checkWa = (await db.query('SELECT * FROM users WHERE id = $1', [uWhatsAppWithAge.id])).rows[0];
  assert.equal(checkWa.onboarding_completed, true);
  assert.equal(checkWa.onboarding_step, 6);
  assert.equal(checkWa.age_confirmed_21, true, 'genuine historical age confirmation preserved');

  // - Telegram member with age confirmation: grandfathered, age preserved, historical consent recorded
  const checkTg = (await db.query('SELECT * FROM users WHERE id = $1', [uTelegramWithAge.id])).rows[0];
  assert.equal(checkTg.onboarding_completed, true);
  assert.equal(checkTg.onboarding_step, 6);
  assert.equal(checkTg.age_confirmed_21, true, 'genuine historical age confirmation preserved');

  // - Existing member WITHOUT historical age confirmation:
  // Must be marked onboarding_completed = true so they don't repeat profile onboarding,
  // BUT age_confirmed_21 MUST REMAIN false! Never manufacture consent!
  const checkNoAge = (await db.query('SELECT * FROM users WHERE id = $1', [uExistingWithoutAge.id])).rows[0];
  assert.equal(checkNoAge.onboarding_completed, true, 'does not repeat full profile onboarding');
  assert.equal(checkNoAge.onboarding_step, 6);
  assert.equal(checkNoAge.age_confirmed_21, false, 'NEVER set age_confirmed_21 = true without genuine evidence');

  // Verify onboarding_consents has NO confirmed record for user without historical confirmation!
  const noAgeConsent = (await db.query(
    `SELECT * FROM onboarding_consents WHERE user_id = $1 AND confirmed = true`,
    [uExistingWithoutAge.id]
  )).rows;
  assert.equal(noAgeConsent.length, 0, 'NEVER manufacture confirmed age-consent records');

  // - Member without bookings: grandfathered
  const checkNoBk = (await db.query('SELECT * FROM users WHERE id = $1', [uWithoutBookings.id])).rows[0];
  assert.equal(checkNoBk.onboarding_completed, true);
  assert.equal(checkNoBk.onboarding_step, 6);

  // - Admin user: grandfathered
  const checkAdm = (await db.query('SELECT * FROM users WHERE id = $1', [uAdmin.id])).rows[0];
  assert.equal(checkAdm.onboarding_completed, true);
  assert.equal(checkAdm.onboarding_step, 6);

  // - Ghost user with alias only: NOT grandfathered (an alias alone does not prove identity, age, or consent)
  const checkAliasOnly = (await db.query('SELECT * FROM users WHERE id = $1', [uAliasOnly.id])).rows[0];
  assert.equal(checkAliasOnly.onboarding_completed, false, 'alias alone must NOT be treated as verified identity');
  assert.equal(checkAliasOnly.onboarding_step, 0);

  // 4. Test genuinely new WhatsApp & Telegram registrations created AFTER migration cutoff
  const uNewWa = (await db.query(
    `INSERT INTO users (phone, alias, created_at, status, onboarding_completed, onboarding_step)
     VALUES ('+919833333333', 'NewWaUserPostMig', now() + interval '10 seconds', 'active', false, 0)
     RETURNING id, onboarding_completed, onboarding_step`
  )).rows[0];

  const uNewTg = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, created_at, status, onboarding_completed, onboarding_step)
     VALUES (880001, 'NewTgUserPostMig', now() + interval '10 seconds', 'active', false, 0)
     RETURNING id, onboarding_completed, onboarding_step`
  )).rows[0];

  // 5. Re-run migration 026 (idempotency test)
  await db.tx(async (c) => {
    await c.query(sql);
  });

  // Verify new registrations remain subject to onboarding
  const checkNewWa = (await db.query('SELECT * FROM users WHERE id = $1', [uNewWa.id])).rows[0];
  assert.equal(checkNewWa.onboarding_completed, false, 'new WhatsApp user must NOT be grandfathered on rerun');
  assert.equal(checkNewWa.onboarding_step, 0);

  const checkNewTg = (await db.query('SELECT * FROM users WHERE id = $1', [uNewTg.id])).rows[0];
  assert.equal(checkNewTg.onboarding_completed, false, 'new Telegram user must NOT be grandfathered on rerun');
  assert.equal(checkNewTg.onboarding_step, 0);

  // Verify uExistingWithoutAge still has age_confirmed_21 = false after migration rerun
  const checkNoAgeRerun = (await db.query('SELECT age_confirmed_21 FROM users WHERE id = $1', [uExistingWithoutAge.id])).rows[0];
  assert.equal(checkNoAgeRerun.age_confirmed_21, false, 'rerun must never manufacture age confirmation');
});

test('migration 027: master auth, onboarding, community joins, and expanded Indian cities', async () => {
  // 1. Verify gender_custom column on users table
  const colRes = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'gender_custom'`
  );
  assert.equal(colRes.rows.length, 1, 'users.gender_custom column must exist');

  // 2. Verify member_community_joins table exists
  const tblRes = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name = 'member_community_joins'`
  );
  assert.equal(tblRes.rows.length, 1, 'member_community_joins table must exist');

  // 3. Verify expanded cities directory contains all 4 major regions and exactly 49 canonical markets
  const cities = await db.query(
    `SELECT slug, name, market_tier, active, is_discovery_active FROM location_cities ORDER BY slug`
  );
  assert.ok(cities.rows.length >= 49, `expected at least 49 cities, got ${cities.rows.length}`);

  const citySlugs = new Set(cities.rows.map(c => c.slug));
  const requiredCities = [
    'chennai', 'bengaluru', 'hyderabad', 'kochi', 'coimbatore', 'puducherry', 'madurai', 'trivandrum',
    'kozhikode', 'mysuru', 'mangaluru', 'vijayawada', 'visakhapatnam', 'tiruchirappalli', 'salem',
    'warangal', 'guntur', 'hubli-dharwad',
    'mumbai', 'pune', 'ahmedabad', 'goa', 'surat', 'vadodara', 'nagpur', 'nashik', 'rajkot', 'kolhapur',
    'delhi-ncr', 'chandigarh', 'jaipur', 'gurugram', 'noida', 'lucknow', 'dehradun', 'amritsar',
    'ludhiana', 'jammu', 'agra', 'varanasi', 'kanpur',
    'kolkata', 'bhubaneswar', 'guwahati', 'patna', 'ranchi', 'raipur', 'indore', 'bhopal'
  ];

  for (const rc of requiredCities) {
    assert.ok(citySlugs.has(rc), `required city slug "${rc}" must exist in location_cities`);
  }
});

test('migration 027: preserves administrator-deactivated city status across migration reruns', async () => {
  // 1. Ensure migration 027 is applied
  await migrate({ log: false });

  // 2. Administrator intentionally deactivates a city (e.g. 'kochi')
  await db.query(
    `UPDATE location_cities
     SET active = false, is_discovery_active = false
     WHERE slug = 'kochi'`
  );

  const beforeRerun = (await db.query(
    `SELECT slug, active, is_discovery_active FROM location_cities WHERE slug = 'kochi'`
  )).rows[0];
  assert.equal(beforeRerun.active, false, 'kochi must be deactivated by admin');
  assert.equal(beforeRerun.is_discovery_active, false, 'kochi discovery must be deactivated by admin');

  // 3. Re-run migration 027 SQL script directly to simulate migration re-run
  const migrationSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '027_master_auth_onboarding_neon.sql'), 'utf8');
  await db.query(migrationSql);

  // 4. Confirm the city remains deactivated after migration rerun
  const afterRerun = (await db.query(
    `SELECT slug, active, is_discovery_active FROM location_cities WHERE slug = 'kochi'`
  )).rows[0];
  assert.equal(afterRerun.active, false, 'kochi must REMAIN deactivated after migration rerun');
  assert.equal(afterRerun.is_discovery_active, false, 'kochi discovery must REMAIN deactivated after migration rerun');

  // Restore kochi for other tests
  await db.query(`UPDATE location_cities SET active = true, is_discovery_active = true WHERE slug = 'kochi'`);
});

test('migration 028: master platform evolution schema integrity and backfills', async () => {
  await migrate({ log: false });

  // 1. Verify user columns
  const userCols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`
  )).rows.map((r) => r.column_name);
  assert.ok(userCols.includes('active_mode'), 'users must have active_mode');
  assert.ok(userCols.includes('onboarding_flow'), 'users must have onboarding_flow');

  // 2. Verify event columns
  const eventCols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'events'`
  )).rows.map((r) => r.column_name);
  assert.ok(eventCols.includes('is_archived'), 'events must have is_archived');
  assert.ok(eventCols.includes('is_deleted'), 'events must have is_deleted');
  assert.ok(eventCols.includes('media_cleaned_up'), 'events must have media_cleaned_up');

  // 3. Verify tables exist
  const tables = (await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )).rows.map((r) => r.table_name);
  assert.ok(tables.includes('user_preferences'), 'user_preferences table must exist');
  assert.ok(tables.includes('user_connections'), 'user_connections table must exist');
  assert.ok(tables.includes('business_workspaces'), 'business_workspaces table must exist');
  assert.ok(tables.includes('business_suppliers'), 'business_suppliers table must exist');
  assert.ok(tables.includes('event_cancellations'), 'event_cancellations table must exist');
  assert.ok(tables.includes('media_cleanup_jobs'), 'media_cleanup_jobs table must exist');
});

test('migration 029: recurring venues, session models, and category ticket pricing schema integrity', async () => {
  // 1. Verify event_sessions table exists
  const tables = (await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )).rows.map((r) => r.table_name);
  assert.ok(tables.includes('event_sessions'), 'event_sessions table must exist');

  // 2. Verify columns on event_sessions
  const sessionCols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'event_sessions'`
  )).rows.map((r) => r.column_name);
  assert.ok(sessionCols.includes('event_id'));
  assert.ok(sessionCols.includes('session_index'));
  assert.ok(sessionCols.includes('session_date'));
  assert.ok(sessionCols.includes('venue_id'));
  assert.ok(sessionCols.includes('venue_name'));
  assert.ok(sessionCols.includes('venue_address'));

  // 3. Verify category & capacity columns on ticket_types
  const ticketCols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'ticket_types'`
  )).rows.map((r) => r.column_name);
  assert.ok(ticketCols.includes('category'), 'ticket_types must have category');
  assert.ok(ticketCols.includes('admit_count'), 'ticket_types must have admit_count');
  assert.ok(ticketCols.includes('min_per_booking'), 'ticket_types must have min_per_booking');
  assert.ok(ticketCols.includes('session_id'), 'ticket_types must have session_id');
  assert.ok(ticketCols.includes('valid_session_ids'), 'ticket_types must have valid_session_ids');

  // 4. Verify session columns on bookings and tickets
  const bookingCols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'bookings'`
  )).rows.map((r) => r.column_name);
  assert.ok(bookingCols.includes('session_id'));
  assert.ok(bookingCols.includes('session_date'));
  assert.ok(bookingCols.includes('admit_count'));

  const tCols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'tickets'`
  )).rows.map((r) => r.column_name);
  assert.ok(tCols.includes('session_id'));
  assert.ok(tCols.includes('session_date'));
  assert.ok(tCols.includes('admit_count'));
});
