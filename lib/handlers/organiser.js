// lib/handlers/organiser.js - Organiser wizard pages + API, guest booking of ticket tiers, and
// event images. Every organiser endpoint: session → organiser check → ownership (drafts and
// events are looked up by id AND owner, so another organiser's draft is a 404). Every write:
// CSRF + rate limit.
import { HttpError, readJson, readBinaryBody, sendJson, sendHtml, redirect } from '../http.js';
import { getSessionUser, requireUser, requireCsrf, csrfTokenFor } from '../session.js';
import { parse, z, uuid } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { afterResponse } from '../after.js';
import { deliverMany } from '../services/notifications.js';
import { ticketCheckoutStatus } from '../payments/availability.js';
import { CATEGORY_LABELS, CITIES } from '../services/events.js';
import { TIMEZONES } from '../time.js';
import * as O from '../services/organiser.js';
import { bookTier, TierBookingBody, decideRequest, listEventGuests, manageableEvent } from '../services/ticketing.js';
import { renderOrganiserPage, renderDraftPreview, renderStaffJoinPage } from '../views/organiser.js';
import { can, authorize } from '../services/permissions.js';
import {
  checkInTicket, reissueTicket, revokeTicket, getEventAttendance, listEventScans, getBookingTickets
} from '../services/tickets.js';
import {
  listEventStaff, assignEventStaff, revokeEventStaff, createStaffInvite, getStaffInvite, acceptStaffInvite
} from '../services/event-staff.js';
import {
  listEventAnnouncements, createEventAnnouncement
} from '../services/event-announcements.js';

const id = (v) => {
  if (!uuid.safeParse(v).success) throw new HttpError(404, 'not_found', 'Not found');
  return v;
};

async function organiser(ctx, { write = false, limit = [240, 600], scope = null } = {}) {
  const user = await requireUser(ctx.req);
  await O.requireOrganiser(user);
  if (write) {
    requireCsrf(ctx.req, user);
    const key = scope ? `org:${scope}:${user.id}` : `org:${user.id}`;
    await rateLimit(key, limit[0], limit[1]);
  }
  return user;
}

// ---------- pages ----------

/** Resolve page state without throwing: signed_out | not_organiser | ok. Supports event-scoped staff. */
async function pageState(req, eventId = null) {
  const user = await getSessionUser(req);
  if (!user) return { state: 'signed_out' };
  const isOrg = await O.isOrganiser(user);
  if (isOrg) return { state: 'ok', user, csrf: csrfTokenFor(user.sessionToken) };
  if (eventId) {
    const isStaff = await can(user, 'event.check_in', { eventId });
    if (isStaff) return { state: 'ok', user, csrf: csrfTokenFor(user.sessionToken), eventStaff: true };
  }
  return { state: 'not_organiser', user };
}

function wizardConfig(user, draftId) {
  return {
    draftId: draftId || null,
    alias: user.alias || '',
    templates: Object.entries(O.TEMPLATES).map(([key, t]) => ({ key, label: t.label, hint: t.hint, defaults: O.initialDraftData(key) })),
    cities: CITIES.map((c) => c.name),
    ticketPresets: O.TICKET_PRESETS,
    questionPresets: O.QUESTION_PRESETS,
    categories: Object.entries(CATEGORY_LABELS),
    timezones: TIMEZONES,
    checkout: ticketCheckoutStatus(),
    limits: { images: O.MAX_IMAGES, imageBytes: O.MAX_IMAGE_BYTES, tiers: O.MAX_TIERS, questions: O.MAX_QUESTIONS, pickups: O.MAX_PICKUPS, days: O.MAX_EVENT_DAYS }
  };
}

const NOINDEX = { headers: { 'X-Robots-Tag': 'noindex, nofollow' } };

export async function dashboardPage({ req, res }) {
  const s = await pageState(req);
  sendHtml(res, 200, renderOrganiserPage({ page: 'dashboard', ...s }), NOINDEX);
}

