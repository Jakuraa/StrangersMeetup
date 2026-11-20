// test/telegram-explicit-initiation.test.js - Tests for explicit Telegram widget initiation, age confirmation, and clean logout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, signedInClient, BOT_TOKEN } from './helpers.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(stopServer);

test('1. /signin server-rendered HTML does not inject Telegram widget script automatically', async () => {
  const c = new Client();
  const res = await c.get('/signin');
  assert.equal(res.status, 200);
  const html = res.text;

  // Telegram widget script must NEVER be injected in initial HTML
  assert.doesNotMatch(html, /<script[^>]+src=["']https:\/\/telegram\.org\/js\/telegram-widget\.js/i);

  // Must render explicit initiation controls
  assert.match(html, /data-tg-flow/);
  assert.match(html, /data-tg-start-btn/);
  assert.match(html, /data-age-confirm/);
  assert.match(html, /data-tg-widget-wrap[^>]*hidden/);
  assert.match(html, /data-tg-widget-loading/);
  assert.match(html, /data-tg-widget/);
  assert.match(html, /Continue with Telegram/);
});

test('2. Age confirmation checkbox is unchecked by default in initial markup', async () => {
  const c = new Client();
  const res = await c.get('/signin');
  assert.equal(res.status, 200);
  const html = res.text;

  // Checkbox must not have checked attribute
  assert.match(html, /<input[^>]+type=["']checkbox["'][^>]+data-age-confirm/i);
  assert.doesNotMatch(html, /<input[^>]+data-age-confirm[^>]+checked/i);
});

test('3. POST /api/auth/logout clears session and transient auth flow cookies', async () => {
  const c = await signedInClient('guest');

  // Verify authenticated before logout
  const meBefore = await c.get('/api/me');
  assert.equal(meBefore.status, 200);
  assert.ok(meBefore.json.user);

  // Invoke logout
  const logoutRes = await c.post('/api/auth/logout', {});
  assert.equal(logoutRes.status, 200);
  assert.deepEqual(logoutRes.json, { ok: true });

  // Verify cookies were cleared with max-age=0
  const setCookies = logoutRes.headers.getSetCookie();
  const sessionClear = setCookies.find((h) => h.startsWith('sm_session='));
  assert.ok(sessionClear, 'sm_session must be cleared');
  assert.match(sessionClear, /max-age=0/i);

  const waStepClear = setCookies.find((h) => h.startsWith('sm_wa_step='));
  assert.ok(waStepClear, 'sm_wa_step must be cleared');
  assert.match(waStepClear, /max-age=0/i);

  const tgStateClear = setCookies.find((h) => h.startsWith('sm_tg_state='));
  assert.ok(tgStateClear, 'sm_tg_state must be cleared');
  assert.match(tgStateClear, /max-age=0/i);

  // Check subsequent /api/me call reflects logged-out state
  const meAfter = await c.get('/api/me');
  assert.equal(meAfter.status, 200);
  assert.equal(meAfter.json.user, null);

  // Check /me redirects to signin with next parameter preserved
  const protectedRes = await c.get('/me');
  assert.equal(protectedRes.status, 302);
  assert.equal(protectedRes.headers.get('location'), '/signin?next=%2Fme');
});

test('4. Refreshing /signin after logout maintains clean signed-out state', async () => {
  const c = new Client();
  const res1 = await c.get('/signin');
  assert.equal(res1.status, 200);

  const res2 = await c.get('/signin');
  assert.equal(res2.status, 200);
  assert.doesNotMatch(res2.text, /<script[^>]+src=["']https:\/\/telegram\.org\/js\/telegram-widget\.js/i);
  assert.match(res2.text, /data-tg-start-btn/);

  const me = await c.get('/api/me');
  assert.equal(me.json.user, null);
});
