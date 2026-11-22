// lib/services/finance.js - NIGHTLIFEZ Infrastructure Fee & Organiser Commission Accounting.
// Zero-trust financial integrity: integer paise arithmetic, database transactions,
// append-only immutable history, strict role enforcement, and duplicate protection.

import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { logger } from '../logger.js';
import { env } from '../config.js';

export const DEFAULT_FEE_PERCENTAGE = 5.00;

export function getPlatformFinanceUpi() {
  return env('NIGHTLIFEZ_FINANCE_UPI_ID') || 'nightlifez.finance@icici';
}

export function getPlatformFinanceName() {
  return env('NIGHTLIFEZ_FINANCE_NAME') || 'NIGHTLIFEZ Experiences Private Limited';
}

/**
 * Validates external bank transaction or UTR reference.
 * Must be 6-50 chars, alphanumeric, not placeholder or repeated characters.
 */
export function isValidUtr(ref) {
  if (!ref || typeof ref !== 'string') return false;
  const trimmed = ref.trim();
  if (trimmed.length < 6 || trimmed.length > 50) return false;
  if (/^(manual|dummy|test|placeholder|none|null|n\/?a|fake|temp|xxx)/i.test(trimmed)) return false;
  if (/^(.)\1{4,}$/.test(trimmed)) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-/:]{4,48}[A-Za-z0-9]$/.test(trimmed)) return false;
  return true;
}

/**
 * Validates screenshot or evidence proof URLs.
 * Allows valid https:// URLs or local relative paths in /uploads/ or /media/.
 * Strictly forbids javascript:, data:, file:, and control characters.
 */
export function isValidEvidenceUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.length > 2048) return false;
  if (/[\r\n\t\0]/.test(trimmed)) return false;
  if (/^(javascript|data|file|vbscript):/i.test(trimmed)) return false;

  // Allow relative upload paths e.g. /uploads/evidence.jpg
  if (/^\/(uploads|media|assets)\/[A-Za-z0-9_\-./]+$/.test(trimmed)) {
    if (trimmed.includes('..')) return false;
    return true;
  }

  // Allow absolute https URLs
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * Verifies finance or super_admin authorization from an active admin_users row.
 */
export async function assertFinanceAuthorization(adminUser, c = db) {
  if (!adminUser) {
    throw new HttpError(403, 'forbidden', 'Admin authorization required');
  }
  const row = (await c.query(
    `SELECT a.id, a.role, a.active
       FROM admin_users a
      WHERE a.active = true
        AND (
          a.id = $1
          OR a.telegram_user_id = $2
          OR a.telegram_user_id = (SELECT telegram_user_id FROM users WHERE id = $1)
        )
      LIMIT 1`,
    [adminUser.id || null, adminUser.telegram_user_id || adminUser.tgId || null]
  )).rows[0];
  if (!row || !['super_admin', 'finance'].includes(row.role)) {
    throw new HttpError(403, 'forbidden_role', 'Only finance administrators or super admins can perform this action');
  }
  return row;
}

/**
 * Calculates infrastructure fee using integer paise.
 * Default 5% (500 bps).
 */
export function calculateInfrastructureFee(basePaise, customPercentage = null) {
  const base = Math.max(0, parseInt(basePaise, 10) || 0);
  const pct = customPercentage !== null && customPercentage !== undefined
    ? Number(Number(customPercentage).toFixed(2))
    : DEFAULT_FEE_PERCENTAGE;

  if (base === 0 || pct === 0) {
    return {
      basePaise: base,
      feePaise: 0,
      totalPaise: base,
      feePercentage: pct
    };
  }

  // Calculate using integer paise rounding
  const feePaise = Math.round((base * pct) / 100);
  const totalPaise = base + feePaise;

  return {
    basePaise: base,
    feePaise,
    totalPaise,
    feePercentage: pct
  };
}

/**
 * Retrieves the current active infrastructure fee rule.
 */
export async function getActiveFeeRule(c = db) {
  const row = (await c.query(
    `SELECT * FROM infrastructure_fee_rules
     WHERE is_active = true
     ORDER BY effective_from DESC
     LIMIT 1`
  )).rows[0];

  if (!row) {
    return {
      id: null,
      name: 'Default 5% Rule',
      fee_percentage: '5.00',
      is_active: true
    };
  }

  return row;
}

/**
 * Updates or sets a new infrastructure fee rule.
 * Deactivates prior rules and logs the commission change in the audit trail.
 */
export async function setFeeRule({ percentage, name = 'Platform Infrastructure Fee', notes = '', adminUser }, c = db) {
  const verifiedAdmin = await assertFinanceAuthorization(adminUser, c);

  const pct = Number(percentage);
  if (isNaN(pct) || pct < 0 || pct > 100) {
    throw new HttpError(400, 'validation', 'Fee percentage must be between 0% and 100%');
  }

  return c.tx(async (tx) => {
    // 1. Get current active rule for audit diff
    const prevRule = await getActiveFeeRule(tx);

    // 2. Deactivate existing active rules
    await tx.query(
      `UPDATE infrastructure_fee_rules
       SET is_active = false, effective_until = now(), updated_at = now()
       WHERE is_active = true`
    );

    // 3. Insert new rule
    const newRule = (await tx.query(
      `INSERT INTO infrastructure_fee_rules (name, fee_percentage, effective_from, is_active, created_by, notes)
       VALUES ($1, $2, now(), true, $3, $4)
       RETURNING *`,
      [name, pct.toFixed(2), verifiedAdmin.id, notes]
    )).rows[0];

    // 4. Log commission rule change in audit trail
    await tx.query(
      `INSERT INTO finance_audit_logs (entity_type, entity_id, action, actor_type, actor_id, before_state, after_state, notes)
       VALUES ('rule', $1, 'rule_updated', 'admin', $2, $3, $4, $5)`,
      [
        newRule.id,
        verifiedAdmin.id,
        JSON.stringify(prevRule || {}),
        JSON.stringify(newRule),
        `Commission rule updated to ${pct.toFixed(2)}%`
      ]
    );

    return newRule;
  });
}

/**
 * Helper: generates a unique invoice number.
 */
export function generateInvoiceNumber(eventSlug = '') {
  const prefix = eventSlug ? eventSlug.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, 'X') : 'NLZ';
  const yymm = new Date().toISOString().slice(2, 7).replace('-', '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `INV-${yymm}-${prefix}-${rand}`;
}

/**
 * Helper: generates a unique payment reference.
 */
