// test/webhook_idempotency.test.js - Webhook verification, pre-checkout, and payment idempotency tests
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import webhookHandler from '../api/webhook.js';
import { signInvoicePayload } from '../lib/telegram.js';
import { db } from '../lib/db.js';

process.env.TELEGRAM_WEBHOOK_SECRET = 'test_webhook_secret_key_12345';
process.env.APP_SECRET = 'test_app_secret_signature_salt';
process.env.MOCK_TELEGRAM = 'true';

test('Webhook: Invalid webhook secret token is rejected with 401', async () => {
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
    headers: {
      'x-telegram-bot-api-secret-token': 'wrong_secret'
    },
    body: { update_id: 100 }
  };

  await webhookHandler(mockReq, mockRes);
  assert.equal(statusCode, 401);
  assert.equal(responseData.ok, false);
});

test('Webhook: Missing webhook secret token is rejected with 401', async () => {
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
    headers: {},
    body: { update_id: 101 }
  };

  await webhookHandler(mockReq, mockRes);
  assert.equal(statusCode, 401);
  assert.equal(responseData.ok, false);
});

test('Webhook: Valid pre_checkout_query is approved', async () => {
  const signedPayload = await signInvoicePayload({
    orderId: 'test_order_1',
    tierId: 'insider',
    starsPrice: 75,
    telegramUserId: 999001
  });

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
    headers: {
      'x-telegram-bot-api-secret-token': 'test_webhook_secret_key_12345'
    },
    body: {
      update_id: 201,
      pre_checkout_query: {
        id: 'pcq_valid_1',
        currency: 'XTR',
        total_amount: 75,
        invoice_payload: signedPayload,
        from: { id: 999001, username: 'testuser1', first_name: 'Test' }
      }
    }
  };

  await webhookHandler(mockReq, mockRes);
  assert.equal(statusCode, 200);
  assert.equal(responseData.ok, true);
  assert.equal(responseData.handled, 'pre_checkout_query');
});

test('Webhook: Pre-checkout query with price manipulation is rejected', async () => {
  // Tampered: payload says insider (75 Stars), but query asks for 10 Stars
  const signedPayload = await signInvoicePayload({
    orderId: 'test_order_tamper',
    tierId: 'insider',
    starsPrice: 75,
    telegramUserId: 999002
  });

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
    headers: {
      'x-telegram-bot-api-secret-token': 'test_webhook_secret_key_12345'
    },
    body: {
      update_id: 202,
      pre_checkout_query: {
        id: 'pcq_tampered_1',
        currency: 'XTR',
        total_amount: 10, // Manipulated price!
        invoice_payload: signedPayload,
        from: { id: 999002, username: 'tamperer' }
      }
    }
  };

  await webhookHandler(mockReq, mockRes);
  assert.equal(statusCode, 200); // Webhook answered
  // Verify in database that it was marked REJECTED
  const event = await db.query('SELECT status, error_message FROM webhook_events WHERE update_id = 202');
  assert.equal(event.rows[0].status, 'REJECTED');
  assert.match(event.rows[0].error_message, /price mismatch/i);
});

test('Webhook: Successful first payment activates membership idempotently', async () => {
  const chargeId = `chg_test_${crypto.randomBytes(4).toString('hex')}`;
  const signedPayload = await signInvoicePayload({
    orderId: 'test_order_first_pay',
    tierId: 'social-plus',
    starsPrice: 250,
    telegramUserId: 888100
  });

  const payloadBody = {
    update_id: 301,
    message: {
      from: { id: 888100, username: 'first_payer', first_name: 'Payer' },
      successful_payment: {
        currency: 'XTR',
        total_amount: 250,
        invoice_payload: signedPayload,
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: 'tg_provider_ref_1',
        is_recurring: true,
        is_first_recurrence: false
      }
    }
  };

  // FIRST CALL
  let res1Data;
  const mockRes1 = {
    setHeader() {},
    end(str) { res1Data = JSON.parse(str); },
    set statusCode(code) {}
  };

  await webhookHandler({
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_key_12345' },
    body: payloadBody
  }, mockRes1);

  assert.equal(res1Data.ok, true);
  assert.equal(res1Data.result.status, 'ACTIVATED');
  assert.equal(res1Data.result.tierId, 'social-plus');
  assert.ok(res1Data.result.inviteLink.includes('mock_invite_'));

  // SECOND CALL (Duplicate update with identical charge ID)
  let res2Data;
  const mockRes2 = {
    setHeader() {},
    end(str) { res2Data = JSON.parse(str); },
    set statusCode(code) {}
  };

  payloadBody.update_id = 302; // Telegram retries with new or same update_id
  await webhookHandler({
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'test_webhook_secret_key_12345' },
    body: payloadBody
  }, mockRes2);

  assert.equal(res2Data.ok, true);
  assert.equal(res2Data.result.status, 'DUPLICATE', 'Duplicate payment must be recognized idempotently');

  // Verify only 1 payment transaction exists in database for this charge ID
  const txCount = await db.query(
    'SELECT COUNT(*) as count FROM payment_transactions WHERE telegram_payment_charge_id = $1',
    [chargeId]
  );
  assert.equal(Number(txCount.rows[0].count), 1, 'Exactly 1 payment transaction should be recorded');
});
