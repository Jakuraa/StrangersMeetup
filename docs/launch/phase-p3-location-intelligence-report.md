# NIGHTLIFEZ P3 — Location Intelligence V1 Report

**Repository:** `Jakuraa/StrangersMeetup`  
**Feature Branch:** `feature/p3-location-intelligence`  
**Base Commit:** `9d48147d0cb793e7997985f987f0fd6ff022e696` (`launch-mvp`)  
**Target Branch:** `launch-mvp`  
**Date:** 2026-11-02  
**Status:** Complete — Ready for Review (Do Not Merge)

---

## 1. Executive Summary

NIGHTLIFEZ Location Intelligence V1 establishes the first official, authoritative geospatial and administrative location foundation for NIGHTLIFEZ across South India and the wider Indian Union.

Built strictly against India's official **Local Government Directory (LGD)** maintained by the Ministry of Panchayati Raj (`https://lgdirectory.gov.in/`), this foundation delivers:
1. **Administrative Integrity:** Official, stable LGD codes for all 36 States and Union Territories (28 States + 8 UTs) and all 87 official districts across Tamil Nadu (38), Karnataka (31), Kerala (14), and Puducherry (4).
2. **Business Separation:** Clean architectural decoupling between Government LGD administrative hierarchy and NIGHTLIFEZ business `market_tier` classifications (`primary_market`, `expansion_market`, `getaway_destination`).
3. **Geospatial Discovery:** Zero-dependency, immutable, parallel-safe PostgreSQL `haversine_km` function paired with matching JS geospatial utilities, supporting nearby event discovery within configurable radii (1–500 km, default 50 km).
4. **Attendee Privacy Boundary:** Ironclad secrecy for private venues. For events configured with `venue_privacy = 'disclosed_after_booking'`, exact coordinates and secret addresses (`address_private`, `maps_url`) are strictly withheld from public discovery and search endpoints. Only approximate distance badges are displayed until booking confirmation.
5. **Architectural Profile Isolation:** Strict separation of user location scopes:
   - **Home City:** Persisted in `users.city` via `PATCH /api/me/profile`.
   - **Discovery / Search City:** Session/URL query param (`?city=slug`) that never overwrites the user's home profile.
   - **Device Geolocation:** Ephemeral GPS coordinates via `navigator.geolocation` (`?lat=...&lng=...&radius_km=50`) with graceful inline fallbacks.
6. **Responsive Accessibility:** Desktop and mobile `<dialog>` location picker supporting instant alias matching (e.g. "Bangalore" -> Bengaluru, "Kovai" -> Coimbatore, "Madras" -> Chennai, "Trichy" -> Tiruchirappalli), region filtering, and quick-select pills with WCAG 2.1 AA compliance (touch targets $\ge$ 44px, label in name, escape-key trapping).
7. **P2 Medium Risk Remediation:** Resolved the issue in `lib/services/permissions.js` where active event admins publishing via the wizard without `organiser_enabled=true` had their capability recorded as revoked.

---

## 2. Official LGD Data Foundation

All administrative geographic identifiers are sourced directly from India's official Local Government Directory (LGD), Ministry of Panchayati Raj, Government of India.

### 2.1 States and Union Territories (36 Total)
All 28 States and 8 Union Territories are seeded in `location_states` with verified LGD codes:
- **South India Core:** Tamil Nadu (`33`), Karnataka (`29`), Kerala (`32`), Puducherry (`34`), Andhra Pradesh (`28`), Telangana (`36`), Goa (`30`).
- **Union Territories:** Delhi (`7`), Chandigarh (`4`), Jammu & Kashmir (`1`), Ladakh (`37`), Andaman & Nicobar Islands (`35`), Lakshadweep (`31`), Dadra & Nagar Haveli and Daman & Diu (`38`), Puducherry (`34`).
- **All 36 records** have unique LGD codes, ISO state codes, `verified = true`, and `source_url = 'https://lgdirectory.gov.in/'`.

