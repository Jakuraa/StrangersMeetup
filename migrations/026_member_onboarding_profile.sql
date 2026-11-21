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

-- 4. Grandfather all existing pre-migration members.
-- We identify pre-migration users via reliable creation timestamp:
-- Any account created on or before migration application is an existing member.
DO $$
DECLARE
  v_cutoff TIMESTAMPTZ;
BEGIN
  -- Determine migration cutoff:
  -- If schema_migrations already has an applied_at for 026, use that.
  -- Otherwise, use clock_timestamp() as the cutoff for existing users.
  SELECT applied_at INTO v_cutoff FROM schema_migrations WHERE name = '026_member_onboarding_profile.sql';
  IF v_cutoff IS NULL THEN
    v_cutoff := clock_timestamp();
  END IF;

  -- 4a. Grandfather existing pre-migration users:
  -- Any user created on or before v_cutoff that has a verified account identity
  -- (telegram_user_id, phone, linked in user_identities, active admin_users, or bookings).
  -- CRITICAL CONSENT INTEGRITY RULES:
  -- 1. An alias alone does NOT prove identity, age, or consent; accounts with alias only are NOT grandfathered.
  -- 2. Existing members are marked onboarding_completed = true so they do NOT repeat profile onboarding.
  -- 3. NEVER set age_confirmed_21 = true unless an actual historical age-confirmation record exists.
  -- 4. NEVER manufacture confirmed age-consent records in onboarding_consents.
  UPDATE users SET
    onboarding_completed = true,
    onboarding_completed_at = COALESCE(onboarding_completed_at, age_confirmed_at, created_at, v_cutoff),
    onboarding_step = 6,
    display_name = COALESCE(display_name, alias, 'Member'),
    age_consent_policy_version = CASE
      WHEN age_confirmed_21 = true THEN COALESCE(age_consent_policy_version, 'historical')
      ELSE age_consent_policy_version
    END
  WHERE created_at <= v_cutoff
    AND onboarding_completed = false
    AND (
      telegram_user_id IS NOT NULL
      OR (phone IS NOT NULL AND phone <> '')
      OR EXISTS (SELECT 1 FROM user_identities ui WHERE ui.user_id = users.id)
      OR EXISTS (SELECT 1 FROM admin_users au WHERE au.telegram_user_id = users.telegram_user_id AND au.active)
      OR EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = users.id)
    );

  -- 4b. Record historical age consent ONLY for users who ACTUALLY had age_confirmed_21 = true.
  -- We NEVER manufacture confirmed age-consent records for users without genuine evidence.
  INSERT INTO onboarding_consents (user_id, consent_type, confirmed, policy_version, consented_at)
  SELECT
    id,
    'age_21_plus',
    true,
    COALESCE(age_consent_policy_version, 'historical'),
    COALESCE(age_confirmed_at, created_at, v_cutoff)
  FROM users
  WHERE created_at <= v_cutoff
    AND age_confirmed_21 = true
  ON CONFLICT (user_id, consent_type) DO UPDATE SET
    confirmed = true
  WHERE onboarding_consents.confirmed IS NOT TRUE;

  -- 4c. Backfill existing profile interests from users.interests array into member_interests table
  INSERT INTO member_interests (user_id, interest_key, created_at)
  SELECT
    u.id,
    unnest(u.interests),
    COALESCE(u.created_at, v_cutoff)
  FROM users u
  WHERE u.interests IS NOT NULL AND array_length(u.interests, 1) > 0
  ON CONFLICT (user_id, interest_key) DO NOTHING;

END $$;

-- 5. Index for fast onboarding status lookups
CREATE INDEX IF NOT EXISTS idx_users_onboarding_status ON users(onboarding_completed, onboarding_step);
