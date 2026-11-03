# NIGHTLIFEZ — Geographic Coverage & Directory Specification

**Status:** Canonical Reference  
**Release:** Launch MVP (Milestone M2 / P3 Location Intelligence)  
**Authority:** Official Local Government Directory (LGD), Ministry of Panchayati Raj, Government of India  
**Source URL:** https://lgdirectory.gov.in/  
**Verification Date:** November 2026  

---

## 1. Executive Summary

NIGHTLIFEZ provides curated nightlife, dining, and social experiences. Location intelligence enables attendees to discover events happening near them via device GPS coordinates or city selection, while strictly safeguarding host and attendee privacy.

This document establishes the official geographic coverage, administrative hierarchy, business market tiers, alias resolution dictionary, coordinate provenance model, and the policy governing unsupported locations.

---

## 2. Administrative Hierarchy & Data Provenance

All spatial entities in the NIGHTLIFEZ location directory map to official Indian administrative units defined in the Local Government Directory (LGD).

```
Level 1: States & Union Territories (36 entities — 28 States, 8 UTs)
   │
   └── Level 2: Districts (87 official districts across Phase 1 target states)
         │
         └── Level 3: Cities & Towns (19 active discovery hubs across 3 market tiers)
               │
               └── Level 4: Core Localities & Micro-Markets (13 initial urban micro-markets)
```

### 2.1 Level 1: 36 States and Union Territories

NIGHTLIFEZ seeds all 28 States and 8 Union Territories with official LGD codes and ISO 3166-2:IN subcodes:

| State / UT Name | Type | LGD Code | State Code | Capital / Seat | Status |
|---|---|---|---|---|---|
| Andaman and Nicobar Islands | UT | 35 | AN | Port Blair | Active |
| Andhra Pradesh | State | 28 | AP | Amaravati | Active |
| Arunachal Pradesh | State | 12 | AR | Itanagar | Active |
| Assam | State | 18 | AS | Dispur | Active |
| Bihar | State | 10 | BR | Patna | Active |
| Chandigarh | UT | 4 | CH | Chandigarh | Active |
| Chhattisgarh | State | 22 | CG | Raipur | Active |
| Dadra and Nagar Haveli and Daman and Diu | UT | 26 | DH | Daman | Active |
| Delhi (NCT) | UT | 7 | DL | New Delhi | Active |
| Goa | State | 30 | GA | Panaji | Active |
| Gujarat | State | 24 | GJ | Gandhinagar | Active |
| Haryana | State | 6 | HR | Chandigarh | Active |
| Himachal Pradesh | State | 2 | HP | Shimla | Active |
| Jammu and Kashmir | UT | 1 | JK | Srinagar / Jammu | Active |
| Jharkhand | State | 20 | JH | Ranchi | Active |
| Karnataka | State | 29 | KA | Bengaluru | **Phase 1 Focus** |
| Kerala | State | 32 | KL | Thiruvananthapuram | **Phase 1 Focus** |
| Ladakh | UT | 37 | LA | Leh | Active |
| Lakshadweep | UT | 31 | LD | Kavaratti | Active |
| Madhya Pradesh | State | 23 | MP | Bhopal | Active |
| Maharashtra | State | 27 | MH | Mumbai | Active |
| Manipur | State | 14 | MN | Imphal | Active |
| Meghalaya | State | 17 | ML | Shillong | Active |
| Mizoram | State | 15 | MZ | Aizawl | Active |
| Nagaland | State | 13 | NL | Kohima | Active |
| Odisha | State | 21 | OD | Bhubaneswar | Active |
| Puducherry | UT | 34 | PY | Puducherry | **Phase 1 Focus** |
| Punjab | State | 3 | PB | Chandigarh | Active |
| Rajasthan | State | 8 | RJ | Jaipur | Active |
| Sikkim | State | 11 | SK | Gangtok | Active |
| Tamil Nadu | State | 33 | TN | Chennai | **Phase 1 Focus** |
| Telangana | State | 36 | TS | Hyderabad | Active |
| Tripura | State | 16 | TR | Agartala | Active |
| Uttar Pradesh | State | 9 | UP | Lucknow | Active |
| Uttarakhand | State | 5 | UK | Dehradun | Active |
| West Bengal | State | 19 | WB | Kolkata | Active |