export function generatePaymentReference() {
  const yymm = new Date().toISOString().slice(2, 7).replace('-', '');
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `PAYREF-${yymm}-${rand}`;
}

/**
 * Helper: generates a unique receipt number.
 */
export function generateReceiptNumber() {
  const yymm = new Date().toISOString().slice(2, 7).replace('-', '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `REC-${yymm}-${rand}`;
}

/**
 * Helper: generates a unique credit note number.
 */
export function generateCreditNoteNumber() {
  const yymm = new Date().toISOString().slice(2, 7).replace('-', '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `CN-${yymm}-${rand}`;
}

/**
 * Records an infrastructure fee entry when a paid ticket booking occurs.
 * Automatically manages:
 * - infrastructure_fee_entries
 * - organiser_fee_accounts
 * - organiser_fee_invoices
 * - organiser_fee_invoice_lines
 * - finance_audit_logs
 */
export async function recordBookingFeeEntry(booking, event, tier, c = db) {
  if (!booking || !event || !tier || tier.kind !== 'paid') {
    return null; // Free bookings do not accrue infrastructure fees
  }

  const qty = booking.quantity || 1;
  const basePaise = Number(tier.price_paise) * qty;
  const activeRule = await getActiveFeeRule(c);
  const feePct = Number(activeRule.fee_percentage || DEFAULT_FEE_PERCENTAGE);
  const calc = calculateInfrastructureFee(basePaise, feePct);

  const organiserId = event.organiser_user_id;
  if (!organiserId) {
    // Internal/feed events without organiser profile
    return null;
  }

  // 0. Upfront Idempotency Check: if an entry already exists for this booking, return immediately
  const existingEntry = (await c.query(
    `SELECT * FROM infrastructure_fee_entries WHERE booking_id = $1`,
    [booking.id]
  )).rows[0];
  if (existingEntry) {
    return { feeEntry: existingEntry, duplicate: true };
  }

  const snapshot = {
    ruleId: activeRule.id,
    feePercentage: feePct,
    baseAmountPaise: calc.basePaise,
    feePaise: calc.feePaise,
    totalCollectedPaise: calc.totalPaise,
    ticketTypeId: tier.id,
    tierName: tier.name,
    quantity: qty,
    calculatedAt: new Date().toISOString()
  };

  // 1. Update booking with fee details
  await c.query(
    `UPDATE bookings SET
       base_price_paise = $2,
       infrastructure_fee_paise = $3,
       fee_percentage = $4,
       fee_rule_id = $5,
       fee_calculation_snapshot = $6
     WHERE id = $1`,
    [booking.id, calc.basePaise, calc.feePaise, feePct, activeRule.id, JSON.stringify(snapshot)]
  );

  // 2. Upsert Organiser Fee Account
  const account = (await c.query(
    `INSERT INTO organiser_fee_accounts (
       organiser_id, total_fee_payable_paise, outstanding_balance_paise
     ) VALUES ($1, $2, $2)
     ON CONFLICT (organiser_id) DO UPDATE SET
       total_fee_payable_paise = organiser_fee_accounts.total_fee_payable_paise + EXCLUDED.total_fee_payable_paise,
       outstanding_balance_paise = (organiser_fee_accounts.total_fee_payable_paise + EXCLUDED.total_fee_payable_paise)
                                  - organiser_fee_accounts.total_fee_paid_paise
                                  - organiser_fee_accounts.total_fee_reversal_paise,
       status = CASE
         WHEN (organiser_fee_accounts.total_fee_payable_paise + EXCLUDED.total_fee_payable_paise)
              - organiser_fee_accounts.total_fee_paid_paise
              - organiser_fee_accounts.total_fee_reversal_paise <= 0 THEN 'settled'
         ELSE 'active'
       END,
       updated_at = now()
     RETURNING *`,
    [organiserId, calc.feePaise]
  )).rows[0];

  // 3. Insert Infrastructure Fee Entry (Unique on booking_id prevents duplicate entry)
  const feeEntry = (await c.query(
    `INSERT INTO infrastructure_fee_entries (
       account_id, organiser_id, event_id, booking_id, ticket_type_id,
       base_amount_paise, fee_percentage, fee_amount_paise, total_collected_paise,
       rule_id, calculation_snapshot, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'accrued')
     ON CONFLICT (booking_id) DO UPDATE SET
       updated_at = now()
     RETURNING *`,
    [
      account.id,
      organiserId,
      event.id,
      booking.id,
      tier.id,
      calc.basePaise,
      feePct,
      calc.feePaise,
      calc.totalPaise,
      activeRule.id,
      JSON.stringify(snapshot)
    ]
  )).rows[0];

  // 4. Find or Create Organiser Fee Invoice for this event settlement
  let invoice = (await c.query(
    `SELECT * FROM organiser_fee_invoices
     WHERE event_id = $1 AND status IN ('pending', 'payment_submitted', 'under_verification', 'partially_settled')
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [event.id]
  )).rows[0];

  const defaultDueDate = event.infrastructure_fee_deadline
    ? new Date(event.infrastructure_fee_deadline)
    : (event.start_at ? new Date(event.start_at) : new Date(Date.now() + 7 * 864e5));

  if (!invoice) {
    const invNumber = generateInvoiceNumber(event.slug || '');
    const payRef = generatePaymentReference();
    invoice = (await c.query(
      `INSERT INTO organiser_fee_invoices (
         invoice_number, payment_reference, account_id, organiser_id, event_id,
         billing_period_start, billing_period_end, due_date,
         tickets_count, gross_ticket_value_paise, fee_amount_paise,
         net_fee_payable_paise, outstanding_amount_paise, status
       ) VALUES ($1, $2, $3, $4, $5, now(), now(), $6, $7, $8, $9, $9, $9, 'pending')
       RETURNING *`,
      [
        invNumber,
        payRef,
        account.id,
        organiserId,
        event.id,
        defaultDueDate.toISOString(),
        qty,
        calc.basePaise,
        calc.feePaise
      ]
    )).rows[0];
  } else {
    invoice = (await c.query(
      `UPDATE organiser_fee_invoices SET
         tickets_count = tickets_count + $2,
         gross_ticket_value_paise = gross_ticket_value_paise + $3,
         fee_amount_paise = fee_amount_paise + $4,
         net_fee_payable_paise = net_fee_payable_paise + $4,
         outstanding_amount_paise = net_fee_payable_paise + $4 - amount_paid_paise - reversals_paise,
         billing_period_end = now(),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [invoice.id, qty, calc.basePaise, calc.feePaise]
    )).rows[0];
  }

  // 5. Add invoice line
  await c.query(
    `INSERT INTO organiser_fee_invoice_lines (
       invoice_id, fee_entry_id, description, quantity,
       base_amount_paise, rate_percent, line_total_paise
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      invoice.id,
      feeEntry.id,
      `${tier.name} — ${qty} ticket${qty === 1 ? '' : 's'} (5% platform fee)`,
      qty,
      calc.basePaise,
      feePct,
      calc.feePaise
    ]
  );

  // 6. Record in audit logs
  await c.query(
    `INSERT INTO finance_audit_logs (
       entity_type, entity_id, action, actor_type, actor_id, after_state, notes
     ) VALUES ('fee_entry', $1, 'entry_accrued', 'system', $2, $3, $4)`,
    [
      feeEntry.id,
      booking.user_id ? `user:${booking.user_id}` : 'system',
      JSON.stringify(snapshot),
      `Infrastructure fee of ₹${(calc.feePaise / 100).toFixed(2)} accrued for booking ${booking.id}`
    ]
  );

  return { feeEntry, account, invoice, calculation: calc };
}

/**
 * Reverses or adjusts an infrastructure fee entry upon booking cancellation or refund.
 * Generates an approved credit note and updates the invoice and account balances.
 */
export async function reverseBookingFeeEntry(bookingId, { reason = 'Booking cancelled / refunded', adminUser = null, actor = 'system' } = {}, c = db) {
  const feeEntry = (await c.query(
    `SELECT * FROM infrastructure_fee_entries WHERE booking_id = $1 FOR UPDATE`,
    [bookingId]
  )).rows[0];

  if (!feeEntry || feeEntry.status === 'reversed') {
    return null; // No entry or already reversed
  }

  const creditNoteNum = generateCreditNoteNumber();

  // 1. Create Credit Note / Adjustment
  const adjustment = (await c.query(
    `INSERT INTO infrastructure_fee_adjustments (
       credit_note_number, account_id, organiser_id, event_id,
       fee_entry_id, booking_id, amount_paise, adjustment_type, reason,
       status, approved_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'refund_reversal', $8, 'approved',
       COALESCE($9, (SELECT id FROM admin_users WHERE role = 'super_admin' AND active LIMIT 1))
     ) RETURNING *`,
    [
      creditNoteNum,
      feeEntry.account_id,
      feeEntry.organiser_id,
      feeEntry.event_id,
      feeEntry.id,
      bookingId,
      feeEntry.fee_amount_paise,
      reason,
      adminUser?.id || null
    ]
  )).rows[0];

  // 2. Mark fee entry as reversed
  await c.query(
    `UPDATE infrastructure_fee_entries SET status = 'reversed', updated_at = now() WHERE id = $1`,
    [feeEntry.id]
  );

  // 3. Update Organiser Fee Account
  if (feeEntry.account_id) {
    await c.query(
      `UPDATE organiser_fee_accounts SET
         total_fee_reversal_paise = total_fee_reversal_paise + $2,
         outstanding_balance_paise = total_fee_payable_paise - total_fee_paid_paise - (total_fee_reversal_paise + $2),
         status = CASE
           WHEN total_fee_payable_paise - total_fee_paid_paise - (total_fee_reversal_paise + $2) <= 0 THEN 'settled'
           ELSE status
         END,
         updated_at = now()
       WHERE id = $1`,
      [feeEntry.account_id, feeEntry.fee_amount_paise]
    );
  }

  // 4. Update Organiser Fee Invoice
  const invoice = (await c.query(
    `SELECT * FROM organiser_fee_invoices
     WHERE event_id = $1 AND status NOT IN ('cancelled')
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [feeEntry.event_id]
  )).rows[0];

  if (invoice) {
    await c.query(
      `UPDATE organiser_fee_invoices SET
         reversals_paise = reversals_paise + $2,
         outstanding_amount_paise = GREATEST(0, net_fee_payable_paise - amount_paid_paise - (reversals_paise + $2)),
         status = CASE
           WHEN net_fee_payable_paise - amount_paid_paise - (reversals_paise + $2) <= 0 THEN 'fully_settled'
           ELSE status
         END,
         updated_at = now()
       WHERE id = $1`,
      [invoice.id, feeEntry.fee_amount_paise]
    );
  }

  // 5. Audit Log
  await c.query(
    `INSERT INTO finance_audit_logs (
       entity_type, entity_id, action, actor_type, actor_id, after_state, notes
     ) VALUES ('credit_note', $1, 'fee_reversed', $2, $3, $4, $5)`,
    [
      adjustment.id,
      adminUser ? 'admin' : 'system',
      adminUser?.id || actor,
      JSON.stringify(adjustment),
      `Infrastructure fee reversal of ₹${(feeEntry.fee_amount_paise / 100).toFixed(2)}: ${reason}`
    ]
  );

  return { feeEntry, adjustment };
}

