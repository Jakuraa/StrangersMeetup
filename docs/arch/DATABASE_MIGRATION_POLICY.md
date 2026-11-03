# NIGHTLIFEZ — Database Migration Policy & Architecture

**Definitive guide to schema evolution, migration concurrency locking, environment inventory, and zero-downtime safety rules.**

---

## 1. Migration Principles & Guarantees

NIGHTLIFEZ applies database schema changes through sequential, numbered SQL scripts in [`migrations/`](file:///Users/pradeepjakuraa/strangersmeetup/migrations). Every schema modification must strictly adhere to the following principles:

1. **Additive Only:** Destructive operations (`DROP TABLE`, `DROP COLUMN`, `RENAME COLUMN`) on active application tables are strictly forbidden during release cycles. Changes are introduced additively.
2. **Strict Transactional Execution:** Each migration file executes inside an isolated transaction (`BEGIN ... COMMIT`). If any statement fails, the entire migration rolls back immediately.
3. **Concurrency Serialization:** Migrations acquire a Postgres transaction-scoped advisory lock (`SELECT pg_advisory_xact_lock(724501)`) before reading `schema_migrations`. Parallel deployments or builds cannot race or execute duplicate migrations.
4. **Permanent Immutability:** Once a migration has been applied to Preview or Production, its file content is permanently immutable. Any fixes or adjustments must be shipped as a new, forward migration (e.g. migration `014` fixing `013`).
5. **Re-run Idempotency:** Every DDL statement must be safely re-runnable without error (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and guarded `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;` blocks).

---

## 2. Migration Inventory & Classification

All 12 active migrations (003 through 014) have been inspected, categorized, and verified against Local/CI, Preview, and Production environments:

| Migration File | Description & Scope | Locking Risk | Local / CI | Preview DB (`ep-green-hall`) | Production DB (Target) |
|---|---|---|---|---|---|
| `003_identity_events_bookings.sql` | Postgres baseline schema: users, events, bookings, media, custom enums (`user_status`, `event_category`, `venue_privacy`). | Low (Fresh creation) | **Applied** | **Applied** | **Applied** (2026-10-29 `dpl_3g7a...`) |
| `004_payments_entitlements_admin.sql` | Payment models, membership entitlements, admin roles, and audit outbox. | Low (Fresh creation) | **Applied** | **Applied** | **Applied** (2026-10-29 `dpl_3g7a...`) |
| `005_reports_alerts.sql` | User safety reports (`/report`), alert opt-ins (`users.alerts_opt_in`). | Minimal (Add column, new table) | **Applied** | **Applied** | **Applied** (2026-10-29 `dpl_3g7a...`) |
| `006_discovery_insights_membership.sql` | External feeds, submissions, first-party analytics, SuperProfile membership rows. | Minimal (Add columns, indexes) | **Applied** | **Applied** | **Applied** (2026-10-29 `dpl_3g7a...`) |
| `007_organiser_enums.sql` | Organiser booking and category enums (`pending_approval`, `declined`, `networking`). | Minimal (`ALTER TYPE ... ADD VALUE`) | **Applied** | **Applied** | **Applied** (2026-10-29 `dpl_3g7a...`) |
| `008_organiser_wizard.sql` | Organiser draft documents (`event_drafts`), ticket tiers, feature toggles. | Low (New table, add columns) | **Applied** | **Applied** | **Applied** (2026-10-29 `dpl_3g7a...`) |
| `009_user_sessions.sql` | Server-side user session management and instant revocation support. | Low (New table, indexes) | **Applied** | **Applied** | **Applied** (2026-10-29 `dpl_3g7a...`) |
| `010_superprofile_checkout.sql` | SuperProfile ticketing checkout mode and URL constraints. | Minimal (Add columns with constraints) | **Applied** | **Applied** | **Pending PR #17** |
| `011_trust_safety_remediation.sql` | Enhanced safety reporting categories, user block relationships (`user_blocks`). | Low (New table, add columns) | **Applied** | **Applied** | **Pending PR #17** |
| `012_identity_orgs_memberships.sql` | Multi-identity mapping, organisations, capabilities, scoped team memberships. | Low (New tables, custom enums) | **Applied** | **Applied** | **Pending PR #17** |
| `013_location_intelligence.sql` | Official India Local Government Directory (LGD) tables (States, Districts, Cities, Localities). | Low (New tables, bulk seed data) | **Applied** | **Applied** | **Pending PR #17** |
| `014_location_remediation.sql` | Coordinate provenance tracking (`location_provenance`) and auto-city resolution trigger. | Minimal (Add column, trigger function) | **Applied** | **Applied** | **Pending PR #17** |

---

## 3. Concurrency Protection & Execution Mechanics

Migrations are applied automatically via `scripts/migrate.js` using the core `migrate()` function in [`lib/db.js`](file:///Users/pradeepjakuraa/strangersmeetup/lib/db.js#L173):

```javascript
export async function migrate({ log = true } = {}) {
  // 1. Ensure migration tracking table exists
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  const applied = new Set(
    (await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name)
  );
  const ran = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    await db.tx(async (c) => {
      // 2. Acquire transaction-level advisory lock (Key: 724501)
      await c.query('SELECT pg_advisory_xact_lock(724501)');

      // 3. Re-check in case another parallel process just applied it
      const again = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (again.rowCount) return;

      // 4. Execute migration SQL statements
      await c.query(sql);

      // 5. Record applied migration
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      ran.push(file);
    });

    if (log) logger.info('migration applied', { file });
  }
  return ran;
}
```

### Key Safety Characteristics:
- **Lock Key `724501`:** A dedicated 64-bit integer identifier allocated specifically for NIGHTLIFEZ schema migration synchronization.
- **Transaction Scope (`_xact_`):** The lock is automatically released by Postgres when the transaction commits or aborts, eliminating the risk of orphaned locks on process termination.
- **Double-Check Pattern:** Even if multiple serverless containers begin migrating simultaneously, the second container waits on the lock, discovers the file is recorded in `schema_migrations`, and safely skips re-execution.

---

## 4. Backward Compatibility & Zero-Downtime Rollout

Because serverless applications run multiple concurrent instances during deployments, an older version of the application will inevitably handle requests while migrations are executing.

### Strategies Enforced in NIGHTLIFEZ Migrations:
1. **No NOT NULL Without Defaults:** Any newly added column either allows `NULL` or specifies a safe `DEFAULT` value (e.g., `coords_provenance location_provenance NOT NULL DEFAULT 'none'`).
2. **Enum Additions:** In PostgreSQL, new enum values added via `ALTER TYPE ... ADD VALUE IF NOT EXISTS` cannot be used in statements within the same transaction. For this reason, enum additions are isolated or placed prior to tables that consume them (e.g. migration `007` isolates enums before migration `008`).
3. **Decoupled Code & DB Deployments:** Application code handles missing columns gracefully with fallbacks (e.g., `row.coords_provenance || 'none'`), ensuring the old application version continues running without error while migrations land.

---

## 5. Rollback & Forward Recovery Procedures

### 5.1. Forward Remediation (Preferred Standard)
When a migration produces an unexpected edge case or requires schema refinement:
1. **Do not modify the existing applied file.**
2. Create a new sequential migration (e.g., `015_<remediation_name>.sql`).
3. Include idempotent adjustments (`ALTER TABLE ...`, data backfills, updated triggers).
4. Test locally using `resetDb()` and upgrade dry-runs.
5. Deploy through the standard PR pipeline into `launch-mvp`.

### 5.2. Emergency Rollback via Neon Instant Point-in-Time Restore
In the unlikely event of catastrophic failure or data corruption:
1. Access the Neon Console or CLI.
2. Select the affected database branch (`preview` or `production`).
3. Restore the branch to the exact timestamp immediately preceding the deployment.
4. Redeploy the previous stable application commit in Vercel.
