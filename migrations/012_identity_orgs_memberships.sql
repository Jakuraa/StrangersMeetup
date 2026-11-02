-- 012_identity_orgs_memberships.sql — Identities, organisations, scoped memberships, capabilities,
-- venues and event teams. Additive only; safe to re-run (every CREATE/INSERT is guarded).
-- admin_users is unchanged and still holds platform roles. Access checks live in
-- lib/services/permissions.js (can()).

DO $$ BEGIN
  CREATE TYPE identity_provider AS ENUM ('telegram', 'phone');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE org_kind AS ENUM ('personal', 'business', 'venue_operator', 'organiser_team');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE org_status AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE org_role AS ENUM ('owner', 'admin', 'manager', 'staff');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE membership_status AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE capability_status AS ENUM ('claimed', 'verified', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE venue_status AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE team_status AS ENUM ('active', 'removed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per way a person can prove who they are. Telegram today; phone later (PHONE_OTP=later).
CREATE TABLE IF NOT EXISTS user_identities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  provider     identity_provider NOT NULL,
  subject      TEXT NOT NULL,
  verified_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (user_id);

INSERT INTO user_identities (user_id, provider, subject, verified_at, created_at)
SELECT u.id, 'telegram', u.telegram_user_id::text, u.created_at, u.created_at FROM users u
ON CONFLICT (provider, subject) DO NOTHING;

-- personal_user_id links a 'personal' org to the one person it belongs to (one each), so the
-- backfill below and ensurePersonalOrg() can find it without guessing by name.
CREATE TABLE IF NOT EXISTS organisations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              org_kind NOT NULL,
  name              TEXT NOT NULL,
  status            org_status NOT NULL DEFAULT 'active',
  verified_at       TIMESTAMPTZ,
  personal_user_id  UUID UNIQUE REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT personal_org_has_user CHECK ((kind = 'personal') = (personal_user_id IS NOT NULL))
);
DROP TRIGGER IF EXISTS trg_organisations_updated ON organisations;
CREATE TRIGGER trg_organisations_updated BEFORE UPDATE ON organisations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS capabilities (
  code                   TEXT PRIMARY KEY,
  label                  TEXT NOT NULL,
  requires_verification  BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO capabilities (code, label, requires_verification) VALUES
  ('organise_events', 'Organise events', true),
  ('manage_venue', 'Manage a venue', true),
  ('host_staff', 'Host / event staff', false),
  ('dj', 'DJ', false),
  ('security', 'Security', true),
  ('photography', 'Photography', false),
  ('food_service', 'Food service', true),
  ('first_aid', 'First aid', true),
  ('creator', 'Creator', false)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS org_memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  org_id      UUID NOT NULL REFERENCES organisations(id),
  role        org_role NOT NULL,
  status      membership_status NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON org_memberships (org_id, status);
DROP TRIGGER IF EXISTS trg_org_memberships_updated ON org_memberships;
CREATE TRIGGER trg_org_memberships_updated BEFORE UPDATE ON org_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS user_capabilities (
  user_id          UUID NOT NULL REFERENCES users(id),
  capability_code  TEXT NOT NULL REFERENCES capabilities(code),
  status           capability_status NOT NULL DEFAULT 'claimed',
  evidence_ref     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability_code)
);
DROP TRIGGER IF EXISTS trg_user_capabilities_updated ON user_capabilities;
CREATE TRIGGER trg_user_capabilities_updated BEFORE UPDATE ON user_capabilities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- address_private, lat and lng are never part of any public response.
CREATE TABLE IF NOT EXISTS venues (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organisations(id),
  name             TEXT NOT NULL,
  locality_id      UUID,
  capacity         INTEGER CHECK (capacity IS NULL OR capacity > 0),
  address_private  TEXT,
  lat              DOUBLE PRECISION CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lng              DOUBLE PRECISION CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
  status           venue_status NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_venues_org ON venues (org_id, status);
DROP TRIGGER IF EXISTS trg_venues_updated ON venues;
CREATE TRIGGER trg_venues_updated BEFORE UPDATE ON venues FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS event_team (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id),
  org_id      UUID REFERENCES organisations(id),
  user_id     UUID REFERENCES users(id),
  team_role   TEXT NOT NULL,
  status      team_status NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_team_member CHECK (org_id IS NOT NULL OR user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_event_team_event ON event_team (event_id, status);

ALTER TABLE events ADD COLUMN IF NOT EXISTS organiser_org_id UUID REFERENCES organisations(id);
CREATE INDEX IF NOT EXISTS idx_events_organiser_org ON events (organiser_org_id, start_at DESC) WHERE organiser_org_id IS NOT NULL;

-- Compatibility backfill: everyone who organises today (wizard access or owns an event/draft)
-- gets a personal org, an owner membership and the organise_events capability.
WITH organisers AS (
  SELECT u.id, u.alias, u.organiser_enabled FROM users u
   WHERE u.organiser_enabled
      OR EXISTS (SELECT 1 FROM events e WHERE e.organiser_user_id = u.id)
      OR EXISTS (SELECT 1 FROM event_drafts d WHERE d.organiser_user_id = u.id)
)
INSERT INTO organisations (kind, name, status, personal_user_id)
SELECT 'personal', COALESCE(NULLIF(trim(o.alias), ''), 'Personal'), 'active', o.id FROM organisers o
ON CONFLICT (personal_user_id) DO NOTHING;

INSERT INTO org_memberships (user_id, org_id, role, status)
SELECT o.personal_user_id, o.id, 'owner', 'active' FROM organisations o WHERE o.kind = 'personal'
ON CONFLICT (user_id, org_id) DO NOTHING;

INSERT INTO user_capabilities (user_id, capability_code, status)
SELECT o.personal_user_id, 'organise_events', CASE WHEN u.organiser_enabled THEN 'verified' ELSE 'revoked' END::capability_status
  FROM organisations o JOIN users u ON u.id = o.personal_user_id WHERE o.kind = 'personal'
ON CONFLICT (user_id, capability_code) DO NOTHING;

UPDATE events e SET organiser_org_id = o.id
  FROM organisations o
 WHERE o.personal_user_id = e.organiser_user_id AND e.organiser_org_id IS NULL;