/**
 * Organiser submits a payment claim.
 * IMPORTANT: This is a submission claim only; it does NOT clear the outstanding balance.
 */
export async function submitFeePayment({
  organiserId,
  invoiceId = null,
  paymentReference = null,
  amountPaise,
  utrNumber,
  payerUpiId = null,
  notes = '',
  screenshotUrl = null
}, c = db) {
  const amt = parseInt(amountPaise, 10);
  if (isNaN(amt) || amt <= 0) {
    throw new HttpError(400, 'validation', 'Submitted amount must be greater than zero');
  }

  const cleanUtr = String(utrNumber || '').trim();
  if (!isValidUtr(cleanUtr)) {
    throw new HttpError(400, 'validation', 'Please enter a valid 12-character bank UTR reference number');
  }

  let cleanScreenshotUrl = null;
  if (screenshotUrl) {
    cleanScreenshotUrl = String(screenshotUrl).trim();
    if (!isValidEvidenceUrl(cleanScreenshotUrl)) {
      throw new HttpError(400, 'validation', 'Invalid screenshot URL: only HTTPS or safe upload paths are permitted');
    }
  }

  return c.tx(async (tx) => {
    // 1. Prevent duplicate UTR
    const dupSubmission = (await tx.query(
      `SELECT id, status FROM organiser_fee_payment_submissions WHERE utr_number = $1`,
      [cleanUtr]
    )).rows[0];
    if (dupSubmission) {
      throw new HttpError(409, 'duplicate_utr', `A payment claim with UTR "${cleanUtr}" has already been submitted.`);
    }

    const dupBank = (await tx.query(
      `SELECT id FROM nightlifez_bank_transactions WHERE utr_number = $1`,
      [cleanUtr]
    )).rows[0];
    if (dupBank) {
      throw new HttpError(409, 'duplicate_utr', `A bank credit with UTR "${cleanUtr}" is already recorded in the system.`);
    }

    // 2. Fetch invoice if given or resolve by paymentReference
    let inv = null;
    if (invoiceId) {
      inv = (await tx.query(
        `SELECT * FROM organiser_fee_invoices WHERE id = $1 AND organiser_id = $2`,
        [invoiceId, organiserId]
      )).rows[0];
      if (!inv) {
        throw new HttpError(404, 'invoice_not_found', 'Invoice not found or does not belong to this organiser');
      }
    } else if (paymentReference) {
      inv = (await tx.query(
        `SELECT * FROM organiser_fee_invoices WHERE payment_reference = $1 AND organiser_id = $2`,
        [paymentReference, organiserId]
      )).rows[0];
      if (!inv) {
        throw new HttpError(404, 'invoice_not_found', 'Payment reference not found or does not belong to this organiser');
      }
    }

    const ref = inv?.payment_reference || paymentReference || generatePaymentReference();

    // 3. Fetch account
    const account = (await tx.query(
      `SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`,
      [organiserId]
    )).rows[0];

    // 4. Insert submission
    const submission = (await tx.query(
      `INSERT INTO organiser_fee_payment_submissions (
         account_id, organiser_id, invoice_id, payment_reference,
         amount_paise, utr_number, payer_upi_id, submission_notes,
         screenshot_url, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'submitted')
       RETURNING *`,
      [
        account?.id || null,
        organiserId,
        inv?.id || null,
        ref,
        amt,
        cleanUtr,
        payerUpiId ? String(payerUpiId).trim() : null,
        notes ? String(notes).trim() : null,
        cleanScreenshotUrl
      ]
    )).rows[0];

    // 5. Update invoice status to 'under_verification' (Outstanding balance is UNCHANGED)
    if (inv) {
      await tx.query(
        `UPDATE organiser_fee_invoices SET
           status = CASE WHEN status = 'pending' THEN 'under_verification' ELSE status END,
           updated_at = now()
         WHERE id = $1`,
        [inv.id]
      );
    }

    // 6. Record audit log
    await tx.query(
      `INSERT INTO finance_audit_logs (
         entity_type, entity_id, action, actor_type, actor_id, after_state, notes
       ) VALUES ('payment_submission', $1, 'payment_submitted', 'organiser', $2, $3, $4)`,
      [
        submission.id,
        `user:${organiserId}`,
        JSON.stringify({ id: submission.id, utrNumber: cleanUtr, amountPaise: amt, paymentReference: ref }),
        `Payment claim of ₹${(amt / 100).toFixed(2)} submitted with UTR ${cleanUtr}. Pending bank verification.`
      ]
    );

    return {
      submission,
      message: 'Payment claim submitted. Our finance team will verify the bank transaction before clearing the balance.'
    };
  });
}

