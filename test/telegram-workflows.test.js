// test/telegram-workflows.test.js - Milestone M5: Telegram identity, event community isolation,
// operational notifications, quiet hours, safety reporting, and recovery workflows.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  resetDb, startServer, stopServer, Client, db, callsTo, clearCalls,
  createEvent, signedInClient
} from './helpers.js';
import { inviteForBooking, revokeBookingInvites, activeInvite } from '../lib/services/invites.js';
import { enqueue, deliver, isQuietHours, quietHoursNextAttempt } from '../lib/services/notifications.js';
import { createAccountLinkToken, redeemAccountLinkToken, getAccountLinkStatus } from '../lib/services/users.js';

const SECRET = { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_123456' };
let seq = 8000;
const msg = (from, text, extra = {}) => ({
  update_id: ++seq,
  message: { message_id: seq, date: 0, chat: { id: from.id, type: 'private' }, from, text, ...extra }
});

before(async () => {
  await resetDb();
  await startServer();
});
after(stopServer);
beforeEach(clearCalls);

// =========================================================================
// 1. Telegram Identity & Account Linking
// =========================================================================

test('account linking: generates link token and status endpoint tracks state', async () => {
  const userClient = await signedInClient({ ageConfirmed: true });
  const res = await userClient.post('/api/auth/telegram/link-token', {});
  assert.equal(res.status, 200);
  assert.ok(res.json.token);
  assert.match(res.json.linkUrl, /start=link_/);

  const statusBefore = await userClient.get(`/api/auth/telegram/link-status?token=${res.json.token}`);
  assert.equal(statusBefore.status, 200);
  assert.equal(statusBefore.json.linked, false);
  assert.equal(statusBefore.json.expired, false);
});

test('account linking: redeeming token via Telegram /start link_<token> links web user', async () => {
  const userClient = await signedInClient({ ageConfirmed: true });
  const gen = await userClient.post('/api/auth/telegram/link-token', {});
  const token = gen.json.token;

  const tgSender = { id: 7001, first_name: 'Ananya', username: 'ananya_blr' };
  const c = new Client();
  const update = msg(tgSender, `/start link_${token}`);
  const r = await c.post('/api/telegram/webhook', update, SECRET);
  assert.equal(r.status, 200);

  const reply = callsTo('sendMessage').find((m) => m.params.chat_id === 7001);
  assert.match(reply.params.text, /securely linked to Telegram/);

  // Status should now be linked
  const statusAfter = await userClient.get(`/api/auth/telegram/link-status?token=${token}`);
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.json.linked, true);
  assert.equal(statusAfter.json.telegramUserId, 7001);

  // Identity should exist in user_identities
  const identity = await db.one(
    `SELECT * FROM user_identities WHERE user_id = $1 AND provider = 'telegram' AND subject = '7001'`,
    [userClient.userId]
  );
  assert.equal(identity.subject, '7001');

  // Re-using the same link token must fail
  clearCalls();
  const reuseUpdate = msg(tgSender, `/start link_${token}`);
  await c.post('/api/telegram/webhook', reuseUpdate, SECRET);
  const reuseReply = callsTo('sendMessage').find((m) => m.params.chat_id === 7001);
  assert.match(reuseReply.params.text, /invalid or has expired/);
});

test('account linking: expired link token is rejected', async () => {
  const expiredToken = crypto.randomBytes(24).toString('base64url');
  await db.query(
    `INSERT INTO account_link_tokens (token, expires_at) VALUES ($1, now() - interval '5 minutes')`,
    [expiredToken]
  );

  const tgSender = { id: 7002, first_name: 'Vikram' };
  const c = new Client();
  await c.post('/api/telegram/webhook', msg(tgSender, `/start link_${expiredToken}`), SECRET);
  const reply = callsTo('sendMessage').find((m) => m.params.chat_id === 7002);
  assert.match(reply.params.text, /invalid or has expired/);
});

// =========================================================================
// 2. Event Community Isolation & No Global Attendee Group
// =========================================================================

