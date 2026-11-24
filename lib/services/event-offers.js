// lib/services/event-offers.js - Offers & Discount Engine Module.
// Server-side discount calculation, promo code verification, redemption tracking & limits.

import { db } from '../db.js';
import { HttpError } from '../http.js';

export async function saveEventOffers(c, eventId, offers = []) {
  await c.query(`DELETE FROM event_offers WHERE event_id = $1`, [eventId]);
  if (!Array.isArray(offers) || offers.length === 0) {
    await c.query(`UPDATE events SET has_offers = false WHERE id = $1`, [eventId]);
    return [];
  }

  const valid = [];
  for (let i = 0; i < offers.length; i++) {
    const o = offers[i];
    const name = String(o.name || '').trim();
    if (!name) continue;
    const desc = o.description ? String(o.description).trim().slice(0, 500) : null;
    const code = o.code ? String(o.code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30) : null;
    const type = o.discountType === 'fixed_amount' ? 'fixed_amount' : 'percentage';
    const value = parseInt(o.discountValue, 10);
    if (!value || value <= 0) continue;

    const maxDiscountPaise = o.maxDiscountPaise ? parseInt(o.maxDiscountPaise, 10) : null;
    const minOrderPaise = o.minOrderPaise ? Math.max(0, parseInt(o.minOrderPaise, 10)) : 0;
    const minQuantity = o.minQuantity ? Math.max(1, parseInt(o.minQuantity, 10)) : 1;
    const tierIds = Array.isArray(o.applicableTierIds) ? o.applicableTierIds.filter(Boolean) : [];
    const phaseIds = Array.isArray(o.applicablePhaseIds) ? o.applicablePhaseIds.filter(Boolean) : [];
    const startsAt = o.startsAt ? new Date(o.startsAt) : null;
    const expiresAt = o.expiresAt ? new Date(o.expiresAt) : null;
    const totalLimit = o.totalLimit ? parseInt(o.totalLimit, 10) : null;
    const perUserLimit = o.perUserLimit ? parseInt(o.perUserLimit, 10) : 1;
    const active = o.active !== false;

    const res = await c.query(
      `INSERT INTO event_offers (
         event_id, name, description, code, discount_type, discount_value, max_discount_paise,
         min_order_paise, min_quantity, applicable_tier_ids, applicable_phase_ids,
         starts_at, expires_at, total_limit, per_user_limit, active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        eventId, name, desc, code || null, type, value, maxDiscountPaise,
        minOrderPaise, minQuantity, tierIds, phaseIds,
        startsAt, expiresAt, totalLimit, perUserLimit, active
      ]
    );
    valid.push(res.rows[0]);
  }

  await c.query(`UPDATE events SET has_offers = $2 WHERE id = $1`, [eventId, valid.length > 0]);
  return valid;
}

export async function getEventOffers(eventId, c = db) {
  const { rows } = await c.query(
    `SELECT * FROM event_offers WHERE event_id = $1 ORDER BY created_at ASC`,
    [eventId]
  );
  return rows;
}

/**
 * Validates and calculates discount on the server side using integer paise.
 */
export async function evaluateOffer({
  c = db,
  eventId,
  offerId = null,
  promoCode = null,
  ticketSubtotalPaise = 0,
  quantity = 1,
  tierId = null,
  phaseId = null,
  userId = null,
  now = new Date()
}) {
  if (!offerId && !promoCode) {
    return { valid: false, reason: 'no_offer_specified' };
  }

  let offer;
  if (offerId) {
    offer = (await c.query(
      `SELECT * FROM event_offers WHERE id = $1 AND event_id = $2 FOR UPDATE`,
      [offerId, eventId]
    )).rows[0];
  } else if (promoCode) {
    const cleanCode = String(promoCode).trim().toUpperCase();
    offer = (await c.query(
      `SELECT * FROM event_offers WHERE event_id = $1 AND code = $2 FOR UPDATE`,
      [eventId, cleanCode]
    )).rows[0];
  }

  if (!offer) {
    return { valid: false, reason: 'Offer or promo code not found.' };
  }

  if (!offer.active) {
    return { valid: false, reason: 'This promotional offer is no longer active.' };
  }

  if (offer.starts_at && new Date(offer.starts_at) > now) {
    return { valid: false, reason: 'This promotional offer has not started yet.' };
  }

  if (offer.expires_at && new Date(offer.expires_at) < now) {
    return { valid: false, reason: 'This promotional offer has expired.' };
  }

  if (offer.min_quantity && quantity < offer.min_quantity) {
    return {
      valid: false,
      reason: `Requires a minimum of ${offer.min_quantity} tickets (current: ${quantity}).`
    };
  }

  if (offer.min_order_paise && ticketSubtotalPaise < offer.min_order_paise) {
    const minRs = Math.ceil(offer.min_order_paise / 100);
    return {
      valid: false,
      reason: `Requires a minimum order value of ₹${minRs}.`
    };
  }

  if (Array.isArray(offer.applicable_tier_ids) && offer.applicable_tier_ids.length > 0) {
    if (!tierId || !offer.applicable_tier_ids.includes(tierId)) {
      return { valid: false, reason: 'This offer is not applicable to the selected ticket type.' };
    }
  }

  if (Array.isArray(offer.applicable_phase_ids) && offer.applicable_phase_ids.length > 0) {
    if (!phaseId || !offer.applicable_phase_ids.includes(phaseId)) {
      return { valid: false, reason: 'This offer is not applicable to the current sales phase.' };
    }
  }

  if (offer.total_limit != null && offer.redemption_count >= offer.total_limit) {
    return { valid: false, reason: 'This offer has reached its maximum total redemptions.' };
  }

  if (userId && offer.per_user_limit) {
    const userRedemptions = (await c.query(
      `SELECT COUNT(*)::int as count FROM offer_redemptions WHERE offer_id = $1 AND user_id = $2`,
      [offer.id, userId]
    )).rows[0]?.count || 0;

    if (userRedemptions >= offer.per_user_limit) {
      return { valid: false, reason: 'You have already redeemed this offer the maximum allowed number of times.' };
    }
  }

  // Calculate discount in paise
  let discountPaise = 0;
  if (offer.discount_type === 'percentage') {
    discountPaise = Math.floor((ticketSubtotalPaise * offer.discount_value) / 100);
    if (offer.max_discount_paise && discountPaise > offer.max_discount_paise) {
      discountPaise = offer.max_discount_paise;
    }
  } else if (offer.discount_type === 'fixed_amount') {
    discountPaise = offer.discount_value;
  }

  // Never allow discount to exceed eligible ticket subtotal
  discountPaise = Math.max(0, Math.min(discountPaise, ticketSubtotalPaise));

  return {
    valid: true,
    offer,
    discountPaise,
    finalAmountPaise: ticketSubtotalPaise - discountPaise,
    finalPayablePaise: ticketSubtotalPaise - discountPaise
  };
}

/**
 * Pure calculation helper for offer discounts using integer paise.
 */
export function calculateDiscountPaise(offer, { ticketSubtotalPaise = 0, quantity = 1 } = {}) {
  const minQty = offer.min_quantity ?? offer.minQuantity ?? 1;
  if (minQty && quantity < minQty) {
    return { valid: false, reason: `Minimum of ${minQty} tickets required.` };
  }
  const minOrder = offer.min_order_paise ?? offer.minOrderPaise;
  if (minOrder && ticketSubtotalPaise < minOrder) {
    return { valid: false, reason: `Minimum order value of ₹${Math.ceil(minOrder / 100)} required.` };
  }
  let discountPaise = 0;
  const dType = offer.discount_type || offer.discountType;
  const dVal = offer.discount_value ?? offer.discountValue ?? 0;
  const maxCap = offer.max_discount_paise ?? offer.maxDiscountPaise;
  if (dType === 'percentage') {
    discountPaise = Math.floor((ticketSubtotalPaise * dVal) / 100);
    if (maxCap && discountPaise > maxCap) {
      discountPaise = maxCap;
    }
  } else if (dType === 'fixed_amount') {
    discountPaise = dVal;
  }
  discountPaise = Math.max(0, Math.min(discountPaise, ticketSubtotalPaise));
  return {
    valid: true,
    discountPaise,
    finalAmountPaise: ticketSubtotalPaise - discountPaise,
    finalPayablePaise: ticketSubtotalPaise - discountPaise
  };
}

/**
 * Record redemption transactionally upon booking creation or confirmation.
 */
export async function recordOfferRedemption(c, { offerId, eventId, bookingId, userId, discountPaise }) {
  if (!offerId || !bookingId) return null;

  // Insert redemption record
  const row = (await c.query(
    `INSERT INTO offer_redemptions (offer_id, event_id, booking_id, user_id, discount_paise)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (offer_id, booking_id) DO NOTHING
     RETURNING *`,
    [offerId, eventId, bookingId, userId, discountPaise]
  )).rows[0];

  if (row) {
    // Atomically increment redemption count on offer
    await c.query(
      `UPDATE event_offers SET redemption_count = redemption_count + 1, updated_at = now() WHERE id = $1`,
      [offerId]
    );
  }
  return row;
}

/**
 * Organiser reporting on offers usage.
 */
export async function getOrganiserOffersReport(first, second = db) {
  const c = (first && typeof first.query === 'function') ? first : second;
  const eventId = (first && typeof first.query === 'function') ? second : first;

  const { rows } = await c.query(
    `SELECT o.id, o.name, o.code, o.discount_type, o.discount_value, o.total_limit, o.redemption_count,
            COALESCE(SUM(r.discount_paise), 0)::bigint as total_discount_given_paise,
            COALESCE(SUM(b.amount_paise), 0)::bigint as total_net_revenue_paise,
            COUNT(r.id)::int as actual_redemption_count
       FROM event_offers o
       LEFT JOIN offer_redemptions r ON r.offer_id = o.id
       LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE o.event_id = $1
      GROUP BY o.id
      ORDER BY o.created_at ASC`,
    [eventId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    discountType: r.discount_type,
    discountValue: r.discount_value,
    totalLimit: r.total_limit,
    redemptionCount: r.redemption_count,
    actualRedemptionCount: r.actual_redemption_count,
    remainingCapacity: r.total_limit ? Math.max(0, r.total_limit - r.redemption_count) : null,
    totalDiscountPaise: Number(r.total_discount_given_paise),
    total_discount_paise: Number(r.total_discount_given_paise),
    netRevenuePaise: Number(r.total_net_revenue_paise),
    net_revenue_paise: Number(r.total_net_revenue_paise),
    total_redemptions: r.redemption_count,
    totalRedemptions: r.redemption_count,
    totalDiscountGivenPaise: parseInt(r.total_discount_given_paise, 10) || 0
  }));
}