/**
 * Admin confirms receipt of organiser fee payment after verifying the incoming bank credit.
 * ONLY finance or super_admin roles can confirm payments.
 * Clears the outstanding balance ONLY for the verified amount.
 */
export async function confirmFeePayment({
  submissionId,
  bankTxId,
  verifiedAmountPaise = null,
  notes = '',
  adminUser,
  allocations = []
}, c = db) {
  const verifiedAdmin = await assertFinanceAuthorization(adminUser, c);

  const cleanBankTxId = String(bankTxId || '').trim();
  if (!cleanBankTxId || cleanBankTxId.length < 4) {
    throw new HttpError(400, 'validation', 'A valid bank transaction ID is required for verification');
  }

  return c.tx(async (tx) => {
    // 1. Fetch submission and lock row
    const submission = (await tx.query(
      `SELECT s.*, i.outstanding_amount_paise, i.net_fee_payable_paise, i.event_id
       FROM organiser_fee_payment_submissions s
       LEFT JOIN organiser_fee_invoices i ON i.id = s.invoice_id
       WHERE s.id = $1
       FOR UPDATE OF s`,
      [submissionId]
    )).rows[0];

    if (!submission) {
      throw new HttpError(404, 'not_found', 'Payment submission not found');
    }

    if (submission.status === 'verified') {
      throw new HttpError(409, 'already_verified', 'This payment submission has already been verified and confirmed');
    }

    if (submission.status === 'rejected') {
      throw new HttpError(409, 'already_rejected', 'Cannot confirm a rejected payment submission');
    }

    const verifiedPaise = verifiedAmountPaise !== null && verifiedAmountPaise !== undefined
      ? parseInt(verifiedAmountPaise, 10)
      : submission.amount_paise;

    if (isNaN(verifiedPaise) || verifiedPaise <= 0) {
      throw new HttpError(400, 'validation', 'Verified amount must be greater than zero');
    }

    // 2. Fetch or create Bank Transaction
    let bankTx = (await tx.query(
      `SELECT * FROM nightlifez_bank_transactions WHERE bank_tx_id = $1 FOR UPDATE`,
      [cleanBankTxId]
    )).rows[0];

    if (!bankTx) {
      // Check duplicate UTR on bank transactions
      const dupBankUtr = (await tx.query(
        `SELECT id FROM nightlifez_bank_transactions WHERE utr_number = $1`,
        [submission.utr_number]
      )).rows[0];

      if (dupBankUtr) {
        throw new HttpError(409, 'duplicate_bank_transaction', `Bank transaction with UTR "${submission.utr_number}" already exists.`);
      }

      bankTx = (await tx.query(
        `INSERT INTO nightlifez_bank_transactions (
           bank_tx_id, utr_number, amount_paise, allocated_amount_paise,
           unallocated_amount_paise, payer_vpa, verification_notes, verified_by, status
         ) VALUES ($1, $2, $3, 0, $3, $4, $5, $6, 'unallocated')
         RETURNING *`,
        [
          cleanBankTxId,
          submission.utr_number,
          verifiedPaise,
          submission.payer_upi_id,
          notes,
          verifiedAdmin.id
        ]
      )).rows[0];
    }

    // 3. Invariant: One bank credit must never be allocated to multiple invoices beyond its actual amount
    if (bankTx.unallocated_amount_paise < verifiedPaise) {
      throw new HttpError(409, 'insufficient_bank_credit',
        `Bank transaction ${cleanBankTxId} only has ₹${(bankTx.unallocated_amount_paise / 100).toFixed(2)} unallocated, but ₹${(verifiedPaise / 100).toFixed(2)} was requested.`
      );
    }

    // 4. Resolve Invoices for Allocation
    const allocationPlan = [];
    if (Array.isArray(allocations) && allocations.length > 0) {
      let sum = 0;
      for (const a of allocations) {
        const amt = parseInt(a.amountPaise, 10);
        if (isNaN(amt) || amt <= 0) throw new HttpError(400, 'validation', 'Allocation amounts must be positive');
        sum += amt;
        allocationPlan.push({ invoiceId: a.invoiceId, amountPaise: amt });
      }
      if (sum !== verifiedPaise) {
        throw new HttpError(400, 'validation', `Allocation breakdown (₹${(sum / 100).toFixed(2)}) must match verified total (₹${(verifiedPaise / 100).toFixed(2)})`);
      }
    } else if (submission.invoice_id) {
      allocationPlan.push({ invoiceId: submission.invoice_id, amountPaise: verifiedPaise });
    } else {
      // Allocate to oldest pending invoice of this organiser
      const openInvoices = (await tx.query(
        `SELECT id, outstanding_amount_paise FROM organiser_fee_invoices
         WHERE organiser_id = $1 AND outstanding_amount_paise > 0
         ORDER BY due_date ASC
         FOR UPDATE`,
        [submission.organiser_id]
      )).rows;

      let remaining = verifiedPaise;
      for (const inv of openInvoices) {
        if (remaining <= 0) break;
        const alloc = Math.min(remaining, inv.outstanding_amount_paise);
        allocationPlan.push({ invoiceId: inv.id, amountPaise: alloc });
        remaining -= alloc;
      }

      if (remaining > 0) {
        throw new HttpError(400, 'excess_allocation', `Verified amount exceeds total outstanding balance across invoices by ₹${(remaining / 100).toFixed(2)}`);
      }
    }

    // 5. Execute Invoice Allocations
    const receiptNumbers = [];
    for (const alloc of allocationPlan) {
      const inv = (await tx.query(
        `SELECT * FROM organiser_fee_invoices WHERE id = $1 FOR UPDATE`,
        [alloc.invoiceId]
      )).rows[0];

      if (!inv) throw new HttpError(404, 'invoice_not_found', `Invoice ${alloc.invoiceId} not found`);

      if (inv.organiser_id !== submission.organiser_id) {
        throw new HttpError(400, 'cross_organiser_allocation', `Invoice ${inv.invoice_number} does not belong to the payment organiser`);
      }

      if (inv.status === 'cancelled') {
        throw new HttpError(400, 'invalid_invoice_status', `Cannot allocate payment to cancelled invoice ${inv.invoice_number}`);
      }

      if (alloc.amountPaise > inv.outstanding_amount_paise) {
        throw new HttpError(400, 'excess_allocation', `Allocation of ₹${(alloc.amountPaise / 100).toFixed(2)} exceeds invoice ${inv.invoice_number} outstanding amount of ₹${(inv.outstanding_amount_paise / 100).toFixed(2)}`);
      }

      const receiptNum = generateReceiptNumber();
      receiptNumbers.push(receiptNum);

      // Insert Allocation
      await tx.query(
        `INSERT INTO organiser_fee_payment_allocations (
           bank_transaction_id, submission_id, invoice_id,
           allocated_amount_paise, receipt_number, allocated_by, allocation_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          bankTx.id,
          submission.id,
          inv.id,
          alloc.amountPaise,
          receiptNum,
          verifiedAdmin.id,
          notes
        ]
      );

      // Update Invoice
      const newPaid = inv.amount_paid_paise + alloc.amountPaise;
      const newOutstanding = Math.max(0, inv.net_fee_payable_paise - newPaid - inv.reversals_paise);
      const newStatus = newOutstanding === 0 ? 'fully_settled' : 'partially_settled';

      await tx.query(
        `UPDATE organiser_fee_invoices SET
           amount_paid_paise = $2,
           outstanding_amount_paise = $3,
           status = $4,
           updated_at = now()
         WHERE id = $1`,
        [inv.id, newPaid, newOutstanding, newStatus]
      );
    }

    // 6. Update Bank Transaction
    const newAllocated = bankTx.allocated_amount_paise + verifiedPaise;
    const newUnallocated = bankTx.amount_paise - newAllocated;
    const newBankStatus = newUnallocated === 0 ? 'fully_allocated' : 'partially_allocated';

    await tx.query(
      `UPDATE nightlifez_bank_transactions SET
         allocated_amount_paise = $2,
         unallocated_amount_paise = $3,
         status = $4,
         updated_at = now()
       WHERE id = $1`,
      [bankTx.id, newAllocated, newUnallocated, newBankStatus]
    );

    // 7. Update Organiser Fee Account
    const acc = (await tx.query(
      `UPDATE organiser_fee_accounts SET
         total_fee_paid_paise = total_fee_paid_paise + $2,
         outstanding_balance_paise = total_fee_payable_paise - (total_fee_paid_paise + $2) - total_fee_reversal_paise,
         status = CASE
           WHEN total_fee_payable_paise - (total_fee_paid_paise + $2) - total_fee_reversal_paise <= 0 THEN 'settled'
           ELSE 'active'
         END,
         last_settled_at = now(),
         updated_at = now()
       WHERE organiser_id = $1
       RETURNING *`,
      [submission.organiser_id, verifiedPaise]
    )).rows[0];

    // 8. Update Payment Submission status
    const verifiedSub = (await tx.query(
      `UPDATE organiser_fee_payment_submissions SET
         status = 'verified',
         verified_by = $2,
         verified_at = now(),
         bank_transaction_id = $3,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [submission.id, verifiedAdmin.id, bankTx.id]
    )).rows[0];

    // 9. Immutable Audit Log
    await tx.query(
      `INSERT INTO finance_audit_logs (
         entity_type, entity_id, action, actor_type, actor_id, before_state, after_state, notes
       ) VALUES ('payment_submission', $1, 'payment_confirmed', 'admin', $2, $3, $4, $5)`,
      [
        submission.id,
        verifiedAdmin.id,
        JSON.stringify(submission),
        JSON.stringify({ verifiedSub, receiptNumbers, verifiedPaise, bankTxId: cleanBankTxId }),
        `Payment of ₹${(verifiedPaise / 100).toFixed(2)} verified against bank credit ${cleanBankTxId}. Receipts: ${receiptNumbers.join(', ')}`
      ]
    );

    return {
      submission: verifiedSub,
      receiptNumbers,
      verifiedAmountPaise: verifiedPaise,
      outstandingBalancePaise: acc ? acc.outstanding_balance_paise : 0
    };
  });
}

