// lib/services/upi-payments.js - State machine, lifecycle, and order processing for UPI payments.
// Supports PhonePe Payment Gateway and provider-neutral adapters with atomic PostgreSQL transactions.

import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { livePayments } from '../config.js';
import { phonePeInstance, mockInstance, PhonePeAdapter, PaymentAdapterError } from '../upi/adapter.js';
import { enqueue } from './notifications.js';
import { removeFromChat } from './invites.js';
import { seatsTaken, tierSeatsTaken } from './bookings.js';
import { logger } from '../logger.js';

export const UPI_LEGAL_TRANSITIONS = {
  created: ['pending', 'failed', 'expired', 'cancelled'],
  pending: ['processing', 'succeeded', 'failed', 'expired', 'cancelled'],
  processing: ['pending', 'succeeded', 'failed', 'expired', 'cancelled'],
  succeeded: ['refund_pending', 'refunded', 'disputed'],
  refund_pending: ['refunded', 'failed', 'succeeded'],
  failed: [],
  expired: [],
  cancelled: [],
  refunded: [],
  disputed: ['refunded', 'succeeded']
};

export function isLegalTransition(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true;
  const next = UPI_LEGAL_TRANSITIONS[fromStatus];
  return Boolean(next && next.includes(toStatus));
}

