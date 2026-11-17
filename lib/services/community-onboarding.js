// lib/services/community-onboarding.js - Automated community onboarding for Telegram and WhatsApp.
// Enforces idempotent records, explicit consent separation, PII protection, and official channel tracking.

import { db } from '../db.js';
import { tg } from '../telegram/api.js';
import { siteUrl, telegramCommunityUrl, whatsappChannelUrl, env } from '../config.js';
import { maskPhone } from './phone.js';
import { logger } from '../logger.js';
import { HttpError } from '../http.js';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Register user in the Telegram onboarding flow.
 * Dispatches a welcome message ONLY if the user has started the bot or authorized communication,
 * and NEVER repeats the welcome message on subsequent logins.
 */
export async function registerTelegramOnboarding({
  userId,
  telegramUserId,
  botStarted = false,
  c = db
}) {
  if (!userId) throw new HttpError(400, 'missing_user_id', 'User ID is required');

  const tgIdNum = telegramUserId ? Number(telegramUserId) : null;

  // 1. Check existing record
  const existing = (await c.query(
    `SELECT * FROM user_onboarding WHERE user_id = $1 AND channel = 'telegram' FOR UPDATE`,
    [userId]
  )).rows[0];

  let record = existing;

  if (!existing) {
    const insertRes = await c.query(
      `INSERT INTO user_onboarding (
         user_id, channel, status, telegram_user_id, created_at, updated_at
       ) VALUES ($1, 'telegram', 'registered', $2, now(), now())
       ON CONFLICT (user_id, channel) DO UPDATE
         SET telegram_user_id = COALESCE(EXCLUDED.telegram_user_id, user_onboarding.telegram_user_id),
             updated_at = now()
       RETURNING *`,
      [userId, tgIdNum]
    );
    record = insertRes.rows[0];
  } else if (tgIdNum && !existing.telegram_user_id) {
    const updateRes = await c.query(
      `UPDATE user_onboarding
          SET telegram_user_id = $2, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [existing.id, tgIdNum]
    );
    record = updateRes.rows[0];
  }

  // 2. Dispatch welcome message ONLY if bot communication is authorized AND welcome has NOT been sent yet
  const canSendWelcome = Boolean(botStarted && tgIdNum && !record.welcome_sent_at);

  if (canSendWelcome) {
    try {
      const commUrl = telegramCommunityUrl();
      const welcomeText =
        'Welcome to <b>NIGHTLIFEZ</b>! 🍸✨\n\n' +
        'Your account is verified and ready. Discover exclusive weekend parties, social mixers, dinner clubs, and secret nightlife across South India (21+).\n\n' +
        'Join our official community channel for private event drops, secret venue coordinates, and guestlist privileges.';

      const buttons = [
        [{ text: 'Join NIGHTLIFEZ Community', url: commUrl }],
        [{ text: 'Open NIGHTLIFEZ', web_app: { url: siteUrl() } }]
      ];

      await tg('sendMessage', {
        chat_id: tgIdNum,
        text: welcomeText,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buttons }
      });

      // Check community membership status where bot permissions allow
      let membershipVerified = false;
      const eventsChatId = env('TG_CHAT_ID_EVENTS');
      if (eventsChatId) {
        try {
          const member = await tg('getChatMember', { chat_id: eventsChatId, user_id: tgIdNum });
          if (member && ['creator', 'administrator', 'member', 'restricted'].includes(member.status)) {
            membershipVerified = true;
          }
        } catch {
          // Non-fatal if bot lacks admin rights on chat
        }
      }

      const updated = await c.query(
        `UPDATE user_onboarding
            SET status = 'welcome_sent',
                welcome_sent_at = now(),
                channel_offered_at = COALESCE(channel_offered_at, now()),
                membership_verified = $2,
                membership_checked_at = now(),
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [record.id, membershipVerified]
      );
      record = updated.rows[0];
    } catch (err) {
      logger.warn('community onboarding welcome delivery deferred or failed', {
        userId,
        telegramUserId: tgIdNum,
        error: err.message
      });
    }
  }

  return {
    ok: true,
    record,
    communityUrl: telegramCommunityUrl(),
    welcomeSent: Boolean(record.welcome_sent_at)
  };
}

