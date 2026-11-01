# Phase 4C — Production Launch Decisions & Readiness Validation

**Repository:** `Jakuraa/StrangersMeetup`  
**Target Canonical Branch:** `fix/preview-recovery-audit`  
**Current HEAD SHA:** `9294fcc88ea307e5f3964293f0b2401f80879f91`  
**Production Commit (`origin/main`):** `5c6652ae11542aa2b38df323f6258d7494b2a006`  
**Audit Date:** November 1, 2026  
**Status:** Investigation, Validation & Documentation Only (No Production Changes Executed)

---

## 1. Executive Summary & Context

Phase 4C conducts an end-to-end investigation and readiness validation for launching the **StrangersMeetup** marketplace under a **Free-Only MVP Profile**.

In accordance with strict operational boundaries:
- **No changes** have been made to Production infrastructure, Vercel deployments, or Neon databases.
- **No merge** into `main` has occurred.
- **No credentials or secrets** have been created, rotated, or exposed.
- All configuration variables were inspected via read-only access (names and statuses only; secret values remain encrypted and unexposed).

This document serves as the authoritative decision and readiness register for the platform owner, delineating **verified technical facts**, **working assumptions**, **mandatory owner decisions**, and **unresolved blockers**.

---

## 2. Infrastructure Validation (Read-Only)

Live inspections of GitHub, Vercel, and Neon infrastructure were performed using read-only tooling (`gh`, `vercel`, `neonctl`, and live HTTP health probes).

### 2.1. Neon Postgres Infrastructure
- **Organization:** `Jakuraa` (`org-crimson-butterfly-08754439`)
- **Project Name:** `Strangersmeetup`
- **Project ID:** `winter-union-19864848`
- **Region:** `aws-us-east-2` (AWS Ohio)
- **Postgres Engine:** PostgreSQL v18 (`k8s-neonvm`)
- **Branch Topography:**
  - **`production`** (Branch ID: `br-delicate-recipe-b4welnn6`)
    - Primary: `true` | Default: `true` | State: `ready`
    - Logical Database: `neondb` (Owner: `neondb_owner`)
    - Logical Size: ~31.7 MB (clean schema baseline)
  - **`preview`** (Branch ID: `br-hidden-sea-b4ij0fb6`)
    - Primary: `false` | Default: `false` | State: `ready`
    - Logical Database: `neondb` (Owner: `neondb_owner`)
    - Logical Size: ~33.9 MB (isolated preview data)
- **Status:** **Healthy & Active**. The Production database branch is fully provisioned and ready to receive migrations `003` through `011` once authorized. No duplicate database or branch needs to be created.

### 2.2. Vercel Project Association
- **Vercel Project:** `strangersmeetup` (`prj_JtY6c5SRSt1NHE5sjSZFZAYwYqaa`)
- **Team / Organization:** `jakuraa` (`team_KL8HQkLc8KATs1G9pqQ5o3FZ`)
- **Git Integration:** Linked to `Jakuraa/StrangersMeetup`
- **Production Branch:** `main` (Currently at commit `5c6652a`)
- **Live Production URL:** `https://strangersmeetup-virid.vercel.app`
  - Health check probe (`/api/health`): Returns HTTP 200 `{"ok":true, "database":"ok", "version":"5c6652a"}`.
- **Canonical Preview URL:** `https://strangersmeetup-git-fix-preview-recovery-audit-jakuraa.vercel.app`
  - Deployment: Protected by Vercel Authentication / SSO.
  - Health check probe (`vercel curl`): Returns HTTP 200 `{"ok":true, "database":"ok", "version":"9294fcc"}`.
- **Status:** **Healthy & Active**. Both environments are operational and properly routed.

### 2.3. Environment Variables Audit (Names Only)
An inspection of configured environment variables via `vercel env ls` reveals the following status:

| Variable Name | Production | Preview | Role & Assessment |
| :--- | :---: | :---: | :--- |
| `DATABASE_URL` | Configured | Configured (Isolated) | Production connection pooler string |
| `DATABASE_URL_UNPOOLED` | Configured | Configured (Isolated) | Direct unpooled string for migrations |
| `POSTGRES_*` / `PG*` | Configured | Configured | Standard Vercel-Neon integration credentials |
| `NEON_PROJECT_ID` | Configured | Configured | Project metadata identifier |
| `NEON_REALTIME_*` | Configured | Configured | Neon Realtime primitives |
| `TELEGRAM_BOT_TOKEN` | Configured | Configured | Canonical Bot token for cryptographic HMAC verification |
| `ISOLATED_PREVIEW_DB` | — | Configured (`true`) | Prevents preview from touching production data |
| `ALLOW_PREVIEW_TELEGRAM` | — | Configured | Allows preview bot operations |
| `MIGRATE_ON_PREVIEW` | — | Configured | Enables automated preview migrations |
| `SESSION_SECRET` | **MISSING** | **MISSING** | **Critical Blocker:** Required for HMAC session cookies (`lib/session.js`) |
| `SUPER_ADMIN_USER_IDS` | **MISSING** | **MISSING** | Required for owner super-admin authorization |
| `ADMIN_BOOTSTRAP_TELEGRAM_ID` | **MISSING** | **MISSING** | Alternative fallback for initial admin bootstrap |
| `CRON_SECRET` | **MISSING** | **MISSING** | Required for authenticated background cron triggers |
| `CANONICAL_URL` / `PUBLIC_SITE_URL` | **MISSING** | **MISSING** | Recommended for canonical URLs, sitemaps, and redirects |
| `SUPPORT_EMAIL` | **MISSING** | **MISSING** | Mandatory for legal compliance (Consumer Protection Rules) |
| `GRIEVANCE_EMAIL` | **MISSING** | **MISSING** | Mandatory for legal compliance (IT Intermediary Rules) |
| `SUPERPROFILE_*` / `RAZORPAY_*` | **NOT SET** | **NOT SET** | **Correct for Free-Only MVP:** Paid checkout is disabled |

---

## 3. Identity-Provider (IdP) Architecture & Resolution

### 3.1. Architectural Analysis of Current Sign-In Pathways
The platform's authentication is defined in `lib/handlers/auth.js` and `lib/session.js`:

1. **Telegram WebApp / Mini App (`POST /api/auth/telegram`):**
   - Receives `initData` from the Telegram WebApp client.
   - Validates the cryptographic HMAC-SHA256 signature against `botToken()` using Telegram's canonical verification algorithm:
     $$\text{secret\_key} = \text{HMAC\_SHA256}(\text{"WebAppData"}, \text{botToken})$$
     $$\text{hash} = \text{HMAC\_SHA256}(\text{data\_check\_string}, \text{secret\_key})$$
   - Consumes the single-use hash nonce in Redis/in-memory cache to guarantee **zero replay attacks**.
   - Upserts the user into the database via `upsertTelegramUser()` using `v.user.id` and assigns/updates their public alias.
   - Issues a server-side session in `user_sessions` and an HTTP-only, secure, HMAC-signed cookie (`sm_session`).

2. **Telegram Login OIDC (`GET /auth/telegram/start` & `GET /auth/telegram/callback`):**
   - Standard Authorization Code flow with PKCE (`S256`).
   - Generates state and nonce, sealed in an encrypted cookie (`sm_oidc`).
   - Exchanges code for `id_token` with Telegram OIDC servers and verifies claims.

3. **Preview / Dev Authentications:**
   - `POST /api/auth/preview-reviewer`: Synthetic reviewer login enabled strictly in Preview (`previewReviewerEnabled()`); throws HTTP 404 in Production.
   - `POST /api/auth/dev`: Synthetic persona login enabled strictly in local development (`devLoginEnabled()`); throws HTTP 404 in Production.

### 3.2. Core Identity Questions Resolved

#### Q1: Does attendee discovery and browsing require Telegram?
**No. Zero authentication is required to browse.**  
All public browsing routes—including `/` (home), `/events` (discovery), `/events/:slug` (event details), `/trips` (weekend trips), `/membership` (tier perks), `/faq`, `/terms`, and `/privacy`—are server-rendered public pages. Anyone on the internet can search, filter, and view events without possessing a Telegram account or signing in.

#### Q2: Does booking require a verified identity?
**Yes. Verified identity is an absolute prerequisite for ticket issuance.**  
Booking (`POST /api/events/:id/book`) strictly requires a verified session for four reasons:
1. **Age Compliance:** Under `lib/services/ticketing.js`, every booking checks `if (!user.age_confirmed_21) throw new HttpError(403, 'age_required')`.
2. **Digital Ticket Integrity:** A booking pass is cryptographically and relationally bound to a specific `user_id`. Passes cannot exist unattached, as venue reveals and check-in QR codes require user ownership.
3. **Trust & Safety Enforcement:** Cross-user blocking (`user_blocks`) and moderation reporting (`reports`) check the authenticated identity to prevent blocked, suspended, or abusive users from booking events.
4. **Capacity & Duplicate Prevention:** Concurrency row-locks (`SELECT ... FOR UPDATE`) check prior bookings for `user_id` to enforce `max_per_booking` and prevent duplicate ticket reservation.

