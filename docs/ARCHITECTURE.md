# NIGHTLIFEZ — Technical Architecture

**Status:** Production Baseline  
**Runtime:** Node.js 24.x on Vercel Serverless Platform  
**Database:** PostgreSQL 16 (Neon Serverless Postgres)  

---

## 1. Architectural Overview

NIGHTLIFEZ is built on a high-efficiency, zero-build architecture. All server execution flows through a single serverless function routed by an internal HTTP dispatcher.

```
                           ┌───────────────────────────┐
                           │      Client Request       │
                           │ (Browser / Telegram Mini) │
                           └─────────────┬─────────────┘
                                         │
                                         ▼
                           ┌───────────────────────────┐
                           │       Vercel Edge         │
                           │  - TLS 1.3 Termination    │
                           │  - Static Asset Delivery  │
                           │  - vercel.json Rewrites   │
                           └─────────────┬─────────────┘
                                         │
                                         ▼
                           ┌───────────────────────────┐
                           │      api/index.js         │
                           │  (Serverless Entry Point) │
                           └─────────────┬─────────────┘
                                         │
                                         ▼
                           ┌───────────────────────────┐
                           │       lib/router.js       │
                           │ - Route Matcher & Auth    │
                           │ - Rate Limiting & CSRF    │
                           │ - Escaped HTML SSR / JSON │
                           └─────────────┬─────────────┘
                                         │
                        ┌────────────────┴────────────────┐
                        ▼                                 ▼
             ┌─────────────────────┐           ┌─────────────────────┐
             │    Neon Postgres    │           │ Telegram Bot API    │
             │ - Pooled Connections│           │ - Webhooks          │
             │ - Advisory Locks    │           │ - Private Invites   │
             │ - Outbox Pattern    │           │ - Check-in Passes   │
             └─────────────────────┘           └─────────────────────┘
```

---

## 2. Core Components

### A. Serverless Entry & Routing (`api/index.js`, `lib/router.js`)
- **Zero-Build Pipeline:** No transpilation, bundling, or Webpack overhead. Node.js runs native ESM modules directly.
- **Route Matching:** Clean URL pattern matching supporting parameter extraction (`/events/:slug`, `/trips/:slug`, `/admin/events/:id`).
- **Template Rendering (`lib/views/`):** Pure server-side rendering using an auto-escaping tagged template literal (`html` tag), preventing Cross-Site Scripting (XSS) at the templating layer.

### B. Database Layer & Migration Policy (`lib/db.js`, `scripts/migrate.js`)
- **Connection Management:** `pg.Pool` with TLS support, keepalives, and connection pooling optimized for serverless execution.
- **Idempotent Migrations:** Numbered SQL migration files (`migrations/003_*.sql` through `020_*.sql`) tracked in the `schema_migrations` table.
- **Concurrency Protection:** Migrations acquire a PostgreSQL advisory lock (`pg_advisory_lock(839201948)`) before running, guaranteeing zero race conditions even during concurrent deployment invocations.
- **Database Isolation:** Production database hostnames (`ep-dawn-glitter-b4mkwxkl`) are hard-coded into `DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS` in `lib/config.js` to strictly block Preview deployments from connecting to Production storage.

---

## 3. Finite State Machines

### A. Booking Lifecycle
```
           createCheckout (Capacity Lock in Tx)
  (None) ──────────────────────────────────────────► pending_payment
                                                           │
                                                           │ Hold expires (15 min)
                                                           ▼
                                                       cancelled
                                                           │
                                 Verified Webhook: Paid    │
            pending_payment ───────────────────────────────┼────────► confirmed
                                                           │              │
                                                           │              │ Door Scan
                                                           │              ▼
                                                           │          checked_in
                                                           │              │
                                                           │ Admin Refund │
                                                           ▼              ▼
                                                       refunded ◄─────────┘
```
- **Capacity Integrity:** Checkouts check available slots inside a database transaction using `SELECT ... FOR UPDATE` against the event capacity, preventing overselling.
- **Stale Hold Recovery:** Holds that remain unpaid after 15 minutes are released lazily by queries and swept by the daily cron.

### B. Payment Transaction States
`created` $\to$ `paid` | `failed` $\to$ `refunded`
- **Idempotency Guarantee:** Every webhook event is checked against `webhook_events(provider, provider_event_id)` inside a unique constraint check before processing. Duplicate webhooks return `200 OK` with zero side effects.

### C. Telegram Entitlement & Membership States
`active` $\to$ `cancelled` (user cancels, retains access until `expires_at`) $\to$ `expired` (cron sweeps) $\to$ `revoked` (bot issues ban+unban to kick from chat).

---

## 4. Authentication & Security Architecture

### A. Telegram Mini App Authentication
- Mini Apps pass an `initData` query string containing user attributes and a cryptographic `hash`.
- The server validates the signature using `HMAC-SHA-256("WebAppData", bot_token)`.
- Validates `auth_date` ($\le$ 300 seconds) and enforces nonce checking against replay attacks.

### B. Telegram Login Widget (OIDC)
- Sign-ins via the Telegram Login Widget generate a SHA-256 HMAC hash verified using `SHA256(bot_token)`.

### C. Session Management (`user_sessions`)
- Authenticated clients receive an HTTP-only, Secure, SameSite=Lax cookie named `sm_session`.
- Sessions contain a cryptographic signature verifying user ID, session UUID, and expiration.
- Sessions are actively cross-referenced against the `user_sessions` database table, enabling immediate server-side revocation on logout or admin ban.

### D. CSRF Mitigation
- All state-mutating requests (`POST`, `PUT`, `DELETE`) require an `X-CSRF-Token` header.
- The CSRF token is derived via `HMAC(session_secret, session_id + "csrf")`, ensuring zero token spoofing without active cookies.

---

## 5. Notification & Asynchronous Outbox Pattern

To prevent external network failures (e.g., Telegram API latency) from rolling back critical financial transactions:
1. When a booking confirms, the database transaction writes a row to the `notifications` outbox table.
2. The server attempts inline dispatch immediately following transaction commit.
3. If the Telegram API is unavailable, the notification remains in `pending` status with an incremental retry backoff counter.
4. Scheduled cron jobs sweep and retry pending notifications automatically.
