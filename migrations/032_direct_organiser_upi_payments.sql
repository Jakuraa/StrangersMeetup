-- 032_direct_organiser_upi_payments.sql
-- Direct Organiser UPI Payment Integration:
-- Organiser-to-attendee direct peer-to-peer payments without intermediary gateway holding funds.

-- 1. Extend events table
ALTER TABLE events ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'free';
ALTER TABLE events ADD COLUMN IF NOT EXISTS organiser_upi_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS organiser_payee_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS payment_instructions TEXT;

-- 2. Extend bookings table for direct organiser UPI payment tracking
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_ref TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS direct_upi_status TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS utr_reference TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_reported_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Update payment_mode check constraint to include direct_upi
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_mode;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_mode
  CHECK (payment_mode IS NULL OR payment_mode IN ('free', 'provider', 'external', 'direct_upi'));

-- Add check constraint for direct_upi_status
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_direct_upi_status;
ALTER TABLE bookings ADD CONSTRAINT bookings_direct_upi_status
  CHECK (direct_upi_status IS NULL OR direct_upi_status IN (
    'awaiting_payment',
    'payment_reported',
    'payment_under_review',
    'payment_confirmed',
    'payment_rejected',
    'expired',
    'cancelled'
  ));

-- Unique booking reference index
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_booking_ref ON bookings(booking_ref) WHERE booking_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_direct_upi ON bookings(event_id, direct_upi_status);
CREATE INDEX IF NOT EXISTS idx_bookings_utr ON bookings(utr_reference) WHERE utr_reference IS NOT NULL;

-- 3. Audit trail for direct organiser payment verifications and transitions
CREATE TABLE IF NOT EXISTS direct_upi_payment_audits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role      TEXT NOT NULL DEFAULT 'organiser',
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  utr_reference   TEXT,
  amount_paise    BIGINT NOT NULL,
  notes           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_direct_upi_audits_booking ON direct_upi_payment_audits(booking_id, created_at);
CREATE INDEX IF NOT EXISTS idx_direct_upi_audits_event ON direct_upi_payment_audits(event_id, created_at);
