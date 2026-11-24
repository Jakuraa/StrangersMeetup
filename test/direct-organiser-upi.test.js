// test/direct-organiser-upi.test.js
// Automated test suite for Direct Organiser UPI Payment Integration.
// Covers all 15 required test scenarios:
// 1. Organiser configures UPI during event creation
// 2. UPI details persist after refresh
// 3. Event-specific UPI details do not leak between organisers
// 4. Paid event publishes successfully with valid direct UPI details
// 5. Paid event cannot publish without valid UPI details
// 6. Attendee receives the correct UPI payment intent and QR amount
// 7. Attendee cannot tamper with the UPI recipient or amount
// 8. UPI app redirect does not confirm payment
// 9. UTR submission does not automatically confirm payment
// 10. Organiser confirmation issues tickets exactly once
// 11. Unauthorised users cannot confirm payments
// 12. Rejected and expired payments restore inventory
// 13. Concurrent bookings cannot overbook inventory
// 14. Free event bookings remain unaffected
// 15. Existing paid drafts are preserved

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDb, startServer, stopServer, Client, db, signedInClient, clearCalls
} from './helpers.js';

let org1;
let org2;
let attendee1;
let attendee2;
let stranger;

/** IST wall-clock 'YYYY-MM-DDTHH:mm', `days` from now at 19:00. */
function istLocal(days, hh = '19:00') {
  const d = new Date(Date.now() + days * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  return `${d}T${hh}`;
}

async function createOrganiser() {
  const c = await signedInClient();
  await db.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [c.userId]);
  return c;
}

before(async () => {
  // Direct UPI must function with zero live gateway flags
  process.env.ENABLE_LIVE_PAYMENTS = 'false';
  process.env.UPI_CHECKOUT_ENABLED = 'false';

  await resetDb();
  await startServer();

  org1 = await createOrganiser();
  org2 = await createOrganiser();
  attendee1 = await signedInClient();
  attendee2 = await signedInClient();
  stranger = await signedInClient();
});

after(async () => {
  await stopServer();
});

beforeEach(clearCalls);

function validDirectUpiDraftData(overrides = {}) {
  return {
    template: 'social',
    category: 'nightlife',
    title: 'Neon Underground Techno Night',
    timezone: 'Asia/Kolkata',
    startLocal: istLocal(5, '21:00'),
    endLocal: istLocal(6, '03:00'),
    multiDay: false,
    venue: 'Warehouse 9, Indiranagar',
    city: 'Bengaluru',
    area: 'Indiranagar',
    privateVenue: false,
    description: 'Underground electronic music night. 21+ only, government photo ID mandatory.',
    paymentMethod: 'direct_upi',
    organiserUpiId: 'technohost@okhdfcbank',
    organiserPayeeName: 'Techno Host Events',
    paymentInstructions: 'Transfer via GooglePay/PhonePe to technohost@okhdfcbank and submit your 12-digit UTR.',
    refundPolicy: 'Full refund if cancelled 48h before event.',
    cancellationPolicy: {
      template: 'standard',
      primaryDeadlineHours: 48,
      primaryRefundPercent: 100,
      secondaryDeadlineHours: 24,
      secondaryRefundPercent: 50,
      noRefundHours: 24,
      allowTransfers: false
    },
    tickets: [
      {
        id: 'vip_tier',
        name: 'VIP Entry',
        kind: 'paid',
        pricePaise: 49900,
        quantity: 10,
        maxPerBooking: 4,
        validOn: 'all'
      }
    ],
    features: {},
    ...overrides
  };
}

