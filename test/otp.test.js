import test from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb } from './helpers.js';
import {
  generateOtpCode,
  hashOtpCode,
  createOtpChallenge,
  verifyOtpChallenge
} from '../lib/services/otp.js';

test.beforeEach(async () => {
  await resetDb();
});

test('generateOtpCode produces 6-digit numeric string', () => {
  for (let i = 0; i < 20; i++) {
    const code = generateOtpCode();
    assert.match(code, /^\d{6}$/);
    const num = Number(code);
    assert.ok(num >= 100000 && num <= 999999);
  }
});

test('hashOtpCode is deterministic with salt', () => {
  const salt = 'abcdef1234567890';
  const h1 = hashOtpCode('123456', salt);
  const h2 = hashOtpCode('123456', salt);
  const h3 = hashOtpCode('123457', salt);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('OTP challenge lifecycle: create, verify with correct code', async () => {
  const phone = '+919876543210';
  const challenge = await createOtpChallenge({ phone, ip: '192.168.1.1' });

  assert.ok(challenge.challengeId);
  assert.match(challenge.otp, /^\d{6}$/);
  assert.equal(challenge.resendAfterSeconds, 60);

  // Verify correctly
  const result = await verifyOtpChallenge({
    challengeId: challenge.challengeId,
    phone,
    code: challenge.otp,
    ip: '192.168.1.1'
  });

  assert.equal(result.ok, true);
  assert.equal(result.phone, phone);

  // Re-verify should fail (single-use)
  await assert.rejects(
    () => verifyOtpChallenge({
      challengeId: challenge.challengeId,
      phone,
      code: challenge.otp,
      ip: '192.168.1.1'
    }),
    /already been used/i
  );
});

test('OTP challenge: invalid code decrements remaining attempts and locks out after 5', async () => {
  const phone = '+919876543211';
  const challenge = await createOtpChallenge({ phone, ip: '192.168.1.2' });

  // 1st bad attempt
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: challenge.challengeId, phone, code: '000000', ip: '192.168.1.2' }),
    /4 attempts remaining/i
  );

  // 2nd bad attempt
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: challenge.challengeId, phone, code: '000000', ip: '192.168.1.2' }),
    /3 attempts remaining/i
  );

  // 3rd bad attempt
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: challenge.challengeId, phone, code: '000000', ip: '192.168.1.2' }),
    /2 attempts remaining/i
  );

  // 4th bad attempt
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: challenge.challengeId, phone, code: '000000', ip: '192.168.1.2' }),
    /1 attempt remaining/i
  );

  // 5th bad attempt -> lockout
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: challenge.challengeId, phone, code: '000000', ip: '192.168.1.2' }),
    /Too many incorrect attempts/i
  );

  // Even with the correct OTP now, challenge is locked
  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: challenge.challengeId, phone, code: challenge.otp, ip: '192.168.1.2' }),
    /Too many incorrect attempts/i
  );
});

test('OTP challenge: resend cooldown blocks premature requests', async () => {
  const phone = '+919876543212';
  await createOtpChallenge({ phone, ip: '192.168.1.3' });

  // Immediate second request within 60s
  await assert.rejects(
    () => createOtpChallenge({ phone, ip: '192.168.1.3' }),
    (err) => {
      assert.equal(err.status, 429);
      assert.match(err.message, /Please wait \d+ seconds/);
      assert.ok((err.retryAfter || err.extra?.retryAfter) > 0);
      return true;
    }
  );
});

test('OTP challenge: expired OTP is rejected', async () => {
  const phone = '+919876543213';
  const challenge = await createOtpChallenge({ phone, ip: '192.168.1.4' });

  // Manually backdate expires_at in DB
  await db.query(`UPDATE otp_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [challenge.challengeId]);

  await assert.rejects(
    () => verifyOtpChallenge({ challengeId: challenge.challengeId, phone, code: challenge.otp, ip: '192.168.1.4' }),
    /This code has expired/i
  );
});