### 2.2 District Coverage (87 Total)
Official LGD district codes seeded across target South Indian states:
- **Tamil Nadu (38 Districts, State LGD 33):** Ariyalur (`610`), Chengalpattu (`730`), Chennai (`568`), Coimbatore (`569`), Cuddalore (`570`), Dharmapuri (`571`), Dindigul (`572`), Erode (`573`), Kallakurichi (`729`), Kancheepuram (`574`), Kanniyakumari (`575`), Karur (`576`), Krishnagiri (`577`), Madurai (`578`), Mayiladuthurai (`735`), Nagapattinam (`579`), Namakkal (`580`), The Nilgiris (`587`), Perambalur (`581`), Pudukkottai (`582`), Ramanathapuram (`583`), Ranipet (`731`), Salem (`584`), Sivagangai (`585`), Tenkasi (`733`), Thanjavur (`586`), Theni (`588`), Thiruvallur (`589`), Thiruvarur (`590`), Tiruchirappalli (`591`), Tirunelveli (`592`), Tirupathur (`732`), Tiruppur (`634`), Tiruvannamalai (`593`), Thoothukkudi (`594`), Vellore (`595`), Villupuram (`596`), Virudhunagar (`597`).
- **Karnataka (31 Districts, State LGD 29):** Bagalkote (`524`), Ballari (`528`), Belagavi (`527`), Bengaluru Rural (`526`), Bengaluru Urban (`525`), Bidar (`529`), Chamarajanagara (`531`), Chikkaballapura (`630`), Chikkamagaluru (`532`), Chitradurga (`533`), Dakshina Kannada (`534`), Davangere (`535`), Dharwad (`536`), Gadag (`537`), Hassan (`539`), Haveri (`540`), Kalaburagi (`538`), Kodagu (`541`), Kolar (`542`), Koppal (`543`), Mandya (`544`), Mysuru (`545`), Raichur (`546`), Ramanagara (`631`), Shivamogga (`547`), Tumakuru (`548`), Udupi (`549`), Uttara Kannada (`550`), Vijayanagara (`738`), Vijayapura (`530`), Yadgir (`635`).
- **Kerala (14 Districts, State LGD 32):** Alappuzha (`554`), Ernakulam (`555`), Idukki (`556`), Kannur (`557`), Kasaragod (`558`), Kollam (`559`), Kottayam (`560`), Kozhikode (`561`), Malappuram (`562`), Palakkad (`563`), Pathanamthitta (`564`), Thiruvananthapuram (`565`), Thrissur (`566`), Wayanad (`567`).
- **Puducherry (4 Districts, State LGD 34):** Karaikal (`598`), Mahe (`599`), Puducherry (`600`), Yanam (`601`).

### 2.3 Active Cities and Towns (19 Total)
Each city is linked to its official district and state, populated with coordinates, standardized aliases, and NIGHTLIFEZ business market tier:

