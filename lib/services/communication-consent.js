// lib/services/communication-consent.js - Explicit, separate transactional and promotional communication consent management.
import { db } from '../db.js';
import { audit } from '../audit.js';
import { normalizePhoneNumber } from './phone.js';

export const CHANNELS = ['whatsapp', 'telegram', 'email', 'sms'];
export const PURPOSES = ['transactional', 'promotional'];

/**
 * Record or update communication consent for a user, channel, and purpose.
 */
export async function recordConsent({
  userId,
  channel,
  purpose,
  status, // 'opted_in' | 'opted_out'
  source = 'profile_settings',
  policyVersion = '1.0',
  ip = null,
  client = db
}) {
  if (!userId) throw new Error('userId is required to record consent');
  if (!CHANNELS.includes(channel)) throw new Error(`Invalid channel: ${channel}`);
  if (!PURPOSES.includes(purpose)) throw new Error(`Invalid purpose: ${purpose}`);
  if (!['opted_in', 'opted_out'].includes(status)) throw new Error(`Invalid status: ${status}`);

  const now = new Date();
  const { rows } = await client.query(
    `INSERT INTO communication_consents (user_id, channel, purpose, status, policy_version, source, ip, consented_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (user_id, channel, purpose) DO UPDATE SET
       status = EXCLUDED.status,
       policy_version = EXCLUDED.policy_version,
       source = EXCLUDED.source,
       ip = COALESCE(EXCLUDED.ip, communication_consents.ip),
       updated_at = EXCLUDED.updated_at
     RETURNING id, user_id, channel, purpose, status, source, consented_at, updated_at`,
    [userId, channel, purpose, status, policyVersion, source, ip, now]
  );

  await audit(userId, `consent_${status}`, `user:${userId}`, {
    channel,
    purpose,
    source,
    policyVersion
  }, client);

  return rows[0];
}

/**
 * Retrieve current communication consent matrix for a user.
 */
export async function getConsents(userId, client = db) {
  const { rows } = await client.query(
    `SELECT channel, purpose, status, consented_at, updated_at 
       FROM communication_consents 
      WHERE user_id = $1`,
    [userId]
  );

  const consents = {
    whatsapp: { transactional: true, promotional: false },
    telegram: { transactional: true, promotional: false },
    email: { transactional: true, promotional: false }
  };

  for (const r of rows) {
    if (consents[r.channel]) {
      consents[r.channel][r.purpose] = (r.status === 'opted_in');
    }
  }

  return consents;
}

/**
 * Check if a user has consented to a specific channel and purpose.
 * Transactional defaults to true (unless suppressed); promotional requires explicit opt-in.
 */
export async function hasConsent({ userId, channel, purpose = 'transactional', client = db }) {
  if (!userId) return false;

  const { rows } = await client.query(
    `SELECT status FROM communication_consents 
      WHERE user_id = $1 AND channel = $2 AND purpose = $3`,
    [userId, channel, purpose]
  );

  if (rows.length > 0) {
    return rows[0].status === 'opted_in';
  }

  // Defaults:
  // Transactional essential notifications: opt-in by default
  // Promotional marketing messages: fail-closed false!
  return purpose === 'transactional';
}

/**
 * Add a destination to the suppression list (e.g. STOP request, spam report).
 */
export async function addSuppression({ channel, destination, reason = 'user_opt_out', client = db }) {
  let cleanDest = String(destination).trim();
  if (channel === 'whatsapp' || channel === 'sms') {
    try {
      cleanDest = normalizePhoneNumber(cleanDest);
    } catch (_) {}
  }

  const { rows } = await client.query(
    `INSERT INTO notification_suppressions (channel, destination, reason, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (channel, destination) DO UPDATE SET reason = EXCLUDED.reason
     RETURNING id, channel, destination, reason, created_at`,
    [channel, cleanDest, reason]
  );

  return rows[0];
}

/**
 * Remove a destination from the suppression list.
 */
export async function removeSuppression({ channel, destination, client = db }) {
  let cleanDest = String(destination).trim();
  if (channel === 'whatsapp' || channel === 'sms') {
    try {
      cleanDest = normalizePhoneNumber(cleanDest);
    } catch (_) {}
  }

  const { rowCount } = await client.query(
    `DELETE FROM notification_suppressions WHERE channel = $1 AND destination = $2`,
    [channel, cleanDest]
  );
  return rowCount > 0;
}

/**
 * Check if a destination is currently suppressed.
 */
export async function isSuppressed({ channel, destination, client = db }) {
  if (!destination) return false;
  let cleanDest = String(destination).trim();
  if (channel === 'whatsapp' || channel === 'sms') {
    try {
      cleanDest = normalizePhoneNumber(cleanDest);
    } catch (_) {}
  }

  const { rowCount } = await client.query(
    `SELECT 1 FROM notification_suppressions WHERE channel = $1 AND destination = $2`,
    [channel, cleanDest]
  );
  return rowCount > 0;
}