export function newUpiOrderId() {
  return `ORD-UPI-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function getAdapter() {
  if (process.env.UPI_ADAPTER === 'mock' || (process.env.NODE_ENV === 'test' && !process.env.FORCE_PHONEPE)) {
    return mockInstance;
  }
  return phonePeInstance;
}

/**
 * Calculates currently held seats for an event across active, unexpired payment intents.
 */
export async function activePaymentHolds(c, eventId, excludeOrderId = null) {
  const { rows } = await c.query(
    `SELECT COALESCE(sum((p.raw_ref->>'qty')::int), 0)::int AS n
     FROM payments p
     WHERE (p.raw_ref->>'eventId')::uuid = $1
       AND p.status IN ('created', 'pending', 'processing')
       AND p.expires_at > now()
       AND ($2::text IS NULL OR p.order_id <> $2)`,
    [eventId, excludeOrderId]
  );
  return rows[0].n;
}

/**
 * Calculates currently held seats for a ticket tier across active, unexpired payment intents.
 */
export async function activeTierPaymentHolds(c, ticketTypeId, excludeOrderId = null) {
  const { rows } = await c.query(
    `SELECT COALESCE(sum((p.raw_ref->>'qty')::int), 0)::int AS n
     FROM payments p
     WHERE (p.raw_ref->>'ticketTypeId')::uuid = $1
       AND p.status IN ('created', 'pending', 'processing')
       AND p.expires_at > now()
       AND ($2::text IS NULL OR p.order_id <> $2)`,
    [ticketTypeId, excludeOrderId]
  );
  return rows[0].n;
}

/**
 * Creates an internal payment intent, reserves inventory check, and returns deep links + dynamic QR.
 */
export async function createUpiPaymentIntent({
  slug,
  user = null,
  ticketTypeId,
  quantity = 1,
  deviceType = 'desktop',
  clientIp = '127.0.0.1'
}) {
  // Check live payment boundary
  if (!livePayments()) {
    throw new HttpError(403, 'live_payments_disabled', 'Paid checkout is currently disabled.');
  }
  if (process.env.VERCEL_ENV === 'preview' && process.env.ALLOW_PREVIEW_PAID_CHECKOUT !== 'true') {
    throw new HttpError(403, 'preview_paid_checkout_disabled', 'Paid checkout is disabled in Preview deployments.');
  }

  const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 20);

  return db.tx(async (c) => {
    // 1. Fetch and lock event
    const event = (await c.query(
      `SELECT id, slug, title, status, start_at, capacity, checkout_mode FROM events
       WHERE slug = $1 FOR UPDATE`,
      [slug]
    )).rows[0];

    if (!event || event.status !== 'published') {
      throw new HttpError(404, 'event_not_found', 'This event is not available for booking');
    }
    if (new Date(event.start_at) <= new Date()) {
      throw new HttpError(409, 'event_started', 'This event has already started');
    }

    // 2. Fetch ticket tier
    const tier = (await c.query(
      `SELECT id, name, kind, price_paise, quantity, max_per_booking, active FROM ticket_types
       WHERE id = $1 AND event_id = $2 AND active`,
      [ticketTypeId, event.id]
    )).rows[0];

    if (!tier || tier.kind !== 'paid') {
      throw new HttpError(404, 'ticket_not_found', 'That paid ticket type is not available');
    }
    if (qty > tier.max_per_booking) {
      throw new HttpError(400, 'validation', `Up to ${tier.max_per_booking} per booking`);
    }

    // 3. Assert capacity including confirmed bookings AND active payment holds
    const takenEventBookings = await seatsTaken(c, event.id);
    const takenEventHolds = await activePaymentHolds(c, event.id);
    const takenTierBookings = await tierSeatsTaken(c, tier.id);
    const takenTierHolds = await activeTierPaymentHolds(c, tier.id);

    const totalEventTaken = takenEventBookings + takenEventHolds;
    const totalTierTaken = takenTierBookings + takenTierHolds;

    if ((event.capacity - totalEventTaken < qty) || (tier.quantity - totalTierTaken < qty)) {
      throw new HttpError(409, 'sold_out', `${tier.name} is sold out or held by active checkout sessions`);
    }

    // 4. Generate Order ID & call Payment Adapter
    const orderId = newUpiOrderId();
    const guestToken = crypto.randomBytes(24).toString('base64url');
    const amountPaise = tier.price_paise * qty;
    const adapter = getAdapter();
    const resolvedUserId = user?.id || user?.userId || null;

    const intent = await adapter.createPaymentIntent({
      orderId,
      amountPaise,
      eventTitle: event.title,
      userId: resolvedUserId,
      deviceType
    });

    // 5. Insert payment row with guest claim token
    const payment = (await c.query(
      `INSERT INTO payments (
         provider, provider_txn_id, order_id, merchant_id, purpose, user_id, amount, currency,
         status, is_test, payment_method, device_type, upi_intent_url, upi_qr_data, expires_at, raw_ref
       ) VALUES ($1, $2, $3, $4, 'ticket', $5, $6, 'INR', 'pending', $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        adapter instanceof PhonePeAdapter ? 'phonepe' : 'upi_mock',
        intent.providerTxnId,
        orderId,
        adapter.merchantId || 'PGTESTPAYUAT',
        resolvedUserId,
        amountPaise,
        Boolean(adapter.isSandbox),
        deviceType === 'mobile' ? 'upi_intent' : 'upi_qr',
        deviceType,
        intent.upiIntentUrl,
        intent.qrData,
        intent.expiresAt,
        JSON.stringify({ eventId: event.id, ticketTypeId: tier.id, qty, deviceType, guestToken })
      ]
    )).rows[0];

    // 6. Record in immutable audit ledger
    await c.query(
      `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
       VALUES ($1, $2, 'created', 'pending', $3, $4)`,
      [
        payment.id,
        orderId,
        resolvedUserId ? `user:${resolvedUserId}` : `guest:${clientIp}`,
        JSON.stringify({ eventId: event.id, tierId: tier.id, qty, amountPaise, guestToken })
      ]
    );

    return {
      orderId,
      status: 'pending',
      amountPaise,
      amountRupees: (amountPaise / 100).toFixed(2),
      currency: 'INR',
      eventTitle: event.title,
      tierName: tier.name,
      quantity: qty,
      guestToken,
      upiIntentUrl: intent.upiIntentUrl,
      upiUri: intent.upiIntentUrl,
      appIntents: intent.appIntents,
      qrData: intent.qrData,
      qrSvg: intent.qrSvg,
      expiresInSeconds: intent.expiresInSeconds,
      expiresAt: intent.expiresAt
    };
  });
}

/**
 * Checks or polls the status of an existing UPI payment order.
 */
