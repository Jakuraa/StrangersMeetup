// lib/telegram/bot.js - Bot update routing: commands, deep links, payments, chat membership.
import { db } from '../db.js';
import { tg } from './api.js';
import { siteUrl, botUsername, env } from '../config.js';
import { upsertTelegramUser, redeemAccountLinkToken, updateNotificationPreferences, getNotificationPreferences } from '../services/users.js';
import { listPublicEvents, getPublicEventBySlug, listTiers } from '../services/events.js';
import { validatePreCheckout, handleSuccessfulPayment, createMembershipInvoice } from '../services/membership.js';
import { inviteForBooking, onChatMemberJoined } from '../services/invites.js';
import { deliverMany } from '../services/notifications.js';
import { claimOrder, startClaimPrompt, isClaimPromptOpen, CLAIM_LIMIT_PER_HOUR } from '../services/claims.js';
import { claimUpiBooking } from '../services/upi-payments.js';
import { rateLimit } from '../ratelimit.js';
import { eventPath } from '../views/components.js';
import { logger } from '../logger.js';

export const COMMANDS = [
  ['start', 'Open NIGHTLIFEZ'],
  ['events', 'Upcoming meetups and trips'],
  ['mybookings', 'Your bookings'],
  ['claim', 'Claim a ticket you bought on SuperProfile'],
  ['membership', 'Membership plans'],
  ['report', 'Report a safety concern'],
  ['quiet_hours', 'Notification quiet hours'],
  ['help', 'Help and support'],
  ['terms', 'Terms and refunds'],
  ['paysupport', 'Payment support']
];

const IST = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function reply(chatId, text, buttons) {
  return tg('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {})
  });
}

function appButton(text = 'Open NIGHTLIFEZ', path = '/') {
  return [{ text, web_app: { url: `${siteUrl()}${path}` } }];
}

function supportLine() {
  const email = env('SUPPORT_EMAIL');
  return email ? `You can also email ${esc(email)}.` : `You can also use ${siteUrl()}/contact.`;
}

