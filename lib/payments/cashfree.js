// lib/payments/cashfree.js - Cashfree PG Orders adapter (alternative provider behind the same
// interface). Webhook signature: base64(HMAC-SHA256(timestamp + rawBody, client secret)).
import crypto from 'node:crypto';
import { env } from '../config.js';
import { HttpError, safeEqual } from '../http.js';

const API_VERSION = '2025-01-01';

export function cashfree({ live }) {
  const appId = env('CASHFREE_APP_ID');
  const secret = env('CASHFREE_SECRET_KEY');
  const base = live ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

  async function call(method, path, body) {
    if (!appId || !secret) throw new HttpError(503, 'not_configured', 'Ticket payments are not configured yet');
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'x-client-id': appId, 'x-client-secret': secret, 'x-api-version': API_VERSION,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw Object.assign(new Error('cashfree network error'), { code: 'PROVIDER_ERROR', status: 502 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`cashfree ${path} ${res.status} ${String(data.message || '').slice(0, 160)}`), { code: 'PROVIDER_ERROR', status: 502 });
    return data;
  }

  return {
    name: 'cashfree',
    isTest: !live,

    async createCheckout() {
      // Cashfree requires customer_phone on Orders and Payment Links, and its hosted checkout opens
      // only via the JS SDK. We do not collect phone numbers, so this adapter does not create
      // checkouts until the owner decides otherwise (docs/PAYMENTS_DECISION.md). Webhook
      // verification, refunds and status lookups below are implemented for that switch.
      throw new HttpError(503, 'not_configured', 'Cashfree checkout is not enabled (customer phone required)');
    },

    verifyWebhook(headers, rawBody) {
      const sig = headers['x-webhook-signature'];
      const ts = headers['x-webhook-timestamp'];
      if (typeof sig !== 'string' || typeof ts !== 'string' || !secret) throw Object.assign(new Error('missing signature'), { code: 'WEBHOOK_SIGNATURE' });
      const expected = crypto.createHmac('sha256', secret).update(ts + rawBody).digest('base64');
      if (!safeEqual(sig, expected)) throw Object.assign(new Error('bad signature'), { code: 'WEBHOOK_SIGNATURE' });
      if (Math.abs(Date.now() - Number(ts)) > 15 * 60_000 && Math.abs(Date.now() / 1000 - Number(ts)) > 15 * 60) {
        throw Object.assign(new Error('stale webhook'), { code: 'WEBHOOK_SIGNATURE' });
      }
      const body = JSON.parse(rawBody);
      const order = body.data?.order;
      const pay = body.data?.payment;
      const eventId = `${body.type}:${pay?.cf_payment_id || order?.order_id}`;
      switch (body.type) {
        case 'PAYMENT_SUCCESS_WEBHOOK':
          return { eventId, type: 'paid', providerTxnId: order?.order_id, providerPaymentId: String(pay?.cf_payment_id || ''), amountPaise: Math.round(Number(pay?.payment_amount) * 100), currency: pay?.payment_currency || order?.order_currency };
        case 'PAYMENT_FAILED_WEBHOOK':
        case 'PAYMENT_USER_DROPPED_WEBHOOK':
          return { eventId, type: 'failed', providerTxnId: order?.order_id, reason: String(pay?.payment_message || body.type).slice(0, 200) };
        case 'REFUND_STATUS_WEBHOOK':
          return body.data?.refund?.refund_status === 'SUCCESS'
            ? { eventId: `refund:${body.data.refund.refund_id}`, type: 'refunded', providerTxnId: body.data.refund.order_id, amountPaise: Math.round(Number(body.data.refund.refund_amount) * 100) }
            : { eventId, type: 'ignored' };
        default:
          return { eventId, type: 'ignored' };
      }
    },

    async refund({ providerTxnId, amountPaise, refundRef }) {
      const r = await call('POST', `/orders/${encodeURIComponent(providerTxnId)}/refunds`, {
        refund_amount: Number((amountPaise / 100).toFixed(2)), refund_id: String(refundRef).slice(0, 40)
      });
      return { refundId: r.refund_id || r.cf_refund_id, status: r.refund_status };
    },

    async fetchStatus(providerTxnId) {
      const o = await call('GET', `/orders/${encodeURIComponent(providerTxnId)}`);
      const map = { PAID: 'paid', ACTIVE: 'created', EXPIRED: 'expired', TERMINATED: 'expired' };
      return { status: map[o.order_status] || 'created', amountPaise: Math.round(Number(o.order_amount) * 100) };
    }
  };
}
