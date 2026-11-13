// test/telegram-widget-callback.test.js - Automated tests for Telegram Login Widget redirect flow.
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

test('valid Telegram widget callback establishes session, clears state cookie, and redirects to next', async () => {
  const c = new Client();
  const state = crypto.randomBytes(16).toString('hex');
  c.cookies.sm_tg_state = state;

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

  // Verify user in database
  const u = await db.one('SELECT telegram_user_id, alias, age_confirmed_21 FROM users WHERE telegram_user_id = 5001');
  assert.equal(u.telegram_user_id, 5001);
  assert.equal(u.alias, 'Aditi');
  assert.equal(u.age_confirmed_21, true);
});

test('owner ID matching ADMIN_BOOTSTRAP_TELEGRAM_ID is automatically bootstrapped as super_admin upon reaching /admin', async () => {
  const c = new Client();
  const state = crypto.randomBytes(16).toString('hex');
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

test('missing state cookie is rejected and redirects to signin with error=expired', async () => {
  const c = new Client(); // no sm_tg_state cookie set
  const state = crypto.randomBytes(16).toString('hex');
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
  c.cookies.sm_tg_state = 'cookie-state-12345';
  const widget = makeWidgetData({ id: 5003, first_name: 'Carol' });
  const qs = buildCallbackQuery(widget, 'url-state-different', '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=expired&next=%2Fme');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('invalid HMAC signature is rejected and redirects to signin with error=invalid_telegram_auth', async () => {
  const c = new Client();
  const state = crypto.randomBytes(16).toString('hex');
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
  const state = crypto.randomBytes(16).toString('hex');
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5005, first_name: 'Eve' });
  widget.id = 5006; // altered ID
  const qs = buildCallbackQuery(widget, state, '/admin');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fadmin');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('expired auth_date (> 86400s old) is rejected', async () => {
  const c = new Client();
  const state = crypto.randomBytes(16).toString('hex');
  c.cookies.sm_tg_state = state;

  const staleTimestamp = Math.floor(Date.now() / 1000) - 86500; // >24h old
  const widget = makeWidgetData({ id: 5007, first_name: 'Frank' }, { authDate: staleTimestamp });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
  assert.ok(!r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('anti-replay protection rejects duplicate callback hash', async () => {
  const widget = makeWidgetData({ id: 5008, first_name: 'Grace' });

  // First attempt: succeeds
  const c1 = new Client();
  const state1 = crypto.randomBytes(16).toString('hex');
  c1.cookies.sm_tg_state = state1;
  const qs1 = buildCallbackQuery(widget, state1, '/me');
  const r1 = await c1.get(`/auth/telegram/widget-callback?${qs1}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), '/me');
  assert.ok(r1.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));

  // Second attempt with exact same signed widget payload (even with fresh state): rejected as replay
  const c2 = new Client();
  const state2 = crypto.randomBytes(16).toString('hex');
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
    const state = crypto.randomBytes(16).toString('hex');
    c.cookies.sm_tg_state = state;

    const widget = makeWidgetData({ id: 5010 + i, first_name: `Target${i}` });
    const qs = buildCallbackQuery(widget, state, unsafeTargets[i]);

    const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/me', `Unsafe destination ${unsafeTargets[i]} must be sanitized to /me`);
  }
});

test('payload containing is_premium is verified and establishes session', async () => {
  const c = new Client();
  const state = crypto.randomBytes(16).toString('hex');
  c.cookies.sm_tg_state = state;

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
  const state = crypto.randomBytes(16).toString('hex');
  c.cookies.sm_tg_state = state;

  const widget = makeWidgetData({ id: 5021, first_name: 'LangUser', username: 'lang_user', language_code: 'en' });
  const qs = buildCallbackQuery(widget, state, '/me');

  const r = await c.get(`/auth/telegram/widget-callback?${qs}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/me');
  assert.ok(r.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));
});

test('payload containing multiple extra Telegram fields is verified', async () => {
  const c = new Client();
  const state = crypto.randomBytes(16).toString('hex');
  c.cookies.sm_tg_state = state;

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
  const state = crypto.randomBytes(16).toString('hex');

  // Missing hash
  const c1 = new Client();
  c1.cookies.sm_tg_state = state;
  const widgetNoHash = makeWidgetData({ id: 5030, first_name: 'NoHash' });
  delete widgetNoHash.hash;
  const r1 = await c1.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetNoHash, state, '/me')}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
  assert.ok(!r1.headers.getSetCookie().some((h) => h.startsWith('sm_session=')));

  // Missing id
  const c2 = new Client();
  c2.cookies.sm_tg_state = state;
  const widgetNoId = makeWidgetData({ id: 5031, first_name: 'NoId' });
  delete widgetNoId.id;
  const r2 = await c2.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetNoId, state, '/me')}`);
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');

  // Missing auth_date
  const c3 = new Client();
  c3.cookies.sm_tg_state = state;
  const widgetNoDate = makeWidgetData({ id: 5032, first_name: 'NoDate' });
  delete widgetNoDate.auth_date;
  const r3 = await c3.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetNoDate, state, '/me')}`);
  assert.equal(r3.status, 302);
  assert.equal(r3.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
});

test('malformed required fields (invalid hash format, non-numeric id) are rejected', async () => {
  const state = crypto.randomBytes(16).toString('hex');

  // Malformed hash (short non-64 hex)
  const c1 = new Client();
  c1.cookies.sm_tg_state = state;
  const widgetShortHash = { ...makeWidgetData({ id: 5033, first_name: 'ShortHash' }), hash: 'badhash' };
  const r1 = await c1.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetShortHash, state, '/me')}`);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');

  // Malformed ID (non-numeric string)
  const c2 = new Client();
  c2.cookies.sm_tg_state = state;
  const widgetBadId = makeWidgetData({ id: 5034, first_name: 'BadId' });
  widgetBadId.id = 'not-a-number';
  const r2 = await c2.get(`/auth/telegram/widget-callback?${buildCallbackQuery(widgetBadId, state, '/me')}`);
  assert.equal(r2.status, 302);
  assert.equal(r2.headers.get('location'), '/signin?error=invalid_telegram_auth&next=%2Fme');
});

test('payload signed with a different bot token is rejected', async () => {
  const c = new Client();
  const state = crypto.randomBytes(16).toString('hex');
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
  const state = crypto.randomBytes(16).toString('hex');
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
  const state = crypto.randomBytes(16).toString('hex');
  c.cookies.sm_tg_state = state;

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
