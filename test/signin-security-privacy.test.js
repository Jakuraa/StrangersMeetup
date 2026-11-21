// test/signin-security-privacy.test.js - Regression suite for sign-in URL privacy, native POST semantics, and consent invariants.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, db } from './helpers.js';
import { getWhatsAppProvider } from '../lib/services/whatsapp-provider.js';
import { requestWhatsAppOtp } from '../lib/services/whatsapp-auth.js';
import { hasConsent } from '../lib/services/communication-consent.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(stopServer);

beforeEach(() => {
  getWhatsAppProvider().clearSentMessages();
});

test('1. Form has explicit POST semantics in rendered HTML', async () => {
  const c = new Client();
  const res = await c.get('/signin');
  assert.equal(res.status, 200);
  const html = res.text;

  // Verify WhatsApp phone form has explicit method="POST" and action
  assert.match(html, /<form\s+class="wa-auth-card"\s+method="POST"\s+action="\/api\/auth\/whatsapp\/otp"\s+data-wa-phone-form>/i);
  // Verify OTP verification form has explicit method="POST" and action
  assert.match(html, /<form\s+id="otp-form"\s+method="POST"\s+action="\/api\/auth\/whatsapp\/verify"\s+data-wa-verify-form>/i);
});

test('2. No native GET submission is possible across auth forms', async () => {
  const c = new Client();
  const res = await c.get('/signin');
  const html = res.text;

  // Extract all <form ...> tags inside .auth-panel
  const formTags = html.match(/<form[^>]*>/gi) || [];
  assert.ok(formTags.length >= 2, 'Must have at least 2 auth forms');

  for (const tag of formTags) {
    if (tag.includes('data-wa-phone-form') || tag.includes('data-wa-verify-form')) {
      assert.match(tag, /method=["']POST["']/i, `Form ${tag} must specify explicit method="POST"`);
      assert.doesNotMatch(tag, /method=["']GET["']/i, `Form ${tag} must never specify method="GET"`);
    }
  }
});

test('3. Enter-key submission cannot leak a phone number into URL query string', async () => {
  const c = new Client();
  const phone = '9876543210';

  // Simulating native form submit (Enter key press sends POST with application/x-www-form-urlencoded)
  const formBody = new URLSearchParams({
    phone,
    ageConfirmed: 'on',
    promotionalOptIn: 'on',
    next: '/me'
  }).toString();

  const res = await c.req('POST', '/api/auth/whatsapp/otp', formBody, {
    'content-type': 'application/x-www-form-urlencoded',
    'accept': 'text/html,application/xhtml+xml,application/xml'
  });

  // Verify response is a safe redirect (302) to step=otp, NEVER appending phone or consent
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location);
  assert.equal(location.includes(phone), false, 'Phone number must NOT be in redirect Location URL');
  assert.equal(location.includes('ageConfirmed'), false, 'ageConfirmed must NOT be in Location URL');
  assert.equal(location.includes('promotionalOptIn'), false, 'promotionalOptIn must NOT be in Location URL');
  assert.match(location, /^\/signin\?step=otp&next=%2Fme$/);

  // Check that sm_wa_step cookie was set securely
  const setCookie = res.headers.getSetCookie?.() || [res.headers.get('set-cookie')];
  assert.match(setCookie.join(';'), /sm_wa_step=/);
});

test('4. JavaScript-disabled submission does not expose PII and completes verification', async () => {
  const c = new Client();
  const phone = '9876543211';
  await db.query(
    `INSERT INTO users (phone, alias, display_name, age_confirmed_21, status, onboarding_completed, onboarding_step)
     VALUES ('+919876543211', 'User9876543211', 'User9876543211', true, 'active', true, 6)
     ON CONFLICT (phone) DO UPDATE SET onboarding_completed = true`
  );

  // Step A: Submit phone number with JS disabled (HTML POST)
  const formBody = new URLSearchParams({
    phone,
    ageConfirmed: 'on',
    next: '/me'
  }).toString();

  const r1 = await c.req('POST', '/api/auth/whatsapp/otp', formBody, {
    'content-type': 'application/x-www-form-urlencoded',
    'accept': 'text/html'
  });

  assert.equal(r1.status, 302);
  const loc1 = r1.headers.get('location');
  assert.doesNotMatch(loc1, /phone=|9876543211|ageConfirmed/);

  // Extract OTP sent to mock provider
  const sent = getWhatsAppProvider().getSentMessages();
  assert.equal(sent.length, 1);
  const otpCode = sent[0].otp;
  assert.ok(otpCode);

  // Step B: Submit verification code with JS disabled (HTML POST)
  const verifyBody = new URLSearchParams({
    otp: otpCode,
    next: '/me'
  }).toString();

  const r2 = await c.req('POST', '/api/auth/whatsapp/verify', verifyBody, {
    'content-type': 'application/x-www-form-urlencoded',
    'accept': 'text/html'
  });

  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/me');
  assert.doesNotMatch(r2.headers.get('location'), /otp|code|phone=/);

  // Verify session cookie was set
  const setCookie = r2.headers.getSetCookie?.() || [r2.headers.get('set-cookie')];
  assert.match(setCookie.join(';'), /sm_session=/);
  // Verify sm_wa_step cookie was cleared (Max-Age=0)
  assert.match(setCookie.join(';'), /sm_wa_step=;/);
});

test('5. Legacy sensitive query parameters are safely removed via 302 redirect', async () => {
  const c = new Client();
  const legacyUrl = '/signin?phone=9876543210&ageConfirmed=on&promotionalOptIn=on&next=%2Fme';

  const res = await c.get(legacyUrl);

  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.equal(location, '/signin?next=%2Fme');
  assert.doesNotMatch(location, /phone|9876543210|ageConfirmed|promotionalOptIn/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('6. Phone numbers and OTP tokens never appear in generated navigation URLs', async () => {
  const c = new Client();
  const probeUrls = [
    '/signin?phone=%2B919876543210',
    '/signin?otp=654321',
    '/signin?code=654321&phone=9876543210',
    '/signin?token=secret123&phone=9876543210'
  ];

  for (const url of probeUrls) {
    const res = await c.get(url);
    assert.equal(res.status, 302);
    const loc = res.headers.get('location');
    assert.equal(loc, '/signin');
    assert.doesNotMatch(loc, /phone|otp|code|token|secret/);
  }
});

test('7. Analytics requests reject query strings in path and never leak PII', async () => {
  const c = new Client();

  // Attempting to send path with query string containing phone should fail analytics schema validation
  const r1 = await c.post('/api/analytics', {
    name: 'page_view',
    path: '/signin?phone=9876543210'
  });
  assert.equal(r1.status, 400);
  assert.equal(r1.json.error, 'validation');

  // Valid path without query string succeeds
  const r2 = await c.post('/api/analytics', {
    name: 'page_view',
    path: '/signin'
  });
  assert.equal(r2.status, 204);
});

test('8. URL parameters cannot establish age verification', async () => {
  const c = new Client();

  // Visitor accessing /signin with ageConfirmed=on in URL
  const res = await c.get('/signin?ageConfirmed=on');
  assert.equal(res.status, 302);

  // Check /api/me: user must still be null (not authenticated)
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user, null);
});

test('9. URL parameters cannot establish promotional consent', async () => {
  const c = new Client();

  // Visitor accessing /signin with promotionalOptIn=on in URL
  await c.get('/signin?promotionalOptIn=on');

  // Verify no communication_consents row exists with status = 'opted_in' for promotional
  const { rows } = await db.query(
    "SELECT * FROM communication_consents WHERE channel = 'whatsapp' AND purpose = 'promotional' AND status = 'opted_in'"
  );
  assert.equal(rows.length, 0);
});

test('10. Promotional consent remains optional and unchecked by default', async () => {
  const c = new Client();
  const res = await c.get('/signin');
  assert.equal(res.status, 200);
  const html = res.text;

  // Must not have checked attribute
  assert.match(html, /<input type="checkbox" id="wa-promo-optin"[^>]*>/);
  assert.doesNotMatch(html, /<input type="checkbox" id="wa-promo-optin"[^>]*checked/i);

  // Invariant in communication-consent service: default promotional consent is false
  const hasPromo = await hasConsent({ userId: '00000000-0000-0000-0000-000000000000', channel: 'whatsapp', purpose: 'promotional' });
  assert.equal(hasPromo, false);
});

test('11. Existing WhatsApp OTP and Telegram authentication behavior remains intact', async () => {
  const c = new Client();
  const phone = '+919876543299';

  // JSON flow (standard AJAX path)
  const r1 = await c.post('/api/auth/whatsapp/otp', {
    phone,
    promotionalOptIn: false
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.ok, true);

  const sent = getWhatsAppProvider().getSentMessages();
  const code = sent[sent.length - 1].otp;

  const r2 = await c.post('/api/auth/whatsapp/verify', {
    challengeId: r1.json.challengeId,
    phone,
    code,
    promotionalOptIn: false
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.ok, true);
  assert.equal(r2.json.user.ageConfirmed, true);

  // Telegram auth rejection of invalid payload remains intact
  const r3 = await c.post('/api/auth/telegram', {
    widget: { id: 12345, first_name: 'Fake', auth_date: 1234567890, hash: 'badhash' }
  });
  assert.equal(r3.status, 401);
});

test('12. Simulates JavaScript failing to initialize before form submission (native HTML POST)', async () => {
  const c = new Client();

  // Case A: User submits without confirming age natively (e.g. bypassing required attribute)
  const noAgeBody = new URLSearchParams({
    phone: '9876543210',
    next: '/me'
  }).toString();

  const r1 = await c.req('POST', '/api/auth/whatsapp/otp', noAgeBody, {
    'content-type': 'application/x-www-form-urlencoded',
    'accept': 'text/html'
  });

  // Must redirect back with error=age, never leaking phone
  assert.equal(r1.status, 302);
  const loc1 = r1.headers.get('location');
  assert.equal(loc1, '/signin?error=age&next=%2Fme');
  assert.doesNotMatch(loc1, /phone|9876543210/);

  // Case B: User submits invalid phone natively
  const badPhoneBody = new URLSearchParams({
    phone: '12345',
    ageConfirmed: 'on',
    next: '/me'
  }).toString();

  const r2 = await c.req('POST', '/api/auth/whatsapp/otp', badPhoneBody, {
    'content-type': 'application/x-www-form-urlencoded',
    'accept': 'text/html'
  });

  assert.equal(r2.status, 302);
  const loc2 = r2.headers.get('location');
  assert.equal(loc2, '/signin?error=invalid_phone&next=%2Fme');
  assert.doesNotMatch(loc2, /12345/);
  assert.doesNotMatch(loc2, /phone=/);
});

test('13. Production provider fails closed with 503 when live WhatsApp credentials are absent', async () => {
  const prevEnv = process.env.NODE_ENV;
  const prevDev = process.env.DEV_LOGIN;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.DEV_LOGIN;

    await assert.rejects(
      async () => {
        await requestWhatsAppOtp({ phone: '+919876543210' });
      },
      (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.code, 'whatsapp_unavailable');
        assert.match(err.message, /WhatsApp sign-in is currently unavailable/);
        return true;
      }
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevDev !== undefined) process.env.DEV_LOGIN = prevDev;
  }
});
