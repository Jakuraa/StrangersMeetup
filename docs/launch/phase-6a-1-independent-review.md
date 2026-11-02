# Phase 6A.1 — NIGHTLIFEZ Independent Rebrand Review

**Document:** Independent Rebrand Review & Audit Report  
**Target Pull Request:** [#19](https://github.com/Jakuraa/StrangersMeetup/pull/19) (`feat(brand): customer-facing rebrand from StrangersMeetup to NIGHTLIFEZ`)  
**Feature Branch:** `feature/nightlifez-rebrand`  
**Base Branch:** `launch-mvp`  
**Commit SHA:** `75b3e82`  
**Date:** 2026-11-02  
**Auditor:** Antigravity AI Engineering Assistant (Independent Audit Mode)  
**Status:** COMPLETE  
**Overall Recommendation:** **APPROVE WITH CONDITIONS**

---

## 1. Executive Summary

This report delivers a rigorous, read-only independent review of **Pull Request #19**, which implements the customer-facing rebrand of the platform from **StrangersMeetup** to **NIGHTLIFEZ** with the tagline **"Discover. Connect. Experience."**

The review evaluates all 17 changed files against the canonical `launch-mvp` base, performs a repository-wide audit for residual brand strings, verifies technical identifier isolation, inspects security and privacy boundaries, analyzes skipped tests in both unit and Playwright test suites, and evaluates accessibility and responsive rendering across viewports (320px, 375px, and desktop).

### High-Level Verdict:
The rebrand architecture is structurally sound, visually cohesive, highly accessible, and safely isolates all underlying database schemas, authentication cookies, and deployment pipelines. However, this independent review identified several residual customer-facing references in event detail views, organiser onboarding, and client-side JavaScript dialogs, as well as an unprovisioned safety contact email. 

Consequently, the release candidate is recommended for **APPROVE WITH CONDITIONS** prior to final merge authorization.

---

## 2. Review Matrix by Category

| # | Category | Scope | Status | Notes |
| :-: | :--- | :--- | :---: | :--- |
| **1** | Changed File Inspection | Full diff of all 17 files against `launch-mvp` | **PASS** | Diff is clean, targeted, and introduces no extraneous edits. |
| **2** | Customer-Facing Brand Consistency | View templates, client scripts, meta tags | **FAIL (Conditional)** | Residual strings in `lib/views/event.js`, `lib/views/organiser.js`, `public/js/site.js`, `public/js/organiser.js`. |
| **3** | Links, Metadata & PWA Assets | Headers, footers, manifest, favicon, OG tags | **PASS** | Valid SVG favicon, valid PWA manifest, intact routing. |
| **4** | Operational Contact Verification | Support & safety reporting email addresses | **FAIL (Conditional)** | `contact@nightlifez.com` referenced in `public/js/site.js` prior to domain/mailbox provisioning. |
| **5** | Dynamic Legal Disclosures | Statutory compliance, IT Act grievance officer | **PASS** | Zero synthetic entities; strictly driven by environment variables. |
| **6** | Telegram & Auth Architecture | Bot API, login widget, HMAC session cookies | **PASS** | 100% unchanged; cookies (`sm_sid`, `sm_oidc`) preserved. |
| **7** | Database Schema & Migrations | Postgres tables, schema files `001`–`011` | **PASS** | 100% frozen; zero database migrations or writes. |
| **8** | 21+ Age Gate & Privacy Controls | Age confirmation, attendee lists, mystery venue | **PASS** | 21+ strictly enforced; private venue addresses hidden until booking. |
| **9** | Payment Safeguards | `ENABLE_LIVE_PAYMENTS=false` & checkout kill-switch | **PASS** | Fail-closed protection intact; paid checkout disabled. |
| **10** | Skipped Test Reconciliation | 2 unit tests & 11 Playwright tests | **PASS** | All skips verified as intentional environment/viewport skips. |
| **11** | Responsive Layout (320px, 375px, Desktop) | Narrow viewport rendering & overflow audits | **PASS** | Zero horizontal scroll; `.logo-soft` cleanly collapses at <=430px. |
| **12** | Accessibility & Visual Direction | Axe core audits, 44px tap targets, contrast | **PASS** | WCAG 2.1 AA compliant; contrast > 11:1; full keyboard navigation. |

---

## 3. Detailed Findings & Classification

### [HIGH] Finding H-01: Residual Customer-Facing "StrangersMeetup" Strings

While the global layout, homepage, footer, navigation, static informational pages, admin console, and Telegram bot greetings were successfully rebranded, an in-depth codebase audit revealed that several secondary customer-facing views and scripts still render the legacy name:

1. **Individual Event View (`lib/views/event.js`):**
   - **Line 25 (JSON-LD Organization):**
     ```javascript
     organizer: e.organiserManaged ? { '@type': 'Organization', name: e.organizer } : { '@type': 'Organization', name: 'StrangersMeetup', url: siteUrl() }
     ```
     *Impact:* Search engines and rich snippets for platform-hosted events will index the publisher organization as `StrangersMeetup` instead of `NIGHTLIFEZ`.
   - **Line 70 (Organiser Disclaimer):**
     ```html
     <li>StrangersMeetup does not run this event. Price, availability, tickets and refunds are handled by the organiser.</li>
     ```
     *Impact:* Attendees viewing externally hosted events see the disclaimer referencing `StrangersMeetup`.
   - **Line 110 (Telegram Mini App Note):**
     ```html
     <p class="pay-note" data-tg-only hidden>Tickets are sold on our website. Open StrangersMeetup in your browser to book.</p>
     ```
     *Impact:* Users inside the Telegram Mini App attempting to book a paid event are told to "Open StrangersMeetup in your browser".

2. **Organiser View (`lib/views/organiser.js`):**
   - **Line 70 (Host Sign-in Hero):**
     ```html
     <h2>Host your events on StrangersMeetup</h2>
     ```
     *Impact:* Prospected event hosts visiting `/organiser` see the legacy platform name on the primary call-to-action banner.
   - **Line 139 (Meta Description):**
     ```javascript
     description: 'Create and manage your StrangersMeetup events.'
     ```

3. **Client-Side Scripts (`public/js/site.js` & `public/js/organiser.js`):**
   - **`public/js/site.js` Line 53 (Browser Age Confirmation Dialog):**
     ```javascript
     if (!window.confirm('StrangersMeetup events are for adults only. Do you confirm you are 21 or older?')) return Promise.resolve(false);
     ```
     *Impact:* The browser modal prompt displayed to attendees explicitly asks them to confirm that "StrangersMeetup events are for adults only".
   - **`public/js/site.js` Line 133 (Telegram Booking Error):**
     ```javascript
     msg.textContent = 'Paid tickets are sold on our website. Open StrangersMeetup in your browser to book.';
     ```
   - **`public/js/site.js` Line 266 (Confirmed Pass Badge):**
     ```javascript
     '<div class="pass-brand"><span class="pass-badge-icon" aria-hidden="true">🎟️</span> <span>StrangersMeetup Pass</span></div>'
     ```
     *Impact:* Digital event passes issued to attendees prominently display "🎟️ StrangersMeetup Pass" at the top of the card.
   - **`public/js/site.js` Line 486 (Filter Categories):**
     ```javascript
     strangers_trips: 'Strangers trips'
     ```
   - **`public/js/organiser.js` Line 248 (Event Creation Wizard Publish Confirmation):**
     ```javascript
     '<p>It will appear on StrangersMeetup for everyone to see'
     ```

---

### [MEDIUM] Finding M-01: Premature Safety Email Reference (`contact@nightlifez.com`)

In `public/js/site.js` (line 555), the signed-out safety reporting fallback was updated to:
```html
<p class="muted">To submit a confidential report online, please <a class="link-cyan" href="/signin">sign in with Telegram</a> first. You can also send <code>/report</code> to our Telegram bot or email <a href="mailto:contact@nightlifez.com">contact@nightlifez.com</a>. If you are in immediate danger, call 112.</p>
```

- **Issue:** The domain `nightlifez.com` has not yet been acquired, and no MX/SPF/DKIM mail routing has been provisioned.
- **Impact:** If an unauthenticated user attempts to send an urgent safety grievance to `contact@nightlifez.com`, the message will bounce or fail silently.
- **Recommended Remediation:** Until `nightlifez.com` MX records are active, the safety block should link exclusively to the Telegram bot (`/report`) or dynamically check `env('SUPPORT_EMAIL')`.

---

### [LOW] Finding L-01: Instagram Link Retains Legacy Handle

In `lib/views/layout.js`:
```javascript
export const INSTAGRAM_URL = 'https://www.instagram.com/the.strangers.meetup/';
```
- **Context:** The site footer features: `Follow @the.strangers.meetup on Instagram`.
- **Impact:** Directs users to the existing legacy Instagram account.
- **Evaluation:** Classified as **LOW**. No `@nightlifez` official account exists yet. Retaining the active account maintains valid social proof until an official rebrand of social channels occurs.

---

### [INFORMATIONAL] Finding I-01: Explanation of Skipped Tests

Both test suites executed during Phase 6A completed with 100% green status, but reported skipped tests:

#### 1. Unit Test Suite (2 Skipped in `test/mcp.test.js`)
- **Skipped Tests:**
  1. `sm_inspect_page inspects public routes and classifies correctly` (`test/mcp.test.js:124`)
  2. `sm_audit_auth_flow audits all security gates` (`test/mcp.test.js:166`)
- **Reason:** Both tests evaluate `getProjectStatus().server_status !== 'ONLINE'`. During standalone `npm test` runs, Node.js executes without spinning up the HTTP server on port 3000. These tests explicitly skip live HTTP requests when running offline.

#### 2. Playwright E2E Suite (11 Skipped)
- **Playwright Configuration:** Defines three projects: `desktop` (1280x800), `mobile` (Pixel 7), and `responsive` (admin matrix).
- **Skipped Tests Breakdown:**
  - **1 test in `e2e/mobile-layout.spec.js` (Line 45):** `test.skip(test.info().project.name !== 'mobile', 'menu button only exists at phone widths')`. Skips under `desktop` project because hamburger navigation only renders at `<=1020px`.
  - **4 tests in `e2e/tap-targets.spec.js` (Line 9):** `test.beforeEach` skips when `project.name !== 'mobile'` because minimum 44px tap target auditing is calibrated for touchscreen mobile viewports.
  - **5 tests in `e2e/wizard-tap-targets.spec.js` (Line 18):** Skips narrow viewport tests (320px, 360px, 375px, 390px, 430px) when running the `desktop` project.
  - **1 test in `e2e/wizard-tap-targets.spec.js` (Line 78):** `test.skip(testInfo.project.name !== 'desktop', 'desktop only')`. Skips desktop control layout verification when running the `mobile` project.
- **Summary:** All 11 skipped tests are intentional, viewport-dependent skips designed to prevent false positives across multi-device test matrices.

---

## 4. Deep-Dive Security & Architectural Audits

### 4.1 Payment Fail-Closed Verification
- Evaluated `lib/config.js` and `lib/payments/availability.js`.
- `livePayments()` strictly evaluates:
  ```javascript
  export function livePayments() {
    return env('ENABLE_LIVE_PAYMENTS', 'false') === 'true';
  }
  ```
- In `lib/payments/availability.js`:
  ```javascript
  if (!livePayments()) {
    return { available: false, reason: 'live_payments_disabled', message: 'Paid ticket checkout is currently disabled.' };
  }
  ```
- **Result:** **PASS**. Live payments remain hard-disabled. All paid tickets fail closed. Free bookings remain fully operational.

### 4.2 Legal Disclosures & Statutory Compliance
- In `lib/views/pages.js`:
  - `entity()` renders `env('LEGAL_ENTITY_NAME') || 'NIGHTLIFEZ (legal entity details will be published here before paid bookings open)'`.
  - Grievance details render `env('GRIEVANCE_EMAIL') ? ... : 'Details will be published here before paid bookings open.'`.
- **Result:** **PASS**. No fictitious corporate names, fake addresses, or invented grievance officers are published.

### 4.3 Telegram Bot & Session Architecture
- HMAC signature validation, login callbacks, and session issuance in `lib/auth/session.js` remain completely untouched.
- Cookie names (`sm_sid` and `sm_oidc`) remain stable, ensuring existing active sessions are preserved without logout disruptions.
- **Result:** **PASS**.

### 4.4 Mobile Layout & Accessibility Evaluation
- **320px Viewport (iPhone SE / narrow Android):**
  - Header branding uses `<span>NIGHT<span class="logo-soft">LIFEZ</span></span>`.
  - CSS rule `@media (max-width: 430px) { .site-header .logo-soft { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } }` smoothly hides `LIFEZ` visually on narrow headers while retaining full semantic screen-reader accessibility.
  - Action chips, search toggle, and account buttons fit cleanly within 320px width without horizontal scrolling.
- **Axe Core Audits:**
  - Zero accessibility violations detected across desktop and mobile runs.
  - Color contrast on the obsidian canvas (`#090B16`) with electric cyan (`#00D9FF`) exceeds 11:1 (surpassing WCAG AAA requirements).

---

## 5. Review Conclusion & Recommendation

### Overall Status: **APPROVE WITH CONDITIONS**

Pull Request [#19](https://github.com/Jakuraa/StrangersMeetup/pull/19) represents a major improvement, delivering a high-quality, professional, vibrant, and youth-oriented consumer identity while safely preserving backend stability, authentication contracts, database schemas, and payment protections.

### Mandatory Pre-Merge Conditions:
1. **Remediate Residual Brand Strings (Finding H-01):**
   - Update `lib/views/event.js` (lines 25, 70, 110) to replace `StrangersMeetup` with `NIGHTLIFEZ`.
   - Update `lib/views/organiser.js` (lines 70, 139) to replace `StrangersMeetup` with `NIGHTLIFEZ`.
   - Update `public/js/site.js` (lines 53, 133, 266, 486) to update the 21+ prompt, booking error, digital pass brand badge (`NIGHTLIFEZ Pass`), and filter labels.
   - Update `public/js/organiser.js` (line 248) to reference `NIGHTLIFEZ`.
2. **Safety Email Safeguard (Finding M-01):**
   - Adjust `public/js/site.js` line 555 to avoid hardcoding `contact@nightlifez.com` until the domain and mailbox are active.
3. **Domain & Trademark Confirmation:**
   - Retain PR #19 unmerged until domain acquisition of `nightlifez.com` is finalized and formal clearance is granted by qualified Indian legal counsel.

*This concludes the independent review. No code modifications, commits, merges, or deployments were performed in accordance with strict review boundaries.*