export async function wizardPage({ req, res, query }) {
  const s = await pageState(req);
  const draft = query.get('draft');
  const config = s.state === 'ok' ? wizardConfig(s.user, uuid.safeParse(draft).success ? draft : null) : null;
  sendHtml(res, 200, renderOrganiserPage({ page: 'wizard', ...s, config }), NOINDEX);
}

export async function managePage({ req, res, params }) {
  const eventId = id(params.id);
  const s = await pageState(req, eventId);
  sendHtml(res, 200, renderOrganiserPage({ page: 'manage', ...s, eventId }), NOINDEX);
}

export async function scanPage({ req, res, params }) {
  const eventId = id(params.id);
  const s = await pageState(req, eventId);
  sendHtml(res, 200, renderOrganiserPage({ page: 'scan', ...s, eventId }), NOINDEX);
}

export async function staffJoinPage({ req, res, query }) {
  const token = query.get('token');
  const user = await getSessionUser(req).catch(() => null);
  let invite = null;
  let error = null;
  if (!token) {
    error = 'Missing invitation token';
  } else {
    try {
      invite = await getStaffInvite(token);
      invite.token = token;
    } catch (err) {
      error = err.message || 'Invalid or expired invite';
    }
  }
  const csrf = user ? csrfTokenFor(user.sessionToken) : '';
  const state = user ? 'ok' : 'signed_out';
  sendHtml(res, 200, renderStaffJoinPage({ state, invite, csrf, error }), NOINDEX);
}

/** The real attendee page rendered from the draft, booking disabled. Owner only; never cached. */
export async function draftPreviewPage({ req, res, params }) {
  const s = await pageState(req);
  if (s.state !== 'ok') return sendHtml(res, s.state === 'signed_out' ? 401 : 403, renderOrganiserPage({ page: 'dashboard', ...s }), NOINDEX);
  const draft = await O.getDraft(s.user.id, id(params.id));
  const event = O.previewEvent(draft.data, { hostFallback: s.user.alias });
  sendHtml(res, 200, renderDraftPreview({ event, draftId: draft.id, issues: O.publishIssues(draft.data) }), NOINDEX);
}

// ---------- drafts API ----------

const withIssues = (draft) => ({ ...draft, issues: O.publishIssues(draft.data) });

export async function context(ctx) {
  const user = await organiser(ctx);
  const [drafts, events] = await Promise.all([O.listDrafts(user.id), O.listOrganiserEvents(user)]);
  sendJson(ctx.res, 200, { ok: true, drafts, events, checkout: ticketCheckoutStatus() });
}

export async function listDrafts(ctx) {
  const user = await organiser(ctx);
  sendJson(ctx.res, 200, { ok: true, drafts: await O.listDrafts(user.id) });
}

const CreateBody = z.object({ template: z.enum(Object.keys(O.TEMPLATES)).optional() }).strict();

export async function createDraft(ctx) {
  const user = await organiser(ctx, { write: true });
  const body = parse(CreateBody, await readJson(ctx.req));
  sendJson(ctx.res, 201, { ok: true, draft: withIssues(await O.createDraft(user, body)) });
}

export async function getDraft(ctx) {
  const user = await organiser(ctx);
  const r = await O.getDraft(user.id, id(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true, draft: withIssues({ id: r.id, data: r.data, step: r.step, version: r.version, status: r.status, eventId: r.event_id, updatedAt: r.updated_at }) });
}

const SaveBody = z.object({
  data: O.DraftData,
  step: z.enum(['basics', 'tickets', 'features', 'preview']).default('basics'),
  version: z.number().int().min(1)
}).strict();

export async function saveDraft(ctx) {
  const user = await organiser(ctx, { write: true });
  const body = parse(SaveBody, await readJson(ctx.req));
  sendJson(ctx.res, 200, { ok: true, draft: withIssues(await O.saveDraft(user.id, id(ctx.params.id), body)) });
}

