// test/payment-security-guardrails.test.js - Payment State Machine, Sandbox Separation, Webhook Security & Hold Releases
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, resetDb } from './helpers.js';
import {
  createUpiPaymentIntent,
  processUpiWebhook,
  getUpiPaymentStatus,
  activePaymentHolds,
  activeTierPaymentHolds
} from '../lib/services/upi-payments.js';
import { checkoutForEvent, ticketCheckoutStatus, isLiveGatewayConfigured } from '../lib/payments/availability.js';
import { seatsTaken } from '../lib/services/bookings.js';

test.beforeEach(async () => {
  await resetDb();
  process.env.UPI_CHECKOUT_ENABLED = 'true';
  process.env.ALLOW_PREVIEW_PAID_CHECKOUT = 'true';
  process.env.FORCE_PHONEPE = 'true';
  process.env.PHONEPE_MERCHANT_ID = 'PGTESTPAYUAT';
  process.env.PHONEPE_SALT_KEY = '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';
  process.env.PHONEPE_SALT_INDEX = '1';
});

test.afterEach(() => {
  delete process.env.UPI_CHECKOUT_ENABLED;
  delete process.env.ALLOW_PREVIEW_PAID_CHECKOUT;
  delete process.env.FORCE_PHONEPE;
  delete process.env.VERCEL_ENV;
});

async function createPaidEventWithTier({ capacity = 10, tierQty = 10, pricePaise = 99900, category = 'general', admitCount = 1 } = {}) {
  const ev = (await db.query(
    `INSERT INTO events (slug, title, category, city, start_at, status, capacity, checkout_mode)
     VALUES ($1, 'Security Showcase Night', 'nightlife', 'Bengaluru', now() + interval '5 days', 'published', $2, 'upi_direct')
     RETURNING *`,
    [`security-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, capacity]
  )).rows[0];

  const tier = (await db.query(
    `INSERT INTO ticket_types (event_id, name, kind, category, price_paise, quantity, admit_count, max_per_booking, active)
     VALUES ($1, 'Pass Tier', 'paid', $2, $3, $4, $5, 4, true)
     RETURNING *`,
    [ev.id, category, pricePaise, tierQty, admitCount]
  )).rows[0];

  return { ev, tier };
}

async function createBuyer(alias = 'buyer_sec') {
  return (await db.query(
    `INSERT INTO users (telegram_user_id, alias, phone, age_confirmed_21)
     VALUES ($1, $2, $3, true) RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias, `+919${crypto.randomBytes(4).toString('hex').slice(0, 9)}`]
  )).rows[0];
}

test('Production Gateway Guard: Sandbox testing is strictly blocked in Production runtime without live credentials', async () => {
  // Simulate Production runtime (VERCEL_ENV=production) with default sandbox merchant ID
  process.env.VERCEL_ENV = 'production';

  // 1. isLiveGatewayConfigured must return false for PGTESTPAYUAT sandbox
  assert.equal(isLiveGatewayConfigured(), false, 'Sandbox credentials must NOT be classified as live gateway');

  // 2. ticketCheckoutStatus returns available: false in production
  const status = ticketCheckoutStatus();
  assert.equal(status.available, false);
  assert.equal(status.reason, 'gateway_pending_configuration');

  // 3. checkoutForEvent returns available: false
  const eventStatus = checkoutForEvent({ checkout_mode: 'upi_direct' });
  assert.equal(eventStatus.available, false);
  assert.equal(eventStatus.reason, 'gateway_pending_configuration');

  // 4. createUpiPaymentIntent strictly rejects creation with 403 in production
  const { ev, tier } = await createPaidEventWithTier();
  const buyer = await createBuyer();

  await assert.rejects(
    async () => {
      await createUpiPaymentIntent({
        slug: ev.slug,
        user: buyer,
        ticketTypeId: tier.id,
        quantity: 1
      });
    },
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'gateway_pending_configuration');
      return true;
    }
  );
});

