// lib/services/membership.js - Membership via Telegram Stars (XTR) subscriptions.
// Bot API 10.x: createInvoiceLink with subscription_period = 2592000 (the only allowed value),
// currency XTR, one price item, max 10000 Stars. Payload ≤ 128 bytes.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { tg } from '../telegram/api.js';
import { env, livePayments } from '../config.js';
import { HttpError } from '../http.js';
import { enqueue } from './notifications.js';
import { audit } from '../audit.js';
import { removeFromChat, tierChatId } from './invites.js';
import { logger } from '../logger.js';

export const STARS_SUBSCRIPTION_PERIOD = 2592000;
export const STARS_MAX_SUBSCRIPTION = 10000;

function payloadKey() {
  const s = env('SESSION_SECRET');
  if (s.length < 32) throw new HttpError(503, 'not_configured', 'Payments are not configured yet');
  return crypto.createHmac('sha256', s).update('stars-invoice-payload-v1').digest();
}

/** m1.<tierCode>.<userUuid>.<mac> — compact, tamper-evident, < 128 bytes. */
export function signPayload(tierCode, userId) {
  const body = `m1.${tierCode}.${userId}`;
  const mac = crypto.createHmac('sha256', payloadKey()).update(body).digest('base64url').slice(0, 22);
  return `${body}.${mac}`;
}

export function verifyPayload(payload) {
  const m = /^m1\.([a-z0-9_]{1,24})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{22})$/.exec(String(payload || ''));
  if (!m) return null;
  const expected = crypto.createHmac('sha256', payloadKey()).update(`m1.${m[1]}.${m[2]}`).digest('base64url').slice(0, 22);
  const a = Buffer.from(m[3]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { tierCode: m[1], userId: m[2] };
}

export function tierPurchasable(tier) {
  return Boolean(tier && tier.active && Number.isInteger(tier.stars_amount) && tier.stars_amount > 0 &&
    tier.stars_amount <= STARS_MAX_SUBSCRIPTION && tier.period_seconds === STARS_SUBSCRIPTION_PERIOD);
}

/** Create a Stars subscription invoice link for a signed-in user. */
export async function createMembershipInvoice(user, tierCode) {
  const tier = await db.one('SELECT * FROM membership_tiers WHERE code = $1', [tierCode]);
  if (!tier || !tier.active) throw new HttpError(404, 'tier_not_found', 'That membership is not available');
  if (!tierPurchasable(tier)) throw new HttpError(409, 'price_not_set', 'Membership prices are announcing soon');
  if (!user.age_confirmed_21) throw new HttpError(403, 'age_required', 'Please confirm you are 21 or older');
  const live = await db.one(
    `SELECT 1 FROM entitlements WHERE user_id = $1 AND tier_id = $2 AND status IN ('active', 'grace') AND expires_at > now()`, [user.id, tier.id]);
  if (live) throw new HttpError(409, 'already_member', 'You already have this membership');
  const link = await tg('createInvoiceLink', {
    title: `${tier.name} membership`.slice(0, 32),
    description: `30 days of access to the ${tier.name} private Telegram group. Renews monthly until cancelled in Telegram.`.slice(0, 255),
    payload: signPayload(tier.code, user.id),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: `${tier.name} (30 days)`, amount: tier.stars_amount }],
    subscription_period: STARS_SUBSCRIPTION_PERIOD
  });
  return { invoiceLink: link, tier: { code: tier.code, name: tier.name, starsAmount: tier.stars_amount } };
}

/** Decide whether to approve a pre_checkout_query. Returns { ok, error? }. */
export async function validatePreCheckout(pcq) {
  if (pcq.currency !== 'XTR') return { ok: false, error: 'Unsupported currency.' };
  let p;
  try {
    p = verifyPayload(pcq.invoice_payload);
  } catch {
    return { ok: false, error: 'Payments are temporarily unavailable.' };
  }
  if (!p) return { ok: false, error: 'This invoice is not valid.' };
  const tier = await db.one('SELECT * FROM membership_tiers WHERE code = $1', [p.tierCode]);
  if (!tierPurchasable(tier)) return { ok: false, error: 'This membership is not available right now.' };
  if (pcq.total_amount !== tier.stars_amount) return { ok: false, error: 'The price has changed. Please start again.' };
  const user = await db.one('SELECT id, telegram_user_id, status, age_confirmed_21 FROM users WHERE id = $1', [p.userId]);
  if (!user || user.telegram_user_id !== pcq.from?.id) return { ok: false, error: 'This invoice belongs to a different account.' };
  if (user.status !== 'active') return { ok: false, error: 'This account cannot purchase memberships.' };
  if (!user.age_confirmed_21) return { ok: false, error: 'Please confirm you are 21+ on our website first.' };
  return { ok: true };
}

/**
 * Process message.successful_payment for a Stars subscription. Idempotent on
 * telegram_payment_charge_id (first payment and every renewal have distinct charge ids).
 * Returns { status: 'duplicate' | 'activated' | 'renewed', notificationIds }.
 */
