// test/preview-remediation.test.js - Critical Preview Authentication Remediation Suite
// Covers DEF-01 to DEF-05:
// 1. VERCEL_ENV=preview and NODE_ENV=production -> reviewer allowed only if safety checks pass.
// 2. VERCEL_ENV=production -> reviewer denied (404).
// 3. Local environment -> reviewer denied.
// 4. Missing VERCEL_ENV -> reviewer denied.
// 5. Production database endpoint -> reviewer denied even if Preview claimed.
// 6. Reviewer cannot access admin endpoints (403).
// 7. Reviewer cannot access organiser or finance privileges (403).
// 8. Unsafe redirect -> rejected (falls back strictly to /me).
// 9. Normal attendee session handling remains secure.
// 10. POST-only method enforcement (GET returns 405).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, Client, db } from './helpers.js';
import { previewReviewerEnabled, REVIEWER_TG_ID } from '../lib/dev-personas.js';
import { seedDemo } from '../scripts/seed-demo.js';

before(startServer);
after(stopServer);

test('DEF-01 Policy Matrix: secure, explicit environment policy for preview reviewer', () => {
  const safeDb = 'postgres://preview-user:secret@ep-cool-glade-12345.preview.neon.tech/main';
  const blockedDb = 'postgres://user:secret@ep-dawn-glitter-b4mkwxkl.pooler.neon.tech/main';

  // 1. VERCEL_ENV=preview and NODE_ENV=production (standard Vercel Preview runtime) -> allowed
  assert.equal(
    previewReviewerEnabled({ VERCEL_ENV: 'preview', NODE_ENV: 'production', DATABASE_URL: safeDb }),
    true,
    'Reviewer must be allowed on verified Vercel Preview even with NODE_ENV=production'
  );

  // 2. VERCEL_ENV=production -> denied fail-closed
  assert.equal(
    previewReviewerEnabled({ VERCEL_ENV: 'production', NODE_ENV: 'production', DATABASE_URL: safeDb }),
    false,
    'Reviewer must be strictly denied on Vercel production'
  );
  assert.equal(
    previewReviewerEnabled({ VERCEL_ENV: 'production', NODE_ENV: 'production', IS_PREVIEW: 'true', DATABASE_URL: safeDb }),
    false,
    'Reviewer must be strictly denied on Vercel production even if IS_PREVIEW is maliciously passed'
  );

  // 3. Local environment -> denied unless IS_PREVIEW is explicitly set
  assert.equal(
    previewReviewerEnabled({ NODE_ENV: 'development', DATABASE_URL: 'postgres://localhost/sm_dev' }),
    false,
    'Reviewer must be denied in standard local development'
  );
  assert.equal(
    previewReviewerEnabled({ NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/sm_dev' }),
    false,
    'Reviewer must be denied in local production simulation without VERCEL_ENV=preview'
  );

  // 4. Missing or ambiguous environment -> denied fail-closed
  assert.equal(previewReviewerEnabled({}), false, 'Missing environment must fail closed');
  assert.equal(previewReviewerEnabled(null), false, 'Null environment must fail closed');
  assert.equal(previewReviewerEnabled({ VERCEL_ENV: 'staging' }), false, 'Unrecognized VERCEL_ENV must fail closed');

  // 5. Production database endpoint -> denied even if Preview claimed
  assert.equal(
    previewReviewerEnabled({ VERCEL_ENV: 'preview', NODE_ENV: 'production', DATABASE_URL: blockedDb }),
    false,
    'Reviewer must be denied if DATABASE_URL matches blocked production compute endpoint'
  );
  assert.equal(
    previewReviewerEnabled({ VERCEL_ENV: 'preview', NODE_ENV: 'production', DATABASE_URL: safeDb, PREVIEW_DATABASE_URL: blockedDb }),
    false,
    'Reviewer must be denied if PREVIEW_DATABASE_URL matches blocked production compute endpoint'
  );

  // 6. Test harness isolation flag (IS_PREVIEW='true')
  assert.equal(
    previewReviewerEnabled({ IS_PREVIEW: 'true', DATABASE_URL: safeDb }),
    true,
    'IS_PREVIEW=true is accepted for isolated non-production test suites'
  );
});

test('DEF-01 HTTP Integration: POST-only method enforcement, 404 in production, 200 in Preview', async () => {
  const c = new Client();
  const origVercelEnv = process.env.VERCEL_ENV;
  const origNodeEnv = process.env.NODE_ENV;
  const origIsPreview = process.env.IS_PREVIEW;

  try {
    // A. Production environment: POST must return 404
    process.env.VERCEL_ENV = 'production';
    process.env.NODE_ENV = 'production';
    delete process.env.IS_PREVIEW;

    const prodRes = await c.post('/api/auth/preview-reviewer', { next: '/me' });
    assert.equal(prodRes.status, 404, 'Returns 404 Not Found in production');

    // B. Vercel Preview runtime simulation (VERCEL_ENV=preview, NODE_ENV=production)
    process.env.VERCEL_ENV = 'preview';
    process.env.NODE_ENV = 'production';
    delete process.env.IS_PREVIEW;

    // GET request must return 405 Method Not Allowed (POST-only route)
    const getRes = await c.get('/api/auth/preview-reviewer');
    assert.equal(getRes.status, 405, 'Direct GET link must return 405 Method Not Allowed');

    // POST request with JSON accept header must return 200 and signed session cookie
    const postRes = await c.post('/api/auth/preview-reviewer', { next: '/events' }, {
      'accept': 'application/json'
    });
    assert.equal(postRes.status, 200, 'Reviewer sign-in succeeds in Preview runtime with NODE_ENV=production');
    assert.equal(postRes.json.ok, true);
    assert.match(postRes.json.user.alias, /Preview Reviewer/);
    assert.equal(postRes.json.user.ageConfirmed, true);
    const dbReviewer = await db.one('SELECT telegram_user_id FROM users WHERE alias = $1', [postRes.json.user.alias]);
    assert.equal(dbReviewer.telegram_user_id, REVIEWER_TG_ID);
    assert.equal(postRes.json.redirect, '/events');

    const csrf = postRes.json.csrf;
    assert.ok(csrf, 'CSRF token returned upon sign-in');

    // C. Verify Least Privilege Boundaries for Reviewer Account
    // 1. Can access /api/me (standard attendee hub)
    const meRes = await c.get('/api/me');
    assert.equal(meRes.status, 200);
    assert.equal(meRes.json.user.alias, 'Preview Reviewer (Synthetic)');

    // 2. CANNOT access platform admin console (forbidden 403)
    const adminRes = await c.get('/api/admin/overview');
    assert.equal(adminRes.status, 403, 'Reviewer account has zero platform admin access');

    // 3. CANNOT access organiser event workspace (forbidden 403)
    const orgRes = await c.get('/api/organiser/events');
    assert.equal(orgRes.status, 403, 'Reviewer account has zero organiser privileges');

    // 4. CANNOT execute finance actions
    const financeRes = await c.post('/api/admin/payments/test-id/refund', { reason: 'Unauthorized' });
    assert.equal(financeRes.status, 403, 'Reviewer account has zero finance/refund privileges');

    // D. Safe Redirect Validation (Open Redirect Protection)
    const evilRes = await c.post('/api/auth/preview-reviewer', { next: 'https://evil-phishing.com' }, {
      'accept': 'application/json'
    });
    assert.equal(evilRes.status, 200);
    assert.equal(evilRes.json.redirect, '/me', 'Unsafe absolute URL safely sanitized to /me');

    const protocolRelativeRes = await c.post('/api/auth/preview-reviewer', { next: '//evil-phishing.com/test' }, {
      'accept': 'application/json'
    });
    assert.equal(protocolRelativeRes.status, 200);
    assert.equal(protocolRelativeRes.json.redirect, '/me', 'Protocol-relative URL safely sanitized to /me');

    const javascriptRes = await c.post('/api/auth/preview-reviewer', { next: 'javascript:alert(1)' }, {
      'accept': 'application/json'
    });
    assert.equal(javascriptRes.status, 200);
    assert.equal(javascriptRes.json.redirect, '/me', 'Scheme injection safely sanitized to /me');
    const activeCsrf = javascriptRes.json.csrf;

    // E. Normal attendee booking and cancellation with Reviewer Session
    await seedDemo({ e: { DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost/sm_e2e' } });
    const ev = await db.one(`SELECT id FROM events WHERE slug = 'sample-chennai-besant-nagar-supper-club'`);
    const tier = await db.one(`SELECT id FROM ticket_types WHERE event_id = $1 AND kind = 'free'`, [ev.id]);

    const userRow = await db.one(`SELECT id FROM users WHERE telegram_user_id = $1`, [REVIEWER_TG_ID]);
    await db.query(`DELETE FROM notifications WHERE booking_id IN (SELECT id FROM bookings WHERE user_id = $1 AND event_id = $2)`, [userRow.id, ev.id]);
    await db.query(`DELETE FROM invite_links WHERE booking_id IN (SELECT id FROM bookings WHERE user_id = $1 AND event_id = $2)`, [userRow.id, ev.id]);
    await db.query(`DELETE FROM bookings WHERE user_id = $1 AND event_id = $2`, [userRow.id, ev.id]);

    const bookRes = await c.post(`/api/events/${ev.id}/book`, {
      ticketTypeId: tier.id,
      quantity: 1,
      answers: {}
    }, { 'x-csrf-token': activeCsrf });
    assert.equal(bookRes.status, 200, 'Reviewer can book free tier');
    assert.equal(bookRes.json.ok, true);
    assert.ok(bookRes.json.bookingId, 'Booking ID issued');

    // Verify booking appears in /api/me/bookings
    const myBookings = await c.get('/api/me/bookings');
    assert.equal(myBookings.status, 200);
    const b = myBookings.json.bookings.find((item) => item.id === bookRes.json.bookingId);
    assert.ok(b, 'Booking found in reviewer bookings list');

    // Cancel the booking
    const cancelRes = await c.post(`/api/bookings/${bookRes.json.bookingId}/cancel`, {}, { 'x-csrf-token': activeCsrf });
    assert.equal(cancelRes.status, 200, 'Reviewer can cancel booking');
    assert.equal(cancelRes.json.ok, true);
  } finally {
    process.env.VERCEL_ENV = origVercelEnv;
    process.env.NODE_ENV = origNodeEnv;
    process.env.IS_PREVIEW = origIsPreview;
  }
});

test('DEF-05 Lead Submission Rate Limiting: protects Preview and Production from lead spam', async () => {
  const c = new Client();
  // Clear rate limits table for isolated test execution
  await db.query(`DELETE FROM rate_limits WHERE key LIKE 'lead:%'`);

  // Submit 5 valid lead payloads within the rate limit
  for (let i = 1; i <= 5; i++) {
    const res = await c.post('/api/leads/partner', {
      name: `Synthetic Partner ${i}`,
      organization: `Partner Org ${i}`,
      email: `partner${i}@example.com`,
      city: 'Bengaluru',
      message: 'Synthetic sound engineering lead test message for rate limit audit.',
      consent: 'yes'
    });
    assert.equal(res.status, 200, `Lead submission ${i} of 5 must succeed`);
    assert.equal(res.json.ok, true);
  }

  // The 6th request from the same IP must be rejected with HTTP 429
  const resBlocked = await c.post('/api/leads/partner', {
    name: 'Synthetic Partner 6',
    organization: 'Partner Org 6',
    email: 'partner6@example.com',
    city: 'Bengaluru',
    message: 'Synthetic sound engineering lead test message that should exceed the limit.',
    consent: 'yes'
  });
  assert.equal(resBlocked.status, 429, '6th lead submission in 1 hour must be rejected with HTTP 429');
  assert.equal(resBlocked.json.error, 'rate_limited');
  assert.match(resBlocked.json.message, /Too many requests/);
  assert.ok(resBlocked.headers.get('retry-after'), 'Must provide Retry-After header');
});

