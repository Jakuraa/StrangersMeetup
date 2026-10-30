// test/superprofile-checkout.test.js - SuperProfile as the only ticket checkout: intents, order webhook,
// refunds, the Telegram claim flow, admin orders, and removal of the old providers. Real Postgres.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetDb, startServer, stopServer, Client, db, callsTo, clearCalls, createEvent, signedInClient, stubOnce
} from './helpers.js';
import { isSuperprofileUrl } from '../lib/payments/index.js';
import { newRef } from '../lib/services/checkout.js';
import { emailHash } from '../lib/services/superprofile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test_sp_webhook_secret_0123456789';
const TG_SECRET = { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_123456' };
const CRON = { authorization: 'Bearer test-cron-secret-0123456789' };
const SP_URL = 'https://superprofile.bio/meetup_host/chennai-social';

let owner;
let finance;
let support;
let seq = 0;

before(async () => {
  await resetDb();
  await startServer();
  owner = await signedInClient({ tgId: 900000001 });
  await owner.get('/api/admin/session');
  finance = await signedInClient();
  support = await signedInClient();
  await owner.post('/api/admin/admins', { telegram_user_id: finance.tgId, role: 'finance' });
  await owner.post('/api/admin/admins', { telegram_user_id: support.tgId, role: 'support' });
});
after(stopServer);
beforeEach(clearCalls);

const hook = (body, secret = SECRET) => new Client().req('POST', '/api/webhooks/superprofile', body, secret ? { 'x-webhook-secret': secret } : {});
const orderId = () => `ORD${Date.now().toString(36)}${++seq}`.toUpperCase();

/** A published event sold through SuperProfile. */
async function spEvent({ price = 49900, capacity = 20, productId = `prod-${++seq}-${crypto.randomBytes(3).toString('hex')}`, mode = 'superprofile', url = SP_URL, ...rest } = {}) {
  const ev = await createEvent({ price, capacity, ...rest });
  await db.query(`UPDATE events SET superprofile_url = $2, superprofile_product_id = $3, checkout_mode = $4 WHERE id = $1`, [ev.id, url, productId, mode]);
  return { ...ev, productId };
}

/** Click "Book Tickets" as `client` (or anonymously); returns the ref SuperProfile would carry back. */
async function clickBook(ev, client = new Client(), query = '') {
  const r = await client.get(`/checkout/${ev.slug}${query}`);
  assert.equal(r.status, 302, r.text);
  const loc = new URL(r.headers.get('location'));
  return { loc, ref: loc.searchParams.get('ref') };
}

const bookingFor = (eventId, userId) => db.one(`SELECT * FROM bookings WHERE event_id = $1 AND user_id = $2`, [eventId, userId]);
const orderRow = (id) => db.one('SELECT * FROM external_orders WHERE order_id = $1', [id]);

let upd = 70000;
const tgMessage = (client, text) => new Client().post('/api/telegram/webhook', {
  update_id: ++upd,
  message: { message_id: upd, date: 0, chat: { id: client.tgId, type: 'private' }, from: { id: client.tgId, first_name: 'Buyer' }, text }
}, TG_SECRET);
const lastReply = (client) => callsTo('sendMessage').filter((m) => m.params.chat_id === client.tgId).pop()?.params.text || '';

// ---------------- checkout intents ----------------

test('Book Tickets redirects to SuperProfile with a ref, signed in or not; one intent per click', async () => {
  const ev = await spEvent();
  const guest = await signedInClient();
  const a = await clickBook(ev, guest);
  assert.equal(a.loc.origin + a.loc.pathname, SP_URL);
  assert.match(a.ref, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(a.loc.searchParams.get('utm_source'), 'strangersmeetup');
  const intent = await db.one('SELECT * FROM checkout_intents WHERE ref = $1', [a.ref]);
  assert.equal(intent.user_id, guest.userId);
  assert.equal(intent.event_id, ev.id);
  assert.ok(new Date(intent.expires_at) > new Date(Date.now() + 24 * 3600e3));

  // Anonymous: no friction, no user attached, funnel event logged.
  const b = await clickBook(ev);
  assert.notEqual(b.ref, a.ref);
  assert.equal((await db.one('SELECT user_id FROM checkout_intents WHERE ref = $1', [b.ref])).user_id, null);
  assert.ok((await db.one(`SELECT count(*)::int n FROM analytics_events WHERE name = 'checkout_click' AND event_id = $1`, [ev.id])).n >= 2);

  // A crawler HEAD never creates an intent.
  const before = (await db.one('SELECT count(*)::int n FROM checkout_intents')).n;
  const head = await new Client().req('HEAD', `/checkout/${ev.slug}`);
  assert.equal(head.status, 302);
  assert.equal((await db.one('SELECT count(*)::int n FROM checkout_intents')).n, before);
});

test('refs are unique and unguessable-looking', () => {
  const refs = new Set(Array.from({ length: 2000 }, () => newRef()));
  assert.equal(refs.size, 2000);
  for (const r of refs) assert.match(r, /^[0-9A-HJKMNP-TV-Z]{8}$/);
});

test('events without a SuperProfile product, closed or unknown events never redirect out', async () => {
  const plain = await createEvent({ price: 49900 });
  const r = await new Client().get(`/checkout/${plain.slug}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/events/${plain.slug}`);
  const draft = await spEvent({ status: 'draft' });
  assert.equal((await new Client().get(`/checkout/${draft.slug}`)).status, 404);
  const past = await spEvent();
  await db.query(`UPDATE events SET start_at = now() - interval '3 days', end_at = now() - interval '2 days' WHERE id = $1`, [past.id]);
  assert.equal((await new Client().get(`/checkout/${past.slug}`)).status, 404);
  assert.equal((await new Client().get('/checkout/Not_A_Slug!')).status, 404);
  // A multi-day trip that has started but not ended: the page already shows it as past, so the
  // checkout link must not still sell it (same rule as free tiers: closed once it starts).
  const running = await spEvent();
  await db.query(`UPDATE events SET start_at = now() - interval '1 day', end_at = now() + interval '2 days' WHERE id = $1`, [running.id]);
  const before = (await db.query(`SELECT count(*)::int AS n FROM checkout_intents WHERE event_id = $1`, [running.id])).rows[0].n;
  assert.equal((await new Client().get(`/checkout/${running.slug}`)).status, 404);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM checkout_intents WHERE event_id = $1`, [running.id])).rows[0].n, before, 'no intent recorded');
});

test('SuperProfile URL allowlist: https and superprofile.bio hosts only', async () => {
  for (const ok of ['https://superprofile.bio/x', 'https://meetup.superprofile.bio/x?a=1', 'https://SuperProfile.bio/x']) assert.equal(isSuperprofileUrl(ok), true, ok);
  for (const bad of ['https://evil.com/x', 'https://superprofile.bio.evil.com/x', 'https://evilsuperprofile.bio/x', 'http://superprofile.bio/x',
    'https://superprofile.bio@evil.com/x', 'https://user:pw@superprofile.bio/x', 'https://superprofile.bio:8443/x', 'javascript:alert(1)', '//superprofile.bio/x', '']) {
    assert.equal(isSuperprofileUrl(bad), false, bad);
  }
  const ev = await createEvent();
  const body = (url) => ({
    slug: ev.slug, category: 'meetup', title: 'Test Meetup', city: 'Chennai', venue_privacy: 'public', start_at: '2031-01-01T10:00:00+05:30',
    capacity: 10, checkout_mode: 'superprofile', superprofile_url: url
  });
  for (const bad of ['https://evil.com/x', 'https://superprofile.bio.evil.com/x']) {
    const r = await owner.patch(`/api/admin/events/${ev.id}`, body(bad));
    assert.equal(r.status, 400, bad);
  }
  // The database refuses it too, whatever the app does.
  await assert.rejects(() => db.query(`UPDATE events SET superprofile_url = 'https://evil.com/x' WHERE id = $1`, [ev.id]));
  await assert.rejects(() => db.query(`UPDATE events SET checkout_mode = 'superprofile', superprofile_url = NULL WHERE id = $1`, [ev.id]));
  assert.equal((await owner.patch(`/api/admin/events/${ev.id}`, body(SP_URL))).status, 200);
});

// ---------------- webhook ----------------

test('webhook: wrong or missing secret → 401 before any write; unconfigured → 503', async () => {
  const id = orderId();
  const body = { event: 'purchase', id, product: 'whatever', amount: '499' };
  assert.equal((await hook(body, 'wrong-secret-wrong-secret-wrong')).status, 401);
  assert.equal((await hook(body, null)).status, 401);
  assert.equal((await orderRow(id)), null);
  assert.equal((await db.one('SELECT count(*)::int n FROM external_orders WHERE order_id = $1', [id])).n, 0);
  assert.equal((await db.one('SELECT count(*)::int n FROM integration_errors')).n, 0, 'a rejected request writes nothing');
  const saved = process.env.SUPERPROFILE_WEBHOOK_SECRET;
  delete process.env.SUPERPROFILE_WEBHOOK_SECRET;
  try { assert.equal((await hook(body)).status, 503); } finally { process.env.SUPERPROFILE_WEBHOOK_SECRET = saved; }
});

test('paid order matched by ref confirms the booking, sends one invite and one DM; duplicate is a no-op', async () => {
  const ev = await spEvent({ price: 49900 });
  const guest = await signedInClient();
  const { ref } = await clickBook(ev, guest);
  // Nothing is confirmed by merely clicking, or by a client-side "I paid".
  assert.equal(await bookingFor(ev.id, guest.userId), null);

  const id = orderId();
  const w = { event: 'purchase', id, product_id: ev.productId, amount: '₹499.00', currency: 'INR', email: 'Buyer@Example.com', ref: ref.toLowerCase() };
  const r1 = await hook(w);
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.result, 'confirmed');
  const b = await bookingFor(ev.id, guest.userId);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.source, 'superprofile');
  assert.equal(b.payment_mode, 'external');
  assert.equal(b.quantity, 1);
  assert.equal(b.amount_paise, 49900);
  const o = await orderRow(id);
  assert.equal(o.match_state, 'matched');
  assert.equal(o.matched_booking_id, b.id);
  assert.equal(o.ref, ref);
  assert.equal(o.status, 'paid');

  const dup = await hook(w);
  assert.equal(dup.json.result, 'duplicate');
  assert.equal((await db.one('SELECT count(*)::int n FROM bookings WHERE event_id = $1', [ev.id])).n, 1);
  assert.equal(callsTo('createChatInviteLink').length, 1);
  assert.equal(callsTo('createChatInviteLink')[0].params.member_limit, 1);
  const dm = callsTo('sendMessage').find((m) => m.params.chat_id === guest.tgId);
  assert.match(dm.params.text, /You're booked/);
  assert.match(dm.params.text, /on SuperProfile/);

  // The buyer's email is only stored as a keyed hash.
  const dump = JSON.stringify((await db.query('SELECT * FROM external_orders')).rows) + JSON.stringify((await db.query('SELECT * FROM audit_log')).rows);
  assert.doesNotMatch(dump.toLowerCase(), /buyer@example\.com/);

  const view = await guest.get(`/api/bookings/${b.id}`);
  assert.equal(view.json.booking.status, 'confirmed');
  assert.equal(view.json.booking.paymentStatus, 'paid');
});

test('unknown product → stored as unmatched, 200, admin alerted; nothing is dropped', async () => {
  const id = orderId();
  const r = await hook({ event: 'purchase', id, product: 'Mystery Product', amount: '100', email: 'x@example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.json.result, 'unmatched');
  const o = await orderRow(id);
  assert.equal(o.event_id, null);
  assert.equal(o.match_state, 'unmatched');
  assert.equal(o.flag_reason, 'unknown_product');
  assert.ok(await db.one(`SELECT 1 AS x FROM integration_errors WHERE kind = 'order_unknown_product'`));
  const alert = callsTo('sendMessage').find((m) => m.params.chat_id === 900000001 && /needs review/.test(m.params.text));
  assert.ok(alert, 'bootstrap admin got a Telegram alert');
  assert.match(alert.params.text, new RegExp(id));
});

test('amount mismatch (or missing amount) is stored and flagged, never confirmed', async () => {
  const ev = await spEvent({ price: 49900 });
  const guest = await signedInClient();
  for (const amount of ['100', undefined, 'abc']) {
    const { ref } = await clickBook(ev, guest);
    const id = orderId();
    const r = await hook({ event: 'purchase', id, product_id: ev.productId, ref, ...(amount === undefined ? {} : { amount }) });
    assert.equal(r.json.result, 'flagged', `amount=${amount}`);
    const o = await orderRow(id);
    assert.equal(o.match_state, 'flagged');
    assert.equal(o.flag_reason, 'amount_mismatch');
    assert.equal(o.matched_booking_id, null);
  }
  assert.equal(await bookingFor(ev.id, guest.userId), null);
  // A foreign currency is flagged too.
  const { ref } = await clickBook(ev, guest);
  const usd = orderId();
  assert.equal((await hook({ event: 'purchase', id: usd, product_id: ev.productId, ref, amount: '499', currency: 'USD' })).json.result, 'flagged');
  assert.equal((await orderRow(usd)).flag_reason, 'currency_mismatch');
  assert.equal(await bookingFor(ev.id, guest.userId), null);
});

test('qty 3 on one order counts 3 seats (given or inferred from the amount)', async () => {
  const ev = await spEvent({ price: 10000, capacity: 20 });
  const g1 = await signedInClient();
  const g2 = await signedInClient();
  const a = await clickBook(ev, g1);
  assert.equal((await hook({ event: 'purchase', id: orderId(), product_id: ev.productId, ref: a.ref, amount: '300', qty: 3 })).json.result, 'confirmed');
  const b = await clickBook(ev, g2);
  assert.equal((await hook({ event: 'purchase', id: orderId(), product_id: ev.productId, ref: b.ref, amount: '300' })).json.result, 'confirmed', 'qty inferred from amount ÷ price');
  assert.equal((await bookingFor(ev.id, g1.userId)).quantity, 3);
  assert.equal((await bookingFor(ev.id, g2.userId)).quantity, 3);
  assert.equal((await db.one(`SELECT sum(quantity)::int n FROM bookings WHERE event_id = $1 AND status = 'confirmed'`, [ev.id])).n, 6);
  // qty and amount disagreeing is a mismatch, not a guess.
  const g3 = await signedInClient();
  const c = await clickBook(ev, g3);
  const id = orderId();
  assert.equal((await hook({ event: 'purchase', id, product_id: ev.productId, ref: c.ref, amount: '300', qty: 2 })).json.result, 'flagged');
});

test('an expired ref is ignored: the order stays unmatched', async () => {
  const ev = await spEvent();
  const guest = await signedInClient();
  const { ref } = await clickBook(ev, guest);
  await db.query(`UPDATE checkout_intents SET expires_at = now() - interval '1 minute' WHERE ref = $1`, [ref]);
  const id = orderId();
  const r = await hook({ event: 'purchase', id, product_id: ev.productId, ref, amount: '499' });
  assert.equal(r.json.result, 'unmatched');
  assert.equal(await bookingFor(ev.id, guest.userId), null);
  assert.equal((await orderRow(id)).match_state, 'unmatched');
});

test('refund → booking refunded, unused invite revoked, guest told; repeat is a no-op', async () => {
  const ev = await spEvent();
  const guest = await signedInClient();
  const { ref } = await clickBook(ev, guest);
  const id = orderId();
  await hook({ event: 'purchase', id, product_id: ev.productId, ref, amount: '499' });
  const b = await bookingFor(ev.id, guest.userId);
  assert.equal((await db.one('SELECT count(*)::int n FROM invite_links WHERE booking_id = $1 AND revoked_at IS NULL', [b.id])).n, 1);
  clearCalls();
  const r = await hook({ event: 'refund', id });
  assert.equal(r.json.result, 'refunded');
  assert.equal((await bookingFor(ev.id, guest.userId)).status, 'refunded');
  assert.equal((await orderRow(id)).status, 'refunded');
  assert.equal((await db.one('SELECT count(*)::int n FROM invite_links WHERE booking_id = $1 AND revoked_at IS NULL', [b.id])).n, 0);
  assert.ok(callsTo('sendMessage').some((m) => m.params.chat_id === guest.tgId && /refunded/.test(m.params.text)));
  assert.equal(callsTo('banChatMember').length, 0, 'never joined, nobody to remove');
  assert.equal((await hook({ event: 'refund', id })).json.result, 'duplicate');
  assert.equal((await hook({ event: 'cancelled', id })).json.result, 'duplicate');
});

test('refund after the guest already joined removes them from the group', async () => {
  const ev = await spEvent();
  const guest = await signedInClient();
  const { ref } = await clickBook(ev, guest);
  const id = orderId();
  await hook({ event: 'purchase', id, product_id: ev.productId, ref, amount: '499' });
  const b = await bookingFor(ev.id, guest.userId);
  await db.query('UPDATE invite_links SET used_at = now() WHERE booking_id = $1', [b.id]);
  clearCalls();
  await hook({ event: 'refund', id });
  const ban = callsTo('banChatMember')[0];
  assert.equal(ban.params.user_id, guest.tgId);
  assert.equal(ban.params.chat_id, -1001111111111);
  assert.equal(callsTo('unbanChatMember').length, 1);
});

test('cancel after check-in keeps the check-in record and flags the order for finance', async () => {
  const ev = await spEvent();
  const guest = await signedInClient();
  const { ref } = await clickBook(ev, guest);
  const id = orderId();
  await hook({ event: 'purchase', id, product_id: ev.productId, ref, amount: '499' });
  const b = await bookingFor(ev.id, guest.userId);
  await db.query(`UPDATE bookings SET status = 'checked_in', checked_in_at = now() WHERE id = $1`, [b.id]);
  const r = await hook({ event: 'cancelled', id });
  assert.equal(r.json.result, 'cancelled_after_check_in');
  const after = await bookingFor(ev.id, guest.userId);
  assert.equal(after.status, 'checked_in');
  assert.ok(after.checked_in_at);
  const o = await orderRow(id);
  assert.equal(o.status, 'cancelled');
  assert.equal(o.match_state, 'flagged');
  assert.equal(o.flag_reason, 'refund_after_check_in');
});

test('a refund that arrives before its purchase is remembered; the late purchase is then a no-op', async () => {
  const ev = await spEvent();
  const id = orderId();
  assert.equal((await hook({ event: 'refund', id, product_id: ev.productId })).json.result, 'refunded_before_purchase');
  const guest = await signedInClient();
  const { ref } = await clickBook(ev, guest);
  assert.equal((await hook({ event: 'purchase', id, product_id: ev.productId, ref, amount: '499' })).json.result, 'duplicate');
  assert.equal(await bookingFor(ev.id, guest.userId), null);
  assert.equal((await orderRow(id)).status, 'refunded');
});

test('a second paid order for an event the buyer already holds is flagged, not double-booked', async () => {
  const ev = await spEvent();
  const guest = await signedInClient();
  await hook({ event: 'purchase', id: orderId(), product_id: ev.productId, ref: (await clickBook(ev, guest)).ref, amount: '499' });
  const id = orderId();
  const r = await hook({ event: 'purchase', id, product_id: ev.productId, ref: (await clickBook(ev, guest)).ref, amount: '499' });
  assert.equal(r.json.result, 'flagged');
  assert.equal((await orderRow(id)).flag_reason, 'duplicate_booking');
  assert.equal((await db.one('SELECT count(*)::int n FROM bookings WHERE event_id = $1 AND user_id = $2', [ev.id, guest.userId])).n, 1);
});

test('event page: SuperProfile owns capacity, so our own seat count never marks it sold out', async () => {
  const ev = await spEvent({ capacity: 1 });
  const guest = await signedInClient();
  await hook({ event: 'purchase', id: orderId(), product_id: ev.productId, ref: (await clickBook(ev, guest)).ref, amount: '499' });
  const g2 = await signedInClient();
  const r = await hook({ event: 'purchase', id: orderId(), product_id: ev.productId, ref: (await clickBook(ev, g2)).ref, amount: '499' });
  assert.equal(r.json.result, 'confirmed', 'a paid order is honoured; SuperProfile stock decides');
  assert.match((await new Client().get(`/events/${ev.slug}`)).text, /data-sp-buy=/);
});

// ---------------- tiered events ----------------

test('paid tier on a linked event: checkout carries tier and qty; the order confirms that tier', async () => {
  const ev = await createEvent({ capacity: 30 });
  await db.query(`UPDATE events SET ticketing = 'tiers', checkout_mode = 'superprofile', superprofile_url = $2, superprofile_product_id = $3 WHERE id = $1`, [ev.id, SP_URL, `tier-prod-${++seq}`]);
  const free = await db.one(`INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking) VALUES ($1, 'Free', 'free', 0, 5, 1) RETURNING id`, [ev.id]);
  const paid = await db.one(`INSERT INTO ticket_types (event_id, name, kind, price_paise, quantity, max_per_booking) VALUES ($1, 'General', 'paid', 30000, 10, 4) RETURNING id`, [ev.id]);
  const page = (await new Client().get(`/events/${ev.slug}`)).text;
  assert.match(page, new RegExp(`data-checkout-path="/checkout/${ev.slug}"`));
  assert.match(page, /data-paid="1"/);
  assert.doesNotMatch(page, /Online payment isn’t available yet/);

  const guest = await signedInClient();
  assert.equal((await new Client().get(`/checkout/${ev.slug}?tier=${free.id}&qty=1`)).status, 404, 'a free tier is not bought on SuperProfile');
  assert.equal((await guest.get(`/checkout/${ev.slug}?tier=${paid.id}&qty=9`)).status, 400, 'over max per booking');
  const { ref } = await clickBook(ev, guest, `?tier=${paid.id}&qty=2`);
  const intent = await db.one('SELECT * FROM checkout_intents WHERE ref = $1', [ref]);
  assert.equal(intent.ticket_type_id, paid.id);
  assert.equal(intent.qty, 2);

  const prod = (await db.one('SELECT superprofile_product_id p FROM events WHERE id = $1', [ev.id])).p;
  const id = orderId();
  assert.equal((await hook({ event: 'purchase', id, product_id: prod, ref, amount: '600' })).json.result, 'confirmed');
  const b = await bookingFor(ev.id, guest.userId);
  assert.equal(b.ticket_type_id, paid.id);
  assert.equal(b.quantity, 2);
  assert.equal(b.amount_paise, 60000);

  // An amount no tier × qty can produce is flagged.
  const g2 = await signedInClient();
  const bad = orderId();
  assert.equal((await hook({ event: 'purchase', id: bad, product_id: prod, ref: (await clickBook(ev, g2, `?tier=${paid.id}&qty=1`)).ref, amount: '123' })).json.result, 'flagged');
});

// ---------------- public pages ----------------

test('event page: paid event with a SuperProfile link shows an external Book Tickets link; without one, a disabled state', async () => {
  const linked = await spEvent({ price: 49900 });
  const page = (await new Client().get(`/events/${linked.slug}`)).text;
  const a = /<a [^>]*data-sp-buy="[^"]+"[^>]*>/.exec(page)?.[0] || '';
  assert.match(a, new RegExp(`href="/checkout/${linked.slug}"`));
  assert.match(a, /rel="noopener nofollow"/);
  assert.match(a, /data-web-only/);
  assert.match(page, /Book Tickets/);
  assert.match(page, /Secure checkout on SuperProfile/);
  assert.match(page, /data-tg-only/, 'Mini App sees a "buy on the website" note instead');
  assert.doesNotMatch(page, /<input[^>]*(card|cvv|upi)/i, 'no payment fields on this site');

  const plain = await createEvent({ price: 49900 });
  const p2 = (await new Client().get(`/events/${plain.slug}`)).text;
  assert.match(p2, /Online booking not available yet/);
  assert.doesNotMatch(p2, /data-sp-buy=/);

  // Price still to be announced but already linked: bookable, price shown at checkout.
  const tbd = await spEvent({ price: null });
  const p3 = (await new Client().get(`/events/${tbd.slug}`)).text;
  assert.match(p3, /data-sp-buy=/);
  assert.match(p3, /Price shown at checkout/);
});

// ---------------- Telegram claim flow ----------------

/** An unmatched paid order for `ev`. */
async function unmatchedOrder(ev, { id = orderId(), email = null, amount = '499' } = {}) {
  const r = await hook({ event: 'purchase', id, product_id: ev.productId, amount, ...(email ? { email } : {}) });
  assert.equal(r.json.result, 'unmatched', r.text);
  return id;
}

test('claim: a valid order yields one booking and exactly one invite; a second claim is refused', async () => {
  const ev = await spEvent();
  const id = await unmatchedOrder(ev);
  const buyer = await signedInClient();
  clearCalls();
  await tgMessage(buyer, `/claim ${id}`);
  const b = await bookingFor(ev.id, buyer.userId);
  assert.equal(b.status, 'confirmed');
  assert.equal(b.source, 'superprofile');
  assert.equal((await orderRow(id)).matched_booking_id, b.id);
  assert.equal(callsTo('createChatInviteLink').length, 1);
  assert.ok(callsTo('sendMessage').some((m) => m.params.chat_id === buyer.tgId && /Order claimed/.test(m.params.text)));
  assert.ok(callsTo('sendMessage').some((m) => m.params.chat_id === buyer.tgId && /You're booked/.test(m.params.text)));

  clearCalls();
  await tgMessage(buyer, `/claim ${id}`);
  assert.match(lastReply(buyer), /could not claim/);
  assert.equal(callsTo('createChatInviteLink').length, 0);
  const other = await signedInClient();
  await tgMessage(other, `/claim ${id}`);
  assert.match(lastReply(other), /could not claim/, 'an order already matched to someone else is refused');
  assert.equal(await bookingFor(ev.id, other.userId), null);
});

test('claim: unknown order, unknown shape, and refunded orders all get the same generic answer', async () => {
  const ev = await spEvent();
  const buyer = await signedInClient();
  await tgMessage(buyer, '/claim DOESNOTEXIST123');
  const generic = lastReply(buyer);
  assert.match(generic, /could not claim/);
  await tgMessage(buyer, '/claim ab');
  assert.equal(lastReply(buyer), generic);
  const refunded = orderId();
  await hook({ event: 'refund', id: refunded, product_id: ev.productId });
  await tgMessage(buyer, `/claim ${refunded}`);
  assert.equal(lastReply(buyer), generic);
  assert.equal((await db.one('SELECT count(*)::int n FROM bookings WHERE user_id = $1', [buyer.userId])).n, 0);
});

test('claim: rate-limited to 5 attempts an hour per Telegram user', async () => {
  const ev = await spEvent();
  const id = await unmatchedOrder(ev);
  const buyer = await signedInClient();
  for (let i = 0; i < 5; i++) await tgMessage(buyer, `/claim WRONGORDER${i}`);
  clearCalls();
  await tgMessage(buyer, `/claim ${id}`);
  assert.match(lastReply(buyer), /more than 5 attempts/);
  assert.equal(await bookingFor(ev.id, buyer.userId), null, 'even a correct ID is refused once limited');
  assert.equal((await orderRow(id)).matched_booking_id, null);
});

test('claim: guessable (numeric) order IDs also need the buyer’s email', async () => {
  const ev = await spEvent();
  const id = String(100000 + (++seq));
  await unmatchedOrder(ev, { id, email: 'Real.Buyer@Example.com' });
  const thief = await signedInClient();
  await tgMessage(thief, `/claim ${id}`);
  assert.match(lastReply(thief), /could not claim/);
  await tgMessage(thief, `/claim ${id} someone.else@example.com`);
  assert.match(lastReply(thief), /could not claim/);
  assert.equal(await bookingFor(ev.id, thief.userId), null);
  const buyer = await signedInClient();
  await tgMessage(buyer, `/claim ${id} real.buyer@example.com`);
  assert.equal((await bookingFor(ev.id, buyer.userId)).status, 'confirmed');
  // The proven email now links the user: their next order matches without a claim.
  assert.equal((await db.one('SELECT email_hash FROM users WHERE id = $1', [buyer.userId])).email_hash, emailHash('real.buyer@example.com'));
  const ev2 = await spEvent();
  const next = orderId();
  const r = await hook({ event: 'purchase', id: next, product_id: ev2.productId, amount: '499', email: 'REAL.BUYER@example.com' });
  assert.equal(r.json.result, 'confirmed');
  assert.equal((await bookingFor(ev2.id, buyer.userId)).status, 'confirmed');
});

test('claim: /start claim then a plain message works; under-21 users are sent to confirm age first', async () => {
  const ev = await spEvent();
  const id = await unmatchedOrder(ev);
  const buyer = await signedInClient();
  await tgMessage(buyer, '/start claim');
  assert.match(lastReply(buyer), /SuperProfile order ID/);
  clearCalls();
  await tgMessage(buyer, id);
  assert.equal((await bookingFor(ev.id, buyer.userId)).status, 'confirmed');

  const ev2 = await spEvent();
  const id2 = await unmatchedOrder(ev2);
  const minor = await signedInClient({ ageConfirmed: false });
  await tgMessage(minor, `/claim ${id2}`);
  assert.match(lastReply(minor), /21/);
  assert.equal(await bookingFor(ev2.id, minor.userId), null);
  assert.equal((await orderRow(id2)).matched_booking_id, null);
});

test('claim: an invite failure keeps the booking and is retried by cron', async () => {
  const ev = await spEvent();
  const id = await unmatchedOrder(ev);
  const buyer = await signedInClient();
  stubOnce('tg:createChatInviteLink', () => { const e = new Error('Bad Request: not enough rights'); e.code = 400; throw e; });
  await tgMessage(buyer, `/claim ${id}`);
  const b = await bookingFor(ev.id, buyer.userId);
  const n = await db.one(`SELECT status, last_error FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed'`, [b.id]);
  assert.equal(n.status, 'failed');
  await db.query(`UPDATE notifications SET next_attempt_at = now() WHERE booking_id = $1`, [b.id]);
  await new Client().get('/api/cron/notifications', CRON);
  assert.equal((await db.one(`SELECT status FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed'`, [b.id])).status, 'sent');
  assert.equal((await db.one('SELECT count(*)::int n FROM invite_links WHERE booking_id = $1', [b.id])).n, 1);
});

// ---------------- admin orders ----------------

test('admin Orders: finance can link (audited), support can only look, the list paginates', async () => {
  const ev = await spEvent();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await unmatchedOrder(ev));
  assert.equal((await new Client().get('/api/admin/orders')).status, 401);
  assert.equal((await (await signedInClient()).get('/api/admin/orders')).status, 403);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await support.get(`/api/admin/orders?state=unmatched&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.orders.length <= 2);
    seen.push(...r.json.orders.map((o) => o.order_id));
    cursor = r.json.nextCursor;
    pages++;
  } while (cursor && pages < 20);
  for (const id of ids) assert.ok(seen.includes(id), `${id} listed`);
  assert.equal(new Set(seen).size, seen.length, 'no order listed twice');
  assert.ok(pages >= 3);
  assert.equal((await support.get('/api/admin/orders?state=bogus')).status, 400);
  assert.equal((await support.get('/api/admin/orders?cursor=junk')).status, 400);

  const row = await orderRow(ids[0]);
  const buyer = await signedInClient();
  assert.equal((await support.post(`/api/admin/orders/${row.id}/link`, { telegramUserId: buyer.tgId })).status, 403);
  assert.equal((await finance.post(`/api/admin/orders/${row.id}/link`, { telegramUserId: 999999999 })).status, 404, 'unknown user');
  const ok = await finance.post(`/api/admin/orders/${row.id}/link`, { telegramUserId: buyer.tgId });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await bookingFor(ev.id, buyer.userId)).status, 'confirmed');
  const audit = await db.one(`SELECT actor FROM audit_log WHERE action = 'order.manual_link' AND target = $1`, [row.id]);
  assert.match(audit.actor, /finance/);
  assert.equal((await finance.post(`/api/admin/orders/${row.id}/link`, { telegramUserId: buyer.tgId })).status, 409, 'already linked');
  assert.equal((await orderRow(ids[0])).match_state, 'matched');
  const matched = await support.get('/api/admin/orders?state=matched');
  assert.ok(matched.json.orders.some((o) => o.order_id === ids[0]));
});

test('admin event form: SuperProfile product ids are unique and changes are audited', async () => {
  const a = await createEvent();
  const b = await createEvent();
  const body = (e, extra) => ({
    slug: e.slug, category: 'meetup', title: 'Test Meetup', city: 'Chennai', venue_privacy: 'public', start_at: '2031-01-01T10:00:00+05:30', capacity: 10,
    checkout_mode: 'superprofile', superprofile_url: SP_URL, ...extra
  });
  const pid = `uniq-${++seq}`;
  assert.equal((await owner.patch(`/api/admin/events/${a.id}`, body(a, { superprofile_product_id: pid }))).status, 200);
  const dupe = await owner.patch(`/api/admin/events/${b.id}`, body(b, { superprofile_product_id: pid.toUpperCase() }));
  assert.equal(dupe.status, 409);
  assert.equal(dupe.json.error, 'product_taken');
  assert.equal((await owner.patch(`/api/admin/events/${b.id}`, body(b, { checkout_mode: 'superprofile', superprofile_url: '' }))).status, 400, 'SuperProfile mode needs a link');
  const log = await db.one(`SELECT details FROM audit_log WHERE action = 'event.update' AND target = $1 ORDER BY at DESC LIMIT 1`, [a.id]);
  assert.equal(log.details.checkoutMode, 'superprofile');
  assert.equal(log.details.superprofileProductChanged, true);
});

// ---------------- provider removal ----------------

test('Razorpay and Cashfree are gone from code, config, UI and docs', () => {
  const skip = new Set(['node_modules', '.git', '.next', '.vercel', 'playwright-report', 'test-results', 'test', 'migrations', '.claude', '.remember', '.agents']);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|json|md|html|css|svg|txt|sql|yml|yaml|example)$/.test(e.name) && e.name !== '.env.example') continue;
      if (e.name === 'package-lock.json') continue;
      if (/razorpay|cashfree/i.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
  const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const name of ['PAYMENT_PROVIDER', 'RAZORPAY_', 'CASHFREE_', 'TICKET_CHECKOUT_ENABLED']) assert.ok(!env.includes(name), name);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'lib/payments')).sort(), ['availability.js', 'index.js', 'superprofile.js']);
});

test('the old payment webhook and booking-checkout API no longer exist', async () => {
  assert.equal((await new Client().post('/api/payments/webhook/razorpay', {})).status, 404);
  assert.equal((await new Client().post('/api/payments/webhook/superprofile_link', {})).status, 404);
  assert.equal((await (await signedInClient()).post('/api/bookings', { eventId: crypto.randomUUID() })).status, 404);
});

test('the provider interface: refund is not supported in-app, webhook verification is constant-time secret only', async () => {
  const { ticketProvider, WebhookSignatureError } = await import('../lib/payments/index.js');
  const p = ticketProvider();
  assert.equal(p.name, 'superprofile_link');
  await assert.rejects(() => p.refund(), (e) => e.code === 'NOT_SUPPORTED_IN_APP' && e.status === 501);
  assert.throws(() => p.verifyWebhook({}), WebhookSignatureError);
  assert.throws(() => p.verifyWebhook({ 'x-webhook-secret': SECRET.slice(0, -1) }), WebhookSignatureError);
  assert.equal(p.verifyWebhook({ 'x-webhook-secret': SECRET }), true);
  const co = await p.createCheckout({ url: SP_URL, ref: 'ABCD2345', slug: 'x' });
  assert.equal(new URL(co.checkoutUrl).searchParams.get('ref'), 'ABCD2345');
  await assert.rejects(() => p.createCheckout({ url: 'https://evil.com/x', ref: 'ABCD2345', slug: 'x' }));
});
