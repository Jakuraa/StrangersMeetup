// lib/services/bookings.js - Booking reads and seat counting. Paid bookings are created only by a
// matched SuperProfile notification (services/orders.js) — never by a client redirect; free tiers
// confirm in services/ticketing.js.
import { db } from '../db.js';
import { SEAT_HOLDING_SQL, formatPaise } from './events.js';

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

/** Cron: release expired seat holds left by approval requests (capacity already ignores them; this tidies status). */
export async function releaseExpiredHolds() {
  const r = await db.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_expired'
      WHERE status = 'pending_payment' AND hold_expires_at < now() - interval '5 minutes'`);
  return r.rowCount;
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
    `SELECT b.*, e.title, e.city, e.start_at, e.timezone, e.venue_private, e.venue_privacy, e.area_public, e.maps_url, e.slug,
            e.pickup_points, e.contact_name, e.contact_phone, t.name AS ticket_name, t.kind AS ticket_kind,
            eo.status AS payment_status
       FROM bookings b JOIN events e ON e.id = b.event_id
       LEFT JOIN ticket_types t ON t.id = b.ticket_type_id
       LEFT JOIN external_orders eo ON eo.matched_booking_id = b.id
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
    slug: b.slug,
    eventId: b.event_id,
    venue: confirmed ? (b.venue_private || null) : null,
    mapsUrl: confirmed || b.venue_privacy === 'public' ? (b.maps_url || null) : null,
    ticket: b.ticket_name ? { name: b.ticket_name, kind: b.ticket_kind, quantity: b.quantity } : null,
    amountLabel: b.amount_paise ? formatPaise(b.amount_paise) : null,
    paymentMode: b.payment_mode,
    paymentStatus: b.payment_status || (b.payment_mode === 'free' ? 'not_required' : null),
    pickup: pickup ? { name: pickup.name, location: pickup.location || '', time: pickup.time || null } : null,
    contact: phone ? { name: b.contact_name, phone, whatsappUrl: `https://wa.me/${phone.replace(/^\+/, '')}` } : null,
    invite: invite ? { link: invite.link, expiresAt: invite.expires_at } : null
  };
}
