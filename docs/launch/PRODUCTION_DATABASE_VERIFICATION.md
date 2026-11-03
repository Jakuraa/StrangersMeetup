# NIGHTLIFEZ — Production Database Verification & Forensic Analysis

**Audit Report on Historical Database Claims, Environment Isolation, and Owner Gate 3 Verification Protocol.**

---

## 1. Executive Summary & Forensic Investigation

During earlier audit phases, an apparent discrepancy was identified regarding the Production database state:
- **Claim A (Build Log):** The Vercel Production deployment `dpl_3g7aUM3Vyq71mZczg7tfmKVL5DgH` on 2026-10-29 reported `[migrate] done (0 applied; vercel production)`.
- **Claim B (Phase 5.1 & 5.4 Reports):** Suspected Production compute endpoint `ep-dawn-glitter-b4mkwxkl` was reported as an "idle, unmigrated clean baseline with 0 user tables".

### Forensic Findings (Empirical Evidence)
A full inspection of the raw build log for `dpl_3g7aUM3Vyq71mZczg7tfmKVL5DgH` directly via the Vercel CLI revealed the exact sequence of events that occurred on 2026-10-29:

```text
2026-10-29T02:00:36.752Z  > strangersmeetup@1.0.0 vercel-build
2026-10-29T02:00:36.752Z  > node scripts/migrate.js
2026-10-29T02:00:37.140Z  {"level":"info","ts":"2026-10-29T02:00:37.138Z","msg":"migration applied","ctx":{"file":"003_identity_events_bookings.sql"}}
2026-10-29T02:00:37.273Z  {"level":"info","ts":"2026-10-29T02:00:37.272Z","msg":"migration applied","ctx":{"file":"004_payments_entitlements_admin.sql"}}
2026-10-29T02:00:37.303Z  {"level":"info","ts":"2026-10-29T02:00:37.303Z","msg":"migration applied","ctx":{"file":"005_reports_alerts.sql"}}
2026-10-29T02:00:37.379Z  {"level":"info","ts":"2026-10-29T02:00:37.379Z","msg":"migration applied","ctx":{"file":"006_discovery_insights_membership.sql"}}
2026-10-29T02:00:37.402Z  {"level":"info","ts":"2026-10-29T02:00:37.400Z","msg":"migration applied","ctx":{"file":"007_organiser_enums.sql"}}
2026-10-29T02:00:37.464Z  {"level":"info","ts":"2026-10-29T02:00:37.463Z","msg":"migration applied","ctx":{"file":"008_organiser_wizard.sql"}}
2026-10-29T02:00:37.495Z  {"level":"info","ts":"2026-10-29T02:00:37.493Z","msg":"migration applied","ctx":{"file":"009_user_sessions.sql"}}
2026-10-29T02:00:37.495Z  [migrate] done (7 applied; vercel production)
...
2026-10-29T02:00:37.580Z  Running "npm run vercel-build"
2026-10-29T02:00:37.951Z  [migrate] done (0 applied; vercel production)
```

### Forensic Conclusion:
1. **Migrations 003–009 Were Indeed Applied:** On 2026-10-29, the initial invocation of `scripts/migrate.js` successfully applied all 7 migrations (`003` through `009`) to the database configured under Production `DATABASE_URL`.
2. **Double Execution Explanation:** Vercel's framework build process ran `npm run vercel-build` a second time ~400ms later. On this second run, `migrate()` correctly reported `0 applied; vercel production`. Previous auditors inspecting only the tail of the log mistakenly assumed that zero migrations had been executed.
3. **The `ep-dawn-glitter-b4mkwxkl` Conundrum:** In Phase 5.1, `ep-dawn-glitter-b4mkwxkl` was identified as a compute endpoint connected to a Neon branch named `production` (`br-delicate-recipe-b4welnn6`). If this branch was created as a fresh baseline **after** the October 29 deployment or if Vercel Production is bound to an earlier endpoint from the project setup 7 days ago, `ep-dawn-glitter-b4mkwxkl` would indeed show 0 user tables.

---

## 2. Vercel Environment Configuration Inspection

Inspection of project environment variables via `npx vercel env ls` confirms that **Preview and Production database connections are physically segregated in Vercel**:

| Variable Name | Environments Scoped | Created | Classification |
|---|---|---|---|
| `DATABASE_URL` | `Preview` | 4 days ago | Dedicated isolated Preview endpoint |
| `DATABASE_URL` | `Development, Production` | 7 days ago | Production endpoint |
| `DATABASE_URL_UNPOOLED` | `Preview` | 4 days ago | Dedicated unpooled Preview endpoint |
| `DATABASE_URL_UNPOOLED` | `Development, Production` | 7 days ago | Production unpooled endpoint |
| `ISOLATED_PREVIEW_DB` | `Preview` | 4 days ago | Flag enabling Preview writes & migrations |
| `MIGRATE_ON_PREVIEW` | `Preview` | 4 days ago | Flag enabling Preview migration execution |

**Security Finding:** Preview deployments **do not share** `DATABASE_URL` with Production. Vercel scopes the connection strings separately.

---

## 3. Dynamic Production Block List Architecture

To prevent any accidental execution of migrations, writes, test personas, or reviewer authentication against the suspected or confirmed Production database, NIGHTLIFEZ enforces a dynamic block list:

```javascript
// lib/config.js
export const DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS = [
  'ep-dawn-glitter-b4mkwxkl'
];

export function getBlockedProductionEndpoints(e = process.env) {
  const set = new Set(DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS);
  const extra = e?.BLOCKED_PRODUCTION_ENDPOINTS;
  if (typeof extra === 'string') {
    for (const part of extra.split(/[,\s]+/)) {
      const trimmed = part.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return Array.from(set);
}

export function isBlockedProductionDatabaseUrl(url, e = process.env) {
  if (!url || typeof url !== 'string') return false;
  const blocked = getBlockedProductionEndpoints(e);
  return blocked.some((endpoint) => url.includes(endpoint));
}
```

### Comprehensive Safety Rail Integration:
1. **Preview Reviewer Gate (`lib/dev-personas.js`):** Returns `false` if `DATABASE_URL` contains any blocked endpoint ID.
2. **Seed & Reset Guard (`scripts/seed-guard.js`):** Throws `SeedRefused` if `DATABASE_URL` contains any blocked endpoint ID.
3. **Preview Write Guard (`lib/db.js`):** `isPreviewWriteAllowed()` returns `false` if `DATABASE_URL` or `PREVIEW_DATABASE_URL` matches any blocked endpoint ID.
4. **Migration Execution Policy (`lib/db.js`):** `migrationPolicy()` refuses preview migrations if `DATABASE_URL` matches any blocked endpoint ID.
5. **Automated Verification:** Verified by automated regression tests in [`test/safety.test.js`](file:///Users/pradeepjakuraa/strangersmeetup/test/safety.test.js#L291).

---

## 4. Owner Gate 3: Required Owner Action Protocol

Before Pull Request #17 (`launch-mvp` $\to$ `main`) can be approved and merged into Production, the owner must complete this 3-step verification protocol:

### Step 1: Inspect Vercel Storage Binding
1. Navigate to [Vercel Dashboard](https://vercel.com) $\rightarrow$ Project **`strangersmeetup`** $\rightarrow$ **Storage** tab.
2. Locate the linked **Neon Postgres** database store.
3. Check the connected Neon Project Name (expected: `Strangersmeetup` / `winter-union-19864848`).

### Step 2: Identify Confirmed Production Compute Endpoint
1. In the Neon Console (or Vercel Storage Quick Access), inspect the **Production** branch (`production` / `br-delicate-recipe-b4welnn6`).
2. Note the active **Compute Endpoint ID** (e.g., `ep-dawn-glitter-b4mkwxkl` or the updated active endpoint).
3. Confirm that Vercel Production `DATABASE_URL` maps to this exact endpoint.

### Step 3: Verify Schema Migrations State
Execute a single read-only SQL query against the confirmed production database:
```sql
SELECT name, applied_at FROM schema_migrations ORDER BY name ASC;
```
- **If rows 003–009 are present:** The database matches the October 29 deployment state. PR #17 will cleanly apply migrations `010` through `014` on release.
- **If 0 rows are present:** The database is a clean baseline. PR #17 will execute the full migration sequence `003` through `014` sequentially.
- **Report Findings:** Provide the confirmed Endpoint ID to the engineering team. If the endpoint differs from `ep-dawn-glitter-b4mkwxkl`, set `BLOCKED_PRODUCTION_ENDPOINTS="<real-endpoint-id>"` in Preview environment settings to maintain continuous fail-closed protection.