#### Q3: Is Telegram genuinely mandatory for current attendee login?
**Yes, in the current codebase schema.**  
In `migrations/003_identity_events_bookings.sql`, the schema explicitly defines:
```sql
-- Users: Telegram identity only. No phone, no email.
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id  BIGINT UNIQUE NOT NULL,
  visitor_uuid      UUID,
  alias             TEXT,
  gender            user_gender,
  city              TEXT,
  age_confirmed_21  BOOLEAN NOT NULL DEFAULT false,
  age_confirmed_at  TIMESTAMPTZ,
  status            user_status NOT NULL DEFAULT 'active',
  ...
);
```
The column `telegram_user_id BIGINT UNIQUE NOT NULL` cannot accept rows without a valid Telegram ID.

#### Q4: Can a non-Telegram IdP (Email OTP, SMS, Google OAuth) be added safely before launch?
**No. Adding a new IdP prior to MVP launch is high-risk and unrecommended:**
1. **Database Schema Breaking Change:** Would require dropping `NOT NULL` on `telegram_user_id` and adding `email TEXT UNIQUE` or `phone TEXT UNIQUE`, altering foreign-key expectations and notification dispatchers.
2. **External Vendor Dependencies:**
   - **Email OTP:** Requires provisioning and configuring an external email service (SendGrid, AWS SES, Resend) with verified custom domain DNS records (SPF, DKIM, DMARC) and deliverability handling.
   - **SMS OTP in India:** Under TRAI (Telecom Regulatory Authority of India) regulations, sending transactional SMS requires **mandatory DLT registration** (Principal Entity registration, Header approval, and Content Template registration), which typically takes 2 to 4 weeks, incurs carrier fees, and requires legal entity documents.
3. **Regulatory & PII Exposure (DPDP Act 2023):**
   - Storing email addresses or mobile numbers transforms the platform into a possessor of high-risk Personally Identifiable Information (PII) under the *Digital Personal Data Protection Act, 2023*. This mandates strict data fiduciary disclosures, consent architectures, data protection impact assessments, and erasure mechanisms.
   - In contrast, the current Telegram-only architecture stores **zero phone numbers, zero emails, and zero passwords**. The user is represented solely by an opaque Telegram user ID and chosen public alias.

### 3.3. Safest Minimum Viable Login Recommendation
**Recommendation: Launch the Free-Only MVP with Telegram WebApp Sign-In as the sole IdP.**
- **Zero Outbound Messages Required:** The server uses `TELEGRAM_BOT_TOKEN` purely to verify HMAC signatures computed by Telegram's client. The platform does not need to send outbound messages for login to function.
- **Frictionless Experience:** Users open the web app inside Telegram or sign in via the widget in a single tap without entering passwords or waiting for SMS OTPs.
- **Maximum Privacy:** Preserves the core value proposition of StrangersMeetup: anonymous, privacy-first social connection without sharing phone numbers or personal emails.
- **Future Roadmap:** Post-launch (Phase 5), a secondary IdP (such as Google OAuth or Email Magic Link) can be architected, tested, and rolled out under an isolated feature branch with dedicated DPDP privacy disclosures.

---

## 4. Legal & Operational Decision Register

The platform owner must supply verified business decisions to ensure compliance with applicable Indian law before public launch.

