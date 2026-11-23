-- migrations/031_venue_self_service_onboarding.sql
-- NIGHTLIFEZ Full Self-Service Venue Onboarding & Direct Management.
-- Additive columns on venues for self-service categorization, neighbourhood, and progress tracking.
-- Fully safe, idempotent, non-destructive, and backward compatible.

-- 1. Extend venues table with self-service metadata
ALTER TABLE venues ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS neighbourhood TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS onboarding_step INTEGER NOT NULL DEFAULT 1;

-- 2. Indexes for discovery, filtering, and onboarding lookups
CREATE INDEX IF NOT EXISTS idx_venues_category ON venues (category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_venues_neighbourhood ON venues (neighbourhood) WHERE neighbourhood IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_venues_onboarding_completed ON venues (org_id, onboarding_completed);
