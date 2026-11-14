// lib/services/otp.js - Cryptographically secure OTP generation, hashing, and transactional verification.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError, safeEqual, hashIp } from '../http.js';
import { rateLimit } from '../ratelimit.js';
import { hashPhone } from './phone.js';
import { logger } from '../logger.js';

export const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
export const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
export const MAX_VERIFY_ATTEMPTS = 5;

/**
 * Generate a cryptographically secure 6-digit random string (100000 - 999999).
 */
export function generateOtpCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Hash an OTP using HMAC-SHA256 with a per-challenge cryptographic salt.
 */
export function hashOtpCode(otp, salt) {
  return crypto.createHmac('sha256', salt).update(String(otp).trim()).digest('hex');
}

/**
 * Create a new OTP challenge in the database.
 * Enforces resend cooldown and rate limits.
 */
export async function createOtpChallenge({
  phone,
  ip = '127.0.0.1',
  userAgent = '',
  purpose = 'login',
  userId = null,
  client = db
}) {
  // Rate limits:
  // IP limit: Max 10 requests per 10 minutes
  await rateLimit(`otp:req:ip:${hashIp(ip)}`, 10, 600);
  // Phone limit: Max 5 requests per 10 minutes
  await rateLimit(`otp:req:phone:${hashPhone(phone)}`, 5, 600);

  // Check active challenge for cooldown
  const { rows: activeChallenges } = await client.query(
    `SELECT id, resend_after, expires_at 
       FROM otp_challenges 
      WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC 
      LIMIT 1`,
    [phone]
  );

  const now = new Date();
  if (activeChallenges.length > 0) {
    const active = activeChallenges[0];
    const resendAfter = new Date(active.resend_after);
    if (resendAfter > now) {
      const waitSeconds = Math.ceil((resendAfter.getTime() - now.getTime()) / 1000);
      const err = new HttpError(429, 'cooldown', `Please wait ${waitSeconds} seconds before requesting another code.`, {
        retryAfter: waitSeconds
      });
      err.retryAfter = waitSeconds;
      throw err;
    }
  }

  const otp = generateOtpCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const otpHash = hashOtpCode(otp, salt);
  const expiresAt = new Date(now.getTime() + OTP_EXPIRY_MS);
  const resendAfter = new Date(now.getTime() + RESEND_COOLDOWN_MS);

  const { rows } = await client.query(
    `INSERT INTO otp_challenges (phone, otp_hash, salt, purpose, user_id, expires_at, resend_after, ip, user_agent, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     RETURNING id, phone, expires_at, resend_after`,
    [phone, otpHash, salt, purpose, userId, expiresAt, resendAfter, ip, userAgent.slice(0, 255), now]
  );

  logger.info('otp challenge created', {
    challengeId: rows[0].id,
    purpose,
    phoneHash: hashPhone(phone)
  });

  return {
    challengeId: rows[0].id,
    otp, // Delivered to provider adapter only; never exposed to HTTP response
    expiresAt,
    resendAfterSeconds: 60
  };
}

/**
 * Verify an OTP challenge using atomic row locking and constant-time comparison.
 */
export async function verifyOtpChallenge({
  challengeId,
  phone,
  code,
  ip = '127.0.0.1'
}) {
  // Verification rate limits
  await rateLimit(`otp:ver:ip:${hashIp(ip)}`, 15, 600);
  await rateLimit(`otp:ver:phone:${hashPhone(phone)}`, 10, 600);

  if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
    throw new HttpError(400, 'invalid_otp', 'Please enter a valid 6-digit code.');
  }

  const result = await db.tx(async (c) => {
    // Atomically lock challenge row
    const { rows } = await c.query(
      `SELECT id, phone, otp_hash, salt, purpose, user_id, expires_at, consumed_at, attempts_count, max_attempts
         FROM otp_challenges
        WHERE id = $1 FOR UPDATE`,
      [challengeId]
    );

    if (!rows.length || rows[0].phone !== phone) {
      // Generic failure message to prevent enumeration
      return { status: 'invalid', message: 'The code you entered is invalid or has expired.' };
    }

    const challenge = rows[0];

    // Check single-use
    if (challenge.consumed_at) {
      return { status: 'consumed', message: 'This code has already been used. Please request a new one.' };
    }

    // Check expiry
    if (new Date(challenge.expires_at) < new Date()) {
      return { status: 'expired', message: 'This code has expired. Please request a new one.' };
    }

    // Check max attempts
    if (challenge.attempts_count >= challenge.max_attempts) {
      return { status: 'locked', message: 'Too many incorrect attempts. Please request a new code.' };
    }

    // Constant-time hash verification
    const candidateHash = hashOtpCode(code.trim(), challenge.salt);
    const isMatch = safeEqual(candidateHash, challenge.otp_hash);

    if (!isMatch) {
      const nextAttempts = challenge.attempts_count + 1;
      await c.query(
        `UPDATE otp_challenges SET attempts_count = $1, updated_at = now() WHERE id = $2`,
        [nextAttempts, challenge.id]
      );

      const remaining = challenge.max_attempts - nextAttempts;
      return {
        status: remaining <= 0 ? 'locked' : 'mismatch',
        remaining,
        message: remaining <= 0
          ? 'Too many incorrect attempts. Please request a new code.'
          : `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
      };
    }

    // Consume challenge
    await c.query(
      `UPDATE otp_challenges SET consumed_at = now(), updated_at = now() WHERE id = $1`,
      [challenge.id]
    );

    return {
      status: 'ok',
      challengeId: challenge.id,
      purpose: challenge.purpose,
      userId: challenge.user_id,
      phone: challenge.phone
    };
  });

  if (result.status === 'ok') {
    logger.info('otp challenge verified successfully', {
      challengeId: result.challengeId,
      purpose: result.purpose,
      phoneHash: hashPhone(phone)
    });
    return {
      ok: true,
      challengeId: result.challengeId,
      purpose: result.purpose,
      userId: result.userId,
      phone: result.phone
    };
  }

  if (result.status === 'locked') {
    throw new HttpError(429, 'too_many_attempts', result.message);
  }
  if (result.status === 'consumed') {
    throw new HttpError(400, 'otp_already_used', result.message);
  }
  if (result.status === 'expired') {
    throw new HttpError(400, 'otp_expired', result.message);
  }
  throw new HttpError(400, 'invalid_otp', result.message);
}
