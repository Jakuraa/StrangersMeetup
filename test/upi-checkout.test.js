// test/upi-checkout.test.js - Milestone M4.1: UPI-First Checkout, Dynamic QR & Verified Payment Integration.
// Tests mobile UPI intent, app-specific links, desktop dynamic QR, PhonePe PG adapter, webhook signatures,
// idempotency, state machine transitions, refunds, and access isolation.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jsQR from 'jsqr';
import {
  resetDb, startServer, stopServer, Client, db, callsTo, clearCalls, createEvent, signedInClient, stubUrl
} from './helpers.js';
import {
  encodeQrMatrix,
  generateQrSvg,
  buildUpiUri,
  VERSIONS,
  MAX_QR_PAYLOAD_BYTES,
  ALIGNMENT_PATTERN_POS,
  QrPayloadTooLargeError
} from '../lib/upi/qr.js';
import {
  PhonePeAdapter,
  MockUpiAdapter,
  buildAppIntents
} from '../lib/upi/adapter.js';
import {
  createUpiPaymentIntent,
  getUpiPaymentStatus,
  applySuccessfulUpiPayment,
  claimUpiBooking,
  activePaymentHolds,
  processUpiWebhook,
  refundUpiOrder,
  isLegalTransition
} from '../lib/services/upi-payments.js';
import { renderUpiCheckout } from '../lib/views/checkout-upi.js';

let guest1;
let guest2;
let guest3;
let admin;
let seq = 0;

before(async () => {
  process.env.ENABLE_LIVE_PAYMENTS = 'true';
  process.env.ALLOW_PREVIEW_PAID_CHECKOUT = 'true';
  stubUrl('https://api-preprod.phonepe.com', (url, init) => {
    if (url.includes('/pg/v1/refund')) {
      return {
        status: 200,
        body: JSON.stringify({
          success: true,
          code: 'PAYMENT_SUCCESS',
          message: 'Refund successful',
          data: {
            transactionId: 'TXN-REFUND-MOCK-1',
            amount: 40000,
            state: 'COMPLETED'
          }
        })
      };
    }
    return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS' }) };
  });
  await resetDb();
  await startServer();
  guest1 = await signedInClient();
  guest2 = await signedInClient();
  guest3 = await signedInClient();
  admin = await signedInClient({ tgId: 900000001 });
  await admin.get('/api/admin/session');
});

after(async () => {
  stubUrl('https://api-preprod.phonepe.com', null);
  process.env.ENABLE_LIVE_PAYMENTS = 'false';
  delete process.env.ALLOW_PREVIEW_PAID_CHECKOUT;
  await stopServer();
});

beforeEach(clearCalls);

async function createPaidEvent({ price = 49900, capacity = 10, title = 'Paid UPI Event' } = {}) {
  const ev = await createEvent({ title, price, capacity, status: 'published' });
  await db.query(`UPDATE events SET ticketing = 'tiers', checkout_mode = 'upi_direct' WHERE id = $1`, [ev.id]);
  const tier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'VIP Entry', 'paid', $2, $3, 4, true) RETURNING *`,
    [ev.id, price, capacity]
  );
  return { event: ev, tier };
}

// ---------------- 1. QR Code & NPCI UPI URI Generation ----------------

test('QR & URI: generates valid NPCI UPI URI with merchant, amount, orderId and note', () => {
  const uri = buildUpiUri({
    vpa: 'nightlifez@ybl',
    name: 'NIGHTLIFEZ Experiences',
    amountPaise: 49900,
    orderId: 'ORD-UPI-TEST1',
    note: 'Bangalore Rooftop Mixer'
  });

  assert.ok(uri.startsWith('upi://pay?'), 'URI starts with upi://pay?');
  const u = new URL(uri);
  assert.equal(u.searchParams.get('pa'), 'nightlifez@ybl');
  assert.equal(u.searchParams.get('pn'), 'NIGHTLIFEZ Experiences');
  assert.equal(u.searchParams.get('am'), '499.00');
  assert.equal(u.searchParams.get('cu'), 'INR');
  assert.equal(u.searchParams.get('tr'), 'ORD-UPI-TEST1');
  assert.equal(u.searchParams.get('tn'), 'Bangalore Rooftop Mixer');

  // SVG QR Generation
  const svg = generateQrSvg(uri, { size: 280 });
  assert.ok(svg.includes('<svg'), 'contains svg root');
  assert.ok(svg.includes('viewBox="0 0 280 280"'), 'correct viewBox');
  assert.ok(svg.includes('<rect'), 'contains background rect');
  assert.ok(svg.includes('<path'), 'contains module path');
});

// ---------------- 2. Mobile UPI Intent & App-Specific Deep Links ----------------

test('mobile intents: generates generic UPI intent and app-specific deep links', () => {
  const baseUri = 'upi://pay?pa=nightlifez%40ybl&pn=NIGHTLIFEZ&am=250.00&cu=INR&tr=ORD123';
  const apps = buildAppIntents(baseUri);

  assert.equal(apps.generic, baseUri);
  assert.ok(apps.gpay.startsWith('gpay://upi/pay?pa='), 'Google Pay intent');
  assert.ok(apps.phonepe.startsWith('phonepe://upi/pay?pa='), 'PhonePe intent');
  assert.ok(apps.paytm.startsWith('paytmmp://upi/pay?pa='), 'Paytm intent');
  assert.ok(apps.cred.startsWith('credpay://upi/pay?pa='), 'CRED intent');
  assert.ok(apps.bhim.startsWith('bhim://upi/pay?pa='), 'BHIM intent');
});

// ---------------- 3. Payment Intent Creation & Database Integrity ----------------

test('payment intent: creates pending payment row and audit ledger entry', async () => {
  const { event, tier } = await createPaidEvent({ price: 75000, capacity: 20 });

  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 2,
    deviceType: 'mobile',
    clientIp: '10.0.0.1'
  });

  assert.ok(intent.orderId.startsWith('ORD-UPI-'));
  assert.equal(intent.amountPaise, 150000);
  assert.equal(intent.amountRupees, '1500.00');
  assert.equal(intent.status, 'pending');
  assert.ok(intent.upiIntentUrl.startsWith('upi://pay?'));
  assert.ok(intent.appIntents.gpay);
  assert.ok(intent.qrSvg.includes('<svg'));

  // Database verification
  const paymentRow = await db.one(`SELECT * FROM payments WHERE order_id = $1`, [intent.orderId]);
  assert.equal(paymentRow.status, 'pending');
  assert.equal(Number(paymentRow.amount), 150000);
  assert.equal(paymentRow.currency, 'INR');
  assert.equal(paymentRow.user_id, guest1.userId);
  assert.equal(paymentRow.device_type, 'mobile');

  // Audit ledger verification
  const auditRow = await db.one(`SELECT * FROM payment_audits WHERE order_id = $1`, [intent.orderId]);
  assert.equal(auditRow.from_status, 'created');
  assert.equal(auditRow.to_status, 'pending');
  assert.equal(auditRow.actor, `user:${guest1.userId}`);
});

// ---------------- 4. State Machine Invariants ----------------

test('state machine: strictly validates legal and illegal status transitions', () => {
  // Legal transitions
  assert.equal(isLegalTransition('created', 'pending'), true);
  assert.equal(isLegalTransition('pending', 'succeeded'), true);
  assert.equal(isLegalTransition('pending', 'failed'), true);
  assert.equal(isLegalTransition('pending', 'expired'), true);
  assert.equal(isLegalTransition('pending', 'cancelled'), true);
  assert.equal(isLegalTransition('succeeded', 'refund_pending'), true);
  assert.equal(isLegalTransition('succeeded', 'refunded'), true);
  assert.equal(isLegalTransition('succeeded', 'disputed'), true);
  assert.equal(isLegalTransition('pending', 'pending'), true); // Idempotent self-transition

  // Illegal transitions (must fail)
  assert.equal(isLegalTransition('failed', 'succeeded'), false);
  assert.equal(isLegalTransition('expired', 'succeeded'), false);
  assert.equal(isLegalTransition('succeeded', 'pending'), false);
  assert.equal(isLegalTransition('refunded', 'succeeded'), false);
});

// ---------------- 5. Webhook Signature Verification ----------------

test('webhook security: PhonePe adapter verifies valid signature and rejects tampered ones', () => {
  const adapter = new PhonePeAdapter({
    merchantId: 'PGTESTPAYUAT',
    saltKey: '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1',
    saltIndex: '1'
  });

  const rawPayload = JSON.stringify({
    response: Buffer.from(JSON.stringify({
      code: 'PAYMENT_SUCCESS',
      data: {
        merchantId: 'PGTESTPAYUAT',
        merchantTransactionId: 'ORD-TEST-SIG-1',
        transactionId: 'TXN123',
        amount: 49900,
        state: 'COMPLETED'
      }
    })).toString('base64')
  });

  // Correct signature
  const validHash = crypto.createHash('sha256').update(`${rawPayload}099eb0cd-0252-4e2a-8aca-eb3c6bd470f1`).digest('hex');
  const validHeader = `${validHash}###1`;

  const verified = adapter.verifyWebhook({ 'x-verify': validHeader }, rawPayload);
  assert.equal(verified.orderId, 'ORD-TEST-SIG-1');
  assert.equal(verified.status, 'succeeded');

  // Tampered payload
  const tamperedPayload = JSON.stringify({ response: 'dGFtcGVyZWQ=' });
  assert.throws(
    () => adapter.verifyWebhook({ 'x-verify': validHeader }, tamperedPayload),
    /Invalid PhonePe webhook signature/
  );

  // Wrong salt index
  assert.throws(
    () => adapter.verifyWebhook({ 'x-verify': `${validHash}###2` }, rawPayload),
    /Invalid PhonePe webhook signature/
  );

  // Missing header
  assert.throws(
    () => adapter.verifyWebhook({}, rawPayload),
    /Invalid PhonePe webhook signature/
  );
});

