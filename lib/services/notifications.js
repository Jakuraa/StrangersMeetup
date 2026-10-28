// lib/services/notifications.js - Outbox for bot DMs + invites. Rows are enqueued inside the
// business transaction; delivery happens after commit and is retried by cron with backoff.
import { db } from '../db.js';
import { tg, isUnreachableUser } from '../telegram/api.js';
import { inviteForBooking, inviteForEntitlement } from './invites.js';
import { siteUrl, botUsername, chatIdFromEnv, livePayments } from '../config.js';
import { logger } from '../logger.js';
import { formatPaise } from './events.js';

export const MAX_ATTEMPTS = 6;

export async function enqueue(client, { kind, userId = null, bookingId = null, entitlementId = null, eventId = null, dedupeKey }) {
  const { rows } = await client.query(
    `INSERT INTO notifications (kind, user_id, booking_id, entitlement_id, event_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [kind, userId, bookingId, entitlementId, eventId, dedupeKey]
  );
  return rows[0]?.id || null;
}

const IST = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const fmt = (d) => IST.format(new Date(d));

function escHtml(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function send(chatId, text, buttons) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {})
  });
}

async function adminChatIds() {
  const { rows } = await db.query(
    `SELECT a.telegram_user_id FROM admin_users a
      WHERE a.active AND a.telegram_user_id IS NOT NULL AND a.role IN ('super_admin', 'finance')`);
  const ids = rows.map((r) => r.telegram_user_id);
  const boot = chatIdFromEnv('ADMIN_BOOTSTRAP_TELEGRAM_ID');
  if (boot && !ids.includes(boot)) ids.push(boot);
  return ids;
}

// Each handler returns nothing on success and throws on failure.
const HANDLERS = {
  async booking_confirmed(n) {
    const b = await db.one(
      `SELECT b.id, b.amount_paise, b.payment_mode, e.title, e.start_at, e.city, e.area_public, e.venue_private, e.venue_privacy, e.organiser_user_id,
              e.telegram_chat_id, u.telegram_user_id
         FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [n.booking_id]);
    if (!b) return;
    let invite = null;
    let inviteErr = null;
    try {
      invite = await inviteForBooking(b.id);
    } catch (err) {
      inviteErr = err;
    }
    const venue = b.venue_privacy === 'public' && b.venue_private ? b.venue_private : null;
    const hostEvent = Boolean(b.organiser_user_id) && b.telegram_chat_id === null;
    const lines = [
      `<b>You're booked!</b> ${escHtml(b.title)}`,
      `${escHtml(fmt(b.start_at))} · ${escHtml(b.area_public ? `${b.area_public}, ` : '')}${escHtml(b.city)}`,
      venue ? `Venue: ${escHtml(venue)}` : hostEvent ? 'The exact venue is on your booking page.' : 'The exact venue is shared inside the private group.',
      b.payment_mode === 'free' ? 'Free ticket — no payment needed.' : b.amount_paise ? `Paid: ${formatPaise(b.amount_paise)}${livePayments() ? '' : ' (test mode)'}` : null,
      `Booking ref: <code>${b.id.slice(0, 8)}</code>`,
      hostEvent ? null : invite ? 'Your one-time group invite is below. It works once and expires in 24 hours.' : 'Your private group invite will follow shortly.'
    ].filter(Boolean);
    const buttons = [];
    if (invite) buttons.push([{ text: 'Join the private group', url: invite.link }]);
    buttons.push([{ text: 'View booking', url: `${siteUrl()}/bookings/${b.id}` }]);
    await send(b.telegram_user_id, lines.join('\n'), buttons);
    if (inviteErr) throw inviteErr; // confirmation delivered; retry later for the invite
  },

  async membership_activated(n) {
    const e = await db.one(
      `SELECT en.id, en.expires_at, t.name, u.telegram_user_id FROM entitlements en
         JOIN membership_tiers t ON t.id = en.tier_id JOIN users u ON u.id = en.user_id WHERE en.id = $1`, [n.entitlement_id]);
    if (!e) return;
    let invite = null;
    let inviteErr = null;
    try {
      invite = await inviteForEntitlement(e.id);
    } catch (err) {
      inviteErr = err;
    }
    await send(e.telegram_user_id,
      `<b>Welcome to ${escHtml(e.name)}.</b>\nYour membership is active until ${escHtml(fmt(e.expires_at))} and renews in Telegram unless you cancel.\n` +
      (invite ? 'Your one-time invite to the members’ group is below (expires in 24 hours).' : 'Your members’ group invite will follow shortly.'),
      invite ? [[{ text: `Join ${e.name}`, url: invite.link }]] : null);
    if (inviteErr) throw inviteErr;
  },

  async membership_renewed(n) {
    const e = await db.one(
      `SELECT en.expires_at, t.name, u.telegram_user_id FROM entitlements en
         JOIN membership_tiers t ON t.id = en.tier_id JOIN users u ON u.id = en.user_id WHERE en.id = $1`, [n.entitlement_id]);
    if (e) await send(e.telegram_user_id, `Your ${escHtml(e.name)} membership renewed. Active until ${escHtml(fmt(e.expires_at))}.`);
  },

  async expiry_reminder(n) {
    const e = await db.one(
      `SELECT en.expires_at, t.name, u.telegram_user_id FROM entitlements en
         JOIN membership_tiers t ON t.id = en.tier_id JOIN users u ON u.id = en.user_id WHERE en.id = $1`, [n.entitlement_id]);
    if (e) {
      await send(e.telegram_user_id,
        `Heads up: your ${escHtml(e.name)} membership period ends ${escHtml(fmt(e.expires_at))}. ` +
        'If renewal is on in Telegram, nothing to do. If you cancelled, access to the members’ group ends then.');
    }
  },

  async membership_expired(n) {
    const e = await db.one(
      `SELECT t.name, u.telegram_user_id FROM entitlements en
         JOIN membership_tiers t ON t.id = en.tier_id JOIN users u ON u.id = en.user_id WHERE en.id = $1`, [n.entitlement_id]);
    if (e) await send(e.telegram_user_id, `Your ${escHtml(e.name)} membership has ended and group access was removed. You can rejoin any time with /membership.`);
  },

  async booking_refunded(n) {
    const b = await db.one(
      `SELECT e.title, u.telegram_user_id FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [n.booking_id]);
    if (b) await send(b.telegram_user_id, `Your booking for ${escHtml(b.title)} was refunded to your original payment method. Banks usually take 5–7 working days.`);
  },

  async event_cancelled(n) {
    const b = await db.one(
      `SELECT e.title, e.start_at, u.telegram_user_id FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [n.booking_id]);
    if (b) await send(b.telegram_user_id, `We're sorry — <b>${escHtml(b.title)}</b> on ${escHtml(fmt(b.start_at))} has been cancelled. You will receive a full refund to your original payment method.`);
  },

  async late_payment_refund_needed(n) {
    // Payment captured after the hold expired and the event is full: alert finance admins.
    const b = await db.one(
      `SELECT b.id, e.title FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.id = $1`, [n.booking_id]);
    const ids = await adminChatIds();
    if (!ids.length) throw new Error('NOT CONFIGURED: no admin Telegram ids');
    for (const id of ids) {
      await send(id, `⚠️ Refund needed: payment received after hold expired and ${escHtml(b?.title || 'event')} is full. Booking ${escHtml(n.booking_id)}. Open /admin → Bookings.`);
    }
    const u = await db.one('SELECT telegram_user_id FROM users WHERE id = $1', [n.user_id]);
    if (u) await send(u.telegram_user_id, `Sorry — ${escHtml(b?.title || 'the event')} filled up before your payment arrived. You will receive a full refund.`);
  },

  async booking_request(n) {
    // To the organiser: a guest asked to join. Names only; answers stay on the manage page.
    const r = await db.one(
      `SELECT e.id, e.title, h.telegram_user_id FROM bookings b JOIN events e ON e.id = b.event_id JOIN users h ON h.id = e.organiser_user_id WHERE b.id = $1`, [n.booking_id]);
    if (r) await send(r.telegram_user_id, `New request to join <b>${escHtml(r.title)}</b>. Approve or decline it on your event page.`,
      [[{ text: 'Review requests', url: `${siteUrl()}/organiser/events/${r.id}` }]]);
  },

  async booking_declined(n) {
    const b = await db.one(
      `SELECT e.title, u.telegram_user_id FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [n.booking_id]);
    if (b) await send(b.telegram_user_id, `The host couldn't accept your request for <b>${escHtml(b.title)}</b> this time. You have not been charged.`);
  },

  async booking_approved_pay(n) {
    const b = await db.one(
      `SELECT b.id, b.hold_expires_at, e.title, u.telegram_user_id FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id
        WHERE b.id = $1 AND b.status = 'pending_payment'`, [n.booking_id]);
    if (b) await send(b.telegram_user_id, `Good news — the host approved your request for <b>${escHtml(b.title)}</b>. Complete payment by ${escHtml(fmt(b.hold_expires_at))} to confirm your spot.`,
      [[{ text: 'Complete booking', url: `${siteUrl()}/bookings/${b.id}` }]]);
  },

  async event_announcement(n) {
    const e = await db.one(`SELECT slug, title, city, start_at, category FROM events WHERE id = $1 AND status = 'published'`, [n.event_id]);
    const u = await db.one('SELECT telegram_user_id, alerts_opt_in FROM users WHERE id = $1', [n.user_id]);
    if (!e || !u?.alerts_opt_in) return;
    const path = ['weekend_trip', 'resort_getaway'].includes(e.category) ? 'trips' : 'events';
    await send(u.telegram_user_id, `New: <b>${escHtml(e.title)}</b>\n${escHtml(fmt(e.start_at))} · ${escHtml(e.city)}`,
      [[{ text: 'See details', url: `${siteUrl()}/${path}/${e.slug}` }]]);
  }
};

