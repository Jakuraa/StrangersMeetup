// lib/services/direct-upi.js - Direct Organiser UPI Payment Integration.
// Direct peer-to-peer payments between attendees and event organisers.
// NIGHTLIFEZ does not receive, hold, split, or control ticket payments.

import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { validateUpiId, validatePayeeName, UPI_REGEX } from './payment-settings.js';
import { generateQrSvg, buildUpiUri } from '../upi/qr.js';
import { buildAppIntents } from '../upi/adapter.js';
import { seatsTaken, tierSeatsTaken } from './bookings.js';
import { issueTicketsForBooking } from './tickets.js';
import { enqueue } from './notifications.js';
import { can } from './permissions.js';
import { calculateBookingPrice, createBookingPriceSnapshot } from './pricing-engine.js';
import { recordOfferRedemption } from './event-offers.js';
import { assertAndRecordPhaseSale } from './sales-phases.js';

export const DIRECT_UPI_STATUSES = [
  'awaiting_payment',
  'payment_reported',
  'payment_under_review',
  'payment_confirmed',
  'payment_rejected',
  'expired',
  'cancelled'
];

export const DIRECT_UPI_HOLD_MINUTES = 30;

export function generateBookingRef() {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `NLZ-${Date.now().toString(36).toUpperCase().slice(-4)}-${rand}`;
}

