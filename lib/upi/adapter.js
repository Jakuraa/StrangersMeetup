// lib/upi/adapter.js - Provider-neutral UPI payment adapter.
// Supports PhonePe Payment Gateway (Primary) and Mock/Sandbox adapter with
// mobile UPI intent deep-linking, app-specific intents (GPay, PhonePe, Paytm, CRED, BHIM),
// and desktop dynamic QR generation.

import crypto from 'node:crypto';
import { safeEqual, HttpError } from '../http.js';
import { env } from '../config.js';
import { buildUpiUri, generateQrSvg } from './qr.js';

export const UPI_INTENT_TTL_SECONDS = 900; // 15 minutes

export class PaymentAdapterError extends Error {
  constructor(message, code = 'ADAPTER_ERROR', status = 502) {
    super(message);
    this.name = 'PaymentAdapterError';
    this.code = code;
    this.status = status;
  }
}

export class WebhookSignatureError extends Error {
  constructor(msg = 'Invalid webhook signature') {
    super(msg);
    this.name = 'WebhookSignatureError';
    this.code = 'WEBHOOK_SIGNATURE';
    this.status = 401;
  }
}

/** Supported UPI client applications for deep-linking */
export const SUPPORTED_UPI_APPS = [
  { id: 'generic', name: 'Any UPI App', scheme: 'upi' },
  { id: 'gpay', name: 'Google Pay', scheme: 'gpay' },
  { id: 'phonepe', name: 'PhonePe', scheme: 'phonepe' },
  { id: 'paytm', name: 'Paytm', scheme: 'paytmmp' },
  { id: 'cred', name: 'CRED', scheme: 'credpay' },
  { id: 'bhim', name: 'BHIM UPI', scheme: 'bhim' }
];

/**
 * Builds app-specific deep links from an NPCI upi:// URI.
 */
export function buildAppIntents(baseUpiUri) {
  const query = baseUpiUri.replace(/^upi:\/\/pay\?/, '');
  return {
    generic: baseUpiUri,
    gpay: `gpay://upi/pay?${query}`,
    phonepe: `phonepe://upi/pay?${query}`,
    paytm: `paytmmp://upi/pay?${query}`,
    cred: `credpay://upi/pay?${query}`,
    bhim: `bhim://upi/pay?${query}`
  };
}

// ---------------- PhonePe PG Implementation ----------------

export class PhonePeAdapter {
  constructor(options = {}) {
    this.merchantId = options.merchantId || env('PHONEPE_MERCHANT_ID') || 'PGTESTPAYUAT';
    this.saltKey = options.saltKey || env('PHONEPE_SALT_KEY') || '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';
    this.saltIndex = options.saltIndex || env('PHONEPE_SALT_INDEX') || '1';
    this.hostUrl = options.hostUrl || env('PHONEPE_HOST_URL') || 'https://api-preprod.phonepe.com/apis/pg-sandbox';
    this.merchantVpa = options.merchantVpa || env('PHONEPE_MERCHANT_VPA') || 'nightlifez@ybl';
    this.isSandbox = this.merchantId.includes('TEST') || this.hostUrl.includes('sandbox');
  }

  /**
   * Generates PhonePe X-VERIFY header:
   * SHA256(payload + endpoint + saltKey) + "###" + saltIndex
   */
  signRequest(bodyString, endpoint) {
    const raw = `${bodyString}${endpoint}${this.saltKey}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return `${hash}###${this.saltIndex}`;
  }

  /**
   * Verifies PhonePe X-VERIFY header on incoming webhooks:
   * Official PhonePe S2S specification: SHA256(base64Response + saltKey) + "###" + saltIndex
   */
  verifyWebhookSignature(signatureHeader, base64Response, rawResponseBody = '') {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const parts = signatureHeader.split('###');
    if (parts.length !== 2) return false;
    const [gotHash, index] = parts;
    if (String(index) !== String(this.saltIndex)) return false;

    // 1. Official PhonePe S2S formula: SHA256(base64Response + saltKey)
    if (base64Response && typeof base64Response === 'string') {
      const expectedHashOfficial = crypto.createHash('sha256').update(`${base64Response}${this.saltKey}`).digest('hex');
      if (safeEqual(gotHash, expectedHashOfficial)) return true;
    }

    // 2. Fallback check for raw request body string
    if (rawResponseBody && typeof rawResponseBody === 'string') {
      const expectedHashRaw = crypto.createHash('sha256').update(`${rawResponseBody}${this.saltKey}`).digest('hex');
      if (safeEqual(gotHash, expectedHashRaw)) return true;
    }

    return false;
  }

