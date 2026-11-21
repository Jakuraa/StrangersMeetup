// test/telegram-widget-callback.test.js - Automated tests for Telegram Login Widget redirect flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDb, startServer, stopServer, Client, makeWidgetData, db, BOT_TOKEN } from './helpers.js';
import { sealWidgetState, TG_WIDGET_MAX_AGE_S } from '../lib/telegram/auth.js';

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

function makeState({ ageConfirmed = true, next = '/me', exp } = {}) {
  return sealWidgetState({ ageConfirmed, next, exp });
}

async function seedOnboardedUser(id, alias = 'User', ageConfirmed = true) {
  await db.query(
    `INSERT INTO users (telegram_user_id, alias, display_name, age_confirmed_21, status, onboarding_completed, onboarding_step)
     VALUES ($1, $2, $2, $3, 'active', true, 6)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       onboarding_completed = true,
       onboarding_step = 6,
       age_confirmed_21 = EXCLUDED.age_confirmed_21`,
    [id, alias, ageConfirmed]
  );
}

test('valid Telegram widget callback establishes session, clears state cookie, and redirects to next', async () => {
  const c = new Client();
  const state = makeState({ ageConfirmed: true, next: '/admin' });
  c.cookies.sm_tg_state = state;

  await seedOnboardedUser(5001, 'Aditi', true);
  const widget = makeWidgetData({ id: 5001, first_name: 'Aditi', username: 'aditi_dev' });
  const qs = buildCallbackQuery(widget, state, '/admin');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');

  // Verify session cookie was issued with HttpOnly and SameSite=Lax
  const setCookies = r.headers.getSetCookie();
  const sessionCookie = setCookies.find((h) => h.startsWith('sm_session='));
  assert.ok(sessionCookie, 'sm_session cookie must be present');
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=Lax/i);

  // Verify state cookie was cleared
  const clearedStateCookie = setCookies.find((h) => h.startsWith('sm_tg_state='));
  assert.ok(clearedStateCookie, 'sm_tg_state must be cleared');
  assert.match(clearedStateCookie, /max-age=0/i);

  // Verify user in database has age confirmed
  const u = await db.one('SELECT telegram_user_id, alias, age_confirmed_21 FROM users WHERE telegram_user_id = 5001');
  assert.equal(u.telegram_user_id, 5001);
  assert.equal(u.alias, 'Aditi');
  assert.equal(u.age_confirmed_21, true);

  // Verify audit record in onboarding_consents
  const consent = await db.one(
    `SELECT confirmed, consent_type FROM onboarding_consents WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = 5001)`
  );
  assert.equal(consent.confirmed, true);
  assert.equal(consent.consent_type, 'age_21_plus');
});

test('owner ID matching ADMIN_BOOTSTRAP_TELEGRAM_ID is automatically bootstrapped as super_admin upon reaching /admin', async () => {
  const c = new Client();
  const state = makeState({ ageConfirmed: true, next: '/admin' });
  c.cookies.sm_tg_state = state;

  // process.env.ADMIN_BOOTSTRAP_TELEGRAM_ID is 900000001 in test/helpers.js
  const ownerWidget = makeWidgetData({ id: 900000001, first_name: 'PlatformOwner' });
  const qs = buildCallbackQuery(ownerWidget, state, '/admin');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');

  // Navigate to /admin using the issued session cookie
  const adminPage = await c.get('/admin');
  assert.equal(adminPage.status, 200);

  // Confirm database record has role super_admin
  const adminRow = await db.one('SELECT telegram_user_id, role, active FROM admin_users WHERE telegram_user_id = 900000001');
  assert.equal(adminRow.role, 'super_admin');
  assert.equal(adminRow.active, true);
});

