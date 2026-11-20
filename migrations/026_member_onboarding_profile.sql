-- migrations/026_member_onboarding_profile.sql
-- Member onboarding: mandatory profile completion tracking, structured interests,
-- consent timestamps, and onboarding step state.
-- Additive only. Idempotent and safe for re-runs.

-- 0. Ensure user_gender enum includes 'other'
DO $$ BEGIN
  ALTER TYPE user_gender ADD VALUE IF NOT EXISTS 'other';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 1. Add onboarding tracking columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS languages TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_consent_policy_version TEXT;

-- 2. Create member_interests table for structured interest storage
CREATE TABLE IF NOT EXISTS member_interests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  interest_key  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, interest_key)
);
CREATE INDEX IF NOT EXISTS idx_member_interests_user ON member_interests(user_id);
CREATE INDEX IF NOT EXISTS idx_member_interests_key ON member_interests(interest_key);

-- 3. Create onboarding_consents table for age eligibility consent audit
CREATE TABLE IF NOT EXISTS onboarding_consents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type      TEXT NOT NULL, -- 'age_21_plus', 'terms_acceptance', 'photo_upload'
  confirmed         BOOLEAN NOT NULL DEFAULT false,
  policy_version    TEXT NOT NULL DEFAULT '1.0',
  ip                TEXT,
  user_agent        TEXT,
  consented_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, consent_type)
);
CREATE INDEX IF NOT EXISTS idx_onboarding_consents_user ON onboarding_consents(user_id);

-- 4. Backfill: existing users with age_confirmed_21=true and at least one booking
-- are considered to have completed onboarding (grandfather clause)
UPDATE users SET
  onboarding_completed = true,
  onboarding_completed_at = COALESCE(age_confirmed_at, created_at),
  onboarding_step = 6,
  display_name = COALESCE(display_name, alias)
WHERE age_confirmed_21 = true
  AND onboarding_completed = false
  AND EXISTS (SELECT 1 FROM bookings WHERE bookings.user_id = users.id);

-- 5. Index for fast onboarding status lookups
CREATE INDEX IF NOT EXISTS idx_users_onboarding_status ON users(onboarding_completed, onboarding_step);
