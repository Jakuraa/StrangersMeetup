# NIGHTLIFEZ Pre-Acceptance Security Gate & Read-Only Audit

**Document:** Pre-Acceptance Authentication & Database Safety Audit  
**Milestone:** Post-M10 Pre-Walkthrough Verification Gate  
**Audit Type:** Strictly Read-Only (Zero Code, Config, Secret or Database Mutations)  
**Target Environment:** Vercel Protected Preview  
**Verified Preview URL:** `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app`  
**Base Commit SHA:** `bb01c7d`  
**Latest Feature SHA:** `89741fe`  
**Audit Date:** November 2026  
**Auditor:** Automated Engineering Security Gate (Antigravity)  

---

## 1. Executive Summary & Gate Decision

Prior to the repository owner initiating the seven-role Preview acceptance walkthrough, an exhaustive, read-only security audit was conducted across:
1. The Preview Reviewer authentication endpoint (`/api/auth/preview-reviewer`).
2. The database provisioning procedures for `admin_users` and `users.organiser_enabled`.
3. Vercel Deployment Protection (SSO) and secret isolation.
4. Test suite reconciliation (692 total tests: 690 passed, 2 skipped, 0 failed).

### Gate Decision Summary

| Audit Domain | Status | Key Finding / Operational Action |
|---|---|---|
| **1. Preview Reviewer Security** | **CONDITIONAL PASS** | **Secure & fail-closed.** Reviewer role is strictly scoped to attendee (zero admin/organizer escalation). However, the endpoint is registered as **`POST` only**. Navigating via browser `<a href>` returns `405 Method Not Allowed`. Owner must trigger via `POST` or use standard Telegram sign-in. |
| **2. Database Provisioning Safety** | **PASS WITH NATIVE ALTERNATIVE** | Proposed SQL is safe if database identity is confirmed first. **Safer native alternative identified:** setting `ADMIN_BOOTSTRAP_TELEGRAM_ID` in Vercel auto-bootstraps the owner with full audit logging, requiring **zero direct SQL execution**. |
| **3. Deployment Protection & Secrets** | **PASS** | Vercel SSO verified active (HTTP 302 to `vercel.com/sso-api`). Zero public bypasses. Zero secrets exposed. `ENABLE_LIVE_PAYMENTS=false` intact. |
| **4. Test Suite Reconciliation** | **PASS** | Exactly 692 tests: 690 passed, 2 skipped, 0 failed. The 2 skipped tests are verified non-blocking MCP server tests requiring port 3000. |

---

## 2. Section 1: Preview Reviewer Authentication Deep Dive

The route `/api/auth/preview-reviewer` provides synthetic session creation for preview testing. The implementation was audited across source files, router definitions, and test suites.

```
                    HTTP POST /api/auth/preview-reviewer?next=/me
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │  previewReviewerEnabled() │
                        └─────────────┬─────────────┘
                                      │
                   Is Production OR Blocked Endpoint?
                   ┌──────────────────┴──────────────────┐
                  YES                                    NO
                   │                                     │
                   ▼                                     ▼
           404 Not Found                     Is VERCEL_ENV === 'preview'
                                             OR IS_PREVIEW === 'true'?
                                             ┌───────────┴───────────┐
                                            YES                      NO
                                             │                       │
                                             ▼                       ▼
                                   Proceeds to Auth            404 Not Found
                                   - REVIEWER_TG_ID (Guest only)
                                   - Zero admin_users entry
                                   - Zero organiser_enabled
                                   - Safe redirect validation
```

### Detailed Check Matrix

