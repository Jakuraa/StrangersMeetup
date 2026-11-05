// lib/services/notifications.js - Outbox for bot DMs + invites. Rows are enqueued inside the
// business transaction; delivery happens after commit and is retried by cron with backoff.
import { db } from '../db.js';
import { tg, isUnreachableUser } from '../telegram/api.js';
import { inviteForBooking, inviteForEntitlement } from './invites.js';
import { siteUrl, botUsername, chatIdFromEnv, livePayments } from '../config.js';
import { logger } from '../logger.js';
import { formatPaise } from './events.js';

export const MAX_ATTEMPTS = 6;
export const NON_URGENT_KINDS = new Set(['event_announcement', 'event_reminder', 'membership_renewed', 'expiry_reminder']);

/**
 * Checks whether quiet hours are currently active for a user in Asia/Kolkata timezone.
 */
export function isQuietHours(user, date = new Date()) {
  if (!user?.quiet_hours_enabled) return false;
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const currentMinutes = hour * 60 + minute;

  const [sH, sM] = String(user.quiet_hours_start || '23:00').split(':').map((v) => parseInt(v, 10));
  const [eH, eM] = String(user.quiet_hours_end || '08:00').split(':').map((v) => parseInt(v, 10));
  const startMinutes = (sH || 0) * 60 + (sM || 0);
  const endMinutes = (eH || 0) * 60 + (eM || 0);

  if (startMinutes > endMinutes) {
    // Window crosses midnight (e.g. 23:00 to 08:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

/**
 * Calculates the exact Date when quiet hours end for the user in Asia/Kolkata timezone.
 */
export function quietHoursNextAttempt(user, date = new Date()) {
  const [eH, eM] = String(user?.quiet_hours_end || '08:00').split(':').map((v) => parseInt(v, 10));
  const now = date.getTime();
  const istDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
  const [y, m, d] = istDateStr.split('-').map(Number);

  // UTC = IST - 5h 30m
  const todayEndUtcMs = Date.UTC(y, m - 1, d, eH - 5, eM - 30);
  if (todayEndUtcMs > now) {
    return new Date(todayEndUtcMs);
  }
  const tomorrowEndUtcMs = Date.UTC(y, m - 1, d + 1, eH - 5, eM - 30);
  return new Date(tomorrowEndUtcMs);
}

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
    const hasGroup = Boolean(b.telegram_chat_id);
    const lines = [
      `<b>You're booked!</b> ${escHtml(b.title)}`,
      `${escHtml(fmt(b.start_at))} · ${escHtml(b.area_public ? `${b.area_public}, ` : '')}${escHtml(b.city)}`,
      venue ? `Venue: ${escHtml(venue)}` : hasGroup ? 'The exact venue is shared inside the private group.' : 'The exact venue is on your booking page.',
      b.payment_mode === 'free' ? 'Free ticket — no payment needed.' : b.amount_paise ? `Paid: ${formatPaise(b.amount_paise)}${b.payment_mode === 'external' ? ' on SuperProfile' : livePayments() ? '' : ' (test mode)'}` : null,
      `Booking ref: <code>${b.id.slice(0, 8)}</code>`,
      hasGroup ? (invite ? 'Your one-time group invite is below. It works once and expires in 24 hours.' : 'Your private group invite will follow shortly.') : null
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

  async order_alert(n) {
    // dedupe_key = oa:<external_orders.id>:<reason>. Order details stay in the admin Orders tab.
    const [, orderRow, reason] = String(n.dedupe_key).split(':');
    const o = await db.one('SELECT order_id, qty FROM external_orders WHERE id = $1', [orderRow]);
    const ids = await adminChatIds();
    if (!ids.length) throw new Error('NOT CONFIGURED: no admin Telegram ids');
    const WHY = {
      unknown_product: 'its SuperProfile product is not linked to any event',
      amount_mismatch: 'the amount does not match the configured price',
      currency_mismatch: 'the currency is not INR',
      event_not_published: 'the event is not published',
      duplicate_booking: 'the buyer already has a booking for this event',
      refund_after_check_in: 'it was refunded after the guest checked in'
    };
    for (const id of ids) {
      await send(id, `⚠️ SuperProfile order ${escHtml(o?.order_id || '')} needs review: ${escHtml(WHY[reason] || reason)}. Nothing was confirmed automatically. Open /admin → Orders.`);
    }
  },

  async reconcile_alert(n) {
    // dedupe_key = rc:<date>:<missing in app>:<missing on SuperProfile>:<amount drift>:<status drift>
    const [, date, inApp, onSp, amount, status] = String(n.dedupe_key).split(':');
    const ids = await adminChatIds();
    if (!ids.length) throw new Error('NOT CONFIGURED: no admin Telegram ids');
    for (const id of ids) {
      await send(id, `⚠️ SuperProfile reconciliation (${escHtml(date)}): ${escHtml(inApp)} order(s) missing in the app, ${escHtml(onSp)} missing on SuperProfile, ` +
        `${escHtml(amount)} amount mismatch(es), ${escHtml(status)} status mismatch(es). Check the SuperProfile dashboard against Admin → Orders.`);
    }
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

  async event_announcement(n) {
    const e = await db.one(`SELECT slug, title, city, start_at, category FROM events WHERE id = $1 AND status = 'published'`, [n.event_id]);
    const u = await db.one('SELECT telegram_user_id, alerts_opt_in FROM users WHERE id = $1', [n.user_id]);
    if (!e || !u?.alerts_opt_in) return;
    const path = ['weekend_trip', 'resort_getaway'].includes(e.category) ? 'trips' : 'events';
    await send(u.telegram_user_id, `New: <b>${escHtml(e.title)}</b>\n${escHtml(fmt(e.start_at))} · ${escHtml(e.city)}`,
      [[{ text: 'See details', url: `${siteUrl()}/${path}/${e.slug}` }]]);
  },

  async event_reminder(n) {
    const b = await db.one(
      `SELECT b.id, e.title, e.start_at, e.city, e.area_public, e.venue_private, e.venue_privacy,
              e.telegram_chat_id, u.telegram_user_id, u.reminders_enabled
         FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [n.booking_id]);
    if (!b || b.reminders_enabled === false) return;
    const venue = b.venue_privacy === 'public' && b.venue_private ? b.venue_private : null;
    const lines = [
      `🔔 <b>Upcoming Event Reminder</b>`,
      `<b>${escHtml(b.title)}</b>`,
      `Starts: ${escHtml(fmt(b.start_at))}`,
      `Location: ${escHtml(b.area_public ? `${b.area_public}, ` : '')}${escHtml(b.city)}`,
      venue ? `Venue: ${escHtml(venue)}` : 'Exact venue details are inside your booking pass or private group.',
      `Booking ref: <code>${b.id.slice(0, 8)}</code>`
    ];
    await send(b.telegram_user_id, lines.join('\n'), [[{ text: 'View booking pass', url: `${siteUrl()}/bookings/${b.id}` }]]);
  },

  async event_update(n) {
    const b = await db.one(
      `SELECT b.id, e.title, u.telegram_user_id FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id WHERE b.id = $1`, [n.booking_id]);
    if (!b) return;
    await send(b.telegram_user_id,
      `📢 <b>Event Update: ${escHtml(b.title)}</b>\n\nImportant operational update regarding your upcoming event. Tap below to view details on your booking pass.`,
      [[{ text: 'View booking pass', url: `${siteUrl()}/bookings/${b.id}` }]]);
  },

  async host_application_received() {
    const ids = await adminChatIds();
    if (!ids.length) throw new Error('NOT CONFIGURED: no admin Telegram ids');
    for (const id of ids) {
      await send(id, `📋 New host application submitted. Review in admin dashboard: ${siteUrl()}/admin`);
    }
  },

  async host_approved(n) {
    const u = await db.one('SELECT telegram_user_id FROM users WHERE id = $1', [n.user_id]);
    if (!u?.telegram_user_id) return;
    await send(u.telegram_user_id,
      `🎉 <b>Congratulations! Your host application has been approved.</b>\n\nYou can now create and host curated social events on NIGHTLIFEZ. Visit your organiser dashboard to get started:`,
      [[{ text: 'Organiser Dashboard', url: `${siteUrl()}/organiser` }]]);
  }
};

/** Deliver one notification row. Never throws; records outcome. */
export async function deliver(id) {
  // Check if non-urgent and inside user's quiet hours
  const peek = await db.one(`SELECT kind, user_id, booking_id FROM notifications WHERE id = $1`, [id]);
  if (peek && NON_URGENT_KINDS.has(peek.kind)) {
    const uid = peek.user_id || (peek.booking_id ? (await db.one('SELECT user_id FROM bookings WHERE id = $1', [peek.booking_id]))?.user_id : null);
    if (uid) {
      const u = await db.one('SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end FROM users WHERE id = $1', [uid]);
      if (u?.quiet_hours_enabled && isQuietHours(u)) {
        const nextAttempt = quietHoursNextAttempt(u);
        await db.query(`UPDATE notifications SET next_attempt_at = $2 WHERE id = $1`, [id, nextAttempt]);
        return 'deferred_quiet_hours';
      }
    }
  }

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
