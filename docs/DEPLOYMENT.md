# NIGHTLIFEZ — Deployment & Environment Setup

**Platform:** Vercel Serverless Platform  
**Production Domain:** [https://nightlifez.com](https://nightlifez.com)  
**Redirect Domain:** [https://www.nightlifez.com](https://www.nightlifez.com) $\to$ `nightlifez.com` (HTTP 308)  
**Vercel Project:** `jakuraa/strangersmeetup` (`prj_JtY6c5SRSt1NHE5sjSZFZAYwYqaa`)  
**Production Database:** Neon Serverless PostgreSQL (`ep-dawn-glitter-b4mkwxkl`)  

---

## 1. Domain & DNS Configuration

The production domain is routed via Cloudflare DNS-only records directly to the Vercel Edge network:

| Record Type | Host | Target Value | Proxy Status | Purpose |
|---|---|---|---|---|
| **A** | `@` (apex) | `76.76.21.21` | DNS only (Unproxied) | Directs apex traffic to Vercel Edge |
| **CNAME** | `www` | `cname.vercel-dns.com` | DNS only (Unproxied) | Enforces permanent HTTP 308 redirect |

- **Edge Certificates:** Managed automatically by Vercel via Let's Encrypt with TLS 1.3 encryption.
- **HSTS & Security Headers:** Enforced automatically by the application router on all responses.

---

## 2. Production Environment Variables

All secrets are managed exclusively within Vercel's encrypted environment variable store.

| Variable Name | Required Scope | Type / Value Example | Description |
|---|---|---|---|
| `DATABASE_URL` | Production & Preview | `postgres://user:pass@host/db?sslmode=require` | Pooled Postgres connection string |
| `PUBLIC_SITE_URL` | Production | `https://nightlifez.com` | Canonical root domain URL |
| `SESSION_SECRET` | Production & Preview | 48+ character cryptographic string | Key used to sign session cookies (`sm_session`) |
| `CRON_SECRET` | Production & Preview | 48+ character random string | Bearer token required to invoke `/api/cron/*` |
| `TICKET_SECRET` | Production & Preview | 64-character hexadecimal key | HMAC-SHA256 key used to sign door QR passes |
| `TELEGRAM_BOT_TOKEN` | Production | `123456789:ABC...` | Bot token provided by @BotFather |
| `TELEGRAM_BOT_USERNAME`| Production | `Nightlifez_bot` | Public handle of the production bot |
| `TELEGRAM_WEBHOOK_SECRET`| Production | 48+ character cryptographic string | Validates inbound Telegram webhook updates |
| `SUPERPROFILE_WEBHOOK_SECRET`| Production | 24+ character cryptographic string | Validates SuperProfile payment webhooks |
| `ADMIN_BOOTSTRAP_TELEGRAM_ID`| Production | Numeric Telegram User ID | Automatically grants initial `super_admin` role |
| `SUPPORT_EMAIL` | Production | `nightlifezofficial@gmail.com` | Customer-facing support email address |
| `GRIEVANCE_EMAIL` | Production | `nightlifezofficial@gmail.com` | Statutory grievance contact address |
| `GRIEVANCE_OFFICER_NAME`| Production | `Grievance Officer` | Official contact name for legal compliance |
| `LEGAL_ENTITY_NAME` | Production | `NIGHTLIFEZ` | Registered operational legal entity |
| `ENABLE_LIVE_PAYMENTS`| Production & Preview | `false` | Master kill switch for live payment collection |
| `UPI_CHECKOUT_ENABLED`| Production & Preview | `false` | Kill switch for native UPI checkout routing |

---

## 3. Database Architecture & Migration Execution

### A. Environment Isolation
- **Production Endpoint:** `ep-dawn-glitter-b4mkwxkl` (Branch: `production`).
- **Preview Endpoint:** `ep-green-hall-b47clnq0` (Branch: `preview`).
- **Safety Rails:** Production endpoint identifiers are strictly registered in `DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS` within `lib/config.js`. If a non-production deployment attempts to bind to the Production database, execution halts immediately with a fatal error.

### B. Migration Pipeline (`scripts/migrate.js`)
- The build command is mapped in `package.json`:
  ```bash
  "vercel-build": "node scripts/migrate.js"
  ```
- **Production Builds:** Automatically execute pending migrations (`003` through `020`) sequentially under an advisory lock (`pg_advisory_lock(839201948)`).
- **Preview Builds:** Automatically skip migrations unless `MIGRATE_ON_PREVIEW=true` is set and the database URL points to a non-production branch.

---

## 4. Release & Deployment Pipeline

```
 [candidate/production-readiness] 
                │
                ▼ Pull Request #45 (CI Suite: Lint, Unit, Integration, E2E)
          [launch-mvp]
                │
                ▼ Pull Request #17 (Production Release Gate)
            [main] ──────► Automatic Vercel Production Build & Deploy
                                  │
                                  ├─ 1. Advisory Lock Acquired
                                  ├─ 2. Migrations 003-020 Executed
                                  └─ 3. Atomic Edge Activation
```

### Promotion Steps:
1. Candidate branch `candidate/production-readiness` undergoes complete CI verification.
2. PR #45 merges approved candidate commits into `launch-mvp`.
3. PR #17 merges `launch-mvp` into `main` upon explicit owner signoff.
4. Vercel automatically deploys the release to `https://nightlifez.com`.

---

## 5. Post-Deployment Verification Checklist

Immediately following a production deployment:

1. **System Health Endpoint:**
   ```bash
   curl -s https://nightlifez.com/api/health
   # Expected output: {"ok":true,"database":"ok","config":{...}}
   ```
2. **Permanent 308 Redirect Verification:**
   ```bash
   curl -sI https://www.nightlifez.com
   # Expected: HTTP/2 308 -> Location: https://nightlifez.com/
   ```
3. **Primary Experience Routes:**
   - Homepage: `https://nightlifez.com/` (200 OK)
   - Events Feed: `https://nightlifez.com/events` (200 OK)
   - Contact Page: `https://nightlifez.com/contact` (200 OK)
   - Trust & Safety: `https://nightlifez.com/trust-safety` (200 OK)
   - Host Portal: `https://nightlifez.com/become-a-host` (200 OK)
   - Venue Portal: `https://nightlifez.com/list-your-venue` (200 OK)
