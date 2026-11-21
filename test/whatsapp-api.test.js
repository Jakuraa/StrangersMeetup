// test/whatsapp-api.test.js - End-to-end HTTP tests for WhatsApp OTP auth, account linking, webhooks, preferences, and admin telemetry.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, startServer, stopServer, Client, makeInitData, db } from './helpers.js';
import { getWhatsAppProvider } from '../lib/services/whatsapp-provider.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(stopServer);

beforeEach(() => {
  getWhatsAppProvider().clearSentMessages();
});

test('WhatsApp Auth API - complete OTP signup lifecycle', async () => {
  const c = new Client();
  const phone = '+919876543210';

  // 1. Request OTP
  const r1 = await c.post('/api/auth/whatsapp/otp', {
    phone,
    promotionalOptIn: true
  });

  assert.equal(r1.status, 200);
  assert.equal(r1.json.ok, true);
  assert.ok(r1.json.challengeId);
  assert.equal(r1.json.phoneMasked, '+91 98****3210');
  assert.equal(typeof r1.json.resendAfterSeconds, 'number');

  // Verify stub provider received OTP
  const sent = getWhatsAppProvider().getSentMessages();
  assert.equal(sent.length, 1);
  const otpCode = sent[0].otp;
  assert.ok(otpCode);

  // 2. Verify OTP and establish session
  const r2 = await c.post('/api/auth/whatsapp/verify', {
    challengeId: r1.json.challengeId,
    phone,
    code: otpCode,
    promotionalOptIn: true
  });

  assert.equal(r2.status, 200);
  assert.equal(r2.json.ok, true);
  assert.equal(r2.json.isNewUser, true);
  assert.ok(r2.json.csrf);
  assert.equal(r2.json.user.ageConfirmed, true);

  // Check session cookie
  const setCookie = r2.headers.getSetCookie().join('\n');
  assert.match(setCookie, /sm_session=/);

  // 3. GET /api/me works with this session
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.ageConfirmed, true);

  // 4. GET /api/me/identities shows WhatsApp linked, Telegram unlinked
  const identities = await c.get('/api/me/identities');
  assert.equal(identities.status, 200);
  assert.equal(identities.json.identities.whatsapp.linked, true);
  assert.equal(identities.json.identities.whatsapp.phoneMasked, '+91 98****3210');
  assert.equal(identities.json.identities.telegram.linked, false);
});

test('WhatsApp Auth API - account linking & sole-provider unlinking guard', async () => {
  // 1. Sign in via Telegram
  const tgClient = new Client();
  const tgUser = { id: 778899, first_name: 'LinkTester' };
  const authRes = await tgClient.post('/api/auth/telegram', {
    initData: makeInitData(tgUser),
    ageConfirmed: true
  });
  assert.equal(authRes.status, 200);
  tgClient.csrf = authRes.json.csrf;

  // 2. Request OTP to link WhatsApp
  const phone = '+919123456789';
  const otpRes = await tgClient.post('/api/auth/whatsapp/otp', { phone });
  assert.equal(otpRes.status, 200);

  const sent = getWhatsAppProvider().getSentMessages();
  const otpCode = sent[sent.length - 1].otp;

  // 3. Link WhatsApp to signed-in user
  const linkRes = await tgClient.post('/api/auth/whatsapp/link', {
    challengeId: otpRes.json.challengeId,
    phone,
    code: otpCode
  });
  assert.equal(linkRes.status, 200);
  assert.equal(linkRes.json.ok, true);

  // Both should be linked now
  const idRes = await tgClient.get('/api/me/identities');
  assert.equal(idRes.json.identities.telegram.linked, true);
  assert.equal(idRes.json.identities.whatsapp.linked, true);

  // 4. Unlink WhatsApp succeeds because Telegram remains
  const unlinkRes = await tgClient.post('/api/auth/whatsapp/unlink', { phone });
  assert.equal(unlinkRes.status, 200);
  assert.equal(unlinkRes.json.ok, true);

  // Re-verify identities
  const idResAfter = await tgClient.get('/api/me/identities');
  assert.equal(idResAfter.json.identities.whatsapp.linked, false);
  assert.equal(idResAfter.json.identities.telegram.linked, true);

  // Now create a WhatsApp-only client and test sole-provider guard
  const waOnly = new Client();
  const waReq = await waOnly.post('/api/auth/whatsapp/otp', { phone: '+919988776655' });
  const waOtp = getWhatsAppProvider().getSentMessages().slice(-1)[0].otp;
  const waAuth = await waOnly.post('/api/auth/whatsapp/verify', {
    challengeId: waReq.json.challengeId,
    phone: '+919988776655',
    code: waOtp
  });
  waOnly.csrf = waAuth.json.csrf;

  // Attempt to unlink sole provider -> must fail
  const failedUnlink = await waOnly.post('/api/auth/whatsapp/unlink', { phone: '+919988776655' });
  assert.equal(failedUnlink.status, 400);
  assert.match(failedUnlink.json.message, /only login method/i);
});

