# NIGHTLIFEZ

Vibrant social discovery, curated nightlife, supper clubs, weekend trips, and hosted experiences across South India (Chennai, Bangalore, Puducherry, Kochi, Goa, Hyderabad) for adults 21+.

**The core money & fulfillment loop:**  
Real event $\to$ Visitor books ticket $\to$ Verified payment webhook $\to$ Booking `confirmed` $\to$ Telegram bot DM $\to$ Single-use private group invite $\to$ QR check-in pass $\to$ Event check-in.

---

## Technical Stack

- **Runtime & Compute:** Zero-build Node 24. A single Vercel serverless function (`api/index.js` $\to$ `lib/router.js`) renders all SSR pages and dispatches API endpoints. Static CSS, JS, and brand assets are served from `public/`.
- **Database:** Serverless Postgres via pooled `pg` (`DATABASE_URL`). Migrations in `migrations/NNN_*.sql` tracked idempotently in `schema_migrations`.
- **Authentication:** Telegram Login Widget (OIDC SHA-256) and Telegram Mini App (`initData` HMAC-SHA-256). HTTP-only, Secure, SameSite=Lax signed session cookies (`sm_session`) backed by Postgres `user_sessions`.
- **Bot & Comms:** Telegram Bot API (`@Nightlifez_bot`), webhook-driven notifications, HMAC ticket verification, and single-use chat invite links.
- **Payments:** External hosted checkout (SuperProfile link-out) and native UPI/PhonePe integrations. Controlled by strict independent feature flags: `ENABLE_LIVE_PAYMENTS=false` and `UPI_CHECKOUT_ENABLED=false` until explicitly approved.

---

## Repository Layout

```
api/index.js            Vercel serverless entry point
lib/router.js           Central HTTP routing table (pages + API)
lib/config.js           Environment variable loading and security assertions
lib/db.js               Postgres connection pooling and query wrapper
lib/handlers/           HTTP route handlers (pages, auth, bookings, payments, telegram, cron, admin, leads)
lib/services/           Domain logic (events, bookings, membership, invites, notifications, refunds, users)
lib/payments/           Payment providers (SuperProfile, UPI/PhonePe)
lib/telegram/           Bot API client, auth validation, webhook router
lib/views/              Server-rendered HTML components (escaped html template tag)
migrations/             Tracked Postgres migration files (003 through 020)
public/                 Static assets: css/, js/ (site.js, admin.js), brand images
scripts/                Operational scripts (migrate, seed-demo, seed-local, lint, db-reset)
test/                   Automated test suites (unit, integration, security against real Postgres)
tests/e2e/              Playwright E2E and Axe accessibility test suites
docs/                   Consolidated project documentation (PRODUCT, ARCHITECTURE, DEPLOYMENT, SECURITY, OPERATIONS)
```

---

## Local Development Setup

### 1. Prerequisites
- Node.js 24.x
- PostgreSQL 14+ running locally

### 2. Quickstart
```bash
# Clone and install dependencies
git clone https://github.com/Jakuraa/StrangersMeetup.git
cd StrangersMeetup
npm install

# Create local development database
createdb sm_dev

# Configure environment
cp .env.example .env
# Edit .env: ensure DATABASE_URL=postgres://localhost/sm_dev and SESSION_SECRET is set

# Run schema migrations
npm run migrate

# Optional: Seed sample demo events or local test personas
npm run seed:demo
npm run seed:local

# Start local server (default: http://localhost:3000)
npm run dev
```

### 3. Reset Local Database
Refuses remote URLs, production databases, and protected branches:
```bash
npm run db:reset:local -- --yes=sm_dev [--seed-demo]
```

---

## Automated Testing Suite

The test suite runs against real PostgreSQL databases. The test harness drops and recreates the `public` schema on `TEST_DATABASE_URL`.

```bash
# Create dedicated test databases
createdb sm_test
createdb sm_e2e

# 1. Syntax and JSON linting
npm run lint

# 2. Unit, integration, and security tests (real Postgres)
TEST_DATABASE_URL=postgres://localhost/sm_test npm test

# 3. Playwright E2E and accessibility audits
E2E_DATABASE_URL=postgres://localhost/sm_e2e npm run test:e2e
```

---

## Core Engineering Principles

1. **Zero Fabricated Data:** Every statistic and count rendered on the site is an authentic database query. When no events exist, honest empty states render rather than fabricated fillers.
2. **Server as Single Source of Truth:** Bookings, ticket allocations, and user entitlements mutate exclusively inside atomic database transactions driven by verified webhooks or server reconciliation. Client redirects never confirm state.
3. **Defense in Depth:** All client inputs are validated via strict schemas. Mutating requests enforce CSRF tokens. Protected endpoints enforce role-based access controls.
4. **Zero Client Secret Leakage:** Sensitive keys, API tokens, and credentials exist solely in server environment variables and are never bundled into client scripts.

---

## Documentation Index

- [docs/PRODUCT.md](file:///Users/pradeepjakuraa/strangersmeetup/docs/PRODUCT.md) — Product vision, user personas, event categories, geographic coverage, and end-to-end user journeys.
- [docs/ARCHITECTURE.md](file:///Users/pradeepjakuraa/strangersmeetup/docs/ARCHITECTURE.md) — System architecture, database schema, state machines, and API specifications.
- [docs/DEPLOYMENT.md](file:///Users/pradeepjakuraa/strangersmeetup/docs/DEPLOYMENT.md) — Vercel production hosting, Neon Postgres configuration, environment variables, and migration gates.
- [docs/SECURITY.md](file:///Users/pradeepjakuraa/strangersmeetup/docs/SECURITY.md) — Security policies, authentication mechanics, payment guards, privacy controls, and vulnerability disclosure.
- [docs/OPERATIONS.md](file:///Users/pradeepjakuraa/strangersmeetup/docs/OPERATIONS.md) — Runbooks, Telegram bot configuration, daily crons, refunds, incident management, and secret rotation.