test('user authenticating without 21+ consent does not have consent fabricated', async () => {
  const c = new Client();
  // State generated with ageConfirmed = false (user did not check 21+ confirmation)
  const state = makeState({ ageConfirmed: false, next: '/me' });
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5090, first_name: 'NoAgeUser' });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);

  // User is created, but age_confirmed_21 must remain false
  const u = await db.one('SELECT id, telegram_user_id, age_confirmed_21 FROM users WHERE telegram_user_id = 5090');
  assert.equal(u.age_confirmed_21, false, 'age_confirmed_21 must be false when user did not check 21+');

  // No audit record in onboarding_consents
  const consent = (await db.query('SELECT * FROM onboarding_consents WHERE user_id = $1', [u.id])).rows;
  assert.equal(consent.length, 0, 'No consent record must be fabricated');
});

test('existing user with previously recorded consent preserves consent even if subsequent state is unconfirmed', async () => {
  const c = new Client();
  // Seed existing user with age_confirmed_21 = true
  await seedOnboardedUser(5091, 'StickyConsentUser', true);

  // Subsequent login with ageConfirmed = false in state
  const state = makeState({ ageConfirmed: false, next: '/me' });
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5091, first_name: 'StickyConsentUser' });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);

  const u = await db.one('SELECT telegram_user_id, age_confirmed_21 FROM users WHERE telegram_user_id = 5091');
  assert.equal(u.age_confirmed_21, true, 'Sticky consent must be preserved for existing user');
});

test('existing user without recorded consent does not have consent fabricated on login', async () => {
  const c = new Client();
  // Seed existing user with age_confirmed_21 = false
  await seedOnboardedUser(5092, 'LegacyNoAgeUser', false);

  // Login with ageConfirmed = false
  const state = makeState({ ageConfirmed: false, next: '/me' });
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5092, first_name: 'LegacyNoAgeUser' });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);

  const u = await db.one('SELECT telegram_user_id, age_confirmed_21 FROM users WHERE telegram_user_id = 5092');
  assert.equal(u.age_confirmed_21, false, 'Historical unconfirmed status must not be altered');
});

