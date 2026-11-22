// lib/payments/availability.js - Can a guest buy a paid ticket for this event right now?
//
// Separates sandbox testing from production gateway checkout.
// Production paid checkout requires an independently verified live provider gateway and
// cannot be enabled through feature flags alone. Free ticket booking is unaffected.

import { livePayments, upiCheckoutEnabled, env, isProductionRuntime } from '../config.js';

// Paid checkout stays off in Preview unless an approved test mode is explicitly enabled.
const PREVIEW_BLOCKED = Object.freeze({
  available: false,
  reason: 'preview_paid_checkout_disabled',
  message: 'Paid checkout is disabled in Preview deployments.'
});

function previewPaidCheckoutBlocked() {
  return process.env.VERCEL_ENV === 'preview' && process.env.ALLOW_PREVIEW_PAID_CHECKOUT !== 'true';
}

/**
 * Checks whether an approved live payment gateway is configured with verified production credentials.
 * Sandbox credentials (PGTESTPAYUAT / preprod / sandbox URLs / placeholder VPAs) are strictly NOT live gateways.
 */
export function isLiveGatewayConfigured() {
  const mId = env('PHONEPE_MERCHANT_ID', '');
  const host = env('PHONEPE_HOST_URL', '');
  const salt = env('PHONEPE_SALT_KEY', '');

  // Fail-closed against sandbox/test/mock credentials or missing configuration
  if (!mId || mId === 'PGTESTPAYUAT' || mId.includes('TEST') || mId.includes('MOCK') || mId.includes('SANDBOX')) {
    return false;
  }
  if (!host || host.includes('sandbox') || host.includes('preprod')) {
    return false;
  }
  if (!salt || salt === '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1') {
    return false;
  }
  return true;
}

/** Per-event checkout availability. `row` is an events row (or anything with the same columns). */
export function checkoutForEvent(row) {
  // UPI/PhonePe events are gated by UPI_CHECKOUT_ENABLED; ENABLE_LIVE_PAYMENTS never opens them.
  if (row?.checkout_mode === 'upi_direct') {
    if (!upiCheckoutEnabled()) {
      return { available: false, reason: 'upi_checkout_disabled', message: 'Paid ticket checkout is currently disabled.' };
    }
    if (previewPaidCheckoutBlocked()) return PREVIEW_BLOCKED;

    // In production, paid checkout CANNOT run on sandbox credentials or feature flag alone
    if (isProductionRuntime() && !isLiveGatewayConfigured()) {
      return {
        available: false,
        reason: 'gateway_pending_configuration',
        message: 'Online paid checkout is pending gateway activation. Free tickets can be booked immediately.'
      };
    }

    const isSandbox = !isLiveGatewayConfigured();
    return {
      available: true,
      reason: isSandbox ? 'upi_sandbox' : 'upi_direct',
      provider: isSandbox ? 'phonepe_sandbox' : 'phonepe',
      isSandbox,
      message: isSandbox ? 'Sandbox test checkout active.' : ''
    };
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

/** Status used by the organiser wizard to determine online checkout availability. */
export function ticketCheckoutStatus() {
  // If an approved live gateway is configured and live UPI is enabled
  if (isLiveGatewayConfigured() && upiCheckoutEnabled()) {
    if (previewPaidCheckoutBlocked()) return PREVIEW_BLOCKED;
    return { available: true, reason: 'upi_direct', provider: 'phonepe', isSandbox: false, message: '' };
  }

  // Sandbox / testing mode is strictly isolated to non-production environments with explicit testing flags
  if (!isProductionRuntime() && (process.env.ALLOW_PREVIEW_PAID_CHECKOUT === 'true' || process.env.NODE_ENV === 'test') && upiCheckoutEnabled()) {
    return {
      available: true,
      reason: 'upi_sandbox',
      provider: 'phonepe_sandbox',
      isSandbox: true,
      message: 'Sandbox UPI testing active.'
    };
  }

  // Safe fail-closed pending-configuration experience
  return {
    available: false,
    reason: 'gateway_pending_configuration',
    message: 'Online paid ticket checkout is pending production gateway onboarding. Free tickets remain active and bookable.'
  };
}
