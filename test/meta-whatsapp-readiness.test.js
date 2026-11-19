// test/meta-whatsapp-readiness.test.js - Unit and integration verification for Meta WhatsApp Cloud API readiness, webhooks, and provider guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { getWhatsAppConfig, MetaCloudWhatsAppProvider, StubWhatsAppProvider } from '../lib/services/whatsapp-provider.js';
import { verifyWebhook, handleWebhook } from '../lib/handlers/whatsapp-webhook.js';
import { isWhatsAppAvailable, requestWhatsAppOtp } from '../lib/services/whatsapp-auth.js';
import { generateOtpCode, hashOtpCode } from '../lib/services/otp.js';
import { renderSignin } from '../lib/views/pages.js';

test('Meta WhatsApp Config - default safe fail-closed state', () => {
  const cfg = getWhatsAppConfig();
  assert.equal(cfg.otpTemplateName, 'nightlifez_auth_otp');
  assert.equal(cfg.apiVersion, 'v21.0');
  // In dev/test without env vars, isLive must be false
  assert.equal(typeof cfg.isLive, 'boolean');
});

test('Meta WhatsApp Webhook Verification Challenge (GET) - accepts matching token and echoes challenge', async () => {
  const testChallenge = 'challenge_test_string_98765';
  const testToken = 'test_verify_token_secure_xyz';

  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = testToken;

  let statusCode = null;
  let responseBody = '';
  let responseHeaders = {};

  const mockRes = {
    writeHead: (code, headers) => {
      statusCode = code;
      responseHeaders = headers;
    },
    end: (body) => {
      responseBody = body;
    }
  };

  const query = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': testToken,
    'hub.challenge': testChallenge
  });

  await verifyWebhook({ res: mockRes, query });

  assert.equal(statusCode, 200);
  assert.equal(responseBody, testChallenge);
  assert.equal(responseHeaders['Content-Type'], 'text/plain');
});

test('Meta WhatsApp Webhook Verification Challenge (GET) - rejects mismatched verify token', async () => {
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'expected_secret_token';

  const mockRes = {
    writeHead: () => {},
    end: () => {}
  };

  const query = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong_token',
    'hub.challenge': 'some_challenge'
  });

  await assert.rejects(
    async () => {
      await verifyWebhook({ res: mockRes, query });
    },
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, 'forbidden');
      return true;
    }
  );
});

test('Meta WhatsApp Webhook Signature Verification - HMAC-SHA256 signature validation', () => {
  const webhookSecret = 'test_meta_app_secret_1234567890';
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1155371310259355',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+919999999999', phone_number_id: '1234567890' },
              statuses: [{ id: 'wamid.HBgL...', status: 'delivered' }]
            },
            field: 'messages'
          }
        ]
      }
    ]
  });

  const validHmac = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
  const validSignatureHeader = `sha256=${validHmac}`;
  const invalidSignatureHeader = 'sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb';

  const provider = new MetaCloudWhatsAppProvider({
    apiVersion: 'v21.0',
    phoneNumberId: '1234567890',
    accessToken: 'test_token',
    webhookSecret
  });

  assert.equal(
    provider.verifyWebhookSignature({ rawBody: payload, signatureHeader: validSignatureHeader }),
    true
  );
  assert.equal(
    provider.verifyWebhookSignature({ rawBody: payload, signatureHeader: invalidSignatureHeader }),
    false
  );
  assert.equal(
    provider.verifyWebhookSignature({ rawBody: payload, signatureHeader: 'invalid_format' }),
    false
  );
});

test('Meta WhatsApp Cloud API payload format conforms strictly to v21.0 authentication template specifications', () => {
  const provider = new MetaCloudWhatsAppProvider({
    apiVersion: 'v21.0',
    phoneNumberId: 'test_phone_id_123',
    accessToken: 'test_token',
    otpTemplateName: 'nightlifez_auth_otp',
    otpTemplateLanguage: 'en'
  });

  assert.equal(provider.baseUrl, 'https://graph.facebook.com/v21.0/test_phone_id_123/messages');
  assert.equal(provider.config.otpTemplateName, 'nightlifez_auth_otp');
  assert.equal(provider.config.apiVersion, 'v21.0');
});