export function sanitizeUtr(raw) {
  const clean = String(raw || '').trim().replace(/\s+/g, '');
  if (!clean) throw new HttpError(400, 'invalid_utr', 'Please provide a valid payment reference or UTR number.');
  if (clean.length < 6 || clean.length > 50) {
    throw new HttpError(400, 'invalid_utr', 'Payment reference / UTR must be between 6 and 50 characters.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new HttpError(400, 'invalid_utr', 'Payment reference / UTR contains invalid characters.');
  }
  return clean;
}

/**
 * Creates or retrieves a pending direct UPI booking, reserving inventory with row locks.
 */
export async function createDirectUpiBooking({
  slug,
  user,
  ticketTypeId,
  quantity = 1,
  answers = {},
  pickupPointId = null,
  sectionId = null,
  phaseId = null,
  promoCode = null,
  offerId = null,
  accessCode = null
}) {
  if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in to book tickets.');
  if (!user.age_confirmed_21) throw new HttpError(403, 'age_required', 'Please confirm you are 21 or older.');

  const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), 20);

  return db.tx(async (c) => {
    // 1. Lock and validate event
    const event = (await c.query(
      `SELECT id, slug, title, status, start_at, capacity, payment_method, checkout_mode,
              organiser_user_id, organiser_upi_id, organiser_payee_name, payment_instructions,
              booking_questions, pickup_points, requires_approval, refund_policy, features
         FROM events
        WHERE slug = $1 FOR UPDATE`,
      [slug]
    )).rows[0];

    if (!event || event.status !== 'published') {
      throw new HttpError(404, 'event_not_found', 'This event is not available for booking.');
    }
    if (new Date(event.start_at) <= new Date()) {
      throw new HttpError(409, 'event_started', 'This event has already started.');
    }
    if (event.payment_method !== 'direct_upi' && event.checkout_mode !== 'upi_direct') {
      throw new HttpError(400, 'invalid_payment_method', 'This event is not configured for direct UPI payment.');
    }
    if (!event.organiser_upi_id || !event.organiser_payee_name) {
      throw new HttpError(409, 'organiser_payment_not_configured', 'Organiser has not configured payment details.');
    }

    // 2. Lock and validate ticket tier
    const tier = (await c.query(
      `SELECT id, name, kind, price_paise, quantity, max_per_booking, min_per_booking,
              category, admit_count, session_id, valid_on, sales_start_at, sales_end_at, active, eligibility
         FROM ticket_types
        WHERE id = $1 AND event_id = $2 AND active FOR UPDATE`,
      [ticketTypeId, event.id]
    )).rows[0];

    if (!tier || tier.kind !== 'paid') {
      throw new HttpError(404, 'ticket_not_found', 'That paid ticket type is not available.');
    }
    const minPerBooking = tier.min_per_booking || 1;
    if (qty < minPerBooking) {
      throw new HttpError(400, 'validation', `At least ${minPerBooking} ticket${minPerBooking === 1 ? '' : 's'} required per booking.`);
    }
    if (qty > tier.max_per_booking) {
      throw new HttpError(400, 'validation', `Up to ${tier.max_per_booking} tickets per booking.`);
    }
    if (tier.sales_start_at && new Date(tier.sales_start_at) > new Date()) {
      throw new HttpError(409, 'sales_not_started', 'Ticket sales have not started yet.');
    }
    if (tier.sales_end_at && new Date(tier.sales_end_at) < new Date()) {
      throw new HttpError(409, 'sales_ended', 'Ticket sales have ended.');
    }

    const admitCount = Number.isInteger(tier.admit_count) && tier.admit_count > 0
      ? tier.admit_count
      : (tier.category === 'couple' ? 2 : (tier.category === 'group' ? 4 : 1));
    const eventSeatsNeeded = qty * admitCount;

    // 3. Check for existing active booking for this user
    const prior = (await c.query(
      `SELECT * FROM bookings
        WHERE event_id = $1 AND user_id = $2
          AND status IN ('pending_payment', 'confirmed', 'checked_in', 'pending_approval')
        ORDER BY created_at DESC FOR UPDATE`,
      [event.id, user.id]
    )).rows;

    const activeConfirmed = prior.find((b) => ['confirmed', 'checked_in'].includes(b.status));
    if (activeConfirmed) {
      throw new HttpError(409, 'already_booked', 'You already have a confirmed booking for this event.');
    }

    // Clean up stale / expired holds from this user so they can place a new booking
    for (const b of prior) {
      if (b.status === 'pending_payment') {
        const isExpired = !b.hold_expires_at || new Date(b.hold_expires_at) <= new Date();
        if (isExpired) {
          if (b.phase_id) {
            await c.query(
              `UPDATE event_sales_phases SET tickets_sold = GREATEST(0, tickets_sold - $2), updated_at = now() WHERE id = $1`,
              [b.phase_id, b.quantity]
            );
          }
          if (b.offer_id) {
            await c.query(
              `UPDATE event_offers SET redemption_count = GREATEST(0, redemption_count - 1), updated_at = now() WHERE id = $1`,
              [b.offer_id]
            );
            await c.query(`DELETE FROM offer_redemptions WHERE booking_id = $1`, [b.id]);
          }
          await c.query(
            `UPDATE bookings
                SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_expired',
                    direct_upi_status = 'expired'
              WHERE id = $1`,
            [b.id]
          );
        } else {
          // Live unexpired hold exists for this user: return it if matching tier, or cancel to replace
          if (b.ticket_type_id === tier.id && b.quantity === qty && !promoCode && !offerId && !sectionId) {
            return formatDirectUpiOrder(b, event, tier);
          }
          if (b.phase_id) {
            await c.query(
              `UPDATE event_sales_phases SET tickets_sold = GREATEST(0, tickets_sold - $2), updated_at = now() WHERE id = $1`,
              [b.phase_id, b.quantity]
            );
          }
          if (b.offer_id) {
            await c.query(
              `UPDATE event_offers SET redemption_count = GREATEST(0, redemption_count - 1), updated_at = now() WHERE id = $1`,
              [b.offer_id]
            );
            await c.query(`DELETE FROM offer_redemptions WHERE booking_id = $1`, [b.id]);
          }
          await c.query(
            `UPDATE bookings
                SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'hold_replaced',
                    direct_upi_status = 'cancelled'
              WHERE id = $1`,
            [b.id]
          );
        }
      }
    }

    // 4. Assert capacity including confirmed bookings and active unexpired holds
    const takenSeats = await seatsTaken(c, event.id);
    const tierTaken = await tierSeatsTaken(c, tier.id);

    if (event.capacity - takenSeats < eventSeatsNeeded || tier.quantity - tierTaken < qty) {
      const left = Math.max(0, Math.min(tier.quantity - tierTaken, Math.floor((event.capacity - takenSeats) / admitCount)));
      throw new HttpError(409, 'sold_out', left > 0 ? `Only ${left} ${tier.name} ticket${left === 1 ? '' : 's'} left.` : `${tier.name} is sold out.`);
    }

    // 5. Server-side unified pricing calculation (never trust client)
    const pricing = await calculateBookingPrice({
      c,
      event,
      tier,
      sectionId,
      phaseId,
      quantity: qty,
      promoCode,
      offerId,
      userId: user.id,
      accessCode
    });

    if (pricing.activePhase) {
      await assertAndRecordPhaseSale(c, pricing.activePhase.id, qty);
    }

    const totalAmountPaise = pricing.finalPaise;
    const bookingRef = generateBookingRef();
    const holdExpiresAt = new Date(Date.now() + DIRECT_UPI_HOLD_MINUTES * 60 * 1000);

    // 6. Insert pending booking
    const booking = (await c.query(
      `INSERT INTO bookings (
         event_id, user_id, ticket_type_id, quantity, admit_count, amount_paise,
         status, payment_mode, direct_upi_status, booking_ref, hold_expires_at,
         answers, pickup_point_id, section_id, phase_id, offer_id, discount_paise,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment', 'direct_upi', 'awaiting_payment', $7, $8, $9, $10, $11, $12, $13, $14, now(), now())
       RETURNING *`,
      [
        event.id,
        user.id,
        tier.id,
        qty,
        admitCount,
        totalAmountPaise,
        bookingRef,
        holdExpiresAt,
        JSON.stringify(answers || {}),
        pickupPointId || null,
        pricing.section ? pricing.section.id : null,
        pricing.activePhase ? pricing.activePhase.id : null,
        pricing.appliedOffer ? pricing.appliedOffer.id : null,
        pricing.discountPaise
      ]
    )).rows[0];

    // Record offer redemption if applicable
    if (pricing.appliedOffer) {
      await recordOfferRedemption(c, {
        offerId: pricing.appliedOffer.id,
        eventId: event.id,
        bookingId: booking.id,
        userId: user.id,
        discountPaise: pricing.discountPaise
      });
    }

    // Save immutable booking price snapshot
    await createBookingPriceSnapshot(c, {
      bookingId: booking.id,
      eventId: event.id,
      pricing
    });

    // 7. Audit log initial booking creation
    await c.query(
      `INSERT INTO direct_upi_payment_audits (
         booking_id, event_id, actor_user_id, actor_role, from_status, to_status,
         amount_paise, notes, metadata
       ) VALUES ($1, $2, $3, 'attendee', NULL, 'awaiting_payment', $4, 'Booking initiated with dynamic UPI intent', $5)`,
      [
        booking.id,
        event.id,
        user.id,
        totalAmountPaise,
        JSON.stringify({
          bookingRef,
          organiserUpiId: event.organiser_upi_id,
          qty,
          tierId: tier.id,
          discountPaise: pricing.discountPaise,
          breakdown: pricing.breakdown
        })
      ]
    );

    return formatDirectUpiOrder(booking, event, tier, pricing.breakdown);
  });
}