  /**
   * Creates a payment intent (returns both deep links and dynamic QR).
   */
  async createPaymentIntent({
    orderId,
    amountPaise,
    eventTitle = 'NIGHTLIFEZ Event',
    userId,
    userPhone = null,
    deviceType = 'desktop',
    returnUrl = ''
  }) {
    if (!orderId || !amountPaise || amountPaise <= 0) {
      throw new PaymentAdapterError('Invalid order parameters for payment intent', 'INVALID_PARAMS', 400);
    }

    // 1. Build standardized NPCI UPI URI
    const upiUri = buildUpiUri({
      vpa: this.merchantVpa,
      name: 'NIGHTLIFEZ Experiences',
      amountPaise,
      orderId,
      note: eventTitle
    });

    const appIntents = buildAppIntents(upiUri);
    const qrSvg = generateQrSvg(upiUri, { size: 280 });
    const expiresAt = new Date(Date.now() + UPI_INTENT_TTL_SECONDS * 1000).toISOString();

    return {
      provider: 'phonepe',
      providerTxnId: `TXN-${orderId}`,
      orderId,
      status: 'pending',
      amountPaise,
      currency: 'INR',
      deviceType,
      upiIntentUrl: upiUri,
      appIntents,
      qrData: upiUri,
      qrSvg,
      expiresInSeconds: UPI_INTENT_TTL_SECONDS,
      expiresAt
    };
  }

  /**
   * Queries payment status directly from PhonePe gateway.
   */
  async getPaymentStatus(orderId, providerTxnId = null) {
    const endpoint = `/pg/v1/status/${this.merchantId}/${orderId}`;
    const xVerify = this.signRequest('', endpoint);

    try {
      const res = await fetch(`${this.hostUrl}${endpoint}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': xVerify,
          'X-MERCHANT-ID': this.merchantId
        }
      });

      if (!res.ok) {
        throw new PaymentAdapterError(`PhonePe status check failed with HTTP ${res.status}`, 'GATEWAY_ERROR');
      }

      const json = await res.json();
      const code = json.code;
      const state = json.data?.state;

      let normalizedStatus = 'pending';
      if (code === 'PAYMENT_SUCCESS' || state === 'COMPLETED') {
        normalizedStatus = 'succeeded';
      } else if (code === 'PAYMENT_ERROR' || state === 'FAILED') {
        normalizedStatus = 'failed';
      } else if (code === 'PAYMENT_DECLINED') {
        normalizedStatus = 'cancelled';
      }

      return {
        provider: 'phonepe',
        orderId,
        providerTxnId: json.data?.transactionId || providerTxnId || `TXN-${orderId}`,
        providerPaymentId: json.data?.paymentInstrument?.utr || null,
        status: normalizedStatus,
        amountPaise: json.data?.amount || null,
        rawStatus: code,
        message: json.message || ''
      };
    } catch (err) {
      if (err instanceof PaymentAdapterError) throw err;
      throw new PaymentAdapterError(`PhonePe status error: ${err.message}`, 'NETWORK_ERROR');
    }
  }

  /**
   * Verifies and decodes incoming PhonePe webhook payload.
   */
  verifyWebhook(headers, rawBody) {
    const signature = headers['x-verify'] || headers['X-VERIFY'];
    if (!signature) {
      throw new WebhookSignatureError('Invalid PhonePe webhook signature: missing header');
    }

    let parsed;
    try {
      parsed = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch {
      throw new HttpError(400, 'invalid_json', 'Invalid JSON body');
    }

    if (!parsed || !parsed.response || typeof parsed.response !== 'string') {
      throw new HttpError(400, 'missing_response', 'Missing base64 response field');
    }

    const base64Response = parsed.response;
    if (!this.verifyWebhookSignature(signature, base64Response, typeof rawBody === 'string' ? rawBody : '')) {
      throw new WebhookSignatureError('Invalid PhonePe webhook signature');
    }

    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(base64Response, 'base64').toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid_payload', 'Could not decode base64 response payload');
    }

    const data = decoded.data || {};
    const code = decoded.code;
    const state = data.state;

    let normalizedStatus = 'pending';
    if (code === 'PAYMENT_SUCCESS' || state === 'COMPLETED') {
      normalizedStatus = 'succeeded';
    } else if (code === 'PAYMENT_ERROR' || state === 'FAILED') {
      normalizedStatus = 'failed';
    } else if (code === 'PAYMENT_DECLINED') {
      normalizedStatus = 'cancelled';
    }

    return {
      provider: 'phonepe',
      orderId: data.merchantTransactionId,
      providerTxnId: data.transactionId,
      providerPaymentId: data.paymentInstrument?.utr || null,
      amountPaise: data.amount,
      status: normalizedStatus,
      rawStatus: code,
      raw: decoded
    };
  }

  /**
   * Initiates a refund for a completed transaction via PhonePe.
   */
  async initiateRefund({ orderId, amountPaise, reason = 'Customer requested refund' }) {
    const refundTxnId = `RFND-${orderId}-${Date.now().toString(36)}`;
    const endpoint = '/pg/v1/refund';
    const payload = {
      merchantId: this.merchantId,
      merchantTransactionId: refundTxnId,
      originalTransactionId: orderId,
      amount: amountPaise,
      callbackUrl: `${env('PUBLIC_SITE_URL') || 'https://sm.test'}/api/payments/webhook/phonepe`
    };

    const bodyString = Buffer.from(JSON.stringify(payload)).toString('base64');
    const xVerify = this.signRequest(bodyString, endpoint);

    try {
      const res = await fetch(`${this.hostUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': xVerify
        },
        body: JSON.stringify({ request: bodyString })
      });

      if (!res.ok) {
        throw new PaymentAdapterError(`PhonePe refund call failed with HTTP ${res.status}`, 'REFUND_FAILED');
      }

      const json = await res.json();
      return {
        refundId: refundTxnId,
        status: json.code === 'PAYMENT_SUCCESS' ? 'refunded' : 'refund_pending',
        raw: json
      };
    } catch (err) {
      if (err instanceof PaymentAdapterError) throw err;
      throw new PaymentAdapterError(`PhonePe refund exception: ${err.message}`, 'REFUND_ERROR');
    }
  }
}

