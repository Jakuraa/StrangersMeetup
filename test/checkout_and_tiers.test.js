// test/checkout_and_tiers.test.js - Tier validation and checkout generation tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { getTierById, tiersConfig } from '../lib/entitlements.js';
import checkoutHandler from '../api/checkout.js';
import tiersHandler from '../api/tiers.js';

test('Tiers Configuration: All three target monthly tiers are defined', () => {
  const tiers = tiersConfig.tiers;
  assert.equal(tiers.length, 3);

  const insider = tiers.find((t) => t.id === 'insider');
  assert.ok(insider, 'Insider tier must exist');
  assert.equal(insider.inrTarget, 149);
  assert.equal(insider.starsPrice, 75);
  assert.equal(insider.billingPeriodDays, 30);
  assert.equal(insider.enabled, true);

  const socialPlus = tiers.find((t) => t.id === 'social-plus');
  assert.ok(socialPlus, 'Social Plus tier must exist');
  assert.equal(socialPlus.inrTarget, 499);
  assert.equal(socialPlus.starsPrice, 250);
  assert.equal(socialPlus.billingPeriodDays, 30);
  assert.equal(socialPlus.enabled, true);

  const vip = tiers.find((t) => t.id === 'vip-circle');
  assert.ok(vip, 'VIP Circle tier must exist');
  assert.equal(vip.inrTarget, 999);
  assert.equal(vip.starsPrice, 500);
  assert.equal(vip.billingPeriodDays, 30);
  assert.equal(vip.enabled, true);
});

test('Tiers Configuration: Benefits are configuration-driven with active/planned statuses', () => {
  for (const tier of tiersConfig.tiers) {
    assert.ok(Array.isArray(tier.benefits), `Benefits for ${tier.id} must be an array`);
    assert.ok(tier.benefits.length > 0);
    for (const b of tier.benefits) {
      assert.ok(b.text, 'Benefit must have text');
      assert.ok(['active', 'planned'].includes(b.status), `Benefit status must be active or planned: got ${b.status}`);
    }
  }
});

test('Tiers API: GET /api/tiers returns public data without leaking private channel IDs', async () => {
  let statusCode;
  let responseData;
  const mockRes = {
    setHeader() {},
    end(str) {
      responseData = JSON.parse(str);
    },
    set statusCode(code) {
      statusCode = code;
    }
  };

  await tiersHandler({ method: 'GET' }, mockRes);
  assert.equal(statusCode, 200);
  assert.equal(responseData.ok, true);
  assert.equal(responseData.tiers.length, 3);

  // Ensure channel identifiers are not leaked
  for (const t of responseData.tiers) {
    assert.equal(t.channelConfigKey, undefined);
    assert.equal(t.channelId, undefined);
  }
});

test('Checkout API: Unknown tier is rejected with 404', async () => {
  let statusCode;
  let responseData;
  const mockRes = {
    setHeader() {},
    end(str) {
      responseData = JSON.parse(str);
    },
    set statusCode(code) {
      statusCode = code;
    }
  };

  const mockReq = {
    method: 'POST',
    body: { tierId: 'non-existent-tier' }
  };

  await checkoutHandler(mockReq, mockRes);
  assert.equal(statusCode, 404);
  assert.equal(responseData.ok, false);
  assert.match(responseData.error, /not found or disabled/i);
});

test('Checkout API: Missing tierId returns 400 Bad Request', async () => {
  let statusCode;
  let responseData;
  const mockRes = {
    setHeader() {},
    end(str) {
      responseData = JSON.parse(str);
    },
    set statusCode(code) {
      statusCode = code;
    }
  };

  await checkoutHandler({ method: 'POST', body: {} }, mockRes);
  assert.equal(statusCode, 400);
  assert.equal(responseData.ok, false);
});

test('Checkout API: Valid tier returns signed invoice link and instructions', async () => {
  let statusCode;
  let responseData;
  const mockRes = {
    setHeader() {},
    end(str) {
      responseData = JSON.parse(str);
    },
    set statusCode(code) {
      statusCode = code;
    }
  };

  const mockReq = {
    method: 'POST',
    body: { tierId: 'social-plus', telegramUserId: 123456789 }
  };

  await checkoutHandler(mockReq, mockRes);
  assert.equal(statusCode, 200);
  assert.equal(responseData.ok, true);
  assert.ok(responseData.invoiceLink, 'Invoice link must be present');
  assert.equal(responseData.tier.id, 'social-plus');
  assert.equal(responseData.tier.starsPrice, 250);
});
