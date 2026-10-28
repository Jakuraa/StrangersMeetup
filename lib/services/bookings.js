// lib/services/bookings.js - Ticket booking state machine. The only paths to `confirmed` are
// applyTicketEvent() (verified webhook or server-side reconciliation) — never a client redirect.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { siteUrl } from '../config.js';
import { SEAT_HOLDING_SQL, formatPaise } from './events.js';
import { enqueue } from './notifications.js';
import { audit } from '../audit.js';
import { logger } from '../logger.js';

export const HOLD_MINUTES = 15;

export async function seatsTaken(c, eventId, excludeBookingId = null) {
  const { rows } = await c.query(
    `SELECT COALESCE(sum(b.quantity), 0)::int AS n FROM bookings b WHERE b.event_id = $1 AND ${SEAT_HOLDING_SQL} AND ($2::uuid IS NULL OR b.id <> $2)`,
    [eventId, excludeBookingId]);
  return rows[0].n;
}

/** Seats of one ticket tier currently taken (confirmed + live holds). */
export async function tierSeatsTaken(c, ticketTypeId, excludeBookingId = null) {
  const { rows } = await c.query(
    `SELECT COALESCE(sum(b.quantity), 0)::int AS n FROM bookings b WHERE b.ticket_type_id = $1 AND ${SEAT_HOLDING_SQL} AND ($2::uuid IS NULL OR b.id <> $2)`,
    [ticketTypeId, excludeBookingId]);
  return rows[0].n;
}

/**
 * Step 1 (one short transaction, event row locked): validate and place a 15-minute seat hold.
 * Returns { booking, event, existing } where existing=true means an active booking was reused.
 */
