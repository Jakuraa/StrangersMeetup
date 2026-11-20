// test/auth-recovery-and-onboarding.test.js - Comprehensive test suite for
// authentication recovery, session revocation, sign-out lifecycle,
// and new member step-by-step onboarding architecture.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, resetDb, startServer, stopServer, Client, makeInitData, makeWidgetData, BOT_TOKEN } from './helpers.js';
import { requestWhatsAppOtp, verifyWhatsAppOtpAndResolveUser } from '../lib/services/whatsapp-auth.js';
import { createSession, revokeSession, getSessionUser, SESSION_COOKIE } from '../lib/session.js';
import { ONBOARDING_STEPS } from '../lib/services/member-onboarding.js';

let tgSeq = 880000000;
let phoneSeq = 9876500000;

function nextPhone() {
  return `+91${++phoneSeq}`;
}

function nextTgUser(name = 'Test User') {
  const id = ++tgSeq;
  return { id, first_name: name.split(' ')[0], last_name: name.split(' ')[1] || 'Attendee', username: `user_${id}` };
}

before(async () => {
  await startServer();
  await resetDb();
});

after(async () => {
  await stopServer();
});

test('AUTHENTICATION: Sign-out lifecycle completely revokes server-side session and clears cookies', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Signout Test');

  // 1. Sign in via Telegram
  const authRes = await client.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser),
    ageConfirmed: true
  });
  assert.equal(authRes.status, 200);
  assert.ok(authRes.json.ok);
  assert.ok(client.cookies[SESSION_COOKIE], 'Session cookie must be issued');

  // Verify server-side session exists in user_sessions table
  const user = await db.one('SELECT * FROM users WHERE telegram_user_id = $1', [tgUser.id]);
  assert.ok(user);
  const liveSessions = await db.query(
    'SELECT * FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL',
    [user.id]
  );
  assert.equal(liveSessions.rows.length, 1, 'Live server-side session must exist');
  const sessionId = liveSessions.rows[0].id;

  // 2. Fetch /api/me to obtain CSRF token
  const meRes = await client.get('/api/me');
  assert.equal(meRes.status, 200);
  assert.ok(meRes.json.csrf);
  client.csrf = meRes.json.csrf;

  // 3. User clicks Sign out -> POST /api/auth/logout
  const logoutRes = await client.post('/api/auth/logout', {});
  assert.equal(logoutRes.status, 200);
  assert.ok(logoutRes.json.ok);

  // 4. Verify server-side session is revoked in database
  const revokedSession = await db.one('SELECT * FROM user_sessions WHERE id = $1', [sessionId]);
  assert.ok(revokedSession.revoked_at, 'Session must have revoked_at timestamp');
  assert.equal(revokedSession.revoke_reason, 'logout');

  // 5. Verify all applicable NIGHTLIFEZ authentication cookies are cleared
  assert.equal(client.cookies[SESSION_COOKIE], undefined, 'Session cookie must be cleared');
  assert.equal(client.cookies['sm_wa_step'], undefined, 'sm_wa_step cookie must be cleared');
  assert.equal(client.cookies['sm_tg_state'], undefined, 'sm_tg_state cookie must be cleared');

  // 6. Verify protected routes reject the old session
  const meAfterLogout = await client.get('/api/me');
  assert.equal(meAfterLogout.status, 200);
  assert.equal(meAfterLogout.json.user, null, 'User must be null after logout');

  // 7. Protected page /me redirects to /signin
  const pageRes = await client.get('/me');
  assert.equal(pageRes.status, 302);
  assert.match(pageRes.headers.get('location'), /\/signin/);

  // 8. Browser refresh maintains clean signed-out state
  const refreshRes = await client.get('/signin');
  assert.equal(refreshRes.status, 200);
  assert.equal(client.cookies[SESSION_COOKIE], undefined);
});

