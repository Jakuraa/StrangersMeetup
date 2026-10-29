# Preview recovery and deployment audit — 2026-10-30

Scope: repository `Jakuraa/StrangersMeetup`, Vercel project `strangersmeetup` (team `satelinkinternet-collabs-projects`, `prj_JtY6c5SRSt1NHE5sjSZFZAYwYqaa`), Neon via the Vercel integration.
Branch for this work: `fix/preview-recovery-audit` (from `origin/launch-mvp` @ `f5e7223`). Nothing was deployed, promoted, merged, migrated remotely or changed in Vercel.

> **Follow-up pass (2026-10-30 ~02:00 IST): see §11–§13.** The isolation gate was re-checked and is still **FAILED**. TLS and redirect regression tests were added. The zod v4 upgrade was trial-run (not adopted). The branch was pushed with Git auto-deploys disabled for this branch only, so CI runs but no Preview is built against the Production database.

## 1. Verdict in one paragraph

Production is **not stuck**. The latest Production deployment (`dpl_3g7aUM3Vyq71mZczg7tfmKVL5DgH`) is built from `main` @ `5c6652a`, and `5c6652a` **is** the current tip of remote `main`. PR #7 (SuperProfile checkout) was merged into **`launch-mvp`**, not `main` (merge commit `f5e7223`), so `main` does not contain it. The cause is Git branch state, not the Vercel Git integration, a failed build or permissions. Vercel already built a READY Preview of `launch-mvp` @ `f5e7223`.

The real blocker for end-to-end Preview testing is different: **Preview and Production share one Neon database.** Every database variable is a single record scoped to Development + Preview + Production, so no write, migration or sign-in test may run against any Preview until the owner gives Preview its own database.

## 2. Git source of truth (verified 2026-10-30 ~01:20 IST)

| Ref | SHA | Notes |
|---|---|---|
| `origin/main` | `5c6652ae11542aa2b38df323f6258d7494b2a006` | Merge of PR #2 (`launch-mvp` → `main`). Its second parent `7bc062b` brings in PRs #3–#6. |
| `origin/launch-mvp` | `f5e7223483a750acebd137955f67992e38730446` | Merge of PR #7. Six commits ahead of `main` (PR #7 content); `main` is one commit ahead (its own merge commit). |
| `origin/feature/superprofile-checkout` | `64cfe6f` | PR #7 head; fully contained in `launch-mvp`. |
| `fix/preview-recovery-audit` (local, this work) | based on `f5e7223` | No upstream set on purpose, so a bare `git push` can never target `launch-mvp`. |

