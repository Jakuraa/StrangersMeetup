// lib/services/invites.js - Single-use, 24h Telegram invite links for bookings and memberships.
import { db } from '../db.js';
import { tg } from '../telegram/api.js';
import { chatIdFromEnv, TIER_CHAT_ENV } from '../config.js';
import { audit } from '../audit.js';

export const INVITE_TTL_S = 24 * 3600;

export class ChatNotConfiguredError extends Error {
  constructor(what) {
    super(`NOT CONFIGURED: chat id for ${what}`);
    this.code = 'CHAT_NOT_CONFIGURED';
  }
}

export function eventChatId(event) {
  return event.telegram_chat_id ?? chatIdFromEnv('TG_CHAT_ID_EVENTS');
}

export function tierChatId(tier) {
  return tier.telegram_chat_id ?? (TIER_CHAT_ENV[tier.code] ? chatIdFromEnv(TIER_CHAT_ENV[tier.code]) : null);
}

/** Return a still-usable invite (unused, unrevoked, >1h left) for the owner, if any. */
export async function activeInvite({ bookingId, entitlementId }) {
  return db.one(
    `SELECT link, expires_at FROM invite_links
      WHERE ${bookingId ? 'booking_id' : 'entitlement_id'} = $1
        AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() + interval '1 hour'
      ORDER BY created_at DESC LIMIT 1`,
    [bookingId || entitlementId]
  );
}

async function create({ chatId, userId, bookingId = null, entitlementId = null, name }) {
  const expireDate = Math.floor(Date.now() / 1000) + INVITE_TTL_S;
  const result = await tg('createChatInviteLink', { chat_id: chatId, name: name.slice(0, 32), member_limit: 1, expire_date: expireDate });
  const row = await db.one(
    `INSERT INTO invite_links (booking_id, entitlement_id, user_id, chat_id, link, expires_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6)) RETURNING link, expires_at`,
    [bookingId, entitlementId, userId, chatId, result.invite_link, expireDate]
  );
  return row;
}

/** Invite for a confirmed booking → event chat. Reuses a still-valid invite. */
export async function inviteForBooking(bookingId) {
  const b = await db.one(
    `SELECT b.id, b.user_id, b.status, e.telegram_chat_id, e.slug, e.organiser_user_id FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id = $1`, [bookingId]);
  if (!b || !['confirmed', 'checked_in'].includes(b.status)) return null;
  // Independent organisers' guests are never added to the platform's shared events chat.
  if (b.organiser_user_id && b.telegram_chat_id === null) return null;
  const existing = await activeInvite({ bookingId });
  if (existing) return existing;
  const chatId = eventChatId(b);
  if (chatId === null) throw new ChatNotConfiguredError('events (TG_CHAT_ID_EVENTS)');
  return create({ chatId, userId: b.user_id, bookingId, name: `bk ${b.slug}` });
}

/** Invite for an active membership → that tier's chat. */
export async function inviteForEntitlement(entitlementId) {
  const e = await db.one(
    `SELECT en.id, en.user_id, en.status, en.expires_at, t.code, t.telegram_chat_id
       FROM entitlements en JOIN membership_tiers t ON t.id = en.tier_id WHERE en.id = $1`, [entitlementId]);
  if (!e || !['active', 'grace', 'cancelled'].includes(e.status) || new Date(e.expires_at) < new Date()) return null;
  const existing = await activeInvite({ entitlementId });
  if (existing) return existing;
  const chatId = tierChatId(e);
  if (chatId === null) throw new ChatNotConfiguredError(`tier ${e.code}`);
  return create({ chatId, userId: e.user_id, entitlementId, name: `member ${e.code}` });
}

/** Remove a user from a chat without a permanent ban (ban, then unban). */
export async function removeFromChat(chatId, telegramUserId) {
  await tg('banChatMember', { chat_id: chatId, user_id: telegramUserId, revoke_messages: false });
  await tg('unbanChatMember', { chat_id: chatId, user_id: telegramUserId, only_if_banned: true });
}

/**
 * Handle a chat_member update: mark our invite as used, and remove anyone who joined with an
 * invite issued to somebody else (leaked link).
 */
export async function onChatMemberJoined(update) {
  const link = update.invite_link?.invite_link;
  const joined = update.new_chat_member;
  if (!link || !joined || !['member', 'restricted'].includes(joined.status)) return { handled: false };
  const inv = await db.one(
    `SELECT i.id, i.chat_id, u.telegram_user_id FROM invite_links i JOIN users u ON u.id = i.user_id WHERE i.link = $1`, [link]);
  if (!inv) return { handled: false };
  const joinerId = joined.user?.id;
  if (joinerId === inv.telegram_user_id) {
    await db.query('UPDATE invite_links SET used_at = COALESCE(used_at, now()) WHERE id = $1', [inv.id]);
    return { handled: true, used: true };
  }
  await db.query('UPDATE invite_links SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [inv.id]);
  try {
    await removeFromChat(inv.chat_id, joinerId);
  } finally {
    await audit('system', 'invite.misuse_removed', inv.id, { chatId: inv.chat_id });
  }
  return { handled: true, removed: true };
}
