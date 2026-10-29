// lib/services/claims.js - Telegram "claim your order" flow for buyers SuperProfile could not tie to a user.
//
// The buyer opens the bot (t.me/<bot>?start=claim), sends their SuperProfile order ID (and optionally
// the email they paid with). One order can be claimed once. Failures all look alike so the bot is no
// oracle for which order IDs exist, and claims are limited to 5 an hour per Telegram user. A short or
// purely numeric order ID (guessable) additionally requires the buyer's email to match.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { rateLimit } from '../ratelimit.js';
import { emailHash } from './superprofile.js';
import { confirmOrderBooking } from './orders.js';

export const CLAIM_LIMIT_PER_HOUR = 5;
export const CLAIM_PROMPT_MINUTES = 10;
export const CLAIM_FAILED_MESSAGE = 'We could not claim that order. Check the order ID (and the email you paid with), or contact support.';

const failed = () => new HttpError(404, 'claim_failed', CLAIM_FAILED_MESSAGE);

export function normaliseOrderId(raw) {
  const id = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{4,100}$/.test(id) ? id : null;
}

/** An order ID someone could plausibly guess by counting. */
export const isGuessableOrderId = (id) => /^\d{1,10}$/.test(id);

export async function startClaimPrompt(userId) {
  await db.query(`UPDATE users SET claim_prompt_until = now() + make_interval(mins => $2) WHERE id = $1`, [userId, CLAIM_PROMPT_MINUTES]);
}

export async function clearClaimPrompt(userId) {
  await db.query('UPDATE users SET claim_prompt_until = NULL WHERE id = $1', [userId]);
}

export async function isClaimPromptOpen(userId) {
  const r = await db.one('SELECT 1 AS x FROM users WHERE id = $1 AND claim_prompt_until > now()', [userId]);
  return Boolean(r);
}

/** Returns { bookingId, notificationIds, eventTitle }; throws HttpError (429 rate limit, 403 age, 404 generic). */
export async function claimOrder(user, rawOrderId, rawEmail = '') {
  await rateLimit(`claim:${user.telegram_user_id}`, CLAIM_LIMIT_PER_HOUR, 3600);
  if (!user.age_confirmed_21) throw new HttpError(403, 'age_required', 'Please confirm you are 21 or older on our website first, then claim your order here.');
  const orderId = normaliseOrderId(rawOrderId);
  if (!orderId) throw failed();
  const email = String(rawEmail || '').trim();
  const givenHash = email ? emailHash(email) : null;
  if (email && !givenHash) throw failed();

  return db.tx(async (c) => {
    const order = (await c.query('SELECT * FROM external_orders WHERE lower(order_id) = lower($1) FOR UPDATE', [orderId])).rows[0];
    if (!order || order.status !== 'paid' || order.matched_booking_id || order.match_state !== 'unmatched' || !order.event_id) throw failed();
    if (isGuessableOrderId(order.order_id) && (!order.buyer_email_hash || givenHash !== order.buyer_email_hash)) throw failed();
    if (givenHash && order.buyer_email_hash && givenHash !== order.buyer_email_hash) throw failed();

    const event = (await c.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [order.event_id])).rows[0];
    if (!event || event.status !== 'published') throw failed();
    const r = await confirmOrderBooking(c, { order, event, userId: user.id, actor: `user:${user.id}` });
    if (r.conflict) throw new HttpError(409, 'duplicate_booking', 'You already have a booking for this event. Send /mybookings to see it, or contact support if you bought extra tickets.');
    // The buyer proved the email by quoting it: later orders from it match without a claim.
    if (givenHash && order.buyer_email_hash === givenHash) await c.query('UPDATE users SET email_hash = $2 WHERE id = $1', [user.id, givenHash]);
    await c.query('UPDATE users SET claim_prompt_until = NULL WHERE id = $1', [user.id]);
    return { bookingId: r.bookingId, notificationIds: [r.notificationId], eventTitle: event.title };
  });
}
