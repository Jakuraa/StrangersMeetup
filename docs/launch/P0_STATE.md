# P0 — Ground truth

Captured 2026-11-02 (IST) from `origin` after `git fetch --prune`. Read-only: nothing was merged, deleted or deployed while collecting this.

## Key refs

| Ref | SHA | Notes |
|---|---|---|
| `main` | `5c6652a` | Merge of PR #2 (2026-10-29). 48 commits behind `launch-mvp`. No GitHub Actions run recorded on `main`. |
| `launch-mvp` | `2dd5eaa` | Merge of `fix/preview-recovery-audit` (PR #18). |
| `fix/preview-recovery-audit` | `303dcab` | 2 commits not in `launch-mvp`, both docs only (Phase 5.4 and 5.5 reports). |
| `feature/nightlifez-rebrand` | `c8d4d85` | PR #19 head. |

## Pull requests

| PR | Title | Base ← Head | State | Mergeable | Checks |
|---|---|---|---|---|---|
| #17 | Production release: free-only MVP | `main` ← `launch-mvp` (`2dd5eaa`) | OPEN | MERGEABLE | `lint, unit, e2e` ✅, Vercel Preview Comments ✅ |
| #19 | feat(brand): customer-facing rebrand from StrangersMeetup to NIGHTLIFEZ | `launch-mvp` ← `feature/nightlifez-rebrand` (`c8d4d85`) | OPEN | MERGEABLE | `lint, unit, e2e` ✅, Vercel Preview Comments ✅ |

## Latest CI run per branch

| Branch | Workflow | Result | Head | Run |
|---|---|---|---|---|
| `main` | — | no run on record | — | — |
| `launch-mvp` | CI | success | `2dd5eaa` | https://github.com/Jakuraa/StrangersMeetup/actions/runs/41338451503 |
| `fix/preview-recovery-audit` | CI | success | `67371cb` (older than branch head `303dcab`; docs-only commits since) | https://github.com/Jakuraa/StrangersMeetup/actions/runs/41316875819 |
| `feature/nightlifez-rebrand` | CI | success | `c8d4d85` | https://github.com/Jakuraa/StrangersMeetup/actions/runs/41368821968 |

## Branch table

"Unique" = commits on the branch that are not in `launch-mvp`. "Merged?" = branch tip is an ancestor of `launch-mvp` / `main`. Nothing is deleted; "archive candidate" only means the branch carries no unmerged work.

| Branch | Last commit | Merged into launch-mvp? | Merged into main? | Unique commits | Keep / archive candidate |
|---|---|---|---|---|---|
| `main` | `5c6652a` 2026-10-29 | n (1 merge commit only) | — | 1 (merge commit for PR #2, no content) | keep |
| `launch-mvp` | `2dd5eaa` 2026-11-02 | — | n | 0 | keep (integration branch) |
| `feature/nightlifez-rebrand` | `c8d4d85` 2026-11-02 | n | n | 2 | keep (PR #19 open) |
| `fix/preview-recovery-audit` | `303dcab` 2026-11-02 | n | n | 2 (docs only) | keep until its 2 docs land or are dropped |
| `feature/attendee-discovery-booking` | `14ebace` 2026-10-31 | y | n | 0 | archive candidate |
| `feature/cloud-deployment-prep` | `607d708` 2026-10-30 | y | n | 0 | archive candidate |
| `feature/complete-marketplace-journey` | `6ad0da0` 2026-11-01 | y | n | 0 | archive candidate |
| `feature/gate-paid-checkout-live-payments` | `db1f25c` 2026-11-01 | y | n | 0 | archive candidate |
| `feature/m2-responsive-admin` | `09c2a96` 2026-10-29 | y | y | 0 | archive candidate |
| `feature/m8-personas-e2e` | `cfa9536` 2026-10-29 | y | y | 0 | archive candidate |
| `feature/organiser-onboarding-wizard` | `f77e437` 2026-10-31 | y | n | 0 | archive candidate |
| `feature/organiser-wizard` | `b3a1d37` 2026-10-28 | y | y | 0 | archive candidate |
| `feature/platform-v2` | `50113e5` 2026-10-29 | y | y | 0 | archive candidate |
| `feature/superprofile-checkout` | `64cfe6f` 2026-10-29 | y | n | 0 | archive candidate |
| `feature/trust-safety-remediation` | `b4f7f73` 2026-11-01 | y | n | 0 | archive candidate |
| `feature/website-ux-enhancements` | `27597aa` 2026-10-31 | y | n | 0 | archive candidate |
| `fix/cloud-deployment-pr9-blockers` | `fb28579` 2026-10-30 | y | n | 0 | archive candidate |
| `fix/render-docker-alignment` | `a6d6159` 2026-10-30 | y | n | 0 | archive candidate |
| `vercel/install-vercel-web-analytics-7s18we` | `a7dbe24` 2026-10-25 | y | y | 0 | archive candidate |

Local only: a worktree at `.claude/worktrees/launch-mvp` on local branch `worktree-launch-mvp` (`7db45a5`). Not inspected or touched.

## Neon endpoints

| Environment | Expected endpoint | Status this run |
|---|---|---|
| Production | `ep-dawn-glitter-b4mkwxkl` | **Not re-verified.** Matches earlier launch docs; confirming it needs the connection string, and reading secret values was blocked in this run. Table count not measured for the same reason. |
| Preview | `ep-green-hall-b47clnq0` | **Not re-verified** (same reason). Preview has its own `DATABASE_URL` / `DATABASE_URL_UNPOOLED` and `ISOLATED_PREVIEW_DB`. |

Observation from env names only: `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and all `POSTGRES_*` variables are set for Development, Preview **and** Production as one shared value each. Only `DATABASE_URL*` is overridden for Preview. The app does not read them today: `lib/db.js:102-108` always passes an explicit connection string to `pg.Pool` and throws when none is set, so `pg` never falls back to `PG*`. Keep it that way — a future `new pg.Pool()` without a connection string on Preview would reach the Production database.

## Production env names (P1 gate)

Checked with `vercel env ls` (names only).

| Name | Production |
|---|---|
| `TELEGRAM_BOT_TOKEN` | present |
| `SESSION_SECRET` | **missing** |
| `CRON_SECRET` | **missing** |
| `TELEGRAM_BOT_USERNAME` | **missing** |
| `TELEGRAM_WEBHOOK_SECRET` | **missing** |
| `TG_CHAT_ID_EVENTS` | **missing** |
| `ADMIN_BOOTSTRAP_TELEGRAM_ID` | **missing** |
| `PUBLIC_SITE_URL` | **missing** |
| `ENABLE_LIVE_PAYMENTS` | **missing** (code default is off) |
| `SUPPORT_EMAIL` | **missing** |
| `LEGAL_ENTITY_NAME` | **missing** |
| `GRIEVANCE_OFFICER_NAME` | **missing** |
| `GRIEVANCE_EMAIL` | **missing** |

Owner settings for this run also have `DOMAIN_READY=no`, `PROD_ENV_VARS_SET=no` and `BOTFATHER_SETDOMAIN_DONE=no`, so the P1 production release is skipped.

## Migrations on `launch-mvp`

`003` → `011` (`003_identity_events_bookings.sql` … `011_trust_safety_remediation.sql`). Next free number: `012`.
