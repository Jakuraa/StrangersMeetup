# NIGHTLIFEZ Operational Readiness Runbook

**Milestone:** NIGHTLIFEZ M10 — Beta Readiness, Operational Hardening & Final Engineering Gate  
**Version:** 1.0 (Beta Candidate)  
**Security Classification:** Confidential — Internal Engineering, Operations & QA Only  
**Effective Date:** November 2026  

---

## 1. System Overview & Architecture Boundary

NIGHTLIFEZ is a curated social discovery and experiences platform serving adults 21+ across South India (Chennai, Bengaluru, Coimbatore, Kochi, Puducherry, and expanding regional hubs). The architecture is built around:

1. **Edge Routing & Proxy:** Vercel Edge Network with Deployment Protection (Single Sign-On / password gating on Preview environments).
2. **Application Server:** Node.js (ESM) running custom HTTP handlers, SSR view rendering, and JSON REST APIs.
3. **Database Layer:** PostgreSQL 16+ with ACID transactions, advisory locking for migrations, spatial indexing for location intelligence, and immutable append-only audit ledgers.
4. **Authentication & Identity:** Telegram WebApp `initData` and Login Widget verification via HMAC-SHA-256 with timestamp freshness checks and `httpOnly` secure session cookies. Dev-login is strictly prohibited in production and preview environments.
5. **Ticketing & Cryptographic QR Verification:** HMAC-SHA-256 signed ticket payloads verified at door check-in with atomic double-scan protection.
6. **Payment Boundary:** Strictly governed by `ENABLE_LIVE_PAYMENTS=false`. No live funds are collected. Free RSVP booking tiers are fully operational.

```
┌────────────────────────────────────────────────────────┐
│                   Vercel Edge Proxy                    │
│      (Preview SSO / Production Custom Domain)          │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│               Node.js Application Server               │
│  - lib/router.js (Strict URL Routing)                  │
│  - lib/handlers/ (HTTP Handlers & CSRF Enforcement)    │
│  - lib/services/ (Permissions, Staff, Tickets, Outbox) │
│  - lib/views/ (Server-Side HTML Views & WCAG AA UI)    │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│                 PostgreSQL 16+ Database                │
│  - events, ticket_types, bookings, tickets             │
│  - users, admin_users, org_memberships, event_team     │
│  - notifications (Transactional Outbox)                │
│  - audit_log & payment_audits (Immutable Ledgers)       │
└────────────────────────────────────────────────────────┘
```

---

## 2. Environment Configuration & Variable Inventory

The application reads runtime configuration from process environment variables validated at startup in `lib/env.js`.

### 2.1 Environment Variable Matrix

| Variable | Environment | Required | Default / Example | Purpose & Security Sensitivity |
|---|---|---|---|---|
| `NODE_ENV` | All | Yes | `production` / `development` | Dictates error verbosity and cookie security policies. |
| `DATABASE_URL` | All | Yes | `postgres://...` | Connection URI for PostgreSQL database. **Strictly confidential.** |
| `SESSION_SECRET` | All | Yes | `32+ char hex/base64` | Secret key used to sign session cookies. |
| `CSRF_SECRET` | All | Yes | `32+ char hex/base64` | Secret key used for double-submit CSRF cookie validation. |
| `QR_HMAC_SECRET` | All | Yes | `32+ char hex/base64` | Cryptographic secret for signing attendee QR ticket payloads. |
| `TELEGRAM_BOT_TOKEN` | Production/Beta | Yes | `123456:ABC-DEF...` | BotFather token for Telegram authentication and notification DMs. |
| `TELEGRAM_BOT_USERNAME` | Production/Beta | Yes | `NightlifezBot` | Public username of the Telegram bot for deep links. |
| `CRON_SECRET` | All | Yes | `32+ char string` | Bearer token authenticating Vercel cron triggers and retry jobs. |
| `ENABLE_LIVE_PAYMENTS` | All | Yes | `false` | **Enforced `false` across Beta.** Completely blocks live payment gateways. |
| `DEV_LOGIN` | Local only | Optional | `false` | Enables synthetic persona picker for automated tests. **Disabled on Vercel.** |
| `VERCEL_PROTECTION_BYPASS` | CI / Automation | Optional | String | Secret token for automated CI test bypass of Vercel SSO. |
| `PORT` | Local / Standalone | Optional | `3000` | Port for local application server. |