### 2.2 Level 2: 87 Districts in Phase 1 Focus Region

Phase 1 covers all 87 official administrative districts across Tamil Nadu, Karnataka, Kerala, and Puducherry:

- **Tamil Nadu (38 districts, LGD State 33):** Ariyalur (579), Chengalpattu (724), Chennai (568), Coimbatore (569), Cuddalore (570), Dharmapuri (571), Dindigul (572), Erode (573), Kallakurichi (725), Kanchipuram (574), Kanniyakumari (575), Karur (576), Krishnagiri (577), Madurai (578), Mayiladuthurai (730), Nagapattinam (580), Namakkal (581), Nilgiris (582), Perambalur (583), Pudukkottai (584), Ramanathapuram (585), Ranipet (726), Salem (586), Sivaganga (587), Tenkasi (727), Thanjavur (588), Theni (589), Thoothukkudi (590), Tiruchirappalli (591), Tirunelveli (592), Tirupathur (728), Tiruppur (635), Tiruvallur (593), Tiruvannamalai (594), Tiruvarur (595), Vellore (596), Viluppuram (597), Virudhunagar (598).
- **Karnataka (31 districts, LGD State 29):** Bagalkote (517), Ballari (518), Belagavi (519), Bengaluru Rural (524), Bengaluru Urban (525), Bidar (520), Chamarajanagara (521), Chikkaballapura (632), Chikkamagaluru (522), Chitradurga (523), Dakshina Kannada (526), Davanagere (527), Dharwad (528), Gadag (529), Hassan (530), Haveri (531), Kalaburagi (532), Kodagu (533), Kolar (534), Koppal (535), Mandya (536), Mysuru (545), Raichur (537), Ramanagara (633), Shivamogga (538), Tumakuru (539), Udupi (540), Uttara Kannada (541), Vijayanagara (736), Vijayapura (542), Yadgir (634).
- **Kerala (14 districts, LGD State 32):** Alappuzha (554), Ernakulam (555), Idukki (556), Kannur (557), Kasaragod (558), Kollam (559), Kottayam (560), Kozhikode (561), Malappuram (562), Palakkad (563), Pathanamthitta (564), Thiruvananthapuram (565), Thrissur (566), Wayanad (567).
- **Puducherry (4 districts, LGD State 34):** Karaikal (599), Mahe (601), Puducherry (600), Yanam (602).

### 2.3 Level 3: 19 Launch Cities & Towns by Business Market Tier

NIGHTLIFEZ segments launch locations into three operational tiers based on market maturity and community demand:

#### Primary Markets (Tier 1)
High-density metropolitan hubs with established nightlife culture, high event frequency, and dedicated organiser communities:
- **Bengaluru** (`bengaluru`, Karnataka, LGD 525) — 12.9716° N, 77.5946° E
- **Chennai** (`chennai`, Tamil Nadu, LGD 568) — 13.0827° N, 80.2707° E
- **Coimbatore** (`coimbatore`, Tamil Nadu, LGD 569) — 11.0168° N, 76.9558° E
- **Kochi** (`kochi`, Kerala, LGD 555) — 9.9312° N, 76.2673° E
- **Puducherry** (`puducherry`, Puducherry, LGD 600) — 11.9416° N, 79.8083° E

#### Expansion Markets (Tier 2)
Emerging tier-2 urban centers with growing social communities:
- **Mysuru** (`mysuru`, Karnataka, LGD 545) — 12.2958° N, 76.6394° E
- **Mangaluru** (`mangaluru`, Karnataka, LGD 526) — 12.9141° N, 74.8560° E
- **Madurai** (`madurai`, Tamil Nadu, LGD 578) — 9.9252° N, 78.1198° E
- **Salem** (`salem`, Tamil Nadu, LGD 586) — 11.6643° N, 78.1460° E
- **Tiruchirappalli** (`tiruchirappalli`, Tamil Nadu, LGD 591) — 10.7905° N, 78.7047° E
- **Thiruvananthapuram** (`thiruvananthapuram`, Kerala, LGD 565) — 8.5241° N, 76.9366° E
- **Kozhikode** (`kozhikode`, Kerala, LGD 561) — 11.2588° N, 75.7804° E

