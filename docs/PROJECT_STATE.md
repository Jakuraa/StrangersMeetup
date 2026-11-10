# NIGHTLIFEZ — Project state

**Single source of truth for where the code, environments and gates stand.** Each milestone PR updates this file. Other docs hold design and how-to detail; this file links to them instead of repeating them. Older point-in-time reports live in [`history/`](history/README.md).

Captured **2026-11-10 15:30 IST**, after `git fetch --all --prune`, from `git`, `gh` and Vercel deployment metadata (§2–§4 and §7 refreshed; §5, §6 and §8 are from 2026-11-03 and not re-checked). Every SHA, PR, run and build-log line below was read in that session. Anything not verified says so.

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
| `origin/main` | `5c6652a` | Production. Merge of PR #2 (2026-10-29). Contains nothing that `launch-mvp` lacks. |
| `origin/launch-mvp` | `771f6e1` | Merge of **PR #41**, "Consolidate M4–M10 (supersedes #30–#40)", 2026-11-10. Head of the consolidated stack: `02bfdba`. |
| `archive/feature/m4-3-upi-security-remediation` … `archive/feature/m10-beta-readiness-hardening` | 11 tags | Heads of the superseded PRs #30–#40 (table in §3). Branches deleted after tagging. |

## 3. Pull requests and CI

**Open**

| PR | Base ← Head | Purpose |
|---|---|---|
| #17 Production release | `main` ← `launch-mvp` | Owner gate 1. Must not be merged without the owner's separate approval. |
| #42 | `launch-mvp` ← `fix/s3a-upi-checkout-flag` | S3a: `UPI_CHECKOUT_ENABLED` separate from `ENABLE_LIVE_PAYMENTS` |

**Consolidation (2026-11-10).** PR #41 merged `feature/m10-beta-readiness-hardening` @ `02bfdba` into `launch-mvp` as `771f6e1`. CI run [42791819075](https://github.com/Jakuraa/StrangersMeetup/actions/runs/42791819075) on the exact head:
- lint 153/153;
- `npm test` 695 tests (693 pass, 0 fail, 2 skipped);
- `npm run test:e2e` 182 tests (171 passed, 11 skipped, 0 failed; desktop 66 / mobile 66 / responsive 50).

CI had been red on #37–#40 because one e2e test leaked state between projects; the fix is `02bfdba`.

| Superseded PR | Branch (now tag `archive/<branch>`) | Head | State |
|---|---|---|---|
| #30 | feature/m4-3-upi-security-remediation | `e4babe6` | auto-marked merged by GitHub (head contained in #41) |
| #31 | feature/m4-3-1-review-remediation | `03bf518` | closed, superseded by #41 |
| #32 | feature/m4-3-2-financial-integrity | `62cb0a3` | closed, superseded by #41 |
| #33 | feature/m4-3-3-provider-verification | `4c54711` | closed, superseded by #41 |
| #34 | feature/m4-3-4-contract-decision | `2c930dd` | closed, superseded by #41 |
| #35 | feature/m5-telegram-operational-workflows | `43cf05a` | closed, superseded by #41 |
| #36 | feature/m6-organiser-workspace | `66ad026` | closed, superseded by #41 |
| #37 | feature/m7-attendee-experience | `5453ab1` | closed, superseded by #41 |
| #38 | feature/m8-realtime-notifications | `0b30221` | closed, superseded by #41 |
| #39 | feature/m9-testing-security-review | `b8c82c5` | closed, superseded by #41 |
| #40 | feature/m10-beta-readiness-hardening | `142cc62` (branch reached `02bfdba`) | closed, superseded by #41 |

Earlier merges into `launch-mvp`: #23 `7c5079e`, #25 `83a30a7`, #26 `46b85c1`, #27 `69cafae`, #28 `c3b4e83`, #29 `c71ec8d`.

Keep `ENABLE_LIVE_PAYMENTS=false` and `UPI_CHECKOUT_ENABLED=false` everywhere.

## 4. Migrations per environment

`npm run vercel-build` runs `scripts/migrate.js` on every Vercel build. `migrationPolicy()` (`lib/db.js`) lets Preview builds migrate only when `MIGRATE_ON_PREVIEW=true` **and** isolation is proven. `migrate()` records applied files **by filename only** in `schema_migrations`. The tree on `launch-mvp` holds `003`–`020`; there is no `021`.