/**
 * Format order response with safe UPI intent link and dynamic QR.
 */
export function formatDirectUpiOrder(booking, event, tier, breakdown = null) {
  const amountPaise = Number(booking.amount_paise);
  const amountRupees = (amountPaise / 100).toFixed(2);
  const bookingRef = booking.booking_ref || `NLZ-${booking.id.slice(0, 8).toUpperCase()}`;

  const note = `Pass ${bookingRef} - ${event.title}`.slice(0, 50);

  const upiIntentUrl = buildUpiUri({
    vpa: event.organiser_upi_id,
    name: event.organiser_payee_name,
    amountPaise,
    orderId: bookingRef,
    note
  });

  const qrSvg = generateQrSvg(upiIntentUrl, { size: 280 });
  const appIntents = buildAppIntents(upiIntentUrl);

  return {
    bookingId: booking.id,
    bookingRef,
    orderId: bookingRef,
    status: booking.direct_upi_status || 'awaiting_payment',
    bookingStatus: booking.status,
    amountPaise,
    amountRupees,
    quantity: booking.quantity,
    ticketName: tier.name,
    ticketTypeId: tier.id,
    eventName: event.title,
    eventSlug: event.slug,
    eventCity: event.city,
    organiserUpiId: event.organiser_upi_id,
    organiserPayeeName: event.organiser_payee_name,
    paymentInstructions: event.payment_instructions || null,
    upiIntentUrl,
    qrSvg,
    appIntents,
    holdExpiresAt: booking.hold_expires_at,
    expiresAt: booking.hold_expires_at ? new Date(booking.hold_expires_at).toISOString() : null,
    pricing: breakdown || (booking.discount_paise ? {
      subtotalPaise: amountPaise + Number(booking.discount_paise),
      discountPaise: Number(booking.discount_paise),
      finalPayablePaise: amountPaise
    } : null),
    utrReference: booking.utr_reference || null,
    disclaimer: "Your payment goes directly to the event organiser's UPI account. NIGHTLIFEZ does not collect or hold this ticket payment. Your ticket will be confirmed after the organiser verifies receipt."
  };
}

