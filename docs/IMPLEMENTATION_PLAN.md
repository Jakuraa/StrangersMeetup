# Implementation plan

Branch: `feature/platform-v2` from `origin/launch-mvp` (`fb73c31`). One PR per milestone into `launch-mvp`
(stacked). Nothing goes to `main` until the owner approves PR #2. Status as of 2026-10-29: **M0 and M1 done**.

```
main (b13d927, PR #1)
 └── launch-mvp (fb73c31, PR #3)  ← PR #2 (draft) into main = production
      └── feature/platform-v2  → PRs per milestone into launch-mvp
```

## Decisions (approved by the owner, 2026-10-28)
1. **Organiser publishing:** an organiser's *first* event goes to admin review; later events publish directly;
   a platform setting can force review for everyone.
2. **Event staff:** assigned per event by the organiser (or `event_manager`/`super_admin`).
3. **Migrations on Vercel:** production builds only; a preview migrates only with `MIGRATE_ON_PREVIEW=true` and its own DB.
4. **Tooling:** Playwright and `@axe-core/playwright` as devDependencies only.

## Standing constraints
No merges, production deploys, DNS changes, env changes on Vercel, or live payments without explicit approval.
SuperProfile is the only checkout; paid tickets are bookable only on events linked to a SuperProfile product. No fabricated data;
demo/seed rows are always marked. Existing tests are never weakened or removed.

---

## M0 — Repository and PR audit ✅
- **Changed:** `docs/PLATFORM_AUDIT.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/ROUTES_AND_ROLES.md`, `docs/TEST_STRATEGY.md`, `.env.example`, `README.md`.
- **Acceptance:** docs match the code with `file:line` evidence; status legend applied. Met.

## M1 — Safety rails ✅
- **Changed:** `lib/db.js` (`migrationPolicy`, `isLocalDatabaseUrl`), `scripts/migrate.js`, `scripts/seed-guard.js`,
  `scripts/seed-demo.js`, `scripts/db-reset-local.js`, `migrations/009_user_sessions.sql`, `lib/session.js`,
  `lib/handlers/auth.js`, `lib/router.js`, `lib/handlers/cron.js`, `public/js/site.js`, `lib/services/bookings.js`,
  `lib/services/insights.js`, `test/safety.test.js`.
- **Migration:** `009` additive (`user_sessions`). Effect: cookies issued before it stop working; everyone signs in once.
- **Risks / rollback:** a preview without `MIGRATE_ON_PREVIEW` now builds against an unmigrated schema if it has a DB
  of its own (intended: set the flag). Rollback = revert the commits; `user_sessions` can stay (unused).
