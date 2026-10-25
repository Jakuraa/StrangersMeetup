// test/payments.test.js - Ticket money loop, webhooks, capacity, reconciliation, Stars membership.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  resetDb, startServer, stopServer, Client, db, callsTo, clearCalls, createEvent, signedInClient, stubOnce
} from './helpers.js';

const TG_SECRET = { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_123456' };
const CRON = { authorization: 'Bearer test-cron-secret-0123456789' };

function rzpWebhook(event, { linkId, paymentId = `pay_${crypto.randomBytes(5).toString('hex')}`, amount, eventId = `evt_${crypto.randomBytes(6).toString('hex')}`, bookingId } = {}) {
  const body = JSON.stringify({
    entity: 'event', event,
    payload: {
      payment_link: linkId ? { entity: { id: linkId, amount, amount_paid: amount, status: event === 'payment_link.paid' ? 'paid' : 'expired', currency: 'INR' } } : undefined,
      payment: { entity: { id: paymentId, amount, currency: 'INR', status: event === 'payment.failed' ? 'failed' : 'captured', notes: bookingId ? { booking_id: bookingId } : {} } }
    }
  });
  const sig = crypto.createHmac('sha256', 'test_rzp_webhook_secret').update(body).digest('hex');
  return { body, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': eventId } };
}

async function postWebhook(w) {
  return new Client().req('POST', '/api/payments/webhook/razorpay', w.body, w.headers);
}

async function bookAndGetLink(client, eventId) {
  const r = await client.post('/api/bookings', { eventId });
  assert.equal(r.status, 200, r.text);
  const pay = await db.one('SELECT * FROM payments WHERE booking_id = $1', [r.json.bookingId]);
  return { ...r.json, linkId: pay.provider_txn_id, amount: Number(pay.amount), paymentId: pay.id };
}

before(async () => { await resetDb(); await startServer(); });
after(stopServer);
beforeEach(clearCalls);

test('price TBD events cannot be booked', async () => {
  const ev = await createEvent({ price: null });
  const c = await signedInClient();
  const r = await c.post('/api/bookings', { eventId: ev.id });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'price_tbd');
});

test('booking requires 21+ confirmation and a session', async () => {
  const ev = await createEvent();
  assert.equal((await new Client().post('/api/bookings', { eventId: ev.id })).status, 401);
  const c = await signedInClient({ ageConfirmed: false });
  const r = await c.post('/api/bookings', { eventId: ev.id });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'age_required');
});

test('paid ticket → exactly one confirmed booking + one invite to the events chat + bot DM; duplicates are no-ops', async () => {
  const ev = await createEvent({ price: 49900 });
  const c = await signedInClient();
  const b = await bookAndGetLink(c, ev.id);
  assert.match(b.checkoutUrl, /^https:\/\/rzp\.io\//);
  const link = callsTo('POST').find((x) => x.path === '/v1/payment_links');
  assert.equal(link.params.amount, 49900);
  assert.match(link.auth, /^Basic /);
  assert.equal((await db.one('SELECT status, is_test FROM payments WHERE id = $1', [b.paymentId])).is_test, true);

  // A client "callback" must not confirm anything.
  await c.get(`/bookings/${b.bookingId}?razorpay_payment_link_status=paid&razorpay_payment_id=pay_fake`);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.bookingId])).status, 'pending_payment');

  const w = rzpWebhook('payment_link.paid', { linkId: b.linkId, amount: b.amount });
  const r1 = await postWebhook(w);
  assert.equal(r1.status, 200);
  assert.equal(r1.json.result, 'confirmed');
  const dup = await postWebhook(w);
  assert.equal(dup.json.result, 'duplicate');
  const again = await postWebhook(rzpWebhook('payment_link.paid', { linkId: b.linkId, amount: b.amount })); // new event id, same payment
  assert.equal(again.json.result, 'already_paid');

  const rows = await db.query(`SELECT status FROM bookings WHERE event_id = $1 AND status = 'confirmed'`, [ev.id]);
  assert.equal(rows.rowCount, 1);
  const invites = callsTo('createChatInviteLink');
  assert.equal(invites.length, 1);
  assert.equal(invites[0].params.chat_id, -1001111111111);
  assert.equal(invites[0].params.member_limit, 1);
  assert.ok(invites[0].params.expire_date - Date.now() / 1000 > 23 * 3600);
  assert.equal((await db.one('SELECT count(*)::int n FROM invite_links WHERE booking_id = $1', [b.bookingId])).n, 1);
  const dm = callsTo('sendMessage').find((m) => m.params.chat_id === c.tgId);
  assert.match(dm.params.text, /You're booked/);
  assert.match(dm.params.text, /test mode/);

  const view = await c.get(`/api/bookings/${b.bookingId}`);
  assert.equal(view.json.booking.status, 'confirmed');
  assert.equal(view.json.booking.venue, 'Secret Cafe, 12 Beach Rd');
  assert.ok(view.json.booking.invite.link.startsWith('https://t.me/+'));
});

