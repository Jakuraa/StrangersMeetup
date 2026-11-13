-- 019_organiser_workspace_and_checkin.sql — Organiser workspace, event-scoped staff, secure QR ticketing & door check-in.
-- Additive only; safe to re-run.

-- 1. Enhance event_team with audit and revocation columns
ALTER TABLE event_team ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE event_team ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(id);
ALTER TABLE event_team ADD COLUMN IF NOT EXISTS revoked_by UUID REFERENCES users(id);
ALTER TABLE event_team ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE event_team ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_team_user_active
  ON event_team (event_id, user_id) WHERE status = 'active' AND user_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_event_team_updated ON event_team;
CREATE TRIGGER trg_event_team_updated BEFORE UPDATE ON event_team FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. Staff invitations table for event-scoped roles
CREATE TABLE IF NOT EXISTS event_staff_invites (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  invited_by     UUID NOT NULL REFERENCES users(id),
  invited_alias  TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at     TIMESTAMPTZ NOT NULL,
  accepted_by    UUID REFERENCES users(id),
  accepted_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_staff_invites_event ON event_staff_invites (event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_staff_invites_token ON event_staff_invites (token) WHERE status = 'pending';

-- 3. Tickets table: cryptographically secure server-authoritative tickets
CREATE TABLE IF NOT EXISTS tickets (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id             UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_id               UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL REFERENCES users(id),
  ticket_type_id         UUID REFERENCES ticket_types(id),
  ticket_number          INTEGER NOT NULL DEFAULT 1,
  ticket_code            TEXT NOT NULL UNIQUE,
  security_hash          TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'checked_in', 'revoked', 'reissued', 'cancelled')),
  checked_in_at          TIMESTAMPTZ,
  checked_in_by          UUID REFERENCES users(id),
  check_in_method        TEXT CHECK (check_in_method IS NULL OR check_in_method IN ('camera_qr', 'manual_lookup', 'manual_override')),
  override_reason        TEXT,
  reissued_to_ticket_id  UUID REFERENCES tickets(id),
  reissued_at            TIMESTAMPTZ,
  reissued_by            UUID REFERENCES users(id),
  revoked_at             TIMESTAMPTZ,
  revoked_by             UUID REFERENCES users(id),
  revocation_reason      TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_booking ON tickets (booking_id);
CREATE INDEX IF NOT EXISTS idx_tickets_event_status ON tickets (event_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets (ticket_code);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets (user_id);
DROP TRIGGER IF EXISTS trg_tickets_updated ON tickets;
CREATE TRIGGER trg_tickets_updated BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 4. Ticket Scans & Check-in Audit Logs (server-authoritative audit trail)
CREATE TABLE IF NOT EXISTS ticket_scans (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id              UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_id             UUID REFERENCES tickets(id),
  booking_id            UUID REFERENCES bookings(id),
  scanned_by            UUID NOT NULL REFERENCES users(id),
  scan_result           TEXT NOT NULL,
  scan_method           TEXT NOT NULL CHECK (scan_method IN ('camera_qr', 'manual_lookup', 'manual_override')),
  override_reason       TEXT,
  scanned_payload_hash  TEXT NOT NULL,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ticket_scans_event ON ticket_scans (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_scans_ticket ON ticket_scans (ticket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_scans_staff ON ticket_scans (scanned_by, created_at DESC);

-- 5. Event Announcements Table
CREATE TABLE IF NOT EXISTS event_announcements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sender_user_id    UUID NOT NULL REFERENCES users(id),
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  is_pinned         BOOLEAN NOT NULL DEFAULT false,
  notify_attendees  BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_announcements_event ON event_announcements (event_id, created_at DESC);

-- 6. Backfill existing confirmed bookings with tickets if any exist without tickets
INSERT INTO tickets (booking_id, event_id, user_id, ticket_type_id, ticket_number, ticket_code, security_hash, status, created_at)
SELECT b.id, b.event_id, b.user_id, b.ticket_type_id, 1,
       'TK-' || upper(substr(md5(b.id::text || '-1-' || b.created_at::text), 1, 4)) || '-' ||
       upper(substr(md5(b.id::text || '-2-' || b.created_at::text), 5, 4)) || '-' ||
       upper(substr(md5(b.id::text || '-3-' || b.created_at::text), 9, 4)),
       md5('nlz_seed_sig_' || b.id::text),
       CASE WHEN b.status = 'checked_in' THEN 'checked_in'
            WHEN b.status = 'cancelled' THEN 'cancelled'
            WHEN b.status = 'refunded' THEN 'revoked'
            ELSE 'valid' END,
       b.created_at
  FROM bookings b
 WHERE b.status IN ('confirmed', 'checked_in')
   AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.booking_id = b.id)
ON CONFLICT (ticket_code) DO NOTHING;