/**
 * Register user in the WhatsApp onboarding flow.
 * Idempotently records that the channel follow action was offered.
 * Never claims false membership and never sends unsolicited marketing messages.
 */
export async function registerWhatsAppOnboarding({
  userId,
  phone,
  c = db
}) {
  if (!userId) throw new HttpError(400, 'missing_user_id', 'User ID is required');

  const existing = (await c.query(
    `SELECT * FROM user_onboarding WHERE user_id = $1 AND channel = 'whatsapp' FOR UPDATE`,
    [userId]
  )).rows[0];

  let record = existing;

  if (!existing) {
    const insertRes = await c.query(
      `INSERT INTO user_onboarding (
         user_id, channel, status, whatsapp_phone, channel_offered_at, created_at, updated_at
       ) VALUES ($1, 'whatsapp', 'channel_offered', $2, now(), now(), now())
       ON CONFLICT (user_id, channel) DO UPDATE
         SET whatsapp_phone = COALESCE(EXCLUDED.whatsapp_phone, user_onboarding.whatsapp_phone),
             channel_offered_at = COALESCE(user_onboarding.channel_offered_at, now()),
             updated_at = now()
       RETURNING *`,
      [userId, phone || null]
    );
    record = insertRes.rows[0];
  } else if (phone && !existing.whatsapp_phone) {
    const updateRes = await c.query(
      `UPDATE user_onboarding
          SET whatsapp_phone = $2,
              channel_offered_at = COALESCE(channel_offered_at, now()),
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [existing.id, phone]
    );
    record = updateRes.rows[0];
  }

  return {
    ok: true,
    record,
    channelUrl: whatsappChannelUrl(),
    offered: true
  };
}

/**
 * Tracks attendee user actions on community channels (e.g. clicking "Follow Channel" or "Join Community").
 * Preserves the invariant: tracks that the action was clicked, but never falsely claims channel membership.
 */
export async function trackOnboardingAction({
  userId,
  channel,
  action,
  metadata = {},
  c = db
}) {
  if (!userId || !channel || !action) {
    throw new HttpError(400, 'invalid_params', 'userId, channel, and action are required');
  }

  if (!['telegram', 'whatsapp'].includes(channel)) {
    throw new HttpError(400, 'invalid_channel', 'channel must be telegram or whatsapp');
  }

  if (!['channel_clicked', 'channel_dismissed'].includes(action)) {
    throw new HttpError(400, 'invalid_action', 'action must be channel_clicked or channel_dismissed');
  }

  const existing = (await c.query(
    `SELECT * FROM user_onboarding WHERE user_id = $1 AND channel = $2 FOR UPDATE`,
    [userId, channel]
  )).rows[0];

  if (!existing) {
    const inserted = (await c.query(
      `INSERT INTO user_onboarding (
         user_id, channel, status, channel_offered_at,
         channel_clicked_at, metadata, created_at, updated_at
       ) VALUES (
         $1, $2, $3, now(),
         CASE WHEN $3 = 'channel_clicked' THEN now() ELSE NULL END,
         $4, now(), now()
       ) RETURNING *`,
      [userId, channel, action, JSON.stringify(metadata)]
    )).rows[0];
    return { ok: true, record: inserted };
  }

  const newStatus = action === 'channel_clicked' ? 'channel_clicked' : existing.status;
  const clickedAt = action === 'channel_clicked' ? 'now()' : 'channel_clicked_at';

  const updated = (await c.query(
    `UPDATE user_onboarding
        SET status = $2,
            channel_clicked_at = COALESCE(channel_clicked_at, ${clickedAt}),
            metadata = metadata || $3::jsonb,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [existing.id, newStatus, JSON.stringify(metadata)]
  )).rows[0];

  return { ok: true, record: updated };
}

/**
 * Retrieve onboarding state for a user.
 */
