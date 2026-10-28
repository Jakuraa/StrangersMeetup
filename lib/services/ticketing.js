// lib/services/ticketing.js - Booking organiser events with ticket tiers.
//
// Inventory is decided inside one transaction holding the event row lock (same lock order as
// services/bookings.js: events, then bookings), so concurrent bookings cannot oversell an event or
// a tier. Free tiers confirm without any payment. Paid tiers need a configured provider
// (payments/availability.js); otherwise they are refused — never "assumed paid". Approval only
// moves a request forward; it never marks anything as paid.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { z } from '../validate.js';
import { audit } from '../audit.js';
import { enqueue } from './notifications.js';
import { seatsTaken, tierSeatsTaken, startCheckout, HOLD_MINUTES } from './bookings.js';
import { ticketCheckoutProvider } from '../payments/availability.js';
import { isOrganiser } from './organiser.js';

/** How long an approved guest has to complete a paid checkout. */
export const APPROVAL_HOLD_HOURS = 24;
const LIVE = ['pending_approval', 'pending_payment', 'confirmed', 'checked_in'];

export const TierBookingBody = z.object({
  ticketTypeId: z.string().uuid(),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
  answers: z.record(z.string().max(40), z.union([z.string().max(2000), z.array(z.string().max(80)).max(12)])).default({}),
  pickupPointId: z.string().max(40).nullable().optional(),
  eligibilityConfirmed: z.boolean().optional()
}).strict();

/** Check answers against the event's questions. Returns cleaned answers or throws 400 with fields. */
export function validateAnswers(questions, answers) {
  const fields = [];
  const out = {};
  for (const q of questions || []) {
    const v = answers[q.id];
    if (q.type === 'multi') {
      const picked = Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : [];
      if (picked.some((x) => !q.options.includes(x))) fields.push({ field: `answers.${q.id}`, message: `${q.label}: choose from the listed options` });
      else if (q.required && !picked.length) fields.push({ field: `answers.${q.id}`, message: `${q.label} is required` });
      else if (picked.length) out[q.id] = picked;
      continue;
    }
    const s = typeof v === 'string' ? v.trim() : '';
    if (q.required && !s) { fields.push({ field: `answers.${q.id}`, message: `${q.label} is required` }); continue; }
    if (!s) continue;
    if (q.type === 'single' && !q.options.includes(s)) fields.push({ field: `answers.${q.id}`, message: `${q.label}: choose one of the listed options` });
    else if (q.type === 'short' && s.length > 200) fields.push({ field: `answers.${q.id}`, message: `${q.label}: keep it under 200 characters` });
    else out[q.id] = s;
  }
  if (fields.length) throw new HttpError(400, 'validation', 'Please answer the required questions', { fields });
  return out;
}

async function assertSeats(c, event, tier, qty, excludeBookingId = null) {
  const eventLeft = event.capacity - await seatsTaken(c, event.id, excludeBookingId);
  const tierLeft = tier.quantity - await tierSeatsTaken(c, tier.id, excludeBookingId);
  if (tierLeft < qty || eventLeft < qty) {
    const left = Math.max(0, Math.min(tierLeft, eventLeft));
    throw new HttpError(409, 'sold_out', left > 0 ? `Only ${left} ${tier.name} ticket${left === 1 ? '' : 's'} left` : `${tier.name} is sold out`);
  }
}

/**
 * Book (or request) a tier. Returns { bookingId, status, checkoutUrl? }.
 * status: confirmed (free), pending_approval (host approves), pending_payment (paid checkout).
 */