| Environment | DB endpoint | Applied | Evidence |
|---|---|---|---|
| **Local / CI** | ephemeral Postgres | `003` … `020` | CI service container; fresh each run. |
| **Preview** (isolated) | `ep-green-hall-b47clnq0` (from earlier docs; the connection string was not read) | **`003` … `020`** | `launch-mvp` @ `771f6e1` build (`dpl_HRrw7oPWNomHhzUuszjpF96RC46s`, 2026-11-10): `[migrate] done (0 applied; vercel preview with MIGRATE_ON_PREVIEW=true and confirmed isolated database)`. That tree holds `003`–`020`, so all of them were already present (applied earlier by the stacked feature-branch Preview builds). |
| **Production** | **unknown**: `ep-dawn-glitter-b4mkwxkl` is unconfirmed (Gate 3) | **believed `003` … `009`** | Build log for `main` @ `5c6652a` (2026-10-29): `[migrate] done (0 applied; vercel production)`; that tree holds `003`–`009`. Not re-verified. The release will apply `010`–`020`: see [PRODUCTION_RELEASE_PACKET.md](launch/PRODUCTION_RELEASE_PACKET.md). |

> ⚠️ **Owner Gate 3 is still open.** See [PRODUCTION_DATABASE_VERIFICATION.md](launch/PRODUCTION_DATABASE_VERIFICATION.md). The block list (`DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS` + `BLOCKED_PRODUCTION_ENDPOINTS` in `lib/config.js`) refuses listed endpoints for preview reviewer sign-in, seed/reset, preview writes and preview migrations.