/**
 * Admin rejects a payment claim with a mandatory reason.
 * The outstanding balance remains unchanged.
 */
export async function rejectFeePayment({ submissionId, reason, adminUser }, c = db) {
  const verifiedAdmin = await assertFinanceAuthorization(adminUser, c);

  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length < 5) {
    throw new HttpError(400, 'validation', 'A mandatory rejection reason (at least 5 characters) is required');
  }

  return c.tx(async (tx) => {
    const sub = (await tx.query(
      `SELECT * FROM organiser_fee_payment_submissions WHERE id = $1 FOR UPDATE`,
      [submissionId]
    )).rows[0];

    if (!sub) {
      throw new HttpError(404, 'not_found', 'Payment submission not found');
    }

    if (sub.status === 'verified') {
      throw new HttpError(409, 'already_verified', 'Cannot reject an already confirmed and verified payment');
    }

    if (sub.status === 'rejected') {
      throw new HttpError(409, 'already_rejected', 'This payment submission has already been rejected');
    }

    const updated = (await tx.query(
      `UPDATE organiser_fee_payment_submissions SET
         status = 'rejected',
         rejection_reason = $2,
         rejected_by = $3,
         rejected_at = now(),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [submissionId, cleanReason, verifiedAdmin.id]
    )).rows[0];

    // Update invoice status if under verification
    if (sub.invoice_id) {
      await tx.query(
        `UPDATE organiser_fee_invoices SET
           status = CASE WHEN status = 'under_verification' THEN 'rejected' ELSE status END,
           updated_at = now()
         WHERE id = $1`,
        [sub.invoice_id]
      );
    }

    // Audit log
    await tx.query(
      `INSERT INTO finance_audit_logs (
         entity_type, entity_id, action, actor_type, actor_id, before_state, after_state, notes
       ) VALUES ('payment_submission', $1, 'payment_rejected', 'admin', $2, $3, $4, $5)`,
      [
        sub.id,
        verifiedAdmin.id,
        JSON.stringify(sub),
        JSON.stringify(updated),
        `Payment claim rejected: ${cleanReason}`
      ]
    );

    return { submission: updated };
  });
}

/**
 * Admin marks a payment submission for further investigation.
 */
export async function investigateFeePayment({ submissionId, notes, adminUser }, c = db) {
  const verifiedAdmin = await assertFinanceAuthorization(adminUser, c);

  const cleanNotes = String(notes || '').trim();
  if (!cleanNotes) {
    throw new HttpError(400, 'validation', 'Investigation notes are required');
  }

  return c.tx(async (tx) => {
    const sub = (await tx.query(
      `SELECT * FROM organiser_fee_payment_submissions WHERE id = $1 FOR UPDATE`,
      [submissionId]
    )).rows[0];

    if (!sub) {
      throw new HttpError(404, 'not_found', 'Payment submission not found');
    }

    if (sub.status === 'verified') {
      throw new HttpError(409, 'already_verified', 'Cannot investigate an already verified and settled payment');
    }

    if (sub.status === 'rejected') {
      throw new HttpError(409, 'already_rejected', 'Cannot investigate an already rejected payment');
    }

    const updated = (await tx.query(
      `UPDATE organiser_fee_payment_submissions SET
         status = 'under_investigation',
         investigation_notes = $2,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [submissionId, cleanNotes]
    )).rows[0];

    await tx.query(
      `INSERT INTO finance_audit_logs (
         entity_type, entity_id, action, actor_type, actor_id, after_state, notes
       ) VALUES ('payment_submission', $1, 'marked_for_investigation', 'admin', $2, $3, $4)`,
      [
        sub.id,
        verifiedAdmin.id,
        JSON.stringify(updated),
        `Payment marked for investigation: ${cleanNotes}`
      ]
    );

    return { submission: updated };
  });
}

