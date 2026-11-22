-- migrations/030_infrastructure_fee_accounting.sql
-- NIGHTLIFEZ 5% Infrastructure Fee & Organiser Commission Accounting.
-- Transparent organiser-side fee calculation, accounting ledger, invoices, receipts,
-- payment submission claims, admin bank verification queue, allocations, and credit notes.
-- Additive, safe, idempotent, and backward compatible.

-- 1. Infrastructure Fee Rules (Admin-configurable percentage, default 5%)
CREATE TABLE IF NOT EXISTS infrastructure_fee_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL DEFAULT 'Standard Platform Infrastructure Fee',
  fee_percentage  NUMERIC(5,2) NOT NULL DEFAULT 5.00 CHECK (fee_percentage >= 0 AND fee_percentage <= 100),
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID REFERENCES admin_users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_infra_fee_rules_active ON infrastructure_fee_rules (is_active, effective_from DESC);

DROP TRIGGER IF EXISTS trg_infra_fee_rules_updated ON infrastructure_fee_rules;
CREATE TRIGGER trg_infra_fee_rules_updated BEFORE UPDATE ON infrastructure_fee_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed the initial default 5% rule if none exists
INSERT INTO infrastructure_fee_rules (name, fee_percentage, is_active, notes)
SELECT 'Default 5% Infrastructure Fee', 5.00, true, 'Standard platform infrastructure fee applied to base ticket price'
WHERE NOT EXISTS (SELECT 1 FROM infrastructure_fee_rules);

-- 2. Organiser Fee Accounts (Balance and settlement state per organiser)
CREATE TABLE IF NOT EXISTS organiser_fee_accounts (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organiser_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  total_fee_payable_paise    BIGINT NOT NULL DEFAULT 0 CHECK (total_fee_payable_paise >= 0),
  total_fee_paid_paise       BIGINT NOT NULL DEFAULT 0 CHECK (total_fee_paid_paise >= 0),
  total_fee_reversal_paise   BIGINT NOT NULL DEFAULT 0 CHECK (total_fee_reversal_paise >= 0),
  outstanding_balance_paise  BIGINT NOT NULL DEFAULT 0,
  status                     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'overdue', 'suspended')),
  last_settled_at            TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organiser_fee_accounts_org ON organiser_fee_accounts (organiser_id);
CREATE INDEX IF NOT EXISTS idx_organiser_fee_accounts_status ON organiser_fee_accounts (status);

DROP TRIGGER IF EXISTS trg_organiser_fee_accounts_updated ON organiser_fee_accounts;
CREATE TRIGGER trg_organiser_fee_accounts_updated BEFORE UPDATE ON organiser_fee_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Extend Events for Organiser Direct UPI and Payment Deadlines
ALTER TABLE events ADD COLUMN IF NOT EXISTS organiser_upi_id TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS infrastructure_fee_deadline TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS infrastructure_fee_extension_granted_by UUID REFERENCES admin_users(id);
ALTER TABLE events ADD COLUMN IF NOT EXISTS infrastructure_fee_extension_reason TEXT;