### 2.2 Preview vs. Production Isolation

| Dimension | Preview Environment | Production Environment |
|---|---|---|
| **Vercel Protection** | Vercel SSO / Password Protection enabled. | Publicly accessible via registered domain (`nightlifez.com`). |
| **Database Instance** | Dedicated preview database branch or staging DB. | Isolated production database cluster with automated backups. |
| **Dev Persona Login** | **Disabled** (`process.env.VERCEL` blocks dev login). | **Disabled** (fails closed). |
| **Payment Gateway** | `ENABLE_LIVE_PAYMENTS=false`. | `ENABLE_LIVE_PAYMENTS=false` (gated by final banking signoff). |
| **Notification Delivery** | Outbox captures notifications; stubbed/test bot. | Real Telegram Bot webhook and DM delivery. |
| **Audit Logging** | Local audit log enabled. | Permanent database audit table with centralized log shipping. |

---

## 3. Database Operations, Backup & Recovery

### 3.1 Backup Procedures (Operational Limitation Notice)

> [!WARNING]
> Automated continuous database backup (WAL archiving or automated snapshotting) is provided at the managed cloud database level (e.g., Neon / AWS RDS / Supabase). It is **not** orchestrated by Node.js application cron jobs. The procedures below detail manual operator commands.

#### Manual Logical Backup (`pg_dump`)
Run a compressed logical backup before any structural migration or major operational event:
```bash
# Capture full database schema and data
pg_dump -v -Fc \
  -d "$DATABASE_URL" \
  -f "backup_nightlifez_$(date +%Y%m%d_%H%M%S).dump"
```

#### Manual Schema-Only Backup
```bash
pg_dump -v --schema-only \
  -d "$DATABASE_URL" \
  -f "schema_nightlifez_$(date +%Y%m%d_%H%M%S).sql"
```

### 3.2 Restoration Procedures
In the event of database corruption or unrecoverable operational incident:
1. Provision a clean, empty PostgreSQL 16+ instance.
2. Restore from the most recent verified compressed dump:
   ```bash
   pg_restore -v --clean --if-exists --no-owner --no-acl \
     -d "$NEW_DATABASE_URL" \
     backup_nightlifez_YYYYMMDD_HHMMSS.dump
   ```
3. Run verification test suite:
   ```bash
   TEST_DATABASE_URL="$NEW_DATABASE_URL" node --test test/migrations.test.js
   ```

---

## 4. Migration Ordering, Rollback Policy & Schema Integrity

### 4.1 Schema Migration Inventory
All migrations are located in `migrations/` and execute in strict numerical order. Each executed migration is recorded in `schema_migrations`.

| Migration Number | File Name | Scope & Changes |
|---|---|---|
| `001` | `001_core.sql` | Users, events, categories, locations base schema. |
| `002` | `002_add_roles_indexes.sql` | Admin users, role enums, performance indexes. |
| `003` | `003_content_blocks.sql` | CMS blocks, curated homepage copy. |
| `004` | `004_payments_entitlements_admin.sql` | Outbox notifications, audit_log, payment orders. |
| `005` | `005_reports_alerts.sql` | Community safety reports, moderation alerts. |
| `006` | `006_discovery_insights_membership.sql` | Analytics events, member discovery, privacy buckets. |
| `007` | `007_mystery_venues.sql` | Secret venue secrecy, private address columns. |
| `008` | `008_organiser_wizard.sql` | Ticket types, capacity rules, event drafts. |
| `009` | `009_auth_security.sql` | Session store, CSRF tracking, rate limit buckets. |
| `010` | `010_superprofile_checkout.sql` | Checkout provider status, external order mapping. |
| `011` | `011_city_coverage.sql` | South India city intelligence, coordinates, bounding boxes. |
| `012` | `012_multi_org.sql` | Tenant organizations, multi-member roles, capabilities. |
| `013` | `013_upi_payments.sql` | Dynamic UPI QR generation, NPCI intent structures. |
| `014` | `014_payment_concurrency.sql` | Capacity holds, unexpired payment locks. |
| `015` | `015_payment_audits.sql` | Immutable append-only payment audit trail. |
| `016` | `016_upi_resilience.sql` | Dispute handling, timeout reconciliation. |
| `017` | `017_tier_hold_index.sql` | Query optimization index on active checkout holds. |
| `018` | `018_discovery_location_indexes.sql` | Spatial indexes, nearby event discovery optimization. |
| `019` | `019_organiser_workspace_and_checkin.sql` | Event team scoping, QR tickets, check-in scans. |
| `020` | `020_attendee_experience.sql` | Saved events, attendee experience hub, cancellation. |
| `021` | `021_realtime_notifications_and_audit.sql` | Operational communications, quiet hours, outbox retries. |

