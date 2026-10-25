// lib/payments/index.js - PaymentProvider selection.
//
// interface PaymentProvider {
//   name: 'razorpay' | 'cashfree'
//   isTest: boolean
//   createCheckout({ bookingId, amountPaise, title, expiresAt, returnUrl }) -> { providerTxnId, checkoutUrl }
//   verifyWebhook(headers, rawBody) -> WebhookEvent  (throws WebhookSignatureError)
//   refund({ providerTxnId, providerPaymentId, amountPaise, refundRef }) -> { refundId, status }
//   fetchStatus(providerTxnId) -> { status: 'created'|'paid'|'failed'|'expired', providerPaymentId?, amountPaise? }
// }
// WebhookEvent = { eventId, type: 'paid'|'failed'|'expired'|'refunded'|'ignored', providerTxnId, providerPaymentId?, amountPaise?, reason? }
import { env, livePayments } from '../config.js';
import { HttpError } from '../http.js';
import { razorpay } from './razorpay.js';
import { cashfree } from './cashfree.js';

export class WebhookSignatureError extends Error {
  constructor(msg = 'invalid webhook signature') {
    super(msg);
    this.code = 'WEBHOOK_SIGNATURE';
  }
}

const PROVIDERS = { razorpay, cashfree };

export function providerByName(name) {
  const factory = PROVIDERS[name];
  if (!factory) throw new HttpError(404, 'unknown_provider', 'Unknown payment provider');
  return factory({ live: livePayments() });
}

/** The configured ticket provider. Refuses mismatched live/test keys. */
export function ticketProvider() {
  return providerByName(env('PAYMENT_PROVIDER', 'razorpay'));
}
