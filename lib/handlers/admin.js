// lib/handlers/admin.js - Admin API + shell page. Every endpoint: session → admin_users allowlist →
// role check. Every mutation: CSRF + rate limit + audit_log (same transaction).
import { db } from '../db.js';
import { HttpError, readJson, sendJson, sendHtml } from '../http.js';
import { getSessionUser, requireUser, requireCsrf, csrfTokenFor } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import { audit } from '../audit.js';
import { chatIdFromEnv, configStatus, botToken, botUsername, siteUrl, env } from '../config.js';
import { enqueue, deliverMany } from '../services/notifications.js';
import { refundPayment as refundSvc } from '../services/refunds.js';
import { listOrders as listOrdersSvc, linkOrderToUser } from '../services/orders.js';
import { isSuperprofileUrl } from '../payments/index.js';
import { removeFromChat, tierChatId } from '../services/invites.js';
import { CATEGORY_LABELS, CITIES, toPublicEvent } from '../services/events.js';
import { getInsights } from '../services/insights.js';
import { tg, TelegramNotConfiguredError } from '../telegram/api.js';
import { oidcConfigured } from '../telegram/auth.js';
import { assertPublicHttpsUrl, runFeeds, approveCandidate as approveCandidateSvc, rejectCandidate as rejectCandidateSvc } from '../services/feeds.js';
import { superprofileConfigured } from '../services/superprofile.js';
import { renderAdminShell } from '../views/admin.js';
import { renderEvent } from '../views/event.js';
import { R } from '../admin-roles.js';


/** Resolve the admin for this request (bootstrapping the owner once), or throw 401/403. */
async function getAdmin(req) {
  const user = await requireUser(req);
  let admin = await db.one('SELECT * FROM admin_users WHERE telegram_user_id = $1 AND active', [user.telegram_user_id]);
  const boot = chatIdFromEnv('ADMIN_BOOTSTRAP_TELEGRAM_ID');
  if (!admin && boot && boot === user.telegram_user_id) {
    admin = await db.one(
      `INSERT INTO admin_users (telegram_user_id, role) VALUES ($1, 'super_admin')
       ON CONFLICT (telegram_user_id) DO UPDATE SET active = admin_users.active RETURNING *`, [user.telegram_user_id]);
    if (!admin.active) admin = null;
    else await audit(`tg:${user.telegram_user_id}`, 'admin.bootstrap', admin.id);
  }
  if (!admin) throw new HttpError(403, 'forbidden', 'Not an admin');
  return { user, admin, actor: `admin:${admin.id}:${admin.role}` };
}

async function guard(ctx, roles, { write = false } = {}) {
  const a = await getAdmin(ctx.req);
  if (!roles.includes(a.admin.role)) throw new HttpError(403, 'forbidden_role', 'Your role cannot do this');
  if (write) {
    requireCsrf(ctx.req, a.user);
    await rateLimit(`admin:${a.admin.id}`, 120, 60);
  }
  return a;
}

const uuidParam = (id) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'not_found', 'Not found');
  return id;
};

// ---------- shell ----------

export async function adminPage({ res, req }) {
  let state = 'signed_out';
  let role = null;
  let csrf = null;
  try {
    const user = await getSessionUser(req);
    if (user) {
      try {
        const a = await getAdmin(req);
        state = 'admin';
        role = a.admin.role;
        csrf = csrfTokenFor(user.sessionToken);
      } catch {
        state = 'forbidden';
      }
    }
  } catch {
    state = 'signed_out';
  }
  sendHtml(res, state === 'admin' ? 200 : state === 'forbidden' ? 403 : 401, renderAdminShell({ state, role, csrf }), {
    headers: { 'X-Robots-Tag': 'noindex, nofollow' }
  });
}

export async function adminPreview(ctx) {
  await guard(ctx, R.ANY);
  const id = uuidParam(ctx.params.id);
  const row = await db.one(
    `SELECT e.*, (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status IN ('confirmed','checked_in')) AS seats_taken FROM events e WHERE e.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'not_found', 'Not found');
  sendHtml(ctx.res, 200, renderEvent(toPublicEvent(row)), { headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
}

export async function adminSession(ctx) {
  const a = await guard(ctx, R.ANY);
  sendJson(ctx.res, 200, { ok: true, role: a.admin.role, alias: a.user.alias, csrf: csrfTokenFor(a.user.sessionToken) });
}

// ---------- overview ----------

export async function overview(ctx) {
  await guard(ctx, R.ANY);
  const k = await db.one(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(DISTINCT user_id)::int FROM entitlements WHERE status IN ('active','grace','cancelled') AND expires_at > now()) AS members,
    (SELECT count(*)::int FROM events WHERE status = 'published' AND start_at > now() AND NOT is_demo) AS upcoming_events,
    (SELECT count(*)::int FROM events WHERE status = 'published' AND start_at > now() AND is_demo) AS upcoming_demo_events,
    (SELECT count(*)::int FROM bookings WHERE status IN ('confirmed','checked_in')) AS confirmed_bookings,
    (SELECT COALESCE(sum(amount),0)::bigint FROM payments WHERE status = 'paid' AND currency = 'INR' AND is_test) AS paid_test_paise,
    (SELECT COALESCE(sum(amount),0)::bigint FROM payments WHERE status = 'paid' AND currency = 'INR' AND NOT is_test) AS paid_live_paise,
    (SELECT COALESCE(sum(amount),0)::bigint FROM payments WHERE status = 'paid' AND currency = 'XTR') AS paid_stars,
    (SELECT count(*)::int FROM payments WHERE status = 'failed') AS failed_payments,
    (SELECT count(*)::int FROM notifications WHERE status = 'failed' AND kind IN ('booking_confirmed','membership_activated')) AS invite_failures,
    (SELECT count(*)::int FROM entitlements WHERE status IN ('active','cancelled') AND expires_at BETWEEN now() AND now() + interval '7 days') AS expiring_memberships,
    (SELECT count(*)::int FROM external_orders WHERE match_state = 'unmatched' AND status = 'paid') AS unmatched_orders,
    (SELECT count(*)::int FROM external_orders WHERE match_state = 'flagged') AS flagged_orders,
    (SELECT count(*)::int FROM leads WHERE status = 'new') AS new_leads,
    (SELECT count(*)::int FROM reports WHERE status = 'new') AS new_reports,
    (SELECT count(*)::int FROM users WHERE alerts_opt_in) AS alert_subscribers`);
  sendJson(ctx.res, 200, { ok: true, kpis: k, config: configStatus() });
}