-- 4. Extend Bookings for Infrastructure Fee Snapshot & Breakdown
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_rule_id UUID REFERENCES infrastructure_fee_rules(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_percentage NUMERIC(5,2);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_price_paise INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS infrastructure_fee_paise INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_calculation_snapshot JSONB DEFAULT '{}'::jsonb;

-- 5. Infrastructure Fee Entries (Append-only accrual ledger per paid ticket booking)
CREATE TABLE IF NOT EXISTS infrastructure_fee_entries (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID REFERENCES organiser_fee_accounts(id) ON DELETE SET NULL,
  organiser_id           UUID NOT NULL REFERENCES users(id),
  event_id               UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  booking_id             UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE UNIQUE,
  ticket_type_id         UUID REFERENCES ticket_types(id) ON DELETE SET NULL,
  base_amount_paise      BIGINT NOT NULL CHECK (base_amount_paise >= 0),
  fee_percentage         NUMERIC(5,2) NOT NULL CHECK (fee_percentage >= 0 AND fee_percentage <= 100),
  fee_amount_paise       BIGINT NOT NULL CHECK (fee_amount_paise >= 0),
  total_collected_paise  BIGINT NOT NULL CHECK (total_collected_paise >= 0),
  currency               TEXT NOT NULL DEFAULT 'INR',
  rule_id                UUID REFERENCES infrastructure_fee_rules(id) ON DELETE SET NULL,
  calculation_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                 TEXT NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'invoiced', 'settled', 'reversed', 'adjusted')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_infra_fee_entries_event ON infrastructure_fee_entries (event_id, status);
CREATE INDEX IF NOT EXISTS idx_infra_fee_entries_org ON infrastructure_fee_entries (organiser_id, status);
CREATE INDEX IF NOT EXISTS idx_infra_fee_entries_booking ON infrastructure_fee_entries (booking_id);

DROP TRIGGER IF EXISTS trg_infra_fee_entries_updated ON infrastructure_fee_entries;
CREATE TRIGGER trg_infra_fee_entries_updated BEFORE UPDATE ON infrastructure_fee_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6. Organiser Fee Invoices (Event settlement period invoices)
CREATE TABLE IF NOT EXISTS organiser_fee_invoices (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number             TEXT NOT NULL UNIQUE,
  payment_reference          TEXT NOT NULL UNIQUE,
  account_id                 UUID REFERENCES organiser_fee_accounts(id) ON DELETE SET NULL,
  organiser_id               UUID NOT NULL REFERENCES users(id),
  event_id                   UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  billing_period_start       TIMESTAMPTZ NOT NULL DEFAULT now(),
  billing_period_end         TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date                   TIMESTAMPTZ NOT NULL,
  tickets_count              INTEGER NOT NULL DEFAULT 0 CHECK (tickets_count >= 0),
  gross_ticket_value_paise   BIGINT NOT NULL DEFAULT 0 CHECK (gross_ticket_value_paise >= 0),
  fee_amount_paise           BIGINT NOT NULL DEFAULT 0 CHECK (fee_amount_paise >= 0),
  reversals_paise            BIGINT NOT NULL DEFAULT 0 CHECK (reversals_paise >= 0),
  net_fee_payable_paise      BIGINT NOT NULL DEFAULT 0 CHECK (net_fee_payable_paise >= 0),
  amount_paid_paise          BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_paise >= 0),
  outstanding_amount_paise   BIGINT NOT NULL DEFAULT 0 CHECK (outstanding_amount_paise >= 0),
  status                     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                               'pending', 'payment_submitted', 'under_verification',
                               'partially_settled', 'fully_settled', 'rejected', 'overdue', 'cancelled'
                             )),
  notes                      TEXT,
  pdf_ref                    TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_invoices_org ON organiser_fee_invoices (organiser_id, status);
CREATE INDEX IF NOT EXISTS idx_fee_invoices_event ON organiser_fee_invoices (event_id);
CREATE INDEX IF NOT EXISTS idx_fee_invoices_ref ON organiser_fee_invoices (payment_reference);