// -----------------------------------------------------------------------------
// Scenario 1: Organiser configures UPI during event creation
// -----------------------------------------------------------------------------
test('1. Organiser configures UPI during event creation', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  assert.equal(r.status, 201);
  const draftId = r.json.draft.id;
  const version = r.json.draft.version;

  const data = validDirectUpiDraftData();
  const putRes = await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data,
    step: 'preview',
    version
  });

  assert.equal(putRes.status, 200, putRes.text);
  const savedDraft = putRes.json.draft;
  assert.equal(savedDraft.data.paymentMethod, 'direct_upi');
  assert.equal(savedDraft.data.organiserUpiId, 'technohost@okhdfcbank');
  assert.equal(savedDraft.data.organiserPayeeName, 'Techno Host Events');
  assert.equal(savedDraft.data.paymentInstructions, 'Transfer via GooglePay/PhonePe to technohost@okhdfcbank and submit your 12-digit UTR.');
  assert.equal(savedDraft.data.tickets[0].kind, 'paid');
  assert.equal(savedDraft.data.tickets[0].pricePaise, 49900);
});

// -----------------------------------------------------------------------------
// Scenario 2: UPI details persist after refresh
// -----------------------------------------------------------------------------
test('2. UPI details persist after refresh', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'social' });
  const draftId = r.json.draft.id;
  const data = validDirectUpiDraftData({
    organiserUpiId: 'rooftop.music@icici',
    organiserPayeeName: 'Rooftop Sessions'
  });

  await org1.req('PUT', `/api/organiser/drafts/${draftId}`, {
    data,
    step: 'preview',
    version: r.json.draft.version
  });

  // Fetch draft again as if page reloaded
  const fetchRes = await org1.get(`/api/organiser/drafts/${draftId}`);
  assert.equal(fetchRes.status, 200);
  const reloaded = fetchRes.json.draft;

  assert.equal(reloaded.data.paymentMethod, 'direct_upi');
  assert.equal(reloaded.data.organiserUpiId, 'rooftop.music@icici');
  assert.equal(reloaded.data.organiserPayeeName, 'Rooftop Sessions');
  assert.equal(reloaded.data.tickets[0].pricePaise, 49900);
});

// -----------------------------------------------------------------------------
// Scenario 3: Event-specific UPI details do not leak between organisers
// -----------------------------------------------------------------------------
test('3. Event-specific UPI details do not leak between organisers', async () => {
  // org1 created a draft with rooftop.music@icici
  const r1 = await org1.post('/api/organiser/drafts', { template: 'social' });
  await org1.req('PUT', `/api/organiser/drafts/${r1.json.draft.id}`, {
    data: validDirectUpiDraftData({ organiserUpiId: 'secret1@okhdfcbank' }),
    step: 'preview',
    version: r1.json.draft.version
  });

  // org2 creates their own draft; defaults must be free and empty
  const r2 = await org2.post('/api/organiser/drafts', { template: 'social' });
  assert.equal(r2.status, 201);
  const org2Draft = r2.json.draft;
  assert.ok(!org2Draft.data.paymentMethod || org2Draft.data.paymentMethod === 'free');
  assert.ok(!org2Draft.data.organiserUpiId, 'Must not have org1 UPI ID');

  // org2 attempts to fetch org1's draft -> 404/403
  const leakAttempt = await org2.get(`/api/organiser/drafts/${r1.json.draft.id}`);
  assert.ok(leakAttempt.status === 403 || leakAttempt.status === 404, 'Must not access other organiser draft');
});

// -----------------------------------------------------------------------------
// Scenario 4: Paid event publishes successfully with valid direct UPI details
// -----------------------------------------------------------------------------
test('4. Paid event publishes successfully with valid direct UPI details without gateway', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const dId = r.json.draft.id;
  const data = validDirectUpiDraftData({
    organiserUpiId: 'directfest@okaxis',
    organiserPayeeName: 'Direct Fest Team'
  });

  const saveRes = await org1.req('PUT', `/api/organiser/drafts/${dId}`, {
    data,
    step: 'preview',
    version: r.json.draft.version
  });
  assert.equal(saveRes.status, 200);

  // Publish draft
  const pubRes = await org1.post(`/api/organiser/drafts/${dId}/publish`, {
    version: saveRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);
  assert.ok(pubRes.json.eventId);

  const eventRow = await db.one('SELECT * FROM events WHERE id = $1', [pubRes.json.eventId]);
  assert.equal(eventRow.payment_method, 'direct_upi');
  assert.equal(eventRow.organiser_upi_id, 'directfest@okaxis');
  assert.equal(eventRow.organiser_payee_name, 'Direct Fest Team');
  assert.equal(eventRow.checkout_mode, 'upi_direct');

  // Verify public view
  const publicRes = await org1.get(pubRes.json.path);
  assert.equal(publicRes.status, 200);
});

