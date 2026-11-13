-- 015_upi_payment_integration.sql — UPI-first checkout, dynamic QR, and payment state machine.
-- Extends payment_provider, payment_status, and checkout_mode enums additively.
-- Adds order tracking, dynamic QR data, device classification, and audit ledger.

-- 1. Extend enums
ALTER TYPE payment_provider ADD VALUE IF NOT EXISTS 'phonepe';
ALTER TYPE payment_provider ADD VALUE IF NOT EXISTS 'upi_mock';

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'processing';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'succeeded';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'expired';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'refund_pending';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'disputed';

ALTER TYPE checkout_mode ADD VALUE IF NOT EXISTS 'upi_direct';

-- 2. Extend payments table
ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS merchant_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS device_type TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS upi_intent_url TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS upi_qr_data TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS webhook_verified_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS verified_event_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reconciled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_ref TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS dispute_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_order_id ON payments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_expires ON payments (expires_at);

-- 3. Payment audit ledger (immutable append-only history of transitions and gateway interactions)
CREATE TABLE IF NOT EXISTS payment_audits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  UUID REFERENCES payments(id),
  order_id    TEXT NOT NULL,
  from_status payment_status,
  to_status   payment_status NOT NULL,
  actor       TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_audits_order ON payment_audits (order_id, created_at);
