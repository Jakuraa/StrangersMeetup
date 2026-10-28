# Test strategy

## Layers
| Layer | Tool | Runs against | Command |
|---|---|---|---|
| Syntax/JSON | `scripts/lint.js` (`node --check`) | all `.js`/`.json` | `npm run lint` |
| Integration | `node:test`, real router in-process, real Postgres, external HTTP stubbed (`test/helpers.js`) | a **dedicated** test DB (the harness drops the `public` schema) | `TEST_DATABASE_URL=postgres://localhost/sm_test npm test` |
| End-to-end *(M9; Playwright added as devDependency)* | Playwright: Chromium desktop, iPhone 14, 320 px, iPad, WebKit | local server + seeded local DB | `npm run e2e` *(planned)* |
| Accessibility *(M2+)* | `@axe-core/playwright` + manual keyboard/screen-reader pass | same | part of `npm run e2e` |
| Visual | Playwright screenshots at 390 px and 1280 px, reviewed by a person | same | `npm run e2e -- --grep @visual` *(planned)* |

There is no build step and no type checker in this repo; reports say so rather than claiming those checks passed.

## Current coverage (127 tests)
`admin` 10 · `auth` 14 · `discovery` 13 · `insights` 12 · `organiser` 26 · `payments` 18 · `site` 13 ·
`telegram` 8 · `safety` 13 (M1: migration policy, seed/reset guards, session revocation, fail-closed amounts,
quantity-based fill).

## Known gaps (scheduled)
| Gap | Milestone |
|---|---|
| Check-in: allowed roles, duplicate (409), wrong role, organiser/staff scope | M5 |
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