/**
 * Extends the infrastructure fee payment deadline for an event.
 */
export async function extendPaymentDeadline({ eventId, newDeadline, reason, adminUser }, c = db) {
  const verifiedAdmin = await assertFinanceAuthorization(adminUser, c);

  const parsedDeadline = new Date(newDeadline);
  if (isNaN(parsedDeadline.getTime())) {
    throw new HttpError(400, 'validation', 'Invalid deadline timestamp');
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason || cleanReason.length < 5) {
    throw new HttpError(400, 'validation', 'A reason of at least 5 characters is required for deadline extension');
  }

  return c.tx(async (tx) => {
    const event = (await tx.query(
      `SELECT id, title, infrastructure_fee_deadline FROM events WHERE id = $1 FOR UPDATE`,
      [eventId]
    )).rows[0];

    if (!event) throw new HttpError(404, 'not_found', 'Event not found');

    const updated = (await tx.query(
      `UPDATE events SET
         infrastructure_fee_deadline = $2,
         infrastructure_fee_extension_granted_by = $3,
         infrastructure_fee_extension_reason = $4,
         updated_at = now()
       WHERE id = $1
       RETURNING id, title, infrastructure_fee_deadline`,
      [eventId, parsedDeadline.toISOString(), verifiedAdmin.id, cleanReason]
    )).rows[0];

    // Update invoice due dates
    await tx.query(
      `UPDATE organiser_fee_invoices SET
         due_date = $2,
         status = CASE WHEN status = 'overdue' THEN 'pending' ELSE status END,
         updated_at = now()
       WHERE event_id = $1 AND status != 'cancelled'`,
      [eventId, parsedDeadline.toISOString()]
    );

    await tx.query(
      `INSERT INTO finance_audit_logs (
         entity_type, entity_id, action, actor_type, actor_id, before_state, after_state, notes
       ) VALUES ('event', $1, 'fee_deadline_extended', 'admin', $2, $3, $4, $5)`,
      [
        eventId,
        verifiedAdmin.id,
        JSON.stringify({ deadline: event.infrastructure_fee_deadline }),
        JSON.stringify(updated),
        `Fee deadline extended to ${parsedDeadline.toISOString()}: ${cleanReason}`
      ]
    );

    return updated;
  });
}