// ---------------- Mock / Test Sandbox Adapter ----------------

export class MockUpiAdapter {
  constructor() {
    this.merchantVpa = 'nightlifez.test@ybl';
    this.simulatedResults = new Map();
  }

  setSimulatedStatus(orderId, status) {
    this.simulatedResults.set(orderId, status);
  }

  async createPaymentIntent({ orderId, amountPaise, eventTitle = 'NIGHTLIFEZ Event', deviceType = 'desktop' }) {
    const upiUri = buildUpiUri({
      vpa: this.merchantVpa,
      name: 'NIGHTLIFEZ Experiences (Test)',
      amountPaise,
      orderId,
      note: eventTitle
    });

    return {
      provider: 'upi_mock',
      providerTxnId: `MOCK-${orderId}`,
      orderId,
      status: 'pending',
      amountPaise,
      currency: 'INR',
      deviceType,
      upiIntentUrl: upiUri,
      appIntents: buildAppIntents(upiUri),
      qrData: upiUri,
      qrSvg: generateQrSvg(upiUri, { size: 280 }),
      expiresInSeconds: UPI_INTENT_TTL_SECONDS,
      expiresAt: new Date(Date.now() + UPI_INTENT_TTL_SECONDS * 1000).toISOString()
    };
  }

  async getPaymentStatus(orderId, providerTxnId = null) {
    const sim = this.simulatedResults.get(orderId) || 'pending';
    return {
      provider: 'upi_mock',
      orderId,
      providerTxnId: providerTxnId || `MOCK-${orderId}`,
      providerPaymentId: sim === 'succeeded' ? `UTR${Date.now()}` : null,
      status: sim,
      amountPaise: 49900,
      rawStatus: sim.toUpperCase(),
      message: `Simulated mock payment ${sim}`
    };
  }

  verifyWebhook(headers, rawBody) {
    const secret = headers['x-webhook-secret'] || headers['x-verify'];
    if (secret !== 'test-upi-webhook-secret') {
      throw new WebhookSignatureError('Invalid mock webhook secret');
    }

    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    return {
      provider: 'upi_mock',
      orderId: body.orderId,
      providerTxnId: body.providerTxnId || `MOCK-${body.orderId}`,
      providerPaymentId: body.utr || `UTR${Date.now()}`,
      amountPaise: body.amountPaise,
      status: body.status || 'succeeded',
      rawStatus: (body.status || 'succeeded').toUpperCase(),
      raw: body
    };
  }

  async initiateRefund({ orderId, amountPaise }) {
    return {
      refundId: `MOCK-RFND-${orderId}`,
      status: 'refunded',
      amountPaise
    };
  }
}

// ---------------- Factory ----------------

const phonePeInstance = new PhonePeAdapter();
const mockInstance = new MockUpiAdapter();

export function getPaymentAdapter(providerName = process.env.UPI_PAYMENT_PROVIDER || 'phonepe') {
  if (providerName === 'upi_mock' || process.env.NODE_ENV === 'test' && !process.env.FORCE_PHONEPE) {
    return phonePeInstance; // PhonePe adapter handles both test and prod through configuration
  }
  return phonePeInstance;
}

export { phonePeInstance, mockInstance };
