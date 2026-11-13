// test/payment-flags.test.js - ENABLE_LIVE_PAYMENTS gates only the SuperProfile link-out;
// UPI_CHECKOUT_ENABLED gates every UPI/PhonePe route. Free booking is unaffected by either. Real Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, startServer, stopServer, Client, db, createEvent, signedInClient } from './helpers.js';
import { checkoutForEvent } from '../lib/payments/availability.js';
import { configStatus } from '../lib/config.js';

const SP_URL = 'https://superprofile.bio/meetup_host/chennai-social';
let seq = 0;

before(async () => {
  await resetDb();
  await startServer();
});
after(async () => {
  process.env.ENABLE_LIVE_PAYMENTS = 'false';
  process.env.UPI_CHECKOUT_ENABLED = 'false';
  await stopServer();
});

function withFlags(live, upi, fn) {
  return async () => {
    const prev = [process.env.ENABLE_LIVE_PAYMENTS, process.env.UPI_CHECKOUT_ENABLED];
    process.env.ENABLE_LIVE_PAYMENTS = live;
    process.env.UPI_CHECKOUT_ENABLED = upi;
    try { await fn(); } finally {
      [process.env.ENABLE_LIVE_PAYMENTS, process.env.UPI_CHECKOUT_ENABLED] = prev;
    }
  };
}

async function spEvent() {
  const ev = await createEvent({ price: 49900 });
  await db.query(`UPDATE events SET superprofile_url = $2, superprofile_product_id = $3, checkout_mode = 'superprofile' WHERE id = $1`,
    [ev.id, SP_URL, `prod-flags-${++seq}-${crypto.randomBytes(3).toString('hex')}`]);
  return ev;
}

async function upiEvent() {
  const ev = await createEvent({ price: 49900 });
  await db.query(`UPDATE events SET ticketing = 'tiers', checkout_mode = 'upi_direct' WHERE id = $1`, [ev.id]);
  const tier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'Entry', 'paid', 49900, 10, 4, true) RETURNING *`, [ev.id]);
  return { ev, tier };
}

async function freeEvent() {
  const ev = await createEvent({ price: null }); // tiered events carry prices on ticket_types
  await db.query(`UPDATE events SET ticketing = 'tiers' WHERE id = $1`, [ev.id]);
  const tier = await db.one(
    `INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking, active)
     VALUES ($1, 'Free entry', 'free', 0, 10, 1, true) RETURNING *`, [ev.id]);
  return { ev, tier };
}

/** Every UPI/PhonePe surface must 404 while UPI_CHECKOUT_ENABLED is off. */
async function assertUpiClosed() {
  const { ev, tier } = await upiEvent();
  const user = await signedInClient();
  const anon = new Client();

  assert.equal((await user.get(`/checkout/${ev.slug}/upi`)).status, 404, 'UPI page');
  const intent = await user.post('/api/checkout/upi/intent', { slug: ev.slug, ticketTypeId: tier.id, quantity: 1 });
  assert.equal(intent.status, 404, 'UPI intent');
  assert.equal((await user.get('/api/checkout/upi/status/ORDER12345678')).status, 404, 'UPI status');
  assert.equal((await user.post('/api/checkout/upi/claim', { orderId: 'ORDER12345678', guestToken: 'x' })).status, 404, 'UPI claim');
  assert.equal((await anon.post('/api/payments/webhook/phonepe', { response: 'e30=' })).status, 404, 'PhonePe webhook');

  // The generic Book Tickets link must not hand off to the closed UPI page.
  const co = await anon.get(`/checkout/${ev.slug}`);
  assert.equal(co.status, 302);
  assert.equal(co.headers.get('location'), `/events/${ev.slug}`);
  assert.equal(checkoutForEvent({ checkout_mode: 'upi_direct' }).reason, 'upi_checkout_disabled');
  assert.equal((await db.one('SELECT count(*)::int n FROM payments WHERE booking_id IS NULL AND raw_ref->>\'eventId\' = $1', [ev.id])).n, 0, 'no intent row');
}

async function assertFreeBookingWorks() {
  const { ev, tier } = await freeEvent();
  const guest = await signedInClient();
  const r = await guest.post(`/api/events/${ev.id}/book`, { ticketTypeId: tier.id, quantity: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [r.json.bookingId])).status, 'confirmed');
}

test('ENABLE_LIVE_PAYMENTS=true, UPI_CHECKOUT_ENABLED=false: SuperProfile link-out works, every UPI route is closed, free booking works',
  withFlags('true', 'false', async () => {
    const ev = await spEvent();
    const r = await new Client().get(`/checkout/${ev.slug}`);
    assert.equal(r.status, 302, r.text);
    assert.ok(r.headers.get('location').startsWith(SP_URL), 'redirects to SuperProfile');
    await assertUpiClosed();
    await assertFreeBookingWorks();
    const cfg = configStatus();
    assert.equal(cfg.livePayments, true);
    assert.equal(cfg.upiCheckout, false);
  }));

test('both flags false: everything paid is closed, free booking works', withFlags('false', 'false', async () => {
  const ev = await spEvent();
  const r = await new Client().get(`/checkout/${ev.slug}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/events/${ev.slug}`, 'no SuperProfile hand-off');
  assert.equal(checkoutForEvent({ checkout_mode: 'superprofile', superprofile_url: SP_URL }).reason, 'live_payments_disabled');
  await assertUpiClosed();
  await assertFreeBookingWorks();
}));

test('UPI_CHECKOUT_ENABLED=true, ENABLE_LIVE_PAYMENTS=false: UPI opens on its own flag, SuperProfile stays closed',
  withFlags('false', 'true', async () => {
    assert.equal(checkoutForEvent({ checkout_mode: 'upi_direct' }).available, true);
    assert.equal(checkoutForEvent({ checkout_mode: 'superprofile', superprofile_url: SP_URL }).available, false);
    const { ev } = await upiEvent();
    const co = await new Client().get(`/checkout/${ev.slug}`);
    assert.equal(co.status, 302);
    assert.equal(co.headers.get('location'), `/checkout/${ev.slug}/upi`);
    await assertFreeBookingWorks();
  }));

test('UPI_CHECKOUT_ENABLED only opens on the exact string "true"', withFlags('false', 'TRUE', async () => {
  assert.equal(checkoutForEvent({ checkout_mode: 'upi_direct' }).available, false);
  process.env.UPI_CHECKOUT_ENABLED = '1';
  assert.equal(checkoutForEvent({ checkout_mode: 'upi_direct' }).available, false);
}));