export async function getUpiPaymentStatus(orderId, { user = null, guestToken = null, checkGateway = false } = {}) {
  const payment = await db.one(
    `SELECT p.*, e.title AS event_title, e.slug AS event_slug, b.id AS booking_id
     FROM payments p
     LEFT JOIN events e ON e.id = (p.raw_ref->>'eventId')::uuid
     LEFT JOIN bookings b ON b.id = p.booking_id
     WHERE p.order_id = $1`,
    [orderId]
  );

  if (!payment) {
    throw new HttpError(404, 'order_not_found', 'Payment order not found');
  }

  // AUTH-01: Strict Authorization Check
  let isStaff = false;
  if (user) {
    if (user.role === 'super_admin' || user.role === 'finance') {
      isStaff = true;
    } else if (user.telegram_user_id) {
      const adminRow = await db.one('SELECT role FROM admin_users WHERE telegram_user_id = $1 AND active', [user.telegram_user_id]);
      if (adminRow && ['super_admin', 'finance', 'event_manager', 'support'].includes(adminRow.role)) {
        isStaff = true;
      }
    }
  }

  if (payment.user_id) {
    if (!user) {
      throw new HttpError(401, 'unauthorized', 'Authentication required to view payment status');
    }
    if (payment.user_id !== user.id && !isStaff) {
      throw new HttpError(403, 'forbidden', 'Access denied to this payment order');
    }
  } else {
    // Guest checkout order: must have admin role OR valid guestToken matching raw_ref
    if (!isStaff) {
      const expectedToken = payment.raw_ref?.guestToken;
      if (!expectedToken || !guestToken || !safeEqual(guestToken, expectedToken)) {
        throw new HttpError(403, 'forbidden', 'Access denied to this payment order');
      }
    }
  }

  // Check expiry
  if (['created', 'pending', 'processing'].includes(payment.status)) {
    if (new Date(payment.expires_at) <= new Date()) {
      await db.tx(async (c) => {
        await c.query(`UPDATE payments SET status = 'expired' WHERE id = $1 AND status IN ('created', 'pending', 'processing')`, [payment.id]);
        await c.query(
          `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
           VALUES ($1, $2, $3, 'expired', 'system:expiry', '{}')`,
          [payment.id, orderId, payment.status]
        );
      });
      return { orderId, status: 'expired', message: 'Payment window expired' };
    }

    // Force gateway status check if requested
    if (checkGateway) {
      try {
        const adapter = getAdapter();
        const gatewayStatus = await adapter.getPaymentStatus(orderId, payment.provider_txn_id);
        if (gatewayStatus.status === 'succeeded' && payment.status !== 'succeeded') {
          return applySuccessfulUpiPayment({
            orderId,
            providerPaymentId: gatewayStatus.providerPaymentId,
            verifiedAmountPaise: gatewayStatus.amountPaise,
            actor: 'poll:gateway'
          });
        }
      } catch (err) {
        logger.warn('gateway status poll failed', { orderId, err: err.message });
      }
    }
  }

  return {
    orderId: payment.order_id,
    status: payment.status,
    amountPaise: Number(payment.amount),
    amountRupees: (Number(payment.amount) / 100).toFixed(2),
    currency: payment.currency,
    eventTitle: payment.event_title,
    eventSlug: payment.event_slug,
    bookingId: payment.booking_id || null,
    expiresAt: payment.expires_at,
    paidAt: payment.paid_at || null
  };
}

/**
 * Transitions a payment to succeeded and confirms the attendee booking atomically.
 */
