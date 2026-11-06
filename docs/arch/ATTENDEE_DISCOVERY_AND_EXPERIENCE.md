# Attendee Discovery & Experience Hub Architecture (M7)

## 1. Executive Summary

Milestone 7 (M7) establishes a consumer-grade discovery engine, transparent recommendation system, and unified attendee experience hub for NIGHTLIFEZ.

Key architectural guarantees:
- **Transparent & Explainable Personalisation:** Recommendation scoring is deterministic and explainable to attendees. Scoring factors are based exclusively on verified inputs: explicit city preference (+40), stated voluntary profile interests (+30), past confirmed event attendance (+25), and explicit bookmarking (+15), alongside trending signals (+20). No opaque algorithmic profiling, intrusive behavioral trackers, or synthetic credentials are used.
- **Privacy-Preserving Location Controls:** Attendees select their discovery city manually by default. Device GPS location is strictly optional, requested only on explicit user click, and never tracked in the background. Distance filtering presents coarse distance bands (e.g. `< 15 km`) rather than precise coordinates to prevent trilateration of secret venues.
- **Strict Mystery Venue Protection:** Mystery venues remain completely masked on discovery feeds, search listings, public event pages, and unconfirmed booking statuses. The exact address and venue directions are securely revealed only on authoritative confirmed passes.
- **Server-Authoritative Digital Passes & Verification:** Digital ticket passes integrate seamlessly with the M6 cryptographic QR engine. A rendered QR code on the client is never treated as independent payment proof; only server-validated confirmed bookings generate issued tickets.
- **Unified Attendee Experience Hub (`/me`):** Consolidates active and past passes, bookmarking/saved events with optimistic UI sync, and host operational announcements into a responsive, mobile-first interface while preserving legacy accessibility and safety reporting structures.
- **Tenant & User Data Isolation:** User saved events, bookings, and private host communications are strictly scoped to the authenticated session. Unauthenticated access returns HTTP 401; cross-user lookups fail closed with HTTP 404.

---

