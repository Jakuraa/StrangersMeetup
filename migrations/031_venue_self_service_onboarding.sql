-- migrations/031_venue_self_service_onboarding.sql
-- NIGHTLIFEZ Full Self-Service Venue Onboarding & Direct Management.
-- Additive columns on venues for self-service categorization, neighbourhood, and progress tracking.
-- Fully safe, idempotent, non-destructive, and backward compatible.

-- 1. Extend venue_status enum to include 'draft' for isolated uncompleted drafts
ALTER TYPE venue_status ADD VALUE IF NOT EXISTS 'draft';

-- 2. Extend venues table with self-service metadata
ALTER TABLE venues ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS neighbourhood TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS onboarding_step INTEGER NOT NULL DEFAULT 1;

-- 3. Indexes for discovery, filtering, and onboarding lookups
CREATE INDEX IF NOT EXISTS idx_venues_category ON venues (category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_venues_neighbourhood ON venues (neighbourhood) WHERE neighbourhood IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_venues_onboarding_completed ON venues (org_id, onboarding_completed);
CREATE INDEX IF NOT EXISTS idx_venues_active_discovery ON venues (id, org_id) WHERE status = 'active' AND onboarding_completed = true;

-- 4. Self-service ownership claims & recovery for duplicate/unclaimed venues
CREATE TABLE IF NOT EXISTS venue_claims (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id            UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  claimant_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claimant_org_id     UUID REFERENCES organisations(id) ON DELETE SET NULL,
  claimant_role       TEXT NOT NULL,
  business_proof_type TEXT NOT NULL,
  business_proof_ref  TEXT NOT NULL,
  contact_name        TEXT NOT NULL,
  contact_email       TEXT NOT NULL,
  contact_phone       TEXT,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_verification',
  resolution_notes    TEXT,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_venue_claims_venue ON venue_claims (venue_id, status);
CREATE INDEX IF NOT EXISTS idx_venue_claims_user ON venue_claims (claimant_user_id, status);
