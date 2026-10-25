// test/telegram.test.js - Bot webhook: secret check, dedupe, commands, invite misuse protection.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, startServer, stopServer, Client, db, callsTo, clearCalls, createEvent } from './helpers.js';

const SECRET = { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_123456' };
let seq = 1000;
const msg = (from, text, extra = {}) => ({ update_id: ++seq, message: { message_id: seq, date: 0, chat: { id: from.id, type: 'private' }, from, text, ...extra } });

before(async () => { await resetDb(); await startServer(); });
after(stopServer);
beforeEach(clearCalls);

test('webhook rejects missing or wrong secret token', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/telegram/webhook', msg({ id: 1, first_name: 'A' }, '/start'))).status, 401);
  assert.equal((await c.post('/api/telegram/webhook', msg({ id: 1, first_name: 'A' }, '/start'), { 'x-telegram-bot-api-secret-token': 'wrong' })).status, 401);
  assert.equal(callsTo('sendMessage').length, 0);
});

test('/start replies with Mini App button and records the user; duplicate update is a no-op', async () => {
  const c = new Client();
  const u = msg({ id: 501, first_name: 'Meera' }, '/start');
  assert.equal((await c.post('/api/telegram/webhook', u, SECRET)).status, 200);
  const sent = callsTo('sendMessage');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].params.reply_markup.inline_keyboard[0][0].web_app.url.startsWith('https://sm.test'));
  const user = await db.one('SELECT bot_started FROM users WHERE telegram_user_id = 501');
  assert.equal(user.bot_started, true);
  const again = await c.post('/api/telegram/webhook', u, SECRET);
  assert.equal(again.json.duplicate, true);
  assert.equal(callsTo('sendMessage').length, 1);
});

test('/start event_<slug> deep link shows that event', async () => {
  await createEvent({ slug: 'deep-link-dinner', title: 'Deep Link Dinner' });
  await new Client().post('/api/telegram/webhook', msg({ id: 502, first_name: 'B' }, '/start event_deep-link-dinner'), SECRET);
  const m = callsTo('sendMessage')[0];
  assert.match(m.params.text, /Deep Link Dinner/);
  assert.match(m.params.reply_markup.inline_keyboard[0][0].web_app.url, /\/events\/deep-link-dinner$/);
});

test('/events, /help, /terms, /paysupport, /membership all answer', async () => {
  for (const cmd of ['/events', '/help', '/terms', '/paysupport', '/membership', '/mybookings']) {
    await new Client().post('/api/telegram/webhook', msg({ id: 503, first_name: 'C' }, cmd), SECRET);
  }
  assert.equal(callsTo('sendMessage').length, 6);
  const membership = callsTo('sendMessage')[4].params.text;
  assert.match(membership, /Announcing soon/);
});

test('/report stores a report; empty /report asks for details', async () => {
  await new Client().post('/api/telegram/webhook', msg({ id: 504, first_name: 'D' }, '/report'), SECRET);
  assert.equal((await db.one('SELECT count(*)::int n FROM reports')).n, 0);
  await new Client().post('/api/telegram/webhook', msg({ id: 504, first_name: 'D' }, '/report Someone was rude at the Chennai dinner'), SECRET);
  const r = await db.one('SELECT body, status FROM reports');
  assert.match(r.body, /rude/);
  assert.equal(r.status, 'new');
});

test('/start alerts opts in; /stopalerts opts out', async () => {
  await new Client().post('/api/telegram/webhook', msg({ id: 505, first_name: 'E' }, '/start alerts'), SECRET);
  assert.equal((await db.one('SELECT alerts_opt_in FROM users WHERE telegram_user_id = 505')).alerts_opt_in, true);
  await new Client().post('/api/telegram/webhook', msg({ id: 505, first_name: 'E' }, '/stopalerts'), SECRET);
  assert.equal((await db.one('SELECT alerts_opt_in FROM users WHERE telegram_user_id = 505')).alerts_opt_in, false);
});

test('joining with someone else\'s invite removes the joiner; owner join marks used', async () => {
  const owner = await db.one(`INSERT INTO users (telegram_user_id) VALUES (601) RETURNING id`);
  const ev = await createEvent();
  const b = await db.one(`INSERT INTO bookings (event_id, user_id, status) VALUES ($1, $2, 'confirmed') RETURNING id`, [ev.id, owner.id]);
  await db.query(`INSERT INTO invite_links (booking_id, user_id, chat_id, link, expires_at) VALUES ($1, $2, -1001111111111, 'https://t.me/+owned1', now() + interval '1 day')`, [b.id, owner.id]);
  const cm = (userId, link) => ({
    update_id: ++seq,
    chat_member: { chat: { id: -1001111111111, type: 'supergroup' }, from: { id: userId }, date: 0,
      old_chat_member: { status: 'left', user: { id: userId } }, new_chat_member: { status: 'member', user: { id: userId } },
      invite_link: { invite_link: link } }
  });
  await new Client().post('/api/telegram/webhook', cm(777, 'https://t.me/+owned1'), SECRET);
  assert.equal(callsTo('banChatMember')[0].params.user_id, 777);
  assert.equal(callsTo('unbanChatMember')[0].params.only_if_banned, true);
  const inv = await db.one(`SELECT used_at, revoked_at FROM invite_links WHERE link = 'https://t.me/+owned1'`);
  assert.ok(inv.revoked_at);

  await db.query(`INSERT INTO invite_links (booking_id, user_id, chat_id, link, expires_at) VALUES ($1, $2, -1001111111111, 'https://t.me/+owned2', now() + interval '1 day')`, [b.id, owner.id]);
  clearCalls();
  await new Client().post('/api/telegram/webhook', cm(601, 'https://t.me/+owned2'), SECRET);
  assert.equal(callsTo('banChatMember').length, 0);
  assert.ok((await db.one(`SELECT used_at FROM invite_links WHERE link = 'https://t.me/+owned2'`)).used_at);
});

test('Telegram API failure returns 500 and releases the dedupe row so Telegram retries', async () => {
  const { stubOnce } = await import('./helpers.js');
  stubOnce('tg:sendMessage', () => { const e = new Error('Too Many Requests'); e.code = 429; throw e; });
  const u = msg({ id: 506, first_name: 'F' }, '/help');
  assert.equal((await new Client().post('/api/telegram/webhook', u, SECRET)).status, 500);
  assert.equal((await db.one(`SELECT count(*)::int n FROM webhook_events WHERE provider = 'telegram_update' AND event_id = $1`, [String(u.update_id)])).n, 0);
  assert.equal((await new Client().post('/api/telegram/webhook', u, SECRET)).status, 200);
});
