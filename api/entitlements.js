// api/entitlements.js - GET /api/entitlements
import { db } from '../lib/db.js';
import { getTierById } from '../lib/entitlements.js';

export const access = 'public';
export const methods = ['GET'];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  const url = new URL(req.url, 'http://localhost');
  const telegramUserId = url.searchParams.get('telegramUserId');
  const orderId = url.searchParams.get('orderId');
  const subscriptionId = url.searchParams.get('subscriptionId');

  if (!telegramUserId && !orderId && !subscriptionId) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: false,
      error: 'Missing query identifier (telegramUserId or subscriptionId required)'
    }));
  }

  let subQuery;
  let params;

  if (subscriptionId) {
    subQuery = `SELECT * FROM subscriptions WHERE id = $1 LIMIT 1`;
    params = [subscriptionId];
  } else if (telegramUserId) {
    subQuery = `SELECT * FROM subscriptions WHERE telegram_user_id = $1 ORDER BY created_at DESC LIMIT 1`;
    params = [Number(telegramUserId)];
  }

  const subResult = await db.query(subQuery, params);
  if (!subResult.rows || subResult.rows.length === 0) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok: false,
      hasActiveSubscription: false,
      status: 'NOT_FOUND',
      message: 'No subscription found for this identifier'
    }));
  }

  const sub = subResult.rows[0];
  const now = new Date();
  const expiresAt = new Date(sub.expires_at);
  const isExpired = sub.status === 'EXPIRED' || (sub.expires_at && expiresAt < now);

  const tier = getTierById(sub.tier_id);

  // Retrieve active entitlement link if active
  let inviteLink = null;
  if (sub.status === 'ACTIVE' && !isExpired) {
    const entResult = await db.query(
      `SELECT invite_link FROM access_entitlements WHERE subscription_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [sub.id]
    );
    if (entResult.rows && entResult.rows.length > 0) {
      inviteLink = entResult.rows[0].invite_link;
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify({
    ok: true,
    hasActiveSubscription: sub.status === 'ACTIVE' && !isExpired,
    subscription: {
      id: sub.id,
      tierId: sub.tier_id,
      tierName: tier ? tier.name : sub.tier_id,
      status: isExpired ? 'EXPIRED' : sub.status,
      startsAt: sub.starts_at,
      expiresAt: sub.expires_at,
      isRecurring: Boolean(sub.is_recurring),
      inviteLink: inviteLink
    }
  }));
}