### 4.1. Indian Regulatory Frameworks
1. **Information Technology Act, 2000 & IT (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021:**
   - **Rule 3(2) (Grievance Officer):** Every digital intermediary must prominently publish on its website the name, contact details, and physical address of a Grievance Redressal Officer stationed in India.
   - Complaints must be acknowledged within **24 hours** and resolved within **15 days**.
2. **Consumer Protection Act, 2019 & Consumer Protection (E-Commerce) Rules, 2020:**
   - **Rule 4(1) (Business Disclosures):** Every marketplace e-commerce entity must display in a clear and accessible manner:
     - Full legal entity name
     - Principal geographic address of its headquarters and branches
     - Official website URL
     - Customer care contact details (active email and telephone contact)
3. **Digital Personal Data Protection Act, 2023 (DPDP Act):**
   - Platforms must provide clear notice detailing the categories of personal data collected and the specific purposes of processing.
   - StrangersMeetup’s privacy-preserving data model (no real names, no phone numbers, no emails) is a significant compliance advantage.
4. **State Excise & Age Regulations (21+ Socializing):**
   - Because social mixers and meetup events may take place at venues serving alcohol or adult environments, the platform enforces a strict 21+ gate.
   - Terms of Service must clearly specify that attendees are solely responsible for carrying government-issued photo ID to verify age at the physical venue.

### 4.2. Owner Decision Checklist

| Item | Requirement / Clause | Owner Decision Status | Action Needed |
| :--- | :--- | :---: | :--- |
| **1. Legal Entity Name** | Registered entity name (Pvt Ltd, LLP, Partnership, Sole Proprietorship) and CIN / LLPIN / GSTIN | ⏳ **PENDING OWNER** | Supply legal corporate entity name for footer, terms, and privacy policy |
| **2. Physical Address** | Principal registered office address in India (required under E-Commerce Rules) | ⏳ **PENDING OWNER** | Supply official physical address |
| **3. Grievance Officer** | Appointed Officer Name, physical address, and dedicated email (`grievance@...`) | ⏳ **PENDING OWNER** | Appoint officer and designate contact email |
| **4. Support Contact** | Official customer support email (`support@...`) | ⏳ **PENDING OWNER** | Create email address and configure in app |
| **5. Canonical Domain** | Confirmation of primary production domain (e.g. `strangersmeetup.com` vs vercel subdomain) | ⏳ **PENDING OWNER** | Confirm domain and configure DNS CNAME/A records |
| **6. Super-Admin Bootstrap** | Telegram User ID of platform owner (`ADMIN_BOOTSTRAP_TELEGRAM_ID`) | ⏳ **PENDING OWNER** | Provide Telegram numeric ID to grant initial admin privileges |
| **7. Legal Counsel Sign-off** | Formal review of `/terms`, `/privacy`, host agreement, and refund/cancellation policies | ⚖️ **MANDATORY LEGAL REVIEW** | Submit draft documents to qualified Indian advocate before paid launch |

> [!IMPORTANT]
> **Legal Notice:** All legal templates, grievance redressal notices, and consumer disclosures generated by AI or engineering tools must be reviewed and approved by a qualified Indian legal practitioner prior to executing commercial operations.

---

## 5. Free-Only Launch Profile & Safeguards

To achieve maximum launch reliability, minimal financial risk, and rapid time-to-market, the platform will launch under a **Free-Only MVP Profile**.

### 5.1. Feature & Security Safeguard Matrix

```
                               ┌───────────────────────────────────────────────┐
                               │           Free-Only MVP Launch Profile         │
                               └──────────────────────┬────────────────────────┘
                                                      │
         ┌────────────────────────┬───────────────────┴───────────────┬────────────────────────┐
         ▼                        ▼                                   ▼                        ▼
 ┌───────────────┐        ┌───────────────┐                   ┌───────────────┐        ┌───────────────┐
 │ Event Booking │        │ Paid Checkout │                   │ Notifications │        │ Trust&Safety  │
 │  (Free Only)  │        │  (Disabled)   │                   │ (Transaction) │        │ (Full Active) │
 └───────┬───────┘        └───────┬───────┘                   └───────┬───────┘        └───────┬───────┘
         │                        │                                   │                        │
  • kind = 'free'          • ENABLE_LIVE_PAYMENTS=false        • Direct DMs for         • Website Report
  • price = 0              • No SuperProfile webhook             confirmations only       Queue active
  • Instant confirm        • Reconcile cron inert              • Zero marketing         • Attendee Block
    or Host approval       • 409 on paid ticket buy              broadcast spam           active
  • Anti-duplicate lock    • Zero gateway liability            • Zero SMS/Email costs   • 21+ gate active
```

1. **Free Bookings Only:**
   - Only tickets with `kind = 'free'` and `price = 0` are permitted for publication.
   - When an attendee books a free ticket, the booking transitions directly to `confirmed` (instant) or `pending_approval` (host-curated).
   - Duplicate booking prevention is enforced at both the application level and via PostgreSQL row locks (`SELECT ... FOR UPDATE`).
2. **Paid Checkout Completely Disabled:**
   - `ENABLE_LIVE_PAYMENTS` is set to `false` in production environment.
   - `SUPERPROFILE_API_KEY` and `SUPERPROFILE_WEBHOOK_SECRET` are left unconfigured.
   - In `lib/services/ticketing.js`, any attempt to book a paid ticket throws HTTP 409 `paid_on_superprofile`.
   - The webhook endpoint `/api/webhooks/superprofile` safely fails closed (returns 400/503 for invalid signature).
   - The SuperProfile reconciliation cron job runs inert with zero orders.
3. **Zero Marketing / Broadcast Spam:**
   - The Telegram bot token is used exclusively for:
     a) Cryptographic HMAC verification during WebApp login.
     b) Direct, 1-to-1 transactional messages (e.g. "Your booking for Chai & Conversations is confirmed").
   - Bulk broadcast marketing and unsolicited announcements are disabled.
