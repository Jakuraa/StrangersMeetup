// api/cancel.js - POST /api/cancel
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const access = 'public';
export const methods = ['POST'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  const { subscriptionId, telegramUserId, reason } = req.body || {};

  if (!subscriptionId && !telegramUserId) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: false,
      error: 'subscriptionId or telegramUserId is required'
    }));
  }

  try {
    let subQuery = 'SELECT id, status, expires_at, is_recurring FROM subscriptions WHERE ';
    let params = [];

    if (subscriptionId) {
      subQuery += 'id = $1 LIMIT 1';
      params = [subscriptionId];
    } else {
      subQuery += 'telegram_user_id = $1 AND status = "ACTIVE" ORDER BY created_at DESC LIMIT 1';
      params = [Number(telegramUserId)];
    }

    const subRes = await db.query(subQuery, params);
    if (subRes.rows && subRes.rows.length > 0) {
      const sub = subRes.rows[0];
      await db.query(
        `UPDATE subscriptions SET cancelled_at = CURRENT_TIMESTAMP, is_recurring = 0 WHERE id = $1`,
        [sub.id]
      );

      await db.query(
        `INSERT INTO audit_logs (id, action, actor_type, actor_id, details_json)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          `aud_cancel_${Date.now()}`,
          'SUBSCRIPTION_CANCEL_REQUESTED',
          'USER',
          String(telegramUserId || sub.id),
          JSON.stringify({ reason: reason || 'User requested cancellation' })
        ]
      );
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: true,
      message: 'Cancellation recorded. As Telegram Stars payments are managed in-app, please also verify cancellation in your Telegram Settings.',
      telegramSteps: [
        'Open Telegram on your mobile device or desktop.',
        'Navigate to Settings > Subscriptions.',
        'Locate StrangersMeetup under active bot subscriptions.',
        'Select Cancel Subscription.',
        'Your channel access will remain active until the end of your current 30-day billing cycle, after which it will not renew.'
      ]
    }));
  } catch (err) {
    logger.error('Failed to process cancel request', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
