-- 011_trust_safety_remediation.sql - Website safety reporting enhancements and attendee blocking

-- 1. Reports table enhancements
ALTER TABLE reports ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_reports_event ON reports (event_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user ON reports (reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_user_created ON reports (user_id, created_at DESC);

-- 2. User blocking relationship
CREATE TABLE IF NOT EXISTS user_blocks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_blocks UNIQUE (blocker_user_id, blocked_user_id),
  CONSTRAINT chk_no_self_block CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks (blocker_user_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks (blocked_user_id);