#### Getaway Destinations (Tier 3)
Resort, hill station, and weekend retreat destinations:
- **Ooty** (`ooty`, Tamil Nadu, LGD 582) — 11.4102° N, 76.6950° E
- **Kodaikanal** (`kodaikanal`, Tamil Nadu, LGD 572) — 10.2381° N, 77.4892° E
- **Coorg (Madikeri)** (`coorg`, Karnataka, LGD 533) — 12.4244° N, 75.7382° E
- **Gokarna** (`gokarna`, Karnataka, LGD 541) — 14.5479° N, 74.3188° E
- **Chikmagalur** (`chikmagalur`, Karnataka, LGD 522) — 13.3161° N, 75.7720° E
- **Varkala** (`varkala`, Kerala, LGD 565) — 8.7379° N, 76.7163° E
- **Wayanad (Kalpetta)** (`wayanad`, Kerala, LGD 567) — 11.6103° N, 76.0827° E

---

## 3. Alias & Synonyms Directory

Users and organisers often use colloquial, historical, or abbreviated names. The directory automatically resolves these aliases to official canonical records:

| Input Query / Alias | Canonical City | Official Slug | State | Notes |
|---|---|---|---|---|
| Bangalore, BLR, Bengaluru Urban, Bengaluru City | Bengaluru | `bengaluru` | Karnataka | Historical name & airport code |
| Madras, MAA, Chennai City | Chennai | `chennai` | Tamil Nadu | Historical name & airport code |
| Kovai, CJB | Coimbatore | `coimbatore` | Tamil Nadu | Colloquial name & airport code |
| Cochin, COK, Ernakulam | Kochi | `kochi` | Kerala | Colonial name & district seat |
| Pondy, Pondicherry, PUD | Puducherry | `puducherry` | Puducherry | French colonial & colloquial name |
| Mysore, MYQ | Mysuru | `mysuru` | Karnataka | Pre-2014 anglicized name |
| Mangalore, Kudla, IXE | Mangaluru | `mangaluru` | Karnataka | Tulu name (`Kudla`) & anglicized name |
| Trichy, Tiruchi | Tiruchirappalli | `tiruchirappalli` | Tamil Nadu | Common abbreviation |
| Trivandrum, TRV | Thiruvananthapuram | `thiruvananthapuram` | Kerala | Pre-1991 anglicized name |
| Calicut, CCJ | Kozhikode | `kozhikode` | Kerala | Colonial name & airport code |
| Udhagamandalam, Udhagai | Ooty | `ooty` | Tamil Nadu | Official Tamil names |
| Kodai | Kodaikanal | `kodaikanal` | Tamil Nadu | Common abbreviation |
| Madikeri, Kodagu | Coorg | `coorg` | Karnataka | Administrative district name |
| Chikkamagaluru | Chikmagalur | `chikmagalur` | Karnataka | Kannada script variation |

---

## 4. Unsupported Cities Policy

To maintain data integrity and prevent deceptive discovery results, NIGHTLIFEZ enforces a strict **Zero Silent Guessing** policy:

1. **No Geographic Guessing:** When an organiser enters a city not listed in the official directory (e.g. `Atlantis` or a foreign city), the system records the raw string in `events.city`, but sets `events.city_id = NULL`, `events.lat = NULL`, `events.lng = NULL`, and `events.coords_provenance = 'none'`.
2. **No Approximate Pins as Exact Venues:** An approximate centroid or district coordinates are **never** displayed on a map as an exact event pin.
3. **Graceful Discovery Fallback:**
   - Text search (`q=...`) continues to match the text string in `events.city`.
   - GPS-based proximity queries (`/api/events/nearby?lat=...&lng=...`) return only events with verified coordinates within the requested radius.
   - If an attendee selects an unsupported city in the UI, an honest empty state is rendered: *"No upcoming events found in [City] yet. Explore nearby events or switch cities."*
