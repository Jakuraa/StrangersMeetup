-- migrations/029_recurring_venues_and_category_tickets.sql
-- Recurring event session venues, category-based ticket pricing & capacity accounting,
-- session-specific booking & ticket passes, and door scan session verification.
-- Additive, safe, idempotent, and backward compatible.

-- 1. Event Sessions (Per-session venue overrides and schedule occurrences)
CREATE TABLE IF NOT EXISTS event_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_index    INTEGER NOT NULL DEFAULT 0,
  session_date     DATE NOT NULL,
  start_at         TIMESTAMPTZ NOT NULL,
  end_at           TIMESTAMPTZ,
  label            TEXT NOT NULL DEFAULT '',
  venue_id         UUID REFERENCES venues(id) ON DELETE SET NULL,
  venue_name       TEXT,
  venue_address    TEXT,
  city             TEXT,
  maps_url         TEXT,
  lat              NUMERIC(9,6),
  lng              NUMERIC(9,6),
  timezone         TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, session_index)
);

CREATE INDEX IF NOT EXISTS idx_event_sessions_event ON event_sessions (event_id, session_date);
CREATE INDEX IF NOT EXISTS idx_event_sessions_venue ON event_sessions (venue_id) WHERE venue_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_event_sessions_updated ON event_sessions;
CREATE TRIGGER trg_event_sessions_updated BEFORE UPDATE ON event_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. Ticket Types Category-based Extensions & Capacity Semantics
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general';
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS admit_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS min_per_booking INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS sales_start_at TIMESTAMPTZ;
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS sales_end_at TIMESTAMPTZ;
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES event_sessions(id) ON DELETE SET NULL;
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS valid_session_ids UUID[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  ALTER TABLE ticket_types ADD CONSTRAINT chk_ticket_types_admit_count CHECK (admit_count >= 1 AND admit_count <= 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_types ADD CONSTRAINT chk_ticket_types_min_per_booking CHECK (min_per_booking >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_ticket_types_category ON ticket_types (event_id, category);
CREATE INDEX IF NOT EXISTS idx_ticket_types_session_id ON ticket_types (session_id) WHERE session_id IS NOT NULL;

-- 3. Bookings Session Linking & Admit Count
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES event_sessions(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS session_date DATE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS admit_count INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_bookings_session_id ON bookings (session_id) WHERE session_id IS NOT NULL;

-- 4. Tickets Session and Admit Count Tracking
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES event_sessions(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS session_date DATE;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS admit_count INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_tickets_session_id ON tickets (session_id) WHERE session_id IS NOT NULL;

-- 5. Ticket Scans Session Auditing
ALTER TABLE ticket_scans ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES event_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ticket_scans_session ON ticket_scans (session_id) WHERE session_id IS NOT NULL;