// ---------- events ----------

const nullableStr = (max) => z.union([z.string().trim().max(max), z.null()]).optional().transform((v) => (v === '' ? null : v));
const httpsUrl = z.union([z.string().trim().url().regex(/^https:\/\//, 'Must be https'), z.literal(''), z.null()]).optional().transform((v) => v || null);
const spUrl = z.union([z.string().trim().max(500).refine(isSuperprofileUrl, 'Must be an https superprofile.bio link'), z.literal(''), z.null()]).optional().transform((v) => v || null);

const EventBody = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase-words-with-dashes').max(120),
  category: z.enum(Object.keys(CATEGORY_LABELS)),
  title: z.string().trim().min(3).max(140),
  summary: nullableStr(300),
  description: nullableStr(5000),
  city: z.string().trim().min(2).max(60),
  area_public: nullableStr(120),
  venue_private: nullableStr(300),
  venue_privacy: z.enum(['public', 'disclosed_after_booking']),
  start_at: z.string().datetime({ offset: true }),
  end_at: z.union([z.string().datetime({ offset: true }), z.literal(''), z.null()]).optional().transform((v) => v || null),
  capacity: z.coerce.number().int().min(1).max(5000),
  ticket_price_paise: z.union([z.coerce.number().int().min(100).max(10_000_000), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v === undefined ? null : v)),
  inclusions: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  exclusions: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  refund_policy: nullableStr(1000),
  gender_policy: nullableStr(160),
  food_available: z.boolean().default(false),
  stay_available: z.boolean().default(false),
  organizer: nullableStr(120),
  bookmyshow_url: httpsUrl,
  external_payment_url: httpsUrl,
  telegram_chat_id: z.union([z.coerce.number().int(), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v === undefined ? null : v)),
  cover_media_id: z.union([z.string().uuid(), z.literal(''), z.null()]).optional().transform((v) => v || null),
  is_demo: z.boolean().default(false),
  superprofile_url: spUrl,
  superprofile_product_id: nullableStr(200),
  checkout_mode: z.enum(['none', 'superprofile', 'free']).default('none')
}).strict()
  .refine((e) => !e.end_at || new Date(e.end_at) > new Date(e.start_at), { message: 'End must be after start', path: ['end_at'] })
  .refine((e) => e.checkout_mode !== 'superprofile' || Boolean(e.superprofile_url), { message: 'Add the SuperProfile link to use SuperProfile checkout', path: ['superprofile_url'] });

const EVENT_COLS = ['slug', 'category', 'title', 'summary', 'description', 'city', 'area_public', 'venue_private', 'venue_privacy', 'start_at', 'end_at',
  'capacity', 'ticket_price_paise', 'inclusions', 'exclusions', 'refund_policy', 'gender_policy', 'food_available', 'stay_available', 'organizer',
  'bookmyshow_url', 'external_payment_url', 'telegram_chat_id', 'cover_media_id', 'is_demo', 'superprofile_url', 'superprofile_product_id', 'checkout_mode'];

function eventValues(e) {
  return EVENT_COLS.map((c) => (c === 'inclusions' || c === 'exclusions' ? JSON.stringify(e[c]) : e[c] ?? null));
}

async function assertProductFree(c, productId, exceptEventId = null) {
  if (!productId) return;
  const used = (await c.query('SELECT 1 FROM events WHERE lower(superprofile_product_id) = lower($1) AND ($2::uuid IS NULL OR id <> $2)', [productId, exceptEventId])).rows[0];
  if (used) throw new HttpError(409, 'product_taken', 'That SuperProfile product is already linked to another event', { fields: [{ field: 'superprofile_product_id', message: 'Already linked' }] });
}

async function assertCoverAuthorized(c, mediaId) {
  if (!mediaId) return;
  const m = (await c.query('SELECT authorized_by_owner FROM media WHERE id = $1', [mediaId])).rows[0];
  if (!m?.authorized_by_owner) throw new HttpError(400, 'validation', 'Cover image must be owner-authorised media', { fields: [{ field: 'cover_media_id', message: 'Not authorised' }] });
}

export async function listEvents(ctx) {
  await guard(ctx, R.ANY);
  const { rows } = await db.query(
    `SELECT e.id, e.slug, e.title, e.city, e.category, e.start_at, e.status, e.is_demo, e.capacity, e.price_status, e.ticket_price_paise,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status IN ('confirmed','checked_in')) AS confirmed
       FROM events e ORDER BY e.start_at DESC LIMIT 200`);
  sendJson(ctx.res, 200, { ok: true, events: rows });
}

export async function getEvent(ctx) {
  await guard(ctx, R.ANY);
  const e = await db.one('SELECT * FROM events WHERE id = $1', [uuidParam(ctx.params.id)]);
  if (!e) throw new HttpError(404, 'not_found', 'Not found');
  sendJson(ctx.res, 200, { ok: true, event: e });
}

export async function createEvent(ctx) {
  const a = await guard(ctx, R.EVENTS_WRITE, { write: true });
  const e = parse(EventBody, await readJson(ctx.req));
  const row = await db.tx(async (c) => {
    await assertCoverAuthorized(c, e.cover_media_id);
    await assertProductFree(c, e.superprofile_product_id);
    const dupe = (await c.query('SELECT 1 FROM events WHERE slug = $1', [e.slug])).rows[0];
    if (dupe) throw new HttpError(409, 'slug_taken', 'That slug is already used');
    const placeholders = EVENT_COLS.map((_, i) => `$${i + 1}`).join(', ');
    const r = (await c.query(
      `INSERT INTO events (${EVENT_COLS.join(', ')}, price_status, status) VALUES (${placeholders}, $${EVENT_COLS.length + 1}, 'draft') RETURNING id, slug`,
      [...eventValues(e), e.ticket_price_paise ? 'set' : 'tbd'])).rows[0];
    await audit(a.actor, 'event.create', r.id, { slug: e.slug, priceSet: Boolean(e.ticket_price_paise), checkoutMode: e.checkout_mode }, c);
    return r;
  });
  sendJson(ctx.res, 201, { ok: true, event: row });
}

export async function updateEvent(ctx) {
  const a = await guard(ctx, R.EVENTS_WRITE, { write: true });
  const id = uuidParam(ctx.params.id);
  const e = parse(EventBody, await readJson(ctx.req));
  await db.tx(async (c) => {
    await assertCoverAuthorized(c, e.cover_media_id);
    const cur = (await c.query('SELECT id, slug, capacity, superprofile_product_id, checkout_mode FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Not found');
    await assertProductFree(c, e.superprofile_product_id, id);
    const taken = (await c.query(`SELECT count(*)::int n FROM bookings WHERE event_id = $1 AND status IN ('confirmed','checked_in')`, [id])).rows[0].n;
    if (e.capacity < taken) throw new HttpError(409, 'capacity_below_bookings', `Capacity cannot be below ${taken} confirmed bookings`);
    const sets = EVENT_COLS.map((col, i) => `${col} = $${i + 2}`).join(', ');
    await c.query(`UPDATE events SET ${sets}, price_status = $${EVENT_COLS.length + 2} WHERE id = $1`,
      [id, ...eventValues(e), e.ticket_price_paise ? 'set' : 'tbd']);
    await audit(a.actor, 'event.update', id, {
      slug: e.slug, checkoutMode: e.checkout_mode,
      ...(cur.checkout_mode !== e.checkout_mode ? { checkoutModeFrom: cur.checkout_mode } : {}),
      ...(cur.superprofile_product_id !== e.superprofile_product_id ? { superprofileProductChanged: true } : {})
    }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

const StatusBody = z.object({ status: z.enum(['draft', 'published', 'cancelled', 'archived']) }).strict();

export async function setEventStatus(ctx) {
  const a = await guard(ctx, R.EVENTS_WRITE, { write: true });
  const id = uuidParam(ctx.params.id);
  const { status } = parse(StatusBody, await readJson(ctx.req));
  const ids = await db.tx(async (c) => {
    const cur = (await c.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Not found');
    await c.query(`UPDATE events SET status = $2::event_status, published_at = CASE WHEN $2::text = 'published' THEN COALESCE(published_at, now()) ELSE published_at END WHERE id = $1`, [id, status]);
    const out = [];
    if (status === 'published' && cur.status !== 'published' && !cur.is_demo) {
      const { rows } = await c.query('SELECT id FROM users WHERE alerts_opt_in AND status = $1', ['active']);
      for (const u of rows) out.push(await enqueue(c, { kind: 'event_announcement', userId: u.id, eventId: id, dedupeKey: `ann:${id}:${u.id}` }));
    }
    if (status === 'cancelled' && cur.status !== 'cancelled') {
      await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'event_cancelled_hold' WHERE event_id = $1 AND status = 'pending_payment'`, [id]);
      const { rows } = await c.query(`SELECT id, user_id FROM bookings WHERE event_id = $1 AND status IN ('confirmed','checked_in')`, [id]);
      for (const b of rows) out.push(await enqueue(c, { kind: 'event_cancelled', userId: b.user_id, bookingId: b.id, eventId: id, dedupeKey: `cancel:${b.id}` }));
    }
    await audit(a.actor, 'event.status', id, { from: cur.status, to: status, announcements: out.length }, c);
    return out;
  });
  // Announcements are delivered by the notifications cron to avoid long admin requests.
  sendJson(ctx.res, 200, { ok: true, queuedAnnouncements: ids.filter(Boolean).length });
}

export async function attendees(ctx) {
  await guard(ctx, R.CHECKIN);
  const { rows } = await db.query(
    `SELECT b.id, b.status, b.confirmed_at, b.checked_in_at, u.alias, u.telegram_user_id
       FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.event_id = $1 AND b.status IN ('confirmed','checked_in') ORDER BY u.alias NULLS LAST`, [uuidParam(ctx.params.id)]);
  sendJson(ctx.res, 200, { ok: true, attendees: rows.map((r) => ({ ...r, ref: r.id.slice(0, 8) })) });
}

export async function checkIn(ctx) {
  const a = await guard(ctx, R.CHECKIN, { write: true });
  const id = uuidParam(ctx.params.id);
  await db.tx(async (c) => {
    const r = await c.query(`UPDATE bookings SET status = 'checked_in', checked_in_at = now() WHERE id = $1 AND status = 'confirmed' RETURNING id`, [id]);
    if (!r.rowCount) throw new HttpError(409, 'not_checkinable', 'Only confirmed bookings can be checked in');
    await audit(a.actor, 'booking.check_in', id, {}, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- bookings & payments ----------

export async function listBookings(ctx) {
  await guard(ctx, R.BOOKINGS);
  const status = ctx.query.get('status');
  const params = [];
  let where = 'TRUE';
  if (status && ['pending_payment', 'confirmed', 'checked_in', 'cancelled', 'refunded', 'refund_due'].includes(status)) {
    if (status === 'refund_due') where = `b.cancel_reason = 'paid_but_unavailable_refund_due' AND b.status <> 'refunded'`;
    else { params.push(status); where = 'b.status = $1'; }
  }
  const { rows } = await db.query(
    `SELECT b.id, b.status, b.cancel_reason, b.created_at, b.confirmed_at, e.title, e.start_at, u.alias,
            p.id AS payment_id, p.provider, p.provider_txn_id, p.provider_payment_id, p.status AS payment_status, p.amount, p.is_test, p.failure_reason,
            eo.order_id, eo.status AS order_status, eo.amount_paise AS order_amount, b.source
       FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id LEFT JOIN payments p ON p.id = b.payment_id
       LEFT JOIN external_orders eo ON eo.matched_booking_id = b.id
      WHERE ${where} ORDER BY b.created_at DESC LIMIT 200`, params);
  const { rows: stars } = await db.query(
    `SELECT p.id AS payment_id, p.provider, p.provider_txn_id, p.status AS payment_status, p.amount, p.is_test, p.created_at, u.alias
       FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.purpose = 'membership' ORDER BY p.created_at DESC LIMIT 100`);
  sendJson(ctx.res, 200, { ok: true, bookings: rows, membershipPayments: stars });
}

// ---------- SuperProfile orders ----------

export async function listOrders(ctx) {
  await guard(ctx, R.ORDERS);
  const r = await listOrdersSvc({ state: ctx.query.get('state') || 'unmatched', cursor: ctx.query.get('cursor'), limit: ctx.query.get('limit') || 25 });
  sendJson(ctx.res, 200, { ok: true, ...r });
}

const LinkBody = z.object({ telegramUserId: z.coerce.number().int().positive() }).strict();

export async function linkOrder(ctx) {
  const a = await guard(ctx, R.ORDERS_LINK, { write: true });
  const { telegramUserId } = parse(LinkBody, await readJson(ctx.req));
  const r = await linkOrderToUser(a.actor, uuidParam(ctx.params.id), telegramUserId);
  await deliverMany(r.notificationIds);
  sendJson(ctx.res, 200, { ok: true, bookingId: r.bookingId });
}

export async function refundPayment(ctx) {
  const a = await guard(ctx, R.REFUND, { write: true });
  await refundSvc(uuidParam(ctx.params.id), a.actor);
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- memberships ----------

export async function listMemberships(ctx) {
  await guard(ctx, R.MEMBERSHIPS);
  const q = (ctx.query.get('q') || '').trim();
  const params = [];
  let where = `en.status IN ('active','grace','cancelled','expired')`;
  if (/^\d{3,15}$/.test(q)) { params.push(Number(q)); where += ` AND u.telegram_user_id = $1`; }
  else if (q) { params.push(`%${q.slice(0, 60)}%`); where += ` AND u.alias ILIKE $1`; }
  const { rows } = await db.query(
    `SELECT en.id, en.status, en.starts_at, en.expires_at, t.name AS tier, u.alias, u.telegram_user_id
       FROM entitlements en JOIN users u ON u.id = en.user_id JOIN membership_tiers t ON t.id = en.tier_id
      WHERE ${where} ORDER BY en.expires_at DESC LIMIT 200`, params);
  sendJson(ctx.res, 200, { ok: true, memberships: rows });
}

export async function revokeEntitlement(ctx) {
  const a = await guard(ctx, R.REVOKE, { write: true });
  const id = uuidParam(ctx.params.id);
  const ent = await db.one(
    `SELECT en.id, en.status, u.telegram_user_id, t.code, t.telegram_chat_id FROM entitlements en
       JOIN users u ON u.id = en.user_id JOIN membership_tiers t ON t.id = en.tier_id WHERE en.id = $1`, [id]);
  if (!ent) throw new HttpError(404, 'not_found', 'Not found');
  if (ent.status === 'revoked') throw new HttpError(409, 'already_revoked', 'Already revoked');
  const chat = tierChatId(ent);
  if (chat !== null) await removeFromChat(chat, ent.telegram_user_id);
  await db.tx(async (c) => {
    await c.query(`UPDATE entitlements SET status = 'revoked', revoked_at = now() WHERE id = $1`, [id]);
    await c.query(`UPDATE invite_links SET revoked_at = COALESCE(revoked_at, now()) WHERE entitlement_id = $1`, [id]);
    await audit(a.actor, 'entitlement.revoke', id, { removedFromChat: chat !== null }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- leads & reports ----------

export async function listLeads(ctx) {
  await guard(ctx, R.LEADS);
  const { rows } = await db.query(`SELECT id, type, payload, status, created_at FROM leads ORDER BY created_at DESC LIMIT 200`);
  let reports = [];
  const a = await getAdmin(ctx.req);
  if (['super_admin', 'moderator'].includes(a.admin.role)) {
    reports = (await db.query(
      `SELECT r.id, r.body, r.status, r.created_at, u.alias, u.telegram_user_id FROM reports r LEFT JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC LIMIT 200`)).rows;
  }
  sendJson(ctx.res, 200, { ok: true, leads: rows, reports });
}

const LeadUpdate = z.object({ status: z.enum(['new', 'contacted', 'closed', 'spam']) }).strict();

export async function updateLead(ctx) {
  const a = await guard(ctx, R.LEADS, { write: true });
  const id = uuidParam(ctx.params.id);
  const { status } = parse(LeadUpdate, await readJson(ctx.req));
  await db.tx(async (c) => {
    const r = await c.query('UPDATE leads SET status = $2 WHERE id = $1 RETURNING id', [id, status]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Not found');
    await audit(a.actor, 'lead.status', id, { status }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

const ReportUpdate = z.object({ status: z.enum(['new', 'reviewing', 'actioned', 'dismissed']) }).strict();

export async function updateReport(ctx) {
  const a = await guard(ctx, ['super_admin', 'moderator'], { write: true });
  const id = uuidParam(ctx.params.id);
  const { status } = parse(ReportUpdate, await readJson(ctx.req));
  await db.tx(async (c) => {
    const r = await c.query('UPDATE reports SET status = $2 WHERE id = $1 RETURNING id', [id, status]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Not found');
    await audit(a.actor, 'report.status', id, { status }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- media ----------

const MediaBody = z.object({
  type: z.enum(['photo', 'video', 'review']),
  url: z.union([z.string().trim().url().regex(/^https:\/\//, 'Must be https'), z.literal(''), z.null()]).optional().transform((v) => v || null),
  caption: nullableStr(500),
  author_alias: nullableStr(80),
  authorized_by_owner: z.boolean().default(false),
  visible: z.boolean().default(false)
}).strict().refine((m) => m.type === 'review' ? Boolean(m.caption) : Boolean(m.url), { message: 'Photos/videos need a URL; reviews need text', path: ['url'] })
  .refine((m) => !m.visible || m.authorized_by_owner, { message: 'Only owner-authorised media can be visible', path: ['visible'] });

export async function listMedia(ctx) {
  await guard(ctx, R.MEDIA);
  const { rows } = await db.query('SELECT * FROM media ORDER BY created_at DESC LIMIT 200');
  sendJson(ctx.res, 200, { ok: true, media: rows });
}

export async function createMedia(ctx) {
  const a = await guard(ctx, R.MEDIA, { write: true });
  const m = parse(MediaBody, await readJson(ctx.req));
  if (m.authorized_by_owner && a.admin.role !== 'super_admin') throw new HttpError(403, 'forbidden_role', 'Only the owner (super_admin) can authorise media');
  const row = await db.tx(async (c) => {
    const r = (await c.query(
      `INSERT INTO media (type, url, caption, author_alias, authorized_by_owner, visible) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [m.type, m.url, m.caption, m.author_alias, m.authorized_by_owner, m.visible])).rows[0];
    await audit(a.actor, 'media.create', r.id, { type: m.type, authorized: m.authorized_by_owner, visible: m.visible }, c);
    return r;
  });
  sendJson(ctx.res, 201, { ok: true, media: row });
}

const MediaPatch = z.object({ authorized_by_owner: z.boolean().optional(), visible: z.boolean().optional() }).strict();

export async function updateMedia(ctx) {
  const a = await guard(ctx, R.MEDIA, { write: true });
  const id = uuidParam(ctx.params.id);
  const patch = parse(MediaPatch, await readJson(ctx.req));
  if (patch.authorized_by_owner !== undefined && a.admin.role !== 'super_admin') throw new HttpError(403, 'forbidden_role', 'Only the owner (super_admin) can authorise media');
  await db.tx(async (c) => {
    const cur = (await c.query('SELECT * FROM media WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Not found');
    const authorized = patch.authorized_by_owner ?? cur.authorized_by_owner;
    const visible = (patch.visible ?? cur.visible) && authorized;
    if (patch.visible && !authorized) throw new HttpError(409, 'not_authorized', 'Authorise the item before making it visible');
    await c.query('UPDATE media SET authorized_by_owner = $2, visible = $3 WHERE id = $1', [id, authorized, visible]);
    await audit(a.actor, 'media.update', id, { authorized, visible }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- membership tiers (super_admin) ----------

export async function listTiers(ctx) {
  await guard(ctx, R.ANY);
  const { rows } = await db.query('SELECT * FROM membership_tiers ORDER BY sort_order');
  sendJson(ctx.res, 200, { ok: true, tiers: rows });
}

const TierPatch = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  benefits: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
  stars_amount: z.union([z.coerce.number().int().min(1).max(10000), z.null()]).optional(),
  telegram_chat_id: z.union([z.coerce.number().int(), z.null()]).optional(),
  active: z.boolean().optional(),
  access_provider: z.enum(['telegram_stars', 'superprofile']).optional(),
  superprofile_url: z.union([z.string().trim().max(500).refine(isSuperprofileUrl, 'Must be an https superprofile.bio link'), z.null()]).optional(),
  superprofile_product_ref: z.union([z.string().trim().min(1).max(200), z.null()]).optional()
}).strict();

export async function updateTier(ctx) {
  const a = await guard(ctx, R.SUPER, { write: true });
  const id = uuidParam(ctx.params.id);
  const p = parse(TierPatch, await readJson(ctx.req));
  await db.tx(async (c) => {
    const cur = (await c.query('SELECT * FROM membership_tiers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Not found');
    await c.query(
      `UPDATE membership_tiers SET name = $2, benefits = $3, stars_amount = $4, telegram_chat_id = $5, active = $6,
              access_provider = $7, superprofile_url = $8, superprofile_product_ref = $9 WHERE id = $1`,
      [id, p.name ?? cur.name, JSON.stringify(p.benefits ?? cur.benefits), p.stars_amount === undefined ? cur.stars_amount : p.stars_amount,
        p.telegram_chat_id === undefined ? cur.telegram_chat_id : p.telegram_chat_id, p.active ?? cur.active,
        p.access_provider ?? cur.access_provider, p.superprofile_url === undefined ? cur.superprofile_url : p.superprofile_url,
        p.superprofile_product_ref === undefined ? cur.superprofile_product_ref : p.superprofile_product_ref]);
    await audit(a.actor, 'tier.update', id, { fields: Object.keys(p), starsFrom: cur.stars_amount, starsTo: p.stars_amount }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- admins & audit (super_admin) ----------

export async function listAdmins(ctx) {
  await guard(ctx, R.SUPER);
  const { rows } = await db.query('SELECT id, telegram_user_id, email, role, active, created_at FROM admin_users ORDER BY created_at');
  sendJson(ctx.res, 200, { ok: true, admins: rows });
}

const AdminBody = z.object({
  telegram_user_id: z.coerce.number().int().positive(),
  role: z.enum(['super_admin', 'event_manager', 'moderator', 'finance', 'support']),
  active: z.boolean().default(true)
}).strict();

export async function upsertAdmin(ctx) {
  const a = await guard(ctx, R.SUPER, { write: true });
  const b = parse(AdminBody, await readJson(ctx.req));
  if (b.telegram_user_id === a.user.telegram_user_id && (!b.active || b.role !== 'super_admin')) {
    throw new HttpError(409, 'self_demote', 'You cannot demote or deactivate yourself');
  }
  await db.tx(async (c) => {
    const r = (await c.query(
      `INSERT INTO admin_users (telegram_user_id, role, active) VALUES ($1, $2, $3)
       ON CONFLICT (telegram_user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active RETURNING id`,
      [b.telegram_user_id, b.role, b.active])).rows[0];
    await audit(a.actor, 'admin.upsert', r.id, { role: b.role, active: b.active }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

export async function listAudit(ctx) {
  await guard(ctx, R.SUPER);
  const { rows } = await db.query('SELECT actor, action, target, details, at FROM audit_log ORDER BY at DESC LIMIT 300');
  sendJson(ctx.res, 200, { ok: true, audit: rows });
}

// ---------- organisers (who may use the event wizard) ----------

export async function listOrganisers(ctx) {
  await guard(ctx, R.SUPER);
  const { rows } = await db.query(
    `SELECT u.id, u.alias, u.telegram_user_id, u.created_at,
            (SELECT count(*)::int FROM events e WHERE e.organiser_user_id = u.id) AS events
       FROM users u WHERE u.organiser_enabled ORDER BY u.alias NULLS LAST LIMIT 500`);
  sendJson(ctx.res, 200, { ok: true, organisers: rows });
}

const OrganiserBody = z.object({ telegram_user_id: z.coerce.number().int().positive(), enabled: z.boolean() }).strict();

export async function setOrganiser(ctx) {
  const a = await guard(ctx, R.SUPER, { write: true });
  const b = parse(OrganiserBody, await readJson(ctx.req));
  await db.tx(async (c) => {
    const r = (await c.query('UPDATE users SET organiser_enabled = $2 WHERE telegram_user_id = $1 RETURNING id', [b.telegram_user_id, b.enabled])).rows[0];
    if (!r) throw new HttpError(404, 'user_not_found', 'That person needs to sign in to the site once first');
    await audit(a.actor, 'organiser.set', r.id, { enabled: b.enabled }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}


// ---------- insights ----------

export async function insights(ctx) {
  await guard(ctx, R.INSIGHTS);
  const days = parseInt(ctx.query.get('days') || '30', 10);
  sendJson(ctx.res, 200, { ok: true, insights: await getInsights(days) }, { 'Cache-Control': 'no-store' });
}

// ---------- Telegram live configuration check ----------

async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (err) {
    return { ok: false, error: err instanceof TelegramNotConfiguredError ? 'NOT CONFIGURED' : String(err.description || err.message).slice(0, 200) };
  }
}

export async function telegramStatus(ctx) {
  await guard(ctx, R.SUPER);
  const expectedWebhook = `${siteUrl()}/api/telegram/webhook`;
  const out = {
    tokenConfigured: Boolean(botToken()),
    usernameConfigured: Boolean(botUsername()),
    webhookSecretConfigured: /^[A-Za-z0-9_-]{16,256}$/.test(env('TELEGRAM_WEBHOOK_SECRET')),
    loginOidcConfigured: oidcConfigured(),
    testEnvironment: env('TELEGRAM_TEST_ENV') === 'true',
    expectedWebhook,
    bot: null, webhook: null, chats: []
  };
  if (!out.tokenConfigured) {
    sendJson(ctx.res, 200, { ok: true, telegram: { ...out, available: false, reason: 'TELEGRAM_BOT_TOKEN is not set on this deployment (or is not in bot-token format).' } });
    return;
  }
  const me = await attempt(() => tg('getMe'));
  out.bot = me.ok
    ? { ok: true, username: me.value.username, id: me.value.id, usernameMatches: !botUsername() || botUsername().toLowerCase() === String(me.value.username).toLowerCase() }
    : me;
  const wh = await attempt(() => tg('getWebhookInfo'));
  out.webhook = wh.ok ? {
    ok: true, url: wh.value.url || '', matchesThisDeployment: wh.value.url === expectedWebhook,
    pendingUpdates: wh.value.pending_update_count, lastErrorAt: wh.value.last_error_date ? new Date(wh.value.last_error_date * 1000).toISOString() : null,
    lastError: wh.value.last_error_message || null, allowedUpdates: wh.value.allowed_updates || null, maxConnections: wh.value.max_connections ?? null
  } : wh;
  const chats = [['events', chatIdFromEnv('TG_CHAT_ID_EVENTS')]];
  for (const t of (await db.query('SELECT code, telegram_chat_id, access_provider FROM membership_tiers WHERE active ORDER BY sort_order')).rows) {
    // SuperProfile manages its own integrated groups; our bot does not need rights there.
    if (t.access_provider === 'superprofile') { out.chats.push({ name: t.code, skipped: 'Managed by SuperProfile' }); continue; }
    chats.push([t.code, tierChatId(t)]);
  }
  for (const [name, id] of chats) {
    if (id === null) { out.chats.push({ name, ok: false, error: 'NOT CONFIGURED: chat id' }); continue; }
    const chat = await attempt(() => tg('getChat', { chat_id: id }));
    const member = me.ok ? await attempt(() => tg('getChatMember', { chat_id: id, user_id: me.value.id })) : { ok: false, error: 'bot unknown' };
    out.chats.push({
      name, chatId: id, ok: chat.ok && member.ok && member.value.status === 'administrator' && Boolean(member.value.can_invite_users) && Boolean(member.value.can_restrict_members),
      title: chat.ok ? chat.value.title : null, chatError: chat.ok ? null : chat.error,
      botStatus: member.ok ? member.value.status : null, canInvite: member.ok ? Boolean(member.value.can_invite_users) : null,
      canRestrict: member.ok ? Boolean(member.value.can_restrict_members) : null, memberError: member.ok ? null : member.error
    });
  }
  sendJson(ctx.res, 200, { ok: true, telegram: { ...out, available: true } }, { 'Cache-Control': 'no-store' });
}

// ---------- discovery: feeds ----------

const FeedBody = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.string().trim().url().regex(/^https:\/\//, 'Must be https').max(500),
  site_url: httpsUrl,
  attribution: z.string().trim().min(2).max(80),
  permission_basis: z.string().trim().min(10, 'Record why we may use this feed (e.g. publisher permission, published terms)').max(500),
  default_category: z.union([z.enum(Object.keys(CATEGORY_LABELS)), z.literal(''), z.null()]).optional().transform((v) => v || null),
  default_city: z.union([z.enum(CITIES.map((c) => c.name)), z.literal(''), z.null()]).optional().transform((v) => v || null),
  active: z.boolean().default(true)
}).strict();

export async function listFeeds(ctx) {
  await guard(ctx, R.DISCOVERY);
  const { rows } = await db.query(
    `SELECT f.*, (SELECT json_agg(l ORDER BY l.at DESC) FROM (SELECT at, status, http_status, items_seen, items_new, items_dup, error, duration_ms
                    FROM feed_fetch_log WHERE feed_id = f.id ORDER BY at DESC LIMIT 5) l) AS recent
       FROM event_feeds f ORDER BY f.created_at DESC`);
  sendJson(ctx.res, 200, { ok: true, feeds: rows });
}

export async function createFeed(ctx) {
  const a = await guard(ctx, R.DISCOVERY_WRITE, { write: true });
  const f = parse(FeedBody, await readJson(ctx.req));
  await assertPublicHttpsUrl(f.url);
  const row = await db.tx(async (c) => {
    const r = (await c.query(
      `INSERT INTO event_feeds (name, url, site_url, attribution, permission_basis, default_category, default_city, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (url) DO NOTHING RETURNING id`,
      [f.name, f.url, f.site_url, f.attribution, f.permission_basis, f.default_category, f.default_city, f.active, a.actor])).rows[0];
    if (!r) throw new HttpError(409, 'feed_exists', 'That feed is already added');
    await audit(a.actor, 'feed.create', r.id, { url: f.url }, c);
    return r;
  });
  sendJson(ctx.res, 201, { ok: true, feed: row });
}

export async function updateFeed(ctx) {
  const a = await guard(ctx, R.DISCOVERY_WRITE, { write: true });
  const id = uuidParam(ctx.params.id);
  const f = parse(FeedBody, await readJson(ctx.req));
  await assertPublicHttpsUrl(f.url);
  await db.tx(async (c) => {
    const r = await c.query(
      `UPDATE event_feeds SET name=$2, url=$3, site_url=$4, attribution=$5, permission_basis=$6, default_category=$7, default_city=$8, active=$9,
              etag = CASE WHEN url = $3 THEN etag END, last_modified = CASE WHEN url = $3 THEN last_modified END
        WHERE id = $1 RETURNING id`,
      [id, f.name, f.url, f.site_url, f.attribution, f.permission_basis, f.default_category, f.default_city, f.active]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Not found');
    await audit(a.actor, 'feed.update', id, { active: f.active }, c);
  });
  sendJson(ctx.res, 200, { ok: true });
}

export async function fetchFeed(ctx) {
  const a = await guard(ctx, R.DISCOVERY_WRITE, { write: true });
  const id = uuidParam(ctx.params.id);
  const feed = await db.one('SELECT id FROM event_feeds WHERE id = $1', [id]);
  if (!feed) throw new HttpError(404, 'not_found', 'Not found');
  await rateLimit(`feedfetch:${id}`, 6, 3600);
  const [result] = await runFeeds({ feedId: id });
  await audit(a.actor, 'feed.fetch', id, { status: result.status, new: result.new });
  sendJson(ctx.res, 200, { ok: true, result });
}

// ---------- discovery: moderation queue ----------

export async function listCandidates(ctx) {
  await guard(ctx, R.DISCOVERY);
  const status = ['pending', 'approved', 'rejected', 'duplicate'].includes(ctx.query.get('status')) ? ctx.query.get('status') : 'pending';
  const { rows } = await db.query(
    `SELECT c.*, f.name AS feed_name, f.attribution AS feed_attribution, e.slug AS event_slug, e.category AS event_category,
            d.title AS duplicate_title, d.slug AS duplicate_slug
       FROM event_candidates c LEFT JOIN event_feeds f ON f.id = c.feed_id LEFT JOIN events e ON e.id = c.event_id
       LEFT JOIN events d ON d.id = c.duplicate_of_event
      WHERE c.status = $1 ORDER BY c.start_at NULLS LAST, c.created_at DESC LIMIT 200`, [status]);
  sendJson(ctx.res, 200, { ok: true, candidates: rows.map(({ ip_hash: _ip, ...r }) => r) });
}

const ApproveBody = z.object({
  mode: z.enum(['external', 'internal']),
  title: z.string().trim().min(3).max(140),
  category: z.enum(Object.keys(CATEGORY_LABELS)),
  city: z.string().trim().min(2).max(60),
  start_at: z.string().datetime({ offset: true }),
  end_at: z.union([z.string().datetime({ offset: true }), z.literal(''), z.null()]).optional().transform((v) => v || null),
  summary: nullableStr(300),
  venue: nullableStr(200),
  area: nullableStr(120),
  organizer: nullableStr(120),
  external_url: httpsUrl,
  source_name: nullableStr(80),
  capacity: z.union([z.coerce.number().int().min(1).max(5000), z.literal(''), z.null()]).optional().transform((v) => (v === '' ? null : v)),
  publish: z.boolean().default(false),
  note: nullableStr(300)
}).strict().refine((d) => !d.end_at || new Date(d.end_at) > new Date(d.start_at), { message: 'End must be after start', path: ['end_at'] })
  .refine((d) => new Date(d.start_at) > new Date(), { message: 'Start must be in the future', path: ['start_at'] });

export async function approveCandidate(ctx) {
  const a = await guard(ctx, R.DISCOVERY_WRITE, { write: true });
  const d = parse(ApproveBody, await readJson(ctx.req));
  const ev = await approveCandidateSvc(uuidParam(ctx.params.id), d, a.actor);
  sendJson(ctx.res, 200, { ok: true, event: ev });
}

const RejectBody = z.object({ status: z.enum(['rejected', 'duplicate']), note: nullableStr(300) }).strict();

export async function rejectCandidate(ctx) {
  const a = await guard(ctx, R.DISCOVERY_WRITE, { write: true });
  const b = parse(RejectBody, await readJson(ctx.req));
  await rejectCandidateSvc(uuidParam(ctx.params.id), b, a.actor);
  sendJson(ctx.res, 200, { ok: true });
}

// ---------- SuperProfile log ----------

export async function listSuperprofile(ctx) {
  await guard(ctx, R.FINANCE_VIEW);
  const { rows: events } = await db.query(
    `SELECT s.event_type, s.external_id, s.product_ref, t.name AS tier, s.amount_paise, s.currency, s.occurred_at, s.received_at,
            (s.email_hash IS NOT NULL) AS has_email
       FROM superprofile_events s LEFT JOIN membership_tiers t ON t.id = s.tier_id ORDER BY s.received_at DESC LIMIT 200`);
  sendJson(ctx.res, 200, {
    ok: true, configured: superprofileConfigured(), webhookPath: '/api/membership/superprofile/webhook', events
  });
}
