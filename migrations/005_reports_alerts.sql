-- 005_reports_alerts.sql — safety reports from /report, and opt-in for new-event alerts.

DO $$ BEGIN
  CREATE TYPE report_status AS ENUM ('new', 'reviewing', 'actioned', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  status      report_status NOT NULL DEFAULT 'new',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);
DROP TRIGGER IF EXISTS trg_reports_updated ON reports;
CREATE TRIGGER trg_reports_updated BEFORE UPDATE ON reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_opt_in BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id);