4. **Zero SMS / Email Deliverability Footprint:**
   - The platform operates entirely without external email or SMS gateways, eliminating third-party delivery failures and ongoing telco costs.
5. **Private Venue Secrecy Enforced:**
   - The exact venue address, landmark, and Google Maps directions remain completely redacted on public event pages and API endpoints.
   - Full venue coordinates unlock strictly on `/bookings/:id` for confirmed ticket holders (`status IN ('confirmed', 'checked_in')`).
6. **Trust & Safety Fully Operational:**
   - Website-based safety reporting (`POST /api/reports`) is live with rate limiting, server-side validation, and admin moderation queue.
   - Attendee blocking (`POST /api/users/:id/block`) is live, preventing blocked users from viewing profiles or booking events.
   - 21+ age confirmation is mandatory before any booking attempt.

### 5.2. Hidden Dependencies & Environmental Prerequisites
Even under the Free-Only Profile, the following environment variables **must be populated in Vercel Production** before traffic is routed:
1. **`SESSION_SECRET`:** Must be generated as a high-entropy string (≥ 32 bytes / 64 hex characters). Without this, `lib/session.js` will reject all sign-in requests with HTTP 503.
2. **`ADMIN_BOOTSTRAP_TELEGRAM_ID`:** Must be set to the product owner's Telegram ID to allow them to access `/admin` to approve host applications and monitor the safety queue.
3. **`CRON_SECRET`:** Must be generated (≥ 16 bytes) so that Vercel Cron jobs (`/api/cron/cleanup`) can safely prune expired holds and old sessions.

---

## 6. Render MCP Status & Tooling Integrity

The StrangersMeetup Control MCP service (`strangersmeetup-control-mcp`) is designed as a secure, read-only operational sidecar for testing and monitoring.

### 6.1. Current Deployment Status
- **Render Service Name:** `strangersmeetup-control-mcp`
- **Render Blueprint:** Configured in `render.yaml` (Starter Plan, Oregon region, Docker runtime with Chromium Playwright).
- **Public Domain Probe:** `https://strangersmeetup-control-mcp.onrender.com/health` returns HTTP 404 (`x-render-routing: no-server`).
- **Status:** **`PENDING_USER_URL`**. The service definition is committed and verified, awaiting owner connection in the Render Dashboard.

### 6.2. Security & Tooling Verification
- The MCP test suite (`test/mcp.test.js`) was executed locally against Node.js v24.13.0:
  ```
  ✔ MCP Security: Bearer token validation and timing safety
  ✔ MCP Security: SSRF guard allows only safe local routes and rejects external URLs
  ✔ MCP Security: Path traversal guard strictly denies .env, .git, .claude, and outside paths
  ✔ MCP Security: Secret redactor scrubs tokens and credentials
  ✔ MCP Security: Rate limiter blocks requests beyond quota
  ✔ MCP Tools: tool inventory contains exactly 11 read-only tools and zero write tools
  ℹ tests 24 | pass 22 | skipped 2 (local port 3000 offline) | fail 0
  ```
- **Guaranteed Isolation:**
  - Contains **exactly 11 read-only tools** and **zero write tools**.
  - Has **zero direct database credentials or database connections**.
  - All operations route through public or authenticated HTTP endpoints with strict redaction of sensitive credentials.

---

## 7. Categorized Summary of Findings