test('user tampering with state token is rejected with error=expired', async () => {
  const c = new Client();
  const validState = makeState({ ageConfirmed: true, next: '/me' });
  const tamperedState = validState + 'injected_tamper';
  c.cookies.sm_tg_state = tamperedState;

  const widget = makeWidgetData({ id: 5093, first_name: 'Tamperer' });
  const qs = buildCallbackQuery(widget, tamperedState, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=expired&next=%2Fme');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('replaying a state nonce is rejected with error=replay', async () => {
  const c = new Client();
  const state = makeState({ ageConfirmed: true, next: '/me' });
  c.cookies.sm_tg_state = state;

  await seedOnboardedUser(5094, 'StateReplayer', true);
  const widget1 = makeWidgetData({ id: 5094, first_name: 'StateReplayer' });
  const qs1 = buildCallbackQuery(widget1, state, '/me');

  // First use: succeeds
  const r1 = await c.get(`/auth/telegram/widget-callback?${qs1}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), '/me');

  // Second use with the same state (even with fresh widget signature): rejected as replay
  c.cookies.sm_tg_state = state; // Re-supply state cookie
  const widget2 = makeWidgetData({ id: 5094, first_name: 'StateReplayer' });
  const qs2 = buildCallbackQuery(widget2, state, '/me');

  const r2 = await c.get(`/auth/telegram/widget-callback?${qs2}`);
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/signin?error=replay&next=%2Fme');
});

test('missing state cookie is rejected and redirects to signin with error=expired', async () => {
  const c = new Client(); // no sm_tg_state cookie set
  const state = makeState();
  const widget = makeWidgetData({ id: 5002, first_name: 'Bob' });
  const qs = buildCallbackQuery(widget, state, '/organiser');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=expired&next=%2Forganiser');

  // Verify no session cookie was set
  const setCookies = r.headers.getSetCookie();
  assert.ok(!setCookies.some((h) => h.startsWith('sm_session=')));
});

test('mismatched state cookie is rejected and redirects to signin with error=expired', async () => {
  const c = new Client();
  c.cookies.sm_tg_state = makeState({ ageConfirmed: true });
  const widget = makeWidgetData({ id: 5003, first_name: 'Carol' });
  const qs = buildCallbackQuery(widget, makeState({ ageConfirmed: true }), '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=expired&next=%2Fme');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('invalid HMAC signature is rejected and redirects to signin with error=invalid_telegram_auth', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5004, first_name: 'Dan' });
  widget.hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // forged hash
  const qs = buildCallbackQuery(widget, state, '/admin');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fadmin');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('tampered field (e.g. ID altered after signing) is rejected', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5005, first_name: 'Eve' });
  widget.id = 5006; // altered ID
  const qs = buildCallbackQuery(widget, state, '/admin');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fadmin');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('stale auth_date (> 300s / 5 minutes old) is rejected', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  const staleTimestamp = Math.floor(Date.now() / 1000) - 305; // 305s old (> 300s window)
  const widget = makeWidgetData({ id: 5007, first_name: 'Frank' }, { authDate: staleTimestamp });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('future auth_date (> 30s clock skew allowance) is rejected', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  const futureTimestamp = Math.floor(Date.now() / 1000) + 60; // 60s in future (> 30s skew tolerance)
  const widget = makeWidgetData({ id: 5009, first_name: 'FutureUser' }, { authDate: futureTimestamp });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('valid auth_date with minor clock skew (<= 30s) is accepted', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  await seedOnboardedUser(5015, 'SkewUser');
  const skewTimestamp = Math.floor(Date.now() / 1000) + 15; // 15s in future (within 30s skew allowance)
  const widget = makeWidgetData({ id: 5015, first_name: 'SkewUser' }, { authDate: skewTimestamp });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/me');
  assert.ok(r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('anti-replay protection rejects duplicate callback hash', async () => {
  await seedOnboardedUser(5008, 'Grace');
  const widget = makeWidgetData({ id: 5008, first_name: 'Grace' });

  // First attempt: succeeds
  const c1 = new Client();
  const state1 = makeState();
  c1.cookies.sm_tg_state = state1;
  const qs1 = buildCallbackQuery(widget, state1, '/me');
  const r1 = await c1.get(`/auth/telegram/widget-callback?${qs1}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), '/me');
  assert.ok(r1.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));

  // Second attempt with exact same signed widget payload: rejected as replay
  const c2 = new Client();
  const state2 = makeState();
  c2.cookies.sm_tg_state = state2;
  const qs2 = buildCallbackQuery(widget, state2, '/me');
  const r2 = await c2.get(`/auth/telegram/widget-callback?${qs2}`);
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/signin?error=replay&next=%2Fme');
  assert.ok(!r2.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('unsafe redirect destinations are sanitized to /me', async () => {
  const unsafeTargets = [
    '//evil.com',
    'https://evil.com/phish',
    'javascript:alert(1)',
    'data:text/html,<h1>pwn</h1>',
    '/\\evil.com'
  ];

  for (let i = 0; i < unsafeTargets.length; i++) {
    const c = new Client();
    const state = makeState();
    c.cookies.sm_tg_state = state;

    await seedOnboardedUser(5010 + i, `Target${i}`);
    const widget = makeWidgetData({ id: 5010 + i, first_name: `Target${i}` });
    const qs = buildCallbackQuery(widget, state, unsafeTargets[i]);

    const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/me', `Unsafe destination ${unsafeTargets[i]} must be sanitized to /me`);
  }
});

test('payload containing is_premium is verified and establishes session', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  await seedOnboardedUser(5020, 'PremiumUser');
  const widget = makeWidgetData({ id: 5020, first_name: 'PremiumUser', username: 'vip_user', is_premium: 'true' });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/me');
  assert.ok(r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));

  const u = await db.one('SELECT telegram_user_id, alias FROM users WHERE telegram_user_id = 5020');
  assert.equal(u.telegram_user_id, 5020);
  assert.equal(u.alias, 'PremiumUser');
});