export async function getOnboardingState(userId, c = db) {
  if (!userId) return { telegram: null, whatsapp: null };

  const { rows } = await c.query(
    `SELECT * FROM user_onboarding WHERE user_id = $1`,
    [userId]
  );

  const tg = rows.find((r) => r.channel === 'telegram') || null;
  const wa = rows.find((r) => r.channel === 'whatsapp') || null;

  return {
    telegram: tg ? {
      status: tg.status,
      welcomeSent: Boolean(tg.welcome_sent_at),
      welcomeSentAt: tg.welcome_sent_at,
      channelOfferedAt: tg.channel_offered_at,
      channelClickedAt: tg.channel_clicked_at,
      membershipVerified: tg.membership_verified,
      communityUrl: telegramCommunityUrl()
    } : {
      status: 'unregistered',
      welcomeSent: false,
      communityUrl: telegramCommunityUrl()
    },
    whatsapp: wa ? {
      status: wa.status,
      channelOffered: Boolean(wa.channel_offered_at),
      channelOfferedAt: wa.channel_offered_at,
      channelClicked: Boolean(wa.channel_clicked_at),
      channelClickedAt: wa.channel_clicked_at,
      channelUrl: whatsappChannelUrl()
    } : {
      status: 'unregistered',
      channelOffered: false,
      channelClicked: false,
      channelUrl: whatsappChannelUrl()
    }
  };
}

/**
 * Admin view of community onboarding audits and metrics.
 * Masks PII to protect user privacy from unauthorized eyes.
 */
export async function listOnboardingAudits({
  limit = 50,
  offset = 0,
  channel = null,
  c = db
} = {}) {
  const params = [];
  let where = 'TRUE';

  if (channel && ['telegram', 'whatsapp'].includes(channel)) {
    params.push(channel);
    where = `o.channel = $${params.length}`;
  }

  params.push(Math.min(Number(limit) || 50, 200));
  const limitIdx = params.length;

  params.push(Math.max(Number(offset) || 0, 0));
  const offsetIdx = params.length;

  const { rows } = await c.query(
    `SELECT o.id, o.user_id, o.channel, o.status,
            o.welcome_sent_at, o.channel_offered_at, o.channel_clicked_at,
            o.membership_verified, o.created_at,
            u.alias,
            o.telegram_user_id,
            o.whatsapp_phone
       FROM user_onboarding o
       JOIN users u ON u.id = o.user_id
      WHERE ${where}
      ORDER BY o.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  // Mask PII for privacy protection
  const sanitized = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userAlias: r.alias || 'Guest User',
    channel: r.channel,
    status: r.status,
    welcomeSentAt: r.welcome_sent_at,
    channelOfferedAt: r.channel_offered_at,
    channelClickedAt: r.channel_clicked_at,
    membershipVerified: r.membership_verified,
    createdAt: r.created_at,
    phoneMasked: r.whatsapp_phone ? maskPhone(r.whatsapp_phone) : null,
    telegramUserId: r.telegram_user_id ? String(r.telegram_user_id) : null
  }));

  // Aggregated stats
  const statsRes = await c.query(
    `SELECT
       COUNT(*)::int AS total_records,
       COUNT(*) FILTER (WHERE channel = 'telegram')::int AS telegram_total,
       COUNT(*) FILTER (WHERE channel = 'whatsapp')::int AS whatsapp_total,
       COUNT(*) FILTER (WHERE welcome_sent_at IS NOT NULL)::int AS welcome_sent_count,
       COUNT(*) FILTER (WHERE channel_offered_at IS NOT NULL)::int AS channel_offered_count,
       COUNT(*) FILTER (WHERE channel_clicked_at IS NOT NULL)::int AS channel_clicked_count,
       COUNT(*) FILTER (WHERE membership_verified = true)::int AS membership_verified_count
     FROM user_onboarding`
  );

  return {
    records: sanitized,
    metrics: statsRes.rows[0] || {
      total_records: 0,
      telegram_total: 0,
      whatsapp_total: 0,
      welcome_sent_count: 0,
      channel_offered_count: 0,
      channel_clicked_count: 0,
      membership_verified_count: 0
    }
  };
}
