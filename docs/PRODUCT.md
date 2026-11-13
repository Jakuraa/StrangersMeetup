# NIGHTLIFEZ — Product Scope & Functionality

**Target Audience:** Adults 21+ across South India  
**Brand Identity:** NIGHTLIFEZ — vibrant social discovery, hosted nightlife, supper clubs, weekend trips, and curated social experiences.  
**Core Promise:** Safe, curated, honest social events with transparent pricing, zero bots, and guaranteed real-world fulfillment.

---

## 1. Product Vision & Value Proposition

NIGHTLIFEZ bridges the gap between digital discovery and real-world connection. Traditional event platforms are impersonal ticket brokers, while dating apps often generate fatigue without real-world interaction. NIGHTLIFEZ combines editorial curation with tight-knit community dynamics:

- **Curated Small-Group Experiences:** Dinners, secret supper clubs, cocktail mixers, private house parties, pub crawls, and weekend getaways.
- **Privacy & Safety First:** Venue locations are protected until booking confirmation. Community guidelines and 21+ age verification are strictly enforced.
- **Real-Time Community Loop:** Post-booking integration with Telegram delivers automated private group access, attendee updates, and digital QR ticket passes.

---

## 2. Target Personas

### A. Attendee / Member (Adults 21+)
- **Motivation:** Looking to meet like-minded people, discover new spots, and attend safe, well-organized social events without awkwardness.
- **Behavior:** Browses upcoming events by city or vibe; signs in via Telegram; books a ticket or buys a community membership; joins the event group chat; checks in at the venue using a QR pass.

### B. Experience Host / Organiser
- **Motivation:** Passionate individuals, event curators, DJs, or community builders wanting to host intimate dinners, parties, or trips.
- **Behavior:** Submits host application via `/become-a-host`; accesses the host workspace once approved; schedules events, monitors attendee capacity, and scans attendee QR tickets at the door.

### C. Venue & Service Partner
- **Motivation:** Premium restaurants, rooftop bars, boutique resorts, and entertainment spaces wanting curated foot traffic during off-peak or themed evenings.
- **Behavior:** Submits venue details via `/list-your-venue` or `/partner-with-us`; collaborates with NIGHTLIFEZ curators for dedicated hosting slots.

### D. Administrative & Operational Team
- **Super Admin:** Platform configuration, team provisioning, financial reconciliation, and media management.
- **Event Manager:** Event creation, capacity monitoring, and door check-in oversight.
- **Moderator:** Community chat safety, attendee verification, and incident management.
- **Finance:** Order reconciliation, refund processing, and payout tracking.

---

## 3. Geographic Coverage & City Hubs

NIGHTLIFEZ operates across South India with dedicated city landing hubs:

| City Hub | Primary Experience Categories | Signature Neighborhoods |
|---|---|---|
| **Chennai** | Rooftop mixers, supper clubs, coastal weekend trips | Besant Nagar, ECR, Nungambakkam, Alwarpet |
| **Bangalore** | Microbrewery crawls, tech mixers, techno nights, house parties | Indiranagar, Koramangala, Church Street, HSR Layout |
| **Puducherry** | Heritage walking dinners, beach parties, boutique cafe meetups | White Town, Promenade Beach, Auroville |
| **Kochi** | Art dinners, waterfront socials, backwater weekend escapes | Fort Kochi, Panampilly Nagar, Kakkanad |
| **Goa** | Sundowner parties, secret beach gigs, coastal retreats | Anjuna, Vagator, Assagao, Palolem |
| **Hyderabad** | Lounge socials, comedy dinners, nightlife crawls | Jubilee Hills, Banjara Hills, Gachibowli |

---

## 4. Primary User Journeys

```
 ┌────────────────┐       ┌─────────────────┐       ┌──────────────────┐
 │ Public Catalog │ ────► │  Event Details  │ ────► │  Booking Hold    │
 │ (No sign-in)   │       │ (Policy/Rules)  │       │ (15m Capacity Tx)│
 └────────────────┘       └─────────────────┘       └────────┬─────────┘
                                                             │
                                                             ▼
 ┌────────────────┐       ┌─────────────────┐       ┌──────────────────┐
 │ Door Check-In  │ ◄──── │ Telegram DM &   │ ◄──── │ Verified Payment │
 │ (HMAC QR Scan) │       │ Group Invite    │       │ (Webhook Web Tx) │
 └────────────────┘       └─────────────────┘       └──────────────────┘
```

### 1. Discovery & Exploration
- Public event feed available without mandatory sign-in or intrusive paywalls.
- Filtering by city, category (nightlife, supper club, trips, mixers), and date.
- **Honest metrics:** Zero fabricated countdowns, phantom "only 2 left" alerts, or fake attendee avatars. Every number is queried from active rows.

### 2. Event Evaluation
- Clear breakdowns of ticket inclusions (food, drinks, entry passes).
- Transparent refund and cancellation policy displayed before checkout.
- Clear disclosure of safety measures and gender-balanced seating commitments.

### 3. Booking & Payment Hold
- User initiates booking; atomic transaction reserves capacity with a 15-minute `hold_expires_at` timestamp.
- User signs in securely via Telegram (Login Widget or Mini App).
- Checkout redirect to provider (SuperProfile / UPI).
- Abandoned checkouts automatically release capacity upon hold expiration.

### 4. Automated Post-Purchase Fulfillment
- Payment webhook triggers atomic transition from `pending_payment` to `confirmed`.
- Asynchronous notification engine dispatches:
  1. Telegram DM to buyer with booking confirmation.
  2. Single-use, 24-hour expiring Telegram invite link to the private event group chat.
  3. Digital QR pass containing an HMAC-SHA256 signature for door admission.

### 5. On-Site Check-In
- Organiser opens the mobile scanner at `/admin/checkin` or event dashboard.
- Attendee presents their QR ticket pass.
- Scanner verifies the signature and records check-in timestamp in real-time, preventing double entry or pass sharing.

### 6. Partner & Host Onboarding
- Dedicated landing routes for hosts (`/become-a-host`), venues (`/list-your-venue`), and partners (`/partner-with-us`).
- Honeypot fields, rate limiting, and Zod schema validations protect incoming leads against spam.

---

## 5. Scope Boundaries & Deferred Features

To maintain launch velocity and absolute stability, the following features are intentionally decoupled from the initial launch:

| Feature Area | Current Status | Launch Rationale |
|---|---|---|
| **Live Native UPI Payments** | Scaffolded, gated by `ENABLE_LIVE_PAYMENTS=false` | Requires final production merchant registration and owner signoff. External SuperProfile checkout handles launch transactions safely. |
| **Algorithmic Matchmaking** | Deferred | Matchmaking algorithms without critical attendee mass create deceptive experiences. Intimate human curation is used at launch. |
| **Public Chat History** | Deferred | Private groups are created per event on Telegram to ensure end-to-end encryption and user autonomy. |
