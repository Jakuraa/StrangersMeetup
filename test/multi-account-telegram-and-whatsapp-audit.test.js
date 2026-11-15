// test/multi-account-telegram-and-whatsapp-audit.test.js - Multi-Account Telegram Login + WhatsApp Production Login Audit Tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, startServer, stopServer, Client, makeWidgetData, db, BOT_TOKEN } from './helpers.js';

before(async () => {
  await resetDb();
  await startServer();
});
after(stopServer);

function buildCallbackQuery(widgetData, state, next) {
  const params = new URLSearchParams();
  if (state !== undefined) params.set('state', state);
  if (next !== undefined) params.set('next', next);
  for (const [k, v] of Object.entries(widgetData)) {
    params.set(k, String(v));
  }
  return params.toString();
}

/* ========================================================================== */
/* OBJECTIVE A: Telegram Multi-Account Support & Isolation                     */
/* ========================================================================== */

test('Telegram multi-account: accepts authentication from any valid Telegram account', async () => {
  // Test Account 1: User 70001 (Alice)
  const client1 = new Client();
  const state1 = crypto.randomBytes(16).toString('hex');
  client1.cookies.sm_tg_state = state1;

  const widgetAlice = makeWidgetData({ id: 70001, first_name: 'Alice', username: 'alice_telegram' });
  const qs1 = buildCallbackQuery(widgetAlice, state1, '/me');
  const res1 = await client1.get(`/auth/telegram/widget-callback?${qs1}`);

  assert.equal(res1.status, 302);
  assert.equal(res1.headers.get('location'), '/me');

  const me1 = await client1.get('/api/me');
  assert.equal(me1.status, 200);
  assert.equal(me1.json.user.alias, 'Alice');

  // Verify database record for Account 1
  const u1 = await db.one('SELECT id, telegram_user_id, alias FROM users WHERE telegram_user_id = 70001');
  assert.equal(u1.telegram_user_id, 70001);
  assert.equal(u1.alias, 'Alice');

  // Test Account 2: User 70002 (Bob)
  const client2 = new Client();
  const state2 = crypto.randomBytes(16).toString('hex');
  client2.cookies.sm_tg_state = state2;

  const widgetBob = makeWidgetData({ id: 70002, first_name: 'Bob', username: 'bob_telegram' });
  const qs2 = buildCallbackQuery(widgetBob, state2, '/me');
  const res2 = await client2.get(`/auth/telegram/widget-callback?${qs2}`);

  assert.equal(res2.status, 302);
  assert.equal(res2.headers.get('location'), '/me');

  const me2 = await client2.get('/api/me');
  assert.equal(me2.status, 200);
  assert.equal(me2.json.user.alias, 'Bob');

  // Verify database record for Account 2
  const u2 = await db.one('SELECT id, telegram_user_id, alias FROM users WHERE telegram_user_id = 70002');
  assert.equal(u2.telegram_user_id, 70002);
  assert.equal(u2.alias, 'Bob');

  // Verify accounts are distinct and isolated in database
  assert.notEqual(u1.id, u2.id);
  const count = await db.one('SELECT count(*)::int as c FROM users WHERE telegram_user_id IN (70001, 70002)');
  assert.equal(count.c, 2);
});

test('Telegram identity: identity is bound strictly to Telegram verified numeric ID, not browser username', async () => {
  const client = new Client();
  const state = crypto.randomBytes(16).toString('hex');
  client.cookies.sm_tg_state = state;

  // Sign in with verified numeric ID 70003, username 'charlie_smith'
  const widget1 = makeWidgetData({ id: 70003, first_name: 'Charlie', username: 'charlie_smith' });
  await client.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widget1, state, '/me')}`);

  const userBefore = await db.one('SELECT id, telegram_user_id, alias FROM users WHERE telegram_user_id = 70003');
  assert.equal(userBefore.telegram_user_id, 70003);

  // Subsequent login with same numeric ID but changed username/first_name updates profile, preserves user ID
  const clientFollowup = new Client();
  const stateFollowup = crypto.randomBytes(16).toString('hex');
  clientFollowup.cookies.sm_tg_state = stateFollowup;

  const widgetUpdated = makeWidgetData({ id: 70003, first_name: 'Charlie Smith Updated', username: 'new_username' });
  await clientFollowup.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetUpdated, stateFollowup, '/me')}`);

  const userAfter = await db.one('SELECT id, telegram_user_id, alias FROM users WHERE telegram_user_id = 70003');
  assert.equal(userAfter.id, userBefore.id, 'User record ID must match across logins with same Telegram ID');
  assert.equal(userAfter.alias, 'Charlie Smith Updated');
});