## 2. Component Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Attendee Discovery Hub UI                        │
│   (/events · /me · /bookings/:id · /nightlife · /dinners · /trips)       │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ Discovery Feed   │    │ Saved Events     │    │ Attendee Hub     │
│ API (/api/feed)  │    │ API (/api/save)  │    │ (/api/me/*)      │
└────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ Recommendation   │    │ saved_events     │    │ bookings &       │
│ Engine & Ranking │    │ Table (DB-020)   │    │ ticket_scans     │
└────────┬─────────┘    └──────────────────┘    └────────┬─────────┘
         │                                               │
         ▼                                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     PostgreSQL Authoritative Storage                     │
│    (events · ticket_types · bookings · saved_events · event_team)        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Recommendation Scoring & Personalisation Engine

The recommendation engine (`lib/services/discovery-feed.js`) scores eligible published events using transparent, inspectable criteria:

```javascript
score = 0;

// 1. Trending signal: 40%+ capacity booked or 3+ confirmed guests
if (capacity > 0 && seatsTaken >= Math.min(3, Math.floor(capacity * 0.4))) {
  score += 20;
  reasons.push(`Popular in ${event.city}`);
}

// 2. Starts soon (within 5 days): recency boost
if (hoursUntilStart > 0 && hoursUntilStart < 120) {
  score += 15;
}

// 3. User Context Matching (Signed-in Attendee)
if (userContext) {
  // Preferred city match
  if (userContext.preferredCity === event.city) {
    score += 40;
    reasons.push(`In your preferred city (${userContext.preferredCity})`);
  }
  // Voluntary profile interest match
  if (userContext.profileInterests.includes(event.category)) {
    score += 30;
    reasons.push(`Matches your interest in ${categoryLabel}`);
  }
  // Previously attended event category match
  if (userContext.attendedCategories.includes(event.category)) {
    score += 25;
    reasons.push('Similar to events you joined');
  }
  // Saved event category match
  if (userContext.savedCategories.includes(event.category)) {
    score += 15;
    reasons.push('Based on your saved events');
  }
}
```

Every decorated event card displays its primary recommendation reason (`e.g. ✨ Matches your interest in Nightlife`, `✨ Similar to events you joined`), providing complete transparency.

---

## 4. Location Intelligence & Privacy Boundaries

### 4.1 Manual City Default
Discovery defaults to manual city selection across all supported South Indian markets (Bengaluru, Chennai, Hyderabad, Kochi, Goa, Coimbatore, Mysuru, Puducherry, Madurai, Kozhikode, Mangaluru, etc.).

### 4.2 Explicit Geolocation & Distance Bands
- Device GPS coordinates are requested **only** when the attendee clicks the `"Near You (50km)"` action.
- If coordinates are rejected or unsupported, the interface falls back gracefully to city-level listings without error modals or blocking screens.
- Distance calculations utilize the standard Haversine formula against city/locality center coordinates.
- Events with `venue_privacy = 'private'` format distances into coarse ranges (`< 5 km`, `< 15 km`, `< 30 km`) rather than precise floating-point meters, preventing mathematical venue trilateration.
- The `lat` and `lng` properties of private venue events are strictly set to `null` on public feeds.

### 4.3 Mystery Venue Secrecy Invariant
- Public event listings and detail pages display the public area (`area_public`) and a branded teaser: `"Mystery Venue — Revealed after confirmed booking"`.
- Private street addresses and maps URLs are stripped by `toPublicEvent()` unless `venue_privacy === 'public'`.
- Unconfirmed, cancelled, or pending bookings receive `venue: null`. Only confirmed or checked-in bookings receive `b.venue_private`.

---

## 5. Multi-Facet Search & Filtering

The discovery feed supports independent and combinable filtering:

| Filter Parameter | Options / Format | Behavior |
|---|---|---|
| `city` | Slug or canonical name (`bengaluru`, `chennai`) | Filters events by market |
| `category` | `nightlife`, `meetup`, `dinner_club`, `weekend_trip`, etc. | Filters events by canonical category |
| `when` | `today`, `tomorrow`, `weekend`, `week`, `month` | Computes IST (UTC+5:30) date range |
| `price` | `all`, `free`, `paid` | Evaluates tier availability and pricing |
| `sort` | `recommended`, `trending`, `date_asc`, `date_desc`, `price_low` | Deterministic ordering |
| `q` | Free-text string (max 80 chars) | ILIKE search on title, summary, area |

---

## 6. Attendee Experience Hub (`/me`) & Digital Passes

The member dashboard (`/me`) acts as a unified Attendee Experience Hub with three reactive sections:

### 6.1 My Passes & Bookings
- Tabbed filters: `All Bookings`, `Upcoming`, and `Past`.
- Cards display status pills (`Confirmed`, `Checked in`, `Awaiting host`, `Declined`, `Refunded`), short reference codes (`#SM-XXXXXXXX`), and action buttons (`View Pass & Venue →`).
- Checked-in bookings render a verified check-in badge: `✓ Checked In`.

### 6.2 Saved Events (Bookmarks)
- Attendee bookmarks are persisted in `saved_events` via `POST /api/events/:id/save` and removed via `DELETE /api/events/:id/save`.
- Immediate optimistic UI update with rollback on network failure.
- Displays full event card with direct link to details and a 1-click `"Remove"` button.

### 6.3 Host Updates & Operational Announcements
- Pulls operational messages posted by event hosts via M6 organiser announcements API.
- Filtered to events where the attendee holds a confirmed or checked-in booking.
- Pinned announcements display priority indicator (`📌`).

### 6.4 QR Pass & Admittance Display (`/bookings/:id`)
- Integrates M6 cryptographic ticket signatures (`NIGHTLIFEZ:v1:...`).
- Embeds SVG QR code graphic and human-readable alphanumeric ticket code for door scanners.
- Door check-in timestamp (`checkedInAt`) is displayed once scanned by staff.
- Unlocks the mystery venue address and Google Maps navigation link.

---

## 7. Database Migration 020

File: `migrations/020_attendee_discovery_and_experience.sql`

```sql
-- Attendee bookmarked / saved events table
CREATE TABLE IF NOT EXISTS saved_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_saved_events_user_event UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_events_user ON saved_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_events_event ON saved_events(event_id);

-- Performance indexes for attendee discovery
CREATE INDEX IF NOT EXISTS idx_events_discovery_status_start ON events(status, start_at) WHERE status IN ('published', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_events_discovery_city ON events(city, status, start_at) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_events_discovery_category ON events(category, status, start_at) WHERE status = 'published';
```

---

## 8. Automated Test & Verification Matrix

Automated test suites verify end-to-end functionality across unit, integration, and browser workflows:

| Test Suite | Tests | Result | Coverage |
|---|:---:|:---:|---|
| `test/m7-attendee-experience.test.js` | 12 | ✅ Passed | Date filter parsing, recommendation scoring math, user context building, feed structure & modules, category/price/date filtering, GPS distance bands, saved events lifecycle & idempotency, tenant isolation, QR ticket integration & check-in reflection, host announcements, search & sorting |
| `test/migrations.test.js` | 8 | ✅ Passed | Migration 020 inventory, idempotency, serialization lock, boundary enforcement, and table indexes |
| `test/auth.test.js` & `test/personas.test.js` | 40 | ✅ Passed | Session verification, attendee profile routing, booking list regression, persona permissions |
| Playwright E2E (`e2e/attendee-journey.spec.js`, `e2e/location-picker.spec.js`) | 16 | ✅ Passed | Instant discovery, location dialog, alias matching, city/category filters, free booking, pass rendering, venue unlock, mobile touch targets |
| Full Regression Suite (`test/*.test.js`) | 656 | ✅ 654 Passed (2 skipped) | 0 failures across all 22 test suites |
| Linter (`npm run lint`) | 149 files | ✅ Clean | 149/149 files cleanly formatted |
