// test/community-onboarding.test.js - Community onboarding lifecycle, idempotency,
// official community/channel tracking, and admin audits.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb, Client, signedInClient, calls, startServer, stopServer } from './helpers.js';
import {
  registerTelegramOnboarding,
  registerWhatsAppOnboarding,
  trackOnboardingAction,
  getOnboardingState,
  listOnboardingAudits
} from '../lib/services/community-onboarding.js';
import { telegramCommunityUrl, whatsappChannelUrl } from '../lib/config.js';

before(async () => {
  await resetDb();
  await startServer();
});

after(stopServer);

beforeEach(async () => {
  await resetDb();
  calls.length = 0;
});

test('Telegram Onboarding: registration saves verified numeric Telegram user ID and is idempotent', async () => {
  const u = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES (777000111, 'alex_nightlife', true, now(), 'active') RETURNING *`
  )).rows[0];

  // 1. Initial registration without bot authorization
  const reg1 = await registerTelegramOnboarding({
    userId: u.id,
    telegramUserId: u.telegram_user_id,
    botStarted: false
  });

  assert.equal(reg1.ok, true);
  assert.equal(reg1.welcomeSent, false);
  assert.equal(reg1.record.channel, 'telegram');
  assert.equal(reg1.record.status, 'registered');
  assert.equal(String(reg1.record.telegram_user_id), '777000111');

  // 2. Duplicate registration (e.g. repeated login) is idempotent and never creates duplicate rows
  const reg2 = await registerTelegramOnboarding({
    userId: u.id,
    telegramUserId: u.telegram_user_id,
    botStarted: false
  });

  assert.equal(reg2.ok, true);
  assert.equal(reg2.record.id, reg1.record.id);

  const { rows } = await db.query(`SELECT * FROM user_onboarding WHERE user_id = $1`, [u.id]);
  assert.equal(rows.length, 1);
});

test('Telegram Onboarding: sends welcome message with community invite ONLY after bot is started', async () => {
  const u = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES (888000222, 'clubber_sam', true, now(), 'active') RETURNING *`
  )).rows[0];

  // User authorizes / starts bot
  const reg = await registerTelegramOnboarding({
    userId: u.id,
    telegramUserId: u.telegram_user_id,
    botStarted: true
  });

  assert.equal(reg.ok, true);
  assert.equal(reg.welcomeSent, true);

  // Check calls recorded by test harness
  const msgCalls = calls.filter((c) => c.api === 'telegram' && c.method === 'sendMessage');
  assert.equal(msgCalls.length, 1);
  const sentPayload = msgCalls[0].params;
  assert.equal(sentPayload.chat_id, 888000222);
  assert.match(sentPayload.text, /Welcome to <b>NIGHTLIFEZ<\/b>/);
  assert.match(sentPayload.text, /official community channel/);

  // Verify inline buttons include official community link and web app action
  const buttons = sentPayload.reply_markup?.inline_keyboard || [];
  assert.ok(buttons.length >= 2);
  const joinBtn = buttons[0][0];
  assert.equal(joinBtn.text, 'Join NIGHTLIFEZ Community');
  assert.equal(joinBtn.url, telegramCommunityUrl());

  // Verify database record has welcome_sent_at and membership status
  const row = (await db.query(`SELECT * FROM user_onboarding WHERE user_id = $1`, [u.id])).rows[0];
  assert.ok(row.welcome_sent_at);
  assert.equal(row.status, 'welcome_sent');

  // Second login with botStarted=true MUST NOT send welcome message again (no spam)
  calls.length = 0;
  const regRepeat = await registerTelegramOnboarding({
    userId: u.id,
    telegramUserId: u.telegram_user_id,
    botStarted: true
  });

  assert.equal(regRepeat.welcomeSent, true);
  const repeatMsgCalls = calls.filter((c) => c.api === 'telegram' && c.method === 'sendMessage');
  assert.equal(repeatMsgCalls.length, 0, 'repeated login must never re-dispatch welcome message');
});