async function cmdStart(msg, user, param) {
  const chat = msg.chat.id;
  if (param?.startsWith('link_')) {
    const token = param.slice(5);
    const r = await redeemAccountLinkToken(token, msg.from);
    if (!r.ok) {
      return reply(chat, 'This account linking link is invalid or has expired. Please generate a new link from your NIGHTLIFEZ profile.');
    }
    return reply(chat,
      'Your NIGHTLIFEZ web account is now securely linked to Telegram! ✅\n\n' +
      'Booking passes and exclusive event invites will be sent directly to this chat.',
      [appButton('Open NIGHTLIFEZ', '/me')]);
  }
  if (param?.startsWith('claim_upi_')) {
    const parts = param.slice(10).split('_');
    if (parts.length >= 2) {
      const orderId = parts[0];
      const guestToken = parts.slice(1).join('_');
      try {
        const claimed = await claimUpiBooking({ orderId, guestToken, user });
        const bId = claimed.bookingId;
        const b = bId ? await db.one('SELECT b.id, e.title FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id = $1', [bId]) : null;
        const inv = bId ? await inviteForBooking(bId).catch(() => null) : null;
        const buttons = [];
        if (inv) buttons.push([{ text: 'Join the private group', url: inv.link }]);
        if (bId) buttons.push([{ text: 'View booking pass', url: `${siteUrl()}/bookings/${bId}` }]);
        return reply(chat,
          `Booking claimed successfully! ✅\n<b>${esc(b?.title || 'Event')}</b>\n` +
          `Booking ref: <code>${String(bId || '').slice(0, 8)}</code>\n\n` +
          (inv ? 'Your one-time private group invite is below:' : 'Your booking is confirmed.'),
          buttons);
      } catch (err) {
        return reply(chat, `Could not claim booking: ${esc(err.message || 'invalid token or order')}`);
      }
    }
  }
  if (param?.startsWith('event_')) {
    const e = await getPublicEventBySlug(param.slice(6));
    if (e) {
      return reply(chat,
        `<b>${esc(e.title)}</b>\n${esc(IST.format(new Date(e.startAt)))} · ${esc(e.city)}\n${esc(e.priceLabel)} · ${esc(e.stateLabel)}${e.isDemo ? '\n<i>Sample listing — not a real event.</i>' : ''}`,
        [appButton('Open event', eventPath(e))]);
    }
  }
  if (param?.startsWith('booking_')) {
    const b = await db.one(
      `SELECT b.id, b.status, e.title FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id::text = $1 AND b.user_id = $2`,
      [param.slice(8), user.id]);
    if (b && ['confirmed', 'checked_in'].includes(b.status)) {
      try {
        const inv = await inviteForBooking(b.id);
        if (inv) return reply(chat, `Here is your one-time invite for <b>${esc(b.title)}</b>. It works once and expires in 24 hours.`, [[{ text: 'Join the private group', url: inv.link }]]);
      } catch (err) {
        logger.warn('invite on /start failed', { reason: String(err.message).slice(0, 100) });
        return reply(chat, 'Your booking is confirmed, but the group invite is not available yet. We will send it as soon as it is ready.');
      }
    }
  }
  if (param === 'claim') return cmdClaim(msg, user, '');
  if (param === 'alerts') {
    await db.query('UPDATE users SET alerts_opt_in = true WHERE id = $1', [user.id]);
    return reply(chat, 'Done — we will message you here when new events are announced. Send /stopalerts to opt out.');
  }

  // Operational recovery: check if user has confirmed bookings where invite was not yet delivered
  const pendingInvites = await db.query(
    `SELECT b.id, e.title, e.telegram_chat_id
       FROM bookings b
       JOIN events e ON e.id = b.event_id
      WHERE b.user_id = $1
        AND b.status IN ('confirmed', 'checked_in')
        AND e.telegram_chat_id IS NOT NULL
        AND COALESCE(e.end_at, e.start_at) > now() - interval '1 day'
        AND NOT EXISTS (
          SELECT 1 FROM invite_links i WHERE i.booking_id = b.id AND i.revoked_at IS NULL
        )
      LIMIT 1`,
    [user.id]
  );
  if (pendingInvites.rows.length > 0) {
    const pb = pendingInvites.rows[0];
    try {
      const inv = await inviteForBooking(pb.id);
      if (inv) {
        return reply(chat,
          `Welcome to <b>NIGHTLIFEZ</b>!\n\nWe found a confirmed booking for <b>${esc(pb.title)}</b>. Here is your private group invite (expires in 24 hours):`,
          [[{ text: 'Join the private group', url: inv.link }], appButton('Open NIGHTLIFEZ')]);
      }
    } catch (err) {
      logger.warn('recovery invite failed on /start', { reason: err.message });
    }
  }

  return reply(chat,
    'Welcome to <b>NIGHTLIFEZ</b> — curated weekend parties, nightlife, social mixers, dinner clubs and trips for adults 21+ across South India.\n\n' +
    'Browse and book below. Your booking confirmations and private group invites will arrive in this chat.',
    [appButton(), [{ text: 'Upcoming events', callback_data: 'events' }]]);
}

const CLAIM_PROMPT = 'Send your <b>SuperProfile order ID</b> to claim your ticket. If you like, add the email you paid with after it, e.g. <code>ABC12345 you@example.com</code>.\n\nYou will get your booking confirmation and a one-time group invite here.';

/** /claim [orderId [email]] — also the target of t.me/<bot>?start=claim. */
async function cmdClaim(msg, user, arg) {
  const [orderId, email] = arg.trim().split(/\s+/);
  if (!orderId) {
    await startClaimPrompt(user.id);
    return reply(msg.chat.id, CLAIM_PROMPT);
  }
  return runClaim(msg.chat.id, user, orderId, email);
}

