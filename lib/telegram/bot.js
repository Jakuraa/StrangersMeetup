// lib/telegram/bot.js - Bot update routing: commands, deep links, payments, chat membership.
import { db } from '../db.js';
import { tg } from './api.js';
import { siteUrl, botUsername, env } from '../config.js';
import { upsertTelegramUser } from '../services/users.js';
import { listPublicEvents, getPublicEventBySlug, listTiers } from '../services/events.js';
import { validatePreCheckout, handleSuccessfulPayment, createMembershipInvoice } from '../services/membership.js';
import { inviteForBooking, onChatMemberJoined } from '../services/invites.js';
import { deliverMany } from '../services/notifications.js';
import { eventPath } from '../views/components.js';
import { logger } from '../logger.js';

export const COMMANDS = [
  ['start', 'Open StrangersMeetup'],
  ['events', 'Upcoming meetups and trips'],
  ['mybookings', 'Your bookings'],
  ['membership', 'Membership plans'],
  ['report', 'Report a safety concern'],
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

function appButton(text = 'Open StrangersMeetup', path = '/') {
  return [{ text, web_app: { url: `${siteUrl()}${path}` } }];
}

function supportLine() {
  const email = env('SUPPORT_EMAIL');
  return email ? `You can also email ${esc(email)}.` : `You can also use ${siteUrl()}/contact.`;
}

async function cmdStart(msg, user, param) {
  const chat = msg.chat.id;
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
  if (param === 'alerts') {
    await db.query('UPDATE users SET alerts_opt_in = true WHERE id = $1', [user.id]);
    return reply(chat, 'Done — we will message you here when new events are announced. Send /stopalerts to opt out.');
  }
  return reply(chat,
    'Welcome to <b>StrangersMeetup</b> — small hosted meetups, dinners, mixers and trips for adults 21+ across South India.\n\n' +
    'Browse and book below. Your booking confirmations and private group invites will arrive in this chat.',
    [appButton(), [{ text: 'Upcoming events', callback_data: 'events' }]]);
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
  const body = text.trim();
  if (!body) {
    return reply(msg.chat.id, 'Please send <b>/report</b> followed by what happened, when, and at which event. Example:\n<code>/report At the Chennai dinner on 7 Nov, someone kept messaging me after I said no.</code>\n\nIf you are in immediate danger, call 112.');
  }
  await db.query('INSERT INTO reports (user_id, body) VALUES ($1, $2)', [user.id, body.slice(0, 4000)]);
  return reply(msg.chat.id, 'Thank you. Your report has been recorded and a moderator will review it. We keep reports confidential.');
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
  if (!m) return reply(msg.chat.id, 'Send /events to see what is coming up, or /help for support.');
  const [, cmd, arg = ''] = m;
  switch (cmd.toLowerCase()) {
    case 'start': return cmdStart(msg, user, arg.trim() || null);
    case 'events': return cmdEvents(msg.chat.id);
    case 'mybookings': return cmdMyBookings(msg.chat.id, user);
    case 'membership': return cmdMembership(msg.chat.id, user);
    case 'report': return cmdReport(msg, user, arg);
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
        '<b>Help</b>\n/events — upcoming events\n/mybookings — your bookings and invites\n/membership — plans\n/report — report a safety concern\n/paysupport — payment problems\n/terms — terms and refunds\n\n' +
        `To cancel or get a refund, reply here with your booking reference. ${supportLine()}`);
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
      if (err.status === 403) return reply(chat, 'Please sign in on our website once and confirm you are 21+, then try again.', [appButton('Open StrangersMeetup', '/signin')]);
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
