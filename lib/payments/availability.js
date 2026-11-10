// lib/payments/availability.js - Can a guest buy a paid ticket for this event right now?
//
// A paid ticket is bookable only when the event is linked to a SuperProfile product
// (checkout_mode = 'superprofile' and a superprofile_url). Linking is an admin action, so events
// created in the organiser wizard cannot take payments until an admin links a product. Nothing here
// can mark a payment as paid: bookings are confirmed only by a matched SuperProfile notification.

import { livePayments, upiCheckoutEnabled } from '../config.js';

// Paid checkout stays off in Preview unless an approved test mode is explicitly enabled.
const PREVIEW_BLOCKED = Object.freeze({ available: false, reason: 'preview_paid_checkout_disabled', message: 'Paid checkout is disabled in Preview deployments.' });
function previewPaidCheckoutBlocked() {
  return process.env.VERCEL_ENV === 'preview' && process.env.ALLOW_PREVIEW_PAID_CHECKOUT !== 'true';
}

/** Per-event checkout availability. `row` is an events row (or anything with the same columns). */
export function checkoutForEvent(row) {
  // UPI/PhonePe events are gated by UPI_CHECKOUT_ENABLED alone; ENABLE_LIVE_PAYMENTS never opens them.
  if (row?.checkout_mode === 'upi_direct') {
    if (!upiCheckoutEnabled()) {
      return { available: false, reason: 'upi_checkout_disabled', message: 'Paid ticket checkout is currently disabled.' };
    }
    if (previewPaidCheckoutBlocked()) return PREVIEW_BLOCKED;
    return { available: true, reason: 'upi_direct', provider: 'phonepe', message: '' };
  }
  // ENABLE_LIVE_PAYMENTS gates only the SuperProfile hosted link-out.
  if (!livePayments()) {
    return { available: false, reason: 'live_payments_disabled', message: 'Paid ticket checkout is currently disabled.' };
  }
  if (previewPaidCheckoutBlocked()) return PREVIEW_BLOCKED;
  const available = row?.checkout_mode === 'superprofile' && Boolean(row?.superprofile_url);
  return available
    ? { available: true, reason: 'superprofile', provider: 'superprofile_link', message: '' }
    : { available: false, reason: 'no_superprofile_product', message: 'Online booking is not available for this event yet.' };
}

/** Status used by the organiser wizard, which has no SuperProfile product to attach. */
export function ticketCheckoutStatus() {
  return {
    available: false,
    reason: 'admin_link_required',
    message: 'Paid tickets are bought on SuperProfile and need a product linked by the NIGHTLIFEZ team. Until then guests can only book free tickets.'
  };
}
