// test/automated-checkout-e2e.test.js - Rebuilt Paid Ticket Checkout: Automated Provider Verification & WhatsApp Confirmation
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, resetDb } from './helpers.js';
import {
  createDraft,
  saveDraft,
  publishDraft
} from '../lib/services/organiser.js';
import { toPublicEvent } from '../lib/services/events.js';
import {
  createUpiPaymentIntent,
  processUpiWebhook,
  getUpiPaymentStatus,
  activePaymentHolds
} from '../lib/services/upi-payments.js';
import { getBookingTickets } from '../lib/services/tickets.js';
import { getWhatsAppProvider } from '../lib/services/whatsapp-provider.js';
import { deliverDue } from '../lib/services/notifications.js';

test.beforeEach(async () => {
  await resetDb();
  process.env.UPI_CHECKOUT_ENABLED = 'true';
  process.env.ALLOW_PREVIEW_PAID_CHECKOUT = 'true';
  process.env.FORCE_PHONEPE = 'true';
  process.env.PHONEPE_MERCHANT_ID = 'PGTESTPAYUAT';
  process.env.PHONEPE_SALT_KEY = '099eb0cd-0252-4e2a-8aca-eb3c6bd470f1';
  process.env.PHONEPE_SALT_INDEX = '1';
  getWhatsAppProvider().clearSentMessages();
});

test.afterEach(() => {
  process.env.UPI_CHECKOUT_ENABLED = 'false';
  delete process.env.ALLOW_PREVIEW_PAID_CHECKOUT;
  delete process.env.FORCE_PHONEPE;
  getWhatsAppProvider().clearSentMessages();
});