// -----------------------------------------------------------------------------
// Scenario 5: Paid event cannot publish without valid UPI details
// -----------------------------------------------------------------------------
test('5. Paid event cannot publish without valid UPI details', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const dId = r.json.draft.id;

  // Invalid: paymentMethod is direct_upi but organiserUpiId is invalid
  const invalidData = validDirectUpiDraftData({
    organiserUpiId: 'invalid-upi-no-vpa',
    organiserPayeeName: ''
  });

  const saveRes = await org1.req('PUT', `/api/organiser/drafts/${dId}`, {
    data: invalidData,
    step: 'preview',
    version: r.json.draft.version
  });
  assert.equal(saveRes.status, 200);

  // Issues should report the problems
  const issues = saveRes.json.draft.issues;
  assert.ok(issues.some(i => i.field === 'organiserUpiId'));
  assert.ok(issues.some(i => i.field === 'organiserPayeeName'));

  // Publish must fail with 422
  const pubRes = await org1.post(`/api/organiser/drafts/${dId}/publish`, {
    version: saveRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 422);
  assert.match(pubRes.text, /valid UPI ID|organiser payee name/i);
});

// -----------------------------------------------------------------------------
// Helper to publish a direct UPI event for checkout testing
// -----------------------------------------------------------------------------
let directUpiEvent;
let directUpiTier;

async function setupDirectUpiEvent() {
  const r = await org1.post('/api/organiser/drafts', { template: 'social' });
  const dId = r.json.draft.id;
  const data = validDirectUpiDraftData({
    title: 'Soundwave Festival 2026',
    organiserUpiId: 'soundwave@hdfcbank',
    organiserPayeeName: 'Soundwave Live',
    tickets: [
      {
        id: 'tier1',
        name: 'Pass',
        kind: 'paid',
        pricePaise: 25000, // ₹250.00
        quantity: 5,
        maxPerBooking: 3,
        validOn: 'all'
      }
    ]
  });

  const saveRes = await org1.req('PUT', `/api/organiser/drafts/${dId}`, {
    data,
    step: 'preview',
    version: r.json.draft.version
  });
  const pubRes = await org1.post(`/api/organiser/drafts/${dId}/publish`, {
    version: saveRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200, pubRes.text);

  const event = await db.one('SELECT * FROM events WHERE id = $1', [pubRes.json.eventId]);
  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.id]);
  return { event, tier };
}