async function runClaim(chat, user, orderId, email) {
  try {
    const r = await claimOrder(user, orderId, email);
    await reply(chat, `Order claimed ✅ <b>${esc(r.eventTitle)}</b>. Your confirmation and group invite follow now.`);
    await deliverMany(r.notificationIds);
  } catch (err) {
    if (err.status === 429) return reply(chat, `That was more than ${CLAIM_LIMIT_PER_HOUR} attempts in an hour. Please try again later, or ${supportLine()}`);
    if (err.status === 403 || err.status === 404 || err.status === 409) return reply(chat, esc(err.message));
    throw err;
  }
}

async function cmdEvents(chat) {
  const events = await listPublicEvents({ limit: 8 });
  if (!events.length) return reply(chat, 'No upcoming events are listed right now. Tap below to be told when new ones are announced.', [[{ text: 'Notify me', url: `https://t.me/${botUsername()}?start=alerts` }]]);
  const lines = events.map((e) => `• <b>${esc(e.title)}</b>${e.isDemo ? ' (sample)' : ''} — ${esc(IST.format(new Date(e.startAt)))}, ${esc(e.city)} · ${esc(e.priceLabel)}`);
  return reply(chat, `<b>Upcoming</b>\n${lines.join('\n')}`, [appButton('Browse & book')]);
}

async function cmdMyBookings(chat, user) {
  const { rows } = await db.query(
    `SELECT b.id, b.status, e.title, e.start_at FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.user_id = $1 AND b.status IN ('confirmed', 'checked_in', 'pending_payment')
        AND COALESCE(e.end_at, e.start_at) > now() - interval '1 day'
      ORDER BY e.start_at LIMIT 10`, [user.id]);
  if (!rows.length) return reply(chat, 'You have no upcoming bookings.', [appButton('Find an event')]);
  const label = { confirmed: 'Confirmed', checked_in: 'Checked in', pending_payment: 'Awaiting payment' };
  return reply(chat, rows.map((r) => `• <b>${esc(r.title)}</b> — ${esc(IST.format(r.start_at))} · ${label[r.status]}`).join('\n'),
    rows.filter((r) => r.status !== 'pending_payment').slice(0, 3).map((r) => [{ text: `Invite: ${r.title}`.slice(0, 40), callback_data: `inv:${r.id}` }]));
}

async function cmdMembership(chat, user) {
  const tiers = await listTiers();
  const { rows } = await db.query(
    `SELECT t.name, en.expires_at FROM entitlements en JOIN membership_tiers t ON t.id = en.tier_id
      WHERE en.user_id = $1 AND en.status IN ('active', 'grace', 'cancelled') AND en.expires_at > now()`, [user.id]);
  const mine = rows.length ? `\n\nYour membership: ${rows.map((r) => `${esc(r.name)} until ${esc(IST.format(r.expires_at))}`).join(', ')}` : '';
  // Inside Telegram only Stars tiers are offered: digital access sold in Telegram must use Stars,
  // so tiers sold through SuperProfile's web checkout are never listed or linked here.
  const starTiers = tiers.filter((t) => t.provider === 'telegram_stars');
  const buttons = starTiers.filter((t) => t.purchasable).map((t) => [{ text: `Join ${t.name} — ${t.starsAmount} ⭐`, callback_data: `join:${t.code}` }]);
  if (!starTiers.length) return reply(chat, `<b>Membership</b>\nThere are no memberships available in Telegram right now.${mine}`);
  return reply(chat,
    `<b>Membership</b>\n${starTiers.map((t) => `• <b>${esc(t.name)}</b> — ${esc(t.priceLabel)}`).join('\n')}${mine}\n\nPaid in Telegram Stars, renews every 30 days, cancel any time in Telegram settings.`,
    buttons.length ? buttons : null);
}

