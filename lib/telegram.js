// lib/telegram.js - Server-side Telegram Bot API Adapter for Telegram Stars Recurring Payments
import crypto from 'node:crypto';
import https from 'node:https';
import { getConfig } from './config.js';
import { logger } from './logger.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * Execute Telegram Bot API method
 */
async function callTelegramApi(method, body = {}) {
  const token = await getConfig('TELEGRAM_BOT_TOKEN');
  const mockMode = (await getConfig('MOCK_TELEGRAM')) === 'true' || !token || token.startsWith('YOUR_');

  if (mockMode) {
    logger.info(`[MOCK_TELEGRAM] Bot API call: ${method}`, {
      method,
      mockParams: { ...body, payload: body.payload ? '[PAYLOAD_PRESENT]' : undefined }
    });

    if (method === 'createInvoiceLink') {
      const mockSlug = crypto.randomBytes(8).toString('hex');
      return { ok: true, result: `https://t.me/$${await getConfig('TELEGRAM_BOT_USERNAME', 'StrangersMeetupBot')}?start=invoice_${mockSlug}` };
    }

    if (method === 'answerPreCheckoutQuery') {
      return { ok: true, result: true };
    }

    if (method === 'createChatInviteLink') {
      const linkId = crypto.randomBytes(6).toString('hex');
      return {
        ok: true,
        result: {
          invite_link: `https://t.me/+mock_invite_${linkId}`,
          name: body.name || 'Member Single-Use Invite',
          member_limit: body.member_limit || 1,
          is_revoked: false
        }
      };
    }

    if (method === 'banChatMember' || method === 'unbanChatMember') {
      return { ok: true, result: true };
    }

    return { ok: true, result: {} };
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const payloadStr = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr)
        },
        timeout: 8000
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.ok) {
              logger.warn(`Telegram API error on ${method}`, {
                errorCode: parsed.error_code,
                description: parsed.description
              });
            }
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Failed to parse Telegram API response: ${err.message}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Telegram API timeout on ${method}`));
    });

    req.on('error', (err) => {
      reject(new Error(`Telegram API network error on ${method}: ${err.message}`));
    });

    req.write(payloadStr);
    req.end();
  });
}

/**
 * Generate HMAC signature for invoice payload to prevent tampering
 */
export async function signInvoicePayload(dataObj) {
  const secret = await getConfig('APP_SECRET', 'fallback-dev-secret-salt-2026');
  const serialized = JSON.stringify(dataObj);
  const hmac = crypto.createHmac('sha256', secret).update(serialized).digest('hex').substring(0, 16);
  return `${Buffer.from(serialized).toString('base64url')}.${hmac}`;
}

/**
 * Verify HMAC signature on invoice payload
 */
export async function verifyInvoicePayload(signedPayload) {
  if (!signedPayload || typeof signedPayload !== 'string') return null;
  const parts = signedPayload.split('.');
  if (parts.length !== 2) return null;

  const [b64Data, providedHmac] = parts;
  try {
    const serialized = Buffer.from(b64Data, 'base64url').toString('utf8');
    const secret = await getConfig('APP_SECRET', 'fallback-dev-secret-salt-2026');
    const expectedHmac = crypto.createHmac('sha256', secret).update(serialized).digest('hex').substring(0, 16);

    const bufA = Buffer.from(providedHmac);
    const bufB = Buffer.from(expectedHmac);
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      logger.warn('Invoice payload HMAC verification failed');
      return null;
    }

    return JSON.parse(serialized);
  } catch (err) {
    logger.error('Error parsing invoice payload', err);
    return null;
  }
}

/**
 * Verify Telegram Webhook Secret Token header
 */
export async function verifyWebhookSecret(secretHeader) {
  const expectedSecret = await getConfig('TELEGRAM_WEBHOOK_SECRET');
  if (!expectedSecret) {
    logger.warn('TELEGRAM_WEBHOOK_SECRET not configured');
    return false;
  }
  if (!secretHeader || typeof secretHeader !== 'string') return false;

  const bufProvided = Buffer.from(secretHeader);
  const bufExpected = Buffer.from(expectedSecret);

  if (bufProvided.length !== bufExpected.length) return false;
  return crypto.timingSafeEqual(bufProvided, bufExpected);
}

/**
 * Official Telegram Bot API: createInvoiceLink for Recurring Stars Subscription
 * Docs: https://core.telegram.org/bots/api#createinvoicelink
 */
export async function createRecurringStarsInvoiceLink({
  title,
  description,
  tierId,
  starsPrice,
  telegramUserId,
  memberId,
  billingPeriodSeconds = 2592000 // 30 days
}) {
  const orderId = `sm_${tierId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const payloadData = {
    orderId,
    tierId,
    starsPrice,
    telegramUserId,
    memberId,
    timestamp: Date.now()
  };

  const signedPayload = await signInvoicePayload(payloadData);

  const requestBody = {
    title: title.substring(0, 32),
    description: description.substring(0, 255),
    payload: signedPayload,
    provider_token: '', // Must be empty string for Telegram Stars (XTR)
    currency: 'XTR',
    prices: [
      {
        label: `${title} (30-Day Subscription)`,
        amount: starsPrice
      }
    ],
    subscription_period: billingPeriodSeconds // 2592000 for 30-day recurring Stars subscription
  };

  const response = await callTelegramApi('createInvoiceLink', requestBody);
  if (!response.ok) {
    throw new Error(response.description || 'Failed to create Telegram invoice link');
  }

  return {
    orderId,
    invoiceLink: response.result,
    signedPayload
  };
}