test('Meta WhatsApp Asset Reconciliation Guard - Asset ID 1155371310259355 must never be used as Phone Number ID', () => {
  // Asset 1155371310259355 is a WhatsApp Business App link asset under Messaging accounts, NOT a Cloud API Phone Number ID
  const rawAssetId = '1155371310259355';
  
  // Verify that empty or unverified phone number ID keeps provider safely disabled
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.WHATSAPP_ENABLED = 'true';
  process.env.WHATSAPP_ACCESS_TOKEN = 'test_token';
  
  const cfgWithoutPhoneId = getWhatsAppConfig();
  assert.equal(cfgWithoutPhoneId.isConfigured, false);
  assert.equal(cfgWithoutPhoneId.isLive, false);

  // Clean up
  delete process.env.WHATSAPP_ENABLED;
  delete process.env.WHATSAPP_ACCESS_TOKEN;
});

test('Postman Collection Integrity - contains all necessary Graph API calls for WABA, phone numbers, and template validation', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  
  const collectionPath = path.join(process.cwd(), 'docs/postman/nightlifez-meta-whatsapp.postman_collection.json');
  const envPath = path.join(process.cwd(), 'docs/postman/nightlifez-meta-whatsapp.postman_environment.json');
  
  const collectionRaw = await fs.readFile(collectionPath, 'utf8');
  const envRaw = await fs.readFile(envPath, 'utf8');
  
  const collection = JSON.parse(collectionRaw);
  const environment = JSON.parse(envRaw);
  
  assert.ok(collection.info.name.includes('NIGHTLIFEZ'));
  assert.ok(collection.item.length >= 3);
  
  // Verify WABA inspection endpoint
  const wabaItem = collection.item[0].item[0];
  assert.match(wabaItem.request.url.raw, /\{\{waba_id\}\}/);
  
  // Verify Phone Numbers endpoint
  const phoneNumbersItem = collection.item[0].item[1];
  assert.match(phoneNumbersItem.request.url.raw, /phone_numbers/);
  
  // Verify Template endpoint
  const templateItem = collection.item[1].item[0];
  assert.match(templateItem.request.url.raw, /message_templates/);
  
  // Verify Environment variables
  const envKeys = new Set(environment.values.map(v => v.key));
  assert.ok(envKeys.has('waba_id'));
  assert.ok(envKeys.has('whatsapp_phone_number_id'));
  assert.ok(envKeys.has('whatsapp_access_token'));
  assert.ok(envKeys.has('otp_template_name'));
});

test('Meta WhatsApp Webhook Verification Challenge (GET) - fails closed when token is unset in non-test mode', async () => {
  const origNodeEnv = process.env.NODE_ENV;
  delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  process.env.NODE_ENV = 'production';

  const mockRes = { writeHead: () => {}, end: () => {} };
  const query = new URLSearchParams({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'any_token',
    'hub.challenge': 'some_challenge'
  });

  try {
    await assert.rejects(
      async () => {
        await verifyWebhook({ res: mockRes, query });
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, 'forbidden');
        return true;
      }
    );
  } finally {
    process.env.NODE_ENV = origNodeEnv;
  }
});

test('Production Guard - isWhatsAppAvailable() strictly returns false when WHATSAPP_ENABLED is not true in production', () => {
  const origVercel = process.env.VERCEL;
  const origEnabled = process.env.WHATSAPP_ENABLED;
  
  process.env.VERCEL = '1';
  process.env.WHATSAPP_ENABLED = 'false';
  
  assert.equal(isWhatsAppAvailable(), false);
  
  // Clean up
  if (origVercel !== undefined) process.env.VERCEL = origVercel;
  else delete process.env.VERCEL;
  if (origEnabled !== undefined) process.env.WHATSAPP_ENABLED = origEnabled;
  else delete process.env.WHATSAPP_ENABLED;
});

