// test/booking-integrity.test.js - Milestone M4: Payment, booking and revenue readiness audit.
// Verifies free reservation lifecycle, capacity enforcement, concurrency protection, refusal of forged paid status,
// webhook idempotency & signature verification, refund state transitions, organiser access isolation,
// and strict enforcement of ENABLE_LIVE_PAYMENTS=false safety boundary.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  resetDb, startServer, stopServer, Client, db, callsTo, clearCalls, createEvent, signedInClient
} from './helpers.js';
import { checkoutForEvent } from '../lib/payments/availability.js';

const SECRET = 'test_sp_webhook_secret_0123456789';
const SP_URL = 'https://superprofile.bio/nightlifez/chennai-vip';

let owner;
let orgA;
let orgB;
let guest1;
let guest2;
let guest3;
let guest4;
let guest5;
let seq = 0;

before(async () => {
  await resetDb();
  await startServer();
  owner = await signedInClient({ tgId: 900000001 });
  await owner.get('/api/admin/session');
  orgA = await signedInClient();
  orgB = await signedInClient();
  guest1 = await signedInClient();
  guest2 = await signedInClient();
  guest3 = await signedInClient();
  guest4 = await signedInClient();
  guest5 = await signedInClient();
});

after(stopServer);
beforeEach(clearCalls);

const hook = (body, secret = SECRET) => new Client().req('POST', '/api/webhooks/superprofile', body, secret ? { 'x-webhook-secret': secret } : {});
const orderId = () => `ORD-M4-${Date.now().toString(36)}-${++seq}`.toUpperCase();

async function createOrgEvent(orgClient, title = 'Org Event', overrides = {}) {
  const org = (await db.one(`INSERT INTO organisations (kind, name) VALUES ('organiser_team', $1) RETURNING id`, [`Org-${title}-${++seq}`])).id;
  await db.query(`INSERT INTO org_memberships (user_id, org_id, role, status) VALUES ($1, $2, 'owner', 'active')`, [orgClient.userId, org]);
  const ev = await createEvent({ title, ...overrides });
  const updated = await db.one(`UPDATE events SET organiser_org_id = $2, organiser_user_id = $3 WHERE id = $1 RETURNING *`, [ev.id, org, orgClient.userId]);
  return updated;
}

// ---------------- 1. Concurrency and Capacity Enforcement ----------------