export async function discardDraft(ctx) {
  const user = await organiser(ctx, { write: true });
  await O.discardDraft(user.id, id(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true });
}

export async function checkDraft(ctx) {
  const user = await organiser(ctx);
  const r = await O.getDraft(user.id, id(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true, issues: O.publishIssues(r.data), checkout: ticketCheckoutStatus() });
}

const PublishBody = z.object({ version: z.number().int().min(1), confirm: z.literal(true) }).strict();

export async function publishDraft(ctx) {
  const user = await organiser(ctx, { write: true, limit: [20, 600], scope: 'publish' });
  const raw = await readJson(ctx.req);
  if (raw.confirm !== true) throw new HttpError(400, 'confirm_required', 'Publishing needs explicit confirmation.');
  const body = parse(PublishBody, raw);
  sendJson(ctx.res, 200, { ok: true, ...(await O.publishDraft(user, id(ctx.params.id), body)) });
}

// ---------- images ----------

export async function uploadImage(ctx) {
  const user = await organiser(ctx, { write: true, limit: [40, 600], scope: 'upload' });
  const buf = await readBinaryBody(ctx.req, O.MAX_IMAGE_BYTES);
  const img = await O.addImage(user.id, id(ctx.params.id), buf, ctx.req.headers['content-type']);
  sendJson(ctx.res, 201, { ok: true, image: img });
}

export async function deleteImage(ctx) {
  const user = await organiser(ctx, { write: true });
  await O.removeImage(user.id, id(ctx.params.id), id(ctx.params.image));
  sendJson(ctx.res, 200, { ok: true });
}

export async function serveImage({ req, res, params }) {
  const viewer = await getSessionUser(req).catch(() => null);
  const img = await O.readImage(id(params.id), viewer);
  if (!img) throw new HttpError(404, 'not_found', 'Not found');
  res.statusCode = 200;
  res.setHeader('Content-Type', img.content_type);
  res.setHeader('Content-Length', String(img.bytes.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', img.is_public ? 'public, max-age=86400, immutable' : 'private, no-store');
  res.end(img.bytes);
}

// ---------- organiser events ----------

export async function listEvents(ctx) {
  const user = await organiser(ctx);
  sendJson(ctx.res, 200, { ok: true, events: await O.listOrganiserEvents(user) });
}

export async function eventGuests(ctx) {
  const user = await requireUser(ctx.req);
  const r = await listEventGuests(user, id(ctx.params.id));
  const e = await manageableEvent(user, r.event.id, undefined, { action: 'event.view_guests' });
  const path = `${['weekend_trip', 'resort_getaway'].includes(e.category) ? '/trips' : '/events'}/${e.slug}`;
  sendJson(ctx.res, 200, { ok: true, ...r, event: { ...r.event, path } });
}

async function decide(ctx, decision) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:${user.id}`, 240, 600);
  const r = await decideRequest(user, id(ctx.params.id), decision);
  await afterResponse(() => deliverMany(r.notificationIds || []));
  sendJson(ctx.res, 200, { ok: true, status: r.status });
}
export const approveBooking = (ctx) => decide(ctx, 'approve');
export const declineBooking = (ctx) => decide(ctx, 'decline');

// ---------- guests ----------

export async function bookTicket(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`book:${user.id}`, 10, 600);
  const body = parse(TierBookingBody, await readJson(ctx.req));
  const r = await bookTier(user, id(ctx.params.id), body);
  await afterResponse(() => deliverMany(r.notificationIds || []));
  sendJson(ctx.res, 200, { ok: true, bookingId: r.bookingId, status: r.status, checkoutUrl: r.checkoutUrl || null, existing: Boolean(r.existing) });
}

// ---------- M6 Organiser Workspace & Event Staff API ----------

export async function eventOverview(ctx) {
  const user = await requireUser(ctx.req);
  const overview = await O.getEventOverview(user, id(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true, ...overview });
}

const UpdateEventBody = z.object({
  title: z.string().min(3).max(140).optional(),
  description: z.string().min(10).max(5000).optional(),
  capacity: z.number().int().min(1).max(5000).optional(),
  start_at: z.string().optional(),
  end_at: z.string().nullable().optional(),
  area_public: z.string().max(120).nullable().optional(),
  venue_private: z.string().max(300).nullable().optional(),
  venue_privacy: z.enum(['public', 'disclosed_after_booking']).optional(),
  maps_url: z.string().max(500).nullable().optional(),
  refund_policy: z.string().max(1000).nullable().optional()
}).strict();

export async function updateEvent(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:edit:${user.id}`, 60, 600);
  const body = parse(UpdateEventBody, await readJson(ctx.req));
  const event = await O.updateOrganiserEvent(user, id(ctx.params.id), body);
  sendJson(ctx.res, 200, { ok: true, event });
}

