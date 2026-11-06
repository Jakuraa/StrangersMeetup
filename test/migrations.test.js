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

  // Exactly 18 migrations currently exist: 003 through 020
  assert.equal(files.length, 18, `expected 18 migration files, got ${files.length}: ${files.join(', ')}`);

  // Verify sequential ordering
  const expectedPrefixes = [
    '003_', '004_', '005_', '006_', '007_', '008_',
    '009_', '010_', '011_', '012_', '013_', '014_', '015_', '016_', '017_', '018_', '019_', '020_'
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

test('schema_migrations table records all 18 migrations in correct order', async () => {
  const { rows } = await db.query('SELECT name, applied_at FROM schema_migrations ORDER BY name ASC');
  assert.equal(rows.length, 18);

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

  // Total count in schema_migrations must remain exactly 18
  const countRes = await db.one('SELECT count(*)::int AS n FROM schema_migrations');
  assert.equal(countRes.n, 18);
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
