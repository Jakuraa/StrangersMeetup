// lib/services/refunds.js - Finance-initiated refunds (tickets via provider, memberships via Stars).
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { providerByName } from '../payments/index.js';
import { tg } from '../telegram/api.js';
import { enqueue, deliverMany } from './notifications.js';
import { audit } from '../audit.js';
import { removeFromChat, tierChatId } from './invites.js';

export async function refundPayment(paymentId, actor) {
  const p = await db.one(
    `SELECT p.*, u.telegram_user_id FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = $1`, [paymentId]);
  if (!p) throw new HttpError(404, 'not_found', 'Payment not found');
  if (p.status !== 'paid') throw new HttpError(409, 'not_refundable', `Payment is ${p.status}`);

  // Claim the refund atomically so two concurrent clicks cannot refund twice.
  const claim = await db.query(
    `UPDATE payments SET failure_reason = 'refund_in_progress'
      WHERE id = $1 AND status = 'paid' AND failure_reason IS DISTINCT FROM 'refund_in_progress' RETURNING id`, [p.id]);
  if (!claim.rowCount) throw new HttpError(409, 'refund_in_progress', 'A refund for this payment is already in progress');

  try {
    if (p.provider === 'telegram_stars') {
      await tg('refundStarPayment', { user_id: p.telegram_user_id, telegram_payment_charge_id: p.provider_txn_id });
    } else {
      await providerByName(p.provider).refund({
        providerTxnId: p.provider_txn_id, providerPaymentId: p.provider_payment_id, amountPaise: Number(p.amount), refundRef: `rf_${p.id.slice(0, 8)}`
      });
    }
  } catch (err) {
    await db.query(`UPDATE payments SET failure_reason = NULL WHERE id = $1 AND failure_reason = 'refund_in_progress'`, [p.id]);
    throw err.status ? err : new HttpError(502, 'refund_failed', 'The provider rejected the refund. Nothing was changed.');
  }

  const ids = await db.tx(async (c) => {
    await c.query(`UPDATE payments SET status = 'refunded', refunded_at = now(), failure_reason = NULL WHERE id = $1 AND status = 'paid'`, [p.id]);
    const out = [];
    if (p.booking_id) {
      await c.query(`UPDATE bookings SET status = 'refunded', refunded_at = now() WHERE id = $1`, [p.booking_id]);
      await c.query(`UPDATE invite_links SET revoked_at = COALESCE(revoked_at, now()) WHERE booking_id = $1`, [p.booking_id]);
      out.push(await enqueue(c, { kind: 'booking_refunded', userId: p.user_id, bookingId: p.booking_id, dedupeKey: `bk:${p.booking_id}:refunded` }));
    }
    if (p.purpose === 'membership') {
      await c.query(`UPDATE entitlements SET status = 'revoked', revoked_at = now() WHERE last_payment_id = $1 AND status IN ('active', 'grace', 'cancelled')`, [p.id]);
    }
    await audit(actor, 'payment.refunded', p.id, { provider: p.provider, amount: Number(p.amount), bookingId: p.booking_id }, c);
    return out;
  });

  if (p.purpose === 'membership') {
    const ent = await db.one(
      `SELECT t.code, t.telegram_chat_id FROM entitlements en JOIN membership_tiers t ON t.id = en.tier_id WHERE en.last_payment_id = $1`, [p.id]);
    const chat = ent ? tierChatId(ent) : null;
    if (chat) await removeFromChat(chat, p.telegram_user_id).catch(() => {});
  }
  await deliverMany(ids);
  return { ok: true };
}