const CancelBody = z.object({
  reason: z.string().min(3).max(500).default('Cancelled by organiser')
}).strict();

export async function cancelEvent(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:cancel:${user.id}`, 20, 600);
  const body = parse(CancelBody, await readJson(ctx.req));
  const r = await O.cancelOrganiserEvent(user, id(ctx.params.id), body);
  sendJson(ctx.res, 200, r);
}

export async function eventInventory(ctx) {
  const user = await requireUser(ctx.req);
  const inv = await O.getEventInventory(user, id(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true, ...inv });
}

export async function eventBookings(ctx) {
  const user = await requireUser(ctx.req);
  const q = ctx.query.get('q') || '';
  const status = ctx.query.get('status') || 'all';
  const page = Math.max(1, parseInt(ctx.query.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(ctx.query.get('limit') || '50', 10) || 50));
  const bookings = await O.listOrganiserBookings(user, id(ctx.params.id), { query: q, status, page, limit });
  sendJson(ctx.res, 200, { ok: true, bookings, page, limit });
}

export async function cancelBooking(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:bkcancel:${user.id}`, 60, 600);
  const body = parse(CancelBody, await readJson(ctx.req));
  const r = await O.cancelOrganiserBooking(user, id(ctx.params.id), body);
  sendJson(ctx.res, 200, r);
}

// ---------- Event Staff Roles & Invitations ----------

export async function eventStaff(ctx) {
  const user = await requireUser(ctx.req);
  const data = await listEventStaff(user, id(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true, ...data });
}

const AssignStaffBody = z.object({
  userId: uuid,
  role: z.enum(['event_manager', 'door_staff', 'guest_list_manager', 'assistant']),
  notes: z.string().max(500).nullable().optional()
}).strict();

export async function assignStaff(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:staff:${user.id}`, 60, 600);
  const body = parse(AssignStaffBody, await readJson(ctx.req));
  const r = await assignEventStaff(user, id(ctx.params.id), body);
  sendJson(ctx.res, 201, r);
}

export async function revokeStaff(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:staff:${user.id}`, 60, 600);
  const r = await revokeEventStaff(user, id(ctx.params.id), id(ctx.params.staffId));
  sendJson(ctx.res, 200, r);
}

const InviteStaffBody = z.object({
  role: z.enum(['event_manager', 'door_staff', 'guest_list_manager', 'assistant']),
  invitedAlias: z.string().max(80).optional(),
  ttlHours: z.number().int().min(1).max(168).default(48)
}).strict();