// ---------------- 6. Webhook Processing & Booking Confirmation ----------------

test('webhook confirmation: valid webhook confirms booking, updates payment, and is idempotent', async () => {
  const { event, tier } = await createPaidEvent({ price: 50000, capacity: 10 });
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest2,
    ticketTypeId: tier.id,
    quantity: 1,
    deviceType: 'desktop'
  });

  const adapter = new PhonePeAdapter({
    merchantId: 'PGTESTPAYUAT',
    saltKey: '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1',
    saltIndex: '1'
  });

  const responseJson = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: intent.orderId,
      transactionId: `TXN-${intent.orderId}`,
      amount: 50000,
      state: 'COMPLETED',
      paymentInstrument: {
        type: 'UPI',
        utr: 'UTR9988776655'
      }
    }
  };

  const rawBody = JSON.stringify({
    response: Buffer.from(JSON.stringify(responseJson)).toString('base64')
  });

  const validHash = crypto.createHash('sha256').update(`${rawBody}099eb0cd-0252-4e2a-8aca-eb3c6bd470f1`).digest('hex');
  const headers = { 'x-verify': `${validHash}###1` };

  // First delivery: processes successfully
  const r1 = await processUpiWebhook({ headers, rawBody, clientIp: '127.0.0.1' });
  assert.equal(r1.ok, true);
  assert.equal(r1.result, 'confirmed');

  // Verify payment status in DB
  const paymentRow = await db.one(`SELECT * FROM payments WHERE order_id = $1`, [intent.orderId]);
  assert.equal(paymentRow.status, 'succeeded');
  assert.equal(paymentRow.provider_payment_id, 'UTR9988776655');
  assert.ok(paymentRow.booking_id, 'booking_id linked');

  // Verify confirmed booking in DB
  const bookingRow = await db.one(`SELECT * FROM bookings WHERE id = $1`, [paymentRow.booking_id]);
  assert.equal(bookingRow.status, 'confirmed');
  assert.equal(bookingRow.payment_mode, 'provider');
  assert.equal(Number(bookingRow.amount_paise), 50000);

  // Second delivery (Replay): idempotent duplicate
  const r2 = await processUpiWebhook({ headers, rawBody, clientIp: '127.0.0.1' });
  assert.equal(r2.ok, true);
  assert.equal(r2.result, 'duplicate');

  // Bookings count for event remains 1
  const count = await db.one(`SELECT count(*)::int AS count FROM bookings WHERE event_id = $1`, [event.id]);
  assert.equal(count.count, 1);
});

// ---------------- 7. Status Polling API ----------------

test('status polling: client polling returns current status and handles expiry', async () => {
  const { event, tier } = await createPaidEvent({ price: 30000 });
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest3,
    ticketTypeId: tier.id,
    quantity: 1
  });

  const c = new Client();

  // AUTH-01: Anonymous request rejected with 401
  const resAnon = await c.get(`/api/checkout/upi/status/${intent.orderId}`);
  assert.equal(resAnon.status, 401);

  // AUTH-01: Different user rejected with 403
  const resOther = await guest1.get(`/api/checkout/upi/status/${intent.orderId}`);
  assert.equal(resOther.status, 403);

  // Pending status for owner
  const resPending = await guest3.get(`/api/checkout/upi/status/${intent.orderId}`);
  assert.equal(resPending.status, 200);
  assert.equal(resPending.json.status, 'pending');
  assert.equal(resPending.json.amountPaise, 30000);

  // Manually expire payment in DB
  await db.query(`UPDATE payments SET expires_at = now() - interval '1 second' WHERE order_id = $1`, [intent.orderId]);

  // Polling after expiry returns expired
  const resExpired = await guest3.get(`/api/checkout/upi/status/${intent.orderId}`);
  assert.equal(resExpired.status, 200);
  assert.equal(resExpired.json.status, 'expired');
});

// ---------------- 8. Refund & Access Revocation ----------------

test('refunds: refund transitions payment to refunded and revokes Telegram invites', async () => {
  const { event, tier } = await createPaidEvent({ price: 40000 });
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // Confirm payment
  const succ = await applySuccessfulUpiPayment({
    orderId: intent.orderId,
    verifiedAmountPaise: 40000,
    currency: 'INR',
    merchantId: 'PGTESTPAYUAT',
    providerPaymentId: 'UTR-REFUND-1',
    actor: 'test'
  });

  // Create an active invite link for this booking
  const invite = await db.one(
    `INSERT INTO invite_links (booking_id, user_id, chat_id, link, expires_at)
     VALUES ($1, $2, -1001111111111, 'https://t.me/+testupirefund', now() + interval '1 day') RETURNING *`,
    [succ.bookingId, guest1.userId]
  );

  // Execute refund
  const refundRes = await refundUpiOrder(intent.orderId, { actor: 'admin:finance' });
  assert.equal(refundRes.status, 'refunded');

  // Verify payment is refunded
  const paymentCheck = await db.one(`SELECT status, refund_ref FROM payments WHERE order_id = $1`, [intent.orderId]);
  assert.equal(paymentCheck.status, 'refunded');
  assert.ok(paymentCheck.refund_ref);

  // Verify booking is refunded
  const bookingCheck = await db.one(`SELECT status FROM bookings WHERE id = $1`, [succ.bookingId]);
  assert.equal(bookingCheck.status, 'refunded');

  // Verify invite link was revoked
  const inviteCheck = await db.one(`SELECT revoked_at FROM invite_links WHERE id = $1`, [invite.id]);
  assert.ok(inviteCheck.revoked_at !== null, 'invite link revoked on refund');
});

// ---------------- 9. Concurrency & Overselling Prevention ----------------

test('concurrency: simultaneous checkout intents respect capacity limits', async () => {
  // Event with 1 remaining seat
  const { event, tier } = await createPaidEvent({ price: 20000, capacity: 1 });

  // Guest 1 creates intent
  const intent1 = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.ok(intent1.orderId);

  // Confirm guest 1's booking
  await applySuccessfulUpiPayment({
    orderId: intent1.orderId,
    verifiedAmountPaise: 20000,
    currency: 'INR',
    merchantId: 'PGTESTPAYUAT',
    actor: 'test'
  });

  // Guest 2 attempts to create intent for sold out tier
  await assert.rejects(
    () => createUpiPaymentIntent({
      slug: event.slug,
      user: guest2,
      ticketTypeId: tier.id,
      quantity: 1
    }),
    (err) => err.status === 409 && err.code === 'sold_out'
  );
});

// ---------------- 10. Safety Boundary Enforcement ----------------

test('safety boundary: ENABLE_LIVE_PAYMENTS=false blocks paid intent creation in non-test mode', async () => {
  const origAllow = process.env.ALLOW_PREVIEW_PAID_CHECKOUT;
  const origLive = process.env.ENABLE_LIVE_PAYMENTS;

  try {
    delete process.env.ALLOW_PREVIEW_PAID_CHECKOUT;
    process.env.ENABLE_LIVE_PAYMENTS = 'false';

    const { event, tier } = await createPaidEvent({ price: 20000 });

    await assert.rejects(
      () => createUpiPaymentIntent({
        slug: event.slug,
        user: guest1,
        ticketTypeId: tier.id,
        quantity: 1
      }),
      (err) => err.status === 403 && err.code === 'live_payments_disabled'
    );
  } finally {
    process.env.ALLOW_PREVIEW_PAID_CHECKOUT = origAllow;
    process.env.ENABLE_LIVE_PAYMENTS = origLive;
  }
});

// ---------------- 11. HTTP End-to-End Route Tests ----------------

test('http routes: GET /checkout/:slug/upi renders checkout view for signed-in user', async () => {
  const { event, tier } = await createPaidEvent({ price: 15000 });
  const res = await guest1.get(`/checkout/${event.slug}/upi?ticket_type_id=${tier.id}&quantity=1`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('Pay with UPI'));
  assert.ok(res.text.includes('Scan QR code to pay'));
  assert.ok(res.text.includes('Google Pay'));
  assert.ok(res.text.includes('PhonePe'));
  assert.ok(res.text.includes('Paytm'));
  assert.ok(res.text.includes('CRED'));
});