async function cmdReport(msg, user, text) {
  const chat = msg.chat.id;
  const body = text.trim();
  if (!body) {
    return reply(chat,
      '⚠️ <b>If you are in immediate danger, call 112 or local emergency services.</b>\n' +
      'Women’s Helpline: <b>1091 / 181</b>\n\n' +
      'To report a safety issue to NIGHTLIFEZ moderators, reply with <b>/report</b> followed by what happened, when, and at which event.\n\n' +
      'Example:\n<code>/report At the Indiranagar mixer on Friday, someone made unwelcome advances after being asked to stop.</code>');
  }

  if (body.length < 10) {
    return reply(chat, 'Please provide more details in your report (at least 10 characters) so our moderation team can investigate.\n\nEmergency helpline: 112.');
  }

  try {
    await rateLimit(`tg_report:${user.id}`, 5, 3600);
  } catch (err) {
    if (err.status === 429) {
      return reply(chat, 'You have submitted several reports recently. For urgent assistance, please call 112 or contact support.');
    }
    throw err;
  }

  await db.query(
    `INSERT INTO reports (user_id, category, body, status) VALUES ($1, 'safety_concern', $2, 'new')`,
    [user.id, body.slice(0, 3000)]
  );
  return reply(chat,
    'Thank you. Your report has been recorded and a NIGHTLIFEZ moderator will review it confidentially.\n\n' +
    'If you are in immediate danger or need urgent on-ground help, please call <b>112</b>.');
}

async function cmdQuietHours(msg, user, arg) {
  const chat = msg.chat.id;
  const clean = arg.trim().toLowerCase();
  if (!clean) {
    const prefs = await getNotificationPreferences(user.id);
    const status = prefs?.quiet_hours_enabled ? 'ON' : 'OFF';
    const start = prefs?.quiet_hours_start ? String(prefs.quiet_hours_start).slice(0, 5) : '23:00';
    const end = prefs?.quiet_hours_end ? String(prefs.quiet_hours_end).slice(0, 5) : '08:00';
    return reply(chat,
      `<b>Quiet Hours Settings</b>\n\n` +
      `Status: <b>${status}</b>\n` +
      `Window: <b>${esc(start)} to ${esc(end)} IST</b>\n\n` +
      `During quiet hours, non-urgent notifications (announcements and reminders) are held until morning. Urgent booking and refund confirmations are always delivered immediately.\n\n` +
      `To change: send <code>/quiet_hours on</code>, <code>/quiet_hours off</code>, or <code>/quiet_hours 23:00 08:00</code>.`);
  }

  if (clean === 'on' || clean === 'enable') {
    await updateNotificationPreferences(user.id, { quietHoursEnabled: true });
    return reply(chat, 'Quiet hours enabled ✅ Non-urgent alerts will be muted from 23:00 to 08:00 IST.');
  }
  if (clean === 'off' || clean === 'disable') {
    await updateNotificationPreferences(user.id, { quietHoursEnabled: false });
    return reply(chat, 'Quiet hours disabled. You will receive notifications as soon as they are generated.');
  }

  const times = clean.split(/\s+/);
  if (times.length === 2 && /^\d{1,2}:\d{2}$/.test(times[0]) && /^\d{1,2}:\d{2}$/.test(times[1])) {
    const start = times[0].padStart(5, '0');
    const end = times[1].padStart(5, '0');
    await updateNotificationPreferences(user.id, { quietHoursEnabled: true, quietHoursStart: start, quietHoursEnd: end });
    return reply(chat, `Quiet hours updated ✅ Muting non-urgent alerts between <b>${esc(start)}</b> and <b>${esc(end)} IST</b>.`);
  }

  return reply(chat, 'Usage: <code>/quiet_hours on</code>, <code>/quiet_hours off</code>, or <code>/quiet_hours 23:00 08:00</code>.');
}