test('AUTHENTICATION: Sign-out rejects invalid CSRF tokens with 403 (CSRF guardrail)', async () => {
  const client = new Client();
  const tgUser = nextTgUser('WrongCsrf Logout');

  const authRes = await client.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser),
    ageConfirmed: true
  });
  assert.equal(authRes.status, 200);
  assert.ok(client.cookies[SESSION_COOKIE]);

  // Attempt logout with wrong CSRF
  const badLogout = await client.req('POST', '/api/auth/logout', {}, { 'x-csrf-token': 'wrong_token' });
  assert.equal(badLogout.status, 403);
  assert.ok(client.cookies[SESSION_COOKIE], 'Session cookie must remain on CSRF rejection');

  // Then logout with valid CSRF succeeds
  const meRes = await client.get('/api/me');
  const validLogout = await client.req('POST', '/api/auth/logout', {}, { 'x-csrf-token': meRes.json.csrf });
  assert.equal(validLogout.status, 200);
  assert.equal(client.cookies[SESSION_COOKIE], undefined);
});

test('AUTHENTICATION: Telegram Login Widget callback with state validation and replay defense', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Telegram Callback');
  const stateNonce = crypto.randomBytes(16).toString('hex');

  // Set state cookie
  client.cookies['sm_tg_state'] = stateNonce;

  const widgetData = makeWidgetData(tgUser);
  const queryParams = new URLSearchParams({
    ...widgetData,
    state: stateNonce,
    next: '/events'
  });

  const callbackRes = await client.get(`/auth/telegram/widget-callback?${queryParams.toString()}`);
  assert.equal(callbackRes.status, 302);
  // New user redirects to onboarding
  assert.match(callbackRes.headers.get('location'), /\/onboarding/);
  assert.ok(client.cookies[SESSION_COOKIE], 'Session cookie must be established');

  // Replay attempt with same hash must be rejected
  const replayClient = new Client();
  replayClient.cookies['sm_tg_state'] = stateNonce;
  const replayRes = await replayClient.get(`/auth/telegram/widget-callback?${queryParams.toString()}`);
  assert.equal(replayRes.status, 302);
  assert.match(replayRes.headers.get('location'), /error=replay/);
});