// -----------------------------------------------------------------------------
// Scenario 6: Attendee receives correct UPI payment intent and QR amount
// -----------------------------------------------------------------------------
test('6. Attendee receives correct UPI payment intent and QR amount', async () => {
  const { event, tier } = await setupDirectUpiEvent();
  directUpiEvent = event;
  directUpiTier = tier;

  // Attendee initiates checkout for 2 tickets: 2 × 25000 = 50000 paise (₹500.00)
  const checkoutRes = await attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2`);
  assert.equal(checkoutRes.status, 200);

  // Verify response contains payee name, UPI ID, and calculated amount
  assert.match(checkoutRes.text, /Soundwave Live/);
  assert.match(checkoutRes.text, /soundwave@hdfcbank/);
  assert.match(checkoutRes.text, /₹500\.00/);

  // Verify payment intent deep link
  assert.match(checkoutRes.text, /pa=soundwave%40hdfcbank/);
  assert.match(checkoutRes.text, /pn=Soundwave(?:\+|%20)Live/);
  assert.match(checkoutRes.text, /am=500\.00/);
  assert.match(checkoutRes.text, /cu=INR/);

  // Check booking created in DB
  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 AND ticket_type_id = $3 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee1.userId, tier.id]
  );
  assert.ok(booking);
  assert.equal(booking.status, 'pending_payment');
  assert.equal(booking.direct_upi_status, 'awaiting_payment');
  assert.equal(booking.amount_paise, 50000);
  assert.equal(booking.quantity, 2);
  assert.ok(booking.booking_ref.startsWith('NLZ-'));
});

// -----------------------------------------------------------------------------
// Scenario 7: Attendee cannot tamper with UPI recipient or amount
// -----------------------------------------------------------------------------
test('7. Attendee cannot tamper with UPI recipient or amount', async () => {
  const { event, tier } = await setupDirectUpiEvent();

  // Try to tamper with amount or custom query params
  const checkoutRes = await attendee2.get(
    `/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1&amount=1.00&pa=hacker@upi`
  );
  assert.equal(checkoutRes.status, 200);

  // Server must strictly enforce the real tier price and organiser UPI
  assert.match(checkoutRes.text, /am=250\.00/);
  assert.doesNotMatch(checkoutRes.text, /am=1\.00/);
  assert.match(checkoutRes.text, /pa=soundwave%40hdfcbank/);
  assert.doesNotMatch(checkoutRes.text, /hacker@upi/);

  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee2.userId]
  );
  assert.equal(booking.amount_paise, 25000, 'Calculated server-side from tier pricePaise');
});

// -----------------------------------------------------------------------------
// Scenario 8: UPI app redirect does not confirm payment
// -----------------------------------------------------------------------------
test('8. UPI app redirect does not confirm payment', async () => {
  const { event, tier } = await setupDirectUpiEvent();

  const checkoutRes = await attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1`);
  assert.equal(checkoutRes.status, 200);

  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee1.userId]
  );

  // Status check API
  const statusRes = await attendee1.get(`/api/checkout/upi/booking-status/${booking.id}`);
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json.bookingStatus, 'pending_payment');
  assert.equal(statusRes.json.status, 'awaiting_payment');
  assert.equal(statusRes.json.isConfirmed, false);

  // Tickets must not exist
  const tickets = (await db.query(`SELECT * FROM tickets WHERE booking_id = $1`, [booking.id])).rows;
  assert.equal(tickets.length, 0);
});

// -----------------------------------------------------------------------------
// Scenario 9: UTR submission does not automatically confirm payment
// -----------------------------------------------------------------------------
test('9. UTR submission does not automatically confirm payment', async () => {
  const { event, tier } = await setupDirectUpiEvent();

  await attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1`);
  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee1.userId]
  );

  // Attendee submits UTR reference
  const reportRes = await attendee1.post('/api/checkout/upi/report-payment', {
    bookingId: booking.id,
    utr: '987654321098'
  });
  assert.equal(reportRes.status, 200);
  assert.equal(reportRes.json.ok, true);
  assert.equal(reportRes.json.status, 'payment_reported');

  // Verify in DB: booking is still pending_payment, not confirmed!
  const updatedBooking = await db.one(`SELECT * FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(updatedBooking.status, 'pending_payment');
  assert.equal(updatedBooking.direct_upi_status, 'payment_reported');
  assert.equal(updatedBooking.utr_reference, '987654321098');

  // Zero tickets issued
  const tickets = (await db.query(`SELECT * FROM tickets WHERE booking_id = $1`, [booking.id])).rows;
  assert.equal(tickets.length, 0);
});