test('WhatsApp Auth API - communication preferences GET and PATCH', async () => {
  const c = new Client();
  const phone = '+919555112233';
  const req = await c.post('/api/auth/whatsapp/otp', { phone });
  const otp = getWhatsAppProvider().getSentMessages().slice(-1)[0].otp;
  const auth = await c.post('/api/auth/whatsapp/verify', {
    challengeId: req.json.challengeId,
    phone,
    code: otp,
    promotionalOptIn: true
  });
  c.csrf = auth.json.csrf;

  // GET preferences
  const getPref = await c.get('/api/me/communication-preferences');
  assert.equal(getPref.status, 200);
  assert.equal(getPref.json.preferences.whatsapp.transactional, true);
  assert.equal(getPref.json.preferences.whatsapp.promotional, true);

  // PATCH preferences (opt out of promotional)
  const patchPref = await c.patch('/api/me/communication-preferences', {
    channel: 'whatsapp',
    purpose: 'promotional',
    status: 'opted_out'
  });
  assert.equal(patchPref.status, 200);
  assert.equal(patchPref.json.preferences.whatsapp.promotional, false);
  assert.equal(patchPref.json.preferences.whatsapp.transactional, true);
});

test('WhatsApp Webhooks - challenge verification and receipt ingestion', async () => {
  const c = new Client();

  // 1. GET Challenge verification
  const verifyRes = await c.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nightlifez_webhook_verify_token&hub.challenge=test_challenge_abc123');
  assert.equal(verifyRes.status, 200);
  assert.equal(verifyRes.text, 'test_challenge_abc123');

  // 2. Reject bad verify token
  const badVerify = await c.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test');
  assert.equal(badVerify.status, 403);

  // 3. Ingest message status receipt
  const receiptPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456789',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '123', phone_number_id: '456' },
              statuses: [
                {
                  id: 'wamid.test_status_123',
                  status: 'delivered',
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  recipient_id: '919876543210'
                }
              ]
            },
            field: 'messages'
          }
        ]
      }
    ]
  };

  const rawJson = JSON.stringify(receiptPayload);
  const secret = process.env.WHATSAPP_WEBHOOK_SECRET || 'test_whatsapp_webhook_secret';
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawJson).digest('hex');

  const webhookRes = await c.post('/api/webhooks/whatsapp', receiptPayload, {
    'x-hub-signature-256': sig
  });
  assert.equal(webhookRes.status, 200);
  assert.equal(webhookRes.json.ok, true);

  // 4. Ingest incoming STOP keyword from user
  const stopPayload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '123456789',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              messages: [
                {
                  from: '919876543210',
                  id: 'wamid.inbound_stop_123',
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  text: { body: 'STOP' },
                  type: 'text'
                }
              ]
            },
            field: 'messages'
          }
        ]
      }
    ]
  };

  const stopRawJson = JSON.stringify(stopPayload);
  const stopSig = 'sha256=' + crypto.createHmac('sha256', secret).update(stopRawJson).digest('hex');

  const stopRes = await c.post('/api/webhooks/whatsapp', stopPayload, {
    'x-hub-signature-256': stopSig
  });
  assert.equal(stopRes.status, 200);

  // Verify phone is added to suppression list
  const supp = (await db.query(`SELECT * FROM notification_suppressions WHERE destination = '+919876543210'`)).rows[0];
  assert.ok(supp);
  assert.equal(supp.reason, 'keyword_opt_out');
});