test('concurrency: concurrent bookings for the last remaining seats prevent overselling', async () => {
  // Create an event with total capacity of 2 and a free tier with quantity of 2
  const ev = await createEvent({ title: 'Limited Capacity Mixer', capacity: 2 });
  await db.query(`UPDATE events SET ticketing = 'tiers' WHERE id = $1`, [ev.id]);
  const tier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'Limited Free RSVP', 'free', 0, 2, 1, true) RETURNING *`,
    [ev.id]
  );

  // 5 distinct guests attempt to book the 2 remaining seats simultaneously
  const clients = [guest1, guest2, guest3, guest4, guest5];
  const promises = clients.map((c) =>
    c.post(`/api/events/${ev.id}/book`, {
      ticketTypeId: tier.id,
      quantity: 1,
      answers: {}
    })
  );

  const results = await Promise.all(promises);

  // Exactly 2 bookings must succeed (200 OK, confirmed)
  const successful = results.filter((r) => r.status === 200 && r.json?.status === 'confirmed');
  assert.equal(successful.length, 2, `exactly 2 bookings succeed, got ${successful.length}`);

  // The remaining 3 bookings must fail with 409 Conflict (sold_out)
  const rejected = results.filter((r) => r.status === 409 && r.json?.error === 'sold_out');
  assert.equal(rejected.length, 3, `exactly 3 bookings rejected as sold_out, got ${rejected.length}`);

  // Database verification: exactly 2 rows in bookings table for this event
  const bookingCount = await db.one(
    `SELECT count(*)::int AS count FROM bookings WHERE event_id = $1 AND status = 'confirmed'`,
    [ev.id]
  );
  assert.equal(bookingCount.count, 2, 'database records exactly 2 confirmed bookings');
});

// ---------------- 2. Refusal of Forged Paid Status ----------------

test('forged paid status: booking endpoint strictly rejects paid tiers and extra fields', async () => {
  const ev = await createEvent({ title: 'Tiered Show', capacity: 10 });
  await db.query(`UPDATE events SET ticketing = 'tiers' WHERE id = $1`, [ev.id]);
  const paidTier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'VIP Entry', 'paid', 250000, 5, 2, true) RETURNING *`,
    [ev.id]
  );

  // Attempting to book a paid tier via free booking API is rejected
  const resPaid = await guest1.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: paidTier.id,
    quantity: 1,
    answers: {}
  });
  assert.equal(resPaid.status, 409);
  assert.equal(resPaid.json.error, 'paid_on_superprofile');

  // Attempting to inject client-supplied forged fields (status, payment_mode, amount_paise)
  const freeTier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'Free Pass', 'free', 0, 5, 1, true) RETURNING *`,
    [ev.id]
  );
  const resTampered = await guest1.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: freeTier.id,
    quantity: 1,
    answers: {},
    status: 'confirmed',
    payment_mode: 'external',
    amount_paise: 0
  });
  // Strict schema validation rejects unknown keys with 400
  assert.equal(resTampered.status, 400);
  assert.equal(resTampered.json.error, 'validation');
});

test('forged paid status: organiser cannot approve a paid tier request into confirmed', async () => {
  const orgEv = await createOrgEvent(orgA, 'Host Event with Approval', { capacity: 10 });
  await db.query(`UPDATE events SET ticketing = 'tiers', requires_approval = true WHERE id = $1`, [orgEv.id]);
  const paidTier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'Paid Tier', 'paid', 100000, 5, 1, true) RETURNING *`,
    [orgEv.id]
  );

  // Directly insert a pending_approval booking for a paid tier (simulating stale or tampered state)
  const pendingBooking = await db.one(
    `INSERT INTO bookings (event_id, user_id, ticket_type_id, quantity, status, amount_paise)
     VALUES ($1, $2, $3, 1, 'pending_approval', 100000) RETURNING *`,
    [orgEv.id, guest2.userId, paidTier.id]
  );

  // Organiser attempts to approve the paid request
  const approveRes = await orgA.post(`/api/organiser/bookings/${pendingBooking.id}/approve`, {});
  assert.equal(approveRes.status, 409);
  assert.equal(approveRes.json.error, 'payment_unavailable');

  // Booking status remains pending_approval
  const check = await db.one(`SELECT status FROM bookings WHERE id = $1`, [pendingBooking.id]);
  assert.equal(check.status, 'pending_approval');
});

// ---------------- 3. Payment Boundary: ENABLE_LIVE_PAYMENTS=false ----------------

test('payment boundary: ENABLE_LIVE_PAYMENTS=false blocks checkout redirect for all events', async () => {
  assert.equal(process.env.ENABLE_LIVE_PAYMENTS, 'false', 'safety boundary is false');
  const ev = await createEvent({ title: 'Paid Event' });
  await db.query(
    `UPDATE events SET superprofile_url = $2, superprofile_product_id = 'prod-test-live', checkout_mode = 'superprofile' WHERE id = $1`,
    [ev.id, SP_URL]
  );

  // Availability helper returns unavailable
  const avail = checkoutForEvent(ev);
  assert.equal(avail.available, false);
  assert.equal(avail.reason, 'live_payments_disabled');

  // HTTP GET /checkout/:slug redirects back to event page, never to payment provider
  const client = new Client();
  const res = await client.get(`/checkout/${ev.slug}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/events/${ev.slug}`);
});

// ---------------- 4. Webhook Signature and Security Validation ----------------

test('webhooks: missing or invalid signature is rejected with 401', async () => {
  const ord = orderId();
  const payload = { event: 'purchase', id: ord, product_id: 'prod-none', amount: 500, currency: 'INR', qty: 1 };

  // Missing secret header
  const resMissing = await hook(payload, null);
  assert.equal(resMissing.status, 401);

  // Invalid secret header
  const resInvalid = await hook(payload, 'wrong-secret-01234567890123456');
  assert.equal(resInvalid.status, 401);

  // Verified: zero database entries created
  const orderRow = await db.one(`SELECT count(*)::int AS count FROM external_orders WHERE order_id = $1`, [ord]);
  assert.equal(orderRow.count, 0);
});

// ---------------- 5. Duplicate Webhooks and Replayed Requests ----------------