- **Tests:** 13 new (`test/safety.test.js`); the amount and fill tests were confirmed to fail on the old code.
- **Acceptance:** 127/127 tests, lint clean, scripts smoke-tested on a scratch DB. Met.
- **Deferred:** `__path` tightening in `lib/router.js` (needs the function's `req.url` confirmed on a preview).

## M8 (moved forward) — Seed v2 and local personas
- **Files:** `scripts/seed-local.js`, `scripts/seed-guard.js`, `lib/handlers/auth.js` (dev persona login),
  `lib/views/pages.js` (persona picker on `/signin`, local only), `docs/MANUAL_UAT_GUIDE.md`.
- **Data:** synthetic users in a reserved Telegram id range (`9_100_000_000+`), names prefixed "Test", every event
  `is_demo=true`; organisers ×2, admin, staff, guests; draft/published/completed/cancelled events; free and
  disabled-paid tiers; pending approvals; confirmed, cancelled and checked-in bookings; sold-out and low-inventory
  events; analytics rows across 7/30/90-day windows.
- **Guards:** same as the dev login (no Vercel, `DEV_LOGIN=true`, not production) **plus** a local `DATABASE_URL`.
- **Tests:** persona login 404 on Vercel / in production / with a remote DB; seed is idempotent; seed refuses remote.
- **Acceptance:** `npm run seed:local` twice gives the same counts; each persona lands on its dashboard.

## M3 — Authentication and role enforcement
- **Files:** `migrations/010_identities.sql` (`user_identities(provider, subject, user_id)`, `telegram_user_id`
  nullable, backfill Telegram identities), `lib/auth/google.js` (OIDC code flow, PKCE, state, nonce, `iss`/`aud`/`exp`
  checks against Google's JWKS), `lib/handlers/auth.js`, `lib/services/users.js`, settings UI for linked accounts.
- **Rules:** no automatic linking by email; linking only from a signed-in session with fresh re-auth; unlinking the
  last identity is refused; clear "Google sign-in not configured" state when credentials are absent.
- **Risks:** every `telegram_user_id` lookup (admin bootstrap, grants, bot) must tolerate users without Telegram;
  bot DMs only for users with a Telegram identity.
- **Tests:** state/nonce/PKCE tampering, wrong audience, expired token, replay, link hijack attempt, duplicate subject.
- **Blocked on:** Google OAuth client id/secret and registered callbacks.

## M2 — Design system and public experience
- **Files:** `public/css/site.css` (spacing/type tokens, 4 breakpoints, night surface), `public/css/components.css`
  (dialog, toast, badge, state blocks, ticket pass, app shell, stacked tables), `public/js/ui.js` (dialog/toast),
  `lib/views/*`, `public/js/site.js` (nav focus, Escape, link close), image variants (`event_images` thumbnails + `srcset`).
- **Out of scope:** new animation library; changing brand colours.
- **Tests:** E2E overflow check at 320/390/768/1280; axe (no serious/critical); keyboard nav; reduced-motion run.
- **Acceptance:** screenshots reviewed at mobile + desktop; no `confirm()/alert()/prompt()` left in user flows.

## M4 — Guest portal
- **Files:** `lib/views/member.js`, `public/js/member.js`, `lib/services/bookings.js` (cancel; refund-due flag for paid),
  `migrations/011_tickets.sql` (`bookings.ticket_secret`, `checked_in_count`), QR rendering (vendored, MIT, no CDN).
- **Rules:** a cancellation releases the seat in the same transaction; paid cancellations never auto-refund while
  payments are off — they are flagged for finance; ticket token = HMAC(booking id, ticket secret), rotated on cancel.
- **Tests:** cancel own vs other's (404), cancel twice, cancel after check-in refused, QR token tamper, export
  contains only the user's data, deletion anonymises and keeps financial records.
- **Acceptance:** Journey A (`docs/TEST_STRATEGY.md`) passes on mobile and desktop.

## M5 — Organiser workspace
- **Files:** `lib/views/organiser.js` (app shell, overview, event tabs), `public/js/organiser.js`,
  `lib/services/organiser.js` (validated edit of published events, review status), `lib/services/staff.js`,
  `migrations/012_staff_review.sql` (`event_staff`, `events.review_status`, `organiser_first_event_reviewed`),
  scanner page with `BarcodeDetector` + typed-code fallback; `vercel.json` `camera=(self)` on the scan route only.
- **Rules:** edits that change date, venue or tiers after bookings exist require confirmation and notify guests;
  capacity cannot drop below seats taken; first event goes to `pending_review`.
- **Tests:** full cross-organiser denial set, staff scope, duplicate scan 409, wrong-event ticket refused, revoked
  organiser loses access, CSRF on every organiser write.
- **Acceptance:** Journey B passes; scanner usable one-handed at 390 px.

## M6 — Admin console
- **Files:** `lib/views/admin.js`, `public/js/admin.js` (sections, pagination, search, detail drawers),
  `lib/handlers/admin.js` (users, sessions revoke, review queue, health), audit viewer with readable diffs.
- **Tests:** the full role matrix in `docs/ROUTES_AND_ROLES.md` (allowed + denied per row), self-promotion attempts,
  audit entry per sensitive write without secrets or unnecessary personal data.
- **Acceptance:** Journey C passes; every destructive action uses a confirmation dialog naming the target.

## M7 — Analytics and reporting
- **Files:** `lib/services/analytics.js`, `migrations/013_analytics_indexes.sql` (`analytics_events(event_id, name, at)`),
  organiser and admin views, CSV export (organiser: own events, no guest PII beyond what they already see).
- **Definitions (documented in the UI):** views and unique visitors from first-party `analytics_events`
  (cookie-less visitor id); conversion = confirmed bookings ÷ unique event-page visitors in the window; gross ticket
  value only from `payments.status='paid'` (none while payments are off); free RSVPs counted separately.
- **Tests:** every number equals a hand-computed value from seeded rows; empty windows show 0 vs "Unavailable".

## M9 — End-to-end, accessibility, security, polish
- Playwright projects: Chromium desktop, iPhone 14, 320 px, iPad, WebKit. Journeys A–D. axe + manual keyboard pass.
- Security review pass (`docs/PLATFORM_AUDIT.md` items re-checked), Lighthouse on a preview, screenshot review.

## M10 — Release readiness
- Honest report: verified vs unverified, open risks, owner actions. Draft PR updates only — no merge.

## Activating a payment provider later (documented, not done)
All of: provider account approved for this merchant category in writing; test keys + webhook secret in Vercel
Preview; `TICKET_CHECKOUT_ENABLED=true` on Preview only; sandbox E2E (book → webhook → confirmed → refund) passes on
a preview; owner approval; then live keys with `ENABLE_LIVE_PAYMENTS=true` on Production. Event tickets are never
routed through a membership/digital-goods product.