async function placeHold(user, eventId) {
  return db.tx(async (c) => {
    const event = (await c.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
    if (!event || event.status !== 'published') throw new HttpError(404, 'event_not_found', 'This event is not available');
    if (new Date(event.start_at) <= new Date()) throw new HttpError(409, 'event_started', 'This event has already started');
    if (event.source === 'external') throw new HttpError(409, 'external_event', 'This event is booked on the organiser’s own page');
    if (event.ticketing === 'tiers') throw new HttpError(409, 'choose_ticket', 'Choose a ticket type on the event page to book');
    if (event.price_status !== 'set' || !event.ticket_price_paise) throw new HttpError(409, 'price_tbd', 'Bookings open once the price is announced');
    if (!user.age_confirmed_21) throw new HttpError(403, 'age_required', 'Please confirm you are 21 or older');

    const active = (await c.query(
      `SELECT b.*, p.checkout_url FROM bookings b LEFT JOIN payments p ON p.id = b.payment_id
        WHERE b.event_id = $1 AND b.user_id = $2 AND b.status IN ('pending_payment', 'confirmed', 'checked_in') FOR UPDATE OF b`,
      [eventId, user.id])).rows[0];
    if (active) {
      if (active.status !== 'pending_payment') return { booking: active, event, existing: true };
      if (new Date(active.hold_expires_at) > new Date() && active.checkout_url) return { booking: active, event, existing: true };
      // Stale or never-completed hold: release it and start fresh.
      await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_replaced' WHERE id = $1`, [active.id]);
    }

    if (await seatsTaken(c, eventId) >= event.capacity) throw new HttpError(409, 'sold_out', 'Sorry, this event is sold out');
    const booking = (await c.query(
      `INSERT INTO bookings (event_id, user_id, status, amount_paise, hold_expires_at)
       VALUES ($1, $2, 'pending_payment', $3, now() + make_interval(mins => $4)) RETURNING *`,
      [eventId, user.id, event.ticket_price_paise, HOLD_MINUTES])).rows[0];
    return { booking, event, existing: false };
  });
}

/**
 * Create (or resume) a booking and a hosted checkout.
 * Returns { bookingId, status, checkoutUrl? }.
 */
export async function createBooking(user, eventId, provider) {
  const { booking, event, existing } = await placeHold(user, eventId);
  if (existing) {
    return { bookingId: booking.id, status: booking.status, checkoutUrl: booking.status === 'pending_payment' ? booking.checkout_url : null };
  }
  const checkoutUrl = await startCheckout(user.id, booking, event, provider);
  return { bookingId: booking.id, status: 'pending_payment', checkoutUrl };
}

/**
 * Create a hosted checkout for a booking already holding seats (status pending_payment) and record
 * the `created` payment. On provider failure, `onFail` releases the hold (default: cancel).
 * Provider-agnostic: any PaymentProvider from lib/payments works. Returns the checkout URL.
 */
export async function startCheckout(userId, booking, event, provider, {
  onFail = (id) => db.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'checkout_failed' WHERE id = $1`, [id])
} = {}) {
  let checkout;
  try {
    checkout = await provider.createCheckout({
      bookingId: booking.id,
      userId,
      amountPaise: booking.amount_paise,
      title: `${event.title} — ${event.city}`,
      expiresAt: booking.hold_expires_at,
      returnUrl: `${siteUrl()}/bookings/${booking.id}`
    });
  } catch (err) {
    await onFail(booking.id);
    if (err instanceof HttpError) throw err;
    logger.error('checkout creation failed', err, { provider: provider.name });
    throw new HttpError(502, 'checkout_failed', 'We could not start checkout. Please try again in a moment.');
  }
  await db.tx(async (c) => {
    const pay = (await c.query(
      `INSERT INTO payments (provider, provider_txn_id, purpose, user_id, booking_id, amount, currency, status, is_test, checkout_url, raw_ref)
       VALUES ($1, $2, 'ticket', $3, $4, $5, 'INR', 'created', $6, $7, $8) RETURNING id`,
      [provider.name, checkout.providerTxnId, userId, booking.id, booking.amount_paise, provider.isTest, checkout.checkoutUrl,
        JSON.stringify({ txn: checkout.providerTxnId })])).rows[0];
    await c.query(`UPDATE bookings SET payment_id = $2, payment_mode = COALESCE(payment_mode, 'provider') WHERE id = $1`, [booking.id, pay.id]);
  });
  return checkout.checkoutUrl;
}

/**
 * Apply a verified provider event. Idempotent per (provider, eventId) via webhook_events, and per
 * payment via its status. Returns { result, notificationIds }.
 */
export async function applyTicketEvent(providerName, evt) {
  return db.tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO webhook_events (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`, [providerName, evt.eventId]);
    if (!ins.rowCount) return { result: 'duplicate', notificationIds: [] };
    const whId = ins.rows[0].id;
    const finish = async (result, notificationIds = []) => {
      await c.query('UPDATE webhook_events SET processed_at = now(), result = $2 WHERE id = $1', [whId, result]);
      return { result, notificationIds };
    };
    if (evt.type === 'ignored') return finish('ignored');

    let payment;
    if (evt.type === 'refunded' && !evt.providerTxnId) {
      payment = (await c.query(`SELECT * FROM payments WHERE provider = $1 AND provider_payment_id = $2 FOR UPDATE`, [providerName, evt.providerPaymentId])).rows[0];
    } else if (evt.providerTxnId) {
      payment = (await c.query(`SELECT * FROM payments WHERE provider = $1 AND provider_txn_id = $2 FOR UPDATE`, [providerName, evt.providerTxnId])).rows[0];
    } else if (evt.bookingId) {
      payment = (await c.query(`SELECT * FROM payments WHERE provider = $1 AND booking_id = $2 AND purpose = 'ticket' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [providerName, evt.bookingId])).rows[0];
    }
    if (!payment || payment.purpose !== 'ticket') return finish('unknown_payment');

    if (evt.type === 'failed') {
      if (payment.status === 'created') {
        await c.query(`UPDATE payments SET status = 'failed', failure_reason = $2 WHERE id = $1`, [payment.id, evt.reason || 'failed']);
      }
      return finish('failed_recorded'); // nothing granted; the hold simply expires
    }

    if (evt.type === 'expired') {
      if (payment.status === 'created') {
        await c.query(`UPDATE payments SET status = 'failed', failure_reason = 'expired' WHERE id = $1`, [payment.id]);
        await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'checkout_expired' WHERE id = $1 AND status = 'pending_payment'`, [payment.booking_id]);
      }
      return finish('expired');
    }

    if (evt.type === 'refunded') {
      if (payment.status !== 'refunded') {
        await c.query(`UPDATE payments SET status = 'refunded', refunded_at = now() WHERE id = $1`, [payment.id]);
        await c.query(`UPDATE bookings SET status = 'refunded', refunded_at = now() WHERE id = $1 AND status <> 'refunded'`, [payment.booking_id]);
        await c.query(`UPDATE invite_links SET revoked_at = COALESCE(revoked_at, now()) WHERE booking_id = $1`, [payment.booking_id]);
      }
      return finish('refunded');
    }

    // evt.type === 'paid'
    if (payment.status === 'paid' || payment.status === 'refunded') return finish('already_paid');
    if (evt.amountPaise !== undefined && Number(evt.amountPaise) !== Number(payment.amount)) {
      logger.error('payment amount mismatch', null, { paymentId: payment.id });
      await c.query(`UPDATE payments SET failure_reason = 'amount_mismatch' WHERE id = $1`, [payment.id]);
      return finish('amount_mismatch');
    }
    if (evt.currency && evt.currency !== 'INR') return finish('currency_mismatch');
    await c.query(`UPDATE payments SET status = 'paid', paid_at = now(), provider_payment_id = COALESCE($2, provider_payment_id), failure_reason = NULL WHERE id = $1`,
      [payment.id, evt.providerPaymentId || null]);

    // Lock order matches placeHold (events, then bookings) to avoid deadlocks.
    const eventId = (await c.query('SELECT event_id FROM bookings WHERE id = $1', [payment.booking_id])).rows[0].event_id;
    const event = (await c.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
    const booking = (await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [payment.booking_id])).rows[0];
    if (['confirmed', 'checked_in'].includes(booking.status)) return finish('already_confirmed');

    const holdActive = booking.status === 'pending_payment' && new Date(booking.hold_expires_at) > new Date();
    const otherActive = (await c.query(
      `SELECT 1 FROM bookings WHERE event_id = $1 AND user_id = $2 AND id <> $3 AND status IN ('confirmed', 'checked_in', 'pending_payment')
         AND (status <> 'pending_payment' OR hold_expires_at > now())`, [booking.event_id, booking.user_id, booking.id])).rows[0];
    const qty = booking.quantity || 1;
    let capacityOk = holdActive || (await seatsTaken(c, booking.event_id, booking.id)) + qty <= event.capacity;
    if (capacityOk && !holdActive && booking.ticket_type_id) {
      const tier = (await c.query('SELECT quantity FROM ticket_types WHERE id = $1', [booking.ticket_type_id])).rows[0];
      capacityOk = Boolean(tier) && (await tierSeatsTaken(c, booking.ticket_type_id, booking.id)) + qty <= tier.quantity;
    }
    const eventOk = event.status === 'published';

    if (capacityOk && eventOk && !otherActive) {
      if (booking.status !== 'pending_payment') {
        // Hold had been released; release any other stale pending row for the unique index first.
        await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_replaced'
                        WHERE event_id = $1 AND user_id = $2 AND id <> $3 AND status = 'pending_payment'`, [booking.event_id, booking.user_id, booking.id]);
      }
      await c.query(`UPDATE bookings SET status = 'confirmed', confirmed_at = now(), cancelled_at = NULL, cancel_reason = NULL WHERE id = $1`, [booking.id]);
      const nid = await enqueue(c, { kind: 'booking_confirmed', userId: booking.user_id, bookingId: booking.id, dedupeKey: `bk:${booking.id}:confirmed` });
      await audit(`webhook:${providerName}`, 'booking.confirmed', booking.id, { paymentId: payment.id }, c);
      return finish('confirmed', [nid]);
    }

    // Paid but cannot honour (late payment and event full / cancelled / duplicate booking): never keep the money silently.
    await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), cancel_reason = 'paid_but_unavailable_refund_due' WHERE id = $1`, [booking.id]);
    const nid = await enqueue(c, { kind: 'late_payment_refund_needed', userId: booking.user_id, bookingId: booking.id, dedupeKey: `bk:${booking.id}:refund_needed` });
    await audit(`webhook:${providerName}`, 'booking.refund_needed', booking.id, { paymentId: payment.id, reason: !eventOk ? 'event_not_published' : otherActive ? 'duplicate_booking' : 'capacity' }, c);
    return finish('refund_needed', [nid]);
  });
}