export async function bookTier(user, eventId, body) {
  if (!user.age_confirmed_21) throw new HttpError(403, 'age_required', 'Please confirm you are 21 or older');
  const placed = await db.tx(async (c) => {
    const event = (await c.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [eventId])).rows[0];
    if (!event || event.status !== 'published') throw new HttpError(404, 'event_not_found', 'This event is not available');
    if (event.ticketing !== 'tiers') throw new HttpError(409, 'not_tiered', 'This event uses the standard booking button');
    if (new Date(event.start_at) <= new Date()) throw new HttpError(409, 'event_started', 'This event has already started');
    const tier = (await c.query('SELECT * FROM ticket_types WHERE id = $1 AND event_id = $2 AND active', [body.ticketTypeId, eventId])).rows[0];
    if (!tier) throw new HttpError(404, 'ticket_not_found', 'That ticket type is not available');
    const qty = body.quantity;
    if (qty > tier.max_per_booking) throw new HttpError(400, 'validation', `Up to ${tier.max_per_booking} ${tier.name} ticket${tier.max_per_booking === 1 ? '' : 's'} per booking`, { fields: [{ field: 'quantity', message: 'Too many tickets' }] });
    if (tier.eligibility && !body.eligibilityConfirmed) {
      throw new HttpError(400, 'validation', `Please confirm you meet this ticket’s eligibility: ${tier.eligibility}`, { fields: [{ field: 'eligibilityConfirmed', message: 'Required' }] });
    }
    const answers = validateAnswers(event.booking_questions, body.answers || {});
    const pickups = Array.isArray(event.pickup_points) ? event.pickup_points : [];
    if (pickups.length && !pickups.some((p) => p.id === body.pickupPointId)) {
      throw new HttpError(400, 'validation', 'Choose a pickup point', { fields: [{ field: 'pickupPointId', message: 'Required' }] });
    }
    const paid = tier.kind === 'paid';
    const provider = paid ? ticketCheckoutProvider() : null;
    if (paid && !provider) throw new HttpError(409, 'payment_unavailable', 'Online payment is not available for this ticket yet. Free tickets can still be booked.');

    const prior = (await c.query(
      `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 AND status IN ('pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'declined')
        ORDER BY created_at DESC FOR UPDATE`, [eventId, user.id])).rows;
    if (prior.some((b) => b.status === 'declined') && !prior.some((b) => LIVE.includes(b.status))) {
      throw new HttpError(409, 'declined', 'The host did not approve your request for this event.');
    }
    const live = prior.find((b) => LIVE.includes(b.status));
    if (live) {
      const staleHold = live.status === 'pending_payment' && new Date(live.hold_expires_at) <= new Date();
      if (!staleHold) return { booking: live, existing: true };
      await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_replaced' WHERE id = $1`, [live.id]);
    }

    await assertSeats(c, event, tier, qty);
    const common = [eventId, user.id, tier.id, qty, JSON.stringify(answers), body.pickupPointId || null, tier.price_paise * qty];
    if (event.requires_approval) {
      // A request holds no seat; availability is re-checked when the host approves.
      const b = (await c.query(
        `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, answers, pickup_point_id, amount_paise, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval') RETURNING *`, common)).rows[0];
      const nid = await notifyHost(c, event, b);
      await audit(`user:${user.id}`, 'booking.request', b.id, { eventId, tier: tier.id, qty }, c);
      return { booking: b, notificationIds: nid ? [nid] : [] };
    }
    if (!paid) {
      const b = (await c.query(
        `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, answers, pickup_point_id, amount_paise, status, payment_mode, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', 'free', now()) RETURNING *`, common)).rows[0];
      const nid = await enqueue(c, { kind: 'booking_confirmed', userId: user.id, bookingId: b.id, dedupeKey: `bk:${b.id}:confirmed` });
      await audit(`user:${user.id}`, 'booking.confirmed_free', b.id, { eventId, tier: tier.id, qty }, c);
      return { booking: b, notificationIds: [nid] };
    }
    const b = (await c.query(
      `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, answers, pickup_point_id, amount_paise, status, payment_mode, hold_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_payment', 'provider', now() + make_interval(mins => $8)) RETURNING *`, [...common, HOLD_MINUTES])).rows[0];
    return { booking: b, event, provider };
  });

  const { booking } = placed;
  if (placed.existing) {
    const url = booking.status === 'pending_payment'
      ? (await db.one('SELECT checkout_url FROM payments WHERE id = $1', [booking.payment_id]))?.checkout_url || null : null;
    return { bookingId: booking.id, status: booking.status, existing: true, checkoutUrl: url };
  }
  if (placed.provider) {
    const checkoutUrl = await startCheckout(user.id, booking, placed.event, placed.provider);
    return { bookingId: booking.id, status: 'pending_payment', checkoutUrl, notificationIds: [] };
  }
  return { bookingId: booking.id, status: booking.status, notificationIds: placed.notificationIds };
}

async function notifyHost(c, event, booking) {
  if (!event.organiser_user_id) return null;
  return enqueue(c, { kind: 'booking_request', userId: event.organiser_user_id, bookingId: booking.id, eventId: event.id, dedupeKey: `req:${booking.id}` });
}

// ---------- organiser side ----------

