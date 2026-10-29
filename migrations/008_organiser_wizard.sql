-- 008_organiser_wizard.sql — organiser drafts, ticket tiers, event features, guest approval.
-- Additive only. Existing single-price events keep working unchanged (events.ticketing = 'single').

-- ---------- who may organise ----------
-- Granted by a super_admin. Active admins with an events-write role may also organise.
ALTER TABLE users ADD COLUMN IF NOT EXISTS organiser_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------- drafts: work in progress, never public ----------
-- A draft is a versioned JSON document owned by one organiser. It only becomes an `events` row
-- on explicit publish, so a draft can never appear in public queries.
CREATE TABLE IF NOT EXISTS event_drafts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_user_id  UUID NOT NULL REFERENCES users(id),
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  step               TEXT NOT NULL DEFAULT 'basics' CHECK (step IN ('basics', 'tickets', 'features', 'preview')),
  version            INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'published', 'discarded')),
  event_id           UUID REFERENCES events(id),
  published_at       TIMESTAMPTZ,
  discarded_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_drafts_owner ON event_drafts (organiser_user_id, status, updated_at DESC);
DROP TRIGGER IF EXISTS trg_event_drafts_updated ON event_drafts;
CREATE TRIGGER trg_event_drafts_updated BEFORE UPDATE ON event_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- uploaded event images ----------
-- Small, re-encoded images stored in Postgres (no blob store is configured). `is_public` flips
-- only when the event that uses the image is published; until then only the owner can fetch it.
CREATE TABLE IF NOT EXISTS event_images (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID NOT NULL REFERENCES users(id),
  draft_id        UUID REFERENCES event_drafts(id),
  content_type    TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes           BYTEA NOT NULL,
  byte_size       INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  is_public       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_images_draft ON event_images (draft_id);

-- ---------- events: organiser + features ----------
ALTER TABLE events ADD COLUMN IF NOT EXISTS organiser_user_id UUID REFERENCES users(id);
ALTER TABLE events ADD COLUMN IF NOT EXISTS draft_id UUID REFERENCES event_drafts(id);
ALTER TABLE events ADD COLUMN IF NOT EXISTS ticketing TEXT NOT NULL DEFAULT 'single';
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_multi_day BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS maps_url TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS booking_questions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE events ADD COLUMN IF NOT EXISTS pickup_points JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS gallery JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE events ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT events_ticketing CHECK (ticketing IN ('single', 'tiers'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT maps_url_https CHECK (maps_url IS NULL OR maps_url ~ '^https://');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT contact_phone_e164 CHECK (contact_phone IS NULL OR contact_phone ~ '^\+[1-9][0-9]{7,14}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_events_organiser ON events (organiser_user_id, created_at DESC) WHERE organiser_user_id IS NOT NULL;

-- ---------- ticket tiers ----------
CREATE TABLE IF NOT EXISTS ticket_types (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES events(id),
  name             TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  kind             TEXT NOT NULL CHECK (kind IN ('free', 'paid')),
  price_paise      INTEGER NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity >= 0 AND quantity <= 5000),
  max_per_booking  INTEGER NOT NULL DEFAULT 1 CHECK (max_per_booking BETWEEN 1 AND 20),
  valid_on         DATE,           -- NULL: valid for the whole event (all days)
  eligibility      TEXT CHECK (eligibility IS NULL OR char_length(eligibility) <= 120),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A free tier can never carry a price, so it can never start a payment.
  CONSTRAINT ticket_price_kind CHECK (
    (kind = 'free' AND price_paise = 0) OR (kind = 'paid' AND price_paise >= 100 AND price_paise <= 10000000))
);
CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON ticket_types (event_id, sort_order);
DROP TRIGGER IF EXISTS trg_ticket_types_updated ON ticket_types;
CREATE TRIGGER trg_ticket_types_updated BEFORE UPDATE ON ticket_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- bookings: tiers, quantity, answers, approval ----------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ticket_type_id UUID REFERENCES ticket_types(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_point_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_mode TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES users(id);
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_quantity CHECK (quantity BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- free: no payment involved. provider: a hosted checkout via a configured PaymentProvider.
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_payment_mode CHECK (payment_mode IS NULL OR payment_mode IN ('free', 'provider'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_bookings_ticket_type ON bookings (ticket_type_id) WHERE ticket_type_id IS NOT NULL;

-- One live booking or request per guest per event, now including approval requests.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active_v2
  ON bookings (event_id, user_id) WHERE status IN ('pending_approval', 'pending_payment', 'confirmed', 'checked_in');
DROP INDEX IF EXISTS uq_bookings_active;