export async function applySuccessfulUpiPayment({
  orderId,
  providerTxnId = null,
  providerPaymentId = null,
  verifiedAmountPaise = null,
  actor = 'webhook:phonepe'
}) {
  return db.tx(async (c) => {
    const payment = (await c.query(
      `SELECT * FROM payments WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    )).rows[0];

    if (!payment) {
      throw new HttpError(404, 'order_not_found', 'Payment not found');
    }

    if (payment.status === 'succeeded') {
      return { orderId, status: 'succeeded', duplicate: true, bookingId: payment.booking_id };
    }

    if (!isLegalTransition(payment.status, 'succeeded')) {
      throw new HttpError(409, 'invalid_transition', `Cannot transition payment from ${payment.status} to succeeded`);
    }

    // FIN-01: Underpayment defense. Verify amount if provided.
    if (verifiedAmountPaise !== null && verifiedAmountPaise !== undefined) {
      const expectedAmount = Number(payment.amount);
      const actualAmount = Number(verifiedAmountPaise);
      if (actualAmount !== expectedAmount) {
        logger.error('Payment amount mismatch detected', {
          orderId,
          expected: expectedAmount,
          actual: actualAmount
        });
        await c.query(
          `UPDATE payments SET
             status = 'disputed',
             failure_reason = 'Amount mismatch: expected ' || $2 || ', got ' || $3,
             webhook_verified_at = now()
           WHERE id = $1`,
          [payment.id, expectedAmount, actualAmount]
        );
        await c.query(
          `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
           VALUES ($1, $2, $3, 'disputed', $4, $5)`,
          [
            payment.id,
            orderId,
            payment.status,
            actor,
            JSON.stringify({ expectedPaise: expectedAmount, verifiedPaise: actualAmount, reason: 'amount_mismatch' })
          ]
        );
        return {
          orderId,
          status: 'disputed',
          amountMismatch: true,
          message: `Payment amount mismatch: expected ${expectedAmount}, received ${actualAmount}`
        };
      }
    }

    const refData = payment.raw_ref || {};
    const eventId = refData.eventId;
    const ticketTypeId = refData.ticketTypeId;
    const qty = refData.qty || 1;

    const event = (await c.query(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId])).rows[0];
    if (!event) throw new HttpError(404, 'event_not_found', 'Event not found');

    // CONCUR-01: Capacity re-check at confirmation
    const taken = await seatsTaken(c, event.id);
    if (event.capacity - taken < qty) {
      logger.error('Capacity exceeded upon payment confirmation', {
        orderId,
        eventId: event.id,
        capacity: event.capacity,
        taken,
        requestedQty: qty
      });
      await c.query(
        `UPDATE payments SET
           status = 'refund_pending',
           failure_reason = 'capacity_exceeded',
           provider_txn_id = COALESCE($2, provider_txn_id),
           provider_payment_id = COALESCE($3, provider_payment_id),
           paid_at = COALESCE(paid_at, now()),
           webhook_verified_at = now()
         WHERE id = $1`,
        [payment.id, providerTxnId, providerPaymentId]
      );
      await c.query(
        `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
         VALUES ($1, $2, $3, 'refund_pending', $4, $5)`,
        [
          payment.id,
          orderId,
          payment.status,
          actor,
          JSON.stringify({ reason: 'capacity_exceeded', capacity: event.capacity, seatsTaken: taken, requestedQty: qty })
        ]
      );
      return {
        orderId,
        status: 'refund_pending',
        overbooked: true,
        message: 'Event sold out before payment confirmation. Queued for refund.'
      };
    }

    if (ticketTypeId) {
      const tier = (await c.query(`SELECT * FROM ticket_types WHERE id = $1 FOR UPDATE`, [ticketTypeId])).rows[0];
      if (tier && tier.capacity) {
        const tierTaken = await tierSeatsTaken(c, tier.id);
        if (tier.capacity - tierTaken < qty) {
          logger.error('Tier capacity exceeded upon payment confirmation', {
            orderId,
            ticketTypeId: tier.id,
            capacity: tier.capacity,
            tierTaken,
            requestedQty: qty
          });
          await c.query(
            `UPDATE payments SET
               status = 'refund_pending',
               failure_reason = 'tier_capacity_exceeded',
               provider_txn_id = COALESCE($2, provider_txn_id),
               provider_payment_id = COALESCE($3, provider_payment_id),
               paid_at = COALESCE(paid_at, now()),
               webhook_verified_at = now()
             WHERE id = $1`,
            [payment.id, providerTxnId, providerPaymentId]
          );
          await c.query(
            `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
             VALUES ($1, $2, $3, 'refund_pending', $4, $5)`,
            [
              payment.id,
              orderId,
              payment.status,
              actor,
              JSON.stringify({ reason: 'tier_capacity_exceeded', capacity: tier.capacity, seatsTaken: tierTaken, requestedQty: qty })
            ]
          );
          return {
            orderId,
            status: 'refund_pending',
            overbooked: true,
            message: 'Tier sold out before payment confirmation. Queued for refund.'
          };
        }
      }
    }

    // DATA-01: Guest checkout handling - when payment.user_id is null, do NOT insert null into bookings table
    if (!payment.user_id) {
      await c.query(
        `UPDATE payments SET
           status = 'succeeded',
           provider_txn_id = COALESCE($2, provider_txn_id),
           provider_payment_id = COALESCE($3, provider_payment_id),
           paid_at = now(),
           webhook_verified_at = now()
         WHERE id = $1`,
        [payment.id, providerTxnId, providerPaymentId]
      );
      await c.query(
        `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
         VALUES ($1, $2, $3, 'succeeded', $4, $5)`,
        [
          payment.id,
          orderId,
          payment.status,
          actor,
          JSON.stringify({ guestClaimRequired: true, providerPaymentId, providerTxnId })
        ]
      );
      await audit(actor, 'payment.succeeded_upi_guest', payment.id, { orderId, amount: payment.amount }, c);

      return {
        orderId,
        status: 'succeeded',
        guestClaimRequired: true,
        bookingId: null
      };
    }

    // Create confirmed booking for authenticated user
    const booking = (await c.query(
      `INSERT INTO bookings (
         event_id, user_id, ticket_type_id, quantity, status, amount_paise,
         payment_mode, source, confirmed_at, payment_id
       ) VALUES ($1, $2, $3, $4, 'confirmed', $5, 'provider', 'site', now(), $6)
       RETURNING *`,
      [event.id, payment.user_id, ticketTypeId, qty, payment.amount, payment.id]
    )).rows[0];

    // Update payment
    await c.query(
      `UPDATE payments SET
         status = 'succeeded',
         provider_txn_id = COALESCE($2, provider_txn_id),
         provider_payment_id = COALESCE($3, provider_payment_id),
         paid_at = now(),
         webhook_verified_at = now(),
         booking_id = $4
       WHERE id = $1`,
      [payment.id, providerTxnId, providerPaymentId, booking.id]
    );

    // Record audit
    await c.query(
      `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
       VALUES ($1, $2, $3, 'succeeded', $4, $5)`,
      [
        payment.id,
        orderId,
        payment.status,
        actor,
        JSON.stringify({ bookingId: booking.id, providerPaymentId, providerTxnId })
      ]
    );

    // Enqueue confirmation notification
    const nid = await enqueue(c, {
      kind: 'booking_confirmed',
      userId: payment.user_id,
      bookingId: booking.id,
      dedupeKey: `bk:${booking.id}:confirmed`
    });

    await audit(actor, 'payment.succeeded_upi', payment.id, { orderId, bookingId: booking.id, amount: payment.amount }, c);

    return {
      orderId,
      status: 'succeeded',
      bookingId: booking.id,
      notificationId: nid
    };
  });
}

/**
 * Claims a guest UPI booking once the user logs in.
 */
export async function claimUpiBooking({ orderId, guestToken, user }) {
  if (!user || !user.id) {
    throw new HttpError(401, 'unauthorized', 'Must be signed in to claim a booking');
  }
  if (!orderId || !guestToken) {
    throw new HttpError(400, 'validation', 'orderId and guestToken are required');
  }

  return db.tx(async (c) => {
    const payment = (await c.query(
      `SELECT * FROM payments WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    )).rows[0];

    if (!payment) {
      throw new HttpError(404, 'order_not_found', 'Payment not found');
    }

    if (payment.booking_id) {
      if (payment.user_id === user.id) {
        return { orderId, status: 'succeeded', bookingId: payment.booking_id, duplicate: true };
      }
      throw new HttpError(409, 'already_claimed', 'This booking has already been claimed');
    }

    if (payment.status !== 'succeeded') {
      throw new HttpError(400, 'payment_not_succeeded', `Payment is in status ${payment.status}, cannot claim`);
    }

    const expectedToken = payment.raw_ref?.guestToken;
    if (!expectedToken || !safeEqual(guestToken, expectedToken)) {
      throw new HttpError(403, 'invalid_token', 'Invalid guest claim token');
    }

    const refData = payment.raw_ref || {};
    const eventId = refData.eventId;
    const ticketTypeId = refData.ticketTypeId;
    const qty = refData.qty || 1;

    const event = (await c.query(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId])).rows[0];
    if (!event) throw new HttpError(404, 'event_not_found', 'Event not found');

    const booking = (await c.query(
      `INSERT INTO bookings (
         event_id, user_id, ticket_type_id, quantity, status, amount_paise,
         payment_mode, source, confirmed_at, payment_id
       ) VALUES ($1, $2, $3, $4, 'confirmed', $5, 'provider', 'site', now(), $6)
       RETURNING *`,
      [event.id, user.id, ticketTypeId, qty, payment.amount, payment.id]
    )).rows[0];

    await c.query(
      `UPDATE payments SET user_id = $2, booking_id = $3 WHERE id = $1`,
      [payment.id, user.id, booking.id]
    );

    await c.query(
      `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
       VALUES ($1, $2, $3, $3, $4, $5)`,
      [
        payment.id,
        orderId,
        payment.status,
        `user:${user.id}`,
        JSON.stringify({ action: 'guest_claimed', bookingId: booking.id })
      ]
    );

    const nid = await enqueue(c, {
      kind: 'booking_confirmed',
      userId: user.id,
      bookingId: booking.id,
      dedupeKey: `bk:${booking.id}:confirmed`
    });

    await audit(`user:${user.id}`, 'payment.claimed_guest', payment.id, { orderId, bookingId: booking.id }, c);

    return {
      orderId,
      status: 'succeeded',
      bookingId: booking.id,
      notificationId: nid,
      claimed: true
    };
  });
}