test('AUTHENTICATION: Telegram callback signature failure rejects forged payloads', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Forged Telegram');
  const stateNonce = crypto.randomBytes(16).toString('hex');
  client.cookies['sm_tg_state'] = stateNonce;

  const widgetData = makeWidgetData(tgUser);
  // Tamper with user ID after signature generation
  widgetData.id = 999999999;

  const queryParams = new URLSearchParams({
    ...widgetData,
    state: stateNonce,
    next: '/me'
  });

  const res = await client.get(`/auth/telegram/widget-callback?${queryParams.toString()}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /error=invalid_telegram_auth/);
  assert.equal(client.cookies[SESSION_COOKIE], undefined);
});

test('AUTHENTICATION: Telegram callback state mismatch rejects CSRF attempts', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Csrf State');
  client.cookies['sm_tg_state'] = 'attacker_state_cookie';

  const widgetData = makeWidgetData(tgUser);
  const queryParams = new URLSearchParams({
    ...widgetData,
    state: 'different_state_query',
    next: '/me'
  });

  const res = await client.get(`/auth/telegram/widget-callback?${queryParams.toString()}`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /error=expired/);
  assert.equal(client.cookies[SESSION_COOKIE], undefined);
});

test('AUTHENTICATION: WhatsApp OTP login for new member directs to onboarding', async () => {
  const client = new Client();
  const phone = nextPhone();

  // 1. Request OTP
  const otpRes = await client.post('/api/auth/whatsapp/otp', { phone });
  assert.equal(otpRes.status, 200);
  assert.ok(otpRes.json.challengeId);
  const challengeId = otpRes.json.challengeId;

  // Retrieve test dev OTP
  const challengeRow = await db.one('SELECT otp_hash FROM otp_challenges WHERE id = $1', [challengeId]);
  assert.ok(challengeRow);

  // In test environment, devOtp is returned in payload
  const devOtp = otpRes.json.devOtp || '123456';

  // 2. Verify OTP
  const verifyRes = await client.post('/api/auth/whatsapp/verify', {
    challengeId,
    phone,
    code: devOtp
  });
  assert.equal(verifyRes.status, 200);
  assert.ok(verifyRes.json.ok);
  assert.equal(verifyRes.json.isNewUser, true);
  assert.match(verifyRes.json.redirect, /\/onboarding/);
  assert.ok(client.cookies[SESSION_COOKIE]);
});

test('ONBOARDING: Step 1 to Step 6 full progression with server-side validation', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Kavya Natarajan');

  // Sign in as new user
  const authRes = await client.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser),
    ageConfirmed: true
  });
  client.csrf = authRes.json.csrf;

  // 1. Initial status: onboarding incomplete, step <= 1
  const initialStatus = await client.get('/api/onboarding/status');
  assert.equal(initialStatus.status, 200);
  assert.equal(initialStatus.json.completed, false);
  assert.ok(initialStatus.json.totalSteps, 6);

  // 2. Visiting /me while onboarding is incomplete redirects to /onboarding
  const mePageRes = await client.get('/me');
  assert.equal(mePageRes.status, 302);
  assert.match(mePageRes.headers.get('location'), /\/onboarding/);

  // 3. Step 2 — Age eligibility confirmation
  const ageRes = await client.post('/api/onboarding/age', {
    confirmed: true,
    policyVersion: '1.0'
  });
  assert.equal(ageRes.status, 200);
  assert.equal(ageRes.json.eligible, true);

  // Verify consent record created in DB
  const consentRow = await db.one(
    "SELECT * FROM onboarding_consents WHERE consent_type = 'age_21_plus' AND user_id = (SELECT id FROM users WHERE telegram_user_id = $1)",
    [tgUser.id]
  );
  assert.ok(consentRow);
  assert.equal(consentRow.confirmed, true);

  // 4. Step 3 — Basic profile (Display Name, Gender, City)
  // Missing display name fails
  const missingName = await client.post('/api/onboarding/profile', {
    displayName: '',
    gender: 'female',
    city: 'Bengaluru'
  });
  assert.equal(missingName.status, 400);

  // Valid basic profile succeeds
  const profileRes = await client.post('/api/onboarding/profile', {
    displayName: 'Kavya N',
    gender: 'female',
    city: 'Bengaluru'
  });
  assert.equal(profileRes.status, 200);
  assert.equal(profileRes.json.ok, true);

  // 5. Step 4 — Interests selection (min 1 required)
  const emptyInterests = await client.post('/api/onboarding/interests', {
    interests: []
  });
  assert.equal(emptyInterests.status, 400);

  const validInterests = await client.post('/api/onboarding/interests', {
    interests: ['parties_nightlife', 'music_concerts', 'dining_food']
  });
  assert.equal(validInterests.status, 200);
  assert.equal(validInterests.json.count, 3);

  // Verify interests persisted in structured member_interests table
  const interestRows = await db.query(
    'SELECT interest_key FROM member_interests WHERE user_id = (SELECT id FROM users WHERE telegram_user_id = $1) ORDER BY interest_key',
    [tgUser.id]
  );
  assert.equal(interestRows.rows.length, 3);

  // 6. Step 5 — Optional profile (bio & languages)
  const optionalRes = await client.post('/api/onboarding/optional', {
    bio: 'Music enthusiast and weekend party lover in Bengaluru.',
    languages: ['English', 'Tamil', 'Kannada']
  });
  assert.equal(optionalRes.status, 200);
  assert.equal(optionalRes.json.ok, true);

  // 7. Step 6 — Complete onboarding
  const completeRes = await client.post('/api/onboarding/complete', {});
  assert.equal(completeRes.status, 200);
  assert.equal(completeRes.json.completed, true);

  // 8. Verify status is now completed
  const finalStatus = await client.get('/api/onboarding/status');
  assert.equal(finalStatus.status, 200);
  assert.equal(finalStatus.json.completed, true);

  // 9. Now visiting /me returns 200 OK without redirecting to onboarding
  const meAfterComplete = await client.get('/me');
  assert.equal(meAfterComplete.status, 200);
  assert.match(meAfterComplete.text, /data-attendee-hub/);

  // 10. Visiting /onboarding when already completed redirects directly to /me
  const onboardingAfterComplete = await client.get('/onboarding');
  assert.equal(onboardingAfterComplete.status, 302);
  assert.equal(onboardingAfterComplete.headers.get('location'), '/me');
});

test('ONBOARDING: Under-21 users are rejected and cannot bypass via direct API', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Underage Visitor');

  const authRes = await client.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser),
    ageConfirmed: false
  });
  client.csrf = authRes.json.csrf;

  // Reject age eligibility
  const ageRes = await client.post('/api/onboarding/age', {
    confirmed: false
  });
  assert.equal(ageRes.status, 200);
  assert.equal(ageRes.json.eligible, false);

  // Attempting to bypass by calling /api/onboarding/complete fails
  const completeBypass = await client.post('/api/onboarding/complete', {});
  assert.equal(completeBypass.status, 400);
  assert.match(completeBypass.json.message, /Age confirmation is required/);
});

test('ONBOARDING: Incomplete member resumes at exact incomplete step', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Resume Member');

  const authRes = await client.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser),
    ageConfirmed: true
  });
  client.csrf = authRes.json.csrf;

  // Complete step 2 (age)
  await client.post('/api/onboarding/age', { confirmed: true });

  // Complete step 3 (profile)
  await client.post('/api/onboarding/profile', {
    displayName: 'Arjun Resume',
    gender: 'male',
    city: 'Chennai'
  });

  // User closes browser and signs in again later with fresh callback payload
  const secondClient = new Client();
  const secondAuth = await secondClient.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser, { authDate: Math.floor(Date.now() / 1000) + 10 }),
    ageConfirmed: true
  });
  secondClient.csrf = secondAuth.json.csrf;

  // Fetch status: should have saved basic profile and currentStep = 3
  const statusRes = await secondClient.get('/api/onboarding/status');
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.json.completed, false);
  assert.equal(statusRes.json.profile.displayName, 'Arjun Resume');
  assert.equal(statusRes.json.profile.city, 'Chennai');
  assert.equal(statusRes.json.profile.gender, 'male');
  assert.equal(statusRes.json.currentStep, ONBOARDING_STEPS.BASIC_PROFILE);
});

test('ONBOARDING: Gender field accepts "prefer_not_to_say" and "other"', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Inclusive Gender');

  const authRes = await client.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser),
    ageConfirmed: true
  });
  client.csrf = authRes.json.csrf;

  await client.post('/api/onboarding/age', { confirmed: true });

  // Prefer not to say
  const pntsRes = await client.post('/api/onboarding/profile', {
    displayName: 'Sam',
    gender: 'prefer_not_to_say',
    city: 'Kochi'
  });
  assert.equal(pntsRes.status, 200);

  // Other
  const otherRes = await client.post('/api/onboarding/profile', {
    displayName: 'Alex',
    gender: 'other',
    city: 'Kochi'
  });
  assert.equal(otherRes.status, 200);
});

test('ONBOARDING: Preserves intended next URL redirect after completion', async () => {
  const client = new Client();
  const tgUser = nextTgUser('Target Destination');

  const authRes = await client.post('/api/auth/telegram', {
    widget: makeWidgetData(tgUser),
    ageConfirmed: true
  });
  client.csrf = authRes.json.csrf;

  // Finish mandatory onboarding
  await client.post('/api/onboarding/age', { confirmed: true });
  await client.post('/api/onboarding/profile', {
    displayName: 'Target Tester',
    gender: 'non_binary',
    city: 'Puducherry'
  });
  await client.post('/api/onboarding/interests', {
    interests: ['adventure_outdoors', 'social_meetups']
  });
  await client.post('/api/onboarding/complete', {});

  // Visiting /onboarding with ?next=/events/weekend-special redirects to target
  const directRes = await client.get('/onboarding?next=%2Fevents%2Fweekend-special');
  assert.equal(directRes.status, 302);
  assert.equal(directRes.headers.get('location'), '/events/weekend-special');
});