/** Cron: release expired holds (capacity already ignores them; this tidies status). */
export async function releaseExpiredHolds() {
  const r = await db.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_expired'
      WHERE status = 'pending_payment' AND hold_expires_at < now() - interval '5 minutes'`);
  return r.rowCount;
}

/** Cron: ask the provider about payments still 'created' (missed webhooks) and apply the truth. */
export async function reconcilePayments(provider, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT id, provider_txn_id FROM payments
      WHERE provider = $1 AND purpose = 'ticket' AND status = 'created'
        AND created_at < now() - interval '10 minutes' AND created_at > now() - interval '7 days'
      ORDER BY created_at LIMIT $2`, [provider.name, limit]);
  const out = { checked: rows.length, applied: 0, notificationIds: [] };
  for (const p of rows) {
    try {
      const s = await provider.fetchStatus(p.provider_txn_id);
      if (s.status === 'created') continue;
      const type = s.status === 'paid' ? 'paid' : s.status === 'expired' ? 'expired' : 'failed';
      const r = await applyTicketEvent(provider.name, {
        eventId: `reconcile:${p.provider_txn_id}:${type}`, type, providerTxnId: p.provider_txn_id,
        providerPaymentId: s.providerPaymentId, amountPaise: s.amountPaise, reason: 'reconciled'
      });
      if (!['duplicate'].includes(r.result)) out.applied++;
      out.notificationIds.push(...r.notificationIds);
    } catch (err) {
      logger.warn('reconcile failed', { paymentId: p.id, reason: String(err.message).slice(0, 120) });
    }
  }
  return out;
}