4. **Organiser Guidance:** When entering an unsupported location, the UI indicates that GPS discovery will be inactive until the city is onboarded or precise coordinates are verified.

---

## 5. Coordinate Provenance & Privacy Boundary

### 5.1 Provenance Hierarchy (`location_provenance`)

Every event with coordinates carries a strict provenance label:

```
  ┌───────────────────┐
  │      'none'       │  No coordinates assigned (unsupported city or coordinates missing).
  └─────────┬─────────┘
            │
  ┌─────────▼─────────┐
  │      'city'       │  Coordinates derived from official LGD city centroid.
  └─────────┬─────────┘
            │
  ┌─────────▼─────────┐
  │    'locality'     │  Coordinates derived from official urban neighborhood/micro-market.
  └─────────┬─────────┘
            │
  ┌─────────▼─────────┐
  │      'venue'      │  Exact host-verified venue coordinates.
  └───────────────────┘
```

### 5.2 Public Exposure Rules

1. **Latitude / Longitude Suppression:**
   - Raw `lat` and `lng` are exposed on `toPublicEvent()` **only** when `venue_privacy === 'public'` **and** `coords_provenance === 'venue'`.
   - For all other events (city centroids, localities, secret venues), `lat` and `lng` are returned as `null` to public API consumers and unconfirmed visitors.
2. **Private Venue Privacy (M-02 Protection):**
   - Private venues (`venue_privacy = 'disclosed_after_booking'`) **never** expose exact numeric `distance_km`. Raw numeric distance enables multi-point trilateration from 3 GPS vantage points.
   - Private venues emit `distanceKm: null` and provide a privacy-preserving coarse `distanceBand`:
     - `< 1 km away` (for distances under 1 km)
     - `~2 km away` (1 to 2.9 km)
     - `~5 km away` (3 to 5.9 km)
     - `~10 km away` (6 to 11.9 km)
     - `~20 km away` (12 to 24.9 km)
     - `~30–50 km away` (25 to 49.9 km)
     - `~N0 km away` (rounded to nearest 10 km for larger distances)
   - Public venues with exact coordinates retain both `distanceKm` and `distanceBand`.

---

## 6. Geospatial Performance Specification

1. **Bounding-Box Pre-Filter (M-01 Optimization):**
   - Haversine distance calculations are CPU-intensive when evaluated row-by-row over tens of thousands of rows.
   - `findNearbyEvents` computes an indexed bounding box:
     $$\Delta \text{lat} = \frac{R}{110.574 \text{ km}}$$
     $$\Delta \text{lng} = \frac{R}{111.320 \times \cos(\text{lat}_{\max}) \text{ km}}$$
   - PostgreSQL filters candidate rows using the B-tree composite index `idx_events_coords (lat, lng) WHERE status = 'published'` before executing `haversine_km`.
   - Measured benchmark: 50,000 rows speedup is **7.9x faster** (91.1 ms down to 11.4 ms) with 95%+ candidate row pruning.
2. **Polar & Antimeridian Safety:**
   - Latitudes are clamped to $[-90, 90]$.
   - Longitude wrapping around the antimeridian ($\pm 180^\circ$) generates a split disjunctive query `(lng >= min_wrap OR lng <= max_wrap)` to prevent index truncation or mathematical domain errors.

---

## 7. Expansion Roadmap

| Phase | Milestone | Regions | Target Hubs | Governance Step |
|---|---|---|---|---|
| **Phase 1** | Launch MVP (Current) | South India | Bengaluru, Chennai, Coimbatore, Kochi, Puducherry + 14 regional hubs | LGD 2026 baseline verified |
| **Phase 2** | Post-Launch (P4) | West India | Mumbai, Pune, North Goa, South Goa, Ahmedabad | Add Maharashtra & Goa districts and localities |
| **Phase 3** | National Scale | North & East | NCR Delhi, Hyderabad, Kolkata, Chandigarh, Jaipur | Complete national tier-1 directory |

### Governance & Additions Workflow
1. Municipal boundary and LGD code verification via `https://lgdirectory.gov.in/`.
2. Schema migration adding records to `location_cities` and `location_localities` with official lat/lng centroids.
3. Verification in staging test suite before production migration.