/**
 * Computes event-wise accounting and summary for an organiser.
 */
export async function getOrganiserFinanceSummary(organiserId, c = db) {
  // 1. Account details
  let account = (await c.query(
    `SELECT * FROM organiser_fee_accounts WHERE organiser_id = $1`,
    [organiserId]
  )).rows[0];

  if (!account) {
    account = {
      total_fee_payable_paise: 0,
      total_fee_paid_paise: 0,
      total_fee_reversal_paise: 0,
      outstanding_balance_paise: 0,
      status: 'active'
    };
  }

  // 2. Event-wise breakdown
  const events = (await c.query(
    `SELECT
       e.id AS event_id,
       e.title AS event_title,
       e.slug AS event_slug,
       e.start_at,
       e.infrastructure_fee_deadline,
       COALESCE(SUM(b.quantity), 0)::int AS tickets_sold,
       COALESCE(SUM(b.base_price_paise), 0)::bigint AS organiser_base_revenue_paise,
       COALESCE(SUM(fe.fee_amount_paise), 0)::bigint AS total_fee_payable_paise,
       COALESCE(SUM(CASE WHEN fe.status = 'reversed' THEN fe.fee_amount_paise ELSE 0 END), 0)::bigint AS refunds_adjustments_paise,
       COALESCE(inv.amount_paid_paise, 0)::bigint AS fee_payment_confirmed_paise,
       GREATEST(0, COALESCE(SUM(fe.fee_amount_paise), 0)::bigint
                  - COALESCE(inv.amount_paid_paise, 0)::bigint
                  - COALESCE(SUM(CASE WHEN fe.status = 'reversed' THEN fe.fee_amount_paise ELSE 0 END), 0)::bigint
       )::bigint AS outstanding_paise,
       COALESCE(inv.status, 'pending') AS settlement_status,
       inv.id AS invoice_id,
       inv.invoice_number,
       inv.payment_reference,
       inv.due_date
     FROM events e
     LEFT JOIN bookings b ON b.event_id = e.id AND b.status IN ('confirmed', 'checked_in')
     LEFT JOIN infrastructure_fee_entries fe ON fe.booking_id = b.id
     LEFT JOIN organiser_fee_invoices inv ON inv.event_id = e.id
     WHERE e.organiser_user_id = $1
     GROUP BY e.id, e.title, e.slug, e.start_at, e.infrastructure_fee_deadline, inv.id, inv.amount_paid_paise, inv.status, inv.invoice_number, inv.payment_reference, inv.due_date
     ORDER BY e.start_at DESC`,
    [organiserId]
  )).rows;

  const now = new Date();
  const eventSummaries = events.map((ev) => {
    const isOverdue = ev.outstanding_paise > 0 && ev.due_date && new Date(ev.due_date) < now;
    let labelStatus = ev.settlement_status;
    if (isOverdue) labelStatus = 'overdue';
    else if (ev.settlement_status === 'under_verification') labelStatus = 'under_admin_verification';

    return {
      eventId: ev.event_id,
      eventTitle: ev.event_title,
      eventSlug: ev.event_slug,
      ticketsSold: ev.tickets_sold,
      organiserRevenuePaise: ev.organiser_base_revenue_paise,
      infrastructureFeePaise: ev.total_fee_payable_paise,
      refundsAdjustmentsPaise: ev.refunds_adjustments_paise,
      totalFeePayablePaise: ev.total_fee_payable_paise,
      amountAlreadyPaidPaise: ev.fee_payment_confirmed_paise,
      outstandingPaise: ev.outstanding_paise,
      settlementStatus: labelStatus,
      invoiceId: ev.invoice_id,
      invoiceNumber: ev.invoice_number,
      paymentReference: ev.payment_reference,
      dueDate: ev.due_date,
      isOverdue
    };
  });

  // 3. Submissions History
  const submissions = (await c.query(
    `SELECT
       s.id,
       s.payment_reference,
       s.amount_paise,
       s.utr_number,
       s.payer_upi_id,
       s.status,
       s.submission_notes,
       s.screenshot_url,
       s.rejection_reason,
       s.created_at,
       s.verified_at,
       i.invoice_number,
       e.title AS event_title
     FROM organiser_fee_payment_submissions s
     LEFT JOIN organiser_fee_invoices i ON i.id = s.invoice_id
     LEFT JOIN events e ON e.id = i.event_id
     WHERE s.organiser_id = $1
     ORDER BY s.created_at DESC`,
    [organiserId]
  )).rows;

  return {
    account: {
      totalFeePayablePaise: Number(account.total_fee_payable_paise),
      totalFeePaidPaise: Number(account.total_fee_paid_paise),
      totalFeeReversalPaise: Number(account.total_fee_reversal_paise),
      outstandingBalancePaise: Number(account.outstanding_balance_paise),
      status: account.status
    },
    events: eventSummaries,
    submissions,
    platformUpi: {
      vpa: getPlatformFinanceUpi(),
      name: getPlatformFinanceName(),
      instructions: [
        '1. Transfer the exact fee amount via UPI or Net Banking to our official NIGHTLIFEZ UPI ID.',
        '2. Add your unique Payment Reference in the transaction remarks/notes.',
        '3. Enter the 12-digit bank UTR reference number below and submit your claim.',
        '4. Our finance team verifies the incoming credit with our bank before marking the invoice settled.'
      ]
    }
  };
}

/**
 * Central Finance Management Overview for NIGHTLIFEZ Finance Administrators.
 */