| City Slug | Name | State | District LGD | Market Tier | Aliases |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `chennai` | Chennai | Tamil Nadu | 568 (Chennai) | `primary_market` | Madras, MAA, Singara Chennai |
| `bengaluru` | Bengaluru | Karnataka | 525 (Bengaluru Urban) | `primary_market` | Bangalore, BLR, Bengaluru Urban, Silicon Valley |
| `coimbatore` | Coimbatore | Tamil Nadu | 569 (Coimbatore) | `primary_market` | Kovai, CJB |
| `kochi` | Kochi | Kerala | 555 (Ernakulam) | `primary_market` | Cochin, Ernakulam, COK |
| `puducherry` | Puducherry | Puducherry | 600 (Puducherry) | `primary_market` | Pondicherry, Pondi, Pondy, PNY |
| `mysuru` | Mysuru | Karnataka | 545 (Mysuru) | `expansion_market` | Mysore, MYQ |
| `mangaluru` | Mangaluru | Karnataka | 534 (Dakshina Kannada) | `expansion_market` | Mangalore, IXE, Kudla |
| `madurai` | Madurai | Tamil Nadu | 578 (Madurai) | `expansion_market` | Temple City, IXM |
| `salem` | Salem | Tamil Nadu | 584 (Salem) | `expansion_market` | SXV, Mango City |
| `tiruchirappalli`| Tiruchirappalli | Tamil Nadu | 591 (Tiruchirappalli) | `expansion_market` | Trichy, Tiruchi, TRZ |
| `thiruvananthapuram`| Thiruvananthapuram | Kerala | 565 (Thiruvananthapuram)| `expansion_market` | Trivandrum, TRV |
| `kozhikode` | Kozhikode | Kerala | 561 (Kozhikode) | `expansion_market` | Calicut, CCJ |
| `ooty` | Ooty | Tamil Nadu | 587 (The Nilgiris) | `getaway_destination` | Udhagamandalam, Udhagai, Nilgiris |
| `kodaikanal` | Kodaikanal | Tamil Nadu | 572 (Dindigul) | `getaway_destination` | Kodai, Princess of Hill Stations |
| `coorg` | Coorg | Karnataka | 541 (Kodagu) | `getaway_destination` | Kodagu, Madikeri |
| `gokarna` | Gokarna | Karnataka | 550 (Uttara Kannada) | `getaway_destination` | Om Beach, Gokarn |
| `chikmagalur` | Chikmagalur | Karnataka | 532 (Chikkamagaluru) | `getaway_destination` | Chikkamagaluru, Coffee Land |
| `varkala` | Varkala | Kerala | 565 (Thiruvananthapuram)| `getaway_destination` | Varkala Cliff, Papanasam |
| `wayanad` | Wayanad | Kerala | 567 (Wayanad) | `getaway_destination` | Kalpetta, Sulthan Bathery |

> [!NOTE]
> Government LGD classifications do not define commercial "tiers". Tiers in `location_cities.market_tier` are strictly NIGHTLIFEZ product and business tiers (`primary_market`, `expansion_market`, `getaway_destination`).

---

## 3. Database Architecture & Additive Migration 013

File: `migrations/013_location_intelligence.sql`

### 3.1 Relational Schema Hierarchy
```
Country ('IN')
   └── location_states (All 36 States & UTs with official LGD codes)
         └── location_districts (87 Districts across TN, KA, KL, PY)
               └── location_cities (19 Cities with market tiers & aliases)
                     └── location_localities (13 Localities for core nightlife hubs)
```

- **`location_states`**: `id UUID PRIMARY KEY`, `lgd_code INT UNIQUE`, `name TEXT`, `type state_kind`, `state_code TEXT UNIQUE`, `source_url TEXT`, `source_date DATE`, `verified BOOLEAN`.
- **`location_districts`**: `id UUID PRIMARY KEY`, `state_id UUID REFERENCES location_states(id)`, `lgd_code INT UNIQUE`, `name TEXT`, `census_2011_code TEXT`, `verified BOOLEAN`.
- **`location_cities`**: `id UUID PRIMARY KEY`, `district_id UUID REFERENCES location_districts(id)`, `state_id UUID REFERENCES location_states(id)`, `slug TEXT UNIQUE`, `name TEXT`, `local_name TEXT`, `lat DOUBLE PRECISION`, `lng DOUBLE PRECISION`, `aliases TEXT[]`, `market_tier TEXT`, `is_discovery_active BOOLEAN`.
- **`location_localities`**: `id UUID PRIMARY KEY`, `city_id UUID REFERENCES location_cities(id)`, `slug TEXT`, `name TEXT`, `postal_code TEXT`, `lat DOUBLE PRECISION`, `lng DOUBLE PRECISION`, `aliases TEXT[]`, `UNIQUE (city_id, slug)`.
- **`events` Alterations**: Added `city_id UUID REFERENCES location_cities(id)`, `locality_id UUID REFERENCES location_localities(id)`, `lat DOUBLE PRECISION`, `lng DOUBLE PRECISION`, with indexes `idx_events_city_id` and `idx_events_coords (lat, lng)`.
- **`venues` Foreign Key**: Added guarded FK constraint `fk_venues_locality` referencing `location_localities(id)`.

