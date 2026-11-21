-- migrations/028_master_platform_evolution.sql
-- Master Platform Evolution: Unified Business Workspaces, Dual Account Switching,
-- Attendee Networking & Preferences, Event Cancellation/Archival Lifecycle, and Media Cleanup Audit.
-- Additive, idempotent, backward-compatible migration.

-- 1. Extend users table for dual account modes and onboarding flows
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_mode TEXT NOT NULL DEFAULT 'attendee';
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_flow TEXT NOT NULL DEFAULT 'attendee';

-- Ensure constraint on active_mode and onboarding_flow
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_active_mode CHECK (active_mode IN ('attendee', 'business'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_users_onboarding_flow CHECK (onboarding_flow IN ('attendee', 'business'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Attendee Experience Preferences and Recommendation Profiles
CREATE TABLE IF NOT EXISTS user_preferences (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  preferred_group_sizes   TEXT[] NOT NULL DEFAULT '{}',
  preferred_event_times   TEXT[] NOT NULL DEFAULT '{}',
  preferred_event_types   TEXT[] NOT NULL DEFAULT '{}',
  preferred_music         TEXT[] NOT NULL DEFAULT '{}',
  preferred_dining        TEXT[] NOT NULL DEFAULT '{}',
  social_discovery_opt_in BOOLEAN NOT NULL DEFAULT false,
  profile_visibility      TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'connections_only', 'private')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON user_preferences(user_id);

DROP TRIGGER IF EXISTS trg_user_preferences_updated ON user_preferences;
CREATE TRIGGER trg_user_preferences_updated BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Attendee-to-Attendee Connections (Privacy-Preserving Social Networking)
CREATE TABLE IF NOT EXISTS user_connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'blocked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_user_connections_not_self CHECK (requester_id <> addressee_id),
  UNIQUE (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_user_connections_requester ON user_connections(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_user_connections_addressee ON user_connections(addressee_id, status);

DROP TRIGGER IF EXISTS trg_user_connections_updated ON user_connections;
CREATE TRIGGER trg_user_connections_updated BEFORE UPDATE ON user_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. Unified Business Workspaces
CREATE TABLE IF NOT EXISTS business_workspaces (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE UNIQUE,
  owner_user_id     UUID NOT NULL REFERENCES users(id),
  business_type     TEXT NOT NULL DEFAULT 'organiser' CHECK (business_type IN (
                      'organiser', 'venue', 'host', 'trip_operator', 'artist_dj',
                      'photographer', 'transport', 'activity_provider', 'production_supplier', 'supplier', 'other'
                    )),
  business_name     TEXT NOT NULL,
  description       TEXT,
  city              TEXT,
  operating_cities  TEXT[] NOT NULL DEFAULT '{}',
  services          TEXT[] NOT NULL DEFAULT '{}',
  logo_url          TEXT,
  cover_image_url   TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'suspended')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_workspaces_owner ON business_workspaces(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_business_workspaces_type ON business_workspaces(business_type, status);

DROP TRIGGER IF EXISTS trg_business_workspaces_updated ON business_workspaces;
CREATE TRIGGER trg_business_workspaces_updated BEFORE UPDATE ON business_workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ BEGIN
  ALTER TABLE business_workspaces DROP CONSTRAINT IF EXISTS business_workspaces_business_type_check;
  ALTER TABLE business_workspaces ADD CONSTRAINT business_workspaces_business_type_check CHECK (business_type IN (
    'organiser', 'venue', 'host', 'trip_operator', 'artist_dj',
    'photographer', 'transport', 'activity_provider', 'production_supplier', 'supplier', 'other'
  ));
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- 5. Business Suppliers & Partners Listings
CREATE TABLE IF NOT EXISTS business_suppliers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID NOT NULL REFERENCES business_workspaces(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  portfolio_urls TEXT[] NOT NULL DEFAULT '{}',
  service_areas  TEXT[] NOT NULL DEFAULT '{}',
  pricing_notes  TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_suppliers_workspace ON business_suppliers(workspace_id);
CREATE INDEX IF NOT EXISTS idx_business_suppliers_category ON business_suppliers(category, status);

DROP TRIGGER IF EXISTS trg_business_suppliers_updated ON business_suppliers;
CREATE TRIGGER trg_business_suppliers_updated BEFORE UPDATE ON business_suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6. Event Lifecycle Extensions: Soft-deletion, Archival, and Cancellation Audit
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS media_cleaned_up BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS media_cleaned_up_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS event_cancellations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE UNIQUE,
  cancelled_by_user_id    UUID NOT NULL REFERENCES users(id),
  reason                  TEXT NOT NULL,
  refund_notes            TEXT,
  attendee_count_notified INT NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_cancellations_event ON event_cancellations(event_id);

-- 7. Event Media Cleanup Jobs Audit & Telemetry
CREATE TABLE IF NOT EXISTS media_cleanup_jobs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type             TEXT NOT NULL DEFAULT 'scheduled' CHECK (job_type IN ('scheduled', 'manual_event', 'dry_run')),
  event_id             UUID REFERENCES events(id),
  initiated_by_user_id UUID REFERENCES users(id),
  status               TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  items_scanned        INT NOT NULL DEFAULT 0,
  items_deleted        INT NOT NULL DEFAULT 0,
  bytes_reclaimed      BIGINT NOT NULL DEFAULT 0,
  error_message        TEXT,
  details              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_cleanup_jobs_type ON media_cleanup_jobs(job_type, status);
CREATE INDEX IF NOT EXISTS idx_media_cleanup_jobs_event ON media_cleanup_jobs(event_id);

-- 8. Backfill existing organisers into business_workspaces
-- Ensures zero disruption for existing organisers who created personal organisations in migration 012
INSERT INTO business_workspaces (org_id, owner_user_id, business_type, business_name, description, status)
SELECT o.id, o.personal_user_id, 'organiser', o.name, 'Organiser Workspace', 'active'
  FROM organisations o
 WHERE o.kind = 'personal' AND o.personal_user_id IS NOT NULL
ON CONFLICT (org_id) DO NOTHING;