/**
 * Ingests, verifies, and processes incoming UPI provider webhooks.
 */
export async function processUpiWebhook({ headers, rawBody, clientIp }) {
  const adapter = getAdapter();
  const verified = adapter.verifyWebhook(headers, rawBody);

  const orderId = verified.orderId;
  const status = verified.status;

  if (status === 'succeeded') {
    try {
      const res = await applySuccessfulUpiPayment({
        orderId,
        providerTxnId: verified.providerTxnId,
        providerPaymentId: verified.providerPaymentId,
        verifiedAmountPaise: verified.amountPaise,
        actor: `webhook:${verified.provider}`
      });
      if (res.status === 'disputed') {
        return { ok: false, error: 'amount_mismatch', orderId, message: res.message };
      }
      return {
        ok: true,
        result: res.duplicate ? 'duplicate' : (res.overbooked ? 'overbooked' : 'confirmed'),
        orderId,
        bookingId: res.bookingId || null,
        guestClaimRequired: res.guestClaimRequired || false
      };
    } catch (err) {
      if (err.code === 'amount_mismatch' || err.status === 400) {
        return { ok: false, error: 'amount_mismatch', orderId, message: err.message };
      }
      throw err;
    }
  }

  // Handle failure / cancellation
  await db.tx(async (c) => {
    const payment = (await c.query(`SELECT * FROM payments WHERE order_id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!payment) return;
    if (isLegalTransition(payment.status, status)) {
      await c.query(
        `UPDATE payments SET status = $2, failure_reason = $3, webhook_verified_at = now() WHERE id = $1`,
        [payment.id, status, verified.rawStatus || 'Webhook reported failure']
      );
      await c.query(
        `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [payment.id, orderId, payment.status, status, `webhook:${verified.provider}`, JSON.stringify(verified.raw || {})]
      );
    }
  });

  return { ok: true, result: status, orderId };
}