test('Admin Notifications Telemetry - RBAC and masked PII', async () => {
  // 1. Unauthenticated request -> 401
  const anon = new Client();
  const unauth = await anon.get('/api/admin/notifications/health');
  assert.equal(unauth.status, 401);

  // 2. Regular user (guest) request -> 403 Forbidden
  const guestClient = new Client();
  const req = await guestClient.post('/api/auth/whatsapp/otp', { phone: '+919111222333' });
  const otp = getWhatsAppProvider().getSentMessages().slice(-1)[0].otp;
  await guestClient.post('/api/auth/whatsapp/verify', {
    challengeId: req.json.challengeId,
    phone: '+919111222333',
    code: otp
  });

  const guestHealth = await guestClient.get('/api/admin/notifications/health');
  assert.equal(guestHealth.status, 403);

  // 3. Super Admin request -> 200 OK
  const adminClient = new Client();
  await adminClient.post('/api/auth/telegram', {
    initData: makeInitData({ id: 900000001, first_name: 'SuperAdmin' }), // ADMIN_BOOTSTRAP_TELEGRAM_ID
    ageConfirmed: true
  });

  const health = await adminClient.get('/api/admin/notifications/health');
  assert.equal(health.status, 200);
  assert.ok(health.json.whatsapp);
  assert.equal(health.json.whatsapp.mode, 'safe_mock_adapter');

  const stats = await adminClient.get('/api/admin/notifications/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.json.telemetry.otp);
  assert.ok(stats.json.telemetry.messages);

  const messages = await adminClient.get('/api/admin/notifications/messages');
  assert.equal(messages.status, 200);
  assert.ok(Array.isArray(messages.json.messages));

  const suppressions = await adminClient.get('/api/admin/notifications/suppressions');
  assert.equal(suppressions.status, 200);
  assert.ok(Array.isArray(suppressions.json.suppressions));
  if (suppressions.json.suppressions.length > 0) {
    assert.ok(suppressions.json.suppressions[0].destinationMasked.includes('****'));
  }
});

test('UI Rendering - /signin and /me pages conform to modern web standards', async () => {
  const c = new Client();
  const signinPage = await c.get('/signin');
  assert.equal(signinPage.status, 200);

  // 1. Auth switcher tabs
  assert.match(signinPage.text, /data-auth-tab="whatsapp"/);
  assert.match(signinPage.text, /data-auth-tab="telegram"/);

  // 2. WhatsApp phone form
  assert.match(signinPage.text, /data-wa-phone-form/);
  assert.match(signinPage.text, /data-wa-submit-phone/);

  // 3. Modern Web Guidance compliance for SMS OTP form
  assert.match(signinPage.text, /id="otp-form"/);
  assert.match(signinPage.text, /id="otp-input"/);
  assert.match(signinPage.text, /inputmode="numeric"/);
  assert.match(signinPage.text, /autocomplete="one-time-code"/);
  assert.match(signinPage.text, /pattern="\\d\{6\}"/);
  assert.match(signinPage.text, /aria-describedby="otp-format-hint"/);
  assert.match(signinPage.text, /id="otp-format-hint"/);
  assert.match(signinPage.text, /data-wa-resend-btn/);
  assert.match(signinPage.text, /data-wa-change-phone/);

  // 4. Attendee hub /me page has account settings tab when signed in
  const req = await c.post('/api/auth/whatsapp/otp', { phone: '+919999988888' });
  const otp = getWhatsAppProvider().getSentMessages().slice(-1)[0].otp;
  await c.post('/api/auth/whatsapp/verify', {
    challengeId: req.json.challengeId,
    phone: '+919999988888',
    code: otp
  });

  await db.query(`UPDATE users SET onboarding_completed = TRUE, onboarding_step = 6 WHERE phone = '+919999988888'`);

  const mePage = await c.get('/me');
  assert.equal(mePage.status, 200);
  assert.match(mePage.text, /data-hub-tab="account"/);
  assert.match(mePage.text, /data-account-settings/);
});