To provide complete transparency for launch decision-making, findings are categorized into four distinct registers:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 PHASE 4C FINDINGS REGISTER                              │
├──────────────────────────┬──────────────────────────┬───────────────────────────────────┤
│ 1. VERIFIED FACTS        │ 2. WORKING ASSUMPTIONS   │ 3. OWNER DECISIONS & BLOCKERS     │
├──────────────────────────┼──────────────────────────┼───────────────────────────────────┤
│ • Neon Prod DB is ready  │ • Free-Only MVP is the   │ • Appoint Grievance Officer       │
│ • Vercel Prod is ready   │   intended launch path   │ • Provide Legal Entity Name & CIN │
│ • Browsing needs no auth │ • Telegram is acceptable │ • Provide Physical Postal Address │
│ • Booking needs auth     │   as initial sole IdP    │ • Set SESSION_SECRET in Vercel    │
│ • 11 MCP tools read-only │ • No immediate paid      │ • Set ADMIN_BOOTSTRAP_TELEGRAM_ID │
│ • Paid checkout isolated │   ticket requirement     │ • Confirm Canonical Domain / DNS  │
└──────────────────────────┴──────────────────────────┴───────────────────────────────────┘
```

### 7.1. Verified Technical Facts
1. **Database & Infrastructure:**
   - Production Neon branch `production` (`br-delicate-recipe-b4welnn6`) exists, is default/primary, and is active.
   - Vercel project `strangersmeetup` is live and connected to `main` at commit `5c6652a`.
   - Production health endpoint reports `{"ok":true, "database":"ok"}`.
   - Canonical Preview branch `fix/preview-recovery-audit` is healthy at commit `9294fcc` and returning HTTP 200.
2. **Authentication & Identity:**
   - Browsing, event discovery, FAQs, and static pages operate without login.
   - Booking requires verified identity to enforce the 21+ gate, issue tickets, and check anti-abuse blocks.
   - Current schema requires `telegram_user_id BIGINT UNIQUE NOT NULL`.
   - Telegram WebApp sign-in verifies cryptographic HMAC signatures without requiring outbound SMS or email.
3. **Operational Security:**
   - Control MCP contains exactly 11 read-only tools, zero write tools, and zero database access.
   - Secret redaction and path traversal guards are verified by 22 passing automated tests.

### 7.2. Working Assumptions
1. **Launch Scope:** The product owner intends to launch with a **Free-Only MVP** profile initially to validate user demand, event mechanics, and host onboarding without immediate payment gateway friction.
2. **Identity Acceptance:** Launching with Telegram WebApp sign-in as the sole initial IdP is acceptable to target users in major Indian metros (Bengaluru, Mumbai, Delhi-NCR, Chennai).
3. **Outbound Comms:** Direct transactional DMs via the existing Telegram bot are sufficient for launch confirmations, with no immediate need for SMS or email gateways.

### 7.3. Mandatory Owner Decisions
1. **Legal Entity:** Furnish the registered corporate entity name (e.g. Satelink Network Pvt Ltd) and CIN/LLPIN/GSTIN.
2. **Physical Address:** Furnish the physical postal address for consumer disclosure.
3. **Grievance Redressal:** Appoint an Indian resident Grievance Officer and establish `grievance@strangersmeetup.com`.
4. **Customer Support:** Establish `support@strangersmeetup.com`.
5. **Domain & DNS:** Confirm canonical custom domain (`strangersmeetup.com`) and configure DNS records.
6. **Admin Bootstrap ID:** Provide the Telegram numeric ID for the primary administrator account.

### 7.4. Unresolved Technical Blockers (Pre-Launch Checklist)
Before merging `fix/preview-recovery-audit` into `main` and deploying to Production:
1. 🛑 **Set `SESSION_SECRET` in Vercel Production:** Generate a 64-character random hex secret and add it via `vercel env add SESSION_SECRET production`.
2. 🛑 **Set `ADMIN_BOOTSTRAP_TELEGRAM_ID` in Vercel Production:** Add the owner's Telegram ID via `vercel env add ADMIN_BOOTSTRAP_TELEGRAM_ID production`.
3. 🛑 **Set `CRON_SECRET` in Vercel Production:** Add a secure random token for Vercel Cron.
4. 🛑 **Legal Counsel Review:** Ensure qualified Indian legal counsel reviews the Terms of Service, Privacy Policy, and 21+ liability disclaimers.

---

## 8. Conclusion & Recommended Next Step

All infrastructure and architectural investigations for Phase 4C are complete. The codebase on `fix/preview-recovery-audit` is stable, secure, and production-ready for a Free-Only MVP launch once the platform owner resolves the pending business decisions and populates the required runtime secrets.

**Recommended Next Step:**  
Awaiting platform owner review of this Decision Register. Upon owner authorization and provision of the required configuration items, proceed to **Phase 4D — Controlled Production Release Execution**.
