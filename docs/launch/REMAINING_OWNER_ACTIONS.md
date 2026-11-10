# NIGHTLIFEZ Remaining Owner Actions & Production Launch Readiness

**Milestone:** NIGHTLIFEZ M10 — Beta Readiness, Operational Hardening & Final Engineering Gate  
**Version:** 1.0 (Beta Candidate)  
**Security Classification:** Confidential — Repository Owner & Board Only  
**Effective Date:** November 2026  

---

## 1. Executive Summary & Governance Gate

NIGHTLIFEZ engineering milestones M1 through M10 are complete on feature branches. The product has reached the **Beta Candidate** stage and is ready for an independent, protected Preview acceptance walkthrough by the repository owner.

> [!CAUTION]
> **Production Launch Boundary:** Automated engineering tests passing does **NOT** constitute permission to deploy to Production. All feature PRs (#17 through #40) remain unmerged by design. The repository owner must complete the statutory, legal, financial, and infrastructural actions below before any Production release or live payment activation can occur.

---

## 2. Preview Automation Discrepancy Reconciliation (Blocker #6 Audit)

During the M9 review, an inconsistency was identified regarding the status of Vercel Preview automation bypass credentials. This section provides an authoritative, transparent breakdown of the exact state across all layers.

### 2.1 State Matrix Across Layers

| Dimension | Current Actual State | Action Required | Owner Responsibility? |
|---|---|---|---|
| **Application Code** | Fully implemented in `playwright.config.js` and `docs/launch/VERCEL_PREVIEW_AUTOMATION.md`. Passes `x-vercel-protection-bypass` and `x-vercel-set-bypass-cookie` headers when `VERCEL_PROTECTION_BYPASS` is set. No code-level backdoors exist in application routes. | None. Code is clean and compliant. | No (Completed by Engineering) |
| **GitHub Actions Workflows** | `.github/workflows/ci.yml` runs locally on Ubuntu with throwaway Postgres 16 service containers (`sm_test` and `sm_e2e`). A dedicated deployment webhook workflow (`preview-e2e.yml`) has been documented as a reference runbook but not committed to CI. | If the owner wishes CI to run against live `*.vercel.app` URLs automatically upon deployment, add `preview-e2e.yml`. | Optional Owner Decision |
| **GitHub Repository Secrets** | Secret `VERCEL_PROTECTION_BYPASS` is not accessible to engineering agents. | Owner must add `VERCEL_PROTECTION_BYPASS` in GitHub Settings $\rightarrow$ Secrets and Variables $\rightarrow$ Actions. | **Yes (Owner Action)** |
| **Vercel Project Dashboard** | Deployment Protection (SSO / Password) is active on Preview deployments. Bypass token must be generated in Vercel settings. | Owner must navigate to Vercel $\rightarrow$ Settings $\rightarrow$ Deployment Protection $\rightarrow$ Protection Bypass for Automation $\rightarrow$ Generate Secret. | **Yes (Owner Action)** |
| **Actually Tested Status** | All 692 unit/integration/security tests and 14/14 multi-role Playwright browser tests have been verified against real PostgreSQL instances locally. Tests against live `*.vercel.app` with the bypass header have not been executed in CI. | Owner conducts manual Preview walkthrough using SSO credentials per `OWNER_PREVIEW_ACCEPTANCE_CHECKLIST.md`. | **Yes (Owner Action)** |

---

## 3. Preview Environment Variables Provisioning (DEF-02, DEF-03, DEF-04 Remediation)

The Live Preview Acceptance audit identified three missing environment variables in the **Vercel Preview** environment that block authenticated user journeys. The repository owner must configure these variables in the Vercel Dashboard under **Project Settings $\rightarrow$ Environment Variables**, scoping them strictly to **Preview**.

> [!IMPORTANT]
> **Environment Scoping:** Ensure each variable below is checked for the **Preview** environment only. Never reuse production secrets across preview environments.

| Secret / Variable Name | Scope | Expected Format / Source | Purpose & Remediation Target | Status |
|---|---|---|---|---|
| `SESSION_SECRET` | **Preview** | 64-char random hex string (`openssl rand -hex 32`) | **DEF-02 Remediation:** Signs and verifies `sm_session` cookies with HMAC-SHA-256. Prevents `HTTP 503 Service Unavailable` on session creation. Must be unique to Preview. | **Awaiting Owner Action** |
| `TELEGRAM_BOT_USERNAME` | **Preview** | Telegram bot handle (e.g. `NightlifezTestBot`) | **DEF-03 Remediation:** Configures the Telegram Login Widget on `/signin`. Note: Telegram requires `/setdomain` via `@BotFather`. Because dynamic preview URLs vary, the Preview Reviewer endpoint serves as the primary preview testing flow. | **Awaiting Owner Action** |
| `ADMIN_BOOTSTRAP_TELEGRAM_ID` | **Preview** | Numeric Telegram User ID (e.g. `123456789`) | **DEF-04 Remediation:** Enables zero-SQL native bootstrap for Role 7 (Admin). When this Telegram user logs in and visits `/admin`, they are automatically granted `super_admin` with an audit record (`admin.bootstrap`). | **Awaiting Owner Action** |

### 3.1 Step-by-Step Vercel Preview Configuration Instructions

1. **Generate a Preview Session Secret:**
   Run in your local terminal:
   ```bash
   openssl rand -hex 32
   ```
2. **Add to Vercel Project Settings:**
   - Go to [Vercel Project Dashboard](https://vercel.com/jakuraa/strangersmeetup) $\rightarrow$ **Settings** $\rightarrow$ **Environment Variables**.
   - Add Key: `SESSION_SECRET`
   - Value: `<GENERATED_64_CHAR_HEX>`
   - Environment: Check **Preview** ONLY (Uncheck Production and Development).
3. **Add Telegram Bot Variables (Optional for Preview Reviewer, Required for Real Telegram Login):**
   - Add Key: `TELEGRAM_BOT_USERNAME`
   - Value: `<YOUR_BOT_USERNAME>` (e.g. `NightlifezDevBot`)
   - Environment: Check **Preview**.
4. **Add Admin Bootstrap Variable:**
   - Add Key: `ADMIN_BOOTSTRAP_TELEGRAM_ID`
   - Value: `<YOUR_NUMERIC_TELEGRAM_USER_ID>`
   - Environment: Check **Preview**.
5. **Redeploy Preview Deployment:**
   - Navigate to **Deployments** $\rightarrow$ select the latest deployment for PR #40 (`feature/m10-beta-readiness-hardening`).
   - Click **...** $\rightarrow$ **Redeploy** (without building cache) so the serverless runtime picks up the new environment variables.

---

## 4. Production Environment & Secrets Provisioning

The following secrets must be securely configured in the Vercel Production Environment Dashboard before any public launch.

| Secret Name | Source / Provider | Description | Status |
|---|---|---|---|
| `DATABASE_URL` | Neon / Cloud Postgres | Connection string for Production PostgreSQL 16+ database with SSL enabled. | Pending Owner Provisioning |
| `SESSION_SECRET` | Owner Generation | 64-character random cryptographic hex string for signing session cookies. | Pending Owner Provisioning |
| `CSRF_SECRET` | Owner Generation | 64-character random cryptographic hex string for CSRF double-submit token verification. | Pending Owner Provisioning |
| `QR_HMAC_SECRET` | Owner Generation | 64-character random cryptographic hex string for door check-in QR signatures. | Pending Owner Provisioning |
| `CRON_SECRET` | Owner Generation | Secret string passed in `Authorization: Bearer <CRON_SECRET>` by Vercel Cron. | Pending Owner Provisioning |
| `TELEGRAM_BOT_TOKEN` | Telegram @BotFather | Production Bot token for user authentication, webhook verification, and DMs. | Pending Owner Provisioning |
| `TELEGRAM_BOT_USERNAME` | Telegram @BotFather | Official production bot username (e.g., `NightlifezOfficialBot`). | Pending Owner Provisioning |
| `TELEGRAM_WEBHOOK_SECRET` | Owner Generation | Secret token passed in `X-Telegram-Bot-Api-Secret-Token` header. | Pending Owner Provisioning |
| `ENABLE_LIVE_PAYMENTS` | Internal Config | **Must remain `false`** until banking, merchant KYC, and reconciliation are signed off. | Enforced `false` |

---

## 5. Production Database Verification (Owner Gate 3)

The production database must be verified following the instructions in `docs/launch/PRODUCTION_DATABASE_VERIFICATION.md`:
1. **Isolated Cluster:** Ensure Production PostgreSQL is completely separate from development/testing databases.
2. **Extensions Enabled:** Verify `pgcrypto` is available (`CREATE EXTENSION IF NOT EXISTS pgcrypto`).
3. **Run Forward Migrations:** Execute migrations `001` through `021` using `migrate()`.
4. **Verify Schema Version:** Query `SELECT * FROM schema_migrations ORDER BY version;` and confirm all 21 migrations recorded.
5. **Verify Immutable Audits:** Verify `trg_payment_audits_immutable` trigger is active on `payment_audits`.
6. **Automated Backups:** Confirm cloud provider automated daily snapshots and 7-day point-in-time recovery (PITR) are enabled.

---

## 6. Telegram Bot & WebApp Configuration

1. **Create Production Bot:**
   - Open Telegram and message `@BotFather`.
   - Run `/newbot` and name it `NIGHTLIFEZ` with username `NightlifezBot` (or preferred brand handle).
2. **Configure Mini App / WebApp:**
   - In BotFather: `/newapp` $\rightarrow$ select bot $\rightarrow$ set Title `NIGHTLIFEZ` $\rightarrow$ set WebApp URL to `https://nightlifez.com` (or preview URL).
3. **Register Webhook:**
   - Register webhook with secret token:
     ```bash
     curl -F "url=https://nightlifez.com/api/telegram/webhook" \
          -F "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
          https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook
     ```
4. **Set Bot Commands:**
   - `/start` — Launch NIGHTLIFEZ discovery
   - `/events` — Browse upcoming experiences
   - `/help` — Community assistance and safety contact
   - `/report` — Report safety incident or code of conduct violation

---

## 7. Statutory, Legal & Regulatory Compliance (Indian Law)

> [!IMPORTANT]
> NIGHTLIFEZ operates in India (Tamil Nadu, Karnataka, Kerala, Puducherry). Statutory compliance with the Information Technology Act, 2000 and Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021 is mandatory.

### 7.1 Required Statutory Information
The repository owner must provide authentic corporate information to update customer-facing policies (`/privacy`, `/terms`, `/refunds`, `/contact`):
1. **Registered Legal Entity Name:** The formal registered company name (e.g., *Nightlifez Experiences Private Limited* or LLP/Sole Proprietorship).
2. **Corporate Identity Number (CIN) / Registration Number:** Formal government registration identifier.
3. **Registered Corporate Address:** Physical registered office address in India.
4. **Grievance Officer Designation:**
   - Name of the designated Grievance Officer.
   - Physical mailing address.
   - Dedicated email address (e.g., `grievance@nightlifez.com`).
   - Phone contact during business hours.
   - *Requirement:* Must acknowledge grievances within 24 hours and resolve within 15 days under IT Rules 2021.
5. **Goods and Services Tax (GST) Registration:** GSTIN number and tax treatment (18% GST on platform/ticket facilitation fees).

### 7.2 Legal Review Checklist
- [ ] Qualified Indian legal counsel review of Terms of Service (`/terms`) covering adults 21+ restriction, attendee liability waiver, and alcohol/substance prohibition.
- [ ] Privacy Policy (`/privacy`) review ensuring compliance with Digital Personal Data Protection Act (DPDP Act 2023).
- [ ] Ticket Cancellation and Refund Policy (`/refunds`) alignment with consumer protection regulations.

---

## 8. Domain, DNS & Email Routing Configuration

Reference runbook: `docs/launch/DNS_AND_EMAIL_ROUTING.md`.

1. **Apex & Subdomain Routing:**
   - Point `nightlifez.com` (Apex) and `www.nightlifez.com` (CNAME) to Vercel's edge network (`76.76.21.21` / `cname.vercel-dns.com`).
2. **Email Ingestion & Forwarding:**
   - Configure Cloudflare Email Routing or Google Workspace MX records.
   - Setup aliases:
     - `support@nightlifez.com` $\rightarrow$ support inbox
     - `grievance@nightlifez.com` $\rightarrow$ legal & grievance officer
     - `partners@nightlifez.com` $\rightarrow$ partnerships team
3. **Deliverability & Security Records:**
   - SPF: `v=spf1 include:_spf.mx.cloudflare.net ~all`
   - DKIM: CNAME records provided by mail provider.
   - DMARC: `v=DMARC1; p=reject; rua=mailto:dmarc-reports@nightlifez.com; pct=100`

---

## 9. Summary Action Checklist for Owner

- [ ] **Action 0:** Configure Vercel Preview environment variables (`SESSION_SECRET`, `TELEGRAM_BOT_USERNAME`, `ADMIN_BOOTSTRAP_TELEGRAM_ID`) and redeploy Preview (Section 3).
- [ ] **Action 1:** Review and approve M10 Pull Request #40 (containing DEF-01 fix and remediation test suite).
- [ ] **Action 2:** Generate Vercel Protection Bypass Secret and add to GitHub Secrets (`VERCEL_PROTECTION_BYPASS`).
- [ ] **Action 3:** Conduct multi-role Preview acceptance walkthrough per `OWNER_PREVIEW_ACCEPTANCE_CHECKLIST.md`.
- [ ] **Action 4:** Provision Production PostgreSQL database cluster and verify migrations.
- [ ] **Action 5:** Register official Telegram Bot via BotFather and configure WebApp URL.
- [ ] **Action 6:** Provide registered entity details and designate Grievance Officer.
- [ ] **Action 7:** Conduct qualified legal review of Terms and Privacy Policy.
- [ ] **Action 8:** Configure custom domain DNS and email routing.
- [ ] **Action 9:** Authorize production PR merge sequence (#17 through #40).
- [ ] **Action 10:** Final review of payment gateway integration before flipping `ENABLE_LIVE_PAYMENTS=true`.
- [ ] **Action 10:** Final review of payment gateway integration before flipping `ENABLE_LIVE_PAYMENTS=true`.
