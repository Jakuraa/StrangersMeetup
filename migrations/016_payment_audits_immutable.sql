-- 016_payment_audits_immutable.sql — Enforce append-only integrity on payment_audits table.
-- Prevents UPDATE and DELETE operations to guarantee tamper-proof audit trail.
-- Adds index for fast active-hold capacity querying on payments table.

CREATE OR REPLACE FUNCTION prevent_payment_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_audits is an append-only ledger; updates and deletes are forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_audits_immutable ON payment_audits;
CREATE TRIGGER trg_payment_audits_immutable
BEFORE UPDATE OR DELETE ON payment_audits
FOR EACH ROW EXECUTE FUNCTION prevent_payment_audit_mutation();

CREATE INDEX IF NOT EXISTS idx_payments_active_holds ON payments (((raw_ref->>'eventId')::uuid), status, expires_at);