test('event community isolation: separate private groups per event; no global shared group', async () => {
  const user = await db.one(`INSERT INTO users (telegram_user_id) VALUES (7101) RETURNING id`);

  // Event A with its own private group
  const eventA = await createEvent({ telegram_chat_id: -1001234500001, title: 'Event A Mixer' });
  // Event B with its own private group
  const eventB = await createEvent({ telegram_chat_id: -1001234500002, title: 'Event B Party' });
  // Event C without an assigned Telegram chat
  const eventC = await createEvent({ telegram_chat_id: null, title: 'Event C Dinner' });

  const bookingA = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [eventA.id, user.id]
  );
  const bookingB = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [eventB.id, user.id]
  );
  const bookingC = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [eventC.id, user.id]
  );

  const inviteA = await inviteForBooking(bookingA.id);
  const inviteB = await inviteForBooking(bookingB.id);
  const inviteC = await inviteForBooking(bookingC.id);

  assert.ok(inviteA, 'Event A should generate invite');
  assert.ok(inviteB, 'Event B should generate invite');
  assert.equal(inviteC, null, 'Event C without dedicated chat must return null (no fallback to global chat)');

  // Verify invite links were created for separate chat IDs
  const createdInvites = callsTo('createChatInviteLink');
  assert.equal(createdInvites.length, 2);
  assert.equal(createdInvites[0].params.chat_id, -1001234500001);
  assert.equal(createdInvites[1].params.chat_id, -1001234500002);
});

test('unconfirmed booking receives no invite link', async () => {
  const user = await db.one(`INSERT INTO users (telegram_user_id) VALUES (7102) RETURNING id`);
  const ev = await createEvent({ telegram_chat_id: -1001234500003 });

  // Pending payment
  const pendingBooking = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'pending_payment') RETURNING id`,
    [ev.id, user.id]
  );
  assert.equal(await inviteForBooking(pendingBooking.id), null);

  // Cancelled booking
  const cancelledBooking = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'cancelled') RETURNING id`,
    [ev.id, user.id]
  );
  assert.equal(await inviteForBooking(cancelledBooking.id), null);
});

test('invite link reuse and duplicate protection', async () => {
  const user = await db.one(`INSERT INTO users (telegram_user_id) VALUES (7103) RETURNING id`);
  const ev = await createEvent({ telegram_chat_id: -1001234500004 });
  const b = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [ev.id, user.id]
  );

  const inv1 = await inviteForBooking(b.id);
  const inv2 = await inviteForBooking(b.id);
  assert.equal(inv1.link, inv2.link, 'Repeated call must reuse existing active invite link');
  assert.equal(callsTo('createChatInviteLink').length, 1, 'Only one API call to Telegram');
});

test('revoking booking invites on refund/cancellation', async () => {
  const user = await db.one(`INSERT INTO users (telegram_user_id) VALUES (7104) RETURNING id`);
  const ev = await createEvent({ telegram_chat_id: -1001234500005 });
  const b = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [ev.id, user.id]
  );

  const inv = await inviteForBooking(b.id);
  assert.ok(inv);

  const activeBefore = await activeInvite({ bookingId: b.id });
  assert.ok(activeBefore);

  await revokeBookingInvites(b.id);

  const activeAfter = await activeInvite({ bookingId: b.id });
  assert.equal(activeAfter, null, 'Revoked invite must no longer be active');
});

// =========================================================================
// 3. Operational Notifications & Quiet Hours
// =========================================================================

test('quiet hours calculation: correctly detects IST time window and midnight crossing', () => {
  const user = {
    quiet_hours_enabled: true,
    quiet_hours_start: '23:00',
    quiet_hours_end: '08:00'
  };

  // 23:30 IST -> in quiet hours (18:00 UTC)
  const d1 = new Date('2026-11-05T18:00:00Z');
  assert.equal(isQuietHours(user, d1), true);

  // 05:00 IST -> in quiet hours (23:30 UTC previous day)
  const d2 = new Date('2026-11-05T23:30:00Z');
  assert.equal(isQuietHours(user, d2), true);

  // 14:00 IST -> outside quiet hours (08:30 UTC)
  const d3 = new Date('2026-11-05T08:30:00Z');
  assert.equal(isQuietHours(user, d3), false);

  // Quiet hours disabled
  assert.equal(isQuietHours({ quiet_hours_enabled: false }, d1), false);
});

test('quiet hours delivery deferral for non-urgent notifications vs immediate urgent delivery', async () => {
  const user = await db.one(
    `INSERT INTO users (telegram_user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
     VALUES (7201, true, '00:00', '23:59') RETURNING id`
  );
  const ev = await createEvent();
  const b = await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [ev.id, user.id]
  );

  // 1. Non-urgent notification (event_reminder) during quiet hours is deferred
  const notifId = await enqueue(db, {
    kind: 'event_reminder',
    userId: user.id,
    bookingId: b.id,
    dedupeKey: `er:test:${Date.now()}`
  });

  const res1 = await deliver(notifId);
  assert.equal(res1, 'deferred_quiet_hours');
  assert.equal(callsTo('sendMessage').length, 0);

  // 2. Urgent notification (booking_confirmed) delivers immediately despite quiet hours
  const urgentId = await enqueue(db, {
    kind: 'booking_confirmed',
    userId: user.id,
    bookingId: b.id,
    dedupeKey: `bc:test:${Date.now()}`
  });

  const res2 = await deliver(urgentId);
  assert.equal(res2, 'sent');
  assert.equal(callsTo('sendMessage').length, 1);
});

