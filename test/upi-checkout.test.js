// test/upi-checkout.test.js - Milestone M4.1: UPI-First Checkout, Dynamic QR & Verified Payment Integration.
// Tests mobile UPI intent, app-specific links, desktop dynamic QR, PhonePe PG adapter, webhook signatures,
// idempotency, state machine transitions, refunds, and access isolation.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  resetDb, startServer, stopServer, Client, db, callsTo, clearCalls, createEvent, signedInClient, stubUrl
} from './helpers.js';
import {
  encodeQrMatrix,
  generateQrSvg,
  buildUpiUri
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
  processUpiWebhook,
  refundUpiOrder,
  isLegalTransition
} from '../lib/services/upi-payments.js';

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

  // Pending status
  const resPending = await c.get(`/api/checkout/upi/status/${intent.orderId}`);
  assert.equal(resPending.status, 200);
  assert.equal(resPending.json.status, 'pending');
  assert.equal(resPending.json.amountPaise, 30000);

  // Manually expire payment in DB
  await db.query(`UPDATE payments SET expires_at = now() - interval '1 second' WHERE order_id = $1`, [intent.orderId]);

  // Polling after expiry returns expired
  const resExpired = await c.get(`/api/checkout/upi/status/${intent.orderId}`);
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
  await applySuccessfulUpiPayment({ orderId: intent1.orderId, actor: 'test' });

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