### 4.2 Migration Policy & Rollback Constraints

> [!IMPORTANT]
> **Rollback Limitations:** Because PostgreSQL migrations may create types, modify constraints, and write data backfills, migrations are strictly **forward-only**. Downgrade scripts (`down.sql`) are not automatically executed. In case of migration defect, author a new forward migration (`022_...sql`).

- **Advisory Locking:** All migrations run within an exclusive PostgreSQL session-level advisory lock (`sm_migrate_lock`, hashtext 0x534d4947) ensuring that concurrent application boots never execute duplicate or interleaved migrations.
- **Transactional DDL:** Every migration file executes inside a database transaction block (`BEGIN` ... `COMMIT`). If an error occurs, changes roll back completely without partial schema mutation.

---

## 5. Health Checks, Monitoring & Structured Logging

### 5.1 Service Health Endpoint (`/api/health`)
The application exposes an unauthenticated health probe:
- **Method & Path:** `GET /api/health`
- **Behavior:**
  - Executes `SELECT 1` on PostgreSQL.
  - Inspects environment variables by presence (boolean flag only; secrets are never output).
  - Returns `HTTP 200` with JSON payload:
    ```json
    {
      "status": "ok",
      "database": "connected",
      "time": "2026-11-09T14:40:00.000Z",
      "version": "1.0.0",
      "environment": "preview"
    }
    ```
  - If the database is unreachable, returns `HTTP 503 Service Unavailable`.

### 5.2 Structured Logging & Privacy Scrubbing (`lib/logger.js`)
All server events are emitted in single-line JSON format compatible with modern log collectors:
```json
{"timestamp":"2026-11-09T14:40:00.000Z","level":"info","message":"lead received","type":"venue"}
```
- **Redaction Guard:** Tokens (`token`, `secret`, `initData`, `password`, `key`) are automatically scrubbed by regex before logging.
- **Zero PII Exposure:** Attendee phone numbers, Telegram passwords, and private venue addresses are never emitted to application logs.

---

## 6. Notification Outbox Failures, Retry Limits & Dead-Letter Handling

### 6.1 Transactional Outbox Pattern
Side effects such as Telegram direct messages, organizer notifications, and attendee status updates are written to the `notifications` table within the same transaction as the triggering business event.

```
[User Action] ──► [DB Transaction: Business State + Notification Row (status: 'pending')]
                                                              │
                                                              ▼
                                               [Async Worker / Cron / Event Hook]
                                                              │
                                            ┌─────────────────┴─────────────────┐
                                            ▼                                   ▼
                                     [Delivery OK]                       [Delivery Error]
                                     status: 'sent'                      attempts = attempts + 1
                                     sent_at: now()                      status: 'failed' (attempts >= 5)
```

### 6.2 Dead-Letter Thresholds & Quiet Hours
1. **Retry Limit:** A notification is retried up to **5 times** with exponential backoff (`2^(attempts) * 60` seconds).
2. **Dead-Letter State:** After 5 failed attempts, the record transitions to `status = 'failed'` and remains in the outbox for manual investigation.
3. **Quiet Hours Deferral:** Non-urgent notifications between 22:00 and 08:00 IST are scheduled for `next_attempt_at = 08:00 IST` to avoid disturbing attendees during night hours.
4. **Admin Manual Retry:**
   - Administrators can review failed notifications at `GET /api/admin/notifications?status=failed`.
   - Admin can trigger an immediate manual retry via `POST /api/admin/notifications/:id/retry`. The action is audited in `audit_log`.

---

## 7. Incident Response, Safety & Escalation Procedures

### 7.1 Severity Classification Matrix