async function createHost(alias = 'host_checkout') {
  return (await db.query(
    `INSERT INTO users (telegram_user_id, alias, organiser_enabled, age_confirmed_21)
     VALUES ($1, $2, true, true) RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias]
  )).rows[0];
}

async function createAttendee(alias = 'guest_buyer') {
  const digits = Math.floor(100000000 + Math.random() * 900000000);
  return (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, phone)
     VALUES ($1, $2, true, $3) RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias, `+919${digits}`]
  )).rows[0];
}

test('Paid ticket creation publishes with checkout_mode = "upi_direct" eliminating draft pending badge', async () => {
  const host = await createHost('host_live_checkout');

  const draft = await createDraft(host, 'nightlife');
  const updatedData = {
    ...draft.data,
    title: 'Neon Nights Party',
    category: 'nightlife',
    startLocal: '2026-12-31T21:00',
    endLocal: '2027-01-01T04:00',
    city: 'Bengaluru',
    venue: 'Koramangala Social',
    description: 'Premier underground nightlife celebration with automated paid entry and ticket passes.',
    tickets: [
      { id: 't1', name: 'General Entry', category: 'general', kind: 'paid', pricePaise: 79900, quantity: 50, maxPerBooking: 4 }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });

  // 1. Database check: checkout_mode is upi_direct
  const evRow = (await db.query(`SELECT * FROM events WHERE id = $1`, [published.eventId])).rows[0];
  assert.equal(evRow.checkout_mode, 'upi_direct', 'Must be upi_direct, never none');

  // 2. Public view check: toPublicEvent produces open bookable status with upi_direct checkout
  const tiers = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [published.eventId])).rows;
  const publicEv = toPublicEvent({ ...evRow, tiers });
  assert.equal(publicEv.bookable, true);
  assert.equal(publicEv.checkoutAvailable, true);
  assert.equal(publicEv.checkoutMode, 'upi_direct');
  assert.equal(publicEv.checkoutPath, `/checkout/${evRow.slug}`);
  assert.equal(publicEv.tiers[0].available, true);
  assert.equal(publicEv.tiers[0].unavailable, null, 'Must NOT show "Paid ticket — external checkout not configured"');
});

test('End-to-end automated checkout: Intent -> Webhook -> Pass issuance -> WhatsApp confirmation', async () => {
  const host = await createHost('host_e2e_flow');
  const attendee = await createAttendee('buyer_e2e');

  const draft = await createDraft(host, 'nightlife');
  const updatedData = {
    ...draft.data,
    title: 'Saturday Warehouse Rave',
    category: 'nightlife',
    startLocal: '2026-12-20T22:00',
    endLocal: '2026-12-21T04:00',
    city: 'Bengaluru',
    venue: 'Indiranagar Warehouse 7',
    description: 'Curated underground rave. Tickets verified automatically by banking network.',
    tickets: [
      { id: 't_couple', name: 'Couple Pass', category: 'couple', kind: 'paid', pricePaise: 129900, quantity: 30, admitCount: 2, maxPerBooking: 1 }
    ]
  };

  const saved = await saveDraft(host.id, draft.id, { version: draft.version, step: 'tickets', data: updatedData });
  const published = await publishDraft(host, draft.id, { version: saved.version, confirm: true });
  const ev = (await db.query(`SELECT * FROM events WHERE id = $1`, [published.eventId])).rows[0];
  const tier = (await db.query(`SELECT * FROM ticket_types WHERE event_id = $1`, [published.eventId])).rows[0];

  // 1. Attendee initiates paid ticket checkout
  const intent = await createUpiPaymentIntent({
    slug: ev.slug,
    user: attendee,
    ticketTypeId: tier.id,
    quantity: 1,
    deviceType: 'mobile'
  });

  assert.ok(intent.orderId);
  assert.equal(intent.amountPaise, 129900);
  assert.ok(intent.upiIntentUrl);

  // Seat hold is active
  assert.equal(await activePaymentHolds(db, ev.id), 2, '2 seats held for couple pass');

  // 2. Simulated payment webhook confirmation from provider (PhonePe PG mode)
  const responseObj = {
    success: true,
    code: 'PAYMENT_SUCCESS',
    message: 'Payment completed successfully',
    data: {
      merchantId: 'PGTESTPAYUAT',
      merchantTransactionId: intent.orderId,
      transactionId: `TXN_${crypto.randomBytes(6).toString('hex')}`,
      amount: 129900,
      currency: 'INR',
      state: 'COMPLETED',
      responseCode: 'SUCCESS',
      paymentInstrument: { type: 'UPI', utr: 'UTR9988776655' }
    }
  };
  const base64Response = Buffer.from(JSON.stringify(responseObj)).toString('base64');
  const rawBody = JSON.stringify({ response: base64Response });
  const validHash = crypto.createHash('sha256').update(`${base64Response}099eb0cd-0252-4e2a-8aca-eb3c6bd470f1`).digest('hex');

  const webhookResult = await processUpiWebhook({
    headers: {
      'x-verify': `${validHash}###1`
    },
    rawBody,
    clientIp: '127.0.0.1'
  });

  assert.equal(webhookResult.ok, true);
  assert.equal(webhookResult.result, 'confirmed');

  // 3. Payment status is now succeeded
  const statusRes = await getUpiPaymentStatus(intent.orderId, { user: attendee });
  assert.equal(statusRes.status, 'succeeded');
  assert.ok(statusRes.bookingId);

  // 4. Booking and tickets issued
  const bRow = (await db.query(`SELECT * FROM bookings WHERE id = $1`, [statusRes.bookingId])).rows[0];
  assert.equal(bRow.status, 'confirmed');
  assert.equal(bRow.admit_count, 2);

  const tickets = await getBookingTickets(statusRes.bookingId, attendee);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, 'valid');
  assert.equal(tickets[0].admitCount, 2);

  // 5. Notification processing: WhatsApp confirmation dispatched
  await deliverDue();

  const sentWa = getWhatsAppProvider().getSentMessages();
  assert.ok(sentWa.length > 0, 'WhatsApp confirmation message must be sent');
  const confirmMsg = sentWa.find((m) => m.templateName === 'nightlifez_booking_confirmation');
  assert.ok(confirmMsg, 'Must use nightlifez_booking_confirmation template');
  assert.equal(confirmMsg.to, attendee.phone);

  // 6. Idempotency test: duplicate webhook for same order does NOT create duplicate booking or re-issue tickets
  const dupResult = await processUpiWebhook({
    headers: { 'x-verify': `${validHash}###1` },
    rawBody,
    clientIp: '127.0.0.1'
  });
  assert.equal(dupResult.ok, true);
  assert.equal(dupResult.result, 'duplicate');

  const allBookings = (await db.query(`SELECT count(*)::int AS n FROM bookings WHERE payment_id = (SELECT id FROM payments WHERE order_id = $1)`, [intent.orderId])).rows[0].n;
  assert.equal(allBookings, 1, 'Idempotency must prevent duplicate bookings');
});
