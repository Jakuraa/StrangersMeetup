# NIGHTLIFEZ Owner Preview Acceptance Checklist

**Milestone:** NIGHTLIFEZ M10 — Beta Readiness, Operational Hardening & Final Engineering Gate  
**Target Environment:** Vercel Protected Preview (`*.vercel.app`)  
**Access Requirement:** Vercel Deployment Protection SSO Authentication required. No public bypass.  
**Live Payments Status:** Strictly `ENABLE_LIVE_PAYMENTS=false`. Free RSVP bookings only.  
**Version:** 1.0 (Beta Candidate)  

---

## 1. Walkthrough Instructions for the Repository Owner

This checklist is structured for a comprehensive, human-led verification walkthrough across all **seven distinct roles** within the protected Vercel Preview environment.

### Prerequisites Before Beginning Walkthrough
1. **SSO Access:** Ensure you have logged in through Vercel Deployment Protection SSO to view the Preview deployment.
2. **Telegram Sign-In:** Authenticate using your real Telegram account on the Preview `/signin` page, or configure owner-approved preview credentials.
3. **Admin Privileges:** If walking through Admin/Finance/Support personas, verify your Telegram user ID is present in `admin_users` table with the corresponding role (`super_admin`, `finance`, or `support`).
4. **Dev Login Notice:** Dev persona switcher is disabled on deployed Vercel environments. All accounts must authenticate via legitimate Telegram web tokens.

---

## 2. Role 1: Attendee Walkthrough

| Attribute | Specification |
|---|---|
| **Entry Point** | `/` (Discovery Feed) $\rightarrow$ `/events` $\rightarrow$ `/me` (Attendee Hub) |
| **Persona / Account** | Any authenticated Telegram user without administrative privileges. |
| **Pass / Fail** | `[ ] PASS / [ ] FAIL` |

### Step-by-Step Actions
1. **Browse Discovery Feed (`/` and `/events`):**
   - Navigate to `/` and view category carousels (Nightlife, Weekend Parties, Dinners, Meetups, Trips).
   - Use the header city selector to choose a city (e.g., Chennai or Bengaluru).
   - Verify category filters, price filters, and date pills (Today, Tomorrow, Weekend, This Month).
2. **Inspect Event Details (`/events/:slug`):**
   - Click an active event card.
   - Verify event title, date/time in IST, cover art, description, and public locality (e.g. "Indiranagar").
   - **Security Boundary:** Confirm that the exact private venue address and Google Maps directions are **hidden** and indicate disclosure only after booking confirmation.
3. **Save and Unsave Event:**
   - Click the "Save Event" bookmark icon on the event card or detail page.
   - Navigate to `/me` and switch to the **"Saved Events"** tab. Confirm the saved event appears.
   - Click "Remove" / unsave; verify it is removed from the saved list.
4. **Complete a Free RSVP Booking:**
   - On the event detail page, select a free ticket tier and quantity (1).
   - Submit booking.
   - Verify redirection or confirmation modal with booking details, digital ticket code, and QR code.
5. **Verify Private Venue Disclosure:**
   - On the booking confirmation screen or in `/me` under **"My Passes & Bookings"**, confirm the exact secret venue address and Google Maps link are now visible.
6. **Self-Service Booking Cancellation:**
   - Under `/me` $\rightarrow$ "My Passes & Bookings", locate the confirmed booking.
   - Click "Cancel Booking" and confirm the prompt.
   - Confirm booking status updates to `Cancelled`, ticket is marked `revoked`, and private venue details are concealed again.

### Known Limitations
- Paid checkout tiers display a notice that live payments are paused during beta preview (`ENABLE_LIVE_PAYMENTS=false`).

---

## 3. Role 2: Host (Prospective Organiser)

| Attribute | Specification |
|---|---|
| **Entry Point** | `/become-a-host` |
| **Persona / Account** | Authenticated Telegram user who does not yet have organiser privileges. |
| **Pass / Fail** | `[ ] PASS / [ ] FAIL` |

### Step-by-Step Actions
1. **Access Host Application Page (`/become-a-host`):**
   - Review the value proposition, secret venue privacy guarantees, and safety standards (21+ age policy, zero-tolerance code of conduct).
2. **Submit Host Application:**
   - Fill in name, Telegram username (`@username`), city, hosting experience, and proposed event concept.
   - Confirm age 21+ and agree to Community Guidelines.
   - Click **Submit Host Application**.
