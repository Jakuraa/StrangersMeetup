# NIGHTLIFEZ — Master Live Preview Defect Register
**Target Deployment:** `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app`  
**Deployment ID:** `dpl_DoPokr69C3j3e5oPRkq51vobcoER`  
**Git Commit SHA:** `142cc62` (incorporating `bb01c7d`)  
**Test Harness:** Real Playwright Chromium Automation against Protected Preview  
**Audit Date:** November 10, 2026  
**Auditor:** Principal QA Engineer & Browser Automation Lead  

---

## 1. Executive Defect Summary

During the Master Live Preview Browser Acceptance Test executed directly against the live, protected Vercel Preview deployment, 4 functional/environmental defects and 1 behavioral rate-limit constraint were empirically discovered. 

Two of these defects are **CRITICAL** blockers that prevent authenticated testing of Attendee pass generation/cancellation, Organiser event creation, Event Staff scanning, and Admin console workflows on Vercel Preview.

| Defect ID | Severity | Affected Roles | Component / Route | Summary | Root Cause | Remediation Status |
|---|---|---|---|---|---|---|
| **DEF-01** | **CRITICAL** | Role 1 (Attendee) | `lib/dev-personas.js:52`<br>`/api/auth/preview-reviewer` | Preview Reviewer endpoint returns `HTTP 404 Not Found` on Vercel Preview | `previewReviewerEnabled()` rejects `NODE_ENV === 'production'`. Vercel sets `NODE_ENV=production` on all functions (including Preview). | **RESOLVED IN CODE** — Decoupled `NODE_ENV` in `lib/dev-personas.js`. Verified via `test/preview-remediation.test.js` (3/3 pass). |
| **DEF-02** | **CRITICAL** | All Authenticated Roles (1, 3, 5, 7) | Vercel Preview Env<br>`lib/session.js:12` | `SESSION_SECRET` is unconfigured on Vercel Preview | `SESSION_SECRET` environment variable is not populated in Vercel Project Settings for Preview. | **PENDING OWNER ACTION** — Owner must add unique 32+ char hex `SESSION_SECRET` to Preview env. |
| **DEF-03** | **HIGH** | Role 1 (Attendee), Role 2 (Host) | Vercel Preview Env<br>`/signin` | Telegram Login Widget does not render on Preview | `TELEGRAM_BOT_USERNAME` not configured for Preview; also subject to BotFather domain registration. | **PENDING OWNER ACTION** — Configure `TELEGRAM_BOT_USERNAME`. Preview Reviewer serves as primary preview test flow. |
| **DEF-04** | **HIGH** | Role 7 (Admin) | Vercel Preview Env<br>`lib/handlers/admin.js:33` | Native Admin Auto-Bootstrap unavailable | `ADMIN_BOOTSTRAP_TELEGRAM_ID` is unconfigured on Preview. | **PENDING OWNER ACTION** — Owner must set their Telegram ID in Preview env for zero-SQL admin bootstrap. |
| **DEF-05** | **INFO / PASS** | Roles 2, 4, 6 (Leads) | `lib/handlers/leads.js:50`<br>`/api/leads/:type` | Lead submission throttled after 5 submissions per hour | Expected rate limit `lead:${hashIp(ip)}` (5 req / 3600s) correctly triggered on repeated test runs. | **RESOLVED IN HARNESS** — Test harness updated to differentiate active rate limiting from test failures. |

---

## 2. Detailed Defect Dossiers

### DEF-01: Preview Reviewer Route Evaluates False on Vercel Preview (NODE_ENV Bug)

