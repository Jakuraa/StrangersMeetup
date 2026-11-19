import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  requestWhatsAppOtp,
  verifyWhatsAppOtpAndResolveUser,
  unlinkWhatsAppIdentity,
  getLinkedIdentities
} from '../lib/services/whatsapp-auth.js';
import { getWhatsAppProvider } from '../lib/services/whatsapp-provider.js';
import { hasConsent } from '../lib/services/communication-consent.js';

test.beforeEach(async () => {
  await resetDb();
  getWhatsAppProvider().clearSentMessages();
});

test('WhatsApp Auth - new user registration via WhatsApp OTP', async () => {
  const phone = '+919876543210';
  const req = await requestWhatsAppOtp({ phone, ip: '192.168.1.10', promotionalOptIn: true });

  assert.equal(req.ok, true);
  assert.ok(req.challengeId);
  assert.equal(req.phoneMasked, '+91 98****3210');

  // Verify OTP from stub provider
  const sent = getWhatsAppProvider().getSentMessages();
  assert.equal(sent.length, 1);
  const otp = sent[0].otp;

  const auth = await verifyWhatsAppOtpAndResolveUser({
    challengeId: req.challengeId,
    phone,
    code: otp,
    ip: '192.168.1.10',
    promotionalOptIn: true
  });

  assert.equal(auth.ok, true);
  assert.equal(auth.isNewUser, true);
  assert.ok(auth.user.id);
  assert.equal(auth.user.phone, phone);
  assert.equal(auth.user.age_confirmed_21, true);

  // Identity should exist in user_identities
  const identity = (await db.query(`SELECT * FROM user_identities WHERE user_id = $1 AND provider = 'phone'`, [auth.user.id])).rows[0];
  assert.ok(identity);
  assert.equal(identity.subject, phone);

  // Consents: both transactional and promotional should be opted in
  assert.equal(await hasConsent({ userId: auth.user.id, channel: 'whatsapp', purpose: 'transactional' }), true);
  assert.equal(await hasConsent({ userId: auth.user.id, channel: 'whatsapp', purpose: 'promotional' }), true);
});

test('WhatsApp Auth - existing Telegram user links WhatsApp to same account', async () => {
  // 1. Existing Telegram user
  const tgUser = (await db.query(`
    INSERT INTO users (telegram_user_id, alias, age_confirmed_21) 
    VALUES (99001122, 'TelegramHero', true) 
    RETURNING id
  `)).rows[0];

  await db.query(`
    INSERT INTO user_identities (user_id, provider, subject, verified_at)
    VALUES ($1, 'telegram', '99001122', now())
  `, [tgUser.id]);

  const phone = '+919876543220';

  // 2. User links WhatsApp while authenticated
  const req = await requestWhatsAppOtp({ phone, currentUserId: tgUser.id });
  const otp = getWhatsAppProvider().getSentMessages()[0].otp;

  const linkResult = await verifyWhatsAppOtpAndResolveUser({
    challengeId: req.challengeId,
    phone,
    code: otp,
    currentUserId: tgUser.id
  });

  assert.equal(linkResult.ok, true);
  assert.equal(linkResult.linked, true);
  assert.equal(linkResult.user.id, tgUser.id);
  assert.equal(linkResult.user.phone, phone);

  // Both identities exist for the same user
  const identities = (await db.query(`SELECT provider, subject FROM user_identities WHERE user_id = $1 ORDER BY provider`, [tgUser.id])).rows;
  assert.equal(identities.length, 2);
  assert.deepEqual(identities.map((i) => i.provider).sort(), ['phone', 'telegram'].sort());

  // Check getLinkedIdentities
  const linked = await getLinkedIdentities(tgUser.id);
  assert.equal(linked.telegram.linked, true);
  assert.equal(linked.whatsapp.linked, true);
  assert.equal(linked.whatsapp.phone, phone);

  // 3. User signs out and logs back in using WhatsApp OTP -> reaches SAME account!
  getWhatsAppProvider().clearSentMessages();
  const loginReq = await requestWhatsAppOtp({ phone });
  const loginOtp = getWhatsAppProvider().getSentMessages()[0].otp;

  const loginResult = await verifyWhatsAppOtpAndResolveUser({
    challengeId: loginReq.challengeId,
    phone,
    code: loginOtp
  });

  assert.equal(loginResult.ok, true);
  assert.equal(loginResult.isNewUser, false);
  assert.equal(loginResult.user.id, tgUser.id); // Same user ID!
});

