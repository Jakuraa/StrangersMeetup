// lib/payments/razorpay.js - Razorpay Payment Links (hosted checkout) adapter.
// Docs: https://razorpay.com/docs/api/payments/payment-links/ , webhooks: HMAC-SHA256(raw body) hex
// in X-Razorpay-Signature; event id in X-Razorpay-Event-Id.
import crypto from 'node:crypto';
import { env } from '../config.js';
import { HttpError, safeEqual } from '../http.js';

const API = 'https://api.razorpay.com/v1';

class ProviderError extends Error {
  constructor(op, status, description) {
    super(`razorpay ${op} failed: ${status} ${description}`);
    this.code = 'PROVIDER_ERROR';
    this.status = 502;
  }
}

export function razorpay({ live }) {
  const keyId = env('RAZORPAY_KEY_ID');
  const keySecret = env('RAZORPAY_KEY_SECRET');
  const webhookSecret = env('RAZORPAY_WEBHOOK_SECRET');

  function assertKeys() {
    if (!keyId || !keySecret) throw new HttpError(503, 'not_configured', 'Ticket payments are not configured yet');
    const isTestKey = keyId.startsWith('rzp_test_');
    if (!live && !isTestKey) throw new HttpError(503, 'not_configured', 'Live keys are set while ENABLE_LIVE_PAYMENTS=false; refusing to charge');
    if (live && isTestKey) throw new HttpError(503, 'not_configured', 'Test keys are set while ENABLE_LIVE_PAYMENTS=true');
  }

  async function call(method, path, body) {
    assertKeys();
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000)
      });
    } catch (err) {
      throw new ProviderError(path, 0, err.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderError(path, res.status, String(data?.error?.description || '').slice(0, 160));
    return data;
  }

  return {
    name: 'razorpay',
    isTest: !live,

    async createCheckout({ bookingId, amountPaise, title, expiresAt, returnUrl }) {
      // Razorpay requires expire_by to be at least ~15 minutes in the future.
      const expireBy = Math.max(Math.floor(new Date(expiresAt).getTime() / 1000), Math.floor(Date.now() / 1000) + 16 * 60);
      const link = await call('POST', '/payment_links', {
        amount: amountPaise,
        currency: 'INR',
        accept_partial: false,
        description: title.slice(0, 2048),
        reference_id: bookingId.replace(/-/g, '').slice(0, 40),
        expire_by: expireBy,
        reminder_enable: false,
        notify: { sms: false, email: false },
        notes: { booking_id: bookingId },
        callback_url: returnUrl,
        callback_method: 'get'
      });
      return { providerTxnId: link.id, checkoutUrl: link.short_url };
    },

    verifyWebhook(headers, rawBody) {
      const sig = headers['x-razorpay-signature'];
      if (!webhookSecret || typeof sig !== 'string') throw Object.assign(new Error('missing signature'), { code: 'WEBHOOK_SIGNATURE' });
      const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      if (!safeEqual(sig, expected)) throw Object.assign(new Error('bad signature'), { code: 'WEBHOOK_SIGNATURE' });
      const body = JSON.parse(rawBody);
      const eventId = headers['x-razorpay-event-id'] || `${body.event}:${body.payload?.payment?.entity?.id || body.payload?.payment_link?.entity?.id || body.payload?.refund?.entity?.id}`;
      const linkEntity = body.payload?.payment_link?.entity;
      const pay = body.payload?.payment?.entity;
      const refund = body.payload?.refund?.entity;
      switch (body.event) {
        case 'payment_link.paid':
          return { eventId, type: 'paid', providerTxnId: linkEntity?.id, providerPaymentId: pay?.id, amountPaise: pay?.amount ?? linkEntity?.amount_paid, currency: pay?.currency || linkEntity?.currency };
        case 'payment_link.expired':
        case 'payment_link.cancelled':
          return { eventId, type: 'expired', providerTxnId: linkEntity?.id };
        case 'payment.failed':
          // Payment-link payments carry the link id in notes only when present; match via booking note.
          return { eventId, type: 'failed', providerTxnId: linkEntity?.id || null, bookingId: pay?.notes?.booking_id || null, reason: String(pay?.error_description || 'failed').slice(0, 200) };
        case 'refund.processed':
          return { eventId, type: 'refunded', providerPaymentId: refund?.payment_id, amountPaise: refund?.amount };
        default:
          return { eventId, type: 'ignored' };
      }
    },

    async refund({ providerPaymentId, amountPaise, refundRef }) {
      if (!providerPaymentId) throw new HttpError(409, 'no_payment_id', 'No captured payment id to refund');
      const r = await call('POST', `/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
        amount: amountPaise, speed: 'normal', receipt: String(refundRef).slice(0, 40)
      });
      return { refundId: r.id, status: r.status };
    },

    async fetchStatus(providerTxnId) {
      const link = await call('GET', `/payment_links/${encodeURIComponent(providerTxnId)}`);
      const paid = (link.payments || []).find((p) => p.status === 'captured');
      const map = { paid: 'paid', expired: 'expired', cancelled: 'expired', created: 'created', partially_paid: 'created' };
      return { status: map[link.status] || 'created', providerPaymentId: paid?.payment_id || paid?.id || null, amountPaise: paid?.amount ?? link.amount_paid };
    }
  };
}
