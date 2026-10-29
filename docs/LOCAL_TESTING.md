# Local testing: personas, seed data and browser tests

Everything here runs **only on your machine against a local Postgres**. None of it can touch production:

| Safeguard | Where |
|---|---|
| `npm run seed:local` refuses `NODE_ENV=production`, `VERCEL_ENV=production`, any Vercel build, and any `DATABASE_URL` that is not `localhost`/loopback/a Unix socket. There is no remote override (unlike `seed:demo`'s `SEED_ALLOW_REMOTE`). | `scripts/seed-guard.js` (`kind: 'local'`) |
| Persona sign-in (`POST /api/auth/dev`) returns **404** unless all of: not on Vercel, `DEV_LOGIN=true`, not production (`NODE_ENV`/`VERCEL_ENV`), and a local `DATABASE_URL`. The `/signin` picker is rendered under the same check. | `lib/dev-personas.js` → `devLoginEnabled()` |
| Persona sign-in never creates accounts; it only signs in users that `seed:local` created (409 `not_seeded` otherwise). | `lib/handlers/auth.js` |
| The seed deletes and recreates only persona-owned rows (reserved Telegram ids `9100000000–9100999999`) and `local-*` demo events. | `scripts/seed-local.js` |
| The browser suite refuses to start unless `E2E_DATABASE_URL` is local, and starts the server with an explicit environment (`SKIP_DOTENV=true`), so a real `DATABASE_URL` in `.env` is never used. | `e2e/env.js` |

**Google OAuth is not configured and paid checkout is disabled.** Nothing here sets Google client ids or payment
keys; the browser suite runs with `ENABLE_LIVE_PAYMENTS=false`, so paid tickets show "Online booking not available yet"
and can never be bought. Telegram sign-in is replaced locally by the persona picker below.

## 1. One-time setup
```bash
npm install                      # includes dev-only @playwright/test and @axe-core/playwright
npx playwright install chromium  # browser for the e2e suite
createdb sm_dev                  # your local dev database
createdb sm_test                 # unit/integration suite (its schema is dropped on every run; any dedicated local name works, e.g. sm_pv2_test)
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
(Or put the three variables in `.env`; `npm run migrate`, `seed:local` and `dev` all read it. Keep that `.env`
pointed at a local database: the browser suite never reads `.env`, and must never be given production credentials.)

**`npm run seed:local` safety conditions** (all checked before anything is migrated or written; see the table above):
`DATABASE_URL` must be `localhost`, a loopback address or a Unix socket; `NODE_ENV` and `VERCEL_ENV` must not be
`production`; it must not run inside a Vercel build. There is no override. It only deletes and recreates persona-owned
rows, `local-*` events and leads tagged `payload.seed = 'local'`, so other local data is left alone.

## 3. Personas

| Key | Name | Role | Lands on | Can | Cannot |
|---|---|---|---|---|---|
| `guest` | Test Guest Asha | member | `/me` | book free tickets; see the private venue on own confirmed bookings | see others' bookings; organiser tools; admin |
| `guest2` | Test Guest Bala | member | `/me` | own bookings and pending request | book the sold-out event; see `guest`'s booking or any private venue it has not booked |
| `organiser` | Test Organiser Chitra | organiser (`users.organiser_enabled`) | `/organiser` | create/publish events; own guest lists; approve requests | another organiser's events or drafts; admin |
| `organiser2` | Test Organiser Dev | organiser | `/organiser` | own events and draft | organiser 1's events, requests, drafts |
| `staff` | Test Staff Esha | event staff = admin role `support` | `/admin` | attendee lists, bookings list, check-in | event edits, refunds, roles, insights, audit, organiser tools |
| `admin` | Test Admin Farah | `super_admin` | `/admin` | everything, incl. roles, audit, granting organisers | demoting themselves; writes without CSRF |

> **Staff persona limitation.** The `staff` persona is *not* a true event-scoped staff role. It is the platform-wide
> `support` admin role, so it can open the attendee and booking lists of **every** event and check guests in at
> **any** event. That is a test limitation, not the intended final permission model. Event-scoped staff permissions
> (`event_staff`: a person allowed to see and check in guests for specific events only) remain future work for **M5**.

### Persona login flow (local only)
1. Start the server with `DEV_LOGIN=true`, a local `DATABASE_URL`, and no production `NODE_ENV`/`VERCEL_ENV` (section 2).
2. Run `npm run seed:local` — persona sign-in only signs in users the seed created (409 `not_seeded` otherwise).
3. Open `/signin`; the "Local test personas" picker lists the six personas. Click one; you land on its page from the
   table above (`/me`, `/organiser` or `/admin`) with a normal server-side session.
4. Sign out from the site, or re-run `seed:local` (it revokes persona sessions) to switch.

If any condition in step 1 fails the picker is not rendered and `POST /api/auth/dev` returns 404, which is how it
behaves on every deployment.

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

Plus one draft per organiser, 40 analytics rows spread over the 7/30/90-day insight windows, and moderation rows for
the admin console (2 leads, one with a long unbroken URL; 1 guest report).
`npm run seed:local` prints the counts (6 users, 2 admin rows, 8 events, 8 ticket types, 7 bookings, 2 drafts,
40 analytics, 2 leads, 1 report).

## 4. Automated tests
```bash
npm run lint                                                        # node --check over every .js/.json file
TEST_DATABASE_URL=postgres://localhost/sm_pv2_test npm test         # node:test suites; use your dedicated test DB (it is wiped)
npm run test:e2e                                                    # Playwright: desktop + mobile + responsive projects
npm run test:e2e -- --project=mobile e2e/guest-booking.spec.js      # one project / one file
npm run test:e2e -- --project=responsive -g "admin @ 320"           # one viewport of the admin matrix
npm run test:e2e:report                                             # open the last HTML report
```
Before running `npm test`, check that `TEST_DATABASE_URL` names a dedicated local database: the harness drops its
`public` schema. Never point it, or `E2E_DATABASE_URL`, at `.env`'s database or at production.

### Viewport matrix
| Project | Viewport | Specs |
|---|---|---|
| `desktop` | Desktop Chrome 1280×800 | every spec except `admin-responsive` |
| `mobile` | Pixel 7 (412×839, touch) | every spec except `admin-responsive` |
| `responsive` | per describe block: **320×640**, **375×667**, **Pixel 7** (412, touch), **tablet 768×1024**, **desktop 1280×800** | `e2e/closed-and-gates.spec.js` | past/cancelled event pages show a status panel and no booking controls; signed-out (401) and non-admin (403) `/admin` access screens; category card art |
| `e2e/tap-targets.spec.js` | phone project only, 320 and 375px: every interactive control on public, menu, `/me` and organiser pages is ≥44px (inline links in sentences exempt) |
| `e2e/admin-responsive.spec.js` |

The admin console switches to the phone layout (Sections menu, card tables) at ≤800px; tables with more than six
columns (Events) stay as cards up to 920px of panel width, so the tablet and Pixel 7 sizes see cards. Chromium only;
WebKit/iPad is not yet in the matrix.
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
| `e2e/admin-responsive.spec.js` | admin console at all five matrix sizes: every section fits with no sideways scroll; tables become labelled cards with identity first and every column kept; named, ≥44px actions; check-in; lead/report status controls; loading/empty/error/offline/forbidden states; long unbroken text; keyboard focus; desktop sidebar vs. full-width phone "Sections" button (mouse, Enter/Space, Escape); role-filtered sections for staff |

Axe runs with `prefers-reduced-motion: reduce` so it measures settled colours, not mid-fade text.

### Reviewing screenshots
Every run writes full-page screenshots to `test-results/screenshots/<project>-<name>.png` (git-ignored, overwritten
each run). The admin matrix writes `responsive-admin-<viewport>-<screen>.png`, where viewport is `320`, `375`,
`pixel7`, `tablet` or `desktop` and screen is one of `events`, `bookings`, `attendees-before`, `attendees-after`,
`leads`, `reports`, `audit`, `loading`, `empty`, `error`, `long-text`, `keyboard`, `nav` (desktop) or
`nav-closed`/`nav-open` (phones and tablet).
```bash
ls test-results/screenshots/responsive-admin-*.png
open test-results/screenshots/responsive-admin-320-nav-open.png    # macOS Preview; any image viewer works
```
Check for: clipped or overlapping controls, sideways scroll, every table column present as a labelled line on
cards, the identity (event title / member / name) leading each card, usable buttons and status selects, clear
loading/empty/error/offline/forbidden states, a visible focus ring in `*-keyboard.png`, and — on desktop — a sidebar
with no "Sections" text. The automated assertions cover these too; the screenshots are for what assertions miss.
The audit log in `sm_e2e` is not reset by the seed, so `*-audit.png` grows with every run; `dropdb sm_e2e && createdb sm_e2e`
starts it fresh.