3. **Verify Application Confirmation Screen:**
   - Confirm redirection to `/become-a-host?sent=1`.
   - Verify the 3-step expectation timeline is clearly rendered:
     1. *Curation & Safety Review* (24–48 hour turnaround).
     2. *Host Privilege Activation* (organizer tools unlocked upon approval).
     3. *Draft & Publish Your Event* (capacity, tiers, secret venue setup).
4. **Verify Boundary Isolation:**
   - While pending approval, attempt to navigate to `/organiser`.
   - Verify user cannot access organizer creation wizard until an administrator approves the host.

### Known Limitations
- Host approvals are reviewed manually by platform administrators and are not instant auto-approvals.

---

## 4. Role 3: Organiser (Approved Host)

| Attribute | Specification |
|---|---|
| **Entry Point** | `/organiser` |
| **Persona / Account** | User with `organiser_enabled = true` and membership in an organization. |
| **Pass / Fail** | `[ ] PASS / [ ] FAIL` |

### Step-by-Step Actions
1. **Access Organiser Dashboard (`/organiser`):**
   - Confirm KPIs render correctly (Total Events, Active Attendees, Ticket Inventory).
   - Review list of current drafts and published events.
2. **Create New Event Draft (`/organiser/events/new`):**
   - Enter title, category, city, date, start time, end time, and description.
   - Enter private venue address and toggle "Disclose only after booking confirmation".
   - Configure ticket tiers (General Admission, VIP, Free RSVP) and capacity limits.
   - Save draft and verify draft status.
3. **Publish Event:**
   - Review publishing checklist and click "Publish Event".
   - Verify event appears immediately on public discovery (`/events`) and in the organiser list.
4. **Manage Guest List & Bookings (`/organiser/events/:id/guests`):**
   - View attendee roster, booking reference numbers, and ticket statuses.
   - Test approving a pending attendee request (for tiers requiring approval).
5. **Broadcast Event Announcement:**
   - Open Announcements tab on event workspace.
   - Compose an operational update (e.g., "Doors open at 8:00 PM, enter via East Gate").
   - Click "Broadcast Announcement" and confirm delivery timestamp.
6. **Assign Event Staff:**
   - Open Staff tab on event workspace.
   - Assign a user as `door_staff` or generate a staff invite link (`/staff/join?token=...`).

### Security Boundary to Verify
- **Multi-Tenant Isolation:** Organiser A must be strictly unable to view, edit, cancel, or inspect attendee lists of Organiser B's events (`HTTP 404/403`).

---

## 5. Role 4: Venue / Business Owner

| Attribute | Specification |
|---|---|
| **Entry Point** | `/list-your-venue` |
| **Persona / Account** | Venue representative, club manager, café owner, or studio operator. |
| **Pass / Fail** | `[ ] PASS / [ ] FAIL` |

### Step-by-Step Actions
1. **Access Venue Listing Portal (`/list-your-venue`):**
   - Review venue partner benefits (filling low-occupancy weeknights, verified adult crowds, secret venue privacy).
2. **Submit Venue Details:**
   - Fill in contact name, venue name, email, phone number, city, neighborhood, comfortable capacity, and amenities.
   - Submit form.
3. **Verify Venue Submission Lifecycle View:**
   - Confirm redirection to `/list-your-venue?sent=1`.
   - Verify the 3-step expectation timeline is clearly rendered:
     1. *Venue & Safety Review* (24–48 hours capacity and acoustic vetting).
     2. *Organiser & Format Matching* (matching with supper clubs, mixers, private parties).
     3. *Guaranteed Headcounts & Address Privacy* (confidential address until booking confirmation).
4. **Verify Boundary Isolation:**
   - Confirm submitting a venue does not grant access to the admin console or other venues' private submissions.

---

## 6. Role 5: Event Staff (Door & Check-In Staff)

| Attribute | Specification |
|---|---|
| **Entry Point** | `/staff/scan` or assigned event workspace (`/organiser/events/:id/checkin`) |
| **Persona / Account** | User assigned the `door_staff` role for a specific event. |
| **Pass / Fail** | `[ ] PASS / [ ] FAIL` |

### Step-by-Step Actions
1. **Accept Staff Invite:**
   - Open staff invite link (`/staff/join?token=...`) while signed in.
   - Confirm assignment confirmation for the designated event.
2. **Access Door Scanner Interface:**
   - Navigate to `/staff/scan` or check-in screen on mobile browser.
   - Verify mobile camera viewport opens (or manual code lookup field is available).
