// lib/services/safety.js - Trust & Safety: incident reporting, attendee blocking, and moderation integrity.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { logger } from '../logger.js';

export const REPORT_CATEGORIES = [
  'harassment',
  'fraud_suspicious',
  'unwanted_contact',
  'safety_concern',
  'policy_violation',
  'other'
];

/**
 * Submits a confidential safety report from an authenticated attendee.
 */
export async function submitSafetyReport({ userId, category, body, eventId = null, reportedUserId = null }) {
  if (!REPORT_CATEGORIES.includes(category)) {
    throw new HttpError(400, 'invalid_category', 'Invalid report category');
  }
  const trimmed = (body || '').trim();
  if (trimmed.length < 10 || trimmed.length > 3000) {
    throw new HttpError(400, 'validation', 'Report description must be between 10 and 3000 characters');
  }

  return await db.tx(async (c) => {
    let checkedEventId = null;
    if (eventId) {
      const ev = (await c.query('SELECT id, title FROM events WHERE id = $1', [eventId])).rows[0];
      if (!ev) throw new HttpError(404, 'event_not_found', 'Referenced event not found');
      checkedEventId = ev.id;
    }

    let checkedReportedUserId = null;
    if (reportedUserId) {
      if (reportedUserId === userId) {
        throw new HttpError(400, 'self_report', 'You cannot report yourself');
      }
      const target = (await c.query('SELECT id FROM users WHERE id = $1', [reportedUserId])).rows[0];
      if (!target) throw new HttpError(404, 'user_not_found', 'Reported user not found');
      checkedReportedUserId = target.id;
    }

    const { rows } = await c.query(
      `INSERT INTO reports (user_id, category, body, event_id, reported_user_id, status)
       VALUES ($1, $2, $3, $4, $5, 'new')
       RETURNING id, status, created_at`,
      [userId, category, trimmed, checkedEventId, checkedReportedUserId]
    );

    const report = rows[0];
    logger.info('safety report submitted', { reportId: report.id, category, eventId: checkedEventId });
    return report;
  });
}

/**
 * Lists safety reports submitted by the authenticated user only (IDOR isolation).
 */
export async function listUserReports(userId) {
  const { rows } = await db.query(
    `SELECT r.id, r.category, r.body, r.status, r.created_at, e.title AS event_title
       FROM reports r
       LEFT JOIN events e ON e.id = r.event_id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC LIMIT 50`,
    [userId]
  );
  return rows;
}

/**
 * Creates a directional block between blocker and blocked user.
 */
export async function blockUser({ blockerUserId, blockedUserId }) {
  if (!blockedUserId) {
    throw new HttpError(400, 'validation', 'Target user ID is required');
  }
  if (blockerUserId === blockedUserId) {
    throw new HttpError(400, 'self_block', 'You cannot block yourself');
  }

  return await db.tx(async (c) => {
    const target = (await c.query('SELECT id, alias FROM users WHERE id = $1', [blockedUserId])).rows[0];
    if (!target) throw new HttpError(404, 'user_not_found', 'User not found');

    await c.query(
      `INSERT INTO user_blocks (blocker_user_id, blocked_user_id)
       VALUES ($1, $2)
       ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING`,
      [blockerUserId, target.id]
    );

    logger.info('user blocked', { blockerUserId, blockedUserId: target.id });
    return { ok: true, blocked: true };
  });
}

/**
 * Removes a block between blocker and blocked user.
 */
export async function unblockUser({ blockerUserId, blockedUserId }) {
  if (!blockedUserId) {
    throw new HttpError(400, 'validation', 'Target user ID is required');
  }

  const { rowCount } = await db.query(
    `DELETE FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2`,
    [blockerUserId, blockedUserId]
  );

  logger.info('user unblocked', { blockerUserId, blockedUserId, existed: Boolean(rowCount) });
  return { ok: true, unblocked: true };
}

/**
 * Lists users blocked by the authenticated user.
 */
export async function listBlockedUsers(blockerUserId) {
  const { rows } = await db.query(
    `SELECT b.id, b.blocked_user_id, b.created_at, u.alias
       FROM user_blocks b
       JOIN users u ON u.id = b.blocked_user_id
      WHERE b.blocker_user_id = $1
      ORDER BY b.created_at DESC LIMIT 100`,
    [blockerUserId]
  );
  return rows.map((r) => ({
    id: r.id,
    blockedUserId: r.blocked_user_id,
    alias: r.alias || 'Anonymous User',
    createdAt: r.created_at
  }));
}

/**
 * Checks whether userA has blocked userB or userB has blocked userA.
 */
export async function checkBlockConflict(userAId, userBId) {
  if (!userAId || !userBId) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
         OR (blocker_user_id = $2 AND blocked_user_id = $1)
      LIMIT 1`,
    [userAId, userBId]
  );
  return Boolean(rows.length);
}
