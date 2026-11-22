// test/whatsapp-delivery-reliability.test.js - WhatsApp Delivery Reliability, Consent Gates, Retries & Pass Security
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, resetDb, Client, startServer, stopServer, signedInClient } from './helpers.js';
import { getWhatsAppProvider, setWhatsAppProvider, resetWhatsAppProvider } from '../lib/services/whatsapp-provider.js';
import { dispatchNotification, retryFailedNotificationMessages, updateDeliveryReceipt } from '../lib/services/notification-dispatcher.js';
import { recordConsent, addSuppression } from '../lib/services/communication-consent.js';
import { deliverDue, enqueue } from '../lib/services/notifications.js';

test.before(async () => {
  await resetDb();
  await startServer();
});

test.after(async () => {
  await stopServer();
  resetWhatsAppProvider();
  delete process.env.WHATSAPP_ENABLED;
  delete process.env.WHATSAPP_BOOKING_TEMPLATE_APPROVED;
});

test.beforeEach(async () => {
  resetWhatsAppProvider();
});

async function createUser(alias = 'wa_user', phone = '+919876543210') {
  return (await db.query(
    `INSERT INTO users (telegram_user_id, alias, phone, age_confirmed_21)
     VALUES ($1, $2, $3, true) RETURNING *`,
    [Math.floor(100000 + Math.random() * 900000), alias, phone]
  )).rows[0];
}

async function createConfirmedBooking(user) {
  const ev = (await db.query(
    `INSERT INTO events (slug, title, category, city, start_at, status, capacity, checkout_mode)
     VALUES ($1, 'Koramangala Underground', 'nightlife', 'Bengaluru', now() + interval '3 days', 'published', 50, 'free')
     RETURNING *`,
    [`event-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`]
  )).rows[0];

  const booking = (await db.query(
    `INSERT INTO bookings (event_id, user_id, status, payment_mode, amount_paise, admit_count)
     VALUES ($1, $2, 'confirmed', 'free', 0, 1) RETURNING *`,
    [ev.id, user.id]
  )).rows[0];

  return { ev, booking };
}

test('WhatsApp Consent Gate: Users who opted out of transactional notifications do NOT receive messages', async () => {
  const user = await createUser('opted_out_user', '+919111222333');
  // Record explicit opt-out for transactional WhatsApp
  await recordConsent({
    userId: user.id,
    channel: 'whatsapp',
    purpose: 'transactional',
    status: 'opted_out'
  });

  const { booking } = await createConfirmedBooking(user);

  // Enqueue booking_confirmed notification
  await enqueue(db, { kind: 'booking_confirmed', bookingId: booking.id, dedupeKey: `bk:${booking.id}` });
  await deliverDue();

  // 1. WhatsApp provider sent zero messages
  const sentWa = getWhatsAppProvider().getSentMessages();
  assert.equal(sentWa.length, 0, 'No WhatsApp message must be sent to opted-out recipient');

  // 2. Audit record in notification_messages records failed with no_user_consent
  const msgRow = (await db.query(
    `SELECT * FROM notification_messages WHERE user_id = $1 AND idempotency_key = $2`,
    [user.id, `wa:booking:${booking.id}`]
  )).rows[0];

  assert.ok(msgRow, 'Audit record must be logged');
  assert.equal(msgRow.status, 'failed');
  assert.equal(msgRow.last_error, 'no_user_consent');
});

test('WhatsApp Suppression Gate: Suppressed phone number is blocked from dispatch', async () => {
  const user = await createUser('suppressed_user', '+919998887776');
  await addSuppression({ channel: 'whatsapp', destination: user.phone, reason: 'stop_keyword' });

  const { booking } = await createConfirmedBooking(user);
  await enqueue(db, { kind: 'booking_confirmed', bookingId: booking.id, dedupeKey: `bk:${booking.id}` });
  await deliverDue();

  const sentWa = getWhatsAppProvider().getSentMessages();
  assert.equal(sentWa.length, 0, 'No WhatsApp message sent to suppressed destination');

  const msgRow = (await db.query(
    `SELECT * FROM notification_messages WHERE user_id = $1 AND idempotency_key = $2`,
    [user.id, `wa:booking:${booking.id}`]
  )).rows[0];

  assert.ok(msgRow);
  assert.equal(msgRow.status, 'suppressed');
});