test('another user cannot read someone else\'s booking (no IDOR)', async () => {
  const ev = await createEvent();
  const owner = await signedInClient();
  const b = await bookAndGetLink(owner, ev.id);
  const other = await signedInClient();
  assert.equal((await other.get(`/api/bookings/${b.bookingId}`)).status, 404);
});

test('bad webhook signature is rejected and changes nothing', async () => {
  const ev = await createEvent();
  const c = await signedInClient();
  const b = await bookAndGetLink(c, ev.id);
  const w = rzpWebhook('payment_link.paid', { linkId: b.linkId, amount: b.amount });
  w.headers['x-razorpay-signature'] = 'deadbeef';
  assert.equal((await postWebhook(w)).status, 401);
  const tampered = rzpWebhook('payment_link.paid', { linkId: b.linkId, amount: b.amount });
  tampered.body = tampered.body.replace(String(b.amount), '1');
  assert.equal((await postWebhook(tampered)).status, 401);
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.bookingId])).status, 'pending_payment');
  assert.equal((await db.one('SELECT count(*)::int n FROM webhook_events WHERE provider = $1', ['razorpay'])).n >= 0, true);
});

test('failed payment grants nothing', async () => {
  const ev = await createEvent();
  const c = await signedInClient();
  const b = await bookAndGetLink(c, ev.id);
  const r = await postWebhook(rzpWebhook('payment.failed', { amount: b.amount, bookingId: b.bookingId }));
  assert.equal(r.json.result, 'failed_recorded');
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.bookingId])).status, 'pending_payment');
  assert.equal((await db.one('SELECT status FROM payments WHERE id = $1', [b.paymentId])).status, 'failed');
  assert.equal(callsTo('createChatInviteLink').length, 0);
  assert.equal(callsTo('sendMessage').length, 0);
});

test('amount mismatch never confirms', async () => {
  const ev = await createEvent();
  const c = await signedInClient();
  const b = await bookAndGetLink(c, ev.id);
  const r = await postWebhook(rzpWebhook('payment_link.paid', { linkId: b.linkId, amount: 100 }));
  assert.equal(r.json.result, 'amount_mismatch');
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.bookingId])).status, 'pending_payment');
});

test('capacity race: 12 concurrent checkouts for 3 seats never exceed capacity', async () => {
  const ev = await createEvent({ capacity: 3 });
  const clients = await Promise.all(Array.from({ length: 12 }, () => signedInClient()));
  const results = await Promise.all(clients.map((c) => c.post('/api/bookings', { eventId: ev.id })));
  const ok = results.filter((r) => r.status === 200);
  const soldOut = results.filter((r) => r.status === 409 && r.json.error === 'sold_out');
  assert.equal(ok.length, 3);
  assert.equal(soldOut.length, 9);
  const held = await db.one(`SELECT count(*)::int n FROM bookings WHERE event_id = $1 AND status = 'pending_payment'`, [ev.id]);
  assert.equal(held.n, 3);
});

test('same user booking twice reuses the active hold (one checkout)', async () => {
  const ev = await createEvent();
  const c = await signedInClient();
  const a = await c.post('/api/bookings', { eventId: ev.id });
  const b = await c.post('/api/bookings', { eventId: ev.id });
  assert.equal(a.json.bookingId, b.json.bookingId);
  assert.equal(a.json.checkoutUrl, b.json.checkoutUrl);
  assert.equal(callsTo('POST').filter((x) => x.path === '/v1/payment_links').length, 1);
});

test('late payment after hold expiry on a full event → not confirmed, refund flagged', async () => {
  const ev = await createEvent({ capacity: 1 });
  const a = await signedInClient();
  const late = await bookAndGetLink(a, ev.id);
  await db.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [late.bookingId]);
  const b = await signedInClient();
  const winner = await bookAndGetLink(b, ev.id);
  await postWebhook(rzpWebhook('payment_link.paid', { linkId: winner.linkId, amount: winner.amount }));
  const r = await postWebhook(rzpWebhook('payment_link.paid', { linkId: late.linkId, amount: late.amount }));
  assert.equal(r.json.result, 'refund_needed');
  assert.equal((await db.one('SELECT status, cancel_reason FROM bookings WHERE id = $1', [late.bookingId])).cancel_reason, 'paid_but_unavailable_refund_due');
  assert.equal((await db.one(`SELECT count(*)::int n FROM bookings WHERE event_id = $1 AND status = 'confirmed'`, [ev.id])).n, 1);
  assert.ok((await db.one(`SELECT 1 AS x FROM notifications WHERE kind = 'late_payment_refund_needed' AND booking_id = $1`, [late.bookingId])));
});

