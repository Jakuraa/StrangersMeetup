// lib/handlers/organiser.js - Organiser wizard pages + API, guest booking of ticket tiers, and
// event images. Every organiser endpoint: session → organiser check → ownership (drafts and
// events are looked up by id AND owner, so another organiser's draft is a 404). Every write:
// CSRF + rate limit.
import { HttpError, readJson, readBinaryBody, sendJson, sendHtml } from '../http.js';
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
import { renderOrganiserPage, renderDraftPreview } from '../views/organiser.js';

const id = (v) => {
  if (!uuid.safeParse(v).success) throw new HttpError(404, 'not_found', 'Not found');
  return v;
};

async function organiser(ctx, { write = false, limit = [240, 600] } = {}) {
  const user = await requireUser(ctx.req);
  await O.requireOrganiser(user);
  if (write) {
    requireCsrf(ctx.req, user);
    await rateLimit(`org:${user.id}`, limit[0], limit[1]);
  }
  return user;
}

// ---------- pages ----------

/** Resolve page state without throwing: signed_out | not_organiser | ok. */
async function pageState(req) {
  const user = await getSessionUser(req);
  if (!user) return { state: 'signed_out' };
  if (!(await O.isOrganiser(user))) return { state: 'not_organiser', user };
  return { state: 'ok', user, csrf: csrfTokenFor(user.sessionToken) };
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
  const s = await pageState(req);
  sendHtml(res, 200, renderOrganiserPage({ page: 'manage', ...s, eventId: id(params.id) }), NOINDEX);
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
  const [drafts, events] = await Promise.all([O.listDrafts(user.id), O.listOrganiserEvents(user.id)]);
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
  const user = await organiser(ctx, { write: true, limit: [20, 600] });
  const raw = await readJson(ctx.req);
  if (raw.confirm !== true) throw new HttpError(400, 'confirm_required', 'Publishing needs explicit confirmation.');
  const body = parse(PublishBody, raw);
  sendJson(ctx.res, 200, { ok: true, ...(await O.publishDraft(user, id(ctx.params.id), body)) });
}

// ---------- images ----------

export async function uploadImage(ctx) {
  const user = await organiser(ctx, { write: true, limit: [40, 600] });
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
  sendJson(ctx.res, 200, { ok: true, events: await O.listOrganiserEvents(user.id) });
}

export async function eventGuests(ctx) {
  const user = await requireUser(ctx.req);
  const r = await listEventGuests(user, id(ctx.params.id));
  const e = await manageableEvent(user, r.event.id);
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