DROP TRIGGER IF EXISTS trg_fee_invoices_updated ON organiser_fee_invoices;
CREATE TRIGGER trg_fee_invoices_updated BEFORE UPDATE ON organiser_fee_invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 7. Organiser Fee Invoice Lines
CREATE TABLE IF NOT EXISTS organiser_fee_invoice_lines (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id         UUID NOT NULL REFERENCES organiser_fee_invoices(id) ON DELETE CASCADE,
  fee_entry_id       UUID REFERENCES infrastructure_fee_entries(id) ON DELETE SET NULL,
  description        TEXT NOT NULL,
  quantity           INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  base_amount_paise  BIGINT NOT NULL CHECK (base_amount_paise >= 0),
  rate_percent       NUMERIC(5,2) NOT NULL CHECK (rate_percent >= 0),
  line_total_paise   BIGINT NOT NULL CHECK (line_total_paise >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_invoice_lines_inv ON organiser_fee_invoice_lines (invoice_id);

-- 8. NIGHTLIFEZ Bank Transactions (Incoming bank credit verified by finance admin)
CREATE TABLE IF NOT EXISTS nightlifez_bank_transactions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_tx_id               TEXT NOT NULL UNIQUE,
  utr_number                TEXT UNIQUE,
  amount_paise              BIGINT NOT NULL CHECK (amount_paise > 0),
  allocated_amount_paise    BIGINT NOT NULL DEFAULT 0 CHECK (allocated_amount_paise >= 0),
  unallocated_amount_paise  BIGINT NOT NULL CHECK (unallocated_amount_paise >= 0),
  payer_name                TEXT,
  payer_vpa                 TEXT,
  bank_reference            TEXT,
  transaction_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  value_date                TIMESTAMPTZ,
  status                    TEXT NOT NULL DEFAULT 'unallocated' CHECK (status IN ('unallocated', 'partially_allocated', 'fully_allocated', 'reversed')),
  verification_notes        TEXT,
  verified_by               UUID NOT NULL REFERENCES admin_users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_bank_tx_allocation CHECK (allocated_amount_paise + unallocated_amount_paise = amount_paise)
);

CREATE INDEX IF NOT EXISTS idx_bank_tx_utr ON nightlifez_bank_transactions (utr_number);
CREATE INDEX IF NOT EXISTS idx_bank_tx_status ON nightlifez_bank_transactions (status);

DROP TRIGGER IF EXISTS trg_bank_tx_updated ON nightlifez_bank_transactions;
CREATE TRIGGER trg_bank_tx_updated BEFORE UPDATE ON nightlifez_bank_transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 9. Organiser Fee Payment Submissions (Organiser payment claims — never auto-cleared)
CREATE TABLE IF NOT EXISTS organiser_fee_payment_submissions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID REFERENCES organiser_fee_accounts(id) ON DELETE SET NULL,
  organiser_id         UUID NOT NULL REFERENCES users(id),
  invoice_id           UUID REFERENCES organiser_fee_invoices(id) ON DELETE SET NULL,
  payment_reference    TEXT NOT NULL,
  amount_paise         BIGINT NOT NULL CHECK (amount_paise > 0),
  utr_number           TEXT NOT NULL,
  payer_upi_id         TEXT,
  submission_notes     TEXT,
  screenshot_url       TEXT,
  status               TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_investigation', 'verified', 'rejected')),
  rejection_reason     TEXT,
  investigation_notes  TEXT,
  verified_by          UUID REFERENCES admin_users(id),
  verified_at          TIMESTAMPTZ,
  rejected_by          UUID REFERENCES admin_users(id),
  rejected_at          TIMESTAMPTZ,
  bank_transaction_id  UUID REFERENCES nightlifez_bank_transactions(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_submission_utr UNIQUE (utr_number)
);

CREATE INDEX IF NOT EXISTS idx_fee_submissions_org ON organiser_fee_payment_submissions (organiser_id, status);
CREATE INDEX IF NOT EXISTS idx_fee_submissions_invoice ON organiser_fee_payment_submissions (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fee_submissions_utr ON organiser_fee_payment_submissions (utr_number);
CREATE INDEX IF NOT EXISTS idx_fee_submissions_status ON organiser_fee_payment_submissions (status);

DROP TRIGGER IF EXISTS trg_fee_submissions_updated ON organiser_fee_payment_submissions;
CREATE TRIGGER trg_fee_submissions_updated BEFORE UPDATE ON organiser_fee_payment_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 10. Organiser Fee Payment Allocations (Admin-confirmed allocations that clear outstanding balance)
CREATE TABLE IF NOT EXISTS organiser_fee_payment_allocations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id    UUID NOT NULL REFERENCES nightlifez_bank_transactions(id) ON DELETE RESTRICT,
  submission_id          UUID REFERENCES organiser_fee_payment_submissions(id) ON DELETE SET NULL,
  invoice_id             UUID NOT NULL REFERENCES organiser_fee_invoices(id) ON DELETE RESTRICT,
  allocated_amount_paise BIGINT NOT NULL CHECK (allocated_amount_paise > 0),
  receipt_number         TEXT NOT NULL UNIQUE,
  allocated_by           UUID NOT NULL REFERENCES admin_users(id),
  allocation_notes       TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_allocations_inv ON organiser_fee_payment_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fee_allocations_bank ON organiser_fee_payment_allocations (bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_fee_allocations_receipt ON organiser_fee_payment_allocations (receipt_number);

-- 11. Infrastructure Fee Adjustments & Credit Notes (Reversals & cancellations)
CREATE TABLE IF NOT EXISTS infrastructure_fee_adjustments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number  TEXT NOT NULL UNIQUE,
  account_id          UUID REFERENCES organiser_fee_accounts(id) ON DELETE SET NULL,
  organiser_id        UUID NOT NULL REFERENCES users(id),
  event_id            UUID REFERENCES events(id) ON DELETE SET NULL,
  invoice_id          UUID REFERENCES organiser_fee_invoices(id) ON DELETE SET NULL,
  fee_entry_id        UUID REFERENCES infrastructure_fee_entries(id) ON DELETE SET NULL,
  booking_id          UUID REFERENCES bookings(id) ON DELETE SET NULL,
  amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
  adjustment_type     TEXT NOT NULL CHECK (adjustment_type IN ('refund_reversal', 'cancellation_waiver', 'credit_note', 'admin_adjustment')),
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'approved', 'applied', 'void')),
  approved_by         UUID NOT NULL REFERENCES admin_users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_adj_org ON infrastructure_fee_adjustments (organiser_id);
CREATE INDEX IF NOT EXISTS idx_fee_adj_inv ON infrastructure_fee_adjustments (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fee_adj_booking ON infrastructure_fee_adjustments (booking_id);

-- 12. Finance Audit Logs (Immutable ledger of all financial actions and rule changes)
CREATE TABLE IF NOT EXISTS finance_audit_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  before_state  JSONB,
  after_state   JSONB,
  diff          JSONB,
  ip_address    TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_audit_entity ON finance_audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_fin_audit_actor ON finance_audit_logs (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_fin_audit_created ON finance_audit_logs (created_at DESC);