test('idempotency: duplicate purchase webhooks are no-op and never duplicate seats', async () => {
  const ev = await createEvent({ title: 'Webhook Idempotency Event', capacity: 10 });
  const prodId = `prod-idemp-${++seq}`;
  await db.query(
    `UPDATE events SET superprofile_url = $2, superprofile_product_id = $3, checkout_mode = 'superprofile', ticket_price_paise = 49900, price_status = 'set' WHERE id = $1`,
    [ev.id, SP_URL, prodId]
  );

  // Create checkout intent for guest1
  const intentRes = await db.one(
    `INSERT INTO checkout_intents (ref, user_id, event_id, qty, expires_at)
     VALUES ('REFIDMP1', $1, $2, 1, now() + interval '1 day') RETURNING ref`,
    [guest1.userId, ev.id]
  );

  const ord = orderId();
  const payload = {
    event: 'purchase',
    id: ord,
    product_id: prodId,
    amount: 499,
    currency: 'INR',
    qty: 1,
    ref: intentRes.ref
  };

  // 1st delivery: successfully processes and confirms
  const res1 = await hook(payload);
  assert.equal(res1.status, 200);
  assert.equal(res1.json.result, 'confirmed');

  // Verify booking exists
  const booking1 = await db.one(`SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2`, [ev.id, guest1.userId]);
  assert.equal(booking1.status, 'confirmed');
  assert.equal(booking1.payment_mode, 'external');

  // 2nd delivery (replayed request): returns duplicate
  const res2 = await hook(payload);
  assert.equal(res2.status, 200);
  assert.equal(res2.json.result, 'duplicate');

  // Total bookings for this event remains exactly 1
  const count = await db.one(`SELECT count(*)::int AS count FROM bookings WHERE event_id = $1`, [ev.id]);
  assert.equal(count.count, 1);
});

// ---------------- 6. Refund State Transitions and Idempotency ----------------