test('http routes: POST /api/checkout/upi/intent creates intent and returns QR and UPI URI', async () => {
  const { event, tier } = await createPaidEvent({ price: 25000 });
  const res = await guest1.post('/api/checkout/upi/intent', {
    slug: event.slug,
    ticketTypeId: tier.id,
    quantity: 1
  });

  assert.equal(res.status, 200);
  assert.ok(res.json.orderId);
  assert.ok(res.json.upiUri.startsWith('upi://pay?'));
  assert.ok(res.json.qrSvg.startsWith('<svg'));
  assert.ok(res.json.appIntents.gpay.startsWith('gpay://'));
});

test('http routes: POST /api/payments/webhook/phonepe processes valid webhook payload via HTTP', async () => {
  const { event, tier } = await createPaidEvent({ price: 10000 });
  const intentRes = await guest2.post('/api/checkout/upi/intent', {
    slug: event.slug,
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(intentRes.status, 200);
  const orderId = intentRes.json.orderId;

  const payload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: orderId,
      transactionId: `TXN-HTTP-${orderId}`,
      amount: 10000,
      state: 'COMPLETED',
      paymentInstrument: {
        type: 'UPI',
        utr: 'UTR-HTTP-999'
      }
    }
  };

  const rawBody = JSON.stringify({
    response: Buffer.from(JSON.stringify(payload)).toString('base64')
  });

  const validHash = crypto.createHash('sha256').update(`${rawBody}099eb0cd-0252-4e2a-8aca-eb3c6bd470f1`).digest('hex');
  const c = new Client();
  const res = await c.req('POST', '/api/payments/webhook/phonepe', rawBody, {
    'x-verify': `${validHash}###1`,
    'content-type': 'application/json'
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.result, 'confirmed');

  // Check payment row in DB
  const pay = await db.one('SELECT status, provider_payment_id FROM payments WHERE order_id = $1', [orderId]);
  assert.equal(pay.status, 'succeeded');
  assert.equal(pay.provider_payment_id, 'UTR-HTTP-999');
});

// ============================================================================
// Milestone M4.3: Critical UPI Security & Financial Integrity Remediation Tests
// ============================================================================

test('SEC-01: Authentic PhonePe S2S webhook signature calculation using base64 payload', () => {
  const adapter = new PhonePeAdapter();
  const innerPayload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: 'ORD-SEC01-TEST',
      transactionId: 'TXN-SEC01-1',
      amount: 49900,
      state: 'COMPLETED'
    }
  };
  const base64Response = Buffer.from(JSON.stringify(innerPayload)).toString('base64');
  const outerBody = JSON.stringify({ response: base64Response });

  // Official PhonePe S2S specification: SHA256(base64Response + saltKey) + "###" + saltIndex
  const saltKey = '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';
  const expectedHash = crypto.createHash('sha256').update(`${base64Response}${saltKey}`).digest('hex');
  const validHeader = `${expectedHash}###1`;

  const verified = adapter.verifyWebhook({ 'x-verify': validHeader }, outerBody);
  assert.equal(verified.orderId, 'ORD-SEC01-TEST');
  assert.equal(verified.status, 'succeeded');
  assert.equal(verified.amountPaise, 49900);

  // Tampered payload rejected
  const tamperedOuter = JSON.stringify({ response: Buffer.from(JSON.stringify({ ...innerPayload, code: 'PAYMENT_ERROR' })).toString('base64') });
  assert.throws(
    () => adapter.verifyWebhook({ 'x-verify': validHeader }, tamperedOuter),
    /Invalid PhonePe webhook signature/
  );

  // Tampered salt index rejected
  assert.throws(
    () => adapter.verifyWebhook({ 'x-verify': `${expectedHash}###2` }, outerBody),
    /Invalid PhonePe webhook signature/
  );
});

test('FIN-01: Webhook underpayment attack rejected and marked disputed with 0 bookings', async () => {
  const { event, tier } = await createPaidEvent({ price: 500000 }); // ₹5,000 ticket
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // Malicious webhook reporting payment of ₹1 (100 paise) instead of ₹5,000
  const underpayPayload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: intent.orderId,
      transactionId: `TXN-UNDERPAY-${intent.orderId}`,
      amount: 100, // Only 100 paise (₹1)
      state: 'COMPLETED',
      paymentInstrument: { type: 'UPI', utr: 'UTR-ATTACK-001' }
    }
  };
  const base64 = Buffer.from(JSON.stringify(underpayPayload)).toString('base64');
  const rawBody = JSON.stringify({ response: base64 });
  const saltKey = '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';
  const sig = crypto.createHash('sha256').update(`${base64}${saltKey}`).digest('hex') + '###1';

  const hookRes = await processUpiWebhook({
    headers: { 'x-verify': sig },
    rawBody,
    clientIp: '127.0.0.1'
  });

  assert.equal(hookRes.ok, false);
  assert.equal(hookRes.error, 'amount_mismatch');

  // Verify DB state: payment marked disputed
  const paymentRow = await db.one('SELECT status, failure_reason FROM payments WHERE order_id = $1', [intent.orderId]);
  assert.equal(paymentRow.status, 'disputed');
  assert.ok(paymentRow.failure_reason.includes('Amount mismatch'));

  // Zero confirmed bookings created
  const bookingCount = await db.one('SELECT count(*)::int AS count FROM bookings WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)', [intent.orderId]);
  assert.equal(bookingCount.count, 0);

  // Payment audit ledger records dispute with amount details
  const auditEntry = await db.one('SELECT * FROM payment_audits WHERE order_id = $1 AND to_status = $2', [intent.orderId, 'disputed']);
  assert.ok(auditEntry);
  assert.equal(auditEntry.details.reason, 'amount_mismatch');
  assert.equal(auditEntry.details.expectedPaise, 500000);
  assert.equal(auditEntry.details.verifiedPaise, 100);
});

test('DATA-01: Guest checkout flow without user_id succeeds on webhook without 500 and requires claim', async () => {
  const { event, tier } = await createPaidEvent({ price: 15000 });
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: null, // Guest checkout
    ticketTypeId: tier.id,
    quantity: 1
  });

  assert.ok(intent.guestToken, 'Guest token generated and returned');

  // Webhook arrives for this guest order
  const payload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: intent.orderId,
      transactionId: `TXN-GUEST-${intent.orderId}`,
      amount: 15000,
      state: 'COMPLETED',
      paymentInstrument: { type: 'UPI', utr: 'UTR-GUEST-001' }
    }
  };
  const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const rawBody = JSON.stringify({ response: base64 });
  const saltKey = '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';
  const sig = crypto.createHash('sha256').update(`${base64}${saltKey}`).digest('hex') + '###1';

  const hookRes = await processUpiWebhook({
    headers: { 'x-verify': sig },
    rawBody,
    clientIp: '127.0.0.1'
  });

  assert.equal(hookRes.ok, true);
  assert.equal(hookRes.guestClaimRequired, true);

  // Payment is succeeded in DB, but 0 bookings exist yet
  const payRow = await db.one('SELECT id, status, user_id, booking_id FROM payments WHERE order_id = $1', [intent.orderId]);
  assert.equal(payRow.status, 'succeeded');
  assert.equal(payRow.user_id, null);
  assert.equal(payRow.booking_id, null);

  // Anonymous claim fails with 401
  const c = new Client();
  const claimAnon = await c.post('/api/checkout/upi/claim', {
    orderId: intent.orderId,
    guestToken: intent.guestToken
  });
  assert.equal(claimAnon.status, 401);

  // Claim with wrong guestToken fails with 403
  const claimWrongToken = await guest1.post('/api/checkout/upi/claim', {
    orderId: intent.orderId,
    guestToken: 'wrong-token-12345'
  });
  assert.equal(claimWrongToken.status, 403);

  // Valid claim succeeds
  const claimValid = await guest1.post('/api/checkout/upi/claim', {
    orderId: intent.orderId,
    guestToken: intent.guestToken
  });
  assert.equal(claimValid.status, 200);
  assert.ok(claimValid.json.bookingId);
  assert.equal(claimValid.json.claimed, true);

  // Re-claim is idempotent
  const claimDup = await guest1.post('/api/checkout/upi/claim', {
    orderId: intent.orderId,
    guestToken: intent.guestToken
  });
  assert.equal(claimDup.status, 200);
  assert.equal(claimDup.json.duplicate, true);

  // Claimed booking is confirmed in DB
  const bookingRow = await db.one('SELECT * FROM bookings WHERE id = $1', [claimValid.json.bookingId]);
  assert.equal(bookingRow.status, 'confirmed');
  assert.equal(bookingRow.payment_id, payRow.id);
});

