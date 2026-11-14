import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  getWhatsAppConfig,
  getWhatsAppProvider,
  StubWhatsAppProvider,
  MetaCloudWhatsAppProvider
} from '../lib/services/whatsapp-provider.js';

test('getWhatsAppConfig defaults safely when environment variables are not set', () => {
  const cfg = getWhatsAppConfig();
  assert.equal(typeof cfg.enabled, 'boolean');
  assert.equal(typeof cfg.isLive, 'boolean');
  // Unless explicitly configured, isLive is false
  assert.equal(cfg.isLive, false);
});

test('StubWhatsAppProvider captures sent OTP messages in memory', async () => {
  const stub = new StubWhatsAppProvider();
  stub.clearSentMessages();

  const res = await stub.sendOtpTemplate({
    to: '+919876543210',
    otp: '543210',
    language: 'en'
  });

  assert.equal(res.ok, true);
  assert.match(res.messageId, /^wamid\.mock_/);
  assert.equal(res.provider, 'mock');

  const sent = stub.getSentMessages();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+919876543210');
  assert.equal(sent[0].otp, '543210');

  stub.clearSentMessages();
  assert.equal(stub.getSentMessages().length, 0);
});

test('StubWhatsAppProvider verifies HMAC webhook signature', () => {
  const stub = new StubWhatsAppProvider();
  const rawBody = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET || 'test_whatsapp_webhook_secret';
  const validSig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const badSig = 'sha256=' + crypto.createHmac('sha256', 'wrong_secret').update(rawBody).digest('hex');

  assert.equal(stub.verifyWebhookSignature({ rawBody, signatureHeader: validSig }), true);
  assert.equal(stub.verifyWebhookSignature({ rawBody, signatureHeader: badSig }), false);
  assert.equal(stub.verifyWebhookSignature({ rawBody, signatureHeader: 'invalid-header' }), false);
});
