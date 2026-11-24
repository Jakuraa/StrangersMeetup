-- 033_advanced_event_configuration.sql
-- Advanced Event Configuration & Professional Ticketing System:
-- 1. Event Facilities & Amenities
-- 2. Offers & Discount Engine
-- 3. Interactive Venue Layout & Section-Based Ticketing
-- 4. Sales Timeline & Scheduled Pricing Phases
-- 5. Booking Price Snapshots & Redemptions
-- Additive, safe, idempotent, and backward compatible.

-- 1. Extend events table with module availability indicators
ALTER TABLE events ADD COLUMN IF NOT EXISTS has_facilities BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS has_venue_layout BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS has_sales_phases BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS has_offers BOOLEAN NOT NULL DEFAULT false;

-- 2. Event Facilities & Amenities Table
CREATE TABLE IF NOT EXISTS event_facilities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category        TEXT NOT NULL CHECK (category IN ('parking', 'food_beverage', 'accessibility', 'medical_safety', 'other', 'custom')),
  facility_key    TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  icon            TEXT,
  is_custom       BOOLEAN NOT NULL DEFAULT false,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_facilities_event ON event_facilities (event_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_event_facilities_category ON event_facilities (event_id, category);

-- 3. Interactive Venue Layout & Section-Based Ticketing
CREATE TABLE IF NOT EXISTS event_venue_layouts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE UNIQUE,
  layout_type     TEXT NOT NULL DEFAULT 'section_based' CHECK (layout_type IN ('none', 'section_based', 'reserved_seating')),
  canvas_width    INTEGER NOT NULL DEFAULT 800,
  canvas_height   INTEGER NOT NULL DEFAULT 500,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_venue_sections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  layout_id        UUID NOT NULL REFERENCES event_venue_layouts(id) ON DELETE CASCADE,
  event_id         UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_type_id   UUID REFERENCES ticket_types(id) ON DELETE SET NULL,
  section_key      TEXT NOT NULL,
  name             TEXT NOT NULL,
  category         TEXT NOT NULL DEFAULT 'custom',
  color            TEXT NOT NULL DEFAULT '#6366f1',
  shape            TEXT NOT NULL DEFAULT 'rect',
  x                INTEGER NOT NULL DEFAULT 0,
  y                INTEGER NOT NULL DEFAULT 0,
  width            INTEGER NOT NULL DEFAULT 100,
  height           INTEGER NOT NULL DEFAULT 60,
  capacity         INTEGER NOT NULL DEFAULT 100,
  price_paise      INTEGER NOT NULL DEFAULT 0,
  min_per_booking  INTEGER NOT NULL DEFAULT 1,
  max_per_booking  INTEGER NOT NULL DEFAULT 10,
  status           TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable', 'sold_out')),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_sections_event ON event_venue_sections (event_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_venue_sections_layout ON event_venue_sections (layout_id);
CREATE INDEX IF NOT EXISTS idx_venue_sections_tier ON event_venue_sections (ticket_type_id) WHERE ticket_type_id IS NOT NULL;

-- 4. Sales Timeline & Scheduled Pricing Phases
CREATE TABLE IF NOT EXISTS event_sales_phases (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  starts_at            TIMESTAMPTZ NOT NULL,
  ends_at              TIMESTAMPTZ NOT NULL,
  timezone             TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  price_paise          INTEGER,
  quota                INTEGER,
  tickets_sold         INTEGER NOT NULL DEFAULT 0,
  max_per_booking      INTEGER DEFAULT 10,
  applicable_tier_ids  UUID[] NOT NULL DEFAULT '{}',
  access_code          TEXT,
  is_active            BOOLEAN NOT NULL DEFAULT true,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT check_phase_dates CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_sales_phases_event ON event_sales_phases (event_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_sales_phases_active ON event_sales_phases (event_id, is_active);

-- 5. Offers & Discount Engine
CREATE TABLE IF NOT EXISTS event_offers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id             UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  description          TEXT,
  code                 TEXT,
  discount_type        TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed_amount')),
  discount_value       INTEGER NOT NULL CHECK (discount_value > 0),
  max_discount_paise   INTEGER,
  min_order_paise      INTEGER NOT NULL DEFAULT 0,
  min_quantity         INTEGER NOT NULL DEFAULT 1,
  applicable_tier_ids  UUID[] NOT NULL DEFAULT '{}',
  applicable_phase_ids UUID[] NOT NULL DEFAULT '{}',
  starts_at            TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  total_limit          INTEGER,
  per_user_limit       INTEGER DEFAULT 1,
  redemption_count     INTEGER NOT NULL DEFAULT 0,
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_offers_event ON event_offers (event_id, active);
CREATE INDEX IF NOT EXISTS idx_event_offers_code ON event_offers (event_id, code) WHERE code IS NOT NULL;

-- 6. Offer Redemptions Table
CREATE TABLE IF NOT EXISTS offer_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id        UUID NOT NULL REFERENCES event_offers(id) ON DELETE CASCADE,
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  discount_paise  INTEGER NOT NULL CHECK (discount_paise >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (offer_id, booking_id)
);

CREATE INDEX IF NOT EXISTS idx_offer_redemptions_user ON offer_redemptions (offer_id, user_id);
CREATE INDEX IF NOT EXISTS idx_offer_redemptions_event ON offer_redemptions (event_id);

-- 7. Booking Extensions for Advanced Ticketing & Immutable Snapshots
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES event_venue_sections(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS phase_id UUID REFERENCES event_sales_phases(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS offer_id UUID REFERENCES event_offers(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_paise INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bookings_section ON bookings (section_id) WHERE section_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_phase ON bookings (phase_id) WHERE phase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_offer ON bookings (offer_id) WHERE offer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS booking_price_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE UNIQUE,
  event_id            UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  base_price_paise    INTEGER NOT NULL,
  quantity            INTEGER NOT NULL,
  subtotal_paise      INTEGER NOT NULL,
  phase_id            UUID REFERENCES event_sales_phases(id) ON DELETE SET NULL,
  phase_name          TEXT,
  section_id          UUID REFERENCES event_venue_sections(id) ON DELETE SET NULL,
  section_name        TEXT,
  offer_id            UUID REFERENCES event_offers(id) ON DELETE SET NULL,
  offer_name          TEXT,
  offer_code          TEXT,
  discount_paise      INTEGER NOT NULL DEFAULT 0,
  final_paise         INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  breakdown           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_event ON booking_price_snapshots (event_id);
CREATE INDEX IF NOT EXISTS idx_price_snapshots_booking ON booking_price_snapshots (booking_id);
