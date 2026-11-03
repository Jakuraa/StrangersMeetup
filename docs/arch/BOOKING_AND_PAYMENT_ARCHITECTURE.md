# NIGHTLIFEZ — Booking & Payment Architecture

> **Milestone:** M4 Payment, Booking and Revenue Readiness Audit  
> **Status:** Verified & Audited  
> **Target Branch:** `launch-mvp`  
> **Safety Invariant:** `ENABLE_LIVE_PAYMENTS=false` across all environments  

---

## 1. Executive Summary & Design Principles

NIGHTLIFEZ is designed with a **Free RSVP-first architecture** for its MVP launch. The platform provides frictionless discovery, attendee RSVPs, mystery venue disclosure, and private community group integration without taking custody of attendee funds or acting as an unlicensed payment intermediary.

### Core Architectural Principles
1. **Free-First MVP:** Free ticket tiers confirm immediately upon user request (or host approval if configured) with zero payment friction.
2. **Strict Separation of Booking & Payment State:** An event reservation cannot be marked `confirmed` or `paid` by client assertions, client redirects, or manual payment receipts. A booking is only confirmed by internal free tier logic or a cryptographically authenticated webhook from an external provider.
3. **Zero Payment Custody (No Money Aggregation):** NIGHTLIFEZ does not collect, hold, or split ticket revenue. Paid ticketing uses hosted redirects to verified external platforms (SuperProfile) where merchant onboarding, banking, and settlement are handled directly by the external provider.
4. **Fail-Closed Security Boundary:** In all pre-production and launch-mvp environments, `ENABLE_LIVE_PAYMENTS=false` strictly disables external checkout redirects.
5. **Atomic Concurrency Protection:** Inventory checks and booking allocations are executed inside PostgreSQL transactions with row-level locks (`SELECT ... FOR UPDATE`), mathematically preventing overselling.

---

## 2. Complete Booking Lifecycle

```
[ Attendee Discovery ]
        │
        ▼
[ Select Event & Tier ]
        │
   ┌────┴─────────────────────────────┐
   ▼                                  ▼
[ Free Tier ]                  [ Paid Tier ]
   │                                  │
   ├─► Check Age (21+)                ├─► Live Payments Guard (ENABLE_LIVE_PAYMENTS=true?)
   ├─► Block List Check               │     └─► If FALSE: Redirect to Event Page (Disabled)
   ├─► Concurrency Row Lock           │
   ├─► Capacity Assertion             ├─► Generate Checkout Intent (Random Ref)
   │                                  ├─► Redirect to Hosted SuperProfile Checkout
   ├─── Requires Host Approval?       │
   │       ├─► YES: pending_approval  ├─► Attendee Completes Payment Off-Platform
   │       └─► NO:  confirmed         │
   │                                  ▼
   │                           [ SuperProfile Webhook ]
   │                                  │
   │                                  ├─► Verify X-Webhook-Secret (Constant-time)
   │                                  ├─► Verify Currency (INR) & Expected Amount (Paise)
   │                                  ├─► Match Intent Ref or Verified Email Hash
   │                                  └─► Confirm Order Booking (Atomic Transaction)
   │                                              │
   └──────────────────────┬───────────────────────┘
                          │
                          ▼
              [ Booking Confirmed ]
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
[ Ticket Pass ]   [ Mystery Venue ]   [ Telegram Invite ]
(/bookings/:id)     (Private Address    (Single-use 24h
                     & Google Maps)      chat link)
```

### 2.1 Discovery & Selection
- **Public Discovery:** Attendees explore events via `/events`, `/trips`, and city/locality filters.
- **Event Presentation:**
  - Card art and metadata render server-side.
  - Mystery venues display a branded teaser (*"Mystery Venue — Revealed after confirmed booking"*).
  - Private addresses and exact venue coordinates are never exposed in public discovery endpoints.

### 2.2 Free Reservation Flow (`POST /api/events/:id/book`)
- **Route Handler:** `lib/handlers/organiser.js:bookTicket` $\to$ `lib/services/ticketing.js:bookTier`.
- **Pre-Conditions:**
  1. Signed-in attendee session (`requireUser`).
  2. CSRF token validation (`requireCsrf`).
  3. Per-user rate limiting: 10 booking requests per 10 minutes (`rateLimit('book:' + user.id, 10, 600)`).
  4. Age confirmation: Attendee must have verified 21+ status (`user.age_confirmed_21`).
  5. Social safety: Mutual block check (`user_blocks` table) prevents blocked users from booking an organiser's events.