/**
 * Attendee submits a UTR / payment reference number.
 */
export async function reportDirectUpiPayment(user, bookingId, rawUtr) {
  if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  const utr = sanitizeUtr(rawUtr);

  return db.tx(async (c) => {
    const booking = (await c.query(
      `SELECT b.*, e.title AS event_title, e.organiser_user_id
         FROM bookings b
         JOIN events e ON e.id = b.event_id
        WHERE b.id = $1 FOR UPDATE`,
      [bookingId]
    )).rows[0];

    if (!booking) throw new HttpError(404, 'booking_not_found', 'Booking not found.');
    if (booking.user_id !== user.id) {
      throw new HttpError(403, 'forbidden', 'You cannot report payment for another attendee’s booking.');
    }
    if (['confirmed', 'checked_in'].includes(booking.status)) {
      return { ok: true, status: 'payment_confirmed', bookingId: booking.id, message: 'Payment is already confirmed.' };
    }
    if (booking.status === 'cancelled') {
      throw new HttpError(409, 'booking_cancelled', 'This booking has expired or was cancelled.');
    }
    if (booking.hold_expires_at && new Date(booking.hold_expires_at) <= new Date()) {
      throw new HttpError(409, 'hold_expired', 'The seat reservation window has expired.');
    }

    const prevStatus = booking.direct_upi_status || 'awaiting_payment';
    const newStatus = 'payment_reported';

    await c.query(
      `UPDATE bookings
          SET direct_upi_status = $1, utr_reference = $2, payment_reported_at = now(), updated_at = now()
        WHERE id = $3`,
      [newStatus, utr, bookingId]
    );

    await c.query(
      `INSERT INTO direct_upi_payment_audits (
         booking_id, event_id, actor_user_id, actor_role, from_status, to_status,
         utr_reference, amount_paise, notes
       ) VALUES ($1, $2, $3, 'attendee', $4, $5, $6, $7, 'Attendee submitted payment reference/UTR')`,
      [bookingId, booking.event_id, user.id, prevStatus, newStatus, utr, booking.amount_paise]
    );

    // Notify organiser
    if (booking.organiser_user_id) {
      await enqueue(c, {
        kind: 'payment_reported',
        userId: booking.organiser_user_id,
        bookingId: booking.id,
        dedupeKey: `utr:${booking.id}:${utr}`
      }).catch(() => null);
    }

    return {
      ok: true,
      status: newStatus,
      bookingId: booking.id,
      utr,
      message: 'Payment reported successfully. Awaiting organiser verification.'
    };
  });
}