/** The event, if this user may manage it (its organiser, or an events admin). */
export async function manageableEvent(user, eventId, c = db, { lock = false } = {}) {
  const e = (await c.query(`SELECT * FROM events WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [eventId])).rows[0];
  if (!e) throw new HttpError(404, 'not_found', 'Event not found');
  if (e.organiser_user_id === user.id && await isOrganiser(user, c)) return e;
  const admin = (await c.query(`SELECT role FROM admin_users WHERE telegram_user_id = $1 AND active`, [user.telegram_user_id])).rows[0];
  if (admin && ['super_admin', 'event_manager'].includes(admin.role)) return e;
  throw new HttpError(404, 'not_found', 'Event not found');
}

/**
 * Approve or decline a request. Approving a free ticket confirms it (if seats remain). Approving a
 * paid ticket only opens checkout — the booking is confirmed later by the verified payment webhook.
 */
export async function decideRequest(user, bookingId, decision) {
  const r = await db.tx(async (c) => {
    const ref = (await c.query('SELECT event_id FROM bookings WHERE id = $1', [bookingId])).rows[0];
    if (!ref) throw new HttpError(404, 'not_found', 'Booking not found');
    const event = await manageableEvent(user, ref.event_id, c, { lock: true });
    const b = (await c.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])).rows[0];
    if (b.status !== 'pending_approval') throw new HttpError(409, 'not_pending', 'This request has already been decided');
    if (decision === 'decline') {
      await c.query(`UPDATE bookings SET status = 'declined', decided_at = now(), decided_by = $2 WHERE id = $1`, [b.id, user.id]);
      const nid = await enqueue(c, { kind: 'booking_declined', userId: b.user_id, bookingId: b.id, dedupeKey: `bk:${b.id}:declined` });
      await audit(`user:${user.id}`, 'booking.decline', b.id, { eventId: event.id }, c);
      return { status: 'declined', notificationIds: [nid] };
    }
    if (event.status !== 'published' || new Date(event.start_at) <= new Date()) throw new HttpError(409, 'event_closed', 'This event is no longer open for bookings');
    const tier = (await c.query('SELECT * FROM ticket_types WHERE id = $1', [b.ticket_type_id])).rows[0];
    await assertSeats(c, event, tier, b.quantity, b.id);
    if (tier.kind === 'free') {
      await c.query(`UPDATE bookings SET status = 'confirmed', payment_mode = 'free', confirmed_at = now(), decided_at = now(), decided_by = $2 WHERE id = $1`, [b.id, user.id]);
      const nid = await enqueue(c, { kind: 'booking_confirmed', userId: b.user_id, bookingId: b.id, dedupeKey: `bk:${b.id}:confirmed` });
      await audit(`user:${user.id}`, 'booking.approve', b.id, { eventId: event.id, confirmed: true }, c);
      return { status: 'confirmed', notificationIds: [nid] };
    }
    const provider = ticketCheckoutProvider();
    if (!provider) throw new HttpError(409, 'payment_unavailable', 'Online payment is not available yet, so a paid request cannot be approved. The request stays pending.');
    const held = (await c.query(
      `UPDATE bookings SET status = 'pending_payment', payment_mode = 'provider', hold_expires_at = now() + make_interval(hours => $3),
              decided_at = now(), decided_by = $2 WHERE id = $1 RETURNING *`, [b.id, user.id, APPROVAL_HOLD_HOURS])).rows[0];
    await audit(`user:${user.id}`, 'booking.approve', b.id, { eventId: event.id, awaitingPayment: true }, c);
    return { status: 'pending_payment', booking: held, event, provider };
  });
  if (r.provider) {
    // If checkout cannot be created, the request returns to pending rather than being lost.
    await startCheckout(r.booking.user_id, r.booking, r.event, r.provider, {
      onFail: (id) => db.query(`UPDATE bookings SET status = 'pending_approval', hold_expires_at = NULL, decided_at = NULL, decided_by = NULL WHERE id = $1`, [id])
    });
    const nid = await db.tx((c) => enqueue(c, { kind: 'booking_approved_pay', userId: r.booking.user_id, bookingId: r.booking.id, dedupeKey: `bk:${r.booking.id}:approved` }));
    return { status: 'pending_payment', notificationIds: [nid] };
  }
  return r;
}

/** Guests of an event for its organiser: answers, ticket, pickup and approval status. */
export async function listEventGuests(user, eventId) {
  const event = await manageableEvent(user, eventId);
  const { rows } = await db.query(
    `SELECT b.id, b.status, b.quantity, b.answers, b.pickup_point_id, b.payment_mode, b.created_at, b.confirmed_at, b.checked_in_at, b.decided_at,
            t.name AS ticket, t.kind, u.alias, p.status AS payment_status
       FROM bookings b JOIN users u ON u.id = b.user_id
       LEFT JOIN ticket_types t ON t.id = b.ticket_type_id
       LEFT JOIN payments p ON p.id = b.payment_id
      WHERE b.event_id = $1 AND b.status IN ('pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'declined')
      ORDER BY b.created_at`, [eventId]);
  const questions = Array.isArray(event.booking_questions) ? event.booking_questions : [];
  const pickups = Array.isArray(event.pickup_points) ? event.pickup_points : [];
  return {
    event: { id: event.id, title: event.title, status: event.status, startAt: event.start_at, requiresApproval: event.requires_approval, capacity: event.capacity },
    questions: questions.map((q) => ({ id: q.id, label: q.label })),
    guests: rows.map((r) => ({
      id: r.id, ref: r.id.slice(0, 8), alias: r.alias || 'Guest', status: r.status, ticket: r.ticket, kind: r.kind, quantity: r.quantity,
      paymentStatus: r.payment_mode === 'free' ? 'not_required' : r.payment_status || (r.kind === 'paid' ? 'unpaid' : 'not_required'),
      answers: r.answers || {}, pickup: pickups.find((p) => p.id === r.pickup_point_id)?.name || null,
      createdAt: r.created_at, decidedAt: r.decided_at, checkedInAt: r.checked_in_at
    }))
  };
}
