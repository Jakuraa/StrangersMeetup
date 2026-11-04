# NIGHTLIFEZ — Project state

**Single source of truth for where the code, environments and gates stand.** Each milestone PR updates this file. Other docs hold design and how-to detail; this file links to them instead of repeating them. Older point-in-time reports live in [`history/`](history/README.md).

Captured **2026-11-03 07:30 IST**, after `git fetch --all --prune`, from `git`, `gh` and Vercel deployment metadata. Every SHA, PR, run and build-log line below was read in that session. Anything not verified says so.

---

## 1. Branch model

| Branch | Role | Rule |
|---|---|---|
| `main` | **Production.** Vercel deploys it to the Production target. | Changes only through an owner-approved PR (today: PR #17). No direct pushes. |
| `launch-mvp` | **Integration.** Every milestone merges here first. Its pushes build a Vercel **Preview** against the isolated Preview DB. | Changes only through PRs with green CI (`lint, unit, e2e`). |
| `feature/*`, `fix/*` | Short-lived work branches, cut from fresh `origin/launch-mvp`. | One per milestone or fix (`feature/m<N>-<scope>`). Archive after merge. |

Repository: `Jakuraa/StrangersMeetup`. Vercel project: `strangersmeetup` (the technical names stay; see the brand rules in M7).

## 2. Current refs

| Ref | SHA | What it is |
|---|---|---|
| `origin/main` | `5c6652a` | Merge of PR #2 (2026-10-29). **Contains nothing that `launch-mvp` lacks**: both parents (`b13d927`, `7bc062b`) are ancestors of `launch-mvp`. 78 commits behind `launch-mvp`. |
| `origin/launch-mvp` | `c71ec8d` | Merge of PR #29 (M4.2 UPI Security Audit). Baseline for M4.3. |
| `origin/feature/p3-location-intelligence` | `d7836ff` | PR #23 feature branch head; merged into `launch-mvp` at `7c5079e`. |
| `origin/fix/preview-recovery-audit` | `bcb4989` | Commit holding Phase 5.6/5.7 reports; pushed to origin per owner decision. |

Local `main` in the main clone is at `5693f7b`, an older Production commit that is behind `origin/main`. It is not checked out anywhere. Local `launch-mvp` matches `origin/launch-mvp` @ `c71ec8d`.

## 3. Open pull requests and CI

| PR | Base ← Head | Head SHA | Checks on head | Latest CI run |
|---|---|---|---|---|
| #17 Production release: free-only MVP | `main` ← `launch-mvp` | `83a30a7` | `lint, unit, e2e` ✅ (push + PR) · Vercel ✅ · Vercel Preview Comments ✅ | [41564501659](https://github.com/Jakuraa/StrangersMeetup/actions/runs/41564501659) (push) success |
| #30 M4.3 UPI Security Remediation | `launch-mvp` ← `feature/m4-3-upi-security-remediation` | `e4babe6` | `lint, unit, e2e` ✅ | PR Review Baseline for M4.3.1 |
| #31 M4.3.1 Review Remediation | `feature/m4-3-upi-security-remediation` ← `feature/m4-3-1-review-remediation` | `03bf518` | `lint, unit, e2e` ✅ | Independent Review Corrections for PR #30 |
| (Remediation) M4.3.2 Financial Integrity Remediation | `feature/m4-3-1-review-remediation` ← `feature/m4-3-2-financial-integrity` | (work branch) | `lint, unit, e2e` ✅ | Fail-Closed Merchant Identity, Secure Manual Reconciliation & State Transition Verification |

**Owner gate:** PR #17 must not be merged without the owner's separate approval. `main` has no GitHub Actions runs on record. PR #30, PR #31, and PR #17 must not be merged automatically without owner review. Keep `ENABLE_LIVE_PAYMENTS=false` everywhere.

PR #23 is **merged** at `7c5079e` (P3 Location Intelligence + M2 Remediation).
PR #25 is **merged** at `83a30a7` (Owner Addendum Ops: dynamic DB block list, branch archiving, Phase 5.6/5.7 reports).
PR #26 is **merged** at `46b85c1` (M3 Deployment & Database Migration Architecture).
PR #27 is **merged** at `69cafae` (M4 Payment, Booking and Revenue Readiness Audit).
PR #28 is **merged** at `c3b4e83` (M4.1 UPI-First Checkout, Dynamic QR & Verified Payment Integration).
PR #29 is **merged** at `c71ec8d` (M4.2 Independent UPI Payment Security & Production Readiness Audit).
PR #30 is **open / preserved** (`feature/m4-3-upi-security-remediation`).
PR #31 is **open / preserved** (`feature/m4-3-1-review-remediation`).

## 4. Migrations per environment

`npm run vercel-build` runs `scripts/migrate.js` on every Vercel build. `migrationPolicy()` (`lib/db.js:87`) only allows Preview builds to migrate when `MIGRATE_ON_PREVIEW=true` **and** the build is isolated (`ISOLATED_PREVIEW_DB=true` or `PREVIEW_DATABASE_URL` set). `migrate()` records applied files **by filename only** in `schema_migrations`, with no checksum, so an edited migration file is never re-applied.

| Environment | DB endpoint | Applied | Evidence |
|---|---|---|---|
| **Local / CI** | ephemeral Postgres | whatever the checked-out tree has (`003`…`017` on `feature/m4-3-1-review-remediation`) | CI service container; fresh each run. |
| **Preview** (isolated) | `ep-green-hall-b47clnq0` (from earlier docs; the connection string was not read) | **`003` … `014`** (applied) | Applied via PR #23 push @ `d7836ff` (`dpl_AbjNDha7i298qjrh84FZZA3hHUQv`): `migration applied {"file":"014_location_remediation.sql"}`. |
| **Production** | `ep-dawn-glitter-b4mkwxkl` (from earlier docs; not re-verified) | **`003` … `009`** per its last build | Build log for `main` @ `5c6652a` (`dpl_3g7aUM3V…`, 2026-10-29): `[migrate] done (0 applied; vercel production)`; that tree holds `003`–`009`. |

> ℹ️ **Preview DB migrations.** Both `013_location_intelligence.sql` and `014_location_remediation.sql` are applied on the Preview database. `013` was preserved strictly unchanged; all fixes were applied via `014`.

> ⚠️ **Unreconciled — Production DB contents (Owner Gate 3).** See [PRODUCTION_DATABASE_VERIFICATION.md](launch/PRODUCTION_DATABASE_VERIFICATION.md) for full forensics. On 2026-10-29, build `dpl_3g7a...` applied migrations 003–009 to the configured database. The owner will provide the confirmed Production project ID and endpoint ID from Vercel → Storage before release. Until then, `ep-dawn-glitter-b4mkwxkl` is treated as unconfirmed/suspected. The codebase implements a dynamic production endpoint block list (via `DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS` and `BLOCKED_PRODUCTION_ENDPOINTS` in `lib/config.js`), strictly refusing all listed endpoints across preview reviewer sign-in, seed/reset guards, preview writes, and preview migrations, verified by automated tests in `test/safety.test.js` and `test/migrations.test.js`.

## 5. What is live vs Preview-only

| Surface | Code | Status |
|---|---|---|
| **Production** (Vercel Production target) | `main` @ `5c6652a`: Postgres backend, Telegram auth/bot, sandbox payments, admin (PR #2) | Live, READY since 2026-10-29. It is still branded StrangersMeetup and lacks the 74 commits on `launch-mvp`. Production env is missing most required variables (§7). |
| **Preview, `launch-mvp`** | `83a30a7`: everything in Production plus the organiser wizard, SuperProfile checkout (gated off by `ENABLE_LIVE_PAYMENTS`), trust & safety, the NIGHTLIFEZ rebrand (PR #19), P0 ground truth (PR #20), P2 identities/orgs/`can()` (PR #21), wizard e2e fix (PR #22), P3 Location Intelligence + Remediation (PR #23), and Owner Addendum Ops (PR #25) | Preview-only, READY (`dpl_5bwWwcYWVx5cwcxXZNFZt2fhA73C`). Protected by Vercel deployment protection (SSO). |

## 6. Workspaces (worktrees)

`git worktree list`:

| Path | Branch @ SHA | Untracked | Role |
|---|---|---|---|
| `/Users/pradeepjakuraa/strangersmeetup` | `feature/m4-payment-booking-audit` | none | **Canonical workspace** (main clone; holds the `.vercel` project link and local env). Cut from `launch-mvp` @ `46b85c1`. |
| `/Users/pradeepjakuraa/nightlifez-work` | `feature/m1-project-state` | none | Secondary worktree. Free when milestone finishes. |
| `/Users/pradeepjakuraa/strangersmeetup/.claude/worktrees/launch-mvp` | `worktree-launch-mvp` @ `7db45a5` | `.playwright-mcp/` | **Stale worktree.** Preserved as is per owner addendum instruction. |

Stashes: `git stash list` is empty.

Rule: only the canonical workspace switches to `launch-mvp`. Milestone branches get their own worktree, and agents never edit a worktree another session is using.

## 7. Owner gates outstanding

| # | Gate | Status |
|---|---|---|
| 1 | Approve merging PR #17 (`launch-mvp` → `main`) and the Production release | open |
| 2 | Production env vars. Missing as of P0 (2026-11-02, names only): `SESSION_SECRET`, `CRON_SECRET`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TG_CHAT_ID_EVENTS`, `ADMIN_BOOTSTRAP_TELEGRAM_ID`, `PUBLIC_SITE_URL`, `SUPPORT_EMAIL`, `LEGAL_ENTITY_NAME`, `GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_EMAIL` (`ENABLE_LIVE_PAYMENTS` unset = off) | open, not re-checked in M1 |
| 3 | Reconcile which DB Production points at (§4) | open (owner will supply confirmed project ID & endpoint ID from Vercel → Storage; dynamic block list active) |
| 4 | Domain/DNS for `nightlifez.com` (Cloudflare, Vercel) | open (M8 prepares the steps) |
| 5 | BotFather `/setdomain` and profile; Telegram groups and channel | open (M5 prepares the steps) |
| 6 | Vercel Protection Bypass for Automation | open (M9) |
| 7 | Email routing `contact@nightlifez.com` | open (M8) |
| 8 | Legal fields (entity, grievance officer) | open |
| 9 | Approve the branch/worktree deletions proposed in §9 | **completed / approved** (19 fully merged remote branches archived to `archive/<branch>` tags and deleted from origin; `.claude/worktrees/launch-mvp` preserved as is) |
| 10 | Decide on the unpushed Phase 5.6/5.7 reports (local commit `bcb4989`): push and archive, or drop | **completed / approved** (`bcb4989` pushed to `origin/fix/preview-recovery-audit`; reports imported into `docs/history/`) |

## 8. Branch classification

Unique = commits in the branch but not in the reference (`git rev-list --count ref..branch`). Behind = `git rev-list --count branch..origin/launch-mvp`.

| Remote branch | Last commit | Unique vs `launch-mvp` | Unique vs `main` | Behind `launch-mvp` | Class |
|---|---|---|---|---|---|
| `main` | `5c6652a` 2026-10-29 | 1 (merge commit, no content) | — | 73 | keep (production) |
| `launch-mvp` | `7c5079e` 2026-11-03 | — | 73 | — | keep (integration baseline) |
| `feature/p3-location-intelligence` | `d7836ff` 2026-11-03 | 0 | 73 | 1 | merged (PR #23 @ `7c5079e`) |
| `fix/preview-recovery-audit` | `bcb4989` 2026-11-02 | 1 | 48 | 26 | docs remainder (pushed; reports imported into `docs/history/`) |

19 fully merged remote branches were archived and deleted in accordance with approved Owner Gate 9 (see §9).

Local-only state (main clone):

| Local branch | State | Note |
|---|---|---|
| `fix/preview-recovery-audit` | equals remote `bcb4989` | pushed to origin per owner decision (gate 10) |
| `feature/m2-responsive-admin` | 1 ahead of its old remote (`e82cac9`) | patch-identical to `f4bbc2b` already on `launch-mvp` |
| `sprint/mvp-launch-ux` | no upstream; tip is an ancestor of `launch-mvp` | merged |
| `worktree-launch-mvp` | tracks `origin/launch-mvp`, tip is an ancestor | stale worktree branch; preserved with `.claude/worktrees/launch-mvp` |
| `launch-mvp` | equals `origin/launch-mvp` @ `7c5079e` | canonical workspace branch |
| `main` | `5693f7b`, behind `origin/main` | fast-forward when next on it |

## 9. Branch archive and deletion (Owner Gate 9 executed)

Per owner approval on 2026-11-03, each of the 19 fully merged remote branches was tagged at its head with `archive/<branch>`, the tag was pushed to `origin`, and the remote branch was subsequently deleted from `origin`.

### Created archive tags (19 total):
1. `archive/feature/attendee-discovery-booking`
2. `archive/feature/cloud-deployment-prep`
3. `archive/feature/complete-marketplace-journey`
4. `archive/feature/gate-paid-checkout-live-payments`
5. `archive/feature/m2-responsive-admin`
6. `archive/feature/m8-personas-e2e`
7. `archive/feature/nightlifez-rebrand`
8. `archive/feature/organiser-onboarding-wizard`
9. `archive/feature/organiser-wizard`
10. `archive/feature/p0-ground-truth`
11. `archive/feature/p2-identity-orgs`
12. `archive/feature/platform-v2`
13. `archive/feature/superprofile-checkout`
14. `archive/feature/trust-safety-remediation`
15. `archive/feature/website-ux-enhancements`
16. `archive/fix/cloud-deployment-pr9-blockers`
17. `archive/fix/p2-wizard-e2e-flake`
18. `archive/fix/render-docker-alignment`
19. `archive/vercel/install-vercel-web-analytics-7s18we`

**Preserved per boundaries:**
- `feature/p3-location-intelligence` (PR #23 branch) — preserved, not deleted.
- `fix/preview-recovery-audit` — preserved, holding commit `bcb4989`.
- Worktree `.claude/worktrees/launch-mvp` and its untracked `.playwright-mcp/` contents — preserved as is.

## 10. Milestone tracker

| Milestone | Branch / PR | Status |
|---|---|---|
| M1 Repository truth | `feature/m1-project-state` / #24 | **Merged** @ `cd40fcf` into `launch-mvp` |
| M2 P3 remediation | `feature/p3-location-intelligence` / #23 | **Merged** @ `7c5079e` into `launch-mvp` (H-01, H-02, M-01, M-02, L-01, L-02 resolved, Migration 014 applied on Preview `dpl_AbjNDha7i298qjrh84FZZA3hHUQv`, 100% CI pass) |
| Owner Addendum | `feature/m2-addendum-ops` / #25 | **Merged** @ `83a30a7` into `launch-mvp` (Dynamic production DB block list + safety tests; 19 merged branches archived and deleted; `bcb4989` pushed and Phase 5.6/5.7 reports imported into `docs/history/`) |
| M3 Deployment & DB Migration | `feature/m3-deployment-migration` / #26 | **Merged** @ `46b85c1` into `launch-mvp` (Deployment architecture, DB migration policy, forensic production verification, environment inventory, migration test suite `test/migrations.test.js`) |
| M4 Payment & Booking Readiness | `feature/m4-payment-booking-audit` / #27 | **Merged** @ `69cafae` into `launch-mvp` (Booking & payment architecture, payment readiness & financial safety report, booking integrity test report, 10/10 automated tests in `test/booking-integrity.test.js`) |
| M4.1 UPI-First Checkout & Dynamic QR | `feature/m4-1-upi-checkout` / #28 | **Merged** @ `c3b4e83` into `launch-mvp` (UPI-First checkout, pure SVG dynamic QR, provider-neutral adapter with PhonePe PG primary, mobile intent links, SHA256 constant-time webhook verification, migration 015, 13/13 automated tests in `test/upi-checkout.test.js`) |
| M4.2 UPI Security & Readiness Audit | `feature/m4-2-upi-security-audit` / #29 | **Merged** @ `c71ec8d` into `launch-mvp` (Independent audit of M4.1 UPI checkout: identified 2 Critical and 3 High severity defects; verdict: NOT READY FOR LIVE PAYMENTS; `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M4.3 Critical UPI Security & Financial Integrity Remediation | `feature/m4-3-upi-security-remediation` | **Completed** (Resolved all 9 M4.2 findings: SEC-01 Base64 webhook signature, FIN-01 underpayment defense & dispute audit, DATA-01 auth gate & guest booking claim API, CONCUR-01 active intent capacity holds & confirmation check, AUTH-01 status polling IDOR fix, QR-01 Dark Module & multi-block interleaving fix, UI-01 responsive viewport CSS isolation, LOG-01 dedicated rate limits, DB-01 immutable `payment_audits` trigger via migration 016; 21/21 tests in `test/upi-checkout.test.js` pass, 7/7 in `test/migrations.test.js` pass, full test suite 453/453 pass; `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M5–M10 | — | not started |

## 11. Where the detail lives

| Topic | Doc |
|---|---|
| UPI security audit | [UPI_SECURITY_AUDIT.md](UPI_SECURITY_AUDIT.md) |
| UPI provider readiness assessment | [UPI_PROVIDER_READINESS.md](UPI_PROVIDER_READINESS.md) |
| UPI-first checkout architecture | [arch/UPI_PAYMENT_INTEGRATION.md](arch/UPI_PAYMENT_INTEGRATION.md) |
| UPI operational readiness report | [launch/UPI_READINESS_REPORT.md](launch/UPI_READINESS_REPORT.md) |
| Booking and payment architecture | [arch/BOOKING_AND_PAYMENT_ARCHITECTURE.md](arch/BOOKING_AND_PAYMENT_ARCHITECTURE.md) |
| Payment readiness & financial safety | [launch/PAYMENT_READINESS.md](launch/PAYMENT_READINESS.md) |
| Booking integrity test report | [launch/BOOKING_INTEGRITY_TEST_REPORT.md](launch/BOOKING_INTEGRITY_TEST_REPORT.md) |
| Deployment architecture | [arch/DEPLOYMENT_ARCHITECTURE.md](arch/DEPLOYMENT_ARCHITECTURE.md) |
| Database migration policy | [arch/DATABASE_MIGRATION_POLICY.md](arch/DATABASE_MIGRATION_POLICY.md) |
| Environment readiness & secrets inventory | [launch/ENVIRONMENT_READINESS.md](launch/ENVIRONMENT_READINESS.md) |
| Production database verification & forensics | [launch/PRODUCTION_DATABASE_VERIFICATION.md](launch/PRODUCTION_DATABASE_VERIFICATION.md) |
| Architecture overview | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Product spec | [SPEC.md](SPEC.md) |
| Geographic coverage & LGD directory | [GEOGRAPHIC_COVERAGE.md](GEOGRAPHIC_COVERAGE.md) |
| Routes and roles | [ROUTES_AND_ROLES.md](ROUTES_AND_ROLES.md) |
| Implementation plan | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| Test strategy / local testing | [TEST_STRATEGY.md](TEST_STRATEGY.md) · [LOCAL_TESTING.md](LOCAL_TESTING.md) |
| Operations runbook | [RUNBOOK.md](RUNBOOK.md) · [FIRST_EVENT_RUNBOOK.md](FIRST_EVENT_RUNBOOK.md) |
| Go-live checklist | [GO_LIVE.md](GO_LIVE.md) |
| Payments decision / SuperProfile ops | [PAYMENTS_DECISION.md](PAYMENTS_DECISION.md) · [SUPERPROFILE_OPS.md](SUPERPROFILE_OPS.md) |
| Telegram setup | [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md) |
| Organiser wizard | [ORGANISER_WIZARD.md](ORGANISER_WIZARD.md) |
| Membership and discovery | [MEMBERSHIP_DISCOVERY.md](MEMBERSHIP_DISCOVERY.md) |
| Audits | [AUDIT.md](AUDIT.md) · [PLATFORM_AUDIT.md](PLATFORM_AUDIT.md) · [PREVIEW_RECOVERY_AUDIT.md](PREVIEW_RECOVERY_AUDIT.md) · [UI_UX_AUDIT.md](UI_UX_AUDIT.md) |
| P0 ground truth (2026-11-02 snapshot) | [launch/P0_STATE.md](launch/P0_STATE.md) |
| Phase reports 4A–6A.2 | [history/](history/README.md) |
