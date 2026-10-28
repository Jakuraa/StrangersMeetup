// lib/payments/availability.js - Can guests pay for a paid ticket tier right now?
//
// Ticket inventory and booking logic never ask "which provider"; they ask this module whether a
// hosted checkout is available and, if so, receive a PaymentProvider (see ./index.js). Adding a
// future approved provider means adding an adapter there — not touching tiers or bookings.
//
// Paid checkout for organiser tiers is OFF unless the owner explicitly opts in with
// TICKET_CHECKOUT_ENABLED=true AND the selected provider's keys are present. There is no manual
// UPI or pay-at-venue flow: nothing here can mark a payment as paid. Payments only become `paid`
// from a signature-verified provider webhook or server-side reconciliation (services/bookings.js).
import { env, configStatus } from '../config.js';
import { ticketProvider } from './index.js';

export function ticketCheckoutStatus() {
  if (env('TICKET_CHECKOUT_ENABLED', 'false') !== 'true') {
    return {
      available: false,
      reason: 'not_enabled',
      message: 'Online payment for paid tickets is not available yet. You can set up paid tiers and save them; guests can only book free tiers until a payment method is approved and configured.'
    };
  }
  const status = configStatus();
  if (status.paymentKeys !== 'configured') {
    return { available: false, reason: 'not_configured', message: 'Paid checkout is enabled but the payment provider is not configured, so paid tiers cannot be booked.' };
  }
  return { available: true, reason: 'configured', provider: status.paymentProvider, testMode: !status.livePayments, message: '' };
}

/** The provider to charge with, or null when paid checkout is unavailable. */
export function ticketCheckoutProvider() {
  return ticketCheckoutStatus().available ? ticketProvider() : null;
}