test('CONCUR-01: Active unexpired checkout intent holds capacity & re-checks at confirmation', async () => {
  // Event with capacity = 1
  const { event, tier } = await createPaidEvent({ price: 20000, capacity: 1 });

  // User 1 creates intent for 1 seat
  const intent1 = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.ok(intent1.orderId);

  // User 2 attempts to create intent while User 1 holds active unexpired intent
  await assert.rejects(
    async () => {
      await createUpiPaymentIntent({
        slug: event.slug,
        user: guest2,
        ticketTypeId: tier.id,
        quantity: 1
      });
    },
    /sold out/i
  );

  // Expire User 1's payment intent
  await db.query(`UPDATE payments SET expires_at = now() - interval '10 seconds' WHERE order_id = $1`, [intent1.orderId]);

  // User 2 can now create intent
  const intent2 = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest2,
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.ok(intent2.orderId);

  // Now test confirmation capacity guard: consume capacity manually
  await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, source, confirmed_at)
     VALUES ($1, $2, $3, 1, 'confirmed', 20000, 'free', 'site', now())`,
    [event.id, guest3.userId, tier.id]
  );

  // Confirming User 2's payment detects capacity exceeded
  const confirmResult = await applySuccessfulUpiPayment({
    orderId: intent2.orderId,
    verifiedAmountPaise: 20000,
    currency: 'INR',
    merchantId: 'PGTESTPAYUAT',
    providerTxnId: 'TXN-OVERSOLD-1',
    actor: 'test:concurrency'
  });

  assert.equal(confirmResult.overbooked, true);
  assert.equal(confirmResult.status, 'refund_pending');

  const payOversold = await db.one('SELECT status, failure_reason FROM payments WHERE order_id = $1', [intent2.orderId]);
  assert.equal(payOversold.status, 'refund_pending');
  assert.equal(payOversold.failure_reason, 'capacity_exceeded');
});

test('AUTH-01: Status endpoint authorization and guest token isolation', async () => {
  const { event, tier } = await createPaidEvent({ price: 10000 });
  const guestIntent = await createUpiPaymentIntent({
    slug: event.slug,
    user: null,
    ticketTypeId: tier.id,
    quantity: 1
  });

  const c = new Client();

  // Polling guest order without token is forbidden (403)
  const resNoToken = await c.get(`/api/checkout/upi/status/${guestIntent.orderId}`);
  assert.equal(resNoToken.status, 403);

  // Polling guest order with invalid token is forbidden (403)
  const resBadToken = await c.get(`/api/checkout/upi/status/${guestIntent.orderId}?token=invalid-guest-token`);
  assert.equal(resBadToken.status, 403);

  // Polling guest order with valid token succeeds (200)
  const resValidToken = await c.get(`/api/checkout/upi/status/${guestIntent.orderId}?token=${guestIntent.guestToken}`);
  assert.equal(resValidToken.status, 200);
  assert.equal(resValidToken.json.orderId, guestIntent.orderId);

  // Admin user can view guest order without token
  const resAdmin = await admin.get(`/api/checkout/upi/status/${guestIntent.orderId}`);
  assert.equal(resAdmin.status, 200);
});

test('QR-01: QR format info preserves mandatory Dark Module at (size - 8, 8)', () => {
  // Test Version 1 (21x21, <=14 bytes)
  const uriV1 = 'upi://pay';
  const qr1 = encodeQrMatrix(uriV1);
  assert.equal(qr1.version, 1);
  assert.equal(qr1.size, 21);
  assert.equal(qr1.get(qr1.size - 8, 8), true, 'Dark module at (size - 8, 8) in Version 1 must be true');

  // Test Version 3 (29x29)
  const uriV3 = 'upi://pay?pa=test@upi&pn=Test&am=100.00';
  const qr3 = encodeQrMatrix(uriV3);
  assert.equal(qr3.version, 3);
  assert.equal(qr3.size, 29);
  assert.equal(qr3.get(qr3.size - 8, 8), true, 'Dark module at (size - 8, 8) in Version 3 must be true');

  // Test Version 8 (49x49, long UPI URI with metadata)
  const uriLong = buildUpiUri({
    vpa: 'nightlifez@icici',
    name: 'NIGHTLIFEZ Experiences',
    amountPaise: 499900,
    orderId: 'ORD-UPI-TEST-V8-1234567890',
    note: 'Premium VIP Table Reservation'
  });
  const qr8 = encodeQrMatrix(uriLong);
  assert.equal(qr8.version, 8, 'Selected Version 8 for long URI');
  assert.equal(qr8.get(qr8.size - 8, 8), true, `Dark module at (size - 8, 8) in Version ${qr8.version} must be true`);
});

test('UI-01: Responsive CSS rules strictly isolate mobile intent and desktop QR', () => {
  const rendered = renderUpiCheckout({
    order: {
      orderId: 'ORD-UI-TEST',
      amountPaise: 29900,
      amountRupees: '299.00',
      currency: 'INR',
      eventTitle: 'UI Test Mixer',
      tierName: 'Standard',
      quantity: 1,
      upiUri: 'upi://pay?pa=test@upi',
      appIntents: { gpay: 'gpay://', phonepe: 'phonepe://', paytm: 'paytm://', cred: 'cred://', bhim: 'bhim://' },
      qrSvg: '<svg></svg>',
      expiresInSeconds: 600
    },
    event: { slug: 'ui-test-mixer', title: 'UI Test Mixer', city: 'Mumbai', start_at: new Date() },
    tier: { name: 'Standard', price_paise: 29900 },
    user: guest1.user
  });

  assert.ok(rendered.includes('.checkout-desktop { display: none !important; }'));
  assert.ok(rendered.includes('.checkout-mobile { display: none !important; }'));
  assert.ok(rendered.includes('@media (max-width: 768px)'));
  assert.ok(rendered.includes('@media (min-width: 769px)'));
  assert.ok(rendered.includes('class="checkout-desktop"'));
  assert.ok(rendered.includes('class="checkout-mobile"'));
});

test('DB-01: payment_audits table is strictly append-only and immutable', async () => {
  const { event, tier } = await createPaidEvent({ price: 10000 });
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 1
  });

  const auditRow = await db.one('SELECT id FROM payment_audits WHERE order_id = $1 LIMIT 1', [intent.orderId]);
  assert.ok(auditRow);

  // Direct UPDATE should be blocked by trigger
  await assert.rejects(
    async () => {
      await db.query(`UPDATE payment_audits SET actor = 'tampered' WHERE id = $1`, [auditRow.id]);
    },
    /append-only ledger/
  );

  // Direct DELETE should be blocked by trigger
  await assert.rejects(
    async () => {
      await db.query(`DELETE FROM payment_audits WHERE id = $1`, [auditRow.id]);
    },
    /append-only ledger/
  );
});

// ============================================================================
// Milestone M4.3.1: Remediate Independent Review Findings (REV-01 - REV-07)
// ============================================================================

function decodeQrMatrix(qr) {
  const scale = 4;
  const margin = 4;
  const width = (qr.size + margin * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  data.fill(255);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.get(r, c)) {
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const idx = (((r + margin) * scale + y) * width + ((c + margin) * scale + x)) * 4;
            data[idx] = 0;
            data[idx + 1] = 0;
            data[idx + 2] = 0;
            data[idx + 3] = 255;
          }
        }
      }
    }
  }
  return jsQR(data, width, width);
}

test('REV-01: QR alignment patterns across supported versions (1-14) and independent jsQR decoding', () => {
  // 1. Verify all versions from 1 to 14 independently decode with jsQR
  for (let v = 1; v <= 14; v++) {
    const minCap = v === 1 ? 8 : (VERSIONS[v - 1].dataCap + 1);
    const prefix = `V${v}:`;
    const payload = prefix + 'K'.repeat(minCap - prefix.length);
    const qr = encodeQrMatrix(payload);
    assert.equal(qr.version, v, `Expected Version ${v}`);

    // Verify dark module at (size - 8, 8)
    assert.equal(qr.get(qr.size - 8, 8), true, `Dark module must be set in Version ${v}`);

    // Verify independent decoding via jsQR
    const decoded = decodeQrMatrix(qr);
    assert.ok(decoded, `jsQR failed to decode Version ${v}`);
    assert.equal(decoded.data, payload, `Decoded payload mismatch for Version ${v}`);

    // Verify alignment patterns do not overwrite finder patterns
    const alignCoords = ALIGNMENT_PATTERN_POS[v] || [];
    const len = alignCoords.length;
    for (let i = 0; i < len; i++) {
      for (let j = 0; j < len; j++) {
        // Finder corners must not have alignment pattern centers
        if ((i === 0 && j === 0) || (i === 0 && j === len - 1) || (i === len - 1 && j === 0)) {
          continue;
        }
        const ar = alignCoords[i];
        const ac = alignCoords[j];
        // Center module must be dark
        assert.equal(qr.get(ar, ac), true, `Alignment pattern center at (${ar}, ${ac}) must be dark in Version ${v}`);
      }
    }
  }

  // 2. Test long UPI URI (243 bytes, selects Version 11) with metadata
  const longUri = buildUpiUri({
    vpa: 'nightlifez.business@okhdfcbank',
    name: 'NIGHTLIFEZ Experiences India Private Limited',
    amountPaise: 1249900,
    orderId: 'ORD-UPI-20261103-VERY-LONG-TRANSACTION-ID-XYZ9876543210',
    note: 'Nightlifez Bangalore VIP Access Pass Tier 1 With Complimentary Drink'
  });
  assert.ok(Buffer.byteLength(longUri, 'utf8') > 213, 'Expected payload length to exceed Version 10 capacity');
  const longQr = encodeQrMatrix(longUri);
  assert.ok(longQr.version >= 11, `Expected version >= 11, got ${longQr.version}`);
  const decodedLong = decodeQrMatrix(longQr);
  assert.equal(decodedLong?.data, longUri, 'Long UPI URI decoded accurately via jsQR');
});

test('REV-02: Duplicate active booking prevented during intent creation (409 already_booked)', async () => {
  const { event, tier } = await createPaidEvent({ price: 30000 });

  // 1. First booking confirmed for guest1
  await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, source)
     VALUES ($1, $2, $3, 1, 'confirmed', 30000, 'provider', 'site')`,
    [event.id, guest1.userId, tier.id]
  );

  // 2. Attempting to create a second UPI intent for the same event must be rejected
  await assert.rejects(
    async () => {
      await createUpiPaymentIntent({
        slug: event.slug,
        user: guest1,
        ticketTypeId: tier.id,
        quantity: 1
      });
    },
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'already_booked');
      return true;
    }
  );
});

