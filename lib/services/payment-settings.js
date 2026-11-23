// lib/services/payment-settings.js - Organiser UPI and payment settings storage.
// Enforces:
// 1. Strict UPI ID format validation.
// 2. Strict payee name validation.
// 3. Authenticated ownership and cross-tenant isolation (never reveals another organiser's details).
// 4. Persistence across sessions and page refreshes.
// 5. Unverified status by default (no fake verification badges).
// 6. Absolute business rule: UPI settings are stored for future payouts only and NEVER activate paid ticket checkout or live collection.
import { db } from '../db.js';
import { HttpError } from '../http.js';

export const UPI_REGEX = /^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9]{2,64}$/;

let tableEnsured = false;
export async function ensurePaymentSettingsTable(c = db) {
  if (tableEnsured) return;
  await c.query(`
    CREATE TABLE IF NOT EXISTS organiser_payment_settings (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
      org_id          UUID REFERENCES organisations(id) ON DELETE SET NULL,
      upi_id          TEXT NOT NULL,
      payee_name      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'configured', 'verified', 'rejected')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_organiser_payment_settings_user ON organiser_payment_settings(user_id);
    ALTER TABLE business_workspaces ADD COLUMN IF NOT EXISTS upi_id TEXT;
    ALTER TABLE business_workspaces ADD COLUMN IF NOT EXISTS upi_payee_name TEXT;
    ALTER TABLE business_workspaces ADD COLUMN IF NOT EXISTS upi_status TEXT DEFAULT 'unverified';
  `);
  tableEnsured = true;
}

export function validateUpiId(upiId) {
  const clean = String(upiId || '').trim();
  if (!clean) throw new HttpError(400, 'invalid_upi', 'UPI ID is required.');
  if (!UPI_REGEX.test(clean)) {
    throw new HttpError(400, 'invalid_upi_format', 'Invalid UPI ID format. E.g. name@okaxis or business@okhdfcbank.');
  }
  return clean;
}

export function validatePayeeName(name) {
  const clean = String(name || '').trim();
  if (clean.length < 2) {
    throw new HttpError(400, 'invalid_payee_name', 'Account or payee display name must be at least 2 characters.');
  }
  if (clean.length > 100) {
    throw new HttpError(400, 'invalid_payee_name', 'Account or payee display name cannot exceed 100 characters.');
  }
  return clean;
}

export async function getOrganiserPaymentSettings(userId, c = db) {
  await ensurePaymentSettingsTable(c);
  const row = (await c.query(
    `SELECT id, user_id, org_id, upi_id, payee_name, status, created_at, updated_at
       FROM organiser_payment_settings
      WHERE user_id = $1`,
    [userId]
  )).rows[0];

  if (!row) {
    return {
      configured: false,
      upiId: null,
      payeeName: null,
      status: 'unconfigured',
      statusLabel: 'Not configured',
      isVerified: false
    };
  }

  return {
    configured: true,
    upiId: row.upi_id,
    payeeName: row.payee_name,
    status: row.status === 'verified' ? 'verified' : 'unverified',
    statusLabel: row.status === 'verified' ? 'Verified' : 'Configured (Verification Pending)',
    isVerified: row.status === 'verified',
    updatedAt: row.updated_at
  };
}

export async function saveOrganiserPaymentSettings(userId, { upiId, payeeName }, c = db) {
  await ensurePaymentSettingsTable(c);
  const cleanUpi = validateUpiId(upiId);
  const cleanName = validatePayeeName(payeeName);

  // Find user's organisation if they have one
  const org = (await c.query(
    `SELECT org_id FROM org_memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
    [userId]
  )).rows[0];
  const orgId = org ? org.org_id : null;

  const row = (await c.query(
    `INSERT INTO organiser_payment_settings (user_id, org_id, upi_id, payee_name, status, updated_at)
     VALUES ($1, $2, $3, $4, 'unverified', now())
     ON CONFLICT (user_id) DO UPDATE
        SET upi_id = EXCLUDED.upi_id,
            payee_name = EXCLUDED.payee_name,
            org_id = COALESCE(EXCLUDED.org_id, organiser_payment_settings.org_id),
            status = 'unverified',
            updated_at = now()
     RETURNING id, user_id, upi_id, payee_name, status, updated_at`,
    [userId, orgId, cleanUpi, cleanName]
  )).rows[0];

  // Sync to business_workspaces if user owns one
  if (orgId) {
    await c.query(
      `UPDATE business_workspaces
          SET upi_id = $1, upi_payee_name = $2, upi_status = 'unverified', updated_at = now()
        WHERE org_id = $3`,
      [cleanUpi, cleanName, orgId]
    );
  }

  return {
    configured: true,
    upiId: row.upi_id,
    payeeName: row.payee_name,
    status: 'unverified',
    statusLabel: 'Configured (Verification Pending)',
    isVerified: false,
    updatedAt: row.updated_at
  };
}

export async function deleteOrganiserPaymentSettings(userId, c = db) {
  await ensurePaymentSettingsTable(c);
  await c.query(`DELETE FROM organiser_payment_settings WHERE user_id = $1`, [userId]);
  await c.query(
    `UPDATE business_workspaces
        SET upi_id = NULL, upi_payee_name = NULL, upi_status = 'unverified', updated_at = now()
      WHERE owner_user_id = $1`,
    [userId]
  );
  return { ok: true };
}
