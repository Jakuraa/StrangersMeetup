// test/payments.test.js - Telegram Stars membership (ticket payments: see superprofile-checkout.test.js).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resetDb, startServer, stopServer, Client, db, callsTo, clearCalls, signedInClient
} from './helpers.js';

const TG_SECRET = { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_123456' };
const CRON = { authorization: 'Bearer test-cron-secret-0123456789' };

before(async () => { await resetDb(); await startServer(); });
after(stopServer);
beforeEach(clearCalls);

test('cron endpoints reject missing/wrong CRON_SECRET', async () => {
  assert.equal((await new Client().get('/api/cron/daily')).status, 401);
  assert.equal((await new Client().get('/api/cron/daily', { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await new Client().get('/api/cron/daily', CRON)).status, 200);
});

// ---------------- Membership (Telegram Stars) ----------------

let upd = 50000;
const tgUpdate = (body) => new Client().post('/api/telegram/webhook', { update_id: ++upd, ...body }, TG_SECRET);

test('membership checkout refuses while Stars price is NULL', async () => {
  const c = await signedInClient();
  const r = await c.post('/api/membership/checkout', { tierCode: 'tier_1' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'price_not_set');
});

test('Stars membership: invoice → pre_checkout → payment → entitlement + invite to the tier chat; duplicate charge no-op; expiry revokes', async () => {
  await db.query(`UPDATE membership_tiers SET stars_amount = 250 WHERE code = 'tier_1'`);
  const c = await signedInClient();
  const r = await c.post('/api/membership/checkout', { tierCode: 'tier_1' });
  assert.equal(r.status, 200, r.text);
  const inv = callsTo('createInvoiceLink')[0].params;
  assert.equal(inv.currency, 'XTR');
  assert.equal(inv.subscription_period, 2592000);
  assert.equal(inv.prices[0].amount, 250);
  assert.equal(inv.provider_token, '');
  assert.ok(Buffer.byteLength(inv.payload) <= 128);

  // pre_checkout: wrong payer rejected, wrong amount rejected, correct approved
  await tgUpdate({ pre_checkout_query: { id: 'q1', from: { id: 1 }, currency: 'XTR', total_amount: 250, invoice_payload: inv.payload } });
  await tgUpdate({ pre_checkout_query: { id: 'q2', from: { id: c.tgId }, currency: 'XTR', total_amount: 1, invoice_payload: inv.payload } });
  await tgUpdate({ pre_checkout_query: { id: 'q3', from: { id: c.tgId }, currency: 'XTR', total_amount: 250, invoice_payload: inv.payload } });
  const answers = callsTo('answerPreCheckoutQuery').map((a) => [a.params.pre_checkout_query_id, a.params.ok]);
  assert.deepEqual(answers, [['q1', false], ['q2', false], ['q3', true]]);

  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const sp = { currency: 'XTR', total_amount: 250, invoice_payload: inv.payload, telegram_payment_charge_id: 'stxCHARGE1', provider_payment_charge_id: 'p1', subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true };
  const payMsg = { message: { message_id: 1, date: 0, chat: { id: c.tgId, type: 'private' }, from: { id: c.tgId, first_name: 'M' }, successful_payment: sp } };
  await tgUpdate(payMsg);
  await tgUpdate(payMsg); // duplicate delivery with a new update_id

  const ent = await db.one(`SELECT e.*, t.code FROM entitlements e JOIN membership_tiers t ON t.id = e.tier_id WHERE e.user_id = $1`, [c.userId]);
  assert.equal(ent.status, 'active');
  assert.equal(ent.code, 'tier_1');
  assert.equal((await db.one(`SELECT count(*)::int n FROM payments WHERE provider = 'telegram_stars'`)).n, 1);
  const invites = callsTo('createChatInviteLink');
  assert.equal(invites.length, 1);
  assert.equal(invites[0].params.chat_id, -1002222222221);

  // Renewal (new charge id) extends, no second invite
  clearCalls();
  await tgUpdate({ message: { ...payMsg.message, successful_payment: { ...sp, telegram_payment_charge_id: 'stxCHARGE2', is_first_recurring: false, subscription_expiration_date: exp + 30 * 86400 } } });
  const renewed = await db.one('SELECT expires_at FROM entitlements WHERE id = $1', [ent.id]);
  assert.equal(Math.floor(new Date(renewed.expires_at).getTime() / 1000), exp + 30 * 86400);
  assert.equal(callsTo('createChatInviteLink').length, 0);

  // Expiry → revoked via ban + unban in the tier chat; rerun is a no-op
  await db.query(`UPDATE entitlements SET expires_at = now() - interval '2 hours' WHERE id = $1`, [ent.id]);
  clearCalls();
  const run1 = await new Client().get('/api/cron/memberships', CRON);
  assert.equal(run1.json.results.memberships.revoked, 1);
  assert.equal(callsTo('banChatMember')[0].params.chat_id, -1002222222221);
  assert.equal(callsTo('banChatMember')[0].params.user_id, c.tgId);
  assert.equal(callsTo('unbanChatMember')[0].params.only_if_banned, true);
  assert.equal((await db.one('SELECT status FROM entitlements WHERE id = $1', [ent.id])).status, 'revoked');
  clearCalls();
  const run2 = await new Client().get('/api/cron/memberships', CRON);
  assert.equal(run2.json.results.memberships.revoked, 0);
  assert.equal(callsTo('banChatMember').length, 0);
});

test('expiry reminder is sent once per period', async () => {
  await db.query(`UPDATE membership_tiers SET stars_amount = 500 WHERE code = 'tier_2'`);
  const u = await db.one(`INSERT INTO users (telegram_user_id, age_confirmed_21) VALUES (880001, true) RETURNING id`);
  const t = await db.one(`SELECT id FROM membership_tiers WHERE code = 'tier_2'`);
  await db.query(`INSERT INTO entitlements (user_id, tier_id, status, expires_at) VALUES ($1, $2, 'active', now() + interval '2 days')`, [u.id, t.id]);
  clearCalls();
  const a = await new Client().get('/api/cron/memberships', CRON);
  const b = await new Client().get('/api/cron/memberships', CRON);
  assert.equal(a.json.results.memberships.reminders, 1);
  assert.equal(b.json.results.memberships.reminders, 0);
  assert.equal(callsTo('sendMessage').filter((m) => m.params.chat_id === 880001).length, 1);
});