async function onMessage(msg) {
  if (msg.chat?.type !== 'private' || !msg.from || msg.from.is_bot) return;
  const user = await upsertTelegramUser(msg.from, { botStarted: true }).catch((err) => {
    if (err.status === 403) return null;
    throw err;
  });
  if (!user) return reply(msg.chat.id, 'This account is restricted. Contact support if you think this is a mistake.');

  if (msg.successful_payment) {
    const r = await handleSuccessfulPayment(msg.successful_payment, msg.from);
    await deliverMany(r.notificationIds);
    return;
  }

  const text = msg.text || '';
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) {
    // After "claim" the bot waits a few minutes for an order ID.
    if (text.trim() && await isClaimPromptOpen(user.id)) return cmdClaim(msg, user, text);
    return reply(msg.chat.id, 'Send /events to see what is coming up, or /help for support.');
  }
  const [, cmd, arg = ''] = m;
  switch (cmd.toLowerCase()) {
    case 'start': return cmdStart(msg, user, arg.trim() || null);
    case 'events': return cmdEvents(msg.chat.id);
    case 'mybookings': return cmdMyBookings(msg.chat.id, user);
    case 'claim': return cmdClaim(msg, user, arg);
    case 'membership': return cmdMembership(msg.chat.id, user);
    case 'report': return cmdReport(msg, user, arg);
    case 'quiet_hours': return cmdQuietHours(msg, user, arg);
    case 'stopalerts':
      await db.query('UPDATE users SET alerts_opt_in = false WHERE id = $1', [user.id]);
      return reply(msg.chat.id, 'You will no longer receive new-event alerts.');
    case 'terms':
      return reply(msg.chat.id, `Terms: ${siteUrl()}/terms\nBilling & refunds: ${siteUrl()}/refunds\nCommunity guidelines: ${siteUrl()}/community-guidelines`);
    case 'paysupport':
      return reply(msg.chat.id, `For a payment problem, reply here with your booking reference (from your confirmation message) or the date of the Stars payment, and what went wrong. ${supportLine()}`);
    case 'help':
    case 'support':
    default:
      return reply(msg.chat.id,
        '<b>NIGHTLIFEZ Support & Community Care</b>\n\n' +
        '/events — upcoming curated nightlife, mixers & trips\n' +
        '/mybookings — your tickets and private group invites\n' +
        '/claim — claim a ticket you bought on SuperProfile or UPI\n' +
        '/membership — plans and perks\n' +
        '/quiet_hours — mute non-urgent night alerts\n' +
        '/report — report a safety concern (reviewed by moderators)\n' +
        '/paysupport — payment queries\n' +
        '/terms — terms, billing and refunds\n\n' +
        '🚨 <b>Emergency Services: 112</b> | Women’s Helpline: <b>1091 / 181</b>\n\n' +
        `To cancel or request a refund, reply with your booking ref. ${supportLine()}`);
  }
}

async function onCallback(cq) {
  const user = await upsertTelegramUser(cq.from, { botStarted: true });
  const chat = cq.message?.chat?.id ?? cq.from.id;
  await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  const data = String(cq.data || '');
  if (data === 'events') return cmdEvents(chat);
  if (data.startsWith('inv:')) return cmdStart({ chat: { id: chat } }, user, `booking_${data.slice(4)}`);
  if (data.startsWith('join:')) {
    try {
      const { invoiceLink, tier } = await createMembershipInvoice(user, data.slice(5));
      return reply(chat, `Tap below to join <b>${esc(tier.name)}</b> for ${tier.starsAmount} Stars / 30 days.`, [[{ text: `Pay ${tier.starsAmount} ⭐`, url: invoiceLink }]]);
    } catch (err) {
      if (err.status === 403) return reply(chat, 'Please sign in on our website once and confirm you are 21+, then try again.', [appButton('Open NIGHTLIFEZ', '/signin')]);
      return reply(chat, esc(err.status ? err.message : 'Membership is not available right now.'));
    }
  }
  return undefined;
}

/** Route one update. Throws on failures that Telegram should retry. */
export async function handleUpdate(update) {
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query;
    const v = await validatePreCheckout(pcq).catch((err) => {
      logger.error('pre_checkout validation error', err);
      return { ok: false, error: 'Payments are temporarily unavailable.' };
    });
    await tg('answerPreCheckoutQuery', v.ok ? { pre_checkout_query_id: pcq.id, ok: true } : { pre_checkout_query_id: pcq.id, ok: false, error_message: v.error });
    return 'pre_checkout_query';
  }
  if (update.message) {
    await onMessage(update.message);
    return 'message';
  }
  if (update.callback_query) {
    await onCallback(update.callback_query);
    return 'callback_query';
  }
  if (update.chat_member) {
    await onChatMemberJoined(update.chat_member);
    return 'chat_member';
  }
  return 'ignored';
}