3. **Scan Valid Ticket QR Code:**
   - Present an attendee digital ticket QR code.
   - Verify green checkmark, attendee alias, ticket tier, and sound/haptic success feedback.
   - Confirm attendance counter increments by 1.
4. **Duplicate Scan Prevention:**
   - Immediately rescan the same QR ticket.
   - Verify amber/red warning: **"Ticket Already Checked In"** with exact prior check-in timestamp.
5. **Cross-Event Ticket Rejection:**
   - Present a valid ticket belonging to a *different* event.
   - Verify rejection: **"Invalid Ticket for this Event"**.
6. **Verify Least-Privilege Scoping:**
   - Confirm door staff cannot view attendee phone numbers, cannot change ticket pricing, and cannot edit event details.

---

## 7. Role 6: Service Provider / Experiential Partner

| Attribute | Specification |
|---|---|
| **Entry Point** | `/partner-with-us` |
| **Persona / Account** | Mixologist, DJ, photographer, caterer, performer, or brand partner. |
| **Pass / Fail** | `[ ] PASS / [ ] FAIL` |

### Step-by-Step Actions
1. **Access Partnership Portal (`/partner-with-us`):**
   - Review collaboration tracks (talent roster, brand activations, sound & lighting).
2. **Submit Partner Proposal:**
   - Fill in contact name, organization/stage name, work email, city, and capability proposal.
   - Submit form.
3. **Verify Partner Submission Lifecycle View:**
   - Confirm redirection to `/partner-with-us?sent=1`.
   - Verify the 3-step expectation timeline is clearly rendered:
     1. *Capability & Service Review* (2 business day assessment against event itineraries).
     2. *Host & Community Matching* (direct introduction to verified organizers).
     3. *Transparent Operational Logistics* (direct settlements, zero platform cut).
4. **Verify Boundary Isolation:**
   - Confirm provider cannot view private admin data or other partner submissions.

---

## 8. Role 7: Admin, Finance & Support

| Attribute | Specification |
|---|---|
| **Entry Point** | `/admin` |
| **Persona / Account** | User account configured in `admin_users` table. |
| **Pass / Fail** | `[ ] PASS / [ ] FAIL` |

### Step-by-Step Actions
1. **Access Admin Console (`/admin`):**
   - Confirm Super Admin sees all tabs: Overview, Events, Organisers, Memberships, Payments & Orders, Leads & Reports, Notifications Outbox, Audit Log.
2. **Support Admin Boundary Check:**
   - Sign in as `support` admin.
   - Verify Support can view tickets, bookings, and safety reports.
   - **Boundary Enforcement:** Verify Support **cannot** initiate refunds, cannot grant organizer privileges, and cannot modify admin roles (`HTTP 403 Forbidden`).
3. **Finance Admin Boundary Check:**
   - Sign in as `finance` admin.
   - Verify Finance can view payment records and reconcile manual refunds.
   - **Boundary Enforcement:** Verify Finance **cannot** manage admins or edit ticket pricing tiers.
4. **Review Safety Reports & Moderation:**
   - Open `Safety & Reports` tab.
   - Inspect reported user incidents, review moderation notes, and test attendee blocking.
5. **Inspect Notification Outbox:**
   - Open `Notifications Outbox` tab.
   - Filter by status (`pending`, `sent`, `failed`).
   - Trigger a manual retry on a failed notification; verify state updates to pending and audit log captures the event.
6. **Verify Audit Log Integrity:**
   - Open `Audit Log` tab.
   - Verify all administrative actions (event publishes, staff assignments, retries, role changes) are chronologically recorded with actor ID, timestamp, and metadata.

---

## 9. Walkthrough Evidence Record

| Role Verified | Evaluator Telegram Username | Timestamp (IST) | Status | Notes / Observations |
|---|---|---|---|---|
| 1. Attendee | | | `[ ] PASS / [ ] FAIL` | |
| 2. Host | | | `[ ] PASS / [ ] FAIL` | |
| 3. Organiser | | | `[ ] PASS / [ ] FAIL` | |
| 4. Venue Owner | | | `[ ] PASS / [ ] FAIL` | |
| 5. Event Staff | | | `[ ] PASS / [ ] FAIL` | |
| 6. Service Provider | | | `[ ] PASS / [ ] FAIL` | |
| 7. Admin / Finance / Support | | | `[ ] PASS / [ ] FAIL` | |

**Final Owner Signoff Signature:** ___________________________  
**Date:** ___________________________