test('notification preferences API: user can view and update quiet hours and reminders', async () => {
  const c = await signedInClient({ ageConfirmed: true });

  const get1 = await c.get('/api/me/notification-preferences');
  assert.equal(get1.status, 200);
  assert.equal(get1.json.preferences.reminders_enabled, true);

  const update = await c.req('PATCH', '/api/me/notification-preferences', {
    quietHoursEnabled: true,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    remindersEnabled: true
  });
  assert.equal(update.status, 200);
  assert.equal(update.json.preferences.quiet_hours_enabled, true);
  assert.equal(update.json.preferences.quiet_hours_start, '22:00:00');
  assert.equal(update.json.preferences.quiet_hours_end, '07:00:00');
});

// =========================================================================
// 4. Safety & Support Workflows
// =========================================================================

test('Telegram /report: validates body, rate limits, and provides emergency contacts', async () => {
  const c = new Client();
  const tgUser = { id: 7301, first_name: 'Tara' };

  // 1. Empty /report returns instructions and emergency 112 info
  await c.post('/api/telegram/webhook', msg(tgUser, '/report'), SECRET);
  let reply = callsTo('sendMessage').pop().params.text;
  assert.match(reply, /call 112/);
  assert.match(reply, /1091/);

  // 2. Overly short report (<10 chars) prompts for more details
  clearCalls();
  await c.post('/api/telegram/webhook', msg(tgUser, '/report short'), SECRET);
  reply = callsTo('sendMessage').pop().params.text;
  assert.match(reply, /at least 10 characters/);

  // 3. Valid report stores in database with category safety_concern and status new
  clearCalls();
  await c.post('/api/telegram/webhook', msg(tgUser, '/report Indiranagar event: someone was harassing guests near the exit'), SECRET);
  reply = callsTo('sendMessage').pop().params.text;
  assert.match(reply, /recorded and a NIGHTLIFEZ moderator will review it/);

  const reportRow = await db.one(`SELECT category, body, status FROM reports WHERE body LIKE '%harassing%'`);
  assert.equal(reportRow.category, 'safety_concern');
  assert.equal(reportRow.status, 'new');
});

test('Telegram /quiet_hours command toggles and configures notification window', async () => {
  const c = new Client();
  const tgUser = { id: 7302, first_name: 'Rahul' };

  // View status
  await c.post('/api/telegram/webhook', msg(tgUser, '/quiet_hours'), SECRET);
  let reply = callsTo('sendMessage').pop().params.text;
  assert.match(reply, /Quiet Hours Settings/);

  // Enable
  clearCalls();
  await c.post('/api/telegram/webhook', msg(tgUser, '/quiet_hours on'), SECRET);
  reply = callsTo('sendMessage').pop().params.text;
  assert.match(reply, /Quiet hours enabled/);

  // Set custom hours
  clearCalls();
  await c.post('/api/telegram/webhook', msg(tgUser, '/quiet_hours 22:30 07:30'), SECRET);
  reply = callsTo('sendMessage').pop().params.text;
  assert.match(reply, /22:30/);
  assert.match(reply, /07:30/);

  // Disable
  clearCalls();
  await c.post('/api/telegram/webhook', msg(tgUser, '/quiet_hours off'), SECRET);
  reply = callsTo('sendMessage').pop().params.text;
  assert.match(reply, /Quiet hours disabled/);
});

// =========================================================================
// 5. Operational Recovery & Unreachable User Handling
// =========================================================================

test('operational recovery: /start delivers pending invite to previously unreachable user', async () => {
  const user = await db.one(`INSERT INTO users (telegram_user_id) VALUES (7401) RETURNING id`);
  const ev = await createEvent({ telegram_chat_id: -1001234500009, title: 'Bangalore Rooftop Party' });

  // Confirmed booking exists, but user never received the invite (e.g. booked on web before starting bot)
  await db.one(
    `INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`,
    [ev.id, user.id]
  );

  const c = new Client();
  const tgUser = { id: 7401, first_name: 'Dev' };
  await c.post('/api/telegram/webhook', msg(tgUser, '/start'), SECRET);

  const reply = callsTo('sendMessage').find((m) => m.params.chat_id === 7401);
  assert.match(reply.params.text, /Bangalore Rooftop Party/);
  assert.match(reply.params.text, /private group invite/);
  assert.ok(reply.params.reply_markup.inline_keyboard[0][0].url.startsWith('https://t.me/+test'));
});