| Level | Definition | Example Scenarios | Response SLA | Action Owner |
|---|---|---|---|---|
| **P0 — Critical** | Complete service outage or security breach. | Database down; private venue addresses leaked; auth bypass; payment exploit. | < 15 minutes | Lead Engineer & System Owner |
| **P1 — High** | Major functional failure affecting attendees or organizers. | Check-in scanner failing at door; notifications completely stalled; booking failures. | < 1 hour | On-Call Engineer |
| **P2 — Medium** | Non-blocking degradation of secondary feature. | Image upload failure; location distance filter inaccuracy; lead form delay. | < 4 hours | Engineering Team |
| **P3 — Low** | Cosmetic issue, typo, minor UI layout glitch. | Empty state spacing; copy clarification; minor responsive padding. | Next business day | Frontend Engineer |

### 7.2 Safety Reports & Moderation Escalation
Attendees can report misconduct, safety risks, or harassment via `/report` or event-level reporting links.
1. **Report Ingestion:** Stored in `reports` table with category, body, reporter ID, and target ID.
2. **Admin Moderation:** Listed in Admin Console under `Safety & Reports`.
3. **Attendee Blocking:**
   - Organizers can block problematic attendees via `POST /api/organiser/blocked-attendees`.
   - Blocked attendees are immediately barred from reserving seats for any event hosted by that organizer.
4. **Emergency Event Cancellation:**
   - Organizers or Super Admins can cancel an event via `POST /api/organiser/events/:id/cancel`.
   - Cancellation triggers automatic ticket invalidation, seat release, and notification dispatch to all confirmed guests.

---

## 8. Organiser & Staff Operational Governance

### 8.1 Organiser Lifecycle
1. **Application:** Prospective host applies at `/become-a-host`.
2. **Review:** Operations team reviews experience and safety compliance within 24–48 hours.
3. **Activation:** Super Admin executes `POST /api/admin/organisers` to set `organiser_enabled = true` and create a personal organization.
4. **Draft & Publish:** Host configures event details, ticket tiers, and mystery venue privacy.
5. **Private Venue Secrecy:** Exact address is strictly concealed from public listings and unbooked users. Disclosed only to confirmed ticket holders.

### 8.2 Event Staff Roles & Scoping

| Staff Role | Allowed Operations | Forbidden Operations |
|---|---|---|
| **Organiser / Owner** | Full event editing, publishing, cancellation, ticket pricing, staff invites, announcements, refunds view. | Modifying platform system settings or other organisers' events. |
| **Event Manager** | Event editing, attendee management, announcements, manual check-in override, ticket reissue. | Staff invites, organization-level member management. |
| **Door Staff** | Real-time QR camera scanning, manual lookup by ticket code, door check-in. | Viewing attendee phone numbers, editing event, publishing announcements. |
| **Guest List Manager** | Viewing guest list, marking attendance, check-in. | Changing capacity, editing pricing, canceling event. |
| **Assistant** | Read-only attendance counts and operational overview. | All mutating actions. |

- **Immediate Staff Revocation:** Revoking staff membership via `DELETE /api/organiser/events/:id/staff/:staffId` immediately cuts off access to check-in tools and guest records.

---

## 9. Financial Safety & Reconciliation Procedures

### 9.1 Live Payment Lock Enforcement
`ENABLE_LIVE_PAYMENTS=false` is enforced at application startup and checkout router initialization. Any attempt to start a paid checkout returns `HTTP 400 payments_disabled`. Free RSVP tier bookings execute normally without financial transactions.

### 9.2 Reconciliation Audit Ledger (`payment_audits`)
All payment lifecycle transitions are recorded in `payment_audits` (an immutable append-only ledger protected by PostgreSQL trigger `trg_payment_audits_immutable`).
- Every entry records `payment_id`, `event_type`, `from_status`, `to_status`, `actor`, and `details`.
- In case of provider drift or manual refund, the Finance Admin must record external transaction reference (`provider_refund_id`) and operator attestation notes in the audit log.

---

## 10. Operational Verification Checklist

Before opening the Preview environment for owner acceptance walkthrough:
- [x] All 21 migrations executed and recorded in `schema_migrations`.
- [x] Health check `GET /api/health` returns `200 ok`.
- [x] Linter reports clean status across all files (`npm run lint`).
- [x] Unit, integration, and security test suites passing (692 tests total).
- [x] Playwright multi-role browser suite passing (14/14 tests across Desktop and Mobile).
- [x] Vercel Preview Deployment Protection (SSO) verified active.
- [x] `ENABLE_LIVE_PAYMENTS=false` confirmed in environment configuration.
