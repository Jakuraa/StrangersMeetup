import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  dispatchNotification,
  updateDeliveryReceipt,
  handleOptOutKeyword,
  getNotificationTelemetry,
  getNotificationMessagesList,
  getSuppressionsList
} from '../lib/services/notification-dispatcher.js';
import { getWhatsAppProvider } from '../lib/services/whatsapp-provider.js';
import { recordConsent } from '../lib/services/communication-consent.js';

test.beforeEach(async () => {
  await resetDb();
  getWhatsAppProvider().clearSentMessages();
});

test('Notification Dispatcher - sends WhatsApp notification and logs in notification_messages', async () => {
  const phone = '+919876543210';
  const res = await dispatchNotification({
    recipient: phone,
    channel: 'whatsapp',
    purpose: 'transactional',
    templateName: 'booking_confirmed',
    templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Music Fest' }] }],
    idempotencyKey: 'test_dispatch_1'
  });

  assert.equal(res.status, 'sent');
  assert.equal(res.channel, 'whatsapp');
  assert.equal(res.recipient, phone);
  assert.ok(res.provider_message_id);
  assert.equal(res.delivery_cost_paise, 15);

  const sent = getWhatsAppProvider().getSentMessages();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, phone);
});

test('Notification Dispatcher - enforces deduplication via idempotencyKey', async () => {
  const phone = '+919876543210';
  const res1 = await dispatchNotification({
    recipient: phone,
    channel: 'whatsapp',
    purpose: 'transactional',
    templateName: 'booking_confirmed',
    idempotencyKey: 'dedupe_key_100'
  });

  const res2 = await dispatchNotification({
    recipient: phone,
    channel: 'whatsapp',
    purpose: 'transactional',
    templateName: 'booking_confirmed',
    idempotencyKey: 'dedupe_key_100'
  });

  assert.equal(res1.id, res2.id);
  assert.equal(getWhatsAppProvider().getSentMessages().length, 1);
});

test('Notification Dispatcher - respects suppression list', async () => {
  const phone = '+919876543210';
  await handleOptOutKeyword({ destination: phone, channel: 'whatsapp' });

  const res = await dispatchNotification({
    recipient: phone,
    channel: 'whatsapp',
    purpose: 'transactional',
    templateName: 'booking_confirmed',
    idempotencyKey: 'suppressed_test_1'
  });

  assert.equal(res.status, 'suppressed');
  assert.equal(res.provider, 'none');
  assert.equal(getWhatsAppProvider().getSentMessages().length, 0);
});

test('Notification Dispatcher - respects user communication consent', async () => {
  const user = (await db.query(`INSERT INTO users (phone, alias) VALUES ('+919876543211', 'Test User') RETURNING id`)).rows[0];

  // Record transactional consent: opted_in, promotional: opted_out
  await recordConsent({ userId: user.id, channel: 'whatsapp', purpose: 'transactional', status: 'opted_in' });
  await recordConsent({ userId: user.id, channel: 'whatsapp', purpose: 'promotional', status: 'opted_out' });

  // Promotional dispatch should fail due to no consent
  const promoRes = await dispatchNotification({
    userId: user.id,
    recipient: '+919876543211',
    channel: 'whatsapp',
    purpose: 'promotional',
    templateName: 'weekend_event_announcement',
    idempotencyKey: 'promo_no_consent_1'
  });

  assert.equal(promoRes.status, 'failed');
  assert.equal(promoRes.last_error, 'no_user_consent');
  assert.equal(getWhatsAppProvider().getSentMessages().length, 0);
});

test('Notification Dispatcher - updates delivery receipt on webhook event', async () => {
  const phone = '+919876543210';
  const sent = await dispatchNotification({
    recipient: phone,
    channel: 'whatsapp',
    purpose: 'transactional',
    templateName: 'booking_confirmed',
    idempotencyKey: 'receipt_test_1'
  });

  const updated = await updateDeliveryReceipt({
    providerMessageId: sent.provider_message_id,
    status: 'delivered'
  });

  assert.equal(updated.status, 'delivered');
  assert.ok(updated.delivered_at);
});

test('Notification Dispatcher - telemetry reports aggregated metrics and masked PII', async () => {
  const telemetry = await getNotificationTelemetry();
  assert.ok(telemetry.whatsapp);
  assert.equal(typeof telemetry.whatsapp.mode, 'string');
  assert.ok(telemetry.otp);
  assert.ok(telemetry.messages);
  assert.ok(telemetry.suppressions);

  const messages = await getNotificationMessagesList({ limit: 10 });
  assert.ok(Array.isArray(messages));
  if (messages.length > 0) {
    assert.ok(messages[0].recipientMasked.includes('****'));
  }
});