test('operational recovery: /start claim_upi_<orderId>_<guestToken> claims guest payment', async () => {
  const ev = await createEvent({ telegram_chat_id: -1001234500010, title: 'Kochi Yacht Mixer' });
  const orderId = `UPI${Date.now()}`;
  const guestToken = crypto.randomBytes(24).toString('base64url');

  // Insert guest payment row (user_id is NULL) with status 'succeeded'
  const pay = await db.one(
    `INSERT INTO payments (provider, provider_txn_id, order_id, merchant_id, purpose, user_id, amount, currency, status, raw_ref)
     VALUES ('phonepe', $1, $2, 'MERCHANT_TEST', 'ticket', NULL, 99900, 'INR', 'succeeded', $3)
     RETURNING id`,
    [`TXN_${Date.now()}`, orderId, JSON.stringify({ eventId: ev.id, qty: 1, guestToken })]
  );

  const c = new Client();
  const tgUser = { id: 7402, first_name: 'Pooja' };
  const r = await c.post('/api/telegram/webhook', msg(tgUser, `/start claim_upi_${orderId}_${guestToken}`), SECRET);
  assert.equal(r.status, 200);

  const reply = callsTo('sendMessage').find((m) => m.params.chat_id === 7402);
  assert.match(reply.params.text, /Booking claimed successfully/);
  assert.match(reply.params.text, /Kochi Yacht Mixer/);

  // Booking should now be confirmed and attached to user
  const updatedPay = await db.one('SELECT user_id, booking_id FROM payments WHERE id = $1', [pay.id]);
  assert.ok(updatedPay.user_id);
  assert.ok(updatedPay.booking_id);
  const booking = await db.one('SELECT * FROM bookings WHERE id = $1', [updatedPay.booking_id]);
  assert.equal(booking.status, 'confirmed');
});

test('operational notification handlers: event_update, host_application_received, host_approved', async () => {
  const host = await db.one(`INSERT INTO users (telegram_user_id) VALUES (7501) RETURNING id`);
  const attendee = await db.one(`INSERT INTO users (telegram_user_id) VALUES (7502) RETURNING id`);
  const ev = await createEvent({ telegram_chat_id: -1001234500011, title: 'Chennai Pub Crawl' });
  const b = await db.one(`INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`, [ev.id, attendee.id]);

  // 1. event_update
  const updateNotifId = await enqueue(db, {
    kind: 'event_update',
    bookingId: b.id,
    dedupeKey: `eu:${ev.id}:${attendee.id}:venue_change`
  });
  await deliver(updateNotifId);
  let sent = callsTo('sendMessage').pop();
  assert.equal(sent.params.chat_id, 7502);
  assert.match(sent.params.text, /Event Update: Chennai Pub Crawl/);

  // 2. host_approved
  clearCalls();
  const hostApprovedNotifId = await enqueue(db, {
    kind: 'host_approved',
    userId: host.id,
    dedupeKey: `ha:${host.id}`
  });
  await deliver(hostApprovedNotifId);
  sent = callsTo('sendMessage').pop();
  assert.equal(sent.params.chat_id, 7501);
  assert.match(sent.params.text, /host application has been approved/);

  // 3. host_application_received (goes to admin bootstrap)
  clearCalls();
  const hostAppNotifId = await enqueue(db, {
    kind: 'host_application_received',
    dedupeKey: `har:${Date.now()}`
  });
  await deliver(hostAppNotifId);
  sent = callsTo('sendMessage').pop();
  assert.match(sent.params.text, /New host application submitted/);
});

test('webhook robustness: missing secret, bad JSON, invalid update_id, and duplicate replay', async () => {
  const c = new Client();

  // Missing secret -> 401
  assert.equal((await c.post('/api/telegram/webhook', { update_id: 9991 })).status, 401);

  // Wrong secret -> 401
  assert.equal((await c.post('/api/telegram/webhook', { update_id: 9992 }, { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 401);

  // Invalid JSON (using low-level request with bad body)
  const badJsonRes = await c.req('POST', '/api/telegram/webhook', 'not a json', {
    ...SECRET,
    'content-type': 'application/json'
  });
  assert.equal(badJsonRes.status, 400);

  // Missing update_id
  assert.equal((await c.post('/api/telegram/webhook', { message: {} }, SECRET)).status, 400);

  // Duplicate replay
  const validUpdate = msg({ id: 7601, first_name: 'Test' }, '/events');
  const r1 = await c.post('/api/telegram/webhook', validUpdate, SECRET);
  assert.equal(r1.status, 200);

  clearCalls();
  const r2 = await c.post('/api/telegram/webhook', validUpdate, SECRET);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.duplicate, true);
  assert.equal(callsTo('sendMessage').length, 0, 'Duplicate webhook replay must not trigger duplicate messages');
});