test('WhatsApp Auth - conflict rejection when phone is already linked to another account', async () => {
  const phone = '+919876543230';

  // User A owns the phone
  const userA = (await db.query(`INSERT INTO users (phone, age_confirmed_21) VALUES ($1, true) RETURNING id`, [phone])).rows[0];
  await db.query(`INSERT INTO user_identities (user_id, provider, subject) VALUES ($1, 'phone', $2)`, [userA.id, phone]);

  // User B (Telegram user) tries to link User A's phone
  const userB = (await db.query(`INSERT INTO users (telegram_user_id, age_confirmed_21) VALUES (99003344, true) RETURNING id`)).rows[0];

  const req = await requestWhatsAppOtp({ phone, currentUserId: userB.id });
  const otp = getWhatsAppProvider().getSentMessages()[0].otp;

  await assert.rejects(
    () => verifyWhatsAppOtpAndResolveUser({
      challengeId: req.challengeId,
      phone,
      code: otp,
      currentUserId: userB.id
    }),
    /already linked to another NIGHTLIFEZ account/i
  );
});

test('WhatsApp Auth - unlinking identity respects sole-provider guard', async () => {
  const phone = '+919876543240';

  // 1. WhatsApp-only user cannot unlink WhatsApp
  const user = (await db.query(`INSERT INTO users (phone, age_confirmed_21) VALUES ($1, true) RETURNING id`, [phone])).rows[0];
  await db.query(`INSERT INTO user_identities (user_id, provider, subject) VALUES ($1, 'phone', $2)`, [user.id, phone]);

  await assert.rejects(
    () => unlinkWhatsAppIdentity({ userId: user.id, phone }),
    /cannot disconnect your only login method/i
  );

  // 2. Add Telegram identity
  await db.query(`UPDATE users SET telegram_user_id = 99005566 WHERE id = $1`, [user.id]);
  await db.query(`INSERT INTO user_identities (user_id, provider, subject) VALUES ($1, 'telegram', '99005566')`, [user.id]);

  // Now unlinking WhatsApp succeeds!
  const res = await unlinkWhatsAppIdentity({ userId: user.id, phone });
  assert.equal(res.ok, true);

  const linked = await getLinkedIdentities(user.id);
  assert.equal(linked.whatsapp.linked, false);
  assert.equal(linked.telegram.linked, true);
});

test('WhatsApp Auth - notification audit logging records configuration-driven template name', async () => {
  const origTemplateName = process.env.WHATSAPP_OTP_TEMPLATE_NAME;
  try {
    process.env.WHATSAPP_OTP_TEMPLATE_NAME = 'custom_nightlifez_auth_v3';
    const phone = '+919876543250';

    const req = await requestWhatsAppOtp({ phone });
    assert.equal(req.ok, true);

    // Verify outbox record has the configured template name, NOT the hardcoded default
    const { rows } = await db.query(
      `SELECT template_name, recipient, purpose, provider, status 
         FROM notification_messages 
        WHERE recipient = $1 
        ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].template_name, 'custom_nightlifez_auth_v3');
    assert.equal(rows[0].purpose, 'auth_otp');
    assert.equal(rows[0].recipient, phone);
  } finally {
    if (origTemplateName !== undefined) process.env.WHATSAPP_OTP_TEMPLATE_NAME = origTemplateName;
    else delete process.env.WHATSAPP_OTP_TEMPLATE_NAME;
  }
});

test('WhatsApp Auth - phone number normalization handles +910, spaces, and brackets', async () => {
  // Test variations of valid phone numbers
  const variations = [
    { raw: '+91 98765 43261', expected: '+919876543261', masked: '+91 98****3261' },
    { raw: '+91 (0) 98765 43262', expected: '+919876543262', masked: '+91 98****3262' },
    { raw: '9876543263', expected: '+919876543263', masked: '+91 98****3263' },
    { raw: '+9109876543264', expected: '+919876543264', masked: '+91 98****3264' }
  ];

  for (const item of variations) {
    getWhatsAppProvider().clearSentMessages();
    const req = await requestWhatsAppOtp({ phone: item.raw, ip: '127.0.0.1' });
    assert.equal(req.ok, true);
    assert.equal(req.phoneMasked, item.masked);

    const sent = getWhatsAppProvider().getSentMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, item.expected);
  }
});

test('WhatsApp Auth - replay protection and single-use enforcement', async () => {
  const phone = '+919876543270';
  const req = await requestWhatsAppOtp({ phone });
  const otp = getWhatsAppProvider().getSentMessages()[0].otp;

  // 1. First verification succeeds
  const firstVerify = await verifyWhatsAppOtpAndResolveUser({
    challengeId: req.challengeId,
    phone,
    code: otp
  });
  assert.equal(firstVerify.ok, true);

  // 2. Replay with the same code & challengeId fails
  await assert.rejects(
    () => verifyWhatsAppOtpAndResolveUser({
      challengeId: req.challengeId,
      phone,
      code: otp
    }),
    /already been used/i
  );
});

test('WhatsApp Auth - resend cooldown enforcement', async () => {
  const phone = '+919876543280';
  // 1. Initial request succeeds
  const req1 = await requestWhatsAppOtp({ phone });
  assert.equal(req1.ok, true);

  // 2. Immediate second request within cooldown is rejected with 429
  await assert.rejects(
    () => requestWhatsAppOtp({ phone }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, 'cooldown');
      assert.ok(typeof err.retryAfter === 'number');
      return true;
    }
  );
});