// -----------------------------------------------------------------------------
// Scenario 10: Organiser confirmation issues tickets exactly once
// -----------------------------------------------------------------------------
test('10. Organiser confirmation issues tickets exactly once', async () => {
  const { event, tier } = await setupDirectUpiEvent();

  await attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2`);
  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee1.userId]
  );
  await attendee1.post('/api/checkout/upi/report-payment', {
    bookingId: booking.id,
    utr: '112233445566'
  });

  // Organiser views payment dashboard
  const listRes = await org1.get(`/api/organiser/events/${event.id}/payments`);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.json.organiserDestination.upiId, 'soundwave@hdfcbank');
  assert.ok(listRes.json.bookings.some(b => b.id === booking.id && b.utrReference === '112233445566'));

  // Organiser confirms with mandatory warning acknowledgment
  const confirmRes = await org1.post(`/api/organiser/events/${event.id}/payments/${booking.id}/confirm`, {
    warningConfirmed: true,
    note: 'Verified in HDFC merchant portal'
  });
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.json.ok, true);
  assert.equal(confirmRes.json.status, 'payment_confirmed');

  // Booking is confirmed
  const confirmedBooking = await db.one(`SELECT * FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(confirmedBooking.status, 'confirmed');
  assert.equal(confirmedBooking.direct_upi_status, 'payment_confirmed');
  assert.equal(confirmedBooking.verified_by_user_id, org1.userId);

  // Tickets issued exactly once for quantity (2)
  const tickets = (await db.query(`SELECT * FROM tickets WHERE booking_id = $1`, [booking.id])).rows;
  assert.equal(tickets.length, 2);

  // Audit entry logged
  const audit = await db.one(
    `SELECT * FROM direct_upi_payment_audits WHERE booking_id = $1 AND to_status = 'payment_confirmed'`,
    [booking.id]
  );
  assert.ok(audit);
  assert.equal(audit.actor_user_id, org1.userId);

  // Repeat confirmation is idempotent and does not create duplicate tickets
  const repeatRes = await org1.post(`/api/organiser/events/${event.id}/payments/${booking.id}/confirm`, {
    warningConfirmed: true
  });
  assert.equal(repeatRes.status, 200);
  const ticketsAfter = (await db.query(`SELECT * FROM tickets WHERE booking_id = $1`, [booking.id])).rows;
  assert.equal(ticketsAfter.length, 2, 'No duplicate tickets issued on repeat confirmation');
});

