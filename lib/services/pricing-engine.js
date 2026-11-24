// lib/services/pricing-engine.js - Unified Pricing Engine.
// Enforces order of operations: Base Tier/Section Price → Sales Phase Override → Offer Discount → Final Payable.
// Never trusts client-side totals. Stores immutable price snapshot.

import { db } from '../db.js';
import { HttpError } from '../http.js';
import { evaluateOffer, recordOfferRedemption } from './event-offers.js';
import { categorizePhases, assertAndRecordPhaseSale } from './sales-phases.js';
import { assertSectionInventory } from './event-venue.js';

/**
 * Calculates authoritative pricing breakdown and returns snapshot data.
 */
export async function calculateBookingPrice({
  c = db,
  event,
  tier,
  sectionId = null,
  phaseId = null,
  quantity = 1,
  promoCode = null,
  offerId = null,
  userId = null,
  accessCode = null,
  now = new Date()
}) {
  const qty = Math.max(1, parseInt(quantity, 10) || 1);

  // 1. Determine Base Price: Section vs Tier
  let basePricePaise = tier.price_paise;
  let section = null;
  if (sectionId) {
    section = await assertSectionInventory(c, sectionId, qty);
    if (section && section.price_paise != null) {
      basePricePaise = section.price_paise;
    }
  }

  // 2. Sales Timeline & Scheduled Pricing Phase Resolution
  const { rows: phases } = await c.query(
    `SELECT * FROM event_sales_phases WHERE event_id = $1 AND is_active ORDER BY sort_order ASC, starts_at ASC`,
    [event.id]
  );

  let activePhase = null;
  if (phaseId) {
    const specificPhase = phases.find((p) => p.id === phaseId || p.name === phaseId);
    if (!specificPhase) {
      throw new HttpError(404, 'phase_not_found', 'Selected sales phase not found.');
    }
    if (specificPhase.access_code && accessCode !== specificPhase.access_code) {
      throw new HttpError(400, 'invalid_access_code', 'Valid access code required to unlock this sales phase.');
    }
    const currentTime = now.getTime();
    if (new Date(specificPhase.starts_at).getTime() > currentTime) {
      throw new HttpError(409, 'phase_not_started', `Sales phase "${specificPhase.name}" has not started yet.`);
    }
    if (new Date(specificPhase.ends_at).getTime() <= currentTime) {
      throw new HttpError(409, 'phase_ended', `Sales phase "${specificPhase.name}" has ended.`);
    }
    if (specificPhase.quota != null && (specificPhase.tickets_sold + qty > specificPhase.quota)) {
      throw new HttpError(409, 'phase_quota_exhausted', `Sales phase "${specificPhase.name}" has reached its ticket quota.`);
    }
    activePhase = specificPhase;
  } else {
    const phaseAnalysis = categorizePhases(phases, { now, tierId: tier.id, accessCode });
    activePhase = phaseAnalysis.current;
  }

  let effectiveUnitPricePaise = basePricePaise;
  if (activePhase && activePhase.price_paise != null) {
    effectiveUnitPricePaise = activePhase.price_paise;
  }

  const ticketSubtotalPaise = effectiveUnitPricePaise * qty;

  // 3. Offers & Discount Engine Evaluation
  let discountPaise = 0;
  let appliedOffer = null;
  let offerReason = null;

  if (promoCode || offerId) {
    const offerRes = await evaluateOffer({
      c,
      eventId: event.id,
      offerId,
      promoCode,
      ticketSubtotalPaise,
      quantity: qty,
      tierId: tier.id,
      phaseId: activePhase ? activePhase.id : null,
      userId,
      now
    });

    if (offerRes.valid) {
      discountPaise = offerRes.discountPaise;
      appliedOffer = offerRes.offer;
    } else {
      offerReason = offerRes.reason;
    }
  }

  const finalPaise = Math.max(0, ticketSubtotalPaise - discountPaise);

  return {
    basePricePaise,
    effectiveUnitPricePaise,
    quantity: qty,
    ticketSubtotalPaise,
    activePhase,
    section,
    appliedOffer,
    offerReason,
    discountPaise,
    finalPaise,
    breakdown: {
      tierName: tier.name,
      sectionName: section ? section.name : null,
      phaseName: activePhase ? activePhase.name : null,
      unitPricePaise: effectiveUnitPricePaise,
      quantity: qty,
      subtotalPaise: ticketSubtotalPaise,
      offerName: appliedOffer ? appliedOffer.name : null,
      offerCode: appliedOffer ? appliedOffer.code : null,
      discountPaise,
      finalPayablePaise: finalPaise,
      currency: 'INR'
    }
  };
}

/**
 * Saves immutable price snapshot in database for an initiated booking.
 */
export async function createBookingPriceSnapshot(c, {
  bookingId,
  eventId,
  pricing
}) {
  const {
    basePricePaise,
    quantity,
    ticketSubtotalPaise,
    activePhase,
    section,
    appliedOffer,
    discountPaise,
    finalPaise,
    breakdown
  } = pricing;

  const res = await c.query(
    `INSERT INTO booking_price_snapshots (
       booking_id, event_id, base_price_paise, quantity, subtotal_paise,
       phase_id, phase_name, section_id, section_name,
       offer_id, offer_name, offer_code, discount_paise, final_paise,
       currency, breakdown
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'INR', $15)
     ON CONFLICT (booking_id) DO UPDATE
       SET base_price_paise = EXCLUDED.base_price_paise,
           subtotal_paise = EXCLUDED.subtotal_paise,
           discount_paise = EXCLUDED.discount_paise,
           final_paise = EXCLUDED.final_paise,
           breakdown = EXCLUDED.breakdown
     RETURNING *`,
    [
      bookingId,
      eventId,
      basePricePaise,
      quantity,
      ticketSubtotalPaise,
      activePhase ? activePhase.id : null,
      activePhase ? activePhase.name : null,
      section ? section.id : null,
      section ? section.name : null,
      appliedOffer ? appliedOffer.id : null,
      appliedOffer ? appliedOffer.name : null,
      appliedOffer ? appliedOffer.code : null,
      discountPaise,
      finalPaise,
      JSON.stringify(breakdown)
    ]
  );

  return res.rows[0];
}