test('Webhook Security & Zero-Trust Verification: Mismatched merchant or missing currency fails closed to disputed', async () => {
  const { ev, tier } = await createPaidEventWithTier({ pricePaise: 129900 });
  const buyer = await createBuyer('buyer_tamper');

  const intent = await createUpiPaymentIntent({
    slug: ev.slug,
    user: buyer,
    ticketTypeId: tier.id,
    quantity: 1
  });

  // 1. Tampered signature is rejected with 401
  const badBody = JSON.stringify({ response: 'eyJsZWFraW5nIjoidHJ1ZSJ9' });
  await assert.rejects(
    async () => {
      await processUpiWebhook({
        headers: { 'x-verify': 'bad_tampered_hash###1' },
        rawBody: badBody,
        clientIp: '127.0.0.1'
      });
    },
    (err) => {
      assert.equal(err.status, 401);
      return true;
    }
  );

  // 2. Webhook payload with missing currency fails closed to disputed (0 bookings confirmed)
  const noCurrencyResponse = {
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: intent.orderId,
      transactionId: `TXN-${intent.orderId}`,
      amount: 129900,
      currency: null, // missing currency
      state: 'COMPLETED',
      paymentInstrument: { type: 'UPI' }
    }
  };
  const base64NoCurr = Buffer.from(JSON.stringify(noCurrencyResponse)).toString('base64');
  const rawNoCurr = JSON.stringify({ response: base64NoCurr });
  const hashNoCurr = crypto.createHash('sha256').update(`${base64NoCurr}099eb0cd-0252-4e2a-8aca-eb3c6bd470f1`).digest('hex');

  const hookResult = await processUpiWebhook({
    headers: { 'x-verify': `${hashNoCurr}###1` },
    rawBody: rawNoCurr,
    clientIp: '127.0.0.1'
  });

  assert.equal(hookResult.ok, false);
  assert.equal(hookResult.error, 'missing_currency');

  // Verify payment status is disputed and NO booking was confirmed
  const pRow = (await db.query(`SELECT * FROM payments WHERE order_id = $1`, [intent.orderId])).rows[0];
  assert.equal(pRow.status, 'disputed');
  assert.equal(pRow.booking_id, null);

  const bookingsCount = (await db.query(`SELECT count(*)::int AS n FROM bookings WHERE event_id = $1`, [ev.id])).rows[0].n;
  assert.equal(bookingsCount, 0, 'No booking confirmed for disputed payment');
});

test('Hold Release & Capacity Integrity: Expired holds release inventory immediately', async () => {
  const { ev, tier } = await createPaidEventWithTier({ capacity: 4, tierQty: 4 });
  const buyer = await createBuyer('buyer_hold');

  const intent = await createUpiPaymentIntent({
    slug: ev.slug,
    user: buyer,
    ticketTypeId: tier.id,
    quantity: 2
  });

  // Hold is active initially
  assert.equal(await activePaymentHolds(db, ev.id), 2);
  assert.equal(await activeTierPaymentHolds(db, tier.id), 2);

  // Simulate payment expiry by setting expires_at to the past
  await db.query(`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [intent.orderId]);

  // Hold is automatically released
  assert.equal(await activePaymentHolds(db, ev.id), 0, 'Expired hold must not hold event capacity');
  assert.equal(await activeTierPaymentHolds(db, tier.id), 0, 'Expired hold must not hold tier capacity');
});

test('Multi-Attendee Admission Accounting: Couple and Group passes hold and consume exact headcount', async () => {
  // Event with total venue capacity 5
  const { ev, tier: coupleTier } = await createPaidEventWithTier({ capacity: 5, tierQty: 3, category: 'couple', admitCount: 2 });
  const buyer1 = await createBuyer('buyer_couple');

  // Booking 2 couple passes (2 passes × 2 admits = 4 seats needed)
  const intent = await createUpiPaymentIntent({
    slug: ev.slug,
    user: buyer1,
    ticketTypeId: coupleTier.id,
    quantity: 2
  });

  // 4 seats held for 2 couple passes
  assert.equal(await activePaymentHolds(db, ev.id), 4, '4 seats held for 2 couple passes');

  // Trying to buy another couple pass (needs 2 more seats, total 6 > capacity 5) is rejected as sold out
  const buyer2 = await createBuyer('buyer_couple2');
  await assert.rejects(
    async () => {
      await createUpiPaymentIntent({
        slug: ev.slug,
        user: buyer2,
        ticketTypeId: coupleTier.id,
        quantity: 1
      });
    },
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'sold_out');
      return true;
    }
  );
});
