// lib/services/orders.js - SuperProfile ticket orders (external_orders) and the bookings they confirm.
//
// A booking is confirmed only from a SuperProfile "purchase" notification (via Zapier/Pabbly →
// /api/webhooks/superprofile) that we can tie to a person: by the checkout ref we attached on the
// way out, or by a previously verified buyer email. Everything else is stored as `unmatched` and
// waits for the buyer to /claim it in the bot or for an admin to link it. Nothing is ever dropped.
// Fails closed: an amount we cannot reconcile with the configured price is stored and flagged, and
// confirms nothing.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { enqueue } from './notifications.js';
import { emailHash, phoneHash, rupeesToPaise } from './superprofile.js';
import { removeFromChat } from './invites.js';
import { recordIntegrationError } from './insights.js';
import { logger } from '../logger.js';

/** Normalise a checkout ref coming back from SuperProfile (case and stray characters vary). */
export function normaliseRef(v) {
  const r = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return r.length === 8 ? r : null;
}

function parseQty(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : null;
}

/**
 * Amounts (paise) the order may legitimately have, or null when no price is configured to check
 * against. A tiered event accepts any paid tier × quantity (the intent narrows it to one tier).
 */
export function expectedAmounts(event, tiers, intent, qty) {
  if (event.ticketing === 'tiers') {
    const paid = tiers.filter((t) => t.kind === 'paid' && (!intent?.ticket_type_id || t.id === intent.ticket_type_id));
    if (!paid.length) return null;
    return new Set(paid.map((t) => t.price_paise * qty));
  }
  if (event.price_status === 'set' && event.ticket_price_paise) return new Set([event.ticket_price_paise * qty]);
  return null;
}

/** Quantity from the payload, else inferred from amount ÷ unit price, else 1. */
export function inferQty(event, tiers, intent, amountPaise, given) {
  const q = parseQty(given);
  if (q) return q;
  const units = event.ticketing === 'tiers'
    ? tiers.filter((t) => t.kind === 'paid' && (!intent?.ticket_type_id || t.id === intent.ticket_type_id)).map((t) => t.price_paise)
    : (event.price_status === 'set' && event.ticket_price_paise ? [event.ticket_price_paise] : []);
  if (amountPaise && units.length === 1 && amountPaise % units[0] === 0) return parseQty(amountPaise / units[0]) || 1;
  return intent?.qty || 1;
}

/**
 * Create the confirmed booking for a paid order and link it. `c` is a transaction client with the
 * order row already locked. Returns { bookingId, notificationId } or { conflict: 'duplicate_booking' }.
 */