export async function handleSuccessfulPayment(sp, from) {
  const p = verifyPayload(sp.invoice_payload);
  if (!p) throw new Error('successful_payment with unverifiable payload');
  if (sp.currency !== 'XTR') throw new Error('unexpected currency');
  return db.tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO webhook_events (provider, event_id) VALUES ('telegram_stars', $1) ON CONFLICT DO NOTHING RETURNING id`,
      [sp.telegram_payment_charge_id]);
    if (!ins.rowCount) return { status: 'duplicate', notificationIds: [] };
    const webhookId = ins.rows[0].id;

    const user = (await c.query('SELECT id, telegram_user_id FROM users WHERE id = $1 FOR UPDATE', [p.userId])).rows[0];
    if (!user || user.telegram_user_id !== from?.id) throw new Error('payer does not match invoice user');
    const tier = (await c.query('SELECT * FROM membership_tiers WHERE code = $1', [p.tierCode])).rows[0];
    if (!tier) throw new Error('tier missing');

    const pay = (await c.query(
      `INSERT INTO payments (provider, provider_txn_id, provider_payment_id, purpose, user_id, amount, currency, status, is_test, paid_at, raw_ref)
       VALUES ('telegram_stars', $1, $2, 'membership', $3, $4, 'XTR', 'paid', $5, now(), $6) RETURNING id`,
      [sp.telegram_payment_charge_id, sp.provider_payment_charge_id || null, user.id, sp.total_amount,
        env('TELEGRAM_TEST_ENV') === 'true' || !livePayments(),
        JSON.stringify({ tier: tier.code, recurring: Boolean(sp.is_recurring), first: Boolean(sp.is_first_recurring) })]
    )).rows[0];

    const expiresAt = sp.subscription_expiration_date
      ? new Date(sp.subscription_expiration_date * 1000)
      : new Date(Date.now() + tier.period_seconds * 1000);

    const existing = (await c.query(
      `SELECT id, status FROM entitlements WHERE user_id = $1 AND tier_id = $2 AND status IN ('active', 'grace', 'cancelled') FOR UPDATE`,
      [user.id, tier.id])).rows[0];
    let entitlementId;
    let status;
    if (existing) {
      await c.query(
        `UPDATE entitlements SET status = 'active', expires_at = GREATEST(expires_at, $2), last_payment_id = $3 WHERE id = $1`,
        [existing.id, expiresAt, pay.id]);
      entitlementId = existing.id;
      status = 'renewed';
    } else {
      entitlementId = (await c.query(
        `INSERT INTO entitlements (user_id, tier_id, status, starts_at, expires_at, last_payment_id)
         VALUES ($1, $2, 'active', now(), $3, $4) RETURNING id`, [user.id, tier.id, expiresAt, pay.id])).rows[0].id;
      status = 'activated';
    }
    const nid = await enqueue(c, {
      kind: status === 'activated' ? 'membership_activated' : 'membership_renewed',
      userId: user.id, entitlementId, dedupeKey: `stars:${sp.telegram_payment_charge_id}`
    });
    await c.query(`UPDATE webhook_events SET processed_at = now(), result = $2 WHERE id = $1`, [webhookId, status]);
    await audit('webhook:telegram_stars', `membership.${status}`, entitlementId, { tier: tier.code, paymentId: pay.id }, c);
    return { status, entitlementId, notificationIds: [nid] };
  });
}

/** Cron: send reminders for memberships ending within 3 days (once per period). */
export async function queueExpiryReminders() {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE entitlements SET reminder_sent_for = expires_at
        WHERE status IN ('active', 'cancelled') AND expires_at BETWEEN now() AND now() + interval '3 days'
          AND reminder_sent_for IS DISTINCT FROM expires_at
        RETURNING id, user_id, expires_at`);
    const ids = [];
    for (const r of rows) {
      ids.push(await enqueue(c, { kind: 'expiry_reminder', userId: r.user_id, entitlementId: r.id, dedupeKey: `rem:${r.id}:${new Date(r.expires_at).toISOString()}` }));
    }
    return ids;
  });
}

/**
 * Cron: expire memberships past expires_at (+1h grace for renewal webhooks) and remove the user
 * from the tier chat. A failed Telegram removal leaves status 'expired' so the next run retries.
 */
export async function expireAndRevoke() {
  await db.query(
    `UPDATE entitlements SET status = 'expired'
      WHERE status IN ('active', 'grace', 'cancelled') AND expires_at < now() - interval '1 hour'`);
  const { rows } = await db.query(
    `SELECT en.id, en.user_id, u.telegram_user_id, t.code, t.telegram_chat_id
       FROM entitlements en JOIN users u ON u.id = en.user_id JOIN membership_tiers t ON t.id = en.tier_id
      WHERE en.status = 'expired' AND en.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM entitlements other
                         WHERE other.user_id = en.user_id AND other.tier_id = en.tier_id
                           AND other.status IN ('active', 'grace', 'cancelled'))
      LIMIT 100`);
  const result = { revoked: 0, failed: 0, notificationIds: [] };
  for (const r of rows) {
    const chatId = tierChatId(r);
    try {
      if (chatId === null) throw new Error(`NOT CONFIGURED: chat id for tier ${r.code}`);
      await removeFromChat(chatId, r.telegram_user_id);
      await db.tx(async (c) => {
        await c.query(`UPDATE entitlements SET status = 'revoked', revoked_at = now() WHERE id = $1`, [r.id]);
        await c.query(`UPDATE invite_links SET revoked_at = COALESCE(revoked_at, now()) WHERE entitlement_id = $1`, [r.id]);
        result.notificationIds.push(await enqueue(c, { kind: 'membership_expired', userId: r.user_id, entitlementId: r.id, dedupeKey: `exp:${r.id}` }));
        await audit('cron', 'membership.revoked', r.id, { tier: r.code }, c);
      });
      result.revoked++;
    } catch (err) {
      result.failed++;
      logger.warn('membership revoke failed', { entitlementId: r.id, reason: String(err.message).slice(0, 120) });
    }
  }
  return result;
}