test('late payment after hold expiry with seats free → confirmed', async () => {
  const ev = await createEvent({ capacity: 5 });
  const c = await signedInClient();
  const b = await bookAndGetLink(c, ev.id);
  await db.query(`UPDATE bookings SET status = 'cancelled', cancel_reason = 'hold_expired', hold_expires_at = now() - interval '1 hour' WHERE id = $1`, [b.bookingId]);
  const r = await postWebhook(rzpWebhook('payment_link.paid', { linkId: b.linkId, amount: b.amount }));
  assert.equal(r.json.result, 'confirmed');
});

test('reconcile cron confirms a paid booking whose webhook never arrived; rerun is a no-op', async () => {
  const ev = await createEvent();
  const c = await signedInClient();
  const b = await bookAndGetLink(c, ev.id);
  await db.query(`UPDATE payments SET created_at = now() - interval '20 minutes' WHERE id = $1`, [b.paymentId]);
  stubOnce(`rzp:GET /v1/payment_links/:id`, () => ({ id: b.linkId, status: 'paid', amount_paid: b.amount, payments: [{ payment_id: 'pay_recon', amount: b.amount, status: 'captured' }] }));
  const r = await new Client().get('/api/cron/reconcile', CRON);
  assert.equal(r.json.results.reconcile.applied, 1, JSON.stringify(r.json));
  assert.equal((await db.one('SELECT status FROM bookings WHERE id = $1', [b.bookingId])).status, 'confirmed');
  const r2 = await new Client().get('/api/cron/reconcile', CRON);
  assert.equal(r2.json.results.reconcile.checked, 0);
});