/**
 * Organiser independently verifies bank/UPI credit and confirms payment received.
 * Strictly requires explicit verification warning acknowledgment.
 */
export async function confirmDirectUpiPayment(user, eventId, bookingId, { note = '', warningConfirmed = false } = {}) {
  if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  if (warningConfirmed !== true) {
    throw new HttpError(400, 'warning_confirmation_required', 'You must explicitly confirm that you independently verified full payment in your bank/UPI account.');
  }

  return db.tx(async (c) => {
    // 1. Authorize organiser permissions on event
    const event = (await c.query(
      `SELECT id, title, organiser_user_id, organiser_org_id, status FROM events WHERE id = $1`,
      [eventId]
    )).rows[0];

    if (!event) throw new HttpError(404, 'event_not_found', 'Event not found.');

    const isAuthorized = event.organiser_user_id === user.id ||
      await can(user, 'event.manage_bookings', { eventId, orgId: event.organiser_org_id }, c);

    if (!isAuthorized) {
      throw new HttpError(403, 'forbidden', 'Only event organisers or authorized team members can confirm payments.');
    }

    // 2. Lock booking
    const booking = (await c.query(
      `SELECT * FROM bookings WHERE id = $1 AND event_id = $2 FOR UPDATE`,
      [bookingId, eventId]
    )).rows[0];

    if (!booking) throw new HttpError(404, 'booking_not_found', 'Booking not found.');

    // Prevent attendees from confirming their own bookings
    if (booking.user_id === user.id && event.organiser_user_id !== user.id) {
      throw new HttpError(403, 'self_confirmation_forbidden', 'Attendees cannot confirm their own payments.');
    }

    // Prevent duplicate confirmation
    if (booking.status === 'confirmed' && booking.direct_upi_status === 'payment_confirmed') {
      return { ok: true, status: 'payment_confirmed', bookingId: booking.id, alreadyConfirmed: true };
    }

    if (booking.status === 'cancelled' && booking.direct_upi_status === 'payment_rejected') {
      throw new HttpError(409, 'already_rejected', 'This payment was already rejected.');
    }

    const prevStatus = booking.direct_upi_status || 'awaiting_payment';
    const newStatus = 'payment_confirmed';

    // 3. Update booking to confirmed status
    await c.query(
      `UPDATE bookings
          SET status = 'confirmed', confirmed_at = now(), payment_mode = 'direct_upi',
              direct_upi_status = $1, verified_by_user_id = $2, verified_at = now(),
              verification_note = $3, updated_at = now()
        WHERE id = $4`,
      [newStatus, user.id, note || null, bookingId]
    );

    // 4. Issue digital ticket passes exactly once
    await issueTicketsForBooking(bookingId, c);

    // 5. Immutable audit entry
    await c.query(
      `INSERT INTO direct_upi_payment_audits (
         booking_id, event_id, actor_user_id, actor_role, from_status, to_status,
         utr_reference, amount_paise, notes, metadata
       ) VALUES ($1, $2, $3, 'organiser', $4, $5, $6, $7, $8, $9)`,
      [
        bookingId,
        eventId,
        user.id,
        prevStatus,
        newStatus,
        booking.utr_reference || null,
        booking.amount_paise,
        note || 'Organiser confirmed bank credit',
        JSON.stringify({ verifiedBy: user.id, verifiedAt: new Date().toISOString() })
      ]
    );

    // 6. Notify attendee
    await enqueue(c, {
      kind: 'booking_confirmed',
      userId: booking.user_id,
      bookingId: booking.id,
      dedupeKey: `bk:${booking.id}:confirmed`
    }).catch(() => null);

    return {
      ok: true,
      status: newStatus,
      bookingId: booking.id,
      bookingRef: booking.booking_ref,
      confirmedAt: new Date().toISOString()
    };
  });
}

