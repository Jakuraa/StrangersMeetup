# NIGHTLIFEZ — Project state

**Single source of truth for where the code, environments and gates stand.** Each milestone PR updates this file. Other docs hold design and how-to detail; this file links to them instead of repeating them. Older point-in-time reports live in [`history/`](history/README.md).

Captured **2026-11-03 03:30 IST**, after `git fetch --all --prune`, from `git`, `gh` and Vercel deployment metadata. Every SHA, PR, run and build-log line below was read in that session. Anything not verified says so.

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
| `origin/main` | `5c6652a` | Merge of PR #2 (2026-10-29). **Contains nothing that `launch-mvp` lacks**: both parents (`b13d927`, `7bc062b`) are ancestors of `launch-mvp`. 57 commits behind `launch-mvp`. |
| `origin/launch-mvp` | `9d48147` | Merge of PR #22 (`fix/p2-wizard-e2e-flake`). Baseline for M1; the M1 merge moves it forward. |
| `origin/feature/p3-location-intelligence` | `15b923d` | PR #23 head; 1 commit ahead of `launch-mvp`, 0 behind. |

Local `main` in the main clone is at `5693f7b`, an older Production commit that is behind `origin/main`. It is not checked out anywhere. Local `launch-mvp` matches `origin/launch-mvp` but has **no upstream set**.

## 3. Open pull requests and CI

| PR | Base ← Head | Head SHA | Checks on head | Latest CI run |
|---|---|---|---|---|
| #23 feat(location): P3 Location Intelligence V1 | `launch-mvp` ← `feature/p3-location-intelligence` | `15b923d` | `lint, unit, e2e` ✅ · Vercel ✅ · Vercel Preview Comments ✅ | [41414881620](https://github.com/Jakuraa/StrangersMeetup/actions/runs/41414881620) success |
| #17 Production release: free-only MVP | `main` ← `launch-mvp` | `9d48147` | `lint, unit, e2e` ✅ (push + PR) · Vercel ✅ · Vercel Preview Comments ✅ | [41396124504](https://github.com/Jakuraa/StrangersMeetup/actions/runs/41396124504) (push) and [41396130033](https://github.com/Jakuraa/StrangersMeetup/actions/runs/41396130033) (PR), both success |

**Owner gate:** PR #17 must not be merged without the owner's separate approval. `main` has no GitHub Actions runs on record.

PR #23 is **not merge-ready**, even though CI is green. It carries the H-01/H-02/M-01/M-02 findings that M2 resolves.

## 4. Migrations per environment

`npm run vercel-build` runs `scripts/migrate.js` on every Vercel build. `migrationPolicy()` (`lib/db.js:87`) only allows Preview builds to migrate when `MIGRATE_ON_PREVIEW=true` **and** the build is isolated (`ISOLATED_PREVIEW_DB=true` or `PREVIEW_DATABASE_URL` set). `migrate()` records applied files **by filename only** in `schema_migrations`, with no checksum, so an edited migration file is never re-applied.