test('REV-02: Duplicate booking during webhook confirmation moves payment to refund_pending with 0 bookings', async () => {
  const { event, tier } = await createPaidEvent({ price: 25000 });

  // 1. User creates a pending intent
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest2,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // 2. User gets an active booking confirmed out of band (or concurrent request)
  await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, source)
     VALUES ($1, $2, $3, 1, 'confirmed', 25000, 'free', 'site')`,
    [event.id, guest2.userId, tier.id]
  );

  // 3. Webhook arrives for the payment intent
  const adapter = new PhonePeAdapter();
  const innerPayload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: intent.orderId,
      transactionId: `TXN-DUP-${intent.orderId}`,
      amount: 25000,
      state: 'COMPLETED'
    }
  };
  const base64 = Buffer.from(JSON.stringify(innerPayload)).toString('base64');
  const rawBody = JSON.stringify({ response: base64 });
  const sig = crypto.createHash('sha256').update(`${base64}099eb0cd-0252-4e2a-8aca-eb3c6bd470f1`).digest('hex') + '###1';

  const hookRes = await processUpiWebhook({
    headers: { 'x-verify': sig },
    rawBody,
    clientIp: '127.0.0.1'
  });

  assert.equal(hookRes.ok, true);
  assert.equal(hookRes.result, 'duplicate_booking');

  // Verify DB state: payment transitioned to refund_pending
  const pay = await db.one('SELECT status, failure_reason FROM payments WHERE order_id = $1', [intent.orderId]);
  assert.equal(pay.status, 'refund_pending');
  assert.equal(pay.failure_reason, 'duplicate_booking');

  // Exactly 1 booking exists (the out-of-band one, zero duplicates created)
  const bks = await db.query('SELECT count(*)::int AS n FROM bookings WHERE event_id = $1 AND user_id = $2', [event.id, guest2.userId]);
  assert.equal(bks.rows[0].n, 1);

  // Audit entry records duplicate_booking reason
  const audit = await db.one(
    `SELECT * FROM payment_audits WHERE order_id = $1 AND to_status = 'refund_pending'`,
    [intent.orderId]
  );
  assert.ok(audit);
  assert.equal(audit.details.reason, 'duplicate_booking');
});

test('REV-02: Duplicate active booking during guest claim is rejected with 409 already_booked', async () => {
  const { event, tier } = await createPaidEvent({ price: 15000 });

  // 1. Guest creates intent (no user_id)
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: null,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // 2. Webhook confirms guest payment
  await applySuccessfulUpiPayment({
    orderId: intent.orderId,
    verifiedAmountPaise: 15000,
    currency: 'INR',
    merchantId: 'PGTESTPAYUAT',
    actor: 'test'
  });

  // 3. User already has a confirmed booking for this event
  await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, source)
     VALUES ($1, $2, $3, 1, 'confirmed', 15000, 'free', 'site')`,
    [event.id, guest3.userId, tier.id]
  );

  // 4. User attempts to claim guest booking -> rejected with 409 already_booked
  await assert.rejects(
    async () => {
      await claimUpiBooking({
        orderId: intent.orderId,
        guestToken: intent.guestToken,
        user: guest3
      });
    },
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'already_booked');
      return true;
    }
  );
});

