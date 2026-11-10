-- 018_telegram_operational_workflows.sql — Telegram account linking tokens, user notification preferences & quiet hours.
-- Additive only. Safe to re-run.

-- 1. User notification preferences and quiet hours
ALTER TABLE users ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_start TIME NOT NULL DEFAULT '23:00';
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiet_hours_end TIME NOT NULL DEFAULT '08:00';

-- 2. Account linking tokens: single-use, 15-minute cryptographically secure tokens linking web sessions to Telegram
CREATE TABLE IF NOT EXISTS account_link_tokens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
  token             TEXT UNIQUE NOT NULL,
  telegram_user_id  BIGINT,
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_link_tokens_token ON account_link_tokens(token) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_account_link_tokens_user ON account_link_tokens(user_id);

-- 3. Index on events.telegram_chat_id for event group chat resolution
CREATE INDEX IF NOT EXISTS idx_events_telegram_chat ON events (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