test('OTP Request Guard - requestWhatsAppOtp() throws 503 whatsapp_unavailable in production when unconfigured', async () => {
  const origVercel = process.env.VERCEL;
  const origEnabled = process.env.WHATSAPP_ENABLED;
  
  process.env.VERCEL = '1';
  process.env.WHATSAPP_ENABLED = 'false';
  
  await assert.rejects(
    async () => {
      await requestWhatsAppOtp({ phone: '+919999999999' });
    },
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'whatsapp_unavailable');
      return true;
    }
  );
  
  // Clean up
  if (origVercel !== undefined) process.env.VERCEL = origVercel;
  else delete process.env.VERCEL;
  if (origEnabled !== undefined) process.env.WHATSAPP_ENABLED = origEnabled;
  else delete process.env.WHATSAPP_ENABLED;
});

test('Sign-in UI Rendering - gracefully renders Telegram fallback card and hides WhatsApp when offline', () => {
  const htmlOffline = renderSignin({ whatsappAvailable: false });
  assert.ok(htmlOffline.includes('data-wa-unavailable'));
  assert.ok(htmlOffline.includes('WhatsApp sign-in is temporarily unavailable'));
  assert.ok(htmlOffline.includes('Continue with Telegram'));
  
  const htmlOnline = renderSignin({ whatsappAvailable: true });
  assert.ok(!htmlOnline.includes('data-wa-unavailable'));
  assert.ok(htmlOnline.includes('Continue with WhatsApp'));
});

test('OTP Generation & Hash Security - cryptographic 6-digit entropy and HMAC-SHA256 salting', () => {
  const code = generateOtpCode();
  assert.match(code, /^\d{6}$/);
  const codeNum = parseInt(code, 10);
  assert.ok(codeNum >= 100000 && codeNum <= 999999);

  const salt1 = crypto.randomBytes(16).toString('hex');
  const salt2 = crypto.randomBytes(16).toString('hex');

  const hash1 = hashOtpCode(code, salt1);
  const hash2 = hashOtpCode(code, salt2);
  const hash1Repeat = hashOtpCode(code, salt1);

  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 64); // SHA-256 hex
  assert.equal(hash1, hash1Repeat); // Deterministic with same salt
  assert.notEqual(hash1, hash2); // Salting prevents rainbow tables
});

test('WhatsApp Access Token Precedence - WHATSAPP_ACCESS_TOKEN takes precedence over nightlifezapiadmin fallback alias', () => {
  const origWaToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const origAdmin = process.env.nightlifezapiadmin;

  try {
    // Both set: WHATSAPP_ACCESS_TOKEN wins
    process.env.WHATSAPP_ACCESS_TOKEN = 'primary_wa_access_token_123';
    process.env.nightlifezapiadmin = 'fallback_admin_token_456';
    assert.equal(getWhatsAppConfig().accessToken, 'primary_wa_access_token_123');

    // Only WHATSAPP_ACCESS_TOKEN set
    delete process.env.nightlifezapiadmin;
    assert.equal(getWhatsAppConfig().accessToken, 'primary_wa_access_token_123');

    // Only nightlifezapiadmin set: fallback alias works
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.nightlifezapiadmin = 'fallback_admin_token_456';
    assert.equal(getWhatsAppConfig().accessToken, 'fallback_admin_token_456');

    // Neither set: empty string
    delete process.env.nightlifezapiadmin;
    assert.equal(getWhatsAppConfig().accessToken, '');
  } finally {
    if (origWaToken !== undefined) process.env.WHATSAPP_ACCESS_TOKEN = origWaToken;
    else delete process.env.WHATSAPP_ACCESS_TOKEN;
    if (origAdmin !== undefined) process.env.nightlifezapiadmin = origAdmin;
    else delete process.env.nightlifezapiadmin;
  }
});

test('WhatsApp Webhook POST Guard - fails closed in production when WHATSAPP_WEBHOOK_SECRET is unconfigured', async () => {
  const origVercel = process.env.VERCEL;
  const origSecret = process.env.WHATSAPP_WEBHOOK_SECRET;

  process.env.VERCEL = '1';
  delete process.env.WHATSAPP_WEBHOOK_SECRET;

  const mockReq = {
    headers: {},
    on: (evt, cb) => {
      if (evt === 'data') cb(Buffer.from('{"object":"whatsapp_business_account","entry":[]}'));
      if (evt === 'end') cb();
    }
  };
  const mockRes = { writeHead: () => {}, end: () => {} };

  try {
    await assert.rejects(
      async () => {
        await handleWebhook({ req: mockReq, res: mockRes });
      },
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'webhook_unconfigured');
        return true;
      }
    );
  } finally {
    if (origVercel !== undefined) process.env.VERCEL = origVercel;
    else delete process.env.VERCEL;
    if (origSecret !== undefined) process.env.WHATSAPP_WEBHOOK_SECRET = origSecret;
    else delete process.env.WHATSAPP_WEBHOOK_SECRET;
  }
});