export async function confirmOrderBooking(c, { order, event, userId, ticketTypeId = null, actor }) {
  const live = (await c.query(
    `SELECT id FROM bookings WHERE event_id = $1 AND user_id = $2 AND status IN ('pending_approval', 'pending_payment', 'confirmed', 'checked_in') LIMIT 1`,
    [event.id, userId])).rows[0];
  if (live) return { conflict: 'duplicate_booking' };
  const b = (await c.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, source, confirmed_at)
     VALUES ($1, $2, $3, $4, 'confirmed', $5, 'external', 'superprofile', now()) RETURNING id`,
    [event.id, userId, ticketTypeId, order.qty, order.amount_paise])).rows[0];
  await c.query(`UPDATE external_orders SET matched_booking_id = $2, match_state = 'matched', flag_reason = NULL WHERE id = $1`, [order.id, b.id]);
  const nid = await enqueue(c, { kind: 'booking_confirmed', userId, bookingId: b.id, dedupeKey: `bk:${b.id}:confirmed` });
  await audit(actor, 'booking.confirmed_external', b.id, { orderRow: order.id, qty: order.qty }, c);
  return { bookingId: b.id, notificationId: nid };
}

async function alertNotification(c, orderRowId, reason) {
  return enqueue(c, { kind: 'order_alert', dedupeKey: `oa:${orderRowId}:${reason}` });
}

/** Apply a "purchase" notification. Idempotent on order_id. */
async function applyPurchase(b) {
  const orderId = b.id;
  const productKeys = [b.product_id, b.product].filter(Boolean).map((s) => s.toLowerCase());
  const productId = b.product_id || b.product || null;
  const email = b.email ? emailHash(b.email) : null;
  const phone = b.phone ? phoneHash(b.phone) : null;
  const amount = rupeesToPaise(b.amount);
  const currency = (b.currency || 'INR').toUpperCase().slice(0, 8);
  const ref = normaliseRef(b.ref);

  const r = await db.tx(async (c) => {
    const event = productKeys.length
      ? (await c.query('SELECT * FROM events WHERE lower(superprofile_product_id) = ANY($1::text[]) FOR UPDATE', [productKeys])).rows[0]
      : null;
    const tiers = event?.ticketing === 'tiers'
      ? (await c.query('SELECT id, kind, price_paise FROM ticket_types WHERE event_id = $1 AND active', [event.id])).rows : [];
    const intent = ref
      ? (await c.query('SELECT * FROM checkout_intents WHERE ref = $1 AND expires_at > now()', [ref])).rows[0] : null;
    const intentForEvent = intent && event && intent.event_id === event.id ? intent : null;
    const qty = event ? inferQty(event, tiers, intentForEvent, amount, b.qty) : (parseQty(b.qty) || 1);

    const ins = await c.query(
      `INSERT INTO external_orders (order_id, product_id, event_id, amount_paise, currency, qty, status, buyer_email_hash, buyer_phone_hash, ref, raw_minimal)
       VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9,$10) ON CONFLICT (order_id) DO NOTHING RETURNING *`,
      [orderId, productId, event?.id || null, amount, currency, qty, email, phone, ref,
        JSON.stringify({ occurred_at: b.occurred_at || null, intent: Boolean(intentForEvent) })]);
    if (!ins.rowCount) return { result: 'duplicate', notificationIds: [] };
    const order = ins.rows[0];

    const flag = async (reason, result) => {
      await c.query(`UPDATE external_orders SET match_state = 'flagged', flag_reason = $2 WHERE id = $1`, [order.id, reason]);
      const nid = await alertNotification(c, order.id, reason);
      await audit('webhook:superprofile', 'order.flagged', order.id, { reason }, c);
      return { result, notificationIds: [nid], alert: reason, orderRow: order.id };
    };

    if (!event) {
      const nid = await alertNotification(c, order.id, 'unknown_product');
      await c.query(`UPDATE external_orders SET flag_reason = 'unknown_product' WHERE id = $1`, [order.id]);
      return { result: 'unmatched', notificationIds: [nid], alert: 'unknown_product', orderRow: order.id };
    }
    if (currency !== 'INR') return flag('currency_mismatch', 'flagged');
    const expected = expectedAmounts(event, tiers, intentForEvent, qty);
    if (expected && (amount === null || !expected.has(amount))) return flag('amount_mismatch', 'flagged');
    if (event.status !== 'published') return flag('event_not_published', 'flagged');

    // Who bought? The ref we attached (signed-in click), else a buyer email a user verified earlier.
    let userId = intentForEvent?.user_id || null;
    if (userId) {
      const u = (await c.query(`SELECT id FROM users WHERE id = $1 AND status = 'active'`, [userId])).rows[0];
      userId = u?.id || null;
    }
    if (!userId && email) {
      const u = (await c.query(`SELECT id FROM users WHERE email_hash = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`, [email])).rows[0];
      userId = u?.id || null;
    }
    if (!userId) {
      await audit('webhook:superprofile', 'order.unmatched', order.id, { eventId: event.id }, c);
      return { result: 'unmatched', notificationIds: [], orderRow: order.id };
    }
    const confirmed = await confirmOrderBooking(c, { order, event, userId, ticketTypeId: intentForEvent?.ticket_type_id || null, actor: 'webhook:superprofile' });
    if (confirmed.conflict) return flag(confirmed.conflict, 'flagged');
    return { result: 'confirmed', notificationIds: [confirmed.notificationId], bookingId: confirmed.bookingId, orderRow: order.id };
  });
  return r;
}

/** Apply a "refund" or "cancelled" notification to an order and its booking. Idempotent. */
async function applyReversal(b) {
  const status = b.event === 'refund' ? 'refunded' : 'cancelled';
  const productKeys = [b.product_id, b.product].filter(Boolean).map((s) => s.toLowerCase());
  const effects = { removeFromChat: null };

  const r = await db.tx(async (c) => {
    const order = (await c.query('SELECT * FROM external_orders WHERE order_id = $1 FOR UPDATE', [b.id])).rows[0];
    if (!order) {
      // Refund seen before the purchase (or the purchase never reached us): keep the fact; a late purchase becomes a duplicate.
      const event = productKeys.length
        ? (await c.query('SELECT id FROM events WHERE lower(superprofile_product_id) = ANY($1::text[])', [productKeys])).rows[0] : null;
      await c.query(
        `INSERT INTO external_orders (order_id, product_id, event_id, amount_paise, currency, status, raw_minimal)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_id) DO NOTHING`,
        [b.id, b.product_id || b.product || null, event?.id || null, rupeesToPaise(b.amount), (b.currency || 'INR').toUpperCase().slice(0, 8), status,
          JSON.stringify({ occurred_at: b.occurred_at || null, before_purchase: true })]);
      return { result: `${status}_before_purchase`, notificationIds: [] };
    }
    if (order.status !== 'paid') return { result: 'duplicate', notificationIds: [] };
    await c.query('UPDATE external_orders SET status = $2 WHERE id = $1', [order.id, status]);
    if (!order.matched_booking_id) {
      await audit('webhook:superprofile', `order.${status}`, order.id, { matched: false }, c);
      return { result: status, notificationIds: [] };
    }
    const booking = (await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [order.matched_booking_id])).rows[0];
    if (booking.status === 'checked_in') {
      // The guest was already admitted: keep the check-in record, tell finance.
      await c.query(`UPDATE external_orders SET match_state = 'flagged', flag_reason = 'refund_after_check_in' WHERE id = $1`, [order.id]);
      const nid = await alertNotification(c, order.id, 'refund_after_check_in');
      await audit('webhook:superprofile', `order.${status}_after_check_in`, order.id, { bookingId: booking.id }, c);
      return { result: `${status}_after_check_in`, notificationIds: [nid], alert: 'refund_after_check_in', orderRow: order.id };
    }
    if (['confirmed', 'pending_payment', 'pending_approval'].includes(booking.status)) {
      await c.query(
        `UPDATE bookings SET status = $2::booking_status,
                refunded_at = CASE WHEN $2 = 'refunded' THEN now() ELSE refunded_at END,
                cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
                cancel_reason = CASE WHEN $2 = 'cancelled' THEN 'superprofile_cancelled' ELSE cancel_reason END
          WHERE id = $1`, [booking.id, status]);
      await c.query('UPDATE invite_links SET revoked_at = COALESCE(revoked_at, now()) WHERE booking_id = $1 AND used_at IS NULL', [booking.id]);
      const joined = (await c.query(
        `SELECT i.chat_id, u.telegram_user_id FROM invite_links i JOIN users u ON u.id = i.user_id
          WHERE i.booking_id = $1 AND i.used_at IS NOT NULL AND i.revoked_at IS NULL LIMIT 1`, [booking.id])).rows[0];
      if (joined) {
        effects.removeFromChat = { chatId: joined.chat_id, telegramUserId: joined.telegram_user_id };
        await c.query('UPDATE invite_links SET revoked_at = now() WHERE booking_id = $1 AND revoked_at IS NULL', [booking.id]);
      }
      const nid = await enqueue(c, { kind: 'booking_refunded', userId: booking.user_id, bookingId: booking.id, dedupeKey: `bk:${booking.id}:refunded` });
      await audit('webhook:superprofile', `order.${status}`, order.id, { bookingId: booking.id }, c);
      return { result: status, notificationIds: [nid], bookingId: booking.id };
    }
    return { result: status, notificationIds: [] };
  });
  return { ...r, effects };
}

/**
 * Entry for order-shaped notifications (purchase / refund / cancelled). Runs the transaction, then
 * the side effects that must not roll it back: group removal and admin alert logging.
 */
export async function applyOrderEvent(b) {
  const r = b.event === 'purchase' ? await applyPurchase(b) : await applyReversal(b);
  if (r.effects?.removeFromChat) {
    const { chatId, telegramUserId } = r.effects.removeFromChat;
    await removeFromChat(chatId, telegramUserId).catch((err) => logger.warn('remove from group failed', { reason: String(err.message).slice(0, 100) }));
  }
  if (r.alert) await recordIntegrationError('superprofile_webhook', `order_${r.alert}`, `order row ${r.orderRow}`);
  return r;
}

/** Does this product belong to a membership tier (handled by the membership flow)? */
export async function isTierProduct(b) {
  const keys = [b.product_id, b.product].filter(Boolean);
  if (!keys.length) return false;
  const row = await db.one('SELECT 1 AS x FROM membership_tiers WHERE lower(superprofile_product_ref) = ANY($1::text[])', [keys.map((k) => k.toLowerCase())]);
  return Boolean(row);
}

// ---------- admin ----------

/** Keyset-paginated order list for the admin Orders tab. */
export async function listOrders({ state = 'unmatched', cursor = null, limit = 25 } = {}) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (state === 'unmatched') where.push(`o.match_state = 'unmatched' AND o.status = 'paid'`);
  else if (state === 'flagged') where.push(`o.match_state = 'flagged'`);
  else if (state === 'matched') where.push(`o.match_state = 'matched'`);
  else if (state !== 'all') throw new HttpError(400, 'validation', 'Unknown state');
  if (cursor) {
    const [ts, id] = String(cursor).split('|');
    if (!ts || Number.isNaN(new Date(ts).getTime()) || !/^[0-9a-f-]{36}$/i.test(id || '')) throw new HttpError(400, 'validation', 'Bad cursor');
    where.push(`(o.received_at, o.id) < (${p(ts)}::timestamptz, ${p(id)}::uuid)`);
  }
  const { rows } = await db.query(
    `SELECT o.id, o.order_id, o.product_id, o.amount_paise, o.currency, o.qty, o.status, o.match_state, o.flag_reason, o.received_at,
            o.matched_booking_id, (o.buyer_email_hash IS NOT NULL) AS has_email, e.title AS event_title, e.slug AS event_slug
       FROM external_orders o LEFT JOIN events e ON e.id = o.event_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY o.received_at DESC, o.id DESC LIMIT ${n + 1}`, params);
  const page = rows.slice(0, n);
  const last = page[page.length - 1];
  return { orders: page, nextCursor: rows.length > n && last ? `${new Date(last.received_at).toISOString()}|${last.id}` : null };
}

/** Finance: link a paid, unclaimed order to the user with this Telegram id and confirm their booking. */
export async function linkOrderToUser(actor, orderRowId, telegramUserId) {
  const out = await db.tx(async (c) => {
    const order = (await c.query('SELECT * FROM external_orders WHERE id = $1 FOR UPDATE', [orderRowId])).rows[0];
    if (!order) throw new HttpError(404, 'not_found', 'Order not found');
    if (order.status !== 'paid') throw new HttpError(409, 'not_linkable', `Order is ${order.status}`);
    if (order.matched_booking_id) throw new HttpError(409, 'already_linked', 'Order is already linked to a booking');
    if (!order.event_id) throw new HttpError(409, 'unknown_product', 'This order’s product is not linked to an event yet. Link the product on the event first.');
    const user = (await c.query(`SELECT id FROM users WHERE telegram_user_id = $1 AND status = 'active'`, [telegramUserId])).rows[0];
    if (!user) throw new HttpError(404, 'user_not_found', 'No active user with that Telegram id. They must sign in once first.');
    const event = (await c.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [order.event_id])).rows[0];
    const r = await confirmOrderBooking(c, { order, event, userId: user.id, actor });
    if (r.conflict) throw new HttpError(409, r.conflict, 'That user already has a booking for this event');
    await audit(actor, 'order.manual_link', order.id, { bookingId: r.bookingId, orderId: order.order_id }, c);
    return { bookingId: r.bookingId, notificationIds: [r.notificationId] };
  });
  return out;
}
