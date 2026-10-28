# Local testing: personas, seed data and browser tests

Everything here runs **only on your machine against a local Postgres**. None of it can touch production:

| Safeguard | Where |
|---|---|
| `npm run seed:local` refuses `NODE_ENV=production`, `VERCEL_ENV=production`, any Vercel build, and any `DATABASE_URL` that is not `localhost`/loopback/a Unix socket. There is no remote override (unlike `seed:demo`'s `SEED_ALLOW_REMOTE`). | `scripts/seed-guard.js` (`kind: 'local'`) |
| Persona sign-in (`POST /api/auth/dev`) returns **404** unless all of: not on Vercel, `DEV_LOGIN=true`, not production (`NODE_ENV`/`VERCEL_ENV`), and a local `DATABASE_URL`. The `/signin` picker is rendered under the same check. | `lib/dev-personas.js` → `devLoginEnabled()` |
| Persona sign-in never creates accounts; it only signs in users that `seed:local` created (409 `not_seeded` otherwise). | `lib/handlers/auth.js` |
| The seed deletes and recreates only persona-owned rows (reserved Telegram ids `9100000000–9100999999`) and `local-*` demo events. | `scripts/seed-local.js` |
| The browser suite refuses to start unless `E2E_DATABASE_URL` is local, and starts the server with an explicit environment (`SKIP_DOTENV=true`), so a real `DATABASE_URL` in `.env` is never used. | `e2e/env.js` |

Google sign-in and payments are not configured by any of this; paid tickets stay unbookable (`ENABLE_LIVE_PAYMENTS=false`, no keys).

## 1. One-time setup
```bash
npm install                      # includes dev-only @playwright/test and @axe-core/playwright
npx playwright install chromium  # browser for the e2e suite
createdb sm_dev                  # your local dev database
createdb sm_test                 # unit/integration suite (its schema is dropped on every run)
createdb sm_e2e                  # browser suite (re-seeded on every run)
```

## 2. Start the app with personas
```bash
export DATABASE_URL=postgres://localhost/sm_dev
export SESSION_SECRET=local-dev-session-secret-at-least-32-chars
export DEV_LOGIN=true
npm run migrate                  # apply migrations
npm run seed:local               # personas + events; safe to re-run, resets persona data each time
npm run dev                      # http://localhost:3000 → /signin shows "Local test personas"
```
(Or put the three variables in `.env`; `npm run migrate`, `seed:local` and `dev` all read it.)

## 3. Personas

| Key | Name | Role | Lands on | Can | Cannot |
|---|---|---|---|---|---|
| `guest` | Test Guest Asha | member | `/me` | book free tickets; see the private venue on own confirmed bookings | see others' bookings; organiser tools; admin |
| `guest2` | Test Guest Bala | member | `/me` | own bookings and pending request | book the sold-out event; see `guest`'s booking or any private venue it has not booked |
| `organiser` | Test Organiser Chitra | organiser (`users.organiser_enabled`) | `/organiser` | create/publish events; own guest lists; approve requests | another organiser's events or drafts; admin |
| `organiser2` | Test Organiser Dev | organiser | `/organiser` | own events and draft | organiser 1's events, requests, drafts |
| `staff` | Test Staff Esha | event staff = admin role `support` | `/admin` | attendee lists, bookings list, check-in | event edits, refunds, roles, insights, audit, organiser tools |
| `admin` | Test Admin Farah | `super_admin` | `/admin` | everything, incl. roles, audit, granting organisers | demoting themselves; writes without CSRF |

Per-event staff (`event_staff`) is planned for M5; until then the staff persona uses the existing platform-wide
`support` admin role, which is the closest server-enforced role.

Sign in from the browser at `/signin`, or from a script:
```bash
curl -i -X POST localhost:3000/api/auth/dev -H 'content-type: application/json' -d '{"persona":"organiser"}'
```

### Seeded events (all `is_demo=true`, slug `local-*`, venues private)
| Slug | Owner | State |
|---|---|---|
| `local-board-games-night` | organiser | open; `guest` confirmed |
| `local-sunday-picnic` | organiser | open, no bookings (used by the booking test) |
| `local-approval-dinner` | organiser | host approval; `guest2` pending request with an answer |
| `local-paid-workshop` | organiser | paid tier only → "Online booking not available yet" |
| `local-low-seats-trek` | organiser2 | 1 seat left (`guest2` holds 2 of 3) |
| `local-sold-out-mixer` | organiser2 | sold out (`guest` holds 2 of 2) |
| `local-past-meetup` | organiser | ended; `guest` checked in, `guest2` confirmed |
| `local-cancelled-movie` | organiser2 | cancelled; `guest2` booking cancelled |

Plus one draft per organiser and 40 analytics rows spread over the 7/30/90-day insight windows.
`npm run seed:local` prints the counts (6 users, 2 admin rows, 8 events, 8 ticket types, 7 bookings, 2 drafts, 40 analytics).

## 4. Automated tests
```bash
npm run lint
TEST_DATABASE_URL=postgres://localhost/sm_test npm test        # node:test suites, incl. test/personas.test.js
npm run test:e2e                                               # Playwright: desktop (1280×800) + mobile (Pixel 7)
npm run test:e2e -- --project=mobile e2e/guest-booking.spec.js # one project / one file
npm run test:e2e:report                                        # open the last HTML report
```
`npm run test:e2e` starts its own server on port 3100 (`E2E_PORT`) against `E2E_DATABASE_URL`
(default `postgres://localhost/sm_e2e`), migrates, re-seeds, and clears that database's rate-limit windows first.
Stop any server already on port 3100 before running it.

| Spec | Covers |
|---|---|
| `e2e/guest-booking.spec.js` | free booking end to end, venue revealed on the confirmed booking; paid and sold-out show no Book button |
| `e2e/organiser-create.spec.js` | four-step wizard → publish → public page hides the venue; the other organiser gets 404 managing it |
| `e2e/admin.spec.js` | super admin console, roles and audit; staff sees only permitted tabs and gets 403 on admin-only APIs; guests/organisers refused |
| `e2e/private-venue.spec.js` | venue never in visitor HTML or `/api/events`; not shown to a non-booked guest, a pending request, or another guest opening the booking URL |
| `e2e/mobile-layout.spec.js` | no sideways scroll (incl. 320px), axe WCAG 2.1 A/AA with no serious/critical issues on public and signed-in pages, mobile menu Escape |

Screenshots of every key screen are written to `test-results/screenshots/<project>-<name>.png` (git-ignored) for
review. Axe runs with `prefers-reduced-motion: reduce` so it measures settled colours, not mid-fade text.