/**
 * Organiser rejects payment with reason, immediately releasing reserved inventory.
 */
export async function rejectDirectUpiPayment(user, eventId, bookingId, { reason = 'Payment not received in account' } = {}) {
  if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 3) {
    throw new HttpError(400, 'reason_required', 'Please provide a valid reason for payment rejection (at least 3 characters).');
  }

  return db.tx(async (c) => {
    const event = (await c.query(
      `SELECT id, organiser_user_id, organiser_org_id FROM events WHERE id = $1`,
      [eventId]
    )).rows[0];

    if (!event) throw new HttpError(404, 'event_not_found', 'Event not found.');

    const isAuthorized = event.organiser_user_id === user.id ||
      await can(user, 'event.manage_bookings', { eventId, orgId: event.organiser_org_id }, c);

    if (!isAuthorized) {
      throw new HttpError(403, 'forbidden', 'Only event organisers or authorized team members can reject payments.');
    }

    const booking = (await c.query(
      `SELECT * FROM bookings WHERE id = $1 AND event_id = $2 FOR UPDATE`,
      [bookingId, eventId]
    )).rows[0];

    if (!booking) throw new HttpError(404, 'booking_not_found', 'Booking not found.');
    if (booking.status === 'confirmed') {
      throw new HttpError(409, 'already_confirmed', 'Confirmed bookings cannot be rejected via payment review.');
    }

    const prevStatus = booking.direct_upi_status || 'awaiting_payment';
    const newStatus = 'payment_rejected';

    // Transition booking to cancelled to immediately release seat reservation
    await c.query(
      `UPDATE bookings
          SET status = 'cancelled', cancelled_at = now(), cancel_reason = $1,
              direct_upi_status = $2, rejection_reason = $1, updated_at = now()
        WHERE id = $3`,
      [cleanReason, newStatus, bookingId]
    );

    // Release phase ticket quota and offer redemption if applicable
    if (booking.phase_id) {
      await c.query(
        `UPDATE event_sales_phases SET tickets_sold = GREATEST(0, tickets_sold - $2), updated_at = now() WHERE id = $1`,
        [booking.phase_id, booking.quantity]
      );
    }
    if (booking.offer_id) {
      await c.query(
        `UPDATE event_offers SET redemption_count = GREATEST(0, redemption_count - 1), updated_at = now() WHERE id = $1`,
        [booking.offer_id]
      );
      await c.query(`DELETE FROM offer_redemptions WHERE booking_id = $1`, [booking.id]);
    }

    // Audit trail
    await c.query(
      `INSERT INTO direct_upi_payment_audits (
         booking_id, event_id, actor_user_id, actor_role, from_status, to_status,
         utr_reference, amount_paise, notes
       ) VALUES ($1, $2, $3, 'organiser', $4, $5, $6, $7, $8)`,
      [
        bookingId,
        eventId,
        user.id,
        prevStatus,
        newStatus,
        booking.utr_reference || null,
        booking.amount_paise,
        cleanReason
      ]
    );

    return {
      ok: true,
      status: newStatus,
      bookingId: booking.id,
      rejectionReason: cleanReason
    };
  });
}

/**
 * Lists direct UPI payment bookings and audit records for organiser dashboard.
 */