/** Bookings for the signed-in user. */
export async function listUserBookings(userId) {
  const { rows } = await db.query(
    `SELECT b.id, b.status, e.title, e.city, e.start_at, e.slug FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.user_id = $1 AND b.status IN ('pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'refunded', 'declined')
        AND NOT (b.status = 'pending_payment' AND b.hold_expires_at < now() - interval '1 day')
      ORDER BY e.start_at DESC LIMIT 50`, [userId]);
  return rows.map((r) => ({ id: r.id, status: r.status, title: r.title, city: r.city, startAt: r.start_at, slug: r.slug }));
}

/**
 * One booking, only if owned by the user. The exact venue, a private venue's map link and the
 * on-ground contact are only included once the booking is confirmed.
 */
export async function getUserBooking(userId, bookingId) {
  const b = await db.one(
    `SELECT b.*, e.title, e.city, e.start_at, e.timezone, e.venue_private, e.venue_privacy, e.area_public, e.maps_url,
            e.pickup_points, e.contact_name, e.contact_phone, t.name AS ticket_name, t.kind AS ticket_kind,
            p.checkout_url, p.is_test, p.status AS payment_status
       FROM bookings b JOIN events e ON e.id = b.event_id
       LEFT JOIN ticket_types t ON t.id = b.ticket_type_id
       LEFT JOIN payments p ON p.id = b.payment_id
      WHERE b.id = $1 AND b.user_id = $2`, [bookingId, userId]);
  if (!b) return null;
  const confirmed = ['confirmed', 'checked_in'].includes(b.status);
  const invite = confirmed
    ? await db.one(`SELECT link, expires_at FROM invite_links WHERE booking_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [b.id])
    : null;
  const pickup = (Array.isArray(b.pickup_points) ? b.pickup_points : []).find((p) => p.id === b.pickup_point_id) || null;
  const phone = confirmed && b.contact_phone ? b.contact_phone : null;
  return {
    id: b.id, status: b.status, title: b.title, city: b.city, startAt: b.start_at, timezone: b.timezone,
    venue: confirmed ? (b.venue_private || null) : null,
    mapsUrl: confirmed || b.venue_privacy === 'public' ? (b.maps_url || null) : null,
    ticket: b.ticket_name ? { name: b.ticket_name, kind: b.ticket_kind, quantity: b.quantity } : null,
    amountLabel: b.amount_paise ? formatPaise(b.amount_paise) : null,
    paymentMode: b.payment_mode,
    paymentStatus: b.payment_status || (b.payment_mode === 'free' ? 'not_required' : null),
    pickup: pickup ? { name: pickup.name, location: pickup.location || '', time: pickup.time || null } : null,
    contact: phone ? { name: b.contact_name, phone, whatsappUrl: `https://wa.me/${phone.replace(/^\+/, '')}` } : null,
    holdActive: b.status === 'pending_payment' && new Date(b.hold_expires_at) > new Date(),
    checkoutUrl: b.status === 'pending_payment' ? b.checkout_url : null,
    isTest: b.payment_id ? b.is_test !== false : false,
    invite: invite ? { link: invite.link, expiresAt: invite.expires_at } : null
  };
}