// -----------------------------------------------------------------------------
// Scenario 11: Unauthorised users cannot confirm payments
// -----------------------------------------------------------------------------
test('11. Unauthorised users cannot confirm payments', async () => {
  const { event, tier } = await setupDirectUpiEvent();

  await attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1`);
  const booking = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee1.userId]
  );

  // 1. Attendee tries to confirm their own booking -> 403
  const selfConfirm = await attendee1.post(`/api/organiser/events/${event.id}/payments/${booking.id}/confirm`, {
    warningConfirmed: true
  });
  assert.equal(selfConfirm.status, 403);

  // 2. Stranger tries to confirm -> 403
  const strangerConfirm = await stranger.post(`/api/organiser/events/${event.id}/payments/${booking.id}/confirm`, {
    warningConfirmed: true
  });
  assert.equal(strangerConfirm.status, 403);

  // 3. Organiser confirms without warningConfirmed -> 400
  const noWarningConfirm = await org1.post(`/api/organiser/events/${event.id}/payments/${booking.id}/confirm`, {
    warningConfirmed: false
  });
  assert.equal(noWarningConfirm.status, 400);
  assert.match(noWarningConfirm.text, /independently verified/i);
});

// -----------------------------------------------------------------------------
// Scenario 12: Rejected and expired payments restore inventory
// -----------------------------------------------------------------------------
test('12. Rejected and expired payments restore inventory', async () => {
  // Create an event with capacity = 2
  const r = await org1.post('/api/organiser/drafts', { template: 'social' });
  const dId = r.json.draft.id;
  const data = validDirectUpiDraftData({
    title: 'Intimate Masterclass',
    organiserUpiId: 'masterclass@icici',
    organiserPayeeName: 'Masterclass Coach',
    tickets: [
      {
        id: 'tier1',
        name: 'Spot',
        kind: 'paid',
        pricePaise: 10000,
        quantity: 2,
        maxPerBooking: 2,
        validOn: 'all'
      }
    ]
  });

  const saveRes = await org1.req('PUT', `/api/organiser/drafts/${dId}`, {
    data,
    step: 'preview',
    version: r.json.draft.version
  });
  const pubRes = await org1.post(`/api/organiser/drafts/${dId}/publish`, {
    version: saveRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200);

  const event = await db.one('SELECT * FROM events WHERE id = $1', [pubRes.json.eventId]);
  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.id]);

  // Attendee 1 reserves 2 spots (fills all inventory)
  const bk1 = await attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2`);
  assert.equal(bk1.status, 200);

  const booking1 = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee1.userId]
  );

  // Attendee 2 tries to book -> inventory full
  const bk2 = await attendee2.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1`);
  assert.equal(bk2.status, 409);

  // Organiser rejects Attendee 1's payment
  const rejectRes = await org1.post(`/api/organiser/events/${event.id}/payments/${booking1.id}/reject`, {
    reason: 'Payment not found in bank statement'
  });
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.json.status, 'payment_rejected');

  const rejectedBooking = await db.one(`SELECT * FROM bookings WHERE id = $1`, [booking1.id]);
  assert.equal(rejectedBooking.status, 'cancelled');
  assert.equal(rejectedBooking.direct_upi_status, 'payment_rejected');

  // Now inventory is restored! Attendee 2 can book
  const bk2Retry = await attendee2.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1`);
  assert.equal(bk2Retry.status, 200);

  // Expired hold test: artificially expire booking 2
  const booking2 = await db.one(
    `SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [event.id, attendee2.userId]
  );
  await db.query(`UPDATE bookings SET hold_expires_at = now() - interval '5 minutes' WHERE id = $1`, [booking2.id]);

  // Attendee 1 can now book 2 tickets again because expired hold released seats
  const bk1Retry = await attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=2`);
  assert.equal(bk1Retry.status, 200);
});

// -----------------------------------------------------------------------------
// Scenario 13: Concurrent bookings cannot overbook inventory
// -----------------------------------------------------------------------------
test('13. Concurrent bookings cannot overbook inventory', async () => {
  // Event with only 1 ticket
  const r = await org1.post('/api/organiser/drafts', { template: 'social' });
  const dId = r.json.draft.id;
  const data = validDirectUpiDraftData({
    title: 'One-on-One VIP Mentorship',
    organiserUpiId: 'mentor@upi',
    organiserPayeeName: 'Solo Mentor',
    tickets: [
      {
        id: 'tier1',
        name: 'Seat',
        kind: 'paid',
        pricePaise: 50000,
        quantity: 1,
        maxPerBooking: 1,
        validOn: 'all'
      }
    ]
  });

  const saveRes = await org1.req('PUT', `/api/organiser/drafts/${dId}`, {
    data,
    step: 'preview',
    version: r.json.draft.version
  });
  const pubRes = await org1.post(`/api/organiser/drafts/${dId}/publish`, {
    version: saveRes.json.draft.version,
    confirm: true
  });
  const event = await db.one('SELECT * FROM events WHERE id = $1', [pubRes.json.eventId]);
  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.id]);

  // Attempt concurrent requests for the single ticket
  const [res1, res2] = await Promise.all([
    attendee1.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1`),
    attendee2.get(`/checkout/${event.slug}/upi?ticketTypeId=${tier.id}&quantity=1`)
  ]);

  const successCount = [res1, res2].filter(r => r.status === 200).length;
  const failureCount = [res1, res2].filter(r => r.status === 409).length;

  assert.equal(successCount, 1, 'Exactly one concurrent booking succeeds');
  assert.equal(failureCount, 1, 'The other concurrent booking is rejected with 409');
});

// -----------------------------------------------------------------------------
// Scenario 14: Free event bookings remain unaffected
// -----------------------------------------------------------------------------
test('14. Free event bookings remain unaffected', async () => {
  const r = await org1.post('/api/organiser/drafts', { template: 'social' });
  const dId = r.json.draft.id;
  const data = validDirectUpiDraftData({
    title: 'Free Community Meetup',
    paymentMethod: 'free',
    organiserUpiId: undefined,
    organiserPayeeName: undefined,
    tickets: [
      {
        id: 'free_tier',
        name: 'Community Pass',
        kind: 'free',
        pricePaise: 0,
        quantity: 20,
        maxPerBooking: 2,
        validOn: 'all'
      }
    ]
  });

  const saveRes = await org1.req('PUT', `/api/organiser/drafts/${dId}`, {
    data,
    step: 'preview',
    version: r.json.draft.version
  });
  const pubRes = await org1.post(`/api/organiser/drafts/${dId}/publish`, {
    version: saveRes.json.draft.version,
    confirm: true
  });
  assert.equal(pubRes.status, 200);

  const event = await db.one('SELECT * FROM events WHERE id = $1', [pubRes.json.eventId]);
  const tier = await db.one('SELECT * FROM ticket_types WHERE event_id = $1', [event.id]);

  // Attendee books free pass
  const bookRes = await attendee1.post(`/api/events/${event.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1
  });
  assert.equal(bookRes.status, 200);
  assert.equal(bookRes.json.ok, true);

  // Booking is immediately confirmed
  const booking = await db.one(`SELECT * FROM bookings WHERE id = $1`, [bookRes.json.bookingId]);
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.amount_paise, 0);

  // Tickets issued immediately
  const tickets = (await db.query(`SELECT * FROM tickets WHERE booking_id = $1`, [booking.id])).rows;
  assert.equal(tickets.length, 1);
});