export async function listDirectUpiBookings(user, eventId) {
  if (!user) throw new HttpError(401, 'unauthorized', 'Please sign in.');

  const event = (await db.query(
    `SELECT id, title, organiser_user_id, organiser_org_id, organiser_upi_id, organiser_payee_name
       FROM events WHERE id = $1`,
    [eventId]
  )).rows[0];

  if (!event) throw new HttpError(404, 'event_not_found', 'Event not found.');

  const isAuthorized = event.organiser_user_id === user.id ||
    await can(user, 'event.manage_bookings', { eventId, orgId: event.organiser_org_id });

  if (!isAuthorized) {
    throw new HttpError(403, 'forbidden', 'You do not have permission to view payment details for this event.');
  }

  const { rows } = await db.query(
    `SELECT b.id, b.booking_ref, b.status AS booking_status, b.direct_upi_status,
            b.amount_paise, b.quantity, b.utr_reference, b.payment_reported_at,
            b.verified_at, b.verification_note, b.rejection_reason, b.created_at, b.hold_expires_at,
            u.alias AS attendee_alias, u.phone AS attendee_phone,
            t.name AS ticket_name,
            v.alias AS verified_by_alias
       FROM bookings b
       JOIN users u ON u.id = b.user_id
       JOIN ticket_types t ON t.id = b.ticket_type_id
       LEFT JOIN users v ON v.id = b.verified_by_user_id
      WHERE b.event_id = $1
        AND (b.payment_mode = 'direct_upi' OR b.direct_upi_status IS NOT NULL)
      ORDER BY b.created_at DESC`,
    [eventId]
  );

  return {
    ok: true,
    eventId: event.id,
    eventTitle: event.title,
    organiserDestination: {
      upiId: event.organiser_upi_id,
      payeeName: event.organiser_payee_name
    },
    bookings: rows.map((r) => ({
      id: r.id,
      bookingRef: r.booking_ref || `NLZ-${r.id.slice(0, 8).toUpperCase()}`,
      bookingStatus: r.booking_status,
      paymentStatus: r.direct_upi_status || 'awaiting_payment',
      amountPaise: Number(r.amount_paise),
      amountRupees: (Number(r.amount_paise) / 100).toFixed(2),
      quantity: r.quantity,
      ticketName: r.ticket_name,
      attendeeAlias: r.attendee_alias || 'Attendee',
      utrReference: r.utr_reference || null,
      paymentReportedAt: r.payment_reported_at,
      verifiedAt: r.verified_at,
      verifiedBy: r.verified_by_alias || null,
      verificationNote: r.verification_note,
      rejectionReason: r.rejection_reason,
      createdAt: r.created_at,
      expiresAt: r.hold_expires_at,
      isExpired: r.hold_expires_at && new Date(r.hold_expires_at) <= new Date() && r.booking_status === 'pending_payment'
    }))
  };
}

/**
 * Get booking payment status for live checkout polling.
 */
export async function getDirectUpiBookingStatus(bookingId, userId = null) {
  const row = (await db.query(
    `SELECT b.id, b.booking_ref, b.status AS booking_status, b.direct_upi_status,
            b.amount_paise, b.hold_expires_at, b.rejection_reason, b.user_id,
            e.slug AS event_slug
       FROM bookings b
       JOIN events e ON e.id = b.event_id
      WHERE b.id = $1`,
    [bookingId]
  )).rows[0];

  if (!row) throw new HttpError(404, 'booking_not_found', 'Booking not found.');
  if (userId && row.user_id !== userId) {
    throw new HttpError(403, 'forbidden', 'Cannot view status of another user’s booking.');
  }

  const isExpired = row.hold_expires_at && new Date(row.hold_expires_at) <= new Date() && row.booking_status === 'pending_payment';

  let effectiveStatus = row.direct_upi_status || 'awaiting_payment';
  if (isExpired && effectiveStatus !== 'payment_confirmed') {
    effectiveStatus = 'expired';
  }

  return {
    ok: true,
    bookingId: row.id,
    bookingRef: row.booking_ref,
    status: effectiveStatus,
    bookingStatus: row.booking_status,
    isConfirmed: effectiveStatus === 'payment_confirmed',
    eventSlug: row.event_slug,
    isExpired,
    rejectionReason: row.rejection_reason || null
  };
}