/** Deliver one notification row. Never throws; records outcome. */
export async function deliver(id) {
  const n = await db.one(
    `UPDATE notifications SET attempts = attempts + 1
      WHERE id = $1 AND status <> 'sent' AND attempts < $2 RETURNING *`, [id, MAX_ATTEMPTS]);
  if (!n) return 'skipped';
  try {
    const handler = HANDLERS[n.kind];
    if (!handler) throw new Error(`unknown kind ${n.kind}`);
    await handler(n);
    await db.query(`UPDATE notifications SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [id]);
    return 'sent';
  } catch (err) {
    const reason = isUnreachableUser(err)
      ? `user_has_not_started_bot: open t.me/${botUsername() || '<bot>'} and press Start`
      : String(err.message || err).slice(0, 300);
    // Exponential backoff: 2, 4, 8, 16, 32 minutes.
    await db.query(
      `UPDATE notifications SET status = 'failed', last_error = $2,
              next_attempt_at = now() + make_interval(mins => power(2, LEAST(attempts, 6))::int)
        WHERE id = $1`, [id, reason]);
    logger.warn('notification failed', { kind: n.kind, attempts: n.attempts, reason: reason.slice(0, 120) });
    return 'failed';
  }
}

export async function deliverMany(ids) {
  const out = [];
  for (const id of ids.filter(Boolean)) out.push(await deliver(id));
  return out;
}

/** Cron: retry due pending/failed notifications. */
export async function deliverDue(limit = 50) {
  const { rows } = await db.query(
    `SELECT id FROM notifications WHERE status <> 'sent' AND attempts < $1 AND next_attempt_at <= now()
      ORDER BY created_at LIMIT $2`, [MAX_ATTEMPTS, limit]);
  const results = await deliverMany(rows.map((r) => r.id));
  return { attempted: results.length, sent: results.filter((r) => r === 'sent').length };
}