/**
 * Official Telegram Bot API: answerPreCheckoutQuery
 * Must be answered within 10 seconds of receipt!
 */
export async function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage = '') {
  return await callTelegramApi('answerPreCheckoutQuery', {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    error_message: ok ? undefined : (errorMessage || 'Subscription payment could not be validated')
  });
}

/**
 * Official Telegram Bot API: createChatInviteLink
 * Generates single-use invite link for private channel
 */
export async function createPrivateChannelInviteLink(channelId, memberId, expireHours = 48) {
  const expireDate = Math.floor(Date.now() / 1000) + (expireHours * 3600);
  const response = await callTelegramApi('createChatInviteLink', {
    chat_id: channelId,
    name: `Member-${memberId || 'access'}`,
    member_limit: 1, // Strictly single-use
    expire_date: expireDate
  });

  if (!response.ok) {
    throw new Error(response.description || `Failed to create invite link for channel ${channelId}`);
  }

  return response.result;
}

/**
 * Revoke member access from private channel (e.g. on expiration or cancellation)
 */
export async function revokeChannelMember(channelId, telegramUserId) {
  // Ban and immediately unban removes user from channel without permanently blocking them
  const banRes = await callTelegramApi('banChatMember', {
    chat_id: channelId,
    user_id: telegramUserId
  });
  if (banRes.ok) {
    await callTelegramApi('unbanChatMember', {
      chat_id: channelId,
      user_id: telegramUserId,
      only_if_banned: true
    });
  }
  return banRes.ok;
}

/**
 * Validate Telegram Mini App initData per official Telegram specifications
 * Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function validateTelegramInitData(initDataString) {
  if (!initDataString || typeof initDataString !== 'string') {
    return { ok: false, error: 'Empty or invalid initData string' };
  }

  const token = await getConfig('TELEGRAM_BOT_TOKEN');
  const mockMode = (await getConfig('MOCK_TELEGRAM')) === 'true' || !token || token.startsWith('YOUR_');

  const params = new URLSearchParams(initDataString);
  const hash = params.get('hash');
  if (!hash) {
    return { ok: false, error: 'Missing hash in initData' };
  }

  params.delete('hash');
  const keys = Array.from(params.keys()).sort();
  const dataCheckString = keys.map((key) => `${key}=${params.get(key)}`).join('\n');

  let user = null;
  try {
    const userRaw = params.get('user');
    user = userRaw ? JSON.parse(userRaw) : null;
  } catch {
    user = null;
  }

  const authDate = parseInt(params.get('auth_date') || '0', 10);

  if (mockMode) {
    return {
      ok: true,
      isMock: true,
      authDate,
      user: user || { id: 12345678, first_name: 'TestUser', username: 'testuser' },
      queryId: params.get('query_id')
    };
  }

  // 1. Calculate secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();

  // 2. Calculate check_hash = HMAC_SHA256(dataCheckString, secret_key)
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const bufProvided = Buffer.from(hash, 'hex');
  const bufCalculated = Buffer.from(calculatedHash, 'hex');

  if (bufProvided.length !== bufCalculated.length || !crypto.timingSafeEqual(bufProvided, bufCalculated)) {
    return { ok: false, error: 'Invalid HMAC signature on initData' };
  }

  // Check freshness (24 hours = 86400 seconds)
  const now = Math.floor(Date.now() / 1000);
  if (now - authDate > 86400) {
    return { ok: false, error: 'initData has expired (exceeds 24 hours)' };
  }

  return {
    ok: true,
    user,
    authDate,
    queryId: params.get('query_id')
  };
}
