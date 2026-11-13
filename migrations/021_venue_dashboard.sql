-- 015_venue_dashboard.sql — Venue Owner Dashboard schema extensions
-- Additive only, guarded, re-runnable. Safe on fresh database and when upgrading from migration 014.

-- 1. Extend venues table with operational and discovery details
ALTER TABLE venues ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS address_public TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES location_cities(id);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS facilities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS rules TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS idx_venues_city_id ON venues (city_id);

-- 2. Link events to venues
ALTER TABLE events ADD COLUMN IF NOT EXISTS venue_id UUID REFERENCES venues(id);
CREATE INDEX IF NOT EXISTS idx_events_venue_id ON events (venue_id);

-- 3. Organiser requests and venue booking enquiries
CREATE TABLE IF NOT EXISTS venue_enquiries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id          UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES organisations(id),
  requester_user_id UUID REFERENCES users(id),
  requester_name    TEXT NOT NULL,
  requester_email   TEXT,
  requester_phone   TEXT,
  event_name        TEXT NOT NULL,
  event_date        DATE NOT NULL,
  start_time        TEXT,
  end_time          TEXT,
  expected_guests   INTEGER NOT NULL DEFAULT 50 CHECK (expected_guests > 0),
  budget_notes      TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  decline_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_enquiries_venue ON venue_enquiries (venue_id, status);
CREATE INDEX IF NOT EXISTS idx_venue_enquiries_org ON venue_enquiries (org_id, status);

DROP TRIGGER IF EXISTS trg_venue_enquiries_updated ON venue_enquiries;
CREATE TRIGGER trg_venue_enquiries_updated BEFORE UPDATE ON venue_enquiries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. Venue-specific safety reports and incident escalations
ALTER TABLE reports ADD COLUMN IF NOT EXISTS venue_id UUID REFERENCES venues(id);
CREATE INDEX IF NOT EXISTS idx_reports_venue_id ON reports (venue_id);
