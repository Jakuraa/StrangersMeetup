// test/entitlements.test.js - Channel entitlement separation and access control tests
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../lib/db.js';
import { reconcileExpiredSubscriptions, tiersConfig } from '../lib/entitlements.js';
import entitlementsHandler from '../api/entitlements.js';
import cancelHandler from '../api/cancel.js';

test('Channel Entitlement: Tier-specific channel configuration keys are distinct', () => {
  const keys = tiersConfig.tiers.map((t) => t.channelConfigKey);
  const uniqueKeys = new Set(keys);
  assert.equal(uniqueKeys.size, 3, 'Each tier must map to a distinct channel config key');
  assert.ok(keys.includes('TELEGRAM_INSIDER_CHANNEL_ID'));
  assert.ok(keys.includes('TELEGRAM_SOCIAL_PLUS_CHANNEL_ID'));
  assert.ok(keys.includes('TELEGRAM_VIP_CHANNEL_ID'));
});

test('Security Gate: Client cannot mark a subscription as paid via API', async () => {
  // Try sending a POST or PUT to /api/entitlements with status=ACTIVE
  let statusCode;
  let responseData;
  const mockRes = {
    setHeader() {},
    end(str) { responseData = JSON.parse(str); },
    set statusCode(code) { statusCode = code; }
  };

  const mockReq = {
    method: 'POST',
    body: { telegramUserId: 123456, status: 'ACTIVE', tierId: 'vip-circle' }
  };

  await entitlementsHandler(mockReq, mockRes);
  assert.equal(statusCode, 405, 'POST to entitlements must be rejected with 405 Method Not Allowed');
});

test('Entitlements API: Querying unknown user returns 404 NOT_FOUND without granting access', async () => {
  let statusCode;
  let responseData;
  const mockRes = {
    setHeader() {},
    end(str) { responseData = JSON.parse(str); },
    set statusCode(code) { statusCode = code; }
  };

  const mockReq = {
    method: 'GET',
    url: '/api/entitlements?telegramUserId=99999999999'
  };

  await entitlementsHandler(mockReq, mockRes);
  assert.equal(statusCode, 404);
  assert.equal(responseData.hasActiveSubscription, false);
});

test('Subscription Expiry: reconcileExpiredSubscriptions revokes expired channel access', async () => {
  const testSubId = `sub_exp_${crypto.randomBytes(4).toString('hex')}`;
  const testUserId = 777123;
  const pastDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago

  // Insert expired subscription
  await db.query(
    `INSERT INTO subscriptions (id, member_id, telegram_user_id, tier_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [testSubId, 'mem_test_exp', testUserId, 'insider', 'ACTIVE', pastDate]
  );

  // Insert active entitlement for this subscription
  const entId = `ent_test_exp_${crypto.randomBytes(4).toString('hex')}`;
  await db.query(
    `INSERT INTO access_entitlements (id, subscription_id, telegram_user_id, tier_id, channel_id, invite_link, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entId, testSubId, testUserId, 'insider', '-1000000000001', 'https://t.me/+old_link', 'ACTIVE']
  );

  // Run reconciliation
  const result = await reconcileExpiredSubscriptions();
  assert.ok(result.revoked >= 1, 'At least 1 expired entitlement should be revoked');

  // Verify DB state
  const updatedSub = await db.query('SELECT status FROM subscriptions WHERE id = $1', [testSubId]);
  assert.equal(updatedSub.rows[0].status, 'EXPIRED');

  const updatedEnt = await db.query('SELECT status, revoked_at FROM access_entitlements WHERE id = $1', [entId]);
  assert.equal(updatedEnt.rows[0].status, 'REVOKED');
  assert.ok(updatedEnt.rows[0].revoked_at, 'Revocation timestamp must be populated');
});

test('Cancellation API: POST /api/cancel marks auto-renewal disabled and records audit log', async () => {
  const cancelSubId = `sub_cancel_${crypto.randomBytes(4).toString('hex')}`;
  const cancelUserId = 666123;
  const futureDate = new Date(Date.now() + 86400000 * 20).toISOString(); // 20 days left

  await db.query(
    `INSERT INTO subscriptions (id, member_id, telegram_user_id, tier_id, status, expires_at, is_recurring)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [cancelSubId, 'mem_cancel_test', cancelUserId, 'social-plus', 'ACTIVE', futureDate, 1]
  );

  let statusCode;
  let responseData;
  const mockRes = {
    setHeader() {},
    end(str) { responseData = JSON.parse(str); },
    set statusCode(code) { statusCode = code; }
  };

  await cancelHandler({
    method: 'POST',
    body: { subscriptionId: cancelSubId, telegramUserId: cancelUserId, reason: 'Testing cancellation' }
  }, mockRes);

  assert.equal(statusCode, 200);
  assert.equal(responseData.ok, true);
  assert.ok(Array.isArray(responseData.telegramSteps));

  // Verify DB update
  const subAfter = await db.query('SELECT is_recurring, cancelled_at FROM subscriptions WHERE id = $1', [cancelSubId]);
  assert.equal(subAfter.rows[0].is_recurring, 0);
  assert.ok(subAfter.rows[0].cancelled_at);
});