| Check ID | Security Condition | Status | Source Files & Line References | Verification Evidence |
|---|---|---|---|---|
| **REV-01** | **Strict Vercel Preview Restriction** | **PASS** | [`lib/dev-personas.js:51-55`](../../lib/dev-personas.js#L51-L55)<br>[`lib/handlers/auth.js:161-163`](../../lib/handlers/auth.js#L161-L163) | `previewReviewerEnabled()` explicitly checks `e.VERCEL_ENV === 'preview' \|\| e.IS_PREVIEW === 'true'`. Returns `false` on production or unconfigured environments. |
| **REV-02** | **Production & Local Exclusion** | **PASS** | [`lib/dev-personas.js:52`](../../lib/dev-personas.js#L52)<br>[`lib/config.js:108-112`](../../lib/config.js#L108-L112) | Checks `e.VERCEL_ENV === 'production' \|\| e.NODE_ENV === 'production'` and `isBlockedProductionDatabaseUrl()`. Throws `404 Not Found`. Tested in `test/attendee-booking.test.js:84-86`. |
| **REV-03** | **Least Privilege: Attendee-Only Permissions** | **PASS** | [`lib/handlers/auth.js:176-186`](../../lib/handlers/auth.js#L176-L186)<br>[`lib/dev-personas.js:36-37`](../../lib/dev-personas.js#L36-L37) | Upserts user with synthetic ID `REVIEWER_TG_ID = 9_100_000_100`. Does not write to `admin_users`, does not set `organiser_enabled = true`, creates no `org_memberships`, and adds no `event_team` records. |
| **REV-04** | **Zero Admin/Organiser Escalation** | **PASS** | [`lib/handlers/admin.js:30-43`](../../lib/handlers/admin.js#L30-L43)<br>[`lib/services/permissions.js:172`](../../lib/services/permissions.js#L172) | Calling `/api/admin/overview` with reviewer session returns `HTTP 403 Forbidden`. Tested in `test/attendee-booking.test.js:109-110`. |
| **REV-05** | **Session Cookie Security & Expiration** | **PASS** | [`lib/session.js:23-40`](../../lib/session.js#L23-L40)<br>[`lib/session.js:90-92`](../../lib/session.js#L90-L92)<br>[`lib/http.js:89`](../../lib/http.js#L89) | Cookie `sm_session` is serialized with `httpOnly: true`, `sameSite: 'Lax'`, `path: '/'`, `secure: true` (on Vercel/HTTPS). Signed with HMAC-SHA-256 (`SESSION_SECRET`). TTL is 7 days, backed by server-side `user_sessions` validation. |
| **REV-06** | **Open Redirect Prevention** | **PASS** | [`lib/handlers/auth.js:96-98`](../../lib/handlers/auth.js#L96-L98) | Validates `next` parameter via `safeNext(next)` using regex `/^\/(?!\/)[\w\-./?=&#%]*$/`. Rejects protocol-relative URLs (`//evil.com`), scheme prefixes (`javascript:`, `https:`), and whitespace. Defaults strictly to `'/me'`. |
| **REV-07** | **Impersonation & Tenant Isolation** | **PASS** | [`lib/handlers/auth.js:176-184`](../../lib/handlers/auth.js#L176-L184) | Synthetic account ID is hardcoded; client cannot supply an arbitrary user ID or Telegram ID. Reviewer can only view and cancel their own bookings. Tested in `test/attendee-booking.test.js:244-249`. |
| **REV-08** | **Fail-Closed Environment Fallback** | **PASS** | [`lib/dev-personas.js:51-55`](../../lib/dev-personas.js#L51-L55) | If environment detection variables are missing, undefined, or malformed, `previewReviewerEnabled()` evaluates to `false`. No fallback enables it silently. |
| **REV-09** | **HTTP Method Dispatching** | **FAIL / BLOCKED FOR DIRECT CLICKING** | [`lib/router.js:72`](../../lib/router.js#L72)<br>[`lib/router.js:246`](../../lib/router.js#L246) | **Critical Operational Finding:** Route is registered as `['POST', '/api/auth/preview-reviewer', ...]`. If the owner clicks a standard link or enters the URL in the browser bar, the browser issues a `GET` request, resulting in `HTTP 405 Method Not Allowed`. |

### Operational Remediation for REV-09
Because code modifications are forbidden under read-only audit governance, the owner **must not** click the URL as a standard `GET` link. The owner can execute the reviewer sign-in via any of the following three methods:

1. **Option A (Browser Developer Console):**
   Open the browser console on the Preview homepage and run:
   ```javascript
   fetch('/api/auth/preview-reviewer', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ next: '/me' })
   }).then(() => window.location.href = '/me');
   ```
2. **Option B (Curl Command):**
   ```bash
   curl -i -X POST -c cookies.txt \
     "https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app/api/auth/preview-reviewer"
   ```
3. **Option C (Standard Telegram Authentication):**
   Sign in via the site header using your real Telegram account.

---

## 3. Section 2: Preview Database Provisioning Safety

The proposed provisioning SQL statements from the walkthrough guide were audited for database safety, multi-tenant boundaries, and operational auditability.

### 3.1 Audit of Proposed SQL Statements

```sql
-- Query 1: User Lookup
SELECT id, telegram_user_id, alias FROM users WHERE telegram_user_id = <YOUR_TELEGRAM_ID>;

-- Query 2: Super Admin Promotion
INSERT INTO admin_users (telegram_user_id, role, active)
VALUES (<YOUR_TELEGRAM_ID>, 'super_admin', true)
ON CONFLICT (telegram_user_id) DO UPDATE SET role = 'super_admin', active = true;

-- Query 3: Organiser Enablement
UPDATE users SET organiser_enabled = true WHERE telegram_user_id = <YOUR_TELEGRAM_ID>;
```

### Safety Evaluation

| Safety Dimension | Status | Audit Findings & Risk Mitigation |
|---|---|---|
| **Database Identity Confirmation** | **PASS (Protocol Required)** | Direct SQL tools (psql, Neon Console) do not pass through application logic. **Mandatory Pre-Check:** The operator must run `SELECT current_database(), current_user, inet_server_addr();` and verify the endpoint matches the Preview database before executing DDL/DML. |
| **Production Rejection** | **PASS (App Layer) / CAUTION (Direct Client)** | The Node.js application enforces `isBlockedProductionDatabaseUrl()` against `ep-dawn-glitter-b4mkwxkl`. However, an external psql client connects directly. The owner must verify the host connection string does not contain production endpoint identifiers. |
| **Account Targeting Scoping** | **PASS** | Queries are parameterized with explicit `WHERE telegram_user_id = <ID>`. No mass updates or unconstrained table mutations exist. |
| **Overwriting Existing Roles** | **CAUTION** | `ON CONFLICT (telegram_user_id) DO UPDATE SET role = 'super_admin'` will overwrite an existing role (e.g., if the user previously held `support` or `finance`). Safe for personal owner onboarding; caution advised when testing sub-admin boundaries. |
| **Auditability** | **FAIL (Direct SQL)** | Direct database mutations bypass `lib/services/audit.js` and do not generate entries in `audit_log`. |
| **Safer Native Alternative** | **SUPERIOR METHOD IDENTIFIED** | **Native Bootstrap:** [`lib/handlers/admin.js:33-40`](../../lib/handlers/admin.js#L33-L40) supports `ADMIN_BOOTSTRAP_TELEGRAM_ID`. Setting this environment variable in Vercel automatically promotes the owner upon their first sign-in to `/admin` and records an audited `admin.bootstrap` entry without requiring any manual SQL! |

### Recommended Provisioning Best Practice
Instead of running manual SQL in psql:
1. In Vercel Project Dashboard $\rightarrow$ Settings $\rightarrow$ Environment Variables $\rightarrow$ Preview.
2. Set `ADMIN_BOOTSTRAP_TELEGRAM_ID = <YOUR_TELEGRAM_ID>`.
3. Sign in to `/signin` with that Telegram account.
4. Navigate to `/admin`. The application automatically promotes your account to `super_admin` and writes to `audit_log`.
5. Once inside the Admin Console, use the **Admins tab** to manage other roles and the **Organisers tab** to approve hosts safely through the UI.

---

## 4. Section 3: Deployment Protection & Secret Isolation Audit

The Vercel deployment configuration, network proxy behavior, and repository files were audited for exposure and isolation.

### 4.1 Deployment Protection Verification
Live HTTP inspection against the canonical preview URL:
```bash
curl -I -s https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app/api/health
```
**Actual HTTP Response:**
```http
HTTP/2 302 
location: https://vercel.com/sso-api?url=https%3A%2F%2Fstrangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app%2Fapi%2Fhealth&nonce=...
server: Vercel
set-cookie: _vercel_sso_nonce=...; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-robots-tag: noindex
x-vercel-id: bom1::2x547-1794293837301-4bb3ac888876
```
- **Vercel SSO Active:** Unauthenticated public requests are redirected to Vercel SSO (`vercel.com/sso-api`). **Status: PASS.**
- **No Public Authentication Bypass:** No application code routes, query flags, or headers bypass SSO. **Status: PASS.**
- **Search Engine Blocking:** `x-robots-tag: noindex` prevents search crawler indexing. **Status: PASS.**

### 4.2 Secret Isolation & Log Redaction
- **Tracked Repository Files:** Audited all 153 tracked files. Zero hardcoded secrets, private keys, or credentials exist. Only environment variable names and placeholders (`<SECRET>`, `<TELEGRAM_WEBHOOK_SECRET>`) are present.
- **Gitignore Protection:** `.env`, `.env.local`, `.vercel`, and database dumps are strictly gitignored.
- **Structured Logging Guard:** [`lib/logger.js`](../../lib/logger.js) automatically redacts tokens, hashes, and session cookies from output logs. **Status: PASS.**

---

## 5. Section 4: Test Report Reconciliation

The M10 test execution results were reconciled against the repository test files:

### 5.1 Test Breakdown

| Category | Total | Passed | Skipped | Failed | Pass Rate |
|---|---|---|---|---|---|
| **Unit & Integration Tests** | 692 | 690 | 2 | 0 | **99.71% (100% of runnable)** |
| **Database Migrations** | 8 | 8 | 0 | 0 | **100%** |
| **Playwright Browser E2E** | 14 | 14 | 0 | 0 | **100%** |
| **Mobile Tap Targets (Playwright)**| 8 | 4 | 4 | 0 | **100% of runnable** |
| **Security & Authorization Audit** | 19 | 19 | 0 | 0 | **100%** |
| **M10 Hardening Tests** | 8 | 8 | 0 | 0 | **100%** |
| **Linter Check** | 153 files | 153 clean | 0 | 0 | **100%** |

### 5.2 Reconciliation of the 2 Skipped Tests

Both skipped tests occur in [`test/mcp.test.js`](../../test/mcp.test.js):
1. **`MCP Tools: sm_inspect_page inspects public routes and classifies correctly` ([`test/mcp.test.js:121`](../../test/mcp.test.js#L121)):**
   - *Condition:* `if (status.server_status !== 'ONLINE') t.skip('Local application server on port 3000 is offline; skipping live HTTP inspection')`.
   - *Explanation:* Checks if a local development server is actively running on port 3000. In automated unit test execution, tests spin up ephemeral servers on randomized ports, so live port 3000 inspection safely skips.
2. **`MCP Tools: sm_audit_auth_flow audits all security gates` ([`test/mcp.test.js:163`](../../test/mcp.test.js#L163)):**
   - *Condition:* `if (status.server_status !== 'ONLINE') t.skip('Local application server on port 3000 is offline; skipping live auth gate audit')`.
   - *Explanation:* Same live server requirement. Comprehensive auth gate auditing is executed by the 19 dedicated tests in `test/m9-security-audit.test.js` and `test/auth.test.js`.

**Reconciliation Verdict:** The 2 skipped tests are expected, deterministic, and non-blocking. Zero test failures exist.

---

## 6. Security Gate Checklist for Owner Walkthrough

| Verification Check | Security Status | Action Required Before Starting Walkthrough |
|---|---|---|
| **1. Attendee Reviewer Login** | **BLOCKED VIA GET LINK** | Do not click as a standard link. Trigger via `POST` (Option A browser console script) or sign in via standard Telegram widget. |
| **2. Admin Account Provisioning** | **ACTION REQUIRED** | Set `ADMIN_BOOTSTRAP_TELEGRAM_ID = <YOUR_TG_ID>` in Vercel Preview Environment Variables (recommended) OR run DB query after verifying database identity. |
| **3. Preview Access** | **READY** | Log into your authorized Vercel team account before opening the preview URL. |
| **4. Live Payments Barrier** | **VERIFIED ENFORCED** | `ENABLE_LIVE_PAYMENTS=false` remains enforced. Free RSVP bookings are functional. |
| **5. Multi-User Walkthrough** | **ACTION REQUIRED** | Use 2 distinct Telegram accounts (or 1 Telegram account + Preview Reviewer session) to test Organiser $\rightarrow$ Staff invite handoffs. |

---

## 7. Governance Compliance Confirmation

- [x] **No PR merged:** PR #40 and all earlier PRs (#17–#39) remain unmerged.
- [x] **No Production changes:** Production deployments, DNS, and databases untouched.
- [x] **Zero database writes:** Read-only audit performed; no database tables modified.
- [x] **No credential changes:** Secrets, tokens, and environment variables unchanged.
- [x] **`ENABLE_LIVE_PAYMENTS=false` intact:** Maintained across all code paths.
- [x] **Preview SSO preserved:** Deployment protection active on Vercel preview.

**Read-Only Security Gate Status:** **AUDIT COMPLETE — READY FOR CAUTIOUS OWNER WALKTHROUGH WITH METHOD RECTIFICATION.**
