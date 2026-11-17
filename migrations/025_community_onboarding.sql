-- migrations/025_community_onboarding.sql
-- Automated community onboarding tracking for Telegram and WhatsApp identities.
-- Idempotent, privacy-preserving, and additive only.

CREATE TABLE IF NOT EXISTS user_onboarding (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel               TEXT NOT NULL, -- 'telegram' or 'whatsapp'
  status                TEXT NOT NULL DEFAULT 'registered', -- 'registered', 'welcome_sent', 'channel_offered', 'channel_clicked', 'completed'
  telegram_user_id      BIGINT,
  whatsapp_phone        TEXT,
  welcome_sent_at       TIMESTAMPTZ,
  channel_offered_at    TIMESTAMPTZ,
  channel_clicked_at    TIMESTAMPTZ,
  membership_verified   BOOLEAN NOT NULL DEFAULT false,
  membership_checked_at TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_user_onboarding_user ON user_onboarding(user_id);
CREATE INDEX IF NOT EXISTS idx_user_onboarding_channel_status ON user_onboarding(channel, status);
CREATE INDEX IF NOT EXISTS idx_user_onboarding_tg_user ON user_onboarding(telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_onboarding_wa_phone ON user_onboarding(whatsapp_phone) WHERE whatsapp_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_onboarding_created ON user_onboarding(created_at DESC);