### 3.2 Plpgsql Haversine Function
```sql
CREATE OR REPLACE FUNCTION haversine_km(
  lat1 DOUBLE PRECISION,
  lng1 DOUBLE PRECISION,
  lat2 DOUBLE PRECISION,
  lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION AS $$
DECLARE
  r CONSTANT DOUBLE PRECISION := 6371.0; -- Mean Earth radius in km
  dlat DOUBLE PRECISION;
  dlng DOUBLE PRECISION;
  a DOUBLE PRECISION;
BEGIN
  IF lat1 IS NULL OR lng1 IS NULL OR lat2 IS NULL OR lng2 IS NULL THEN
    RETURN NULL;
  END IF;
  dlat := radians(lat2 - lat1);
  dlng := radians(lng2 - lng1);
  a := (sin(dlat / 2.0) ^ 2) + cos(radians(lat1)) * cos(radians(lat2)) * (sin(dlng / 2.0) ^ 2);
  IF a > 1.0 THEN a := 1.0; END IF;
  RETURN 2.0 * r * asin(sqrt(a));
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;
```

---

## 4. Geospatial Services & API Endpoints

### 4.1 Backend Service: `lib/services/locations.js`
- `haversineKm(lat1, lng1, lat2, lng2)`: Pure JS calculation mirroring Postgres function within 0.01 km.
- `listStates({ activeOnly, type })`: Returns official states/UTs sorted alphabetically.
- `listDistricts({ stateId, stateLgdCode, activeOnly })`: Returns districts for state.
- `listCities({ activeOnly, discoveryOnly, stateId, districtId, q })`: Matches against name, slug, local_name, and aliases.
- `getCityBySlug(slug)`: Retrieves city by slug, name, or alias.
- `listLocalities({ cityId, citySlug, activeOnly })`: Lists localities in a city.
- `findNearbyEvents({ lat, lng, radiusKm, citySlug, category, limit, offset, includeUnlocated })`: Discovers upcoming published events within radius; safely handles unlocated events.

### 4.2 HTTP API Routes (`lib/handlers/locations.js` & `lib/router.js`)
- `GET /api/locations/states`: Lists all 36 States/UTs.
- `GET /api/locations/districts?state_lgd_code=33`: Lists districts for state.
- `GET /api/locations/cities?q=kovai`: Search cities by alias or name.
- `GET /api/locations/cities/:slug`: Single city details with parent district and state.
- `GET /api/locations/localities?city_slug=bengaluru`: Localities within city.
- `GET /api/events/nearby?lat=12.9716&lng=77.5946&radius_km=50`: Nearby event discovery with distance calculation.

---

## 5. Privacy Safeguards & Security Boundaries

1. **Mystery Venue Address Secrecy:** For events where `venue_privacy = 'disclosed_after_booking'`:
   - Exact venue address (`venue_private`) is completely blanked out on public discovery.
   - Maps URL (`maps_url`) is stripped.
   - Exact coordinates (`events.lat`, `events.lng`) are suppressed from public outputs.
   - Only coarse distance badges (e.g. `📍 5.2 km away`) are shown, calculated from neighborhood or city centers.
2. **Permissions-Policy Header:** Updated `vercel.json` to allow first-party device geolocation while denying third parties:
   ```json
   { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(self), payment=()" }
   ```
3. **No Coerced Geolocation:** Device location is completely optional. If permission is denied or blocked, an inline polite status message is displayed without disrupting manual city selection.

---

## 6. Architectural Profile Separation

NIGHTLIFEZ maintains a strict boundary between distinct user location concepts:
- **Registered Profile Home City (`users.city`):** The user's permanent home base. It is updated **only** when the user explicitly saves their profile via `PATCH /api/me/profile`.
- **Preferred Discovery City:** Selected via the UI location picker or URL (`/events?city=bengaluru`), stored in the active URL and UI state.
- **Device GPS Location:** Ephemeral coordinates retrieved via `navigator.geolocation` for nearby discovery (`/events?lat=...&lng=...&radius_km=50`). It never mutates `users.city`.

---

## 7. P2 Medium Finding Remediation

