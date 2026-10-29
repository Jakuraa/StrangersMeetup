-- 006_discovery_insights_membership.sql — event discovery (feeds, submissions, moderation),
-- voluntary profile data, first-party page views, SuperProfile membership tracking,
-- integration error log. Additive only.

-- New formats. (ADD VALUE is allowed in a transaction on PG12+; the values are not used below.)
ALTER TYPE event_category ADD VALUE IF NOT EXISTS 'weekend_party';
ALTER TYPE event_category ADD VALUE IF NOT EXISTS 'matchmaking';

-- ---------- external (attributed) events ----------
ALTER TABLE events ADD COLUMN IF NOT EXISTS external_url TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS feed_id UUID;
ALTER TABLE events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT external_url_https CHECK (external_url IS NULL OR external_url ~ '^https://');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT source_url_https CHECK (source_url IS NULL OR source_url ~ '^https://');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- An external listing must say where it came from and where to book.
DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT external_attributed CHECK (source <> 'external' OR (external_url IS NOT NULL AND source_name IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_dedupe ON events (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('draft', 'published');

-- ---------- feeds ----------
CREATE TABLE IF NOT EXISTS event_feeds (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  url                   TEXT UNIQUE NOT NULL CHECK (url ~ '^https://'),
  site_url              TEXT CHECK (site_url IS NULL OR site_url ~ '^https://'),
  attribution           TEXT NOT NULL,
  permission_basis      TEXT NOT NULL CHECK (char_length(permission_basis) >= 10),
  default_category      event_category,
  default_city          TEXT,
  active                BOOLEAN NOT NULL DEFAULT true,
  etag                  TEXT,
  last_modified         TEXT,
  last_fetched_at       TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_status           TEXT,
  last_error            TEXT,
  last_item_count       INTEGER,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_event_feeds_updated ON event_feeds;
CREATE TRIGGER trg_event_feeds_updated BEFORE UPDATE ON event_feeds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
  ALTER TABLE events ADD CONSTRAINT fk_events_feed FOREIGN KEY (feed_id) REFERENCES event_feeds(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS feed_fetch_log (
  id          BIGSERIAL PRIMARY KEY,
  feed_id     UUID NOT NULL REFERENCES event_feeds(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  status      TEXT NOT NULL,          -- ok | not_modified | error | blocked_robots
  http_status INTEGER,
  items_seen  INTEGER NOT NULL DEFAULT 0,
  items_new   INTEGER NOT NULL DEFAULT 0,
  items_dup   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feed_fetch_log ON feed_fetch_log (feed_id, at DESC);

-- ---------- moderation queue (feed items + public submissions) ----------
DO $$ BEGIN
  CREATE TYPE candidate_status AS ENUM ('pending', 'approved', 'rejected', 'duplicate');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE candidate_origin AS ENUM ('feed', 'submission');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS event_candidates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin             candidate_origin NOT NULL,
  feed_id            UUID REFERENCES event_feeds(id) ON DELETE SET NULL,
  guid               TEXT,
  link               TEXT,
  title              TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  summary            TEXT,
  start_at           TIMESTAMPTZ,      -- NULL when the source gives no event date (pubDate is never used)
  end_at             TIMESTAMPTZ,
  city               TEXT,
  venue              TEXT,
  category           event_category,
  organizer          TEXT,
  submitter_contact  TEXT,             -- submissions only; shown to admins only
  dedupe_key         TEXT,
  status             candidate_status NOT NULL DEFAULT 'pending',
  duplicate_of_event UUID REFERENCES events(id) ON DELETE SET NULL,
  event_id           UUID REFERENCES events(id) ON DELETE SET NULL,
  review_note        TEXT,
  reviewed_by        TEXT,
  reviewed_at        TIMESTAMPTZ,
  ip_hash            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_feed_guid ON event_candidates (feed_id, guid) WHERE feed_id IS NOT NULL AND guid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidates_status ON event_candidates (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_dedupe ON event_candidates (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidates_link ON event_candidates (link) WHERE link IS NOT NULL;
DROP TRIGGER IF EXISTS trg_event_candidates_updated ON event_candidates;
CREATE TRIGGER trg_event_candidates_updated BEFORE UPDATE ON event_candidates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- voluntary profile data ----------
DO $$ BEGIN
  CREATE TYPE age_band AS ENUM ('21_24', '25_29', '30_34', '35_39', '40_plus', 'prefer_not_to_say');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_band age_band;
ALTER TABLE users ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_updated_at TIMESTAMPTZ;

-- ---------- first-party page views ----------
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS path TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS referrer_host TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS utm_source TEXT;
CREATE INDEX IF NOT EXISTS idx_analytics_visitor ON analytics_events (visitor_uuid, at);

-- ---------- SuperProfile membership ----------
ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS access_provider TEXT NOT NULL DEFAULT 'telegram_stars';
ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS superprofile_url TEXT;
ALTER TABLE membership_tiers ADD COLUMN IF NOT EXISTS superprofile_product_ref TEXT;
DO $$ BEGIN
  ALTER TABLE membership_tiers ADD CONSTRAINT tier_access_provider CHECK (access_provider IN ('telegram_stars', 'superprofile'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE membership_tiers ADD CONSTRAINT tier_superprofile_url_https CHECK (superprofile_url IS NULL OR superprofile_url ~ '^https://');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Raw notifications from SuperProfile (via Zapier/Pabbly). Buyer email is stored only as a keyed hash.
CREATE TABLE IF NOT EXISTS superprofile_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT NOT NULL CHECK (event_type IN ('purchase', 'subscription_expired', 'purchase_abandoned')),
  external_id   TEXT NOT NULL,
  product_ref   TEXT,
  tier_id       UUID REFERENCES membership_tiers(id),
  email_hash    TEXT,
  amount_paise  BIGINT CHECK (amount_paise IS NULL OR amount_paise >= 0),
  currency      TEXT,
  occurred_at   TIMESTAMPTZ,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_superprofile_events UNIQUE (event_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_superprofile_events_at ON superprofile_events (received_at DESC);

CREATE TABLE IF NOT EXISTS superprofile_memberships (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id        UUID REFERENCES membership_tiers(id),
  product_ref    TEXT NOT NULL,
  email_hash     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active', 'expired')),
  started_at     TIMESTAMPTZ NOT NULL,
  last_purchase_at TIMESTAMPTZ NOT NULL,
  expired_at     TIMESTAMPTZ,
  purchases      INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_superprofile_memberships UNIQUE (product_ref, email_hash)
);
DROP TRIGGER IF EXISTS trg_superprofile_memberships_updated ON superprofile_memberships;
CREATE TRIGGER trg_superprofile_memberships_updated BEFORE UPDATE ON superprofile_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- integration errors (no secrets, no payloads) ----------
CREATE TABLE IF NOT EXISTS integration_errors (
  id      BIGSERIAL PRIMARY KEY,
  source  TEXT NOT NULL,     -- telegram_webhook | payment_webhook | superprofile_webhook | feed
  kind    TEXT NOT NULL,
  detail  TEXT,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_integration_errors_at ON integration_errors (at DESC);
