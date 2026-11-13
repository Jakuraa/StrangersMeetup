// lib/services/checkout.js - Checkout intents: carry a (possibly anonymous) buyer across to SuperProfile.
//
// "Book Tickets" links to /checkout/:slug. We record an intent with a short random ref, attach the ref
// to the SuperProfile URL, and redirect. When SuperProfile later reports the order with that ref we
// know who bought. Signed-out visitors are redirected too: paying is never gated on signing in, and
// their order is claimed in the bot afterwards.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { ticketProvider } from '../payments/index.js';
import { checkoutForEvent } from '../payments/availability.js';

export const INTENT_TTL_HOURS = 72;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 8 chars of Crockford base32 = 40 random bits. */
export function newRef() {
  const bytes = crypto.randomBytes(5);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((n >> BigInt(i * 5)) & 31n)];
  return out;
}

/**
 * Record an intent for a published, checkout-enabled event and return where to send the buyer.
 * Returns null when this event cannot be bought online (the caller sends them back to the event page).
 */
export async function createCheckoutIntent({ slug, user = null, ticketTypeId = null, qty = 1 }) {
  const event = await db.one(
    `SELECT id, slug, ticketing, checkout_mode, superprofile_url FROM events
      WHERE slug = $1 AND status = 'published' AND start_at > now()`, [slug]);
  if (!event) throw new HttpError(404, 'event_not_found', 'This event is not available');
  if (!checkoutForEvent(event).available) return null;

  const n = Math.min(Math.max(parseInt(qty, 10) || 1, 1), 20);
  let ticket = null;
  if (ticketTypeId) {
    if (!/^[0-9a-f-]{36}$/i.test(ticketTypeId)) throw new HttpError(404, 'ticket_not_found', 'That ticket type is not available');
    ticket = await db.one(`SELECT id, kind, max_per_booking FROM ticket_types WHERE id = $1 AND event_id = $2 AND active`, [ticketTypeId, event.id]);
    if (!ticket || ticket.kind !== 'paid') throw new HttpError(404, 'ticket_not_found', 'That ticket type is not available');
    if (n > ticket.max_per_booking) throw new HttpError(400, 'validation', `Up to ${ticket.max_per_booking} per booking`);
  }

  let intent = null;
  for (let attempt = 0; attempt < 4 && !intent; attempt++) {
    const ref = newRef();
    const r = await db.query(
      `INSERT INTO checkout_intents (ref, user_id, event_id, ticket_type_id, qty, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) ON CONFLICT (ref) DO NOTHING RETURNING ref`,
      [ref, user?.id || null, event.id, ticket?.id || null, n, INTENT_TTL_HOURS]);
    intent = r.rows[0] || null;
  }
  if (!intent) throw new HttpError(503, 'try_again', 'Please try again in a moment');

  await db.query(`INSERT INTO analytics_events (name, event_id) VALUES ('checkout_click', $1)`, [event.id]);
  const { checkoutUrl } = await ticketProvider().createCheckout({ url: event.superprofile_url, ref: intent.ref, slug: event.slug });
  return { url: checkoutUrl, ref: intent.ref };
}

export async function pruneCheckoutIntents() {
  const r = await db.query(`DELETE FROM checkout_intents WHERE expires_at < now() - interval '30 days'`);
  return r.rowCount;
}