> ⚠️ **Preview has never authenticated a user.** `SESSION_SECRET` (and the Telegram login vars) are missing on Preview, so every earlier "verified Preview" claim covered unauthenticated pages only. The owner steps are in [PREVIEW_LOGIN.md](launch/PREVIEW_LOGIN.md).

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
| 2 | Production env vars. The full list (names only), including `ENABLE_LIVE_PAYMENTS=false` and `UPI_CHECKOUT_ENABLED=false`, is in [PRODUCTION_RELEASE_PACKET.md](launch/PRODUCTION_RELEASE_PACKET.md) §3 | open, not re-checked since P0 (2026-11-02) |
| 3 | Reconcile which DB Production points at (§4) | open (owner will supply confirmed project ID & endpoint ID from Vercel → Storage; dynamic block list active) |
| 4 | Domain/DNS for `nightlifez.com`: Vercel records **DNS-only (grey cloud)**, `www` → apex redirect in Vercel | open. Runbook corrected 2026-11-10: [DNS_AND_EMAIL_ROUTING.md](launch/DNS_AND_EMAIL_ROUTING.md) §2 |
| 5 | Telegram bots: a **test bot** for Preview (`/setdomain strangersmeetup-git-launch-mvp-jakuraa.vercel.app`) and the production bot (`/setdomain nightlifez.com`); groups and channel | open. Steps: [PREVIEW_LOGIN.md](launch/PREVIEW_LOGIN.md) |
| 6 | Vercel Protection Bypass for Automation | reconciled in M10; pending owner token generation in Vercel and injection into GitHub Secrets (see docs/launch/REMAINING_OWNER_ACTIONS.md) |
| 7 | Email routing `contact@nightlifez.com` (receive/forward only); DMARC starts at `p=none` | open. [DNS_AND_EMAIL_ROUTING.md](launch/DNS_AND_EMAIL_ROUTING.md) §3 |
| 8 | Legal fields (entity, grievance officer) | open |
| 11 | **Preview env vars** so Preview can authenticate: `SESSION_SECRET`, `PREVIEW_TELEGRAM_BOT_TOKEN`, Preview-scoped `TELEGRAM_BOT_USERNAME` / `TELEGRAM_LOGIN_CLIENT_ID` / `TELEGRAM_LOGIN_CLIENT_SECRET`, `PREVIEW_PUBLIC_SITE_URL`, `ADMIN_BOOTSTRAP_TELEGRAM_ID` | open. Blocks the S4 authenticated Preview smoke. [PREVIEW_LOGIN.md](launch/PREVIEW_LOGIN.md) |
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
| M4.3 Critical UPI Security & Financial Integrity Remediation | `feature/m4-3-upi-security-remediation` / #30 | **Completed** (Resolved all 9 M4.2 findings: SEC-01 Base64 webhook signature, FIN-01 underpayment defense & dispute audit, DATA-01 auth gate & guest booking claim API, CONCUR-01 active intent capacity holds & confirmation check, AUTH-01 status polling IDOR fix, QR-01 Dark Module & multi-block interleaving fix, UI-01 responsive viewport CSS isolation, LOG-01 dedicated rate limits, DB-01 immutable `payment_audits` trigger via migration 016; 21/21 tests in `test/upi-checkout.test.js` pass, 7/7 in `test/migrations.test.js` pass, full test suite 453/453 pass; `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M4.3.1 Review Remediation | `feature/m4-3-1-review-remediation` / #31 | **Completed** (Remediated independent review findings REV-01 through REV-07; 31/31 UPI tests pass, 464/464 unit/integration tests pass, `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M4.3.2 Financial Integrity Remediation | `feature/m4-3-2-financial-integrity` / #32 | **Completed** (Strict fail-closed merchant identity comparison across verified, stored, and configured identities; secure manual refund reconciliation with verified admin roles and verifiable external references; 33/33 UPI tests pass, 466/466 unit/integration tests pass, `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M4.3.3 Final Provider Verification Integrity | `feature/m4-3-3-provider-verification` / #33 | **Completed** (Eliminated synthetic currency defaults and configured merchant status check fallbacks; fail-closed currency and merchant identity gating; documented CBS operational limitation and operator attestation labeling; 37/37 UPI tests pass, 470/470 unit/integration tests pass, `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M4.3.4 Provider Contract Decision & M4 Closure | `feature/m4-3-4-contract-decision` | **Formally Closed (Live Payments Disabled)** (Adopted Outcome B: PhonePe v1 classified sandbox-only due to lack of machine-verifiable currency in payload; full 22-vector regression suite added; 38/38 UPI tests pass, 471/471 unit/integration tests pass, 157/157 Playwright E2E pass, 140/140 lint clean; `ENABLE_LIVE_PAYMENTS=false` preserved; all M4 exit criteria verified and passed) |
| M5 Telegram & Operational Workflows | `feature/m5-telegram-operational-workflows` / #35 | **Completed** (Telegram identity & account linking, event private supergroup isolation without shared global group, operational recovery on /start, transactional outbox notifications with quiet hours, /report moderation workflow with emergency escalation; 16/16 tests in test/telegram-workflows.test.js, 487/487 unit/integration tests pass, ENABLE_LIVE_PAYMENTS=false preserved) |
| M6 Organiser Workspace, Event Staff & Secure QR Check-in | `feature/m6-organiser-workspace` / #36 | **Completed** (Full organiser workspace with event dashboard, readiness checklist, ticket inventory, guest management, and operational announcements; event-scoped staff roles with organiser, event_manager, door_staff, guest_list_manager, assistant; server-authoritative HMAC-SHA256 signed QR tickets bound to events without leaking attendee PII; mobile-first door check-in scanner with camera QR detection and manual code lookup; atomic duplicate scan and replay prevention; ticket reissue and revocation lifecycle; 15/15 tests in test/m6-organiser-workspace.test.js, 642/642 tests passing across entire regression suite, 145/145 lint clean; `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M7 Attendee Discovery & Experience Hub | `feature/m7-attendee-experience` / #37 | **Completed** (Personalised attendee discovery feed with transparent, explainable recommendation scoring; location and privacy safeguards with manual city default, explicit device GPS distance bands without venue trilateration, and privacy-preserving mystery venue displays; mobile-first event cards with verified host trust badge, 21+ badge, cancellation and refund policies; multi-facet filtering for category, date range [today, tomorrow, weekend, week, month], price [all, free, paid], and sorting [recommended, trending, date_asc, price_low]; attendee experience hub on /me with booking tabs [all, upcoming, past], saved events / bookmarks lifecycle, and host announcements feed; digital QR pass integration with M6 ticket verification and door check-in status display; 12/12 tests in test/m7-attendee-experience.test.js, 8/8 in test/migrations.test.js, 654/654 tests passing across full regression suite, 16/16 Playwright E2E passing, 149/149 lint clean; `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M8 Real-time Notifications & Operational Comms | `feature/m8-realtime-notifications` / #38 | **Completed** (Attendee self-cancellation with transactional seat hold release, ticket invalidation, invite revocation & confirmation notice; organiser operational announcements broadcast with quiet hours deferral; event staff scoping invariant fix for door_staff discovery; host approval workflow with automated notification; admin notifications outbox API & retry mechanism; interactive leads view; operational runbooks in `docs/launch/DNS_AND_EMAIL_ROUTING.md` resolving blockers #4 and #7; `ENABLE_LIVE_PAYMENTS=false` preserved) |
| M9 Testing & Security Review | `feature/m9-testing-security-review` | **Recommended Next Milestone** |

## 11. Where the detail lives

| Topic | Doc |
|---|---|
| Real-time notifications & operational comms architecture | [arch/REALTIME_NOTIFICATIONS_AND_COMMS.md](arch/REALTIME_NOTIFICATIONS_AND_COMMS.md) |
| DNS & email routing runbook (Blockers #4 & #7) | [launch/DNS_AND_EMAIL_ROUTING.md](launch/DNS_AND_EMAIL_ROUTING.md) |
| Attendee discovery & experience hub architecture | [arch/ATTENDEE_DISCOVERY_AND_EXPERIENCE.md](arch/ATTENDEE_DISCOVERY_AND_EXPERIENCE.md) |
| Organiser workspace & QR check-in architecture | [arch/ORGANISER_WORKSPACE_AND_QR_CHECKIN.md](arch/ORGANISER_WORKSPACE_AND_QR_CHECKIN.md) |
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
