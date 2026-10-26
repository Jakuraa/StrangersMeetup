// lib/handlers/admin.js - Admin API + shell page. Every endpoint: session → admin_users allowlist →
// role check. Every mutation: CSRF + rate limit + audit_log (same transaction).
import { db } from '../db.js';
import { HttpError, readJson, sendJson, sendHtml } from '../http.js';
import { getSessionUser, requireUser, requireCsrf, csrfTokenFor } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import { parse, z } from '../validate.js';
import { audit } from '../audit.js';
import { chatIdFromEnv, configStatus } from '../config.js';
import { enqueue } from '../services/notifications.js';
import { refundPayment as refundSvc } from '../services/refunds.js';
import { removeFromChat, tierChatId } from '../services/invites.js';
import { CATEGORY_LABELS, toPublicEvent } from '../services/events.js';
import { renderAdminShell } from '../views/admin.js';
import { renderEvent } from '../views/event.js';

const R = {
  ANY: ['super_admin', 'event_manager', 'moderator', 'finance', 'support'],
  EVENTS_WRITE: ['super_admin', 'event_manager'],
  CHECKIN: ['super_admin', 'event_manager', 'support'],
  BOOKINGS: ['super_admin', 'event_manager', 'finance', 'support'],
  REFUND: ['super_admin', 'finance'],
  MEMBERSHIPS: ['super_admin', 'finance', 'support', 'moderator'],
  REVOKE: ['super_admin', 'moderator'],
  LEADS: ['super_admin', 'event_manager', 'support'],
  MEDIA: ['super_admin', 'moderator'],
  SUPER: ['super_admin']
};

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
    (SELECT count(*)::int FROM bookings WHERE cancel_reason = 'paid_but_unavailable_refund_due' AND status <> 'refunded') AS refunds_due,
    (SELECT count(*)::int FROM leads WHERE status = 'new') AS new_leads,
    (SELECT count(*)::int FROM reports WHERE status = 'new') AS new_reports,
    (SELECT count(*)::int FROM users WHERE alerts_opt_in) AS alert_subscribers`);
  sendJson(ctx.res, 200, { ok: true, kpis: k, config: configStatus() });
}

// ---------- events ----------

const nullableStr = (max) => z.union([z.string().trim().max(max), z.null()]).optional().transform((v) => (v === '' ? null : v));
const httpsUrl = z.union([z.string().trim().url().regex(/^https:\/\//, 'Must be https'), z.literal(''), z.null()]).optional().transform((v) => v || null);
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
  is_demo: z.boolean().default(false)
}).strict().refine((e) => !e.end_at || new Date(e.end_at) > new Date(e.start_at), { message: 'End must be after start', path: ['end_at'] });

const EVENT_COLS = ['slug', 'category', 'title', 'summary', 'description', 'city', 'area_public', 'venue_private', 'venue_privacy', 'start_at', 'end_at',
  'capacity', 'ticket_price_paise', 'inclusions', 'exclusions', 'refund_policy', 'gender_policy', 'food_available', 'stay_available', 'organizer',
  'bookmyshow_url', 'external_payment_url', 'telegram_chat_id', 'cover_media_id', 'is_demo'];

function eventValues(e) {
  return EVENT_COLS.map((c) => (c === 'inclusions' || c === 'exclusions' ? JSON.stringify(e[c]) : e[c] ?? null));
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
    const dupe = (await c.query('SELECT 1 FROM events WHERE slug = $1', [e.slug])).rows[0];
    if (dupe) throw new HttpError(409, 'slug_taken', 'That slug is already used');
    const placeholders = EVENT_COLS.map((_, i) => `$${i + 1}`).join(', ');
    const r = (await c.query(
      `INSERT INTO events (${EVENT_COLS.join(', ')}, price_status, status) VALUES (${placeholders}, $${EVENT_COLS.length + 1}, 'draft') RETURNING id, slug`,
      [...eventValues(e), e.ticket_price_paise ? 'set' : 'tbd'])).rows[0];
    await audit(a.actor, 'event.create', r.id, { slug: e.slug, priceSet: Boolean(e.ticket_price_paise) }, c);
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
    const cur = (await c.query('SELECT id, slug, capacity FROM events WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Not found');
    const taken = (await c.query(`SELECT count(*)::int n FROM bookings WHERE event_id = $1 AND status IN ('confirmed','checked_in')`, [id])).rows[0].n;
    if (e.capacity < taken) throw new HttpError(409, 'capacity_below_bookings', `Capacity cannot be below ${taken} confirmed bookings`);
    const sets = EVENT_COLS.map((col, i) => `${col} = $${i + 2}`).join(', ');
    await c.query(`UPDATE events SET ${sets}, price_status = $${EVENT_COLS.length + 2} WHERE id = $1`,
      [id, ...eventValues(e), e.ticket_price_paise ? 'set' : 'tbd']);
    await audit(a.actor, 'event.update', id, { slug: e.slug }, c);
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
            p.id AS payment_id, p.provider, p.provider_txn_id, p.provider_payment_id, p.status AS payment_status, p.amount, p.is_test, p.failure_reason
       FROM bookings b JOIN events e ON e.id = b.event_id JOIN users u ON u.id = b.user_id LEFT JOIN payments p ON p.id = b.payment_id
      WHERE ${where} ORDER BY b.created_at DESC LIMIT 200`, params);
  const { rows: stars } = await db.query(
    `SELECT p.id AS payment_id, p.provider, p.provider_txn_id, p.status AS payment_status, p.amount, p.is_test, p.created_at, u.alias
       FROM payments p LEFT JOIN users u ON u.id = p.user_id WHERE p.purpose = 'membership' ORDER BY p.created_at DESC LIMIT 100`);
  sendJson(ctx.res, 200, { ok: true, bookings: rows, membershipPayments: stars });
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
  active: z.boolean().optional()
}).strict();

export async function updateTier(ctx) {
  const a = await guard(ctx, R.SUPER, { write: true });
  const id = uuidParam(ctx.params.id);
  const p = parse(TierPatch, await readJson(ctx.req));
  await db.tx(async (c) => {
    const cur = (await c.query('SELECT * FROM membership_tiers WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Not found');
    await c.query(
      `UPDATE membership_tiers SET name = $2, benefits = $3, stars_amount = $4, telegram_chat_id = $5, active = $6 WHERE id = $1`,
      [id, p.name ?? cur.name, JSON.stringify(p.benefits ?? cur.benefits), p.stars_amount === undefined ? cur.stars_amount : p.stars_amount,
        p.telegram_chat_id === undefined ? cur.telegram_chat_id : p.telegram_chat_id, p.active ?? cur.active]);
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