/**
 * Initiates and executes a refund for a UPI payment.
 */
export async function refundUpiOrder(orderId, { actor = 'admin:finance', reason = 'Customer requested refund' } = {}) {
  const adapter = getAdapter();

  return db.tx(async (c) => {
    const payment = (await c.query(`SELECT * FROM payments WHERE order_id = $1 FOR UPDATE`, [orderId])).rows[0];
    if (!payment) throw new HttpError(404, 'order_not_found', 'Payment not found');
    if (payment.status !== 'succeeded') {
      throw new HttpError(409, 'not_refundable', `Cannot refund payment in status ${payment.status}`);
    }

    // Call adapter
    const refundRes = await adapter.initiateRefund({
      orderId,
      amountPaise: Number(payment.amount),
      reason
    });

    // Update payment
    await c.query(
      `UPDATE payments SET status = 'refunded', refunded_at = now(), refund_ref = $2 WHERE id = $1`,
      [payment.id, refundRes.refundId]
    );

    // Record audit
    await c.query(
      `INSERT INTO payment_audits (payment_id, order_id, from_status, to_status, actor, details)
       VALUES ($1, $2, 'succeeded', 'refunded', $3, $4)`,
      [payment.id, orderId, actor, JSON.stringify({ refundId: refundRes.refundId, reason })]
    );

    // Reversal effects on booking & invite links
    if (payment.booking_id) {
      await c.query(`UPDATE bookings SET status = 'refunded', refunded_at = now() WHERE id = $1`, [payment.booking_id]);
      await c.query(`UPDATE invite_links SET revoked_at = COALESCE(revoked_at, now()) WHERE booking_id = $1 AND used_at IS NULL`, [payment.booking_id]);

      const joined = (await c.query(
        `SELECT i.chat_id, u.telegram_user_id FROM invite_links i JOIN users u ON u.id = i.user_id
         WHERE i.booking_id = $1 AND i.used_at IS NOT NULL AND i.revoked_at IS NULL LIMIT 1`,
        [payment.booking_id]
      )).rows[0];

      if (joined) {
        await removeFromChat(joined.chat_id, joined.telegram_user_id).catch(() => {});
        await c.query(`UPDATE invite_links SET revoked_at = now() WHERE booking_id = $1 AND revoked_at IS NULL`, [payment.booking_id]);
      }

      await enqueue(c, {
        kind: 'booking_refunded',
        userId: payment.user_id,
        bookingId: payment.booking_id,
        dedupeKey: `bk:${payment.booking_id}:refunded`
      });
    }

    await audit(actor, 'payment.refunded_upi', payment.id, { orderId, amount: payment.amount, reason }, c);

    return {
      orderId,
      status: 'refunded',
      refundId: refundRes.refundId
    };
  });
}