test('REV-02: SQLSTATE 23505 defensive recovery moves payment to refund_pending without 500 error', async () => {
  const { event, tier } = await createPaidEvent({ price: 20000 });

  // Create an intent
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // Insert a conflicting booking with same (event_id, user_id) right before confirmation
  await db.query(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise, payment_mode, source)
     VALUES ($1, $2, $3, 1, 'pending_payment', 20000, 'provider', 'site')`,
    [event.id, guest1.userId, tier.id]
  );

  // Confirmation must cleanly handle the duplicate without throwing 500
  const res = await applySuccessfulUpiPayment({
    orderId: intent.orderId,
    verifiedAmountPaise: 20000,
    currency: 'INR',
    merchantId: 'PGTESTPAYUAT',
    actor: 'test'
  });

  assert.equal(res.status, 'refund_pending');
  assert.equal(res.duplicateBooking, true);

  const pay = await db.one('SELECT status, failure_reason FROM payments WHERE order_id = $1', [intent.orderId]);
  assert.equal(pay.status, 'refund_pending');
  assert.equal(pay.failure_reason, 'duplicate_booking');
});

test('REV-03: refund_pending operational recovery via admin/finance refund and idempotent retry', async () => {
  const { event, tier } = await createPaidEvent({ price: 35000 });

  // 1. Create intent and trigger overbooking to land in refund_pending
  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest2,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // Consume event capacity
  await db.query(`UPDATE events SET capacity = 0 WHERE id = $1`, [event.id]);

  const confirmRes = await applySuccessfulUpiPayment({
    orderId: intent.orderId,
    verifiedAmountPaise: 35000,
    currency: 'INR',
    merchantId: 'PGTESTPAYUAT',
    actor: 'test'
  });
  assert.equal(confirmRes.status, 'refund_pending');

  // 2. Admin/finance triggers refund for the refund_pending payment
  const refundRes = await refundUpiOrder(intent.orderId, {
    actor: 'admin:finance:900000001',
    reason: 'Event sold out before payment confirmation'
  });

  assert.equal(refundRes.status, 'refunded');
  assert.ok(refundRes.refundId);

  // 3. Verify DB state: payment transitioned from refund_pending to refunded
  const pay = await db.one('SELECT status, refund_ref FROM payments WHERE order_id = $1', [intent.orderId]);
  assert.equal(pay.status, 'refunded');
  assert.equal(pay.refund_ref, refundRes.refundId);

  // 4. Audit ledger preserves full trajectory: created -> pending -> refund_pending -> refunded
  const audits = (await db.query(
    `SELECT from_status, to_status, actor FROM payment_audits WHERE order_id = $1 ORDER BY id ASC`,
    [intent.orderId]
  )).rows;

  const trajectory = audits.map((a) => `${a.from_status}->${a.to_status}`);
  assert.ok(trajectory.includes('created->pending'), 'Expected created->pending');
  assert.ok(trajectory.includes('pending->refund_pending'), 'Expected pending->refund_pending');
  assert.ok(trajectory.includes('refund_pending->refunded'), 'Expected refund_pending->refunded');

  // 5. Retry of refund is idempotent
  const retryRes = await refundUpiOrder(intent.orderId, {
    actor: 'admin:finance:900000001'
  });
  assert.equal(retryRes.status, 'refunded');
  assert.equal(retryRes.duplicate, true);
});

test('REV-03: Provider refund failure leaves payment in refund_pending with manual finance reconciliation recovery', async () => {
  const { event, tier } = await createPaidEvent({ price: 18000 });

  const intent = await createUpiPaymentIntent({
    slug: event.slug,
    user: guest1,
    ticketTypeId: tier.id,
    quantity: 1
  });

  await applySuccessfulUpiPayment({
    orderId: intent.orderId,
    verifiedAmountPaise: 18000,
    currency: 'INR',
    merchantId: 'PGTESTPAYUAT',
    actor: 'test'
  });

  // Temporarily stub refund endpoint to simulate provider 500 failure
  stubUrl('https://api-preprod.phonepe.com', (url) => {
    if (url.includes('/pg/v1/refund')) {
      return {
        status: 500,
        body: JSON.stringify({ success: false, code: 'INTERNAL_SERVER_ERROR', message: 'Gateway error' })
      };
    }
    return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS' }) };
  });

  // Provider refund fails
  await assert.rejects(
    () => refundUpiOrder(intent.orderId, { actor: 'admin:finance' }),
    /Payment gateway refund initiation failed/
  );

  // Payment remains safely in refund_pending with failure reason
  const failedPay = await db.one('SELECT status, failure_reason FROM payments WHERE order_id = $1', [intent.orderId]);
  assert.equal(failedPay.status, 'refund_pending');
  assert.ok(failedPay.failure_reason.includes('refund_failed'));

  // Seed verified active finance admin in admin_users
  const financeAdminUser = await db.one(
    `INSERT INTO admin_users (telegram_user_id, role, active)
     VALUES (980000001, 'finance', true)
     ON CONFLICT (telegram_user_id) DO UPDATE SET active = true, role = 'finance'
     RETURNING *`
  );

  // Finance officer performs manual reconciliation recovery with verified role and documented references
  const reconRes = await refundUpiOrder(intent.orderId, {
    actor: `admin:${financeAdminUser.id}:finance`,
    reason: 'Manual bank transfer reversal confirmed via NetBanking',
    manualReconciliation: true,
    externalRefundRef: 'BANK-REV-20261104-999',
    evidenceRef: 'FIN-AUDIT-TICKET-2026-999'
  });

  assert.equal(reconRes.status, 'refunded');
  assert.equal(reconRes.refundId, 'BANK-REV-20261104-999');

  const finalPay = await db.one('SELECT status, refund_ref, reconciled, reconciled_at FROM payments WHERE order_id = $1', [intent.orderId]);
  assert.equal(finalPay.status, 'refunded');
  assert.equal(finalPay.refund_ref, 'BANK-REV-20261104-999');
  assert.equal(finalPay.reconciled, true);
  assert.ok(finalPay.reconciled_at);

  // Restore refund stub
  stubUrl('https://api-preprod.phonepe.com', (url) => {
    if (url.includes('/pg/v1/refund')) {
      return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS', data: { transactionId: 'TXN-REF-1' } }) };
    }
    return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS' }) };
  });
});

test('REV-04: Mandatory verified amount rejects omitted, null, non-numeric and underpayment attacks', async () => {
  const { event, tier } = await createPaidEvent({ price: 40000 });

  // 1. Omitted amount
  const intent1 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const res1 = await applySuccessfulUpiPayment({ orderId: intent1.orderId, verifiedAmountPaise: null });
  assert.equal(res1.status, 'disputed');
  assert.equal(res1.disputeReason, 'missing_or_invalid_verified_amount');

  // 2. Non-numeric / NaN amount
  const intent2 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const res2 = await applySuccessfulUpiPayment({ orderId: intent2.orderId, verifiedAmountPaise: NaN });
  assert.equal(res2.status, 'disputed');
  assert.equal(res2.disputeReason, 'missing_or_invalid_verified_amount');

  // 3. String non-numeric amount
  const intent3 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const res3 = await applySuccessfulUpiPayment({ orderId: intent3.orderId, verifiedAmountPaise: 'one_hundred' });
  assert.equal(res3.status, 'disputed');
  assert.equal(res3.disputeReason, 'missing_or_invalid_verified_amount');

  // 4. Negative amount
  const intent4 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const res4 = await applySuccessfulUpiPayment({ orderId: intent4.orderId, verifiedAmountPaise: -40000 });
  assert.equal(res4.status, 'disputed');
  assert.equal(res4.disputeReason, 'missing_or_invalid_verified_amount');

  // 5. Underpayment
  const intent5 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const res5 = await applySuccessfulUpiPayment({ orderId: intent5.orderId, verifiedAmountPaise: 39999 });
  assert.equal(res5.status, 'disputed');
  assert.equal(res5.disputeReason, 'amount_mismatch');

  // 6. Currency mismatch
  const intent6 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const res6 = await applySuccessfulUpiPayment({ orderId: intent6.orderId, verifiedAmountPaise: 40000, currency: 'USD', merchantId: 'PGTESTPAYUAT' });
  assert.equal(res6.status, 'disputed');
  assert.equal(res6.disputeReason, 'currency_mismatch');

  // Verify zero bookings were created for all 6 disputed attempts
  for (const it of [intent1, intent2, intent3, intent4, intent5, intent6]) {
    const pay = await db.one('SELECT status FROM payments WHERE order_id = $1', [it.orderId]);
    assert.equal(pay.status, 'disputed');
    const bk = await db.query('SELECT count(*)::int AS n FROM bookings WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)', [it.orderId]);
    assert.equal(bk.rows[0].n, 0);
  }
});

test('REV-05: Overlong QR payload byte limit returns 400 error rather than unhandled 500', async () => {
  const { event, tier } = await createPaidEvent({ price: 10000 });

  // 1. Raw QR encoder rejects payloads exceeding byte capacity
  const giantText = 'upi://pay?' + 'x'.repeat(400);
  assert.throws(
    () => encodeQrMatrix(giantText),
    (err) => {
      assert.ok(err instanceof QrPayloadTooLargeError);
      assert.equal(err.status, 400);
      return true;
    }
  );

  // 2. Multi-byte UTF-8 calculation verifies bytes not character length
  // 3-byte unicode character '🎉' repeated 130 times = 520 bytes > 362 bytes max
  const multiBytePayload = 'upi://pay?tn=' + '🎉'.repeat(130);
  assert.ok(multiBytePayload.length < 362, 'JS character length is under 362');
  assert.ok(Buffer.byteLength(multiBytePayload, 'utf8') > 362, 'Byte length exceeds 362');
  assert.throws(
    () => encodeQrMatrix(multiBytePayload),
    (err) => {
      assert.equal(err.status, 400);
      return true;
    }
  );

  // 3. buildUpiUri preserves full note and never silently truncates
  const fullNote = 'Important Notice: Non-refundable ticket reservation including VIP table and drinks';
  const uri = buildUpiUri({
    vpa: 'test@upi',
    name: 'Nightlifez',
    amountPaise: 1000,
    orderId: 'ORD-TEST-FULL-NOTE',
    note: fullNote
  });
  assert.ok(uri.includes(encodeURIComponent(fullNote).replace(/%20/g, '+')));
});

test('REV-06: PhonePe webhook merchantId verification rejects missing and mismatched merchant identifiers', () => {
  const adapter = new PhonePeAdapter({
    merchantId: 'PGTESTPAYUAT',
    saltKey: '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1',
    saltIndex: '1'
  });

  const saltKey = '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';

  // 1. Missing merchantId
  const missingIdPayload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantTransactionId: 'ORD-REV06-1',
      transactionId: 'TXN1',
      amount: 10000,
      state: 'COMPLETED'
    }
  };
  const b64Missing = Buffer.from(JSON.stringify(missingIdPayload)).toString('base64');
  const bodyMissing = JSON.stringify({ response: b64Missing });
  const sigMissing = crypto.createHash('sha256').update(`${b64Missing}${saltKey}`).digest('hex') + '###1';

  assert.throws(
    () => adapter.verifyWebhook({ 'x-verify': sigMissing }, bodyMissing),
    /merchantId mismatch or missing/
  );

  // 2. Mismatched merchantId
  const mismatchedPayload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'ATTACKER_MERCHANT',
      merchantTransactionId: 'ORD-REV06-2',
      transactionId: 'TXN2',
      amount: 10000,
      state: 'COMPLETED'
    }
  };
  const b64Mismatch = Buffer.from(JSON.stringify(mismatchedPayload)).toString('base64');
  const bodyMismatch = JSON.stringify({ response: b64Mismatch });
  const sigMismatch = crypto.createHash('sha256').update(`${b64Mismatch}${saltKey}`).digest('hex') + '###1';

  assert.throws(
    () => adapter.verifyWebhook({ 'x-verify': sigMismatch }, bodyMismatch),
    /merchantId mismatch or missing/
  );

  // 3. Valid merchantId succeeds
  const validPayload = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: 'ORD-REV06-3',
      transactionId: 'TXN3',
      amount: 10000,
      state: 'COMPLETED'
    }
  };
  const b64Valid = Buffer.from(JSON.stringify(validPayload)).toString('base64');
  const bodyValid = JSON.stringify({ response: b64Valid });
  const sigValid = crypto.createHash('sha256').update(`${b64Valid}${saltKey}`).digest('hex') + '###1';

  const verified = adapter.verifyWebhook({ 'x-verify': sigValid }, bodyValid);
  assert.equal(verified.merchantId, 'PGTESTPAYUAT');
  assert.equal(verified.orderId, 'ORD-REV06-3');
});

test('M4.3.2: Merchant identity must fail closed across adapters and payment confirmation', async () => {
  const saltKey = '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';

  // 1. PhonePe adapter rejects missing, null, empty string, and mismatched merchantId
  const phonePe = new PhonePeAdapter({
    merchantId: 'PGTESTPAYUAT',
    saltKey,
    saltIndex: '1'
  });

  for (const badMerchantId of [undefined, null, '', '   ', 'ATTACKER_MERCHANT']) {
    const payload = {
      code: 'PAYMENT_SUCCESS',
      data: {
        ...(badMerchantId !== undefined ? { merchantId: badMerchantId } : {}),
        merchantTransactionId: 'ORD-M432-PHONEPE',
        transactionId: 'TXN-P1',
        amount: 25000,
        state: 'COMPLETED'
      }
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const body = JSON.stringify({ response: b64 });
    const sig = crypto.createHash('sha256').update(`${b64}${saltKey}`).digest('hex') + '###1';

    assert.throws(
      () => phonePe.verifyWebhook({ 'x-verify': sig }, body),
      /merchantId/i,
      `PhonePe adapter must reject bad merchantId: ${badMerchantId}`
    );
  }

  // 2. PhonePe adapter rejects if adapter itself has missing configured merchantId
  const unconfiguredPhonePe = new PhonePeAdapter({ merchantId: '', saltKey, saltIndex: '1' });
  const validPayload = {
    code: 'PAYMENT_SUCCESS',
    data: { merchantId: 'PGTESTPAYUAT', merchantTransactionId: 'ORD-M432-1', transactionId: 'TXN1', amount: 10000, state: 'COMPLETED' }
  };
  const b64Valid = Buffer.from(JSON.stringify(validPayload)).toString('base64');
  const sigValid = crypto.createHash('sha256').update(`${b64Valid}${saltKey}`).digest('hex') + '###1';
  assert.throws(
    () => unconfiguredPhonePe.verifyWebhook({ 'x-verify': sigValid }, JSON.stringify({ response: b64Valid })),
    /merchant ID configuration is missing/i
  );

  // 3. Mock adapter rejects missing, null, empty string, and mismatched merchantId
  const mockAdapter = new MockUpiAdapter({ merchantId: 'PGTESTPAYUAT' });

  for (const badMerchantId of [undefined, null, '', '   ', 'ATTACKER_MERCHANT']) {
    const mockBody = {
      orderId: 'ORD-M432-MOCK',
      ...(badMerchantId !== undefined ? { merchantId: badMerchantId } : {}),
      amountPaise: 25000,
      status: 'succeeded'
    };
    assert.throws(
      () => mockAdapter.verifyWebhook({ 'x-webhook-secret': 'test-upi-webhook-secret' }, JSON.stringify(mockBody)),
      /merchantId/i,
      `Mock adapter must reject bad merchantId: ${badMerchantId}`
    );
  }

  // 4. Mock adapter rejects if adapter itself has missing configured merchantId
  const unconfiguredMock = new MockUpiAdapter({ merchantId: '' });
  assert.throws(
    () => unconfiguredMock.verifyWebhook(
      { 'x-webhook-secret': 'test-upi-webhook-secret' },
      JSON.stringify({ orderId: 'ORD-M432-MOCK', merchantId: 'PGTESTPAYUAT', amountPaise: 25000 })
    ),
    /merchant ID configuration is missing/i
  );

  // 5. applySuccessfulUpiPayment fail-closed merchant checks
  const { event, tier } = await createPaidEvent({ price: 30000 });

  // 5a. Missing verified merchant ID (null, undefined, empty)
  const it1 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const r1 = await applySuccessfulUpiPayment({ orderId: it1.orderId, verifiedAmountPaise: 30000, currency: 'INR', merchantId: null });
  assert.equal(r1.status, 'disputed');
  assert.equal(r1.disputeReason, 'missing_verified_merchant_id');

  const it1b = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const r1b = await applySuccessfulUpiPayment({ orderId: it1b.orderId, verifiedAmountPaise: 30000, currency: 'INR', merchantId: '   ' });
  assert.equal(r1b.status, 'disputed');
  assert.equal(r1b.disputeReason, 'missing_verified_merchant_id');

  // 5b. Mismatched verified merchant ID
  const it2 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const r2 = await applySuccessfulUpiPayment({ orderId: it2.orderId, verifiedAmountPaise: 30000, currency: 'INR', merchantId: 'WRONG_MERCHANT' });
  assert.equal(r2.status, 'disputed');
  assert.equal(r2.disputeReason, 'merchant_mismatch');

  // 5c. Missing stored merchant ID in database row
  const it3 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  await db.query(`UPDATE payments SET merchant_id = NULL WHERE order_id = $1`, [it3.orderId]);
  const r3 = await applySuccessfulUpiPayment({ orderId: it3.orderId, verifiedAmountPaise: 30000, currency: 'INR', merchantId: 'PGTESTPAYUAT' });
  assert.equal(r3.status, 'disputed');
  assert.equal(r3.disputeReason, 'missing_stored_merchant_id');

  // 6. Currency fail-closed checks
  // 6a. Missing currency (null, empty string, omitted)
  const it4 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const r4 = await applySuccessfulUpiPayment({ orderId: it4.orderId, verifiedAmountPaise: 30000, currency: null, merchantId: 'PGTESTPAYUAT' });
  assert.equal(r4.status, 'disputed');
  assert.equal(r4.disputeReason, 'missing_currency');

  const it4b = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const r4b = await applySuccessfulUpiPayment({ orderId: it4b.orderId, verifiedAmountPaise: 30000, currency: '', merchantId: 'PGTESTPAYUAT' });
  assert.equal(r4b.status, 'disputed');
  assert.equal(r4b.disputeReason, 'missing_currency');

  // 6b. Currency mismatch (USD, EUR)
  const it5 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const r5 = await applySuccessfulUpiPayment({ orderId: it5.orderId, verifiedAmountPaise: 30000, currency: 'EUR', merchantId: 'PGTESTPAYUAT' });
  assert.equal(r5.status, 'disputed');
  assert.equal(r5.disputeReason, 'currency_mismatch');

  // 7. Valid merchant ID and INR confirms successfully
  const it6 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  const r6 = await applySuccessfulUpiPayment({ orderId: it6.orderId, verifiedAmountPaise: 30000, currency: 'INR', merchantId: 'PGTESTPAYUAT' });
  assert.equal(r6.status, 'succeeded');
  assert.ok(r6.bookingId);

  // Verify all disputed intents created zero bookings
  for (const it of [it1, it1b, it2, it3, it4, it4b, it5]) {
    const bkCount = await db.one(
      `SELECT count(*)::int AS n FROM bookings WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)`,
      [it.orderId]
    );
    assert.equal(bkCount.n, 0);
  }
});

test('M4.3.2: Secure manual refund reconciliation authorization, evidence reference and state transitions', async () => {
  const { event, tier } = await createPaidEvent({ price: 22000 });

  // Create active finance admin user
  const financeAdmin = await db.one(
    `INSERT INTO admin_users (telegram_user_id, role, active)
     VALUES (980000777, 'finance', true)
     ON CONFLICT (telegram_user_id) DO UPDATE SET active = true, role = 'finance'
     RETURNING *`
  );

  // 1. Unauthorized finance reconciliation rejected
  const it1 = await createUpiPaymentIntent({ slug: event.slug, user: guest1, ticketTypeId: tier.id });
  await applySuccessfulUpiPayment({ orderId: it1.orderId, verifiedAmountPaise: 22000, currency: 'INR', merchantId: 'PGTESTPAYUAT' });

  // 1a. Unverified actor string
  await assert.rejects(
    () => refundUpiOrder(it1.orderId, {
      actor: 'admin:finance:fake',
      reason: 'Manual refund test without active admin row',
      manualReconciliation: true,
      externalRefundRef: 'BANK-UTR-987654321012',
      evidenceRef: 'FIN-AUDIT-TICKET-101'
    }),
    /unauthorized_finance_role/i
  );

  // 1b. Regular user / guest actor
  await assert.rejects(
    () => refundUpiOrder(it1.orderId, {
      actor: `user:${guest1.userId}`,
      reason: 'Attendee trying to self-reconcile refund',
      manualReconciliation: true,
      externalRefundRef: 'BANK-UTR-987654321012',
      evidenceRef: 'FIN-AUDIT-TICKET-101'
    }),
    /unauthorized_finance_role/i
  );

  // 2. Missing external refund reference rejected
  await assert.rejects(
    () => refundUpiOrder(it1.orderId, {
      actor: `admin:${financeAdmin.id}:finance`,
      reason: 'Customer requested bank reversal',
      manualReconciliation: true,
      externalRefundRef: null,
      evidenceRef: 'FIN-AUDIT-TICKET-101'
    }),
    /invalid_external_refund_ref/i
  );

  // 3. Fabricated / placeholder external refund references rejected
  const placeholders = [
    'MANUAL',
    'MANUAL-BANK-REF-999',
    'manual-ord-12345',
    'DUMMY-REFUND-1',
    'TEST12345',
    'PLACEHOLDER',
    '0000000',
    'XXXXXX',
    '123456',
    'N/A',
    'NONE'
  ];

  for (const ph of placeholders) {
    await assert.rejects(
      () => refundUpiOrder(it1.orderId, {
        actor: `admin:${financeAdmin.id}:finance`,
        reason: 'Customer requested bank reversal',
        manualReconciliation: true,
        externalRefundRef: ph,
        evidenceRef: 'FIN-AUDIT-TICKET-101'
      }),
      /invalid_external_refund_ref/i,
      `Expected placeholder '${ph}' to be rejected`
    );
  }

  // 4. Missing or placeholder evidence reference rejected
  for (const badEvidence of [null, '', '   ', 'none', 'n/a', 'dummy', 'test', 'placeholder']) {
    await assert.rejects(
      () => refundUpiOrder(it1.orderId, {
        actor: `admin:${financeAdmin.id}:finance`,
        reason: 'Customer requested bank reversal',
        manualReconciliation: true,
        externalRefundRef: 'BANK-UTR-987654321012',
        evidenceRef: badEvidence
      }),
      /missing_evidence_ref/i,
      `Expected bad evidence '${badEvidence}' to be rejected`
    );
  }

  // 5. Missing or short documented reconciliation reason rejected
  for (const badReason of [null, '', 'short', 'refund', 'test']) {
    await assert.rejects(
      () => refundUpiOrder(it1.orderId, {
        actor: `admin:${financeAdmin.id}:finance`,
        reason: badReason,
        manualReconciliation: true,
        externalRefundRef: 'BANK-UTR-987654321012',
        evidenceRef: 'FIN-AUDIT-TICKET-101'
      }),
      /missing_reason/i,
      `Expected bad reason '${badReason}' to be rejected`
    );
  }

  // 6. Authorized reconciliation with evidence reference succeeds
  const invite = await db.one(
    `INSERT INTO invite_links (booking_id, user_id, chat_id, link, expires_at)
     VALUES ((SELECT booking_id FROM payments WHERE order_id = $1), $2, -1001111111111, 'https://t.me/+testm432recon', now() + interval '1 day')
     RETURNING *`,
    [it1.orderId, guest1.userId]
  );

  const reconRes = await refundUpiOrder(it1.orderId, {
    actor: `admin:${financeAdmin.id}:finance`,
    reason: 'Confirmed bank transfer reversal via HDFC Corporate UTR 987654321012',
    manualReconciliation: true,
    externalRefundRef: 'BANK-UTR-987654321012',
    evidenceRef: 'FIN-AUDIT-TICKET-88421'
  });

  assert.equal(reconRes.status, 'refunded');
  assert.equal(reconRes.refundId, 'BANK-UTR-987654321012');
  assert.equal(reconRes.manualReconciliation, true);

  // Verify database record
  const pCheck = await db.one(
    `SELECT status, refund_ref, reconciled, reconciled_at, raw_ref FROM payments WHERE order_id = $1`,
    [it1.orderId]
  );
  assert.equal(pCheck.status, 'refunded');
  assert.equal(pCheck.refund_ref, 'BANK-UTR-987654321012');
  assert.equal(pCheck.reconciled, true);
  assert.ok(pCheck.reconciled_at);
  assert.equal(pCheck.raw_ref.reconciliation.externalRefundRef, 'BANK-UTR-987654321012');
  assert.equal(pCheck.raw_ref.reconciliation.evidenceRef, 'FIN-AUDIT-TICKET-88421');

  // Verify immutable audit ledger
  const audits = (await db.query(
    `SELECT from_status, to_status, actor, details FROM payment_audits WHERE order_id = $1 AND to_status = 'refunded'`,
    [it1.orderId]
  )).rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, `admin:${financeAdmin.id}:finance`);
  assert.equal(audits[0].details.reconciliationType, 'manual_finance_reconciliation');
  assert.equal(audits[0].details.externalRefundRef, 'BANK-UTR-987654321012');
  assert.equal(audits[0].details.evidenceRef, 'FIN-AUDIT-TICKET-88421');

  // Verify booking and invite links were revoked
  const bkCheck = await db.one(`SELECT status FROM bookings WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)`, [it1.orderId]);
  assert.equal(bkCheck.status, 'refunded');

  const invCheck = await db.one(`SELECT revoked_at FROM invite_links WHERE id = $1`, [invite.id]);
  assert.ok(invCheck.revoked_at !== null, 'Invite link must be revoked upon confirmed refund');

  // 7. Duplicate reconciliation attempts are strictly idempotent
  const dupeRes = await refundUpiOrder(it1.orderId, {
    actor: `admin:${financeAdmin.id}:finance`,
    reason: 'Duplicate attempt by another operator',
    manualReconciliation: true,
    externalRefundRef: 'BANK-UTR-987654321012',
    evidenceRef: 'FIN-AUDIT-TICKET-88421'
  });
  assert.equal(dupeRes.status, 'refunded');
  assert.equal(dupeRes.duplicate, true);

  // 8. Refund state transitions: provider pending vs completed vs failed
  // 8a. Succeeded and refund_pending can enter refund workflow
  const itPending = await createUpiPaymentIntent({ slug: event.slug, user: guest2, ticketTypeId: tier.id });
  await db.query(`UPDATE payments SET status = 'refund_pending', failure_reason = 'duplicate_booking' WHERE order_id = $1`, [itPending.orderId]);

  // Provider returns pending status
  stubUrl('https://api-preprod.phonepe.com', (url) => {
    if (url.includes('/pg/v1/refund')) {
      return {
        status: 200,
        body: JSON.stringify({ success: true, code: 'PAYMENT_PENDING', data: { transactionId: 'TXN-REF-PENDING' } })
      };
    }
    return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS' }) };
  });

  const pendingRefundRes = await refundUpiOrder(itPending.orderId, { actor: 'admin:finance' });
  assert.equal(pendingRefundRes.status, 'refund_pending');

  const payPendingCheck = await db.one('SELECT status FROM payments WHERE order_id = $1', [itPending.orderId]);
  assert.equal(payPendingCheck.status, 'refund_pending');

  // 8b. Failed provider refund remains recoverable in refund_pending
  stubUrl('https://api-preprod.phonepe.com', (url) => {
    if (url.includes('/pg/v1/refund')) {
      return { status: 503, body: JSON.stringify({ success: false, code: 'SERVICE_UNAVAILABLE', message: 'Gateway down' }) };
    }
    return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS' }) };
  });

  await assert.rejects(
    () => refundUpiOrder(itPending.orderId, { actor: 'admin:finance' }),
    /Payment gateway refund initiation failed/
  );

  const payFailedCheck = await db.one('SELECT status, failure_reason FROM payments WHERE order_id = $1', [itPending.orderId]);
  assert.equal(payFailedCheck.status, 'refund_pending');
  assert.ok(payFailedCheck.failure_reason.includes('refund_failed'));

  // 8c. Recoverable via authorized manual finance reconciliation
  const recoverRes = await refundUpiOrder(itPending.orderId, {
    actor: `admin:${financeAdmin.id}:finance`,
    reason: 'Manual bank reversal following gateway 503 downtime',
    manualReconciliation: true,
    externalRefundRef: 'BANK-RECOV-20261104-555',
    evidenceRef: 'INCIDENT-GATEWAY-DOWN-991'
  });
  assert.equal(recoverRes.status, 'refunded');
  assert.equal(recoverRes.refundId, 'BANK-RECOV-20261104-555');

  // Restore refund stub
  stubUrl('https://api-preprod.phonepe.com', (url) => {
    if (url.includes('/pg/v1/refund')) {
      return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS', data: { transactionId: 'TXN-REF-RESTORED' } }) };
    }
    return { status: 200, body: JSON.stringify({ success: true, code: 'PAYMENT_SUCCESS' }) };
  });

  // 9. Admin HTTP endpoint POST /api/admin/payments/:id/refund enforcement
  const itHttp = await createUpiPaymentIntent({ slug: event.slug, user: guest3, ticketTypeId: tier.id });
  await applySuccessfulUpiPayment({ orderId: itHttp.orderId, verifiedAmountPaise: 22000, currency: 'INR', merchantId: 'PGTESTPAYUAT' });
  const httpPay = await db.one('SELECT id FROM payments WHERE order_id = $1', [itHttp.orderId]);

  // Signed out gets 401
  const anon = new Client();
  assert.equal((await anon.post(`/api/admin/payments/${httpPay.id}/refund`, {})).status, 401);

  // Regular user gets 403
  assert.equal((await guest1.post(`/api/admin/payments/${httpPay.id}/refund`, {})).status, 403);

  // Admin without finance role gets 403
  const managerUser = await signedInClient({ tgId: 980000888 });
  await admin.post('/api/admin/admins', { telegram_user_id: managerUser.tgId, role: 'event_manager' });
  assert.equal((await managerUser.post(`/api/admin/payments/${httpPay.id}/refund`, {})).status, 403);

  // Finance client via HTTP
  const financeClient = await signedInClient({ tgId: financeAdmin.telegram_user_id });

  // Placeholder reference returns 400
  const phRes = await financeClient.post(`/api/admin/payments/${httpPay.id}/refund`, {
    manualReconciliation: true,
    externalRefundRef: 'MANUAL',
    evidenceRef: 'TICKET-1',
    reason: 'Testing placeholder rejection via API'
  });
  assert.equal(phRes.status, 400);

  // Valid manual reconciliation via HTTP returns 200
  const okRes = await financeClient.post(`/api/admin/payments/${httpPay.id}/refund`, {
    manualReconciliation: true,
    externalRefundRef: 'BANK-API-UTR-20261104',
    evidenceRef: 'FIN-TICKET-API-2026',
    reason: 'Confirmed bank refund processed via finance portal'
  });
  assert.equal(okRes.status, 200);

  const finalHttpPay = await db.one('SELECT status, refund_ref FROM payments WHERE id = $1', [httpPay.id]);
  assert.equal(finalHttpPay.status, 'refunded');
  assert.equal(finalHttpPay.refund_ref, 'BANK-API-UTR-20261104');
});