export async function getAdminFinanceOverview(filters = {}, c = db) {
  const { organiserId, eventId, status, minOutstanding } = filters;

  // 1. Aggregated Platform Metrics
  const metrics = (await c.query(
    `SELECT
       COALESCE(SUM(gross_ticket_value_paise), 0)::bigint AS gross_ticket_value_paise,
       COALESCE(SUM(fee_amount_paise), 0)::bigint AS total_fees_earned_paise,
       COALESCE(SUM(amount_paid_paise), 0)::bigint AS confirmed_payments_paise,
       COALESCE(SUM(outstanding_amount_paise), 0)::bigint AS outstanding_balances_paise,
       COALESCE(SUM(reversals_paise), 0)::bigint AS refund_adjustment_totals_paise,
       COALESCE(SUM(CASE WHEN due_date < now() AND outstanding_amount_paise > 0 THEN outstanding_amount_paise ELSE 0 END), 0)::bigint AS overdue_balances_paise
     FROM organiser_fee_invoices`
  )).rows[0];

  const pendingSubmissionsCount = (await c.query(
    `SELECT
       COUNT(*)::int AS count,
       COALESCE(SUM(amount_paise), 0)::bigint AS total_paise
     FROM organiser_fee_payment_submissions
     WHERE status IN ('submitted', 'under_investigation')`
  )).rows[0];

  // 2. Filtered Invoices and Organisers
  const whereClauses = [];
  const params = [];

  if (organiserId) {
    params.push(organiserId);
    whereClauses.push(`i.organiser_id = $${params.length}`);
  }
  if (eventId) {
    params.push(eventId);
    whereClauses.push(`i.event_id = $${params.length}`);
  }
  if (status && status !== 'all') {
    params.push(status);
    whereClauses.push(`i.status = $${params.length}`);
  }
  if (minOutstanding) {
    params.push(parseInt(minOutstanding, 10));
    whereClauses.push(`i.outstanding_amount_paise >= $${params.length}`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const invoices = (await c.query(
    `SELECT
       i.*,
       u.alias AS organiser_alias,
       u.telegram_user_id AS organiser_tg_id,
       e.title AS event_title,
       e.slug AS event_slug,
       e.start_at AS event_start_at
     FROM organiser_fee_invoices i
     JOIN users u ON u.id = i.organiser_id
     JOIN events e ON e.id = i.event_id
     ${whereSql}
     ORDER BY i.created_at DESC
     LIMIT 200`,
    params
  )).rows;

  return {
    kpis: {
      grossTicketValuePaise: Number(metrics.gross_ticket_value_paise),
      totalFeesEarnedPaise: Number(metrics.total_fees_earned_paise),
      confirmedPaymentsPaise: Number(metrics.confirmed_payments_paise),
      outstandingBalancesPaise: Number(metrics.outstanding_balances_paise),
      overdueBalancesPaise: Number(metrics.overdue_balances_paise),
      refundAdjustmentTotalsPaise: Number(metrics.refund_adjustment_totals_paise),
      paymentsAwaitingVerificationPaise: Number(pendingSubmissionsCount.total_paise),
      pendingVerificationCount: pendingSubmissionsCount.count
    },
    invoices
  };
}

/**
 * Verification queue for admin review of organiser payment claims.
 */
export async function getVerificationQueue(filters = {}, c = db) {
  const { status = 'pending', organiserId, eventId } = filters;

  const whereClauses = [];
  const params = [];

  if (status === 'pending') {
    whereClauses.push(`s.status IN ('submitted', 'under_investigation')`);
  } else if (status && status !== 'all') {
    params.push(status);
    whereClauses.push(`s.status = $${params.length}`);
  }

  if (organiserId) {
    params.push(organiserId);
    whereClauses.push(`s.organiser_id = $${params.length}`);
  }
  if (eventId) {
    params.push(eventId);
    whereClauses.push(`i.event_id = $${params.length}`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const queue = (await c.query(
    `SELECT
       s.*,
       u.alias AS organiser_alias,
       u.telegram_user_id AS organiser_tg_id,
       i.invoice_number,
       i.outstanding_amount_paise AS outstanding_before_confirmation_paise,
       e.title AS event_title,
       e.id AS event_id,
       bt.bank_tx_id,
       admin.telegram_user_id AS verified_by_tg_id
     FROM organiser_fee_payment_submissions s
     JOIN users u ON u.id = s.organiser_id
     LEFT JOIN organiser_fee_invoices i ON i.id = s.invoice_id
     LEFT JOIN events e ON e.id = i.event_id
     LEFT JOIN nightlifez_bank_transactions bt ON bt.id = s.bank_transaction_id
     LEFT JOIN admin_users admin ON admin.id = s.verified_by
     ${whereSql}
     ORDER BY s.created_at ASC
     LIMIT 100`,
    params
  )).rows;

  return queue;
}

/**
 * Generates an event-wise financial statement CSV for an organiser.
 */
export async function generateOrganiserStatementCsv(organiserId, c = db) {
  const data = await getOrganiserFinanceSummary(organiserId, c);

  const lines = [
    'Event ID,Event Title,Status,Tickets Sold,Gross Ticket Value (INR),Infrastructure Fee (5%) (INR),Refunds & Adjustments (INR),Fee Payment Confirmed (INR),Outstanding to NIGHTLIFEZ (INR),Payment Reference,Due Date'
  ];

  for (const e of data.events) {
    const row = [
      `"${e.eventId}"`,
      `"${(e.eventTitle || '').replace(/"/g, '""')}"`,
      `"${e.settlementStatus}"`,
      e.ticketsSold,
      (e.organiserRevenuePaise / 100).toFixed(2),
      (e.infrastructureFeePaise / 100).toFixed(2),
      (e.refundsAdjustmentsPaise / 100).toFixed(2),
      (e.amountAlreadyPaidPaise / 100).toFixed(2),
      (e.outstandingPaise / 100).toFixed(2),
      `"${e.paymentReference || ''}"`,
      `"${e.dueDate ? new Date(e.dueDate).toISOString() : ''}"`
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

/**
 * Generates central admin financial accounting CSV.
 */
export async function generateAdminFinanceCsv(c = db) {
  const { invoices } = await getAdminFinanceOverview({}, c);

  const lines = [
    'Invoice Number,Payment Reference,Organiser ID,Organiser Alias,Event ID,Event Title,Tickets Count,Gross Value (INR),Fee Amount (INR),Reversals (INR),Net Payable (INR),Paid (INR),Outstanding (INR),Status,Due Date'
  ];

  for (const inv of invoices) {
    const row = [
      `"${inv.invoice_number}"`,
      `"${inv.payment_reference}"`,
      `"${inv.organiser_id}"`,
      `"${(inv.organiser_alias || '').replace(/"/g, '""')}"`,
      `"${inv.event_id}"`,
      `"${(inv.event_title || '').replace(/"/g, '""')}"`,
      inv.tickets_count,
      (inv.gross_ticket_value_paise / 100).toFixed(2),
      (inv.fee_amount_paise / 100).toFixed(2),
      (inv.reversals_paise / 100).toFixed(2),
      (inv.net_fee_payable_paise / 100).toFixed(2),
      (inv.amount_paid_paise / 100).toFixed(2),
      (inv.outstanding_amount_paise / 100).toFixed(2),
      `"${inv.status}"`,
      `"${inv.due_date ? new Date(inv.due_date).toISOString() : ''}"`
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}
