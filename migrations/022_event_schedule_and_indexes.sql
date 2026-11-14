-- 022_event_schedule_and_indexes.sql — Event Multi-Date Scheduling & Performance Optimization Indexes
-- Additive only, safe, idempotent. Preserves existing event rows and single/consecutive date models.

-- 1. Index for rapid public event queries by status, start_at and end_at
CREATE INDEX IF NOT EXISTS idx_events_status_start_end
  ON events (status, start_at, end_at)
  WHERE status = 'published';

-- 2. Index for ticket tier inventory & active status lookups
CREATE INDEX IF NOT EXISTS idx_ticket_types_event_active
  ON ticket_types (event_id, active, sort_order);

-- 3. Composite index on bookings for tier seat counting & holds
CREATE INDEX IF NOT EXISTS idx_bookings_tier_status
  ON bookings (ticket_type_id, status)
  WHERE status IN ('confirmed', 'checked_in', 'pending_payment');

-- 4. Index on event images for lifecycle cleanup and draft lookup
CREATE INDEX IF NOT EXISTS idx_event_images_draft_public
  ON event_images (draft_id, is_public, created_at);
