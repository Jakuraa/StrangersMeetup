// lib/services/whatsapp-auth.js - WhatsApp OTP authentication, account creation, and multi-provider linking.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { normalizePhoneNumber, maskPhone } from './phone.js';
import { createOtpChallenge, verifyOtpChallenge } from './otp.js';
import { getWhatsAppConfig, getWhatsAppProvider } from './whatsapp-provider.js';
import { recordConsent } from './communication-consent.js';
import { logger } from '../logger.js';

/**
 * Checks whether WhatsApp messaging is configured and operational on this deployment.
 * Fails closed in production / Vercel if live credentials are not present.
 */
export function isWhatsAppAvailable() {
  const cfg = getWhatsAppConfig();
  const isDeployedOrProd = Boolean(process.env.VERCEL) ||
    process.env.NODE_ENV === 'production' ||
    process.env.VERCEL_ENV === 'production';
  const isMockAllowed = !isDeployedOrProd && (process.env.NODE_ENV === 'test' || Boolean(process.env.TEST_DATABASE_URL) || process.env.DEV_LOGIN === 'true');
  return Boolean(cfg.isLive || isMockAllowed);
}

/**
 * Request an authentication OTP delivered over WhatsApp.
 */
export async function requestWhatsAppOtp({
  phone: rawPhone,
  ip = '127.0.0.1',
  userAgent = '',
  purpose = 'login',
  currentUserId = null,
  promotionalOptIn = false
}) {
  if (!isWhatsAppAvailable()) {
    throw new HttpError(
      503,
      'whatsapp_unavailable',
      'WhatsApp sign-in is currently unavailable. Please sign in with Telegram or try again later.'
    );
  }

  const phone = normalizePhoneNumber(rawPhone);

  // Create OTP challenge in DB (enforces cooldown & rate limits)
  const challenge = await createOtpChallenge({
    phone,
    ip,
    userAgent,
    purpose,
    userId: currentUserId
  });

  const cfg = getWhatsAppConfig();
  const templateName = cfg.otpTemplateName || 'nightlifez_auth_otp';
  const language = cfg.otpTemplateLanguage || 'en';
  const buttonType = cfg.otpButtonType || 'copy_code';

  const provider = getWhatsAppProvider();
  let dispatchResult;
  try {
    dispatchResult = await provider.sendOtpTemplate({
      to: phone,
      otp: challenge.otp,
      language,
      templateName,
      buttonType
    });
  } catch (err) {
    logger.error('failed to dispatch whatsapp otp', { error: err.message, recipient: maskPhone(phone) });
    throw err;
  }

  // Record dispatch in notification_messages outbox for audit and cost tracking
  const idempotencyKey = `otp:${challenge.challengeId}`;
  const loggedTemplateName = dispatchResult.templateName || templateName;
  await db.query(
    `INSERT INTO notification_messages (
       user_id, channel, recipient, purpose, template_name, idempotency_key, 
       status, provider, provider_message_id, delivery_cost_paise, metadata
     ) VALUES ($1, 'whatsapp', $2, 'auth_otp', $3, $4, 'sent', $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      currentUserId,
      phone,
      loggedTemplateName,
      idempotencyKey,
      dispatchResult.provider || 'mock',
      dispatchResult.messageId || null,
      dispatchResult.estimatedCostPaise || 15,
      JSON.stringify({ purpose, promotionalOptIn: Boolean(promotionalOptIn), buttonType: dispatchResult.buttonType || buttonType })
    ]
  );

  return {
    ok: true,
    challengeId: challenge.challengeId,
    phoneMasked: maskPhone(phone),
    resendAfterSeconds: challenge.resendAfterSeconds,
    ...(process.env.DEV_LOGIN === 'true' || process.env.NODE_ENV === 'test' ? { devOtp: challenge.otp } : {})
  };
}

/**
 * Verify OTP, create or retrieve user account, and handle secure identity linking.
 */
export async function verifyWhatsAppOtpAndResolveUser({
  challengeId,
  phone: rawPhone,
  code,
  ip = '127.0.0.1',
  currentUserId = null,
  existingUserId = null,
  promotionalOptIn = false
}) {
  const targetUserId = currentUserId || existingUserId || null;
  const phone = normalizePhoneNumber(rawPhone);

  // Transactionally verify OTP (single-use, max attempts, expiry, timing safety)
  const verifyResult = await verifyOtpChallenge({
    challengeId,
    phone,
    code,
    ip
  });

  return await db.tx(async (c) => {
    // -----------------------------------------------------------------
    // CASE A: User is already signed in (Account Linking Flow)
    // -----------------------------------------------------------------
    if (targetUserId) {
      // Check if this phone number is already linked to another account
      const { rows: conflictRows } = await c.query(
        `SELECT u.id, u.alias 
           FROM users u
           LEFT JOIN user_identities ui ON ui.user_id = u.id
          WHERE ((ui.provider IN ('phone', 'whatsapp') AND ui.subject = $1) OR u.phone = $1)
            AND u.id != $2
          LIMIT 1`,
        [phone, targetUserId]
      );

      if (conflictRows.length > 0) {
        throw new HttpError(
          409,
          'phone_already_linked',
          'This WhatsApp number is already linked to another NIGHTLIFEZ account. Please sign in with that account or contact support.'
        );
      }

      // Link identity to current user
      await c.query(
        `INSERT INTO user_identities (user_id, provider, subject, verified_at)
         VALUES ($1, 'phone', $2, now())
         ON CONFLICT (provider, subject) DO UPDATE SET user_id = EXCLUDED.user_id, verified_at = now()`,
        [targetUserId, phone]
      );

      await c.query(
        `UPDATE users SET phone = $1, updated_at = now() WHERE id = $2`,
        [phone, targetUserId]
      );

      await audit(targetUserId, 'identity_linked', `user:${targetUserId}`, {
        provider: 'phone',
        subject: maskPhone(phone),
        ip
      }, c);

      // Record communication consents
      await recordConsent({
        userId: targetUserId,
        channel: 'whatsapp',
        purpose: 'transactional',
        status: 'opted_in',
        source: 'account_linking',
        ip,
        client: c
      });

      if (promotionalOptIn) {
        await recordConsent({
          userId: targetUserId,
          channel: 'whatsapp',
          purpose: 'promotional',
          status: 'opted_in',
          source: 'account_linking',
          ip,
          client: c
        });
      }

      const { rows: updatedUser } = await c.query(`SELECT * FROM users WHERE id = $1`, [targetUserId]);
      return {
        ok: true,
        user: updatedUser[0],
        isNewUser: false,
        linked: true
      };
    }

    // -----------------------------------------------------------------
    // CASE B: User is NOT signed in (Sign-In or Registration Flow)
    // -----------------------------------------------------------------
    const { rows: existingUsers } = await c.query(
      `SELECT u.* 
         FROM users u
         LEFT JOIN user_identities ui ON ui.user_id = u.id
        WHERE (ui.provider IN ('phone', 'whatsapp') AND ui.subject = $1) OR u.phone = $1
        LIMIT 1`,
      [phone]
    );

    let user;
    let isNewUser = false;

    if (existingUsers.length > 0) {
      // Existing user sign-in
      user = existingUsers[0];
      if (user.status !== 'active') {
        throw new HttpError(403, 'account_restricted', 'This account cannot sign in. Contact support if you think this is a mistake.');
      }

      // Ensure identity row exists
      await c.query(
        `INSERT INTO user_identities (user_id, provider, subject, verified_at)
         VALUES ($1, 'phone', $2, now())
         ON CONFLICT (provider, subject) DO UPDATE SET verified_at = now()`,
        [user.id, phone]
      );

      if (!user.phone) {
        await c.query(`UPDATE users SET phone = $1, updated_at = now() WHERE id = $2`, [phone, user.id]);
        user.phone = phone;
      }

      await audit(user.id, 'login_success', `user:${user.id}`, {
        provider: 'phone',
        subject: maskPhone(phone),
        ip
      }, c);
    } else {
      // Create new user
      isNewUser = true;
      const { rows: newRows } = await c.query(
        `INSERT INTO users (phone, age_confirmed_21, age_confirmed_at, status)
         VALUES ($1, true, now(), 'active')
         RETURNING *`,
        [phone]
      );
      user = newRows[0];

      await c.query(
        `INSERT INTO user_identities (user_id, provider, subject, verified_at)
         VALUES ($1, 'phone', $2, now())
         ON CONFLICT (provider, subject) DO NOTHING`,
        [user.id, phone]
      );

      await audit(user.id, 'user_created', `user:${user.id}`, {
        provider: 'phone',
        subject: maskPhone(phone),
        ip
      }, c);
    }

    // Record essential transactional consent
    await recordConsent({
      userId: user.id,
      channel: 'whatsapp',
      purpose: 'transactional',
      status: 'opted_in',
      source: isNewUser ? 'registration' : 'signin',
      ip,
      client: c
    });

    // Record promotional consent if opted in
    if (promotionalOptIn) {
      await recordConsent({
        userId: user.id,
        channel: 'whatsapp',
        purpose: 'promotional',
        status: 'opted_in',
        source: isNewUser ? 'registration' : 'signin',
        ip,
        client: c
      });
    }

    return {
      ok: true,
      user,
      isNewUser,
      linked: false
    };
  });
}

/**
 * Safely unlinks a WhatsApp identity from an account.
 * Guard: Requires that at least one other verified identity exists (e.g. Telegram).
 */
export async function unlinkWhatsAppIdentity({ userId, phone: rawPhone }) {
  const phone = normalizePhoneNumber(rawPhone);

  return await db.tx(async (c) => {
    // Check total verified identities
    const { rows: identities } = await c.query(
      `SELECT provider, subject FROM user_identities WHERE user_id = $1`,
      [userId]
    );

    const otherIdentities = identities.filter((i) => !(i.provider === 'phone' && i.subject === phone));
    if (otherIdentities.length === 0) {
      throw new HttpError(
        400,
        'cannot_unlink_only_provider',
        'You cannot disconnect your only login method. Please connect Telegram before disconnecting WhatsApp.'
      );
    }

    await c.query(
      `DELETE FROM user_identities 
        WHERE user_id = $1 AND provider IN ('phone', 'whatsapp') AND subject = $2`,
      [userId, phone]
    );

    await c.query(
      `UPDATE users SET phone = NULL, updated_at = now() 
        WHERE id = $1 AND phone = $2`,
      [userId, phone]
    );

    await audit(userId, 'identity_unlinked', `user:${userId}`, {
      provider: 'phone',
      subject: maskPhone(phone)
    }, c);

    return { ok: true };
  });
}

/**
 * Retrieve user's linked authentication providers.
 */
export async function getLinkedIdentities(userId, client = db) {
  const { rows } = await client.query(
    `SELECT provider, subject, verified_at, created_at 
       FROM user_identities 
      WHERE user_id = $1 
      ORDER BY created_at ASC`,
    [userId]
  );

  const { rows: userRows } = await client.query(`SELECT telegram_user_id, phone FROM users WHERE id = $1`, [userId]);
  const user = userRows[0] || {};

  const hasTelegram = Boolean(user.telegram_user_id || rows.some((r) => r.provider === 'telegram'));
  const phoneRow = rows.find((r) => r.provider === 'phone' || r.provider === 'whatsapp');
  const hasPhone = Boolean(user.phone || phoneRow);
  const phoneNumber = user.phone || phoneRow?.subject || null;

  return {
    telegram: {
      linked: hasTelegram,
      telegramUserId: user.telegram_user_id ? String(user.telegram_user_id) : null
    },
    whatsapp: {
      linked: hasPhone,
      phone: phoneNumber,
      phoneMasked: phoneNumber ? maskPhone(phoneNumber) : null
    }
  };
}