| Environment | DB endpoint | Applied | Evidence |
|---|---|---|---|
| **Local / CI** | ephemeral Postgres | whatever the checked-out tree has (`003`…`014` on `feature/p3-location-intelligence`) | CI service container; fresh each run. |
| **Preview** (isolated) | `ep-green-hall-b47clnq0` (from earlier docs; the connection string was not read) | **`003` … `013`** (applied); **`014`** (queued for application on PR #23 push) | Build log for PR #23 @ `15b923d` (`dpl_6KeQv9mx…`, 2026-11-02 08:41 UTC): `migration applied {"file":"013_location_intelligence.sql"}`. M2 remediation adds `014_location_remediation.sql` preserving 013 unchanged. |
| **Production** | `ep-dawn-glitter-b4mkwxkl` (from earlier docs; not re-verified) | **`003` … `009`** per its last build | Build log for `main` @ `5c6652a` (`dpl_3g7aUM3V…`, 2026-10-29): `[migrate] done (0 applied; vercel production)`; that tree holds `003`–`009`. |

> ⚠️ **Preview DB is ahead of `launch-mvp`.** It already has `013` from the initial PR #23 push, because all Preview branches share one isolated Preview DB.
> - In strict compliance with safeguards, M2 **did not edit `013_location_intelligence.sql`**. All remediation schema changes are housed in `014_location_remediation.sql`.
> - Any future PR's migration lands on Preview at its first push, before review. Prefer to push migration PRs only when they are ready.

> ⚠️ **Unreconciled — Production DB contents.** [Phase 5.4](history/phase-5-4-pr18-merge-release-candidate-sync.md) says the Production endpoint `ep-dawn-glitter-b4mkwxkl` had **0 user tables**. The 2026-10-29 Production build log says migrations had nothing pending. Both statements cannot hold for the same database. The likeliest explanation is that the Production `DATABASE_URL` was changed after 2026-10-29, but nobody has verified that. Before any Production release, the owner (or an approved read-only check) must confirm which database Production points at and its `schema_migrations` rows.

## 5. What is live vs Preview-only

| Surface | Code | Status |
|---|---|---|
| **Production** (Vercel Production target) | `main` @ `5c6652a`: Postgres backend, Telegram auth/bot, sandbox payments, admin (PR #2) | Live, READY since 2026-10-29. It is still branded StrangersMeetup and lacks the 57 commits below. Production env is missing most required variables (§7). |
| **Preview, `launch-mvp`** | `9d48147`: everything in Production plus the organiser wizard, SuperProfile checkout (gated off by `ENABLE_LIVE_PAYMENTS`), trust & safety, the NIGHTLIFEZ rebrand (PR #19), P0 ground truth (PR #20), P2 identities/orgs/`can()` (PR #21), the wizard e2e fix (PR #22) | Preview-only, READY (`dpl_86inZXG2…`). Behind Vercel deployment protection. |
| **Preview, PR #23** | `15b923d`: P3 location intelligence | Preview-only, READY (`dpl_6KeQv9mx…`). Under remediation in M2. |

Observations for M3 (not acted on in M1):
- `scripts/vercel-ignore.js` logs "Production deployment on 'launch-mvp'" for `launch-mvp` Preview builds, because it treats the branch name as production when deciding whether to build. Isolation still holds, since migration is gated separately by `migrationPolicy()`, but the label is misleading.
- PR #23's Preview build restored its **build cache** from the Production deployment `dpl_3g7aUM3V…`. That cache holds dependencies, not data, and the build migrated against the isolated Preview DB as logged. Recorded as a note, not as a Production touch.

## 6. Workspaces (worktrees)

`git worktree list` (all three paths exist; no two share a branch; no detached HEADs):

| Path | Branch @ SHA | Untracked | Role |
|---|---|---|---|
| `/Users/pradeepjakuraa/strangersmeetup` | `feature/p3-location-intelligence` @ `15b923d` | none | **Canonical workspace** (main clone; holds the `.vercel` project link and local env). It sits on PR #23's branch for M2 and returns to `launch-mvp` between milestones. |
| `/Users/pradeepjakuraa/nightlifez-work` | `feature/m1-project-state` (this PR) | none | Secondary worktree for isolated agent work. Use one per active milestone branch, then free it. |
| `/Users/pradeepjakuraa/strangersmeetup/.claude/worktrees/launch-mvp` | `worktree-launch-mvp` @ `7db45a5` | `.playwright-mcp/` | **Stale.** Its branch is 74 commits behind `origin/launch-mvp` (its tip is an ancestor, with no unique commits). Removal needs the owner's approval (it holds an untracked folder; it also lives under `.claude/`). |

Stashes: `git stash list` is empty.

Rule: only the canonical workspace switches to `launch-mvp`. Milestone branches get their own worktree, and agents never edit a worktree another session is using.

## 7. Owner gates outstanding

| # | Gate | Status |
|---|---|---|
| 1 | Approve merging PR #17 (`launch-mvp` → `main`) and the Production release | open |
| 2 | Production env vars. Missing as of P0 (2026-11-02, names only): `SESSION_SECRET`, `CRON_SECRET`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TG_CHAT_ID_EVENTS`, `ADMIN_BOOTSTRAP_TELEGRAM_ID`, `PUBLIC_SITE_URL`, `SUPPORT_EMAIL`, `LEGAL_ENTITY_NAME`, `GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_EMAIL` (`ENABLE_LIVE_PAYMENTS` unset = off) | open, not re-checked in M1 |
| 3 | Reconcile which DB Production points at (§4) | open |
| 4 | Domain/DNS for `nightlifez.com` (Cloudflare, Vercel) | open (M8 prepares the steps) |
| 5 | BotFather `/setdomain` and profile; Telegram groups and channel | open (M5 prepares the steps) |
| 6 | Vercel Protection Bypass for Automation | open (M9) |
| 7 | Email routing `contact@nightlifez.com` | open (M8) |
| 8 | Legal fields (entity, grievance officer) | open |
| 9 | Approve the branch/worktree deletions proposed in §9 | open |
| 10 | Decide on the unpushed Phase 5.6/5.7 reports (local commit `bcb4989`): push and archive, or drop | open |

## 8. Branch classification

Unique = commits in the branch but not in the reference (`git rev-list --count ref..branch`). Behind = `git rev-list --count branch..origin/launch-mvp`.

| Remote branch | Last commit | Unique vs `launch-mvp` | Unique vs `main` | Behind `launch-mvp` | Class |
|---|---|---|---|---|---|
| `main` | `5c6652a` 2026-10-29 | 1 (merge commit, no content) | — | 57 | keep (production) |
| `launch-mvp` | `9d48147` 2026-11-02 | — | 57 | — | keep (integration) |
| `feature/p3-location-intelligence` | `15b923d` 2026-11-02 | 1 | 58 | 0 | **unique code**, PR #23 (M2) |
| `fix/preview-recovery-audit` | `303dcab` 2026-11-02 | 2 | 48 | 11 | **docs-only remainder**, now archived in `docs/history/` by this PR |
| `feature/attendee-discovery-booking` | `14ebace` 2026-10-31 | 0 | 25 | 32 | merged |
| `feature/cloud-deployment-prep` | `607d708` 2026-10-30 | 0 | 17 | 40 | merged |
| `feature/complete-marketplace-journey` | `6ad0da0` 2026-11-01 | 0 | 32 | 25 | merged |
| `feature/gate-paid-checkout-live-payments` | `db1f25c` 2026-11-01 | 0 | 42 | 15 | merged |
| `feature/m2-responsive-admin` | `09c2a96` 2026-10-29 | 0 | 0 | 58 | merged (also in `main`) |
| `feature/m8-personas-e2e` | `cfa9536` 2026-10-29 | 0 | 0 | 64 | merged (also in `main`) |
| `feature/nightlifez-rebrand` | `c8d4d85` 2026-11-02 | 0 | 50 | 7 | merged (PR #19) |
| `feature/organiser-onboarding-wizard` | `f77e437` 2026-10-31 | 0 | 29 | 28 | merged |
| `feature/organiser-wizard` | `b3a1d37` 2026-10-28 | 0 | 0 | 73 | merged (also in `main`) |
| `feature/p0-ground-truth` | `070a7a8` 2026-11-02 | 0 | 49 | 8 | merged (PR #20) |
| `feature/p2-identity-orgs` | `7198f53` 2026-11-02 | 0 | 54 | 3 | merged (PR #21) |
| `feature/platform-v2` | `50113e5` 2026-10-29 | 0 | 0 | 67 | merged (also in `main`) |
| `feature/superprofile-checkout` | `64cfe6f` 2026-10-29 | 0 | 5 | 52 | merged |
| `feature/trust-safety-remediation` | `b4f7f73` 2026-11-01 | 0 | 34 | 23 | merged |
| `feature/website-ux-enhancements` | `27597aa` 2026-10-31 | 0 | 22 | 35 | merged |
| `fix/cloud-deployment-pr9-blockers` | `fb28579` 2026-10-30 | 0 | 16 | 41 | merged |
| `fix/p2-wizard-e2e-flake` | `2a0e9ce` 2026-11-02 | 0 | 56 | 1 | merged (PR #22) |
| `fix/render-docker-alignment` | `a6d6159` 2026-10-30 | 0 | 19 | 38 | merged |
| `vercel/install-vercel-web-analytics-7s18we` | `a7dbe24` 2026-10-25 | 0 | 0 | 91 | merged (also in `main`), stale bot branch |

Local-only state (main clone):

| Local branch | State | Note |
|---|---|---|
| `fix/preview-recovery-audit` | 1 ahead of its remote (`bcb4989`, Phase 5.6/5.7 reports, **never pushed**) | owner decision (gate 10) |
| `feature/m2-responsive-admin` | 1 ahead of its remote (`e82cac9`) | patch-identical to `f4bbc2b` already on `launch-mvp` (`git cherry` reports `-`) |
| `fix/render-docker-alignment` | upstream mis-set to `origin/fix/preview-recovery-audit` | same SHA as `origin/fix/render-docker-alignment` (0/0) |
| `sprint/mvp-launch-ux` | no upstream; tip is an ancestor of `launch-mvp` | merged |
| `worktree-launch-mvp` | tracks `origin/launch-mvp`, 74 behind, tip is an ancestor | stale worktree branch (§6) |
| `launch-mvp` | equals `origin/launch-mvp`, no upstream set | fix with `git branch -u origin/launch-mvp launch-mvp` |
| `main` | `5693f7b`, behind `origin/main` | fast-forward when next on it |

## 9. Deletion proposal (nothing deleted — owner approval required)

Proof for "merged" = `git rev-list --count origin/launch-mvp..<branch>` returned `0` on 2026-11-03, i.e. the tip is an ancestor of `launch-mvp`.

| Branch | Reason | Proof |
|---|---|---|
| `origin/feature/attendee-discovery-booking` | merged | 0 unique vs `launch-mvp` |
| `origin/feature/cloud-deployment-prep` | merged | 0 unique |
| `origin/feature/complete-marketplace-journey` | merged | 0 unique |
| `origin/feature/gate-paid-checkout-live-payments` | merged | 0 unique |
| `origin/feature/m2-responsive-admin` | merged into `launch-mvp` and `main` | 0 unique vs both |
| `origin/feature/m8-personas-e2e` | merged into both | 0 unique vs both |
| `origin/feature/nightlifez-rebrand` | merged (PR #19) | 0 unique |
| `origin/feature/organiser-onboarding-wizard` | merged | 0 unique |
| `origin/feature/organiser-wizard` | merged into both | 0 unique vs both |
| `origin/feature/p0-ground-truth` | merged (PR #20) | 0 unique |
| `origin/feature/p2-identity-orgs` | merged (PR #21) | 0 unique |
| `origin/feature/platform-v2` | merged into both | 0 unique vs both |
| `origin/feature/superprofile-checkout` | merged | 0 unique |
| `origin/feature/trust-safety-remediation` | merged | 0 unique |
| `origin/feature/website-ux-enhancements` | merged | 0 unique |
| `origin/fix/cloud-deployment-pr9-blockers` | merged | 0 unique |
| `origin/fix/p2-wizard-e2e-flake` | merged (PR #22) | 0 unique |
| `origin/fix/render-docker-alignment` | merged | 0 unique |
| `origin/vercel/install-vercel-web-analytics-7s18we` | merged into both; stale bot branch | 0 unique vs both |
| `origin/fix/preview-recovery-audit` | its 2 unique commits are docs only, and **after this PR merges** they are in `launch-mvp` by content | `docs/history/phase-5-4…` and `phase-5-5…` have blob SHAs `05d545c` and `9cb973f`, identical to the branch's `docs/launch/` blobs. **Delete only after gate 10**, because the local branch also holds unpushed `bcb4989`. |
| local `feature/*`, `fix/*` counterparts of the above | merged | same as remote; local `feature/m2-responsive-admin`'s extra commit is patch-identical to `f4bbc2b` |
| local `sprint/mvp-launch-ux` | merged, no remote | `git merge-base --is-ancestor sprint/mvp-launch-ux origin/launch-mvp` → true |
| worktree `.claude/worktrees/launch-mvp` + branch `worktree-launch-mvp` | stale, 74 behind | tip is an ancestor of `launch-mvp`; **untracked `.playwright-mcp/` would be lost**, so check it first |

Keep: `main`, `launch-mvp`, `feature/p3-location-intelligence` (PR #23).

## 10. Milestone tracker

| Milestone | Branch / PR | Status |
|---|---|---|
| M1 Repository truth | `feature/m1-project-state` / #24 | **Merged** @ `cd40fcf` into `launch-mvp` |
| M2 P3 remediation | `feature/p3-location-intelligence` / #23 | **Remediated** (H-01, H-02, M-01, M-02, L-01, L-02 resolved, Migration 014 added) |
| M3–M10 | — | not started |

## 11. Where the detail lives

| Topic | Doc |
|---|---|
| Architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
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
