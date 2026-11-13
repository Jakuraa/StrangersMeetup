-- 020_attendee_discovery_and_experience.sql - Saved events, discovery indexes & attendee experience foundation.
-- Additive only; safe to re-run.

-- 1. Saved events (bookmarks) for attendees
CREATE TABLE IF NOT EXISTS saved_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id   UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_saved_events_user_event UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_events_user ON saved_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_events_event ON saved_events (event_id);

-- 2. Performance indexes for discovery queries, filtering & ranking
CREATE INDEX IF NOT EXISTS idx_events_discovery_status_start
  ON events (status, start_at ASC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_events_discovery_city
  ON events (lower(city), status, start_at ASC)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_events_discovery_category
  ON events (category, status, start_at ASC)
  WHERE status = 'published';
