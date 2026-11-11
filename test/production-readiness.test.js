// test/production-readiness.test.js - Production Readiness Verification Suite
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signTicketPayload, verifyTicketPayload } from '../lib/services/tickets.js';
import { previewReviewerEnabled } from '../lib/dev-personas.js';
import { livePayments, upiCheckoutEnabled } from '../lib/config.js';
import { checkoutForEvent } from '../lib/payments/availability.js';
import { assertUpiCheckoutEnabled } from '../lib/services/upi-payments.js';

test('Production Ticket Signing Security: cannot fall back to development secret in Production or Vercel', () => {
  const origTicketSecret = process.env.TICKET_SECRET;
  const origSessionSecret = process.env.SESSION_SECRET;
  const origVercel = process.env.VERCEL;
  const origVercelEnv = process.env.VERCEL_ENV;
  const origNodeEnv = process.env.NODE_ENV;

  try {
    // 1. In Production/Vercel: missing both secrets throws HttpError 503 (fail closed)
    delete process.env.TICKET_SECRET;
    delete process.env.SESSION_SECRET;
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    process.env.NODE_ENV = 'production';

    assert.throws(
      () => signTicketPayload('TK-TEST-0001', '00000000-0000-0000-0000-000000000001'),
      (err) => err.status === 503 && /Ticket signing is not configured/.test(err.message),
      'Must throw 503 and refuse to sign tickets in Production without a configured secret'
    );

    // 2. Short secret (< 32 chars) in Production throws 503
    process.env.SESSION_SECRET = 'too-short-secret';
    assert.throws(
      () => signTicketPayload('TK-TEST-0001', '00000000-0000-0000-0000-000000000001'),
      (err) => err.status === 503 && /Ticket signing is not configured/.test(err.message),
      'Short SESSION_SECRET (< 32 chars) must throw 503 in Production'
    );

    // 3. Valid SESSION_SECRET (>= 32 chars) in Production succeeds
    const validSessionSecret = 'a'.repeat(32);
    process.env.SESSION_SECRET = validSessionSecret;
    delete process.env.TICKET_SECRET;
    const sigWithSession = signTicketPayload('TK-TEST-0001', '00000000-0000-0000-0000-000000000001');
    assert.ok(sigWithSession, 'Signs successfully with valid SESSION_SECRET');
    assert.equal(
      verifyTicketPayload('TK-TEST-0001', '00000000-0000-0000-0000-000000000001', sigWithSession),
      true,
      'Verifies successfully with valid SESSION_SECRET'
    );

    // 4. Valid TICKET_SECRET takes precedence over SESSION_SECRET
    const validTicketSecret = 'b'.repeat(32);
    process.env.TICKET_SECRET = validTicketSecret;
    const sigWithTicketSecret = signTicketPayload('TK-TEST-0001', '00000000-0000-0000-0000-000000000001');
    assert.notEqual(sigWithSession, sigWithTicketSecret, 'TICKET_SECRET produces distinct signature from SESSION_SECRET');
    assert.equal(
      verifyTicketPayload('TK-TEST-0001', '00000000-0000-0000-0000-000000000001', sigWithTicketSecret),
      true,
      'Verifies with TICKET_SECRET'
    );

    // 5. In local development (!VERCEL and NODE_ENV!=production): fallback is allowed without throwing
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.NODE_ENV = 'test';
    delete process.env.TICKET_SECRET;
    delete process.env.SESSION_SECRET;
    const devSig = signTicketPayload('TK-TEST-DEV', '00000000-0000-0000-0000-000000000001');
    assert.ok(devSig, 'Local test environment can generate dev signatures');
  } finally {
    process.env.TICKET_SECRET = origTicketSecret;
    process.env.SESSION_SECRET = origSessionSecret;
    process.env.VERCEL = origVercel;
    process.env.VERCEL_ENV = origVercelEnv;
    process.env.NODE_ENV = origNodeEnv;
  }
});

test('Production Reviewer Security: strictly denied in production and ambiguous cloud environments', () => {
  const safeDb = 'postgres://preview-user:secret@ep-cool-glade-12345.preview.neon.tech/main';
  const blockedDb = 'postgres://user:secret@ep-dawn-glitter-b4mkwxkl.pooler.neon.tech/main';

  // Production runtime
  assert.equal(previewReviewerEnabled({ VERCEL_ENV: 'production', DATABASE_URL: safeDb }), false);
  assert.equal(previewReviewerEnabled({ VERCEL_ENV: 'production', IS_PREVIEW: 'true', DATABASE_URL: safeDb }), false);

  // Blocked production database endpoint
  assert.equal(previewReviewerEnabled({ VERCEL_ENV: 'preview', DATABASE_URL: blockedDb }), false);
  assert.equal(previewReviewerEnabled({ VERCEL_ENV: 'preview', PREVIEW_DATABASE_URL: blockedDb }), false);

  // Ambiguous deployed environments
  assert.equal(previewReviewerEnabled({ IS_PREVIEW: 'true', VERCEL: '1', DATABASE_URL: safeDb }), false);
  assert.equal(previewReviewerEnabled({ IS_PREVIEW: 'true', VERCEL_URL: 'nightlifez.vercel.app', DATABASE_URL: safeDb }), false);
  assert.equal(previewReviewerEnabled({ IS_PREVIEW: 'true', NODE_ENV: 'production', DATABASE_URL: safeDb }), false);
  assert.equal(previewReviewerEnabled({ IS_PREVIEW: 'true', AWS_LAMBDA_FUNCTION_NAME: 'api', DATABASE_URL: safeDb }), false);
});

test('Production Payment Safety Invariants: live payments and UPI checkout default to false', () => {
  assert.equal(livePayments(), false, 'ENABLE_LIVE_PAYMENTS must default to false');
  assert.equal(upiCheckoutEnabled(), false, 'UPI_CHECKOUT_ENABLED must default to false');

  // Both checkouts are disabled
  assert.throws(() => assertUpiCheckoutEnabled(), (err) => err.status === 404);

  const eventRowUpi = { checkout_mode: 'upi_direct' };
  const upiCheck = checkoutForEvent(eventRowUpi);
  assert.equal(upiCheck.available, false);
  assert.equal(upiCheck.reason, 'upi_checkout_disabled');

  const eventRowSuperprofile = { checkout_mode: 'superprofile', superprofile_url: 'https://superprofile.bio/test' };
  const spCheck = checkoutForEvent(eventRowSuperprofile);
  assert.equal(spCheck.available, false);
  assert.equal(spCheck.reason, 'live_payments_disabled');
});
