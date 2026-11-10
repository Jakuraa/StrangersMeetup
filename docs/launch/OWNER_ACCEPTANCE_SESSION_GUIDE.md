# NIGHTLIFEZ Owner Acceptance Session Guide

**Document:** Protected Preview Acceptance Walkthrough Guide  
**Milestone:** Post-M10 Pre-Release Verification Gate  
**Target Environment:** Vercel Protected Preview  
**Verified Preview URL:** `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app`  
**Vercel Inspector:** `https://vercel.com/jakuraa/strangersmeetup/6MFkpgjUArzipkNYH6pTb7z5swq2`  
**Security Status:** Vercel Deployment Protection (SSO) active. Public access blocked.  
**Financial Boundary:** `ENABLE_LIVE_PAYMENTS=false` strictly enforced. Free RSVP bookings only.  
**Acceptance Status:** **PENDING OWNER EXECUTION** (Automated tests pass; human-led acceptance walkthrough has not yet occurred).  

---

## 1. Executive Briefing & Walkthrough Objective

Engineering Milestone 10 is complete on feature branch `feature/m10-beta-readiness-hardening` (PR #40). Automated CI test suites (692 unit/integration tests, 14/14 multi-role Playwright browser tests, 8/8 migration tests, and 153 lint files) have passed cleanly.

However, **code verification in CI is not user acceptance.**  
The purpose of this session is for the repository owner to independently verify the complete, end-to-end product across all **seven user roles** on the real, protected Vercel Preview deployment prior to any production deployment or PR merging.

---

## 2. Owner Access & Environment Instructions

### 2.1 Accessing the Protected Preview
The Preview deployment is shielded by Vercel Deployment Protection.
1. **Navigate to Verified Preview URL:**  
   Open `https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app` in your desktop or mobile browser.
2. **Authenticate with Vercel SSO:**  
   - The browser will receive an `HTTP 302` redirect to `https://vercel.com/sso-api?...`.
   - Log in using your authorized Vercel team account credentials.
   - Vercel's edge proxy issues a secure `_vercel_jwt` cookie and redirects you to the NIGHTLIFEZ homepage.
   - *Security Note:* External visitors without Vercel team access cannot reach the application. No public bypass exists.

### 2.2 Application Authentication on Preview
The application uses Telegram authentication (Telegram WebApp / Login Widget) for sessions:
- **Standard Flow:** Click "Sign in" in the top header $\rightarrow$ authenticate via Telegram.
- **Preview Reviewer Guest Session:** On Preview environments, a restricted synthetic reviewer endpoint is available for testing the Attendee journey without tying to a personal Telegram account:
  - *Method & Scoping:* Must be called via `POST /api/auth/preview-reviewer` (clicking as a GET link returns `405 Method Not Allowed`). To sign in as the reviewer, open your browser developer console on the Preview site and run:
    ```javascript
    fetch('/api/auth/preview-reviewer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ next: '/me' }) }).then(() => window.location.href = '/me');
    ```
  - *Privilege Scoping:* This synthetic session is hard-locked to standard attendee/guest permissions only (`REVIEWER_TG_ID = 9100000100`). It cannot access administrator or organizer consoles.
- **Native Admin Bootstrapping:** To test Admin (Role 7) without running direct SQL, set `ADMIN_BOOTSTRAP_TELEGRAM_ID = <YOUR_TELEGRAM_ID>` in Vercel Preview Environment Variables. Signing into `/admin` with that account automatically and auditably grants `super_admin`.
- **Dev-Login Persona Switcher:** Strictly disabled on all Vercel deployments (`devLoginEnabled()` returns `false`).

---

## 3. Account Provisioning Requirements Across All 7 Roles

To test role separation and tenant isolation cleanly, the owner requires the following persona accounts:

| Role | Required Account Type | Existing in Preview DB? | How to Provision / Access |
|---|---|---|---|
| **1. Attendee** | Standard Telegram user or Preview Reviewer | **Yes** (Preview Reviewer synthetic account exists) | Navigate to `/api/auth/preview-reviewer?next=/me` or sign in with any standard Telegram account. |
| **2. Host** | Authenticated Telegram user without organizer role | **Yes** (Any fresh Telegram sign-in) | Sign in with Telegram and navigate to `/become-a-host`. |
| **3. Organiser** | User with `organiser_enabled = true` and team org | **Requires Provisioning** | Sign in as Super Admin $\rightarrow$ Admin Console $\rightarrow$ Organisers tab $\rightarrow$ Grant Organiser Privileges to target user. (Alternatively via DB query below). |
| **4. Venue Owner** | Any public or signed-in user | **Yes** (Publicly accessible) | Navigate directly to `/list-your-venue`. |
| **5. Event Staff** | User assigned `door_staff` on an event | **Provisioned via Invite** | Organiser generates staff invite link on `/organiser/events/:id/staff` $\rightarrow$ Target user opens link to accept role. |
| **6. Service Provider** | Any public or signed-in user | **Yes** (Publicly accessible) | Navigate directly to `/partner-with-us`. |
| **7. Admin / Finance / Support** | User row in `admin_users` table | **Requires Provisioning** | Add the owner's Telegram ID to `admin_users` table in the Preview database (see query below). |

### 3.1 Provisioning SQL Queries (Execute on Preview DB)

To grant your personal Telegram account administrator privileges on the Preview database:

```sql
-- 1. Look up your user ID by Telegram username or ID
SELECT id, telegram_user_id, alias FROM users WHERE telegram_user_id = <YOUR_TELEGRAM_ID>;

-- 2. Grant Super Admin access
INSERT INTO admin_users (telegram_user_id, role, active)
VALUES (<YOUR_TELEGRAM_ID>, 'super_admin', true)
ON CONFLICT (telegram_user_id) DO UPDATE SET role = 'super_admin', active = true;

-- 3. To test Support Admin boundary (restricted):
-- UPDATE admin_users SET role = 'support' WHERE telegram_user_id = <YOUR_TELEGRAM_ID>;

-- 4. To test Finance Admin boundary (restricted):
-- UPDATE admin_users SET role = 'finance' WHERE telegram_user_id = <YOUR_TELEGRAM_ID>;

-- 5. Grant Organiser privileges to an account:
UPDATE users SET organiser_enabled = true WHERE telegram_user_id = <YOUR_TELEGRAM_ID>;
```

---

## 4. Acceptance Evidence Template Across All 7 Roles

Execute the test cases below and record the evidence, timestamp, and result.

### 4.1 Role 1: Attendee (Guest Experience Hub)

| Test ID | Verified Route | Action to Perform | Expected Result | Security Boundary to Verify | Evidence to Capture | Result | Defect Notes |
|---|---|---|---|---|---|---|---|
| **ATT-01** | `/` and `/events` | Browse homepage, change city to "Bengaluru", click "Nightlife" category filter. | Discovery feed updates with relevant active events. Demo events render with visible "Sample" label. | Filter inputs must not cause SQL or DOM errors. | Screenshot of filtered feed. | `[ ] PASS / [ ] FAIL` | |
| **ATT-02** | `/events/:slug` | Open `sample-bengaluru-indiranagar-rooftop-mixer`. View event details. | Event title, cover, start time (IST), inclusions, and public locality ("Indiranagar") visible. | **Private venue address is CONCEALED** ("Secret Terrace disclosed after booking"). | Screenshot of concealed venue section. | `[ ] PASS / [ ] FAIL` | |
| **ATT-03** | `/events/:slug` | Click "Save Event" bookmark icon. Navigate to `/me` $\rightarrow$ "Saved Events". | Event appears in attendee's saved events list. Clicking "Remove" unsaves it. | Saved events are isolated to this user session. | Screenshot of `/me` saved tab. | `[ ] PASS / [ ] FAIL` | |
| **ATT-04** | `/events/:slug` | Select "Free RSVP Entry" ticket tier (Quantity: 1) and submit booking. | Booking succeeds. Confirmation shows booking ID, digital ticket code, and QR code. | `ENABLE_LIVE_PAYMENTS=false` blocks paid tiers without errors. | Screenshot of confirmed booking pass. | `[ ] PASS / [ ] FAIL` | |
| **ATT-05** | `/me` | Open confirmed booking details in `/me` $\rightarrow$ "My Passes & Bookings". | **Private venue address UNLOCKED:** Exact street address and Google Maps directions now visible. | Only confirmed ticket holders can view private venue. | Screenshot of unlocked venue address. | `[ ] PASS / [ ] FAIL` | |
| **ATT-06** | `/me` | Click "Cancel Booking" on the confirmed booking and confirm prompt. | Booking status updates to `Cancelled`. Ticket is revoked. Capacity is returned to inventory. | Address is concealed again post-cancellation. | Screenshot of cancelled booking status. | `[ ] PASS / [ ] FAIL` | |

---

### 4.2 Role 2: Host (Prospective Organiser Application)

| Test ID | Verified Route | Action to Perform | Expected Result | Security Boundary to Verify | Evidence to Capture | Result | Defect Notes |
|---|---|---|---|---|---|---|---|
| **HST-01** | `/become-a-host` | Inspect value proposition, 21+ safety guidelines, and application form. | Page renders clean layout, benefit cards, and required form fields. | Unauthenticated or non-organizer user sees host onboarding. | Screenshot of `/become-a-host`. | `[ ] PASS / [ ] FAIL` | |
| **HST-02** | `/become-a-host` | Fill in name, Telegram username, city, experience, and submit application. | Redirects to `/become-a-host?sent=1`. Renders 3-step expectation timeline (Review $\rightarrow$ Activation $\rightarrow$ Publishing). | Lead row created in `leads` table. Outbox queues `host_application_received`. | Screenshot of confirmation timeline. | `[ ] PASS / [ ] FAIL` | |
| **HST-03** | `/organiser` | Attempt to navigate to `/organiser` while host application is still pending. | Access denied or prompts user that organizer privileges are not yet active. | User cannot access organizer wizard or drafts without approval. | Screenshot of access barrier. | `[ ] PASS / [ ] FAIL` | |

---

### 4.3 Role 3: Organiser (Event Workspace & Operations)

| Test ID | Verified Route | Action to Perform | Expected Result | Security Boundary to Verify | Evidence to Capture | Result | Defect Notes |
|---|---|---|---|---|---|---|---|
| **ORG-01** | `/organiser` | Sign in as approved organiser. Inspect dashboard. | Dashboard displays KPIs (Active Attendees, Total Events), draft list, and published events. | Organiser sees only their own organization's events. | Screenshot of organiser dashboard. | `[ ] PASS / [ ] FAIL` | |
| **ORG-02** | `/organiser/events/new` | Fill event wizard: Title, category, date, private venue, ticket tiers, capacity. Save draft. | Draft saved with status `draft`. Accessible in organiser draft list. | Draft is completely invisible on public `/events` discovery. | Screenshot of draft editor. | `[ ] PASS / [ ] FAIL` | |
| **ORG-03** | `/organiser/events/:id` | Open draft, review publishing checklist, and click "Publish Event". | Event status transitions to `published`. Event appears immediately on `/events`. | All required fields validated before publish allowed. | Screenshot of published event. | `[ ] PASS / [ ] FAIL` | |
| **ORG-04** | `/organiser/events/:id/announcements` | Post an operational update (e.g. "Gates open at 7:30 PM"). | Announcement is recorded, timestamped, and visible to booked attendees in `/me`. | Only authorized event managers/owners can broadcast announcements. | Screenshot of broadcast update. | `[ ] PASS / [ ] FAIL` | |
| **ORG-05** | `/organiser/events/:id/staff` | Invite a user as `door_staff` or copy staff invite link. | Staff invite token generated with 48h TTL. Appears in pending staff roster. | Cross-event staff scoping: Staff is scoped only to this event ID. | Screenshot of staff management tab. | `[ ] PASS / [ ] FAIL` | |

---

### 4.4 Role 4: Venue Owner (Listing & Partner Portal)

| Test ID | Verified Route | Action to Perform | Expected Result | Security Boundary to Verify | Evidence to Capture | Result | Defect Notes |
|---|---|---|---|---|---|---|---|
| **VEN-01** | `/list-your-venue` | Inspect venue partner benefits and fill in venue listing form. | Form validates name, venue name, email, city, capacity, and amenities. | Honeypot field blocks automated bot spam. | Screenshot of venue form. | `[ ] PASS / [ ] FAIL` | |
| **VEN-02** | `/list-your-venue` | Submit venue listing. | Redirects to `/list-your-venue?sent=1`. Renders 3-step expectation timeline (Vetting $\rightarrow$ Matching $\rightarrow$ Booking). | Lead stored securely. Private venue details are not made public. | Screenshot of 3-step confirmation view. | `[ ] PASS / [ ] FAIL` | |
| **VEN-03** | `/admin` | Attempt to access `/admin` with venue account. | Returns `403 Forbidden` / "You don't have access to this page". | Venue owners cannot access administrative or other venues' data. | Screenshot of 403 access screen. | `[ ] PASS / [ ] FAIL` | |

---

### 4.5 Role 5: Event Staff (Door QR Scanner & Attendance)

| Test ID | Verified Route | Action to Perform | Expected Result | Security Boundary to Verify | Evidence to Capture | Result | Defect Notes |
|---|---|---|---|---|---|---|---|
| **STF-01** | `/staff/join?token=...` | Open staff invite link with designated staff account. | Staff assignment confirmed for designated event. Redirects to event check-in tool. | Invalid or expired token is rejected with 404/410. | Screenshot of invite acceptance. | `[ ] PASS / [ ] FAIL` | |
| **STF-02** | `/staff/scan` | Open mobile door scanner. Present valid attendee digital ticket QR code. | Green checkmark, attendee alias, ticket tier confirmed. Attendance counter increments. | Server verifies HMAC-SHA-256 signature against `QR_HMAC_SECRET`. | Screenshot of successful check-in screen. | `[ ] PASS / [ ] FAIL` | |
| **STF-03** | `/staff/scan` | Immediately scan the exact same ticket QR code a second time. | Rejection notice: **"Ticket Already Checked In"** with prior check-in timestamp. | Prevents replay and duplicate entry attacks. | Screenshot of duplicate scan warning. | `[ ] PASS / [ ] FAIL` | |
| **STF-04** | `/staff/scan` | Present a valid ticket QR code from a *different* event. | Rejection notice: **"Invalid Ticket for this Event"**. | Staff cannot check in tickets across unrelated events. | Screenshot of cross-event rejection. | `[ ] PASS / [ ] FAIL` | |
| **STF-05** | `/staff/scan` | Organiser revokes staff user on `/organiser/events/:id/staff`. Staff attempts check-in. | Staff user immediately blocked (`403 Forbidden`). Cannot scan or view attendees. | **Immediate Staff Revocation:** Token/session invalidated instantly. | Screenshot of revoked access denial. | `[ ] PASS / [ ] FAIL` | |

---

### 4.6 Role 6: Service Provider (Talent & Supplier Application)

| Test ID | Verified Route | Action to Perform | Expected Result | Security Boundary to Verify | Evidence to Capture | Result | Defect Notes |
|---|---|---|---|---|---|---|---|
| **PRV-01** | `/partner-with-us` | Fill in partner/talent proposal (DJ gear, photography, bar services). | Form validates organization, work email, city, and service pitch. | Per-IP rate limiting prevents submission flooding. | Screenshot of partner form. | `[ ] PASS / [ ] FAIL` | |
| **PRV-02** | `/partner-with-us` | Submit partner proposal. | Redirects to `/partner-with-us?sent=1`. Renders 3-step expectation timeline (Capability $\rightarrow$ Matching $\rightarrow$ Logistics). | Lead stored in `leads` table. Zero public exposure of contact details. | Screenshot of 3-step confirmation view. | `[ ] PASS / [ ] FAIL` | |
| **PRV-03** | `/admin` | Attempt to access `/admin` with provider account. | Returns `403 Forbidden` access screen. | Service providers cannot access internal admin data. | Screenshot of 403 access screen. | `[ ] PASS / [ ] FAIL` | |

---

### 4.7 Role 7: Admin, Finance & Support

| Test ID | Verified Route | Action to Perform | Expected Result | Security Boundary to Verify | Evidence to Capture | Result | Defect Notes |
|---|---|---|---|---|---|---|---|
| **ADM-01** | `/admin` | Sign in as Super Admin (`admin_users.role = 'super_admin'`). | All tabs visible: Overview, Events, Organisers, Memberships, Payments & Orders, Leads & Reports, Notifications Outbox, Audit Log. | Unauthenticated visitors redirected to `/signin`. | Screenshot of full admin console. | `[ ] PASS / [ ] FAIL` | |
| **ADM-02** | `/admin` | Sign in as Support Admin (`admin_users.role = 'support'`). Attempt to initiate refund or promote organizer. | Tabs for refunds and role management are hidden. Direct API mutations return `403 Forbidden`. | **Least-Privilege Separation:** Support cannot perform financial or role actions. | Screenshot of restricted support view. | `[ ] PASS / [ ] FAIL` | |
| **ADM-03** | `/admin` | Sign in as Finance Admin (`admin_users.role = 'finance'`). View Payments & Orders. Attempt to edit ticket pricing. | Payment ledger visible. Ticket pricing and admin role edits return `403 Forbidden`. | **Least-Privilege Separation:** Finance cannot alter event configurations. | Screenshot of finance view. | `[ ] PASS / [ ] FAIL` | |
| **ADM-04** | `/admin` | Inspect Notifications Outbox tab. Filter by `failed` or `pending`. Trigger manual retry. | Notification attempt count and error visible. Manual retry sets status back to pending. | Action recorded in `audit_log` with admin actor ID. | Screenshot of outbox retry confirmation. | `[ ] PASS / [ ] FAIL` | |
| **ADM-05** | `/admin` | Inspect Audit Log tab. | Chronological audit trail displays recent event publishes, staff invites, retries, and role edits. | `audit_log` is append-only and cannot be altered or cleared from UI. | Screenshot of audit log entries. | `[ ] PASS / [ ] FAIL` | |

---

## 5. Comprehensive Acceptance Blockers & Pre-Walkthrough Classification

To ensure complete transparency, blockers are classified into distinct categories:

### 5.1 Engineering Defects
- **Status:** **0 Open Engineering Defects**.
- All unit, integration, migration, security, and Playwright browser tests pass. No known regression exists in code.

### 5.2 Missing Test Accounts (Walkthrough Prerequisite)
- **Status:** **Action Required by Owner before Walkthrough**.
- On the protected Preview environment, the synthetic reviewer account covers Role 1 (Attendee).
- To test Role 3 (Organiser), Role 5 (Staff), and Role 7 (Admin/Finance/Support), the owner must either:
  1. Add their personal Telegram ID to `admin_users` table in the Preview PostgreSQL database using the queries in §3.1.
  2. Use two distinct Telegram accounts to test multi-user handoffs (e.g. Organiser inviting Staff, Attendee booking Organiser's event).

### 5.3 Owner Configuration Tasks (Pre-Walkthrough)
- **Status:** **Owner Action Required**.
- Owner must ensure they are logged into the Vercel team dashboard to satisfy Vercel SSO protection when opening the preview URL.
- If using Telegram Login Widget, the domain `strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app` must be allowed or the Mini App link tested.

### 5.4 Legal & Statutory Review Requirements (Pre-Production Gate)
- **Status:** **Open (Must not block Preview Walkthrough, but blocks Production Release)**.
- Registered corporate entity name and Indian corporate address.
- Grievance Officer name, email, and postal address required under Indian IT Rules 2021.
- Formal legal counsel signoff on Terms of Service (`/terms`) and Privacy Policy (`/privacy`).
- GST registration and tax treatment confirmation.

### 5.5 Production-Only Blockers (Post-Acceptance Release Gate)
- **Status:** **Strictly Postponed to Post-Acceptance Phase**.
- DNS record cutover for `nightlifez.com`.
- Email MX/DKIM/SPF configuration.
- Production database provisioning and migration execution (Owner Gate 3).
- Flipping `ENABLE_LIVE_PAYMENTS=true` (must remain `false` during beta preview).
- Merging PRs #17 through #40.

---

## 6. How the Owner Begins the Walkthrough (Immediate Next Steps)

1. **Step 1:** Log in to your Vercel account in your web browser.
2. **Step 2:** Open the verified Preview URL:  
   [`https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app`](https://strangersmeetup-git-feature-m10-beta-readiness-h-a721b2-jakuraa.vercel.app)
3. **Step 3:** To run the **Attendee (Role 1)** test immediately as Preview Reviewer:  
   Open your browser developer console on the Preview site and run:  
   `fetch('/api/auth/preview-reviewer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ next: '/me' }) }).then(() => window.location.href = '/me');`  
   *(Or alternatively, sign in directly using your personal Telegram account via the header "Sign in" button).*
4. **Step 4:** Navigate to `/events` and complete tests `ATT-01` through `ATT-06` (browsing, saving, booking sample rooftop mixer, viewing secret venue reveal, and cancelling).
5. **Step 5:** For Admin (Role 7) access, either configure `ADMIN_BOOTSTRAP_TELEGRAM_ID = <YOUR_TELEGRAM_ID>` in Vercel Preview settings (recommended, fully audited) or execute the verified provisioning SQL from §3.1 on the Preview DB.
6. **Step 6:** Follow the test matrix sequentially for Roles 2 through 7.
7. **Step 7:** Document any discrepancies or defects directly in the acceptance evidence template.

---

## 7. Formal Acceptance Status Declaration

> [!IMPORTANT]
> **Formal Acceptance Walkthrough Status:** **NOT YET PERFORMED.**  
> While engineering verification (M1–M10) is 100% complete with automated tests passing, formal acceptance requires human execution and verification by the repository owner on the protected Preview deployment. Production promotion, PR merging, and live payment enablement must remain blocked until the owner signs off on this walkthrough.