// -----------------------------------------------------------------------------
// Scenario 15: Existing paid drafts are preserved
// -----------------------------------------------------------------------------
test('15. Existing paid drafts are preserved', async () => {
  // Simulate an older draft created without paymentMethod explicitly set
  const r = await org1.post('/api/organiser/drafts', { template: 'party' });
  const dId = r.json.draft.id;

  // Raw database insert of an older draft with paid tickets
  const oldDraftData = {
    title: 'Vintage Party Draft',
    category: 'nightlife',
    timezone: 'Asia/Kolkata',
    city: 'Bengaluru',
    tickets: [
      {
        id: 'legacy_vip',
        name: 'Legacy VIP',
        kind: 'paid',
        pricePaise: 75000,
        quantity: 15,
        maxPerBooking: 2
      }
    ]
  };

  await db.query(
    `UPDATE event_drafts SET data = $1 WHERE id = $2`,
    [JSON.stringify(oldDraftData), dId]
  );

  // Organiser fetches draft: data is preserved, not wiped or converted to free
  const fetchRes = await org1.get(`/api/organiser/drafts/${dId}`);
  assert.equal(fetchRes.status, 200);
  const draft = fetchRes.json.draft;

  assert.equal(draft.data.tickets[0].name, 'Legacy VIP');
  assert.equal(draft.data.tickets[0].kind, 'paid');
  assert.equal(draft.data.tickets[0].pricePaise, 75000);

  // Organiser adapts draft by configuring UPI details
  const updateRes = await org1.req('PUT', `/api/organiser/drafts/${dId}`, {
    data: {
      ...draft.data,
      startLocal: istLocal(5, '20:00'),
      endLocal: istLocal(5, '23:00'),
      venue: 'Legacy Club',
      paymentMethod: 'direct_upi',
      organiserUpiId: 'legacyhost@axisbank',
      organiserPayeeName: 'Legacy Host'
    },
    step: 'preview',
    version: draft.version
  });
  assert.equal(updateRes.status, 200);

  // Ticket remains paid at ₹750.00
  assert.equal(updateRes.json.draft.data.tickets[0].kind, 'paid');
  assert.equal(updateRes.json.draft.data.tickets[0].pricePaise, 75000);
  assert.equal(updateRes.json.draft.data.paymentMethod, 'direct_upi');
});