test('payload containing language_code is verified and establishes session', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  await seedOnboardedUser(5021, 'LangUser');
  const widget = makeWidgetData({ id: 5021, first_name: 'LangUser', username: 'lang_user', language_code: 'en' });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/me');
  assert.ok(r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('payload containing multiple extra Telegram fields is verified', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  await seedOnboardedUser(5022, 'FullMeta');
  const widget = makeWidgetData({
    id: 5022,
    first_name: 'FullMeta',
    last_name: 'User',
    username: 'meta_user',
    photo_url: 'https://t.me/i/userpic/320/meta.jpg',
    is_premium: 'true',
    language_code: 'hi',
    allows_write_to_pm: 'true'
  });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/me');
  assert.ok(r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));

  const u = await db.one('SELECT telegram_user_id, alias FROM users WHERE telegram_user_id = 5022');
  assert.equal(u.alias, 'FullMeta User');
});

test('missing required Telegram fields (hash, id, or auth_date) are rejected', async () => {
  // Missing hash
  const c1 = new Client();
  const state1 = makeState();
  c1.cookies.sm_tg_state = state1;
  const widgetNoHash = makeWidgetData({ id: 5030, first_name: 'NoHash' });
  delete widgetNoHash.hash;
  const r1 = await c1.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetNoHash, state1, '/me')}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
  assert.ok(!r1.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));

  // Missing id
  const c2 = new Client();
  const state2 = makeState();
  c2.cookies.sm_tg_state = state2;
  const widgetNoId = makeWidgetData({ id: 5031, first_name: 'NoId' });
  delete widgetNoId.id;
  const r2 = await c2.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetNoId, state2, '/me')}`);
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');

  // Missing auth_date
  const c3 = new Client();
  const state3 = makeState();
  c3.cookies.sm_tg_state = state3;
  const widgetNoDate = makeWidgetData({ id: 5032, first_name: 'NoDate' });
  delete widgetNoDate.auth_date;
  const r3 = await c3.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetNoDate, state3, '/me')}`);
  assert.equal(r3.status, 302);
  assert.equal(r3.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
});

test('malformed required fields (invalid hash format, non-numeric id) are rejected', async () => {
  // Malformed hash (short non-64 hex)
  const c1 = new Client();
  const state1 = makeState();
  c1.cookies.sm_tg_state = state1;
  const widgetShortHash = { ...makeWidgetData({ id: 5033, first_name: 'ShortHash' }), hash: 'badhash' };
  const r1 = await c1.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetShortHash, state1, '/me')}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');

  // Malformed ID (non-numeric string)
  const c2 = new Client();
  const state2 = makeState();
  c2.cookies.sm_tg_state = state2;
  const widgetBadId = makeWidgetData({ id: 5034, first_name: 'BadId' });
  widgetBadId.id = 'not-a-number';
  const r2 = await c2.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetBadId, state2, '/me')}`);
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
});

test('payload signed with a different bot token is rejected', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  const differentToken = '987654321:DIFFERENT_BOT_TOKEN_1234567890';
  const widget = makeWidgetData({ id: 5035, first_name: 'WrongBot' }, { token: differentToken });
  const qs = buildCallbackQuery(widget, state, '/admin');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fadmin');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('duplicate security-sensitive parameters (HTTP parameter pollution) are rejected', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5036, first_name: 'DupParam' });
  const qs = buildCallbackQuery(widget, state, '/me') + '&id=9999999';

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('unauthorized user cannot access /admin and cannot bootstrap administrator role', async () => {
  const c = new Client();
  const state = makeState();
  c.cookies.sm_tg_state = state;

  await seedOnboardedUser(888888888, 'NormalUser');
  // ID 888888888 !== ADMIN_BOOTSTRAP_TELEGRAM_ID (which is 900000001)
  const widget = makeWidgetData({ id: 888888888, first_name: 'NormalUser' });
  const qs = buildCallbackQuery(widget, state, '/admin');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');

  // Attempt to access /admin with the issued attendee session
  const adminRes = await c.get('/admin');
  assert.equal(adminRes.status, 403, 'Unauthorized attendee must receive 403 on /admin');

  // Verify database: user 888888888 must NOT be in admin_users
  const adminRow = await db.one('SELECT * FROM admin_users WHERE telegram_user_id = 888888888');
  assert.equal(adminRow, null, 'User must not exist in admin_users');
});
