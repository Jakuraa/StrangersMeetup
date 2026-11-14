-- migrations/023_whatsapp_auth_and_notifications.sql
-- WhatsApp OTP authentication, multi-channel notification outbox, communication consents, and suppression lists.
-- Additive only. Idempotent and safe for re-runs.

-- 1. Extend identity_provider enum to include 'whatsapp'
DO $$ BEGIN
  ALTER TYPE identity_provider ADD VALUE IF NOT EXISTS 'whatsapp';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Allow users table to support phone-first and whatsapp-first accounts
-- telegram_user_id was NOT NULL in 003; dropping NOT NULL allows WhatsApp-only signups before linking Telegram.
ALTER TABLE users ALTER COLUMN telegram_user_id DROP NOT NULL;

-- Add phone column for normalized E.164 phone numbers
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE;

-- 3. OTP Challenges table for server-side OTP generation, hashing, and verification
CREATE TABLE IF NOT EXISTS otp_challenges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             TEXT NOT NULL,
  otp_hash          TEXT NOT NULL,
  salt              TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT 'login', -- 'login', 'link', 'recovery'
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  attempts_count    INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 5,
  resend_after      TIMESTAMPTZ NOT NULL,
  ip                TEXT NOT NULL,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created ON otp_challenges (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_challenges_ip_created ON otp_challenges (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_challenges_unconsumed ON otp_challenges (phone, expires_at) WHERE consumed_at IS NULL;

-- 4. Communication Consents table for independent transactional vs promotional consent
CREATE TABLE IF NOT EXISTS communication_consents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL, -- 'whatsapp', 'telegram', 'email', 'sms'
  purpose           TEXT NOT NULL, -- 'transactional', 'promotional'
  status            TEXT NOT NULL, -- 'opted_in', 'opted_out'
  policy_version    TEXT NOT NULL DEFAULT '1.0',
  source            TEXT NOT NULL, -- 'signin_form', 'profile_settings', 'opt_out_link', 'webhook'
  ip                TEXT,
  consented_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, purpose)
);

CREATE INDEX IF NOT EXISTS idx_communication_consents_user ON communication_consents (user_id);
CREATE INDEX IF NOT EXISTS idx_communication_consents_lookup ON communication_consents (user_id, channel, purpose, status);

-- 5. Notification Suppressions list (e.g. STOP requests, hard bounces, complaints)
CREATE TABLE IF NOT EXISTS notification_suppressions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel           TEXT NOT NULL, -- 'whatsapp', 'telegram', 'email', 'sms'
  destination       TEXT NOT NULL, -- normalized phone E.164, telegram user id, or email
  reason            TEXT NOT NULL, -- 'user_opt_out', 'bounce', 'complaint', 'admin_suppressed'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, destination)
);

CREATE INDEX IF NOT EXISTS idx_notification_suppressions_dest ON notification_suppressions (channel, destination);

-- 6. Notification Messages dispatch log for multi-channel delivery, retries, and cost tracking
CREATE TABLE IF NOT EXISTS notification_messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id       UUID REFERENCES notifications(id) ON DELETE SET NULL,
  user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  channel               TEXT NOT NULL, -- 'whatsapp', 'telegram', 'email', 'sms'
  recipient             TEXT NOT NULL, -- phone (E.164), telegram_id, email
  purpose               TEXT NOT NULL DEFAULT 'transactional', -- 'auth_otp', 'transactional', 'promotional'
  template_name         TEXT,
  idempotency_key       TEXT UNIQUE NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued', -- 'queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'
  provider              TEXT NOT NULL, -- 'meta_cloud_api', 'telegram_bot', 'mock'
  provider_message_id   TEXT, -- e.g. wamid.HBg...
  delivery_cost_paise   INT NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'INR',
  attempts              INT NOT NULL DEFAULT 0,
  last_error            TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at               TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_messages_user ON notification_messages (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_messages_status ON notification_messages (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_messages_wamid ON notification_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;