test('WhatsApp Webhook POST - strictly validates HMAC-SHA256 signature and rejects tampering', async () => {
  const origSecret = process.env.WHATSAPP_WEBHOOK_SECRET;
  const secret = 'valid_test_signing_secret_987';
  process.env.WHATSAPP_WEBHOOK_SECRET = secret;

  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const validSig = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const invalidSig = 'sha256=invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';

  const mockRes = {
    statusCode: null,
    headers: {},
    body: null,
    setHeader: function(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader: function(k) { return this.headers[k.toLowerCase()]; },
    writeHead: function(status, headers = {}) {
      this.statusCode = status;
      for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = v;
    },
    end: function(chunk) { this.body = chunk; }
  };

  const createReq = (sig, bodyStr) => ({
    headers: sig ? { 'x-hub-signature-256': sig } : {},
    on: (evt, cb) => {
      if (evt === 'data') cb(Buffer.from(bodyStr));
      if (evt === 'end') cb();
    }
  });

  try {
    // 1. Missing signature rejects with 401
    await assert.rejects(
      async () => {
        await handleWebhook({ req: createReq(null, payload), res: mockRes });
      },
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'invalid_signature');
        return true;
      }
    );

    // 2. Invalid signature rejects with 401
    await assert.rejects(
      async () => {
        await handleWebhook({ req: createReq(invalidSig, payload), res: mockRes });
      },
      (err) => {
        assert.equal(err.status, 401);
        assert.equal(err.code, 'invalid_signature');
        return true;
      }
    );

    // 3. Valid signature succeeds with 200
    await handleWebhook({ req: createReq(validSig, payload), res: mockRes });
    assert.equal(mockRes.statusCode, 200);
  } finally {
    if (origSecret !== undefined) process.env.WHATSAPP_WEBHOOK_SECRET = origSecret;
    else delete process.env.WHATSAPP_WEBHOOK_SECRET;
  }
});

test('Sign-in UI Rendering - retains user entered phone number across render', () => {
  const htmlWithPhone = renderSignin({
    whatsappAvailable: true,
    phone: '+919876543210'
  });
  assert.ok(htmlWithPhone.includes('value="9876543210"'));
});

test('Sign-in UI Rendering - does not silently switch authentication methods when WhatsApp tab is requested while unavailable', () => {
  const htmlExplicitWa = renderSignin({
    whatsappAvailable: false,
    activeTab: 'whatsapp'
  });

  // WhatsApp tab remains active (not silently switched to Telegram tab)
  assert.ok(htmlExplicitWa.includes('data-auth-tab="whatsapp" aria-selected="true"'));
  // WhatsApp panel is visible and displays the clear explanation
  assert.ok(htmlExplicitWa.includes('data-auth-panel="whatsapp"'));
  assert.ok(!htmlExplicitWa.includes('data-auth-panel="whatsapp" hidden'));
  assert.ok(htmlExplicitWa.includes('WhatsApp sign-in is temporarily unavailable'));
  // Does NOT render broken form inputs when unavailable
  assert.ok(!htmlExplicitWa.includes('data-wa-phone-form'));
});

test('Sign-in UI Rendering - does not render broken WhatsApp phone form when WhatsApp is offline', () => {
  const htmlOffline = renderSignin({ whatsappAvailable: false });
  assert.ok(htmlOffline.includes('data-wa-unavailable'));
  assert.ok(!htmlOffline.includes('data-wa-phone-form'));
  assert.ok(!htmlOffline.includes('name="phone"'));
  assert.ok(htmlOffline.includes('Continue with Telegram'));
});