export async function inviteStaff(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:staff:${user.id}`, 60, 600);
  const body = parse(InviteStaffBody, await readJson(ctx.req));
  const r = await createStaffInvite(user, id(ctx.params.id), body);
  sendJson(ctx.res, 201, r);
}

export async function getStaffInviteHandler(ctx) {
  const invite = await getStaffInvite(ctx.params.token);
  sendJson(ctx.res, 200, { ok: true, invite });
}

const AcceptInviteBody = z.object({
  token: z.string().min(10).max(100)
}).strict();

export async function acceptStaffInviteHandler(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  const body = parse(AcceptInviteBody, await readJson(ctx.req));
  const r = await acceptStaffInvite(user, body.token);
  sendJson(ctx.res, 200, r);
}

// ---------- Event Announcements ----------

export async function eventAnnouncements(ctx) {
  const user = await requireUser(ctx.req);
  const announcements = await listEventAnnouncements(user, id(ctx.params.id));
  sendJson(ctx.res, 200, { ok: true, announcements });
}

const AnnouncementBody = z.object({
  title: z.string().min(3).max(120),
  message: z.string().min(5).max(3000),
  isPinned: z.boolean().default(false),
  notifyAttendees: z.boolean().default(true)
}).strict();

export async function postAnnouncement(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:ann:${user.id}`, 30, 600);
  const body = parse(AnnouncementBody, await readJson(ctx.req));
  const r = await createEventAnnouncement(user, id(ctx.params.id), body);
  sendJson(ctx.res, 201, r);
}

// ---------- Secure QR Ticket Check-In & Verification ----------

const CheckInBody = z.object({
  ticketCode: z.string().max(50).nullable().optional(),
  qrPayload: z.string().max(500).nullable().optional(),
  method: z.enum(['camera_qr', 'manual_lookup', 'manual_override', 'camera', 'manual']).default('camera_qr'),
  scanMethod: z.enum(['camera_qr', 'manual_lookup', 'manual_override', 'camera', 'manual']).optional(),
  overrideReason: z.string().max(500).nullable().optional()
}).strict();

export async function checkInTicketHandler(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`checkin:${user.id}`, 600, 600);
  const body = parse(CheckInBody, await readJson(ctx.req));
  const rawMethod = body.scanMethod || body.method;
  const method = rawMethod === 'camera' ? 'camera_qr' : (rawMethod === 'manual' ? 'manual_lookup' : rawMethod);
  const r = await checkInTicket(user, id(ctx.params.id), { ...body, method });
  sendJson(ctx.res, 200, r);
}

export async function eventScans(ctx) {
  const user = await requireUser(ctx.req);
  const eventId = id(ctx.params.id);
  await authorize(user, 'event.view_audit', { eventId });
  const limit = Math.min(100, Math.max(1, parseInt(ctx.query.get('limit') || '50', 10) || 50));
  const scans = await listEventScans(eventId, limit);
  sendJson(ctx.res, 200, { ok: true, scans });
}

export async function eventAttendance(ctx) {
  const user = await requireUser(ctx.req);
  const eventId = id(ctx.params.id);
  await authorize(user, 'event.view_inventory', { eventId });
  const attendance = await getEventAttendance(eventId);
  sendJson(ctx.res, 200, { ok: true, ...attendance });
}

const ReissueBody = z.object({
  reason: z.string().min(3).max(500).default('reissued_by_host')
}).strict();

export async function reissueTicketHandler(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:reissue:${user.id}`, 30, 600);
  const body = parse(ReissueBody, await readJson(ctx.req));
  const r = await reissueTicket(user, id(ctx.params.id), body.reason);
  sendJson(ctx.res, 200, r);
}

const RevokeTicketBody = z.object({
  reason: z.string().min(3).max(500).default('revoked_by_host')
}).strict();

export async function revokeTicketHandler(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`org:revoke:${user.id}`, 30, 600);
  const body = parse(RevokeTicketBody, await readJson(ctx.req));
  const r = await revokeTicket(user, id(ctx.params.id), body.reason);
  sendJson(ctx.res, 200, r);
}

export async function guestTicket(ctx) {
  const user = await requireUser(ctx.req);
  const tickets = await getBookingTickets(id(ctx.params.id), user);
  sendJson(ctx.res, 200, { ok: true, tickets });
}