- **Transaction Semantics (`db.tx`):**
  - Acquires row lock on the event: `SELECT * FROM events WHERE id = $1 FOR UPDATE`.
  - Verifies event status is `published` and start time is in the future (`start_at > now()`).
  - Fetches and verifies ticket tier: must be `active`, and `kind === 'free'`.
  - Rejects paid tiers immediately: throws HTTP 409 `paid_on_superprofile`.
  - Evaluates duplicate submissions: checks for prior active bookings (`pending_approval`, `pending_payment`, `confirmed`, `checked_in`). If found, returns `{ existing: true, bookingId, status }` without allocating extra seats.
  - Evaluates remaining capacity:
    $$\text{eventLeft} = \text{capacity} - \text{seatsTaken}(c, \text{eventId})$$
    $$\text{tierLeft} = \text{tier.quantity} - \text{tierSeatsTaken}(c, \text{tier.id})$$
    If $\min(\text{eventLeft}, \text{tierLeft}) < \text{quantity}$, aborts with HTTP 409 `sold_out`.
  - Creates booking record:
    - If `requires_approval = true`: `status = 'pending_approval'`, holding zero inventory until host approval.
    - If `requires_approval = false`: `status = 'confirmed'`, `payment_mode = 'free'`, `confirmed_at = now()`.
  - Enqueues notification: `booking_confirmed` or `booking_request`.
  - Emits audit log entry (`audit()`).

### 2.3 Paid Reservation Flow (Hosted SuperProfile Checkout)
- **Initiation:** Attendee clicks "Book Tickets" $\to$ `GET /checkout/:slug`.
- **Payment Safety Boundary:**
  - `checkoutForEvent(row)` inspects `livePayments()`.
  - If `ENABLE_LIVE_PAYMENTS=false`, checkout redirects back to `/events/:slug` with no intent created.
  - In Preview environments, paid checkouts are blocked unless `ALLOW_PREVIEW_PAID_CHECKOUT=true`.
- **Checkout Intent Generation (`createCheckoutIntent`):**
  - Generates an unguessable 8-character Crockford base32 tracking reference (40 random bits).
  - Inserts row into `checkout_intents` with a 72-hour TTL (`INTENT_TTL_HOURS = 72`).
  - Appends tracking query parameters to external hosted checkout URL:
    - `ref`: Unique tracking token.
    - `utm_source`: `strangersmeetup`
    - `utm_medium`: `site`
    - `utm_campaign`: `<event-slug>`
    - `utm_content`: `<ref>`
  - Returns 302 redirect to external SuperProfile page.
  - Zero financial data (card numbers, UPI IDs, bank accounts) touches NIGHTLIFEZ servers.

### 2.4 Webhook Ingestion & Order Confirmation (`POST /api/webhooks/superprofile`)
- **Authentication:** `ticketProvider().verifyWebhook(req.headers)` compares `x-webhook-secret` using constant-time string equality (`safeEqual`). Requires secret length $\ge 24$ characters.
- **Rate Limiting:**
  - Failed signatures: `spbad:<hashIp>` (30 requests per 10 minutes) to prevent brute-force attacks.
  - Valid signatures: `sp:<hashIp>` (300 requests per minute).
- **Processing (`applyOrderEvent` $\to$ `applyPurchase`):**
  - Idempotent insert into `external_orders` using `ON CONFLICT (order_id) DO NOTHING`. Replayed webhooks return `{ result: 'duplicate' }`.
  - Currency validation: Must be `INR`. Mismatches are flagged for finance review.
  - Price reconciliation: Compares webhook `amount` against expected ticket tier price $\times$ quantity in paise. Amount mismatches are flagged (`flag_reason = 'amount_mismatch'`) and confirm zero seats.
  - Identity matching:
    1. Primary: Resolves intent by tracking `ref` passed back by SuperProfile.
    2. Fallback: Matches buyer's hashed email against active registered users (`email_hash`).
    3. Unmatched: If neither matches, order remains in `match_state = 'unmatched'` for manual bot `/claim` or admin finance linking.
  - Seat confirmation: Inside transaction with order locked, inserts confirmed booking with `source = 'superprofile'`, `payment_mode = 'external'`, and updates `external_orders.match_state = 'matched'`.

### 2.5 Ticket Pass & Mystery Venue Reveal
- **Attendee View (`GET /api/bookings/:id`):**
  - Strictly authorized to the booking owner (`b.user_id = userId`). Unauthorized guests receive 404/401.
  - **Venue Privacy Rule:**
    - If status is `confirmed` or `checked_in`: Response includes `venue` (private address), `mapsUrl`, `contact` (on-ground coordinator phone and WhatsApp link), and single-use Telegram `invite` link.
    - If status is `pending_approval`, `cancelled`, or `refunded`: Venue details remain `null`.

