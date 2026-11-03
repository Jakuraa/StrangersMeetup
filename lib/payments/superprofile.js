// lib/payments/superprofile.js - The one PaymentProvider: `superprofile_link`.
//
// Buyers pay on a SuperProfile-hosted page; this site never sees card or UPI details. So:
//   createCheckout  → returns the SuperProfile URL (with our ref attached), nothing is charged here
//   verifyWebhook   → shared-secret check (constant time) before anything is parsed or written
//   refund          → NOT_SUPPORTED_IN_APP: refunds are issued on SuperProfile, then arrive as a notification
import { env } from '../config.js';
import { HttpError, safeEqual } from '../http.js';

export const SUPERPROFILE_SECRET_HEADER = 'x-webhook-secret';
export const PROVIDER_NAME = 'superprofile_link';

/** https, no credentials, host is superprofile.bio or a subdomain of it. Rejects look-alike hosts. */
export function isSuperprofileUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  return host === 'superprofile.bio' || host.endsWith('.superprofile.bio');
}

export class WebhookSignatureError extends Error {
  constructor(msg = 'invalid webhook secret') {
    super(msg);
    this.code = 'WEBHOOK_SIGNATURE';
  }
}

export function superprofileConfigured() {
  return env('SUPERPROFILE_WEBHOOK_SECRET').length >= 24;
}

/** The SuperProfile URL with our ref carried as query params (SuperProfile may echo them in notifications). */
export function withCheckoutRef(url, { ref, slug }) {
  if (!isSuperprofileUrl(url)) throw new HttpError(409, 'checkout_unavailable', 'Checkout is not available for this event');
  const u = new URL(url);
  u.searchParams.set('ref', ref);
  u.searchParams.set('utm_source', 'strangersmeetup');
  u.searchParams.set('utm_medium', 'site');
  u.searchParams.set('utm_campaign', slug);
  u.searchParams.set('utm_content', ref);
  return u.toString();
}

export const superprofileLink = {
  name: PROVIDER_NAME,
  isTest: false,

  async createCheckout({ url, ref, slug }) {
    return { providerTxnId: ref, checkoutUrl: withCheckoutRef(url, { ref, slug }) };
  },

  /** Throws WebhookSignatureError; call before parsing the body or touching the database. */
  verifyWebhook(headers) {
    const expected = env('SUPERPROFILE_WEBHOOK_SECRET');
    const got = headers[SUPERPROFILE_SECRET_HEADER];
    if (expected.length < 24 || typeof got !== 'string' || !safeEqual(got, expected)) throw new WebhookSignatureError();
    return true;
  },

  async refund() {
    throw new HttpError(501, 'NOT_SUPPORTED_IN_APP', 'Refunds for tickets are issued on SuperProfile. The booking updates when SuperProfile reports the refund.');
  }
};
