-- 017_payments_tier_holds_index.sql — Add index for ticket-tier active payment holds.
-- Matches query expression in activeTierPaymentHolds:
--   ((raw_ref->>'ticketTypeId')::uuid), status, expires_at

CREATE INDEX IF NOT EXISTS idx_payments_active_tier_holds
  ON payments (((raw_ref->>'ticketTypeId')::uuid), status, expires_at);
