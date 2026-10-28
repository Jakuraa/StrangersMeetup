# StrangersMeetup

Small hosted meetups, dinners, dating mixers and weekend trips for adults 21+ across Tamil Nadu, Puducherry, Karnataka and Kerala.

**The money loop:** real event → visitor books → verified payment (webhook) → booking confirmed → Telegram bot DM → single-use private-group invite → visible in `/admin`.

## Stack
- Zero-build Node 24. One Vercel function (`api/index.js` → `lib/router.js`) renders pages and serves the API; `public/` holds static CSS/JS/images.
- Postgres (`pg`), migrations in `migrations/NNN_*.sql`, tracked in `schema_migrations`.
- Telegram Bot API (webhook), Telegram Login (OIDC) + Mini App `initData`.
- Payments: Razorpay Payment Links for tickets; Telegram Stars subscriptions for membership. See `docs/PAYMENTS_DECISION.md`.

## Layout
```
api/index.js            single serverless entry
lib/router.js           route table (pages + API)
lib/handlers/*          HTTP handlers (pages, auth, bookings, payments, telegram, cron, admin, leads)
lib/services/*          domain logic (events, bookings, membership, invites, notifications, refunds, users)
lib/payments/*          PaymentProvider adapters (razorpay, cashfree)
lib/telegram/*          Bot API client, auth validation, bot command routing
lib/views/*             server-rendered HTML (auto-escaping `html` tag)
migrations/             Postgres migrations (legacy SQLite files kept in migrations/legacy-sqlite/)
public/                 css, js (site.js, admin.js), images
scripts/                migrate, seed-demo, telegram-setup, lint, make-og
test/                   node:test suites against real Postgres
docs/                   PLATFORM_AUDIT, IMPLEMENTATION_PLAN, ROUTES_AND_ROLES, TEST_STRATEGY, ORGANISER_WIZARD,
                        AUDIT, SPEC, ARCHITECTURE, PAYMENTS_DECISION, TELEGRAM_SETUP, RUNBOOK, GO_LIVE
```

## Local development
```bash
npm install
# Postgres 14+ running locally; create a database
createdb sm_dev
cp .env.example .env    # fill DATABASE_URL, SESSION_SECRET (32+ chars), CRON_SECRET; DEV_LOGIN=true for a local test login
npm run migrate         # loads .env (only .env — not .env.local)
npm run seed:demo       # optional: 4 sample events, all labelled "Sample"
npm run dev             # http://localhost:3000 (PORT)
```
Reset a **local** database (refuses remote URLs, Vercel, production, and any DB that is not empty or StrangersMeetup):
```bash
npm run db:reset:local -- --yes=sm_dev [--seed-demo]
```

## Tests
```bash
createdb sm_test
TEST_DATABASE_URL=postgres://localhost/sm_test npm test
npm run lint
```
The suite drops and recreates the `public` schema of `TEST_DATABASE_URL`, so point it at a dedicated test database.
Tests run the real router against a real Postgres; Telegram and payment HTTP calls are stubbed in `test/helpers.js`. Coverage includes initData validation (bad hash/stale/replay), webhook signatures and idempotency, failed payments, paid ticket → one booking + one invite, capacity race, Stars membership lifecycle and revocation, admin roles/CSRF, form rate limits, secret scan of client assets, and "no fabricated numbers" on an empty DB.

## Deploy
Vercel builds with `npm run vercel-build`. Migrations run only in **Production** builds; a Preview build migrates
only when `MIGRATE_ON_PREVIEW=true`, which must be set only if Preview has its own database. Crons: `vercel.json` → `/api/cron/daily` (Hobby plan: once a day). Health: `GET /api/health`.

## Rules this codebase keeps
- No fabricated data: every number is a query; demo rows are `is_demo` and labelled "Sample"; social proof hidden below `SOCIAL_PROOF_MIN`.
- Server is the source of truth: bookings/entitlements change only in verified webhooks or server-side reconciliation.
- Secrets only in env vars; `.env.example` lists names only. Live payments off until `ENABLE_LIVE_PAYMENTS=true`.
