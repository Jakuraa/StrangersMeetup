# NIGHTLIFEZ — Environment Readiness & Secrets Inventory

**Single source of truth for environment variable requirements, secrets presence, security boundaries, and Preview/Production readiness.**

---

## 1. Environment Variable Audit & Classification

In strict compliance with security boundaries, this audit inspects **variable names and presence only**. Secret values, passwords, private keys, and tokens are **never logged, exposed, or committed**.

### Master Environment Variable Inventory

| Variable Name | Required By | Scoped in Production | Scoped in Preview | Status / Classification | Security Constraint |
|---|---|---|---|---|---|
| `DATABASE_URL` | Application core | **Present** (created 7d ago) | **Present** (created 4d ago) | **Configured & Isolated** | Pooled Postgres connection string |
| `DATABASE_URL_UNPOOLED` | Migrations / DDL | **Present** (created 7d ago) | **Present** (created 4d ago) | **Configured & Isolated** | Direct Postgres connection string |
| `MIGRATE_ON_PREVIEW` | Migration gating | N/A | **Present** (`true`) | **Configured** | Preview-only migration toggle |
| `ISOLATED_PREVIEW_DB` | Safety rail | N/A | **Present** (`true`) | **Configured** | Required for Preview writes |
| `ALLOW_PREVIEW_TELEGRAM` | Safety rail | N/A | **Present** | **Configured** | Controls Telegram in Preview |
| `SESSION_SECRET` | Auth sessions | **MISSING** (Gate 2) | Fallback / Preview | ⚠️ **Required for Gate 2** | Minimum 32-character random secret |
| `CRON_SECRET` | Scheduled cron | **MISSING** (Gate 2) | Fallback / Preview | ⚠️ **Required for Gate 2** | Minimum 16-character random secret |
| `TELEGRAM_BOT_TOKEN` | Bot API & Auth | **Present** | **Present** | **Configured** | Canonical BotFather bot token |
| `TELEGRAM_BOT_USERNAME` | Web login widget | **MISSING** (Gate 2) | Fallback / Preview | ⚠️ **Required for Gate 2** | Bot handle without `@` prefix |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook security | **MISSING** (Gate 2) | Fallback / Preview | ⚠️ **Required for Gate 2** | 16–256 char URL-safe token |
| `TG_CHAT_ID_EVENTS` | Event alert broadcast | **MISSING** (Gate 2) | Fallback / Preview | ⚠️ **Required for Gate 2** | Target channel/group numeric ID |
| `ADMIN_BOOTSTRAP_TELEGRAM_ID` | Initial super admin | **MISSING** (Gate 2) | Fallback / Preview | ⚠️ **Required for Gate 2** | Owner's numeric Telegram User ID |
| `PUBLIC_SITE_URL` | Canonical links | **MISSING** (Gate 2) | Auto (`VERCEL_URL`) | ⚠️ **Required for Gate 2** | `https://nightlifez.com` (or preview) |
| `SUPPORT_EMAIL` | Statutory / contact | **MISSING** (Gate 2) | Default | ⚠️ **Required for Gate 2** | `contact@nightlifez.com` |
| `LEGAL_ENTITY_NAME` | Terms & Privacy | **MISSING** (Gate 2) | Placeholder | ⚠️ **Required for Gate 2** | Statutory company / entity name |
| `GRIEVANCE_OFFICER_NAME` | Statutory (India IT) | **MISSING** (Gate 2) | Placeholder | ⚠️ **Required for Gate 2** | Required by Indian IT Rules 2021 |
| `GRIEVANCE_EMAIL` | Statutory (India IT) | **MISSING** (Gate 2) | Placeholder | ⚠️ **Required for Gate 2** | Grievance officer direct email |
| `ENABLE_LIVE_PAYMENTS` | Payments kill switch | **Unset (Evaluates false)** | **Unset (Evaluates false)** | **SECURED (Free-Only MVP)** | Must remain `false` / unset |
| `BLOCKED_PRODUCTION_ENDPOINTS` | Safety rail | N/A | Optional | **Supported** | Dynamic production block list |
| `SUPERPROFILE_WEBHOOK_SECRET` | External payments | Unset | Fallback | Optional (Disabled in Free MVP) | Required only if live payments on |

---

## 2. Secrets Management & Operational Security

### 2.1. Free-Only MVP Baseline
- `ENABLE_LIVE_PAYMENTS` is unset / `'false'` across all environments. Paid tickets cannot be checked out; only free guest tickets operate.
- Ticket reservations go through free-tier booking routes (`POST /api/events/:id/book`).
- Payment provider SDKs (Razorpay, Cashfree) have been completely expunged from the codebase in previous milestones.

### 2.2. Preview Reviewer Isolation
- Reviewer sign-in (`POST /api/auth/preview-reviewer`) is strictly available only on Preview environments where `VERCEL_ENV === 'preview'`.
- Reviewer sessions grant guest attendee privileges only; access to `/admin` or organiser mutation tools returns HTTP 403.
- Production environments (`VERCEL_ENV === 'production'` or matching any blocked production database endpoint) return HTTP 404 for reviewer endpoints.

---

## 3. Preview Readiness Verification

The canonical integration branch `launch-mvp` @ commit `83a30a7` has been deployed and verified on Vercel:

### Deployment Evidence
- **Deployment ID:** `dpl_5bwWwcYWVx5cwcxXZNFZt2fhA73C`
- **Deployment Status:** `● Ready` (Built and deployed in 10s)
- **Target:** `preview`
- **Git Commit:** `83a30a7` (`launch-mvp`)
- **Canonical Preview URL:** `https://strangersmeetup-1e658ssoq-jakuraa.vercel.app`
- **Branch Alias:** `https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app`
- **Database Migrations:** `[migrate] done (0 applied; vercel preview with MIGRATE_ON_PREVIEW=true and confirmed isolated database)`

### Vercel Deployment Protection Status
- **SSO Protection:** Active (`all_except_custom_domains`).
- **Access Behavior:** HTTP GET requests return `HTTP/2 302` redirecting unauthenticated users to `https://vercel.com/sso-api`. Public search spiders and unauthorized crawlers are completely blocked (`x-robots-tag: noindex`).
- **Owner Action (Owner Gate 6):** For automated external testing, the owner can provide the Protection Bypass for Automation secret (configured in Vercel Project Settings $\rightarrow$ Deployment Protection).

---

## 4. Outstanding Owner Actions for Production Release

To advance from Preview to Production release, the following Owner Gates remain pending owner completion:

1. **Owner Gate 1:** Approve Pull Request #17 (`launch-mvp` $\to$ `main`).
2. **Owner Gate 2:** Populate the 8 missing Production environment variables in Vercel Project Settings:
   - `SESSION_SECRET`
   - `CRON_SECRET`
   - `TELEGRAM_BOT_USERNAME`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `TG_CHAT_ID_EVENTS`
   - `ADMIN_BOOTSTRAP_TELEGRAM_ID`
   - `PUBLIC_SITE_URL`
   - `SUPPORT_EMAIL`
3. **Owner Gate 3:** Confirm the Production Neon compute endpoint from Vercel $\rightarrow$ Storage.
4. **Owner Gate 4:** Domain & DNS configuration for `nightlifez.com` (Cloudflare/Vercel).
5. **Owner Gate 5:** BotFather `/setdomain` binding to `nightlifez.com`.
6. **Owner Gate 8:** Populate legal disclosures (`LEGAL_ENTITY_NAME`, `GRIEVANCE_OFFICER_NAME`, `GRIEVANCE_EMAIL`).
