import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  getWhatsAppConfig,
  getWhatsAppProvider,
  StubWhatsAppProvider,
  MetaCloudWhatsAppProvider,
  buildOtpTemplatePayload
} from '../lib/services/whatsapp-provider.js';

test('getWhatsAppConfig defaults safely when environment variables are not set', () => {
  const cfg = getWhatsAppConfig();
  assert.equal(typeof cfg.enabled, 'boolean');
  assert.equal(typeof cfg.isLive, 'boolean');
  // Unless explicitly configured, isLive is false
  assert.equal(cfg.isLive, false);
  assert.equal(cfg.otpTemplateName, 'nightlifez_auth_otp');
  assert.equal(cfg.otpTemplateLanguage, 'en');
  assert.equal(cfg.otpButtonType, 'copy_code');
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
  assert.equal(res.templateName, 'nightlifez_auth_otp');

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

test('buildOtpTemplatePayload - Copy Code template configuration', () => {
  const payload = buildOtpTemplatePayload({
    to: '+919876543210',
    otp: '123456',
    templateName: 'nightlifez_auth_otp',
    language: 'en',
    buttonType: 'copy_code'
  });

  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.recipient_type, 'individual');
  assert.equal(payload.to, '919876543210');
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'nightlifez_auth_otp');
  assert.equal(payload.template.language.code, 'en');

  // Verify components: body + button index 0
  assert.equal(payload.template.components.length, 2);
  const [bodyComp, btnComp] = payload.template.components;
  assert.equal(bodyComp.type, 'body');
  assert.deepEqual(bodyComp.parameters, [{ type: 'text', text: '123456' }]);
  assert.equal(btnComp.type, 'button');
  assert.equal(btnComp.sub_type, 'url');
  assert.equal(btnComp.index, '0');
  assert.deepEqual(btnComp.parameters, [{ type: 'text', text: '123456' }]);
});

test('buildOtpTemplatePayload - One-Tap autofill template configuration', () => {
  const payload = buildOtpTemplatePayload({
    to: '+919876543210',
    otp: '654321',
    templateName: 'nightlifez_auth_otp_onetap',
    language: 'en',
    buttonType: 'one_tap'
  });

  assert.equal(payload.template.name, 'nightlifez_auth_otp_onetap');
  assert.equal(payload.template.components.length, 2);
  const [bodyComp, btnComp] = payload.template.components;
  assert.equal(bodyComp.type, 'body');
  assert.deepEqual(bodyComp.parameters, [{ type: 'text', text: '654321' }]);
  assert.equal(btnComp.type, 'button');
  assert.equal(btnComp.sub_type, 'url');
  assert.equal(btnComp.index, '0');
  assert.deepEqual(btnComp.parameters, [{ type: 'text', text: '654321' }]);
});

test('buildOtpTemplatePayload - Zero-Tap template configuration (fallback button structure)', () => {
  const payload = buildOtpTemplatePayload({
    to: '+919876543210',
    otp: '789012',
    templateName: 'nightlifez_auth_otp_zerotap',
    language: 'en',
    buttonType: 'zero_tap'
  });

  assert.equal(payload.template.name, 'nightlifez_auth_otp_zerotap');
  assert.equal(payload.template.components.length, 2);
  const [bodyComp, btnComp] = payload.template.components;
  assert.equal(bodyComp.type, 'body');
  assert.deepEqual(bodyComp.parameters, [{ type: 'text', text: '789012' }]);
  assert.equal(btnComp.type, 'button');
  assert.equal(btnComp.sub_type, 'url');
  assert.equal(btnComp.index, '0');
  assert.deepEqual(btnComp.parameters, [{ type: 'text', text: '789012' }]);
});

test('buildOtpTemplatePayload - Body-only template configuration (buttonType: none)', () => {
  const payload = buildOtpTemplatePayload({
    to: '+919876543210',
    otp: '345678',
    templateName: 'nightlifez_auth_otp_bodyonly',
    language: 'en',
    buttonType: 'none'
  });

  assert.equal(payload.template.name, 'nightlifez_auth_otp_bodyonly');
  assert.equal(payload.template.components.length, 1);
  const [bodyComp] = payload.template.components;
  assert.equal(bodyComp.type, 'body');
  assert.deepEqual(bodyComp.parameters, [{ type: 'text', text: '345678' }]);
});

test('buildOtpTemplatePayload - Multilingual configuration (Hindi, Tamil, en_US)', () => {
  const languages = ['hi', 'ta', 'en_US', 'te', 'kn'];
  for (const lang of languages) {
    const payload = buildOtpTemplatePayload({
      to: '+919876543210',
      otp: '998877',
      templateName: `nightlifez_auth_otp_${lang.toLowerCase()}`,
      language: lang,
      buttonType: 'copy_code'
    });
    assert.equal(payload.template.language.code, lang);
    assert.equal(payload.template.name, `nightlifez_auth_otp_${lang.toLowerCase()}`);
  }
});