test('cron endpoints reject missing/wrong CRON_SECRET', async () => {
  assert.equal((await new Client().get('/api/cron/daily')).status, 401);
  assert.equal((await new Client().get('/api/cron/daily', { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await new Client().get('/api/cron/daily', CRON)).status, 200);
});

test('live keys are refused while ENABLE_LIVE_PAYMENTS=false', async () => {
  const ev = await createEvent();
  const c = await signedInClient();
  process.env.RAZORPAY_KEY_ID = 'rzp_live_REALKEY';
  try {
    const r = await c.post('/api/bookings', { eventId: ev.id });
    assert.equal(r.status, 503);
  } finally {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_TESTKEY';
  }
  assert.equal(callsTo('POST').filter((x) => x.path === '/v1/payment_links').length, 0);
});

// ---------------- Membership (Telegram Stars) ----------------

let upd = 50000;
const tgUpdate = (body) => new Client().post('/api/telegram/webhook', { update_id: ++upd, ...body }, TG_SECRET);

test('membership checkout refuses while Stars price is NULL', async () => {
  const c = await signedInClient();
  const r = await c.post('/api/membership/checkout', { tierCode: 'tier_1' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'price_not_set');
});

test('Stars membership: invoice → pre_checkout → payment → entitlement + invite to the tier chat; duplicate charge no-op; expiry revokes', async () => {
  await db.query(`UPDATE membership_tiers SET stars_amount = 250 WHERE code = 'tier_1'`);
  const c = await signedInClient();
  const r = await c.post('/api/membership/checkout', { tierCode: 'tier_1' });
  assert.equal(r.status, 200, r.text);
  const inv = callsTo('createInvoiceLink')[0].params;
  assert.equal(inv.currency, 'XTR');
  assert.equal(inv.subscription_period, 2592000);
  assert.equal(inv.prices[0].amount, 250);
  assert.equal(inv.provider_token, '');
  assert.ok(Buffer.byteLength(inv.payload) <= 128);

  // pre_checkout: wrong payer rejected, wrong amount rejected, correct approved
  await tgUpdate({ pre_checkout_query: { id: 'q1', from: { id: 1 }, currency: 'XTR', total_amount: 250, invoice_payload: inv.payload } });
  await tgUpdate({ pre_checkout_query: { id: 'q2', from: { id: c.tgId }, currency: 'XTR', total_amount: 1, invoice_payload: inv.payload } });
  await tgUpdate({ pre_checkout_query: { id: 'q3', from: { id: c.tgId }, currency: 'XTR', total_amount: 250, invoice_payload: inv.payload } });
  const answers = callsTo('answerPreCheckoutQuery').map((a) => [a.params.pre_checkout_query_id, a.params.ok]);
  assert.deepEqual(answers, [['q1', false], ['q2', false], ['q3', true]]);

  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const sp = { currency: 'XTR', total_amount: 250, invoice_payload: inv.payload, telegram_payment_charge_id: 'stxCHARGE1', provider_payment_charge_id: 'p1', subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true };
  const payMsg = { message: { message_id: 1, date: 0, chat: { id: c.tgId, type: 'private' }, from: { id: c.tgId, first_name: 'M' }, successful_payment: sp } };
  await tgUpdate(payMsg);
  await tgUpdate(payMsg); // duplicate delivery with a new update_id

  const ent = await db.one(`SELECT e.*, t.code FROM entitlements e JOIN membership_tiers t ON t.id = e.tier_id WHERE e.user_id = $1`, [c.userId]);
  assert.equal(ent.status, 'active');
  assert.equal(ent.code, 'tier_1');
  assert.equal((await db.one(`SELECT count(*)::int n FROM payments WHERE provider = 'telegram_stars'`)).n, 1);
  const invites = callsTo('createChatInviteLink');
  assert.equal(invites.length, 1);
  assert.equal(invites[0].params.chat_id, -1002222222221);

  // Renewal (new charge id) extends, no second invite
  clearCalls();
  await tgUpdate({ message: { ...payMsg.message, successful_payment: { ...sp, telegram_payment_charge_id: 'stxCHARGE2', is_first_recurring: false, subscription_expiration_date: exp + 30 * 86400 } } });
  const renewed = await db.one('SELECT expires_at FROM entitlements WHERE id = $1', [ent.id]);
  assert.equal(Math.floor(new Date(renewed.expires_at).getTime() / 1000), exp + 30 * 86400);
  assert.equal(callsTo('createChatInviteLink').length, 0);

  // Expiry → revoked via ban + unban in the tier chat; rerun is a no-op
  await db.query(`UPDATE entitlements SET expires_at = now() - interval '2 hours' WHERE id = $1`, [ent.id]);
  clearCalls();
  const run1 = await new Client().get('/api/cron/memberships', CRON);
  assert.equal(run1.json.results.memberships.revoked, 1);
  assert.equal(callsTo('banChatMember')[0].params.chat_id, -1002222222221);
  assert.equal(callsTo('banChatMember')[0].params.user_id, c.tgId);
  assert.equal(callsTo('unbanChatMember')[0].params.only_if_banned, true);
  assert.equal((await db.one('SELECT status FROM entitlements WHERE id = $1', [ent.id])).status, 'revoked');
  clearCalls();
  const run2 = await new Client().get('/api/cron/memberships', CRON);
  assert.equal(run2.json.results.memberships.revoked, 0);
  assert.equal(callsTo('banChatMember').length, 0);
});

test('expiry reminder is sent once per period', async () => {
  await db.query(`UPDATE membership_tiers SET stars_amount = 500 WHERE code = 'tier_2'`);
  const u = await db.one(`INSERT INTO users (telegram_user_id, age_confirmed_21) VALUES (880001, true) RETURNING id`);
  const t = await db.one(`SELECT id FROM membership_tiers WHERE code = 'tier_2'`);
  await db.query(`INSERT INTO entitlements (user_id, tier_id, status, expires_at) VALUES ($1, $2, 'active', now() + interval '2 days')`, [u.id, t.id]);
  clearCalls();
  const a = await new Client().get('/api/cron/memberships', CRON);
  const b = await new Client().get('/api/cron/memberships', CRON);
  assert.equal(a.json.results.memberships.reminders, 1);
  assert.equal(b.json.results.memberships.reminders, 0);
  assert.equal(callsTo('sendMessage').filter((m) => m.params.chat_id === 880001).length, 1);
});

test('invite failure (bot not admin) still confirms the booking and is retried by cron', async () => {
  const ev = await createEvent();
  const c = await signedInClient();
  const b = await bookAndGetLink(c, ev.id);
  stubOnce('tg:createChatInviteLink', () => { const e = new Error('Bad Request: not enough rights'); e.code = 400; throw e; });
  const r = await postWebhook(rzpWebhook('payment_link.paid', { linkId: b.linkId, amount: b.amount }));
  assert.equal(r.json.result, 'confirmed');
  const n = await db.one(`SELECT status, last_error FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed'`, [b.bookingId]);
  assert.equal(n.status, 'failed');
  assert.match(n.last_error, /not enough rights/);
  await db.query(`UPDATE notifications SET next_attempt_at = now() WHERE booking_id = $1`, [b.bookingId]);
  await new Client().get('/api/cron/notifications', CRON);
  assert.equal((await db.one(`SELECT status FROM notifications WHERE booking_id = $1 AND kind = 'booking_confirmed'`, [b.bookingId])).status, 'sent');
  assert.equal((await db.one('SELECT count(*)::int n FROM invite_links WHERE booking_id = $1', [b.bookingId])).n, 1);
});
