-- 003_identity_events_bookings.sql — Postgres baseline: identity, media, events, bookings.
-- Additive only. Legacy SQLite migrations (never persisted in production) live in migrations/legacy-sqlite/.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('active', 'suspended', 'banned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE user_gender AS ENUM ('female', 'male', 'non_binary', 'prefer_not_to_say');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE event_category AS ENUM ('meetup', 'dating_mixer', 'nightlife', 'dinner_club', 'movie', 'board_games', 'weekend_trip', 'resort_getaway');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE venue_privacy AS ENUM ('public', 'disclosed_after_booking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE price_status AS ENUM ('tbd', 'set');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE event_source AS ENUM ('internal', 'external');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE event_status AS ENUM ('draft', 'published', 'cancelled', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE booking_status AS ENUM ('pending_payment', 'confirmed', 'checked_in', 'cancelled', 'refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE media_type AS ENUM ('photo', 'video', 'review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Users: Telegram identity only. No phone, no email.
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id  BIGINT UNIQUE NOT NULL,
  visitor_uuid      UUID,
  alias             TEXT,
  gender            user_gender,
  city              TEXT,
  age_confirmed_21  BOOLEAN NOT NULL DEFAULT false,
  age_confirmed_at  TIMESTAMPTZ,
  status            user_status NOT NULL DEFAULT 'active',
  bot_started       BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Media: only owner-authorised items may ever render publicly.
CREATE TABLE IF NOT EXISTS media (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                 media_type NOT NULL,
  url                  TEXT,
  caption              TEXT,
  author_alias         TEXT,
  authorized_by_owner  BOOLEAN NOT NULL DEFAULT false,
  visible              BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_media_updated ON media;
CREATE TRIGGER trg_media_updated BEFORE UPDATE ON media FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                  TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  category              event_category NOT NULL,
  title                 TEXT NOT NULL,
  summary               TEXT,
  description           TEXT,
  city                  TEXT NOT NULL,
  area_public           TEXT,
  venue_private         TEXT,
  venue_privacy         venue_privacy NOT NULL DEFAULT 'disclosed_after_booking',
  start_at              TIMESTAMPTZ NOT NULL,
  end_at                TIMESTAMPTZ,
  timezone              TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  capacity              INTEGER NOT NULL CHECK (capacity >= 0),
  ticket_price_paise    INTEGER CHECK (ticket_price_paise IS NULL OR ticket_price_paise > 0),
  price_status          price_status NOT NULL DEFAULT 'tbd',
  inclusions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  exclusions            JSONB NOT NULL DEFAULT '[]'::jsonb,
  refund_policy         TEXT,
  gender_policy         TEXT,
  food_available        BOOLEAN NOT NULL DEFAULT false,
  stay_available        BOOLEAN NOT NULL DEFAULT false,
  organizer             TEXT,
  source                event_source NOT NULL DEFAULT 'internal',
  bookmyshow_url        TEXT CHECK (bookmyshow_url IS NULL OR bookmyshow_url ~ '^https://'),
  external_payment_url  TEXT CHECK (external_payment_url IS NULL OR external_payment_url ~ '^https://'),
  telegram_chat_id      BIGINT,
  cover_media_id        UUID REFERENCES media(id) ON DELETE SET NULL,
  status                event_status NOT NULL DEFAULT 'draft',
  is_demo               BOOLEAN NOT NULL DEFAULT false,
  published_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_consistent CHECK (
    (price_status = 'tbd' AND ticket_price_paise IS NULL) OR
    (price_status = 'set' AND ticket_price_paise IS NOT NULL)
  ),
  CONSTRAINT end_after_start CHECK (end_at IS NULL OR end_at > start_at)
);
CREATE INDEX IF NOT EXISTS idx_events_public ON events (status, start_at) WHERE status = 'published';
DROP TRIGGER IF EXISTS trg_events_updated ON events;
CREATE TRIGGER trg_events_updated BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS bookings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES events(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  status           booking_status NOT NULL DEFAULT 'pending_payment',
  payment_id       UUID,  -- FK added in 004 once payments exists
  amount_paise     INTEGER,
  hold_expires_at  TIMESTAMPTZ,
  confirmed_at     TIMESTAMPTZ,
  checked_in_at    TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  refunded_at      TIMESTAMPTZ,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active booking per user per event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_active
  ON bookings (event_id, user_id) WHERE status IN ('pending_payment', 'confirmed', 'checked_in');
CREATE INDEX IF NOT EXISTS idx_bookings_event_status ON bookings (event_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings (user_id);
DROP TRIGGER IF EXISTS trg_bookings_updated ON bookings;
CREATE TRIGGER trg_bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- initData / login-widget replay protection (hash seen within TTL).
CREATE TABLE IF NOT EXISTS auth_nonces (
  hash        TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_exp ON auth_nonces (expires_at);

-- Fixed-window rate limiting.
CREATE TABLE IF NOT EXISTS rate_limits (
  key           TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
