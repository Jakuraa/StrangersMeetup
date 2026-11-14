// lib/services/notification-dispatcher.js - Multichannel notification dispatcher with queueing, deduplication, cost estimation, and delivery tracking.
import { db } from '../db.js';
import { logger } from '../logger.js';
import { getWhatsAppConfig, getWhatsAppProvider } from './whatsapp-provider.js';
import { maskPhone } from './phone.js';
import { hasConsent, isSuppressed, addSuppression } from './communication-consent.js';
import { tg } from '../telegram/api.js';

export const ESTIMATED_COST_PAISE = {
  auth_otp: 15,       // Meta authentication conversation (~₹0.15)
  transactional: 15,  // Meta utility conversation (~₹0.15)
  promotional: 80,    // Meta marketing conversation (~₹0.80)
  telegram: 0         // Telegram Bot API is free
};

/**
 * Dispatches a notification via the selected channel with deduplication,
 * consent validation, and audit recording in notification_messages.
 */
export async function dispatchNotification({
  notificationId = null,
  userId = null,
  recipient,
  channel = 'whatsapp',
  purpose = 'transactional',
  templateName = null,
  templateComponents = [],
  text = null,
  idempotencyKey,
  metadata = {}
}) {
  if (!recipient) {
    throw new Error('Recipient is required for dispatch');
  }
  if (!idempotencyKey) {
    throw new Error('idempotencyKey is required for deduplication');
  }

  // 1. Deduplication check
  const existing = (await db.query(
    `SELECT * FROM notification_messages WHERE idempotency_key = $1`,
    [idempotencyKey]
  )).rows[0];

  if (existing) {
    logger.info('notification dispatch skipped (duplicate idempotency key)', {
      idempotencyKey,
      existingId: existing.id,
      status: existing.status
    });
    return existing;
  }

  // 2. Suppression check
  const suppressed = await isSuppressed({ destination: recipient, channel });
  if (suppressed) {
    logger.warn('notification dispatch skipped (recipient suppressed)', {
      recipient: channel === 'whatsapp' ? maskPhone(recipient) : recipient,
      channel,
      purpose
    });
    const { rows } = await db.query(
      `INSERT INTO notification_messages (
        notification_id, user_id, channel, recipient, purpose, template_name,
        idempotency_key, status, provider, delivery_cost_paise, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'suppressed', 'none', 0, $8)
      RETURNING *`,
      [notificationId, userId, channel, recipient, purpose, templateName, idempotencyKey, JSON.stringify(metadata)]
    );
    return rows[0];
  }

  // 3. Consent check (if userId is available)
  if (userId) {
    const consented = await hasConsent({ userId, channel, purpose });
    if (!consented) {
      logger.warn('notification dispatch skipped (no consent for purpose)', {
        userId,
        channel,
        purpose
      });
      const { rows } = await db.query(
        `INSERT INTO notification_messages (
          notification_id, user_id, channel, recipient, purpose, template_name,
          idempotency_key, status, provider, delivery_cost_paise, last_error, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', 'none', 0, 'no_user_consent', $8)
        RETURNING *`,
        [notificationId, userId, channel, recipient, purpose, templateName, idempotencyKey, JSON.stringify(metadata)]
      );
      return rows[0];
    }
  }

  const costPaise = channel === 'telegram' ? 0 : (ESTIMATED_COST_PAISE[purpose] || 15);
  const providerType = channel === 'whatsapp'
    ? (getWhatsAppConfig().isLive && process.env.NODE_ENV !== 'test' ? 'meta_cloud_api' : 'mock')
    : 'telegram_bot';

  // 4. Create pending outbox record
  const { rows: inserted } = await db.query(
    `INSERT INTO notification_messages (
      notification_id, user_id, channel, recipient, purpose, template_name,
      idempotency_key, status, provider, delivery_cost_paise, attempts, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, 1, $10)
    RETURNING *`,
    [notificationId, userId, channel, recipient, purpose, templateName, idempotencyKey, providerType, costPaise, JSON.stringify(metadata)]
  );
  const messageRow = inserted[0];

  // 5. Channel dispatch
  try {
    if (channel === 'whatsapp') {
      const provider = getWhatsAppProvider();
      const sendResult = await provider.sendTemplate({
        to: recipient,
        templateName: templateName || 'nightlifez_generic_notice',
        language: 'en',
        components: templateComponents
      });

      const { rows: updated } = await db.query(
        `UPDATE notification_messages
            SET status = 'sent',
                provider_message_id = $2,
                sent_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [messageRow.id, sendResult.messageId]
      );
      return updated[0];
    } else if (channel === 'telegram') {
      const telegramResult = await tg('sendMessage', {
        chat_id: recipient,
        text: text || metadata.summary || 'Update from NIGHTLIFEZ',
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(metadata.buttons ? { reply_markup: { inline_keyboard: metadata.buttons } } : {})
      });

      const { rows: updated } = await db.query(
        `UPDATE notification_messages
            SET status = 'sent',
                provider_message_id = $2,
                sent_at = now(),
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [messageRow.id, String(telegramResult?.message_id || '')]
      );
      return updated[0];
    } else {
      throw new Error(`Unsupported notification channel: ${channel}`);
    }
  } catch (err) {
    const errorMsg = String(err.message || err).slice(0, 500);
    logger.error('channel dispatch failed', {
      messageId: messageRow.id,
      channel,
      recipient: channel === 'whatsapp' ? maskPhone(recipient) : recipient,
      error: errorMsg
    });

    const { rows: updated } = await db.query(
      `UPDATE notification_messages
          SET status = 'failed',
              last_error = $2,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [messageRow.id, errorMsg]
    );
    return updated[0];
  }
}

/**
 * Updates delivery status from webhook receipt.
 */
export async function updateDeliveryReceipt({
  providerMessageId,
  status,
  timestamp = new Date(),
  errorCode = null,
  errorMessage = null
}) {
  if (!providerMessageId) return null;

  const validStatuses = ['delivered', 'read', 'failed'];
  if (!validStatuses.includes(status)) return null;

  const updateDelivered = status === 'delivered' || status === 'read';
  const deliveredSql = updateDelivered ? `, delivered_at = COALESCE(delivered_at, $3)` : ``;
  const errorSql = errorMessage ? `, last_error = $4` : ``;

  const query = `
    UPDATE notification_messages
       SET status = $2,
           updated_at = now()
           ${deliveredSql}
           ${errorSql}
     WHERE provider_message_id = $1
     RETURNING *
  `;

  const params = [providerMessageId, status];
  if (updateDelivered) params.push(timestamp);
  if (errorMessage) params.push(errorMessage);

  const { rows } = await db.query(query, params);
  return rows[0] || null;
}

/**
 * Handles incoming STOP or opt-out keyword from user.
 */
export async function handleOptOutKeyword({ destination, channel = 'whatsapp', reason = 'keyword_opt_out' }) {
  await addSuppression({ destination, channel, reason });
  // If destination is a phone or telegram id, find user and withdraw promotional consent
  if (channel === 'whatsapp') {
    const user = (await db.query(`SELECT id FROM users WHERE phone = $1`, [destination])).rows[0];
    if (user) {
      await db.query(
        `UPDATE communication_consents
            SET status = 'opted_out', updated_at = now()
          WHERE user_id = $1 AND channel = 'whatsapp' AND purpose = 'promotional'`,
        [user.id]
      );
    }
  }
  return { ok: true, destination: maskPhone(destination), suppressed: true };
}

/**
 * Admin telemetry data aggregation.
 */
export async function getNotificationTelemetry() {
  const config = getWhatsAppConfig();

  // 1. OTP statistics
  const otpStats = (await db.query(`
    SELECT
      COUNT(*)::int AS total_challenges,
      COUNT(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS verified_challenges,
      COUNT(*) FILTER (WHERE attempts_count >= max_attempts)::int AS locked_challenges,
      COALESCE(AVG(EXTRACT(EPOCH FROM (consumed_at - created_at))) FILTER (WHERE consumed_at IS NOT NULL), 0)::float AS avg_verify_seconds
    FROM otp_challenges
  `)).rows[0];

  const totalChallenges = otpStats.total_challenges || 0;
  const verifiedChallenges = otpStats.verified_challenges || 0;
  const verificationRate = totalChallenges > 0 ? Math.round((verifiedChallenges / totalChallenges) * 100) : 0;

  // 2. Messages breakdown
  const messageStats = (await db.query(`
    SELECT
      channel,
      status,
      purpose,
      COUNT(*)::int AS count,
      COALESCE(SUM(delivery_cost_paise), 0)::int AS total_cost_paise
    FROM notification_messages
    GROUP BY channel, status, purpose
  `)).rows;

  const totalSpendPaise = messageStats.reduce((sum, r) => sum + (r.total_cost_paise || 0), 0);

  // 3. Suppressions count
  const suppressionCount = (await db.query(`SELECT COUNT(*)::int AS count FROM notification_suppressions`)).rows[0]?.count || 0;

  return {
    whatsapp: {
      enabled: config.enabled,
      isConfigured: config.isConfigured,
      isLive: config.isLive,
      mode: config.isLive ? 'live_meta_cloud_api' : 'safe_mock_adapter',
      phoneNumberId: config.phoneNumberId ? `${config.phoneNumberId.slice(0, 4)}****` : 'Not Set',
      businessAccountId: config.businessAccountId ? `${config.businessAccountId.slice(0, 4)}****` : 'Not Set',
      apiVersion: config.apiVersion,
      otpTemplateName: config.otpTemplateName,
      otpTemplateLanguage: config.otpTemplateLanguage
    },
    otp: {
      totalChallenges,
      verifiedChallenges,
      lockedChallenges: otpStats.locked_challenges || 0,
      verificationRatePercent: verificationRate,
      avgVerifySeconds: Math.round(otpStats.avgVerifySeconds || 0)
    },
    messages: {
      totalSpendPaise,
      totalSpendRupees: (totalSpendPaise / 100).toFixed(2),
      breakdown: messageStats
    },
    suppressions: {
      total: suppressionCount
    }
  };
}

/**
 * Returns paginated message log with PII masking for admin inspection.
 */
export async function getNotificationMessagesList({ limit = 50, offset = 0, channel = null, status = null } = {}) {
  let whereClauses = [];
  let params = [];
  let idx = 1;

  if (channel) {
    whereClauses.push(`channel = $${idx++}`);
    params.push(channel);
  }
  if (status) {
    whereClauses.push(`status = $${idx++}`);
    params.push(status);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const query = `
    SELECT id, notification_id, user_id, channel, recipient, purpose, template_name,
           status, provider, provider_message_id, delivery_cost_paise, attempts, last_error,
           sent_at, delivered_at, created_at
      FROM notification_messages
      ${whereStr}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const { rows } = await db.query(query, params);

  return rows.map((r) => ({
    ...r,
    recipientMasked: r.channel === 'whatsapp' || r.recipient.startsWith('+')
      ? maskPhone(r.recipient)
      : (r.recipient.length > 6 ? `${r.recipient.slice(0, 3)}****` : r.recipient)
  }));
}

/**
 * Returns suppressions list with masked destinations.
 */
export async function getSuppressionsList({ limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT id, channel, destination, reason, created_at
       FROM notification_suppressions
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return rows.map((r) => ({
    ...r,
    destinationMasked: r.channel === 'whatsapp' || r.destination.startsWith('+')
      ? maskPhone(r.destination)
      : (r.destination.length > 6 ? `${r.destination.slice(0, 3)}****` : r.destination)
  }));
}