test('WhatsApp Onboarding: registers verified phone and presents optional follow channel action', async () => {
  const phone = '+919876543210';
  const u = (await db.query(
    `INSERT INTO users (phone, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES ($1, 'priya_blore', true, now(), 'active') RETURNING *`,
    [phone]
  )).rows[0];

  const reg = await registerWhatsAppOnboarding({
    userId: u.id,
    phone
  });

  assert.equal(reg.ok, true);
  assert.equal(reg.channelUrl, whatsappChannelUrl());
  assert.equal(reg.offered, true);
  assert.equal(reg.record.channel, 'whatsapp');
  assert.equal(reg.record.status, 'channel_offered');
  assert.ok(reg.record.channel_offered_at);
  assert.equal(reg.record.membership_verified, false, 'must not falsely claim channel membership on offer');
});

test('Community Onboarding Tracking: tracks channel follow click without falsely claiming membership', async () => {
  const u = (await db.query(
    `INSERT INTO users (phone, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES ('+919123456780', 'rohan_chennai', true, now(), 'active') RETURNING *`
  )).rows[0];

  await registerWhatsAppOnboarding({ userId: u.id, phone: u.phone });

  // User clicks the Follow WhatsApp Channel button
  const track = await trackOnboardingAction({
    userId: u.id,
    channel: 'whatsapp',
    action: 'channel_clicked',
    metadata: { source: 'signin_modal', device: 'mobile' }
  });

  assert.equal(track.ok, true);
  assert.equal(track.record.status, 'channel_clicked');
  assert.ok(track.record.channel_clicked_at);
  assert.equal(track.record.membership_verified, false, 'must never falsely claim membership after click');

  // Verify getOnboardingState returns correct status
  const state = await getOnboardingState(u.id);
  assert.equal(state.whatsapp.channelClicked, true);
  assert.equal(state.whatsapp.channelUrl, whatsappChannelUrl());
});

test('Attendee HTTP Endpoints: GET /api/me/onboarding and POST /api/onboarding/track', async () => {
  const c = await signedInClient();

  // 1. Check initial onboarding state
  const getRes = await c.get('/api/me/onboarding');
  assert.equal(getRes.status, 200);
  assert.ok(getRes.json.ok);
  assert.ok(getRes.json.onboarding);
  assert.ok(getRes.json.onboarding.telegram);
  assert.ok(getRes.json.onboarding.whatsapp);

  // 2. Track clicking community join action
  const postRes = await c.post('/api/onboarding/track', {
    channel: 'whatsapp',
    action: 'channel_clicked'
  });
  assert.equal(postRes.status, 200);
  assert.equal(postRes.json.ok, true);

  // 3. Confirm updated state
  const updatedRes = await c.get('/api/me/onboarding');
  assert.equal(updatedRes.json.onboarding.whatsapp.channelClicked, true);
});

test('Admin Visibility & Privacy: GET /api/admin/onboarding masks PII and aggregates metrics', async () => {
  // Seed sample onboarding records
  const u1 = (await db.query(
    `INSERT INTO users (telegram_user_id, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES (555111, 'attendee_1', true, now(), 'active') RETURNING *`
  )).rows[0];

  const u2 = (await db.query(
    `INSERT INTO users (phone, alias, age_confirmed_21, age_confirmed_at, status)
     VALUES ('+919876543210', 'attendee_2', true, now(), 'active') RETURNING *`
  )).rows[0];

  await registerTelegramOnboarding({ userId: u1.id, telegramUserId: 555111, botStarted: true });
  await registerWhatsAppOnboarding({ userId: u2.id, phone: '+919876543210' });
  await trackOnboardingAction({ userId: u2.id, channel: 'whatsapp', action: 'channel_clicked' });

  // Sign in as admin
  const adminClient = await signedInClient({ tgId: 900000001 });
  assert.equal((await adminClient.get('/api/admin/session')).json.role, 'super_admin');

  const res = await adminClient.get('/api/admin/onboarding');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.records.length >= 2);
  assert.ok(res.json.metrics);
  assert.ok(res.json.metrics.total_records >= 2);

  // Verify privacy: phone number is masked!
  const waRecord = res.json.records.find((r) => r.channel === 'whatsapp');
  assert.ok(waRecord);
  assert.equal(waRecord.phoneMasked, '+91 98****3210');
  assert.equal(waRecord.whatsapp_phone, undefined, 'Raw phone must never be exposed');
});