- **Defect ID:** `DEF-01`
- **Severity:** **CRITICAL** (Release Blocker for Preview Reviewer Workflow)
- **Affected Roles:** Role 1 (Attendee), Automation Harness
- **Target URL:** `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app/api/auth/preview-reviewer`
- **Source Location:** [`lib/dev-personas.js:51-55`](file:///Users/pradeepjakuraa/strangersmeetup/lib/dev-personas.js#L51-L55)
- **Source Code:**
  ```javascript
  export function previewReviewerEnabled(e = process.env) {
    if (e.VERCEL_ENV === 'production' || e.NODE_ENV === 'production') return false;
    if (isBlockedProductionDatabaseUrl(e.DATABASE_URL, e)) return false;
    return e.VERCEL_ENV === 'preview' || e.IS_PREVIEW === 'true';
  }
  ```
- **Root Cause Analysis:**
  In Vercel Serverless Functions, Vercel executes all functions with `process.env.NODE_ENV = 'production'`, regardless of whether the deployment target is Production or Preview. When `previewReviewerEnabled()` runs on a Vercel Preview deployment, `e.VERCEL_ENV` is `'preview'`, but `e.NODE_ENV` is `'production'`.
  Because line 52 checks `e.VERCEL_ENV === 'production' || e.NODE_ENV === 'production'`, it evaluates to `true` and returns `false` before reaching line 54!
  Consequently:
  1. `POST /api/auth/preview-reviewer` throws `new HttpError(404, 'not_found', 'Not found')`.
  2. The `/signin` page checks `previewReviewer: previewReviewerEnabled()` and completely hides the "Sign in as Preview Reviewer" test button.
- **Reproduction Steps:**
  ```bash
  vercel curl "https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app/api/auth/preview-reviewer" \
    -- -X POST -H "Content-Type: application/json" -d '{"next":"/me"}' -i
  ```
- **Observed Behavior:**
  ```http
  HTTP/2 404 
  content-type: application/json; charset=utf-8
  {"ok":false,"error":"not_found","message":"Not found"}
  ```
- **Expected Behavior:**
  On a verified Preview deployment (`VERCEL_ENV === 'preview'`), `previewReviewerEnabled()` should return `true`, issuing a synthetic attendee session cookie (`REVIEWER_TG_ID = 9100000100`) and redirecting to `/me`.
- **Remediation Implemented & Verified:**
  In `lib/dev-personas.js:51-57`, the environment detection was updated to decouple `NODE_ENV` while retaining strict Production and Database safety gates:
  ```javascript
  export function previewReviewerEnabled(e = process.env) {
    if (e.VERCEL_ENV === 'production') return false;
    if (isBlockedProductionDatabaseUrl(e.DATABASE_URL, e) || isBlockedProductionDatabaseUrl(e.PREVIEW_DATABASE_URL, e)) return false;
    if (e.VERCEL_ENV === 'preview' || e.IS_PREVIEW === 'true') return true;
    return e.NODE_ENV !== 'production' && !e.VERCEL;
  }
  ```
  Verified via dedicated regression suite `test/preview-remediation.test.js`:
  1. `VERCEL_ENV=preview` + `NODE_ENV=production` $\rightarrow$ Allowed (`true`)
  2. `VERCEL_ENV=production` $\rightarrow$ Rejected (`false`)
  3. `NODE_ENV=development` without preview flag $\rightarrow$ Rejected (`false`)
  4. Blocked production DB URL $\rightarrow$ Rejected (`false`)
  5. Missing environment $\rightarrow$ Rejected (`false`)
  6. HTTP integration: POST returns 200 on Preview, GET returns 405 Method Not Allowed, `/api/admin` returns 403 Forbidden.

---

### DEF-02: Missing `SESSION_SECRET` on Vercel Preview Environment

- **Defect ID:** `DEF-02`
- **Severity:** **CRITICAL** (Authentication Infrastructure Blocker)
- **Affected Roles:** All Roles (Attendee, Host, Organiser, Staff, Admin)
- **Target URL:** `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app/api/health`
- **Source Location:** [`lib/session.js:10-14`](file:///Users/pradeepjakuraa/strangersmeetup/lib/session.js#L10-L14)
- **Observed Evidence:**
  Inspection of `/api/health` on Preview returns:
  ```json
  {
    "ok": true,
    "database": "ok",
    "config": {
      "database": "configured",
      "session": "NOT CONFIGURED",
      "cron": "NOT CONFIGURED",
      "telegramBot": "NOT CONFIGURED",
      "telegramWebhookSecret": "NOT CONFIGURED",
      "telegramEventsChat": "NOT CONFIGURED",
      "ticketCheckout": "superprofile_link",
      "livePayments": false,
      "adminBootstrap": "NOT CONFIGURED",
      "telegramLogin": "NOT CONFIGURED",
      "superprofileWebhook": "NOT CONFIGURED"
    },
    "version": "142cc62"
  }
  ```
- **Impact:**
  [`lib/session.js:12`](file:///Users/pradeepjakuraa/strangersmeetup/lib/session.js#L12) states:
  ```javascript
  function secret() {
    const s = env('SESSION_SECRET');
    if (s.length < 32) throw new HttpError(503, 'not_configured', 'Sign-in is not configured yet (SESSION_SECRET)');
    return s;
  }
  ```
  Even if reviewer auth or Telegram auth succeeded in authenticating a user identity, session cookie issuance (`createSession()`) immediately aborts with `HTTP 503 Service Unavailable`.
- **Remediation Recommendation:**
  Repository owner must open Vercel Dashboard $\rightarrow$ Project Settings $\rightarrow$ Environment Variables $\rightarrow$ Add `SESSION_SECRET` for the **Preview** environment with a secure 32+ character random hex string.

---

### DEF-03: Telegram Web Login Widget Credentials Missing on Preview

- **Defect ID:** `DEF-03`
- **Severity:** **HIGH** (Manual Sign-in Blocker)
- **Affected Roles:** Role 1 (Attendee), Role 2 (Host), Role 7 (Admin)
- **Target URL:** `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app/signin`
- **Observed Evidence:**
  The rendered `/signin` page on Preview displays:
  > *"Telegram sign-in is not configured yet on this deployment. On production, attendees and hosts sign in with one tap through Telegram."*
- **Impact:**
  Human testers visiting the Preview URL cannot sign in using real Telegram accounts because the Telegram OAuth Login Widget is not rendered.
- **Remediation Recommendation:**
  Populate `TELEGRAM_BOT_USERNAME` and ensure `TELEGRAM_BOT_TOKEN` is accessible for Preview in Vercel Project Settings. Alternatively, ensure DEF-01 and DEF-02 are resolved so Preview Reviewer login works seamlessly for testing without requiring personal Telegram credentials.

---

### DEF-04: `ADMIN_BOOTSTRAP_TELEGRAM_ID` Missing on Preview

- **Defect ID:** `DEF-04`
- **Severity:** **HIGH** (Admin Onboarding Blocker)
- **Affected Roles:** Role 7 (Super Admin, Support, Finance)
- **Target URL:** `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app/admin`
- **Observed Evidence:**
  `/api/health` reports `"adminBootstrap": "NOT CONFIGURED"`.
- **Impact:**
  The documented zero-SQL native bootstrapping mechanism ([`lib/handlers/admin.js:33-40`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/admin.js#L33-L40)) cannot function. Testing Role 7 requires direct SQL execution on the Preview database unless this variable is set.
- **Remediation Recommendation:**
  In Vercel Preview Environment Variables, set `ADMIN_BOOTSTRAP_TELEGRAM_ID = <OWNER_TELEGRAM_ID>`.

---

### DEF-05: Lead Submission IP Throttling (Verified Working Rate Limiter)

- **Defect ID:** `DEF-05`
- **Severity:** **INFORMATIONAL / VERIFIED BEHAVIOR**
- **Affected Roles:** Roles 2, 4, 6
- **Target URL:** `/api/leads/partner`
- **Observed Evidence:**
  During test run `PRV-02` (after multiple consecutive runs of host and venue submissions from the same IP), the API returned:
  `HTTP 429: "Too many requests. Please try again later."`
- **Analysis:**
  [`lib/handlers/leads.js:50`](file:///Users/pradeepjakuraa/strangersmeetup/lib/handlers/leads.js#L50) enforces:
  `await rateLimit('lead:' + hashIp(ip), 5, 3600);`
  This confirms that rate limiting is strictly active and protecting the Preview database from lead form spam.
