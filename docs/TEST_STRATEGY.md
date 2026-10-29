# Test strategy

## Layers
| Layer | Tool | Runs against | Command |
|---|---|---|---|
| Syntax/JSON | `scripts/lint.js` (`node --check`) | all `.js`/`.json` | `npm run lint` |
| Integration | `node:test`, real router in-process, real Postgres, external HTTP stubbed (`test/helpers.js`) | a **dedicated** local test DB (the harness drops the `public` schema) | `TEST_DATABASE_URL=postgres://localhost/sm_pv2_test npm test` |
| End-to-end | Playwright + axe (dev-only deps), Chromium: `desktop` 1280×800, `mobile` Pixel 7, and the `responsive` admin matrix (320, 375, Pixel 7, tablet 768, desktop 1280); WebKit/iPad still planned | local server on :3100 + `sm_e2e` re-seeded by `seed:local`; `SKIP_DOTENV=true`, so `.env` is never read | `npm run test:e2e` (see `docs/LOCAL_TESTING.md`) |
| Accessibility *(M2+)* | `@axe-core/playwright` (WCAG 2.1 A/AA, no serious/critical) + keyboard assertions; manual screen-reader pass still planned | same | part of `npm run test:e2e` |
| Visual | Full-page screenshots per project and viewport in `test-results/screenshots/` (`responsive-admin-<viewport>-<screen>.png` for the admin matrix), reviewed by a person after every UI change | same | written by every `npm run test:e2e` run |

There is no build step and no type checker in this repo; reports say so rather than claiming those checks passed.

Before any run that wipes or re-seeds a database, confirm the target: `TEST_DATABASE_URL` must be a dedicated local
test DB and `E2E_DATABASE_URL` (default `postgres://localhost/sm_e2e`) must be local — `e2e/env.js` refuses anything
else. `npm run seed:local` refuses non-local URLs, production `NODE_ENV`/`VERCEL_ENV` and Vercel builds, with no override.

## Current coverage
Unit/integration: 149 tests (`admin`, `auth`, `discovery`, `insights`, `organiser`, `payments`, `site`, `telegram`,
`safety` for M1, `personas` for M8). Browser: `guest-booking`, `organiser-create`, `admin`, `private-venue`,
`mobile-layout` on desktop + mobile, and `admin-responsive` across the five-size matrix (M2).

## Test personas and their limits
Six local-only personas (`lib/dev-personas.js`, seeded by `npm run seed:local`, signed in through `/signin` only when
`DEV_LOGIN=true` with a local DB and no production env). The **staff persona is the platform-wide `support` admin
role, not a true event-scoped staff role**: it can open attendee and booking lists and check guests in across *all*
events. Tests that use it prove the `support` role's server-side limits (no event edits, refunds, roles, insights or
audit), not event scoping. This is a test limitation, not the intended final permission model; event-scoped staff
permissions are future work for M5.

Google OAuth is unconfigured and paid checkout is disabled (`ENABLE_LIVE_PAYMENTS=false`, no provider keys) in every
test environment; tests assert that paid tickets cannot be bought, never that a payment succeeds.

## Known gaps (scheduled)
| Gap | Milestone |
|---|---|
| Check-in: allowed roles, duplicate (409), wrong role, organiser/staff scope | M5 |
| Event-scoped staff role (`event_staff`) and tests that staff cannot see or check in other events | M5 |
| WebKit / iPad and a manual screen-reader pass of the admin console | M2 follow-up |
| CSRF rejection on every organiser write (the harness adds the token automatically, so add explicit negatives) | M5 |
| Second organiser: decline, manage page, image delete, events list; revoked organiser | M5 |
| Full role matrix, allowed + denied per row | M6 |
| Google OIDC tampering/replay/linking | M3 |
| Cashfree webhook signature/timestamp | M9 |
| Client-side wizard safety copy (localStorage) | M9 (E2E) |

## Rules
- Tests use synthetic identities only; nothing calls a real provider.
- A test that guards a fix must be shown to fail on the old code at least once (done for M1).
- Never delete or weaken an existing test to get green; if behaviour changes intentionally, the test changes in the
  same commit with the reason in the message.
- Every new endpoint ships with: signed-out denial, wrong-role/other-owner denial, CSRF denial (writes), invalid
  input, and the happy path.

## End-to-end journeys (M9 suite; also the manual UAT script in `docs/MANUAL_UAT_GUIDE.md`, M8)
- **A — New guest (mobile first):** home → filter → event → rules/tiers/location disclosure → free booking →
  confirmation + ticket → `/me` → refresh, sign out, sign in → booking persists → ticket checks in once, second scan refused.
- **B — Organiser:** sign in → template draft → Basics/Tickets/Features/Preview → save, refresh, resume → publish
  free event (first event: review) → guest books (approval) → approve/decline → states update → guest list + scanner →
  analytics match seeded records → another organiser's routes return 404.
- **C — Admin:** users/organisers/events → grant and revoke a role → enforced on the next request → moderate an event →
  booking metrics → audit log entries → a normal user's admin call is refused.
- **D — Adversarial:** unauthenticated access, self-promotion, cross-organiser IDs, duplicate submits, concurrent
  bookings at capacity, duplicate check-in, expired/revoked session, malformed ids, refresh mid-draft, stale draft
  (409), missing env vars, paid checkout disabled, spoofed provider callback, private venue absent from API, page
  source, metadata, sitemap and logs, keyboard-only, reduced motion, slow network / 500s.