### Investigation & Root Cause
In `lib/services/permissions.js`, `ensurePersonalOrg(user, c)` evaluated:
```sql
INSERT INTO user_capabilities (user_id, capability_code, status)
SELECT id, 'organise_events', CASE WHEN organiser_enabled THEN 'verified' ELSE 'revoked' END::capability_status
  FROM users WHERE id = $1
ON CONFLICT (user_id, capability_code) DO NOTHING
```
When an active event admin (with `super_admin` or `event_manager` in `admin_users`) created their first event through the wizard and their `users.organiser_enabled` flag was false, the system inserted `'revoked'` into `user_capabilities`, conflicting with their administrative privileges.

### Remediation
Updated `ensurePersonalOrg(user, c)` to mirror the `PERSONAL_ORG_LIVE` and `isOrganiser()` condition:
```sql
INSERT INTO user_capabilities (user_id, capability_code, status)
SELECT u.id, 'organise_events',
  CASE WHEN (u.organiser_enabled OR EXISTS (
    SELECT 1 FROM admin_users a WHERE a.telegram_user_id = u.telegram_user_id AND a.active AND a.role IN ('super_admin', 'event_manager')
  )) THEN 'verified' ELSE 'revoked' END::capability_status
  FROM users u WHERE u.id = $1
ON CONFLICT (user_id, capability_code) DO NOTHING
```
A dedicated regression test was added in `test/permissions.test.js`, and all 164 permissions tests pass cleanly.

---

## 8. Verification & Test Results

### 8.1 Linting
`npm run lint` — **130/130 files OK** (0 errors).

### 8.2 Unit & Integration Tests
`TEST_DATABASE_URL=postgres://localhost:5432/sm_test npm test`
- **Total Tests:** 411
- **Passed:** 409
- **Failed:** 0
- **Skipped:** 2 (Pre-existing Telegram Stars live token tests)
- **New Test Suite:** `test/locations.test.js` (8/8 tests passed covering LGD codes, district counts, aliases, Haversine accuracy, nearby queries, privacy bounds, and HTTP endpoints).

### 8.3 End-to-End Playwright Tests
- `e2e/location-picker.spec.js`: 12/12 passed (Desktop & Mobile viewports, alias searches, state filters, geolocation denial, touch targets $\ge$ 44px).
- `e2e/closed-and-gates.spec.js` & `e2e/mobile-layout.spec.js`: 39 passed, 1 skipped, 0 failed.
- `e2e/attendee-journey.spec.js`: 4/4 passed (Instant discovery, free booking, mystery venue unlock).

---

## 9. File Changes Summary

| File | Change Description |
| :--- | :--- |
| `migrations/013_location_intelligence.sql` | Additive migration: States, Districts, Cities, Localities, `haversine_km`, seed data & backfill. |
| `lib/services/locations.js` | Core Location Intelligence service (queries, alias matching, Haversine, nearby events). |
| `lib/handlers/locations.js` | HTTP API handlers (`/api/locations/*`, `/api/events/nearby`). |
| `lib/router.js` | Registered public location API routes. |
| `lib/services/events.js` | Expanded `CITIES` to 19 active discovery cities; added distanceKm and coords to `toPublicEvent`. |
| `lib/services/permissions.js` | Resolved P2 finding: active event admin gets verified `organise_events` capability in `ensurePersonalOrg`. |
| `lib/handlers/discovery.js` | Integrated `findNearbyEvents` into `/events` discovery page for `lat`/`lng` query params. |
| `lib/views/layout.js` | Responsive location picker trigger and modal dialog; updated `CITIES` fallback options. |
| `lib/views/components.js` | Added distance badge (`📍 X km away`) to `eventCard`. |
| `public/js/site.js` | Location picker interactive dialog, client-side alias search, non-blocking GPS detection, instant discovery sync. |
| `public/css/site.css` | Location dialog styles, dark theme, touch targets $\ge$ 44px, mobile responsive layouts at 320px/375px. |
| `vercel.json` | Updated `Permissions-Policy` to `geolocation=(self)`. |
| `test/locations.test.js` | Comprehensive unit/integration test suite for Location Intelligence V1. |
| `test/permissions.test.js` | Added regression test for event admin capability verification in `ensurePersonalOrg`. |
| `e2e/location-picker.spec.js` | Playwright E2E test suite for location modal, alias matching, touch targets, and responsiveness. |