test('refunds: refund webhook transitions order and booking to refunded, revoking invite links', async () => {
  const ev = await createEvent({ title: 'Refund Event', capacity: 10 });
  const prodId = `prod-rfnd-${++seq}`;
  await db.query(
    `UPDATE events SET superprofile_url = $2, superprofile_product_id = $3, checkout_mode = 'superprofile', ticket_price_paise = 49900, price_status = 'set' WHERE id = $1`,
    [ev.id, SP_URL, prodId]
  );

  const intent = await db.one(
    `INSERT INTO checkout_intents (ref, user_id, event_id, qty, expires_at)
     VALUES ('REFRFND1', $1, $2, 1, now() + interval '1 day') RETURNING ref`,
    [guest3.userId, ev.id]
  );

  const ord = orderId();
  const purchasePayload = {
    event: 'purchase',
    id: ord,
    product_id: prodId,
    amount: 499,
    currency: 'INR',
    qty: 1,
    ref: intent.ref
  };
  await hook(purchasePayload);

  const booking = await db.one(`SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2`, [ev.id, guest3.userId]);
  assert.equal(booking.status, 'confirmed');

  // Generate an invite link for this confirmed booking
  const inviteLink = await db.one(
    `INSERT INTO invite_links (booking_id, user_id, chat_id, link, expires_at)
     VALUES ($1, $2, -1001111111111, 'https://t.me/+testrefundlink', now() + interval '1 day') RETURNING *`,
    [booking.id, guest3.userId]
  );
  assert.equal(inviteLink.revoked_at, null);

  // Send refund webhook
  const refundPayload = {
    event: 'refund',
    id: ord,
    product_id: prodId,
    amount: 499,
    currency: 'INR'
  };
  const refundRes = await hook(refundPayload);
  assert.equal(refundRes.status, 200);
  assert.equal(refundRes.json.result, 'refunded');

  // Verify external_order status is refunded
  const orderCheck = await db.one(`SELECT status FROM external_orders WHERE order_id = $1`, [ord]);
  assert.equal(orderCheck.status, 'refunded');

  // Verify booking status is refunded and refunded_at is set
  const bookingCheck = await db.one(`SELECT status, refunded_at FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(bookingCheck.status, 'refunded');
  assert.ok(bookingCheck.refunded_at !== null);

  // Verify invite link was revoked
  const inviteCheck = await db.one(`SELECT revoked_at FROM invite_links WHERE id = $1`, [inviteLink.id]);
  assert.ok(inviteCheck.revoked_at !== null, 'invite link revoked on refund');

  // Replay refund webhook: returns duplicate, maintains clean state
  const replayRes = await hook(refundPayload);
  assert.equal(replayRes.status, 200);
  assert.equal(replayRes.json.result, 'duplicate');
});

test('refunds: reversal before purchase is remembered and blocks late purchase confirmation', async () => {
  const ev = await createEvent({ title: 'Reversal First Event', capacity: 10 });
  const prodId = `prod-revfirst-${++seq}`;
  await db.query(
    `UPDATE events SET superprofile_url = $2, superprofile_product_id = $3, checkout_mode = 'superprofile', ticket_price_paise = 49900, price_status = 'set' WHERE id = $1`,
    [ev.id, SP_URL, prodId]
  );

  const ord = orderId();
  const refundPayload = {
    event: 'refund',
    id: ord,
    product_id: prodId,
    amount: 499,
    currency: 'INR'
  };

  // Refund arrives first
  const res1 = await hook(refundPayload);
  assert.equal(res1.status, 200);
  assert.equal(res1.json.result, 'refunded_before_purchase');

  // Late purchase arrives
  const purchasePayload = {
    event: 'purchase',
    id: ord,
    product_id: prodId,
    amount: 499,
    currency: 'INR',
    qty: 1
  };
  const res2 = await hook(purchasePayload);
  assert.equal(res2.status, 200);
  assert.equal(res2.json.result, 'duplicate');

  // Zero bookings confirmed
  const bookingCheck = await db.one(`SELECT count(*)::int AS count FROM bookings WHERE event_id = $1`, [ev.id]);
  assert.equal(bookingCheck.count, 0);
});

// ---------------- 7. Organiser Access Control and Cross-Organiser Isolation ----------------

test('access control: organiser A cannot view or manage attendees of organiser B event', async () => {
  const evA = await createOrgEvent(orgA, 'Org A Event');
  const evB = await createOrgEvent(orgB, 'Org B Event');

  // Add booking to Event B
  const bookingB = await db.one(
    `INSERT INTO bookings (event_id, user_id, quantity, status, payment_mode)
     VALUES ($1, $2, 1, 'pending_approval', 'free') RETURNING *`,
    [evB.id, guest4.userId]
  );

  // Organiser A attempts to view guests of Event B
  const viewRes = await orgA.get(`/api/organiser/events/${evB.id}/guests`);
  assert.ok([403, 404].includes(viewRes.status), `cross-organiser view rejected with ${viewRes.status}`);

  // Organiser A attempts to approve booking on Event B
  const approveRes = await orgA.post(`/api/organiser/bookings/${bookingB.id}/approve`, {});
  assert.ok([403, 404].includes(approveRes.status), `cross-organiser approve rejected with ${approveRes.status}`);

  // Booking B remains pending_approval
  const checkB = await db.one(`SELECT status FROM bookings WHERE id = $1`, [bookingB.id]);
  assert.equal(checkB.status, 'pending_approval');

  // Regular guest cannot access organiser guest list
  const guestRes = await guest1.get(`/api/organiser/events/${evA.id}/guests`);
  assert.ok([403, 404].includes(guestRes.status), `guest view rejected with ${guestRes.status}`);
});

// ---------------- 8. Rate Limiting on Booking Endpoint ----------------

test('rate limiting: booking endpoint throttles abusive request volume', async () => {
  const ev = await createEvent({ title: 'Rate Limited Event', capacity: 50 });
  await db.query(`UPDATE events SET ticketing = 'tiers' WHERE id = $1`, [ev.id]);
  const tier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'Pass', 'free', 0, 50, 1, true) RETURNING *`,
    [ev.id]
  );

  // Clear rate limits for this test client
  await db.query(`DELETE FROM rate_limits WHERE key = $1`, [`book:${guest5.userId}`]);

  // Allowed requests up to limit (10 per 10 minutes)
  for (let i = 0; i < 10; i++) {
    const res = await guest5.post(`/api/events/${ev.id}/book`, {
      ticketTypeId: tier.id,
      quantity: 1,
      answers: {}
    });
    // First request confirms, subsequent return existing: true, but all HTTP 200
    assert.equal(res.status, 200);
  }

  // 11th request triggers rate limit (429)
  const throttled = await guest5.post(`/api/events/${ev.id}/book`, {
    ticketTypeId: tier.id,
    quantity: 1,
    answers: {}
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.json.error, 'rate_limited');
});