### 2.6 Cancellation & Reversal Lifecycle
- **Trigger:** Upstream refund or cancellation on SuperProfile triggers webhook (`event: 'refund'` or `'cancelled'`).
- **Processing (`applyReversal`):**
  - Acquires lock on `external_orders` row.
  - If booking was already checked in (`status === 'checked_in'`), flags order for finance investigation (`flag_reason = 'refund_after_check_in'`) and preserves audit trail.
  - For active bookings (`confirmed`):
    - Updates booking status to `refunded` or `cancelled`.
    - Revokes unused Telegram invite links (`revoked_at = now()`).
    - If attendee already joined the private group, invokes Telegram API `removeFromChat` to revoke community access.
    - Queues `booking_refunded` notification.
- **Out-of-Order Reversals:**
  - If a refund notification arrives before the initial purchase notification, a row is inserted in `external_orders` with `status = 'refunded'` and `before_purchase: true`.
  - When the late purchase notification eventually arrives, it conflicts on `order_id` and is safely discarded as a duplicate.

---

## 3. Concurrency Locking & Race-Condition Mitigations

| Threat Vector | Mitigation Mechanism | Implementation Location |
| :--- | :--- | :--- |
| **Simultaneous Bookings for Last Seat** | Row-level locking on `events` table (`SELECT ... FOR UPDATE`) inside serialized transaction | `lib/services/ticketing.js:66` |
| **Concurrent Double Submission** | Attendee duplicate check under event lock; returns existing booking id | `lib/services/ticketing.js:100-111` |
| **Duplicate Webhook Delivery** | PostgreSQL unique constraint on `external_orders(order_id)` with `ON CONFLICT DO NOTHING` | `lib/services/orders.js:100` |
| **Replayed Intent References** | Intent lookup validates `expires_at > now()`; single booking assignment per ref | `lib/services/orders.js:95` |
| **Concurrent Host Decisions** | Event row lock and booking lock (`SELECT ... FOR UPDATE`); status check rejects non-pending | `lib/services/ticketing.js:160-162` |
| **Out-of-Order Refund vs Purchase** | Pre-purchase refund persistence blocks late purchase confirmation | `lib/services/orders.js:153-162` |

---

## 4. Revenue & Monetization Architecture: Feature Matrix

| Monetization Model | Status | Technical Implementation | Operational & Legal Boundary |
| :--- | :--- | :--- | :--- |
| **Free RSVP Entry** | **Implemented & Tested** | Full in-app booking, atomic capacity check, mystery venue disclosure, ticket pass. | Active for MVP launch. No payment collection. |
| **SuperProfile Hosted Checkout** | **Implemented & Tested (Gated)** | External redirect via `/checkout/:slug`, tracking refs, webhook verification, order reconciliation. | Gated off (`ENABLE_LIVE_PAYMENTS=false`). Zero money collection. |
| **BookMyShow Link-Outs** | **Implemented & Tested** | Curated external feeds and attributed event link-outs (`external_url`). | Link-out only. Non-bookable on NIGHTLIFEZ. |
| **Independent Organiser Ticket Collection** | **Implemented & Tested** | Organisers manage their own ticketing off-platform or host free RSVPs on NIGHTLIFEZ. | Platform does not aggregate organiser funds. |
| **Platform Listing Fees** | **Proposed / Manual** | B2B listing fee for featured placements. Manual invoice by finance team. | No in-app payment rails required. Handled via bank transfer. |
| **Confirmed-Attendee Commission Invoicing** | **Proposed** | Post-event invoicing to organisers based on confirmed check-in count. | Under legal evaluation. Requires commercial contracts. |
| **Telegram Stars Memberships** | **Implemented & Tested** | In-app digital goods sale for VIP memberships via Telegram Bot API (`XTR`). | Compliant with Telegram terms for digital access goods. |
| **Direct Payment Gateway Integration** | **Unavailable (Prohibited)** | Legacy provider SDKs removed. Direct API checkout is disabled. | Prohibited until RBI PA/PG and escrow requirements are fulfilled. |

---

## 5. Security & Access Boundaries

1. **Attendee Data Isolation:**
   - Attendees can only access their own booking passes (`getUserBooking(userId, bookingId)`).
   - Attempts to access another attendee's booking ID return HTTP 404.
2. **Cross-Organiser Isolation:**
   - Organiser A cannot view attendees, answers, or check-in state of Organiser B's events (`manageableEvent(user, eventId, { action: 'event.view_guests' })`).
   - Unauthorized access attempts are rejected with HTTP 403 / 404.
3. **No In-App Ticket Refunds:**
   - Calling in-app refund APIs for ticket orders explicitly throws HTTP 501 `NOT_SUPPORTED_IN_APP`.
   - Ticket refunds must be initiated by finance/support directly on SuperProfile.
4. **Refusal of Manual Payment Proofs / Screenshots:**
   - No route or schema field accepts UPI transaction screenshots, payment slips, or client-asserted payment confirmations.
   - Payment status can ONLY be updated by a verified external webhook, an authorized finance administrator (`/api/admin/orders/:id/link`), or a cryptographically verified Telegram bot claim.