- `git merge-base --is-ancestor f5e7223 origin/main` → **false** (main does not contain PR #7).
- PR #7: `MERGED` 2026-10-29T19:19:07Z, base `launch-mvp`, head `feature/superprofile-checkout`.
- Local `main` checkout (at `/Users/pradeepjakuraa/strangersmeetup`) is 36 commits behind `origin/main`. This is cosmetic; nothing was moved.
- The working trees were clean. No user changes were touched.

### CI (GitHub Actions `CI`, Node 24, postgres:16)

| Run | Ref / SHA | Result |
|---|---|---|
| 40907567064 | PR #7 head `64cfe6f` | success |
| 40938995707 | push `launch-mvp` `f5e7223` | **failure**: 127 passed, 8 skipped, 1 failed |

The failure was `e2e/wizard-tap-targets.spec.js:78`, `TypeError: Cannot read properties of null (reading 'height')`. Root cause: the organiser wizard re-renders its whole step via `innerHTML` when the debounced autosave (900 ms) returns. The node that `toBeVisible()` saw could be detached before `boundingBox()` measured it, and `boundingBox()` returns `null` for a detached node. This is a test race, not an application bug. **Fixed** (see §6).

## 3. Vercel (read-only inspection)

| Item | Value |
|---|---|
| Framework preset | none (static `public/` + one function `api/index.js`) |
| Node | `24.x` (project setting) |
| Build | `vercel.json` `buildCommand: npm run vercel-build` → `node scripts/migrate.js` |
| Production deployment | `dpl_3g7aUM3Vyq71mZczg7tfmKVL5DgH` — `main` @ `5c6652a` — READY |
| Latest Preview | `dpl_6UqPziFHWNVfRLAk2iTETVDjJEyJ` — `launch-mvp` @ `f5e7223` — READY — https://vercel.com/satelinkinternet-collabs-projects/strangersmeetup/6UqPziFHWNVfRLAk2iTETVDjJEyJ |
| Preview aliases | only `strangersmeetup-git-la-730dd9-satelinkinternet-collabs-projects.vercel.app` (branch alias). It is **not** a Production alias. |
| Project domains | `strangersmeetup-virid.vercel.app` (the only domain record); no custom domain |
| Deployment protection | Vercel Authentication (SSO) on `all_except_custom_domains`; no password protection; no trusted IPs |
| Plan | Hobby (runtime logs are kept for 1 hour only) |

**Preview build log (`f5e7223`)** is clean. Migrations were correctly skipped: `[migrate] skipping migrations — vercel preview build: set MIGRATE_ON_PREVIEW=true only if this environment has its own database`. It has two warnings:

1. `engines.node ">=20"` would auto-upgrade to a future major. **Fixed:** the engine is pinned to `24.x`, which matches the Vercel project and CI.
2. `scripts/migrate.js` runs twice per build. Vercel runs the `vercel-build` script and then the `buildCommand` (`npm run vercel-build`) again. This is harmless because migrations are ledgered and idempotent: a re-run applies 0, verified locally. It is noted rather than changed, because changing the Production build path without a Production build to verify it is not a safe repair.

**Runtime errors (last 7 days):**
- A recurring `pg` warning: sslmode `require` is treated as `verify-full` today and will become weaker libpq semantics in pg v9. Owner action: use `sslmode=verify-full` in the connection strings.
- Stale `DB_NOT_CONFIGURED` errors from 26 Oct, from before Neon was attached.
- No schema errors were recorded for the Preview. This is weak evidence (see §8).

**Access:** the Vercel MCP and the local CLI session (user `satelink`) both worked with no OTP. Listing environment variables through the MCP returned **403 forbidden**. The CLI `vercel env ls` (names and scopes only, values never pulled) succeeded. **OTP was not a blocker for anything in this audit.**

## 4. Database isolation — FAILED (hard gate)

These are names and scopes only, from `vercel env ls`. No value was read or decrypted.

| Variable(s) | Scope | Preview-only override? |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Development, Preview, Production (one record each) | **No** |
| `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Development, Preview, Production | **No** |
| `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_URL_NO_SSL`, `POSTGRES_PRISMA_URL`, `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | Development, Preview, Production | **No** |
| `NEON_PROJECT_ID`, `NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL` | Development, Preview, Production | No |
| `NEON_REALTIME_URL`, `NEON_REALTIME_SECRET` | separate Preview and Dev+Prod records | yes, but the app does not use them for its database |
| `TELEGRAM_BOT_TOKEN` | Production, Preview | — (the same bot token on Preview means Preview can message real users) |
| `MIGRATE_ON_PREVIEW` | **absent** (correct) | — |
| `SESSION_SECRET`, `CRON_SECRET`, `PUBLIC_SITE_URL`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_LOGIN_CLIENT_ID/SECRET`, `TELEGRAM_BOT_USERNAME`, `SUPERPROFILE_WEBHOOK_SECRET`, `ADMIN_BOOTSTRAP_TELEGRAM_ID` | **absent in every environment** | — |

Each `DATABASE_URL*` variable is one record whose target set includes both Preview and Production, so the two **cannot** point at different databases. No branch-specific Preview override exists.

Consequences:
- No migration, seed, sign-in, booking, checkout-click or webhook test was run against any Vercel deployment.
- The existing Preview (`launch-mvp` code) serves requests against the **Production** database. That database has only been migrated by `main` builds, so `010_superprofile_checkout.sql` has almost certainly not been applied there. Any Preview code path that reads the 010 columns may fail. This could not be confirmed without database access.
- These Preview GET routes **write** to the shared DB:
  - `/checkout/:slug`: `rate_limits`, `checkout_intents`, `analytics_events`
  - `/auth/telegram/*`: nonces, user upsert, sessions
  - admin GETs when signed in as `ADMIN_BOOTSTRAP_TELEGRAM_ID`: a one-time admin row plus an audit row. This variable is not set today, so it cannot fire.
  - `/api/cron/*`: needs `CRON_SECRET`, which is absent, so cron is closed.
- These routes are read-only and would be safe to smoke-test: `/`, `/events`, `/events/:slug`, `/trips`, collection and city pages, `/api/events`, `/api/health`, `/sitemap.xml`, `/robots.txt`, static assets, and HEAD `/checkout/*`.

### Owner steps to unblock (no secrets need to be shared with anyone)

1. In Neon, create a **branch** (for example `preview`) off the production branch with *schema only*, or create a new empty database in a separate Neon project. Do not copy customer data.
2. In Vercel → Settings → Environment Variables, the Neon integration owns the shared records, so do not edit them. Instead:
   - either use the Neon integration's **"Create a database branch for each preview deployment"** option, which injects branch-specific `DATABASE_URL*` for previews automatically,
   - or add **Preview-scoped** `DATABASE_URL` and `DATABASE_URL_UNPOOLED` records, optionally limited to the `launch-mvp` branch, pointing at the new branch, and remove Preview from the shared records' target list.
3. Only then add `MIGRATE_ON_PREVIEW=true` **scoped to Preview (or to the `launch-mvp` branch only)**, never to Production or All.
4. Add Preview-only values for `SESSION_SECRET` (32+ chars), `CRON_SECRET` (16+), `PUBLIC_SITE_URL`, `TELEGRAM_WEBHOOK_SECRET`, and `SUPERPROFILE_WEBHOOK_SECRET` (24+). Give Preview a **separate test bot token**, or remove Preview from `TELEGRAM_BOT_TOKEN`.
5. Redeploy the `launch-mvp` Preview (Vercel → Deployments → Redeploy, *Preview*). The build log must then say `[migrate] done (8 applied; vercel preview with MIGRATE_ON_PREVIEW=true)`.

## 5. Security and privacy review

Code-level findings, with file:line evidence collected during the audit.

| Area | Finding | Status |
|---|---|---|
| Feed fetch SSRF | `assertPublicHttpsUrl` resolved and validated the host, but `fetch()` resolved DNS **again** at connect time. That is a DNS-rebinding TOCTOU: a short-TTL record could pass the check and then connect to `127.0.0.1` or `169.254.169.254`. `isPrivateIp` also missed NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001::/32`, `192.0.0.0/24`, documentation ranges, `fec0::/10` and hex IPv4-mapped forms. | **Fixed** |
| Session creation without `SESSION_SECRET` | `createSession` inserted a `user_sessions` row before discovering the secret was missing, then returned 503, leaving an orphan row (`lib/session.js`). | **Fixed** |
| Checkout of a started multi-day event | `/checkout/:slug` allowed purchase until `end_at`. The event page already shows `past` at `start_at`, and free tiers refuse at `start_at` (`lib/services/ticketing.js:69`), so only a hand-typed checkout URL could still sell a running trip. | **Fixed**: same rule as free tiers |
| Paid checkout without a product | `checkoutForEvent` requires `checkout_mode='superprofile'` and a `superprofile_url`, otherwise it redirects back to the event with no insert (`lib/payments/availability.js:10`, `lib/services/checkout.js:35`). In-app paid tiers are always refused (`ticketing.js:82`). | OK |
| SuperProfile webhook | Returns 503 when the secret is under 24 chars and 401 on a wrong secret (`lib/handlers/superprofile.js:18`, `lib/payments/superprofile.js:58`). Amount, refund and idempotency checks are covered by the existing unit suite. | OK (unit); live provider BLOCKED |
| Cron and reconcile | Return 401 unless `CRON_SECRET` is 16+ chars and matches as a Bearer token (`lib/handlers/cron.js:36`, `:55`). | OK |
| Telegram webhook | Returns 401 without `TELEGRAM_WEBHOOK_SECRET` (`lib/handlers/telegram.js:15`). | OK |
| `/api/health` | Distinguishes `NOT CONFIGURED`, `error` and `ok`; returns 503 unless ok; no hostnames, DB names or error text. It does not report migration state, and an unreachable DB can hold the request for up to 8 s. | OK; improvement noted |
| Private venue | `events.venue_private` is only serialized when `venue_privacy='public'` (`lib/services/events.js:110`, `:140-143`). JSON-LD uses the same serializer. The sitemap selects only slug, category and updated_at. Bookings show the venue only when confirmed. | OK. Note: pickup-point `location` is public by design. |
| Dependencies | `undici` was added at **7.30.1**; the version bundled with Node 24.13 (7.18.2) has open advisories, and `npm audit` is clean for undici 7.30.1. `zod` 3.x has a **pre-existing high advisory** (fixed in 4.6.6, a major upgrade). | zod: owner decision |

## 6. Changes on `fix/preview-recovery-audit`

| File | Change |
|---|---|
| `lib/services/feeds.js` | `isPrivateIp` is rebuilt on `net.BlockList`. A new exported `pinnedLookup` and `feedDispatcher` (an undici `Agent` with `connect.lookup`) resolve, validate and hand the socket the validated IP in one step. `safeFetch` passes `dispatcher: feedDispatcher`. TLS SNI and certificate checks still use the URL's hostname. The redirect re-validation, timeout and size cap are unchanged. |
| `lib/session.js` | `createSession` checks the secret before the INSERT. |
| `lib/services/checkout.js` | Checkout requires `start_at > now()`. |
| `e2e/wizard-tap-targets.spec.js` | Measurements retry with `expect.poll` until the re-render settles. The thresholds (40 px chip, 52×32 switch, Fix < 30 px) are unchanged. |
| `package.json` / lock | `engines.node` is `24.x`; `undici@7.30.1` is added (exact pin). |
| `test/discovery.test.js` | 3 new tests: the IP classification table; DNS rebinding refused at connect time, including through a real undici fetch; and safeFetch using the pinned dispatcher. |
| `test/safety.test.js` | 1 new test: no orphan session row without `SESSION_SECRET`. |
| `test/superprofile-checkout.test.js` | Added: a started multi-day event returns 404 with no intent recorded. |

No test was removed or weakened. **Mutation check:** with each of the three fixes reverted, exactly 3 tests fail. With the fixes in place, all pass.

## 7. Test evidence

All runs were local, against disposable databases on `localhost`: `sm_audit_test`, `sm_audit_e2e`, and `sm_audit_mig` (dropped afterwards). `DATABASE_URL` was unset, `.env` was absent and `SKIP_DOTENV=true`.

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | 104/104 files OK |
| Unit and integration (baseline `f5e7223`) | `TEST_DATABASE_URL=postgres://localhost/sm_audit_test npm test` | 176 pass, 0 fail, 0 skipped |
| Unit and integration (this branch) | same | **180 pass, 0 fail, 0 skipped** |
| Browser (Playwright + axe; desktop, mobile, responsive matrix) | `E2E_DATABASE_URL=postgres://localhost/sm_audit_e2e npx playwright test` | **128 passed, 8 skipped (project-gated viewport tests), 0 failed** (5.0 min) |
| Previously flaky test | `… wizard-tap-targets.spec.js --project=desktop --repeat-each=10` | 10/10 passed |
| Migrations from empty | `node scripts/migrate.js` on a fresh DB | 8 applied (003→010); ledger has 8 rows |
| Migrations idempotent | second run | 0 applied |
| Preview build policy, no DB | `VERCEL=1 VERCEL_ENV=preview npm run vercel-build` | skipped: `DATABASE_URL not set` |
| Preview build policy, remote URL | same, with a dummy remote URL | skipped: needs `MIGRATE_ON_PREVIEW=true` |
| Real HTTPS through the pinned dispatcher | probe against `https://example.com/` | 200; a rebound answer to 127.0.0.1 gives `EPRIVATEADDR` |
| CI on this branch | — | **not run**: the branch is not pushed (see §8) |

## 8. What was not done, and why

- **Branch not pushed (first pass).** Pushing triggers a Git-linked Vercel Preview automatically, and with the shared database that deployment would be wired to Production data. *Superseded in the follow-up pass:* the branch is pushed with Git deployments disabled for this branch only (§11).
- **No live Preview runtime tests.** The deployment is behind Vercel Authentication. The only way available to fetch it, the MCP `web_fetch_vercel_url`, works by minting a 23-hour share link that bypasses SSO for anyone holding it. That is an access-control change and was not made. Runtime logs could not stand in: Hobby keeps 1 hour.
- **No Production action of any kind.** Nothing was deployed, promoted, aliased or changed in environment variables, and no domain or DNS was touched.
- **SuperProfile live verification is BLOCKED.** There is no webhook secret, no approved product and no provider credentials. Only rejection paths and mocked unit tests were exercised.

## 9. PASS / FAIL / BLOCKED matrix

L = local tests, CI = GitHub Actions, B = Vercel build, R = live Preview runtime.

| Flow | L | CI | B | R |
|---|---|---|---|---|
| Public pages, discovery, trips render (+ axe) | PASS | PASS (PR head) / FAIL on `launch-mvp` push (flaky test, fixed here) | PASS (`f5e7223`) | BLOCKED (SSO; shared DB) |
| `/api/health` states and no leakage | PASS | PASS | — | BLOCKED |
| Unauthenticated/unauthorized admin returns branded 401/403 | PASS | PASS | — | BLOCKED |
| Closed or past events not bookable (incl. started multi-day) | PASS | PASS (old rule) | — | BLOCKED |
| Private venue never public | PASS | PASS | — | BLOCKED |
| Sessions, CSRF, Telegram login and Mini App validation, rate limits | PASS | PASS | — | BLOCKED (no `SESSION_SECRET` or Telegram login vars) |
| Free event booking | PASS | PASS | — | BLOCKED (would write to the Production DB) |
| Paid checkout fails closed without a product | PASS | PASS | — | BLOCKED |
| SuperProfile webhook (secret, amount, refund, idempotency) | PASS (mocked) | PASS (mocked) | — | BLOCKED (no provider credentials) |
| Reconciliation and claim fail closed | PASS | PASS | — | BLOCKED |
| Cron auth | PASS | PASS | — | BLOCKED (`CRON_SECRET` absent, so closed) |
| Feed SSRF and DNS rebinding, TLS hostname check, redirect downgrade and hop cap | PASS (new tests, mutation-checked) | see §13 | — | — |
| Migrations 003→010 | PASS | PASS | Skipped by policy (correct) | BLOCKED (no Preview DB) |
| Preview DB isolation | — | — | **FAIL** (shared records) | — |

## 10. Smallest safe next actions (owner)

1. **Provision a Preview database** and scope the variables as in §4, steps 1–4. This one step unblocks everything marked BLOCKED.
2. Review this branch locally, then push it and open a PR into `launch-mvp`: `git push -u origin fix/preview-recovery-audit`. Do this **after** step 1 if you want its auto-Preview to be safe; CI needs no secrets.
3. When `launch-mvp` is ready to ship, open a PR `launch-mvp` → `main`. Merging it is what puts SuperProfile checkout into Production. The Production build will then apply migration 010 to the Production DB.
4. Change the Neon connection strings to `sslmode=verify-full` to silence the pg deprecation warning and keep today's behaviour.
5. Decide on the zod 3 → 4 upgrade (high advisory).
6. Optional: make `/api/health` report "migrations behind" without details, and cap its DB ping below 8 s.

## 11. Follow-up verification (2026-10-30 ~02:00 IST)

**Git.** `d4a9c73` exists; its only parent is `f5e7223`, which is still the tip of `origin/launch-mvp`. `origin/main` is still `5c6652a`. The `launch-mvp...fix/preview-recovery-audit` diff matches §6 exactly: 10 files, tests added only, none removed or loosened.

**Vercel (read-only; names and scopes only, from `vercel env ls`, no value read).** Nothing changed since §4:
- `DATABASE_URL` and `DATABASE_URL_UNPOOLED` are each **one** record scoped Development + Preview + Production.
- `TELEGRAM_BOT_TOKEN` is one record scoped Production + Preview.
- `MIGRATE_ON_PREVIEW` is absent.

Because each variable is a single record covering both environments, the Preview and Production URLs are structurally identical; no decryption is needed to prove they are shared. **Gate: FAILED.** So in this pass there were no migrations, no seeds, no sign-in, booking or webhook tests, no environment edits and no deployments.

Deployments are unchanged:
- Production: `dpl_3g7aUM3Vyq71mZczg7tfmKVL5DgH`, `main` @ `5c6652a`.
- Newest Preview: `dpl_6UqPziFHWNVfRLAk2iTETVDjJEyJ`, `launch-mvp` @ `f5e7223`.

**Push safety.** Pushing a branch normally makes Vercel build a Preview of it. That Preview would use the shared Production DB and bot token. `vercel.json` now has `git.deploymentEnabled: { "fix/preview-recovery-audit": false }`. Vercel reads this from the pushed commit, so this branch gets CI but no Vercel deployment, and every other branch behaves exactly as before.
- **Remove that key once the Preview DB exists**, so the PR gets its Preview (§10.1).
- After a merge, the key mentions only this branch name and has no effect on `launch-mvp` or `main`.

**Security re-verification (E).**
| Claim | Evidence | Result |
|---|---|---|
| DNS-rebinding protection | `pinnedLookup` resolves, rejects any private answer, and hands the socket the checked address. Tested with a rebinding resolver, directly and through real undici. | PASS |
| Unsafe IPv4 and IPv6 ranges | `net.BlockList` table, including NAT64, 6to4, Teredo, site-local and hex IPv4-mapped forms. A table test covers 22 refused and 4 allowed addresses. | PASS |
| Safe redirects | Every hop is re-validated. Existing test: redirect to a private host is refused. **New:** an `https`→`http` downgrade is refused before the http URL is requested, and loops stop after 4 requests. | PASS |
| TLS hostname verification | **New:** a throwaway CA plus a local HTTPS server, with every hostname pinned to it. The right hostname returns 200; the wrong hostname gives `ERR_TLS_CERT_ALTNAME_INVALID`; an untrusted issuer is refused. To make this testable, `createFeedDispatcher(lookup)` was extracted; production behaviour is unchanged. | PASS |
| Mutation check of the new tests | Adding `rejectUnauthorized: false` makes only the TLS test fail. Changing the hop cap from 4 to 5 makes only the redirect test fail. | PASS |
| No session row without `SESSION_SECRET` | `test/safety.test.js` | PASS |
| Checkout refuses started events | `test/superprofile-checkout.test.js` (404 and no intent row) | PASS |
| No ticket without a trusted SuperProfile notification | A wrong or missing secret gets 401 before any write. An unknown product, a wrong amount or an expired ref is never confirmed. Claims only match webhook-recorded orders. | PASS (mocked) |
| SuperProfile live provider: product, webhook delivery, refunds | No account credentials, product or webhook secret | **BLOCKED** |

## 12. zod 3 → 4: assessment and separate migration plan (not applied)

**Advisory.** GHSA-mrhx-c7xc-m3w5 is high (CVSS 4.0 8.2, CWE-770) and affects `zod <4.6.6`, fixed in 4.6.6. Array parsing collects one issue per failing element with no cap, so a huge array can exhaust memory.

**Exposure in this app: low.**
- Every `z.array` already has `.max()`.
- Request bodies are capped at 64 KB by default.
- The 512 KB reconcile body sits behind `CRON_SECRET`; Telegram's 256 KB body sits behind `TELEGRAM_WEBHOOK_SECRET`.
- The cost is bounded, not unbounded. Upgrade anyway, but as its own PR.

**Trial (scratch copy, not committed).** `zod@4.6.7` as a drop-in: lint 104/104, unit and integration **180/180 pass**. But a direct probe of the APIs this repo uses shows **silent behaviour changes the tests do not catch**:

| v3 usage here | v4 behaviour | Impact |
|---|---|---|
| `z.string({ required_error: 'Required' })` (`lib/handlers/leads.js:8`) | option ignored → "Invalid input: expected string, received undefined" | user-facing form message regresses |
| `{ errorMap: () => ({ message }) }` on `z.literal`/`z.enum` (`leads.js:13`, `discovery.js:25,26,36`) | ignored → generic "Invalid input…" / "Invalid option…" | the "Please tick to continue", "Choose a city" and "Choose a format" messages are lost |
| Default issue messages everywhere | wording changed, e.g. "Unrecognized key(s) in object" → "Unrecognized key: \"b\"" | the visible `fields[].message` text changes |
| `.uuid()` (7 uses) | RFC-strict: rejects non-RFC variant/version nibbles | none for `gen_random_uuid()` ids; use `z.guid()` if a lax check is ever needed |
| `z.record(valueSchema)` one-arg (`auth.js:23`) | still accepted in 4.6.7 | none today; switch to `z.record(z.string(), …)` |
| `.strict()` / `.passthrough()` / `.datetime()` / `.default().transform()` | still work (deprecated aliases) | none; optionally `z.strictObject` / `z.looseObject` / `z.iso.datetime` |

**Plan (separate PR `chore/zod-v4` → `launch-mvp`):**
1. **Tests first, on zod 3:** add tests that pin the custom messages (leads `Required`, consent, discovery city and format). They must pass on v3.
2. Bump to `zod@^4.6.7`. Those new tests must now **fail** (this proves they detect the regression).
3. Replace `required_error` / `errorMap` with v4's `{ error: '…' }`. Make `z.record` two-argument.
4. Run lint, unit, Playwright and axe. Spot-check the visible error text on `/list-your-event`, the leads forms and the organiser wizard.
5. CI green → review → merge into `launch-mvp`. There is no runtime-config or DB impact, so it is independent of the Preview DB gate.

## 13. Follow-up test evidence and CI

Local runs used throwaway databases on `localhost` (`sm_rec_test`, `sm_rec_e2e`, `sm_zod4`), with `DATABASE_URL` empty and `SKIP_DOTENV=true`.

| Check | Result |
|---|---|
| Lint | 104/104 files OK |
| Unit and integration | **182 pass**, 0 fail, 0 skipped (180 + 2 new SSRF tests) |
| Playwright + axe | **128 passed, 8 skipped (project-gated), 0 failed** (5.2 min) |
| zod 4.6.7 trial (scratch) | 180/180 pass; behaviour drift per §12 |
| PR | PR_RESULT |
| CI | CI_RESULT |

### If a Vercel login OTP is ever the blocker

It was not one in this audit. If it comes up:
- confirm the account and mailbox;
- check spam, junk, filters and quarantine;
- request one fresh code and use only the newest;
- if mail still does not arrive, contact Vercel Support through the official Help Center (vercel.com/help).
