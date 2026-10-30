// test/auth.test.js - Telegram initData / Login Widget validation, replay, sessions, CSRF.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, makeInitData, makeWidgetData, signedInClient, db } from './helpers.js';
import { validateInitData } from '../lib/telegram/auth.js';

before(async () => { await resetDb(); await startServer(); });
after(stopServer);

test('valid initData is accepted and issues an httpOnly session cookie', async () => {
  const c = new Client();
  const r = await c.post('/api/auth/telegram', { initData: makeInitData({ id: 4242, first_name: 'Asha' }) });
  assert.equal(r.status, 200);
  assert.ok(r.json.csrf);
  const setCookie = r.headers.getSetCookie().join('\n');
  assert.match(setCookie, /sm_session=.+HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const me = await c.get('/api/me');
  assert.equal(me.json.user.alias, 'Asha');
  const row = await db.one('SELECT telegram_user_id, age_confirmed_21 FROM users WHERE telegram_user_id = 4242');
  assert.equal(row.age_confirmed_21, false);
});

test('bad hash is rejected', async () => {
  const data = makeInitData({ id: 1 }).replace(/hash=[0-9a-f]{4}/, 'hash=0000');
  const r = await new Client().post('/api/auth/telegram', { initData: data });
  assert.equal(r.status, 401);
});

test('initData signed with a different bot token is rejected', async () => {
  const r = await new Client().post('/api/auth/telegram', { initData: makeInitData({ id: 2 }, { token: '999:otherbottokenotherbottokenotherbot' }) });
  assert.equal(r.status, 401);
});

test('stale initData (auth_date > 300s) is rejected', async () => {
  const r = await new Client().post('/api/auth/telegram', { initData: makeInitData({ id: 3 }, { authDate: Math.floor(Date.now() / 1000) - 301 }) });
  assert.equal(r.status, 401);
});

test('replayed initData is rejected', async () => {
  const data = makeInitData({ id: 5, first_name: 'R' });
  assert.equal((await new Client().post('/api/auth/telegram', { initData: data })).status, 200);
  const again = await new Client().post('/api/auth/telegram', { initData: data });
  assert.equal(again.status, 401);
  assert.equal(again.json.error, 'replay');
});

test('client-sent user ids are ignored: identity comes only from the signed payload', async () => {
  const c = new Client();
  const r = await c.post('/api/auth/telegram', { initData: makeInitData({ id: 6 }), telegramUserId: 999, userId: 'x' });
  assert.equal(r.status, 400); // unknown keys are rejected by the schema
});

test('tampered user field after signing is rejected', async () => {
  const p = new URLSearchParams(makeInitData({ id: 7 }));
  p.set('user', JSON.stringify({ id: 8 }));
  assert.equal((await new Client().post('/api/auth/telegram', { initData: p.toString() })).status, 401);
});

test('legacy Login Widget payload validates; tampering fails', async () => {
  const good = makeWidgetData({ id: 9, first_name: 'W' });
  assert.equal((await new Client().post('/api/auth/telegram', { widget: good, ageConfirmed: true })).status, 200);
  const u = await db.one('SELECT age_confirmed_21 FROM users WHERE telegram_user_id = 9');
  assert.equal(u.age_confirmed_21, true);
  const bad = { ...makeWidgetData({ id: 10, first_name: 'W' }), id: 11 };
  assert.equal((await new Client().post('/api/auth/telegram', { widget: bad })).status, 401);
});

test('legacy Login Widget payload validates with extra fields and preserves last_name', async () => {
  const good = makeWidgetData({ id: 91, first_name: 'Vikram', last_name: 'Seth', is_premium: true });
  assert.equal((await new Client().post('/api/auth/telegram', { widget: good, ageConfirmed: true })).status, 200);
  const u = await db.one('SELECT alias, age_confirmed_21 FROM users WHERE telegram_user_id = 91');
  assert.equal(u.alias, 'Vikram Seth');
  assert.equal(u.age_confirmed_21, true);
});

test('unit: validateInitData constant-time path rejects non-hex hash', () => {
  const p = new URLSearchParams(makeInitData({ id: 12 }));
  p.set('hash', 'zz');
  assert.equal(validateInitData(p.toString(), process.env.TELEGRAM_BOT_TOKEN).ok, false);
});

test('mutations without CSRF token are rejected', async () => {
  const c = await signedInClient({ ageConfirmed: false });
  const r = await c.post('/api/auth/confirm-age', {}, { 'x-csrf-token': 'nope' });
  assert.equal(r.status, 403);
});

test('forged session cookie is ignored', async () => {
  const c = new Client();
  c.cookies.sm_session = 'eyJ1IjoiYWJjIiwiZXhwIjo5OTk5OTk5OTk5fQ.forged';
  const me = await c.get('/api/me');
  assert.equal(me.json.user, null);
});

test('banned users cannot sign in', async () => {
  await db.query(`INSERT INTO users (telegram_user_id, status) VALUES (13, 'banned')`);
  const r = await new Client().post('/api/auth/telegram', { initData: makeInitData({ id: 13 }) });
  assert.equal(r.status, 403);
});

test('dev login is unavailable unless DEV_LOGIN=true off-Vercel', async () => {
  assert.equal((await new Client().post('/api/auth/dev', {})).status, 404);
});

test('auth endpoint is rate limited per IP', async () => {
  let last;
  for (let i = 0; i < 25; i++) last = await new Client({ ip: '10.9.9.9' }).post('/api/auth/telegram', { initData: 'hash=00' });
  assert.equal(last.status, 429);
});

test('signed-out /me returns 302 redirect to /signin with next preserved', async () => {
  const r = await new Client().get('/me');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/signin?next=%2Fme');
  assert.match(r.headers.get('cache-control') || '', /no-store/);
});

test('signed-in user reaches /me with status 200', async () => {
  const c = await signedInClient('guest');
  const r = await c.get('/me');
  assert.equal(r.status, 200);
  assert.match(r.text, /My bookings/);
});

test('signin page explains why Telegram is used without passwords', async () => {
  const r = await new Client().get('/signin');
  assert.equal(r.status, 200);
  assert.match(r.text, /Why sign in with Telegram\?/);
  assert.match(r.text, /No passwords to manage/);
  assert.match(r.text, /Your privacy stays protected/);
  assert.match(r.text, /Direct venue delivery/);
});