test('Telegram isolation: a different Telegram account cannot access another user NIGHTLIFEZ account', async () => {
  // Alice (70010) creates booking or access
  const clientAlice = new Client();
  const stateA = crypto.randomBytes(16).toString('hex');
  clientAlice.cookies.sm_tg_state = stateA;
  const widgetA = makeWidgetData({ id: 70010, first_name: 'Alice_Isolated' });
  await clientAlice.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetA, stateA, '/me')}`);

  const uAlice = await db.one('SELECT id, telegram_user_id FROM users WHERE telegram_user_id = 70010');

  // Eve (70011) attempts access
  const clientEve = new Client();
  const stateE = crypto.randomBytes(16).toString('hex');
  clientEve.cookies.sm_tg_state = stateE;
  const widgetE = makeWidgetData({ id: 70011, first_name: 'Eve_Attacker' });
  await clientEve.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetE, stateE, '/me')}`);

  const uEve = await db.one('SELECT id, telegram_user_id FROM users WHERE telegram_user_id = 70011');

  assert.notEqual(uEve.id, uAlice.id);
  assert.equal(uEve.telegram_user_id, 70011);
  assert.equal(uAlice.telegram_user_id, 70010);
});

test('Telegram tampering: forged or mismatched Telegram ID breaks HMAC and fails authentication', async () => {
  const client = new Client();
  const state = crypto.randomBytes(16).toString('hex');
  client.cookies.sm_tg_state = state;

  // Attacker signs payload for 70020, but tampers URL to say id=70021
  const widget = makeWidgetData({ id: 70020, first_name: 'Attacker' });
  widget.id = 70021; // Tampered!

  const res = await client.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widget, state, '/me')}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');

  // Verify no session was issued
  assert.ok(!res.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('Telegram UI: signin page renders switch-account guidance on Telegram tab', async () => {
  const client = new Client();
  const res = await client.get('/signin');
  assert.equal(res.status, 200);

  // Invariant: Clear account-switching guidance present
  assert.match(res.text, /data-tg-switch-tip/);
  assert.match(res.text, /Signing in with a different Telegram account\?/);
  assert.match(res.text, /Incognito or Private window/);
  assert.match(res.text, /web\.telegram\.org/);
  assert.match(res.text, /Open our bot/);

  // Invariant: Pradeep or any hardcoded founder ID is never embedded in template
  assert.doesNotMatch(res.text, /Log in as Pradeep/i);
  assert.doesNotMatch(res.text, /data-hardcoded-user/i);
});

/* ========================================================================== */
/* OBJECTIVE B: WhatsApp Fail-Closed & Unavailable State                       */
/* ========================================================================== */

test('WhatsApp production fail-closed: missing Meta credentials cause HTTP 503 and clear unavailable error', async () => {
  const client = new Client();

  // In simulated production environment (VERCEL=1, VERCEL_ENV=production), unconfigured WhatsApp fails closed
  const prevVercel = process.env.VERCEL;
  const prevVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  try {
    const res = await client.post('/api/auth/whatsapp/otp', {
      phone: '+919876543210',
      promotionalOptIn: false
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, 'whatsapp_unavailable');
    assert.match(res.json.message, /WhatsApp sign-in is currently unavailable/);
  } finally {
    if (prevVercel !== undefined) process.env.VERCEL = prevVercel;
    else delete process.env.VERCEL;
    if (prevVercelEnv !== undefined) process.env.VERCEL_ENV = prevVercelEnv;
    else delete process.env.VERCEL_ENV;
  }
});

test('WhatsApp unavailable UI: renders clear unavailable card and hides phone form when WhatsApp is offline', async () => {
  const client = new Client();

  const prevVercel = process.env.VERCEL;
  const prevVercelEnv = process.env.VERCEL_ENV;
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'production';
  try {
    const res = await client.get('/signin');
    assert.equal(res.status, 200);

    // When WhatsApp is unavailable, the unavailable card is rendered
    assert.match(res.text, /data-wa-unavailable/);
    assert.match(res.text, /WhatsApp sign-in is temporarily unavailable/);
    assert.match(res.text, /data-switch-to-telegram/);

    // And phone form is NOT rendered on the WhatsApp panel
    assert.doesNotMatch(res.text, /data-wa-phone-form/);

    // Telegram tab is active by default
    assert.match(res.text, /data-auth-tab="telegram"/);
    assert.match(res.text, /class="auth-tab-btn active"[^>]*data-auth-tab="telegram"/);
  } finally {
    if (prevVercel !== undefined) process.env.VERCEL = prevVercel;
    else delete process.env.VERCEL;
    if (prevVercelEnv !== undefined) process.env.VERCEL_ENV = prevVercelEnv;
    else delete process.env.VERCEL_ENV;
  }
});

test('WhatsApp bypass prevention: verify endpoint rejects missing challenge and invalid codes', async () => {
  const client = new Client();

  // Missing challenge ID
  const r1 = await client.post('/api/auth/whatsapp/verify', {
    phone: '+919876543210',
    code: '123456'
  });
  assert.equal(r1.status, 400);

  // Non-existent challenge ID
  const r2 = await client.post('/api/auth/whatsapp/verify', {
    challengeId: crypto.randomUUID(),
    phone: '+919876543210',
    code: '123456'
  });
  assert.equal(r2.status, 400);
});

/* ========================================================================== */
/* OBJECTIVE C: Consent & Stale UI State Guardrails                            */
/* ========================================================================== */

test('Consent: fresh visitor signin page has age and promotional checkboxes unchecked', async () => {
  const client = new Client();
  const res = await client.get('/signin');
  assert.equal(res.status, 200);

  // Age confirm must never have checked attribute in HTML
  assert.match(res.text, /data-age-confirm/);
  assert.doesNotMatch(res.text, /data-age-confirm[^>]*checked/);
});

test('Stale UI state: direct GET /signin?step=otp without active challenge cookie safely defaults to phone step', async () => {
  const client = new Client(); // Fresh visitor, no cookies

  const res = await client.get('/signin?step=otp');
  assert.equal(res.status, 200);

  // Invariant: Dummy phone +91 98****1234 is NEVER rendered
  assert.doesNotMatch(res.text, /\+91 98\*\*\*\*1234/);

  // Invariant: OTP panel is not active/unhidden for random visitor
  if (res.text.includes('data-wa-otp-card')) {
    assert.match(res.text, /data-wa-otp-card[^>]*hidden/);
  }
});

test('Stale cookie: expired sm_wa_step cookie is cleared and defaults to phone step', async () => {
  const client = new Client();
  // Set expired challenge cookie (> 15 minutes old)
  client.cookies.sm_wa_step = JSON.stringify({
    challengeId: crypto.randomUUID(),
    phoneMasked: '+91 98****9999',
    phone: '+919876549999',
    createdAt: Date.now() - 15 * 60 * 1000
  });

  const res = await client.get('/signin?step=otp');
  assert.equal(res.status, 200);

  // Invariant: Cookie is cleared with max-age=0
  const setCookies = res.headers.getSetCookie();
  const cleared = setCookies.find((c) => c.startsWith('sm_wa_step='));
  assert.ok(cleared, 'Expired sm_wa_step cookie must be cleared');
  assert.match(cleared, /max-age=0/i);
});

test('CSS Invariant: [hidden] attribute strictly enforces display: none !important', async () => {
  const client = new Client();
  const res = await client.get('/css/site.css');
  assert.equal(res.status, 200);

  // Verify CSS contains !important on hidden attribute
  assert.match(res.text, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(res.text, /\.otp-box\[hidden\]/);
});
