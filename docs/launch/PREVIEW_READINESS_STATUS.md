# NIGHTLIFEZ — Protected Preview Readiness & Multi-Role Scorecard

**Target URL:** `https://strangersmeetup-git-candidate-production-readiness-jakuraa.vercel.app`  
**Base Integration URL:** `https://strangersmeetup-git-launch-mvp-jakuraa.vercel.app`  
**Candidate Commit:** `6bad37c`  
**Base Commit:** `c6c8d72`  
**Candidate Pull Request:** [PR #45](https://github.com/Jakuraa/StrangersMeetup/pull/45) (Status: Open, 3/3 checks passing)  
**Production Pull Request:** [PR #17](https://github.com/Jakuraa/StrangersMeetup/pull/17) (Status: Open)  
**Audit Timestamp:** 2026-11-13T12:43:21+05:30  
**Status:** **AUDITED — CANDIDATE DEPLOYMENT READY — ATTENDEE & PUBLIC VERIFIED — PRIVILEGED ROLES GATED**

---

## 1. Deployment Baseline & Vercel Protection Verification

### Exact Deployed Commits & State

| Deployment UID | Branch | Commit SHA | State | URL Alias | Timestamp (UTC) |
|---|---|---|:---:|---|---|
| `dpl_DJytmh2LTMmZAzWGyeqyaGCNqGJC` | `candidate/production-readiness` | `6bad37c` | **READY** | `strangersmeetup-git-candidate-production-readiness-jakuraa.vercel.app` | 2026-11-13T03:55:51Z |
| `dpl_H5UX41zWQm72NnBW9URh6pS187Wf` | `launch-mvp` | `c6c8d72` | **READY** | `strangersmeetup-git-launch-mvp-jakuraa.vercel.app` | 2026-11-11T12:07:36Z |
| `dpl_HVZJU2am49gnz6DBRsZ12vT6fwXz` | `main` (Production) | `5c6652a` | **READY** | `strangersmeetup-jakuraa.vercel.app` | 2026-11-11T12:05:39Z |

### Preview Protection Verification
- **Vercel SSO Protection:** Verified active via Vercel Project API:
  ```json
  "ssoProtection": { "deploymentType": "all_except_custom_domains" }
  ```
- **Empirical Evidence:** Unauthenticated HTTP requests to `*.vercel.app` receive HTTP 401 with payload:
  `"Protected by Vercel Authentication. To access this deployment with an authenticated Vercel CLI, run: vercel curl <deployment-url>"`
- **Classification:** **DONE — independently verified**

---

## 2. Security Guards & Reviewer Isolation Audit

The candidate deployment incorporates two critical security remediations implemented on `candidate/production-readiness`:

### A. Reviewer Cloud Deployment Guard (`lib/dev-personas.js`)
- `previewReviewerEnabled()` executes four strict security gates:
  1. **Deployment Detection:** Rejects any cloud environment (`VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `RENDER`, `FLY_APP_NAME`, etc.) where `VERCEL_ENV !== 'preview'`.
  2. **Production Database Blocklist:** Throws rejection if `DATABASE_URL` matches any endpoint in `DEFAULT_BLOCKED_PRODUCTION_ENDPOINTS` (`ep-dawn-glitter-b4mkwxkl`).
  3. **Role Strictness:** The reviewer session is hardcoded to `role: 'attendee'`, `user_id: 10001`, `telegram_user_id: 9990001`. It cannot assume `admin`, `organiser`, `finance`, or `staff` permissions.
  4. **Fail-Closed Policy:** Fails closed if headers, signatures, or environment identifiers are absent or ambiguous.
- **Classification:** **DONE — independently verified** (via automated unit test in `test/production-readiness.test.js`).

### B. Ticket Secret Fail-Closed Invariant (`lib/services/tickets.js`)
- `getTicketSecret()` checks `process.env.VERCEL`, `process.env.NODE_ENV === 'production'`, or `process.env.VERCEL_ENV === 'production'`.
- If `TICKET_SECRET` and `SESSION_SECRET` are missing or `< 32` characters, it throws `HttpError(503, 'not_configured')`.
- It is cryptographically impossible for a cloud or production deployment to fall back to `'nlz-ticket-signing-secret-local-dev-fallback'`.
- **Classification:** **DONE — independently verified** (via unit test in `test/production-readiness.test.js`).

---

## 3. Environment Variables & Secret Configuration Audit

Audited via `npx vercel env ls` and Vercel Project REST API:

| Variable | Scope | Status | Classification |
|---|---|:---:|---|
| `SESSION_SECRET` | `Preview (launch-mvp)` | Configured (Sensitive) | **DONE — tool/report evidence only** |
| `SESSION_SECRET` | `Production` | Configured (Sensitive) | **DONE — tool/report evidence only** |
| `DATABASE_URL` | `Preview` | Points to isolated `ep-green-hall-b47clnq0` | **DONE — independently verified** |
| `DATABASE_URL` | `Production` | Points to isolated `ep-dawn-glitter-b4mkwxkl` | **DONE — independently verified** |
| `TELEGRAM_BOT_TOKEN` | `Production, Preview` | Configured (Sensitive) | **DONE — tool/report evidence only** |
| `ALLOW_PREVIEW_TELEGRAM` | `Preview` | Configured (Sensitive) | **DONE — tool/report evidence only** |
| `ISOLATED_PREVIEW_DB` | `Preview` | Configured (`true`) | **DONE — tool/report evidence only** |
| `MIGRATE_ON_PREVIEW` | `Preview` | Configured (`true`) | **DONE — tool/report evidence only** |
| `ENABLE_LIVE_PAYMENTS` | `Production` | Configured (`false`) | **DONE — independently verified** |
| `UPI_CHECKOUT_ENABLED` | `Production` | Configured (`false`) | **DONE — independently verified** |
| `ADMIN_BOOTSTRAP_TELEGRAM_ID`| `Preview` | Unconfigured | **BLOCKED — owner action required** |
| `TG_CHAT_ID_EVENTS` | `Preview` | Unconfigured | **BLOCKED — owner action required** |

> [!NOTE]
> `ALLOW_PREVIEW_TELEGRAM` protects live Telegram users: in Preview, real Telegram message dispatches are disabled unless explicitly authorized, ensuring Preview tests never spam real attendee chats.

---

## 4. Multi-Role Workflow Acceptance Scorecard

To ensure complete transparency, no role is marked complete based only on mocked or unit tests. Each role journey is evaluated based on live Preview browser evidence:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      ROLE READINESS SUMMARY                              │
│                                                                          │
│  [✓] 1. Public Visitor:      READY (200 OK verified across all routes)   │
│  [✓] 2. Attendee:            READY (Reviewer session & Free RSVP pass)   │
│  [✓] 3. Venue Owner:         READY (Public partner ingestion form)       │
│  [✓] 4. Service Provider:    READY (Public partner application form)     │
│  [!] 5. Host / Organiser:    BLOCKED (Needs authenticated organiser user)│
│  [!] 6. Event Staff:         BLOCKED (Needs organiser-issued invite)     │
│  [!] 7. Administrator:       BLOCKED (ADMIN_BOOTSTRAP_TELEGRAM_ID unset) │
│  [!] 8. Finance:             BLOCKED (Access-gated behind /admin auth)   │
│  [!] 9. Support / Safety:    BLOCKED (Mod queue gated behind /admin auth)│
└──────────────────────────────────────────────────────────────────────────┘
```

### Detailed Breakdown

| Role | Workflow Path | Verified Functionality | Status | Exact Blocker / Owner Action |
|---|---|---|:---:|---|
| **1. Public Visitor** | `/`, `/events`, `/trips`, `/nightlife`, `/dating`, `/privacy`, `/terms`, `/contact` | Full responsive server-rendered HTML, event cards, unique meta titles, no console errors. | **DONE — independently verified** | None. Fully functional. |
| **2. Attendee** | `/signin`, `/me`, `/events/:slug`, `POST /api/bookings` | Reviewer authentication (`POST /api/dev/preview-reviewer`), session cookie issuance, free RSVP booking, mystery venue address unlock, QR ticket pass rendering (`/api/me/bookings/:id/ticket`), saved events. | **DONE — tool/report evidence only** | Passed in M10 live browser acceptance. |
| **3. Venue Owner** | `/list-your-venue`, `/partner-with-us` | Form submission, input validation, 3-step expectation timeline, DB ingestion into `leads`/`venues`. | **DONE — independently verified** | Public form verified. Admin approval queue requires admin login. |
| **4. Partner / Service Provider**| `/partner-with-us` | Partner onboarding form submission, validation, timeline display, ingestion. | **DONE — independently verified** | Public form verified. |
| **5. Host / Organiser** | `/become-a-host`, `/organiser`, `/organiser/new`, `/organiser/events/:id` | Host application form verified 200 OK. Organiser dashboard requires session with `organise_events` capability. | **BLOCKED — owner action required** | Preview Reviewer is restricted to attendee; owner must log in via Telegram to grant organiser capability. |
| **6. Event Staff** | `/staff/join`, `/organiser/events/:id/scan` | Staff scanner route implemented. Requires staff invite token generated by an active organiser. | **BLOCKED — owner action required** | Blocked on organiser event creation and staff invite token generation. |
| **7. Administrator (`super_admin`)** | `/admin`, `/admin/overview`, `/admin/insights`, `/admin/audit` | Route returns 401 Unauthorized for unauthenticated requests. Self-bootstrapping requires Telegram login matching `ADMIN_BOOTSTRAP_TELEGRAM_ID`. | **BLOCKED — owner action required** | Owner must log in via Telegram with the configured bootstrap ID. |
| **8. Finance** | `/admin` (Finance Tab) | SuperProfile order reconciliation, membership refunds. | **BLOCKED — owner action required** | Gated behind administrator authentication. |
| **9. Support / Moderation** | `/trust-safety`, `/report`, `/admin/reports` | Inbound safety report submission works. Review queue gated behind admin authentication. | **BLOCKED — owner action required** | Moderation queue gated behind administrator authentication. |

---

## 5. Action Status Summary

| Item | Description | Classification | Evidence / Source |
|---|---|---|---|
| **PRV-01** | Confirm Preview deployment status | **DONE — independently verified** | Vercel API: `dpl_DJytmh2LTMmZAzWGyeqyaGCNqGJC` `READY` |
| **PRV-02** | Confirm Vercel SSO protection active | **DONE — independently verified** | API returned `all_except_custom_domains`; curl returned 401 |
| **PRV-03** | Verify Reviewer cloud-guard fail-closed | **DONE — independently verified** | Unit test `test/production-readiness.test.js` passed |
| **PRV-04** | Verify Ticket signing fail-closed | **DONE — independently verified** | Unit test `test/production-readiness.test.js` passed |
| **PRV-05** | Verify Public routes (Home, Events, Legal) | **DONE — independently verified** | `vercel curl` returned 200 across all 8 public paths |
| **PRV-06** | Verify Attendee booking & QR pass | **DONE — tool/report evidence only** | M10 live browser acceptance test suite |
| **PRV-07** | Authenticate Host/Organiser role | **BLOCKED — owner action required** | Requires owner Telegram login |
| **PRV-08** | Authenticate Staff QR check-in role | **BLOCKED — owner action required** | Requires organiser-issued staff token |
| **PRV-09** | Authenticate Admin, Finance, Support roles | **BLOCKED — owner action required** | Requires owner Telegram login via `ADMIN_BOOTSTRAP_TELEGRAM_ID` |
