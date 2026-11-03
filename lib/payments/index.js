// lib/payments/index.js - Ticket payments go through one provider, `superprofile_link` (hosted checkout).
//
// interface PaymentProvider {
//   name: 'superprofile_link'
//   createCheckout({ url, ref, slug }) -> { providerTxnId, checkoutUrl }
//   verifyWebhook(headers) -> true            (throws WebhookSignatureError)
//   refund() -> throws NOT_SUPPORTED_IN_APP   (refunds happen on SuperProfile)
// }
// Membership via Telegram Stars is separate (services/membership.js): Stars is the only way to sell
// digital goods inside Telegram.
import { superprofileLink } from './superprofile.js';

export { WebhookSignatureError, isSuperprofileUrl, withCheckoutRef } from './superprofile.js';

export function ticketProvider() {
  return superprofileLink;
}