test('WhatsApp Idempotent Deduplication: Duplicate booking confirmation calls never send duplicate WhatsApp messages', async () => {
  const user = await createUser('idempotent_user', '+919777666555');
  const { booking } = await createConfirmedBooking(user);

  await enqueue(db, { kind: 'booking_confirmed', bookingId: booking.id, dedupeKey: `bk:${booking.id}` });
  await deliverDue();

  // First dispatch: 1 message sent
  const sentWa1 = getWhatsAppProvider().getSentMessages();
  assert.equal(sentWa1.length, 1);

  // Second delivery attempt with same booking_confirmed
  await enqueue(db, { kind: 'booking_confirmed', bookingId: booking.id, dedupeKey: `bk:${booking.id}:dup` });
  await deliverDue();

  // Still exactly 1 message sent
  const sentWa2 = getWhatsAppProvider().getSentMessages();
  assert.equal(sentWa2.length, 1, 'Duplicate booking confirmation must be skipped via idempotencyKey');

  // Verify only 1 audit row in notification_messages
  const count = (await db.query(
    `SELECT COUNT(*)::int AS n FROM notification_messages WHERE idempotency_key = $1`,
    [`wa:booking:${booking.id}`]
  )).rows[0].n;
  assert.equal(count, 1);
});

test('Failure Isolation: WhatsApp failure NEVER cancels or reverses a confirmed booking or payment', async () => {
  const user = await createUser('fail_user', '+919444333222');
  const { booking } = await createConfirmedBooking(user);

  // Mock a failing WhatsApp provider
  const failingProvider = {
    async sendTemplate() {
      throw new Error('Meta Cloud API 500 internal server error');
    }
  };
  setWhatsAppProvider(failingProvider);

  await enqueue(db, { kind: 'booking_confirmed', bookingId: booking.id, dedupeKey: `bk:${booking.id}` });
  await deliverDue();

  // 1. Booking remains confirmed in DB
  const bookingRow = (await db.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id])).rows[0];
  assert.equal(bookingRow.status, 'confirmed', 'Booking must remain confirmed even if WhatsApp delivery fails');

  // 2. Notification message is marked failed with error details for retry
  const msgRow = (await db.query(
    `SELECT * FROM notification_messages WHERE idempotency_key = $1`,
    [`wa:booking:${booking.id}`]
  )).rows[0];
  assert.ok(msgRow);
  assert.equal(msgRow.status, 'failed');
  assert.match(msgRow.last_error, /Meta Cloud API 500/);

  // 3. Attendee can still retrieve booking pass from /api/bookings/:id
  resetWhatsAppProvider();
  const retried = await retryFailedNotificationMessages();
  assert.ok(retried.length > 0, 'Retry must pick up failed message');
  assert.equal(retried[0].status, 'sent', 'Retried message successfully sent');
});

test('Delivery Status Tracking: Webhook delivery receipt transitions status from sent to delivered', async () => {
  const user = await createUser('receipt_user', '+919555666777');
  const { booking } = await createConfirmedBooking(user);

  await enqueue(db, { kind: 'booking_confirmed', bookingId: booking.id, dedupeKey: `bk:${booking.id}` });
  await deliverDue();

  const msgRow = (await db.query(
    `SELECT * FROM notification_messages WHERE idempotency_key = $1`,
    [`wa:booking:${booking.id}`]
  )).rows[0];

  assert.equal(msgRow.status, 'sent', 'Initially status must be sent (not delivered)');
  assert.ok(msgRow.provider_message_id);

  // Simulate Meta Cloud API webhook delivery receipt callback
  const delivered = await updateDeliveryReceipt({
    providerMessageId: msgRow.provider_message_id,
    status: 'delivered',
    timestamp: new Date()
  });

  assert.ok(delivered);
  assert.equal(delivered.status, 'delivered', 'Status updated to delivered upon receipt');
  assert.ok(delivered.delivered_at, 'delivered_at timestamp recorded');
});

test('Pass URL Security: /bookings/:id requires authentication and rejects unauthorized visitors', async () => {
  const userA = await createUser('user_a', '+919888111222');
  const { booking } = await createConfirmedBooking(userA);

  const anon = new Client();
  // Unauthenticated visitor cannot view booking details via API
  const unauthRes = await anon.get(`/api/bookings/${booking.id}`);
  assert.equal(unauthRes.status, 401, 'Unauthenticated visitor gets 401');

  // Other attendee (User B) cannot view User A booking details
  const bClient = await signedInClient({ ageConfirmed: true });
  const otherRes = await bClient.get(`/api/bookings/${booking.id}`);
  assert.equal(otherRes.status, 404, 'User B querying User A booking gets 404');
});
