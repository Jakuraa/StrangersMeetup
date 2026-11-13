// lib/handlers/venue.js - Venue Owner Dashboard page and API endpoints.
// Strict access control: every API verifies session and venue ownership via lib/services/venue.js.
// State-changing requests enforce CSRF tokens and rate limiting.
import { HttpError, readJson, sendJson, sendHtml } from '../http.js';
import { getSessionUser, requireUser, requireCsrf, csrfTokenFor } from '../session.js';
import { parse, z, uuid } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { renderVenuePage } from '../views/venue.js';
import * as V from '../services/venue.js';

const uuidParam = (v) => {
  if (!uuid.safeParse(v).success) throw new HttpError(404, 'not_found', 'Invalid identifier');
  return v;
};

async function writer(ctx) {
  const user = await requireUser(ctx.req);
  requireCsrf(ctx.req, user);
  await rateLimit(`venue:${user.id}`, 60, 600);
  return user;
}

// ---------- Pages ----------

export async function venuePage(ctx) {
  const user = await getSessionUser(ctx.req).catch(() => null);
  if (!user) {
    const html = renderVenuePage({ state: 'signed_out' });
    return sendHtml(ctx.res, 200, html, { cache: 'no-store' });
  }

  const isOperator = await V.isVenueOperator(user);
  const csrf = csrfTokenFor(user.sessionToken);

  if (!isOperator) {
    const html = renderVenuePage({ state: 'onboarding', user, csrf });
    return sendHtml(ctx.res, 200, html, { cache: 'no-store' });
  }

  const html = renderVenuePage({ state: 'ok', user, csrf });
  return sendHtml(ctx.res, 200, html, { cache: 'no-store' });
}

// ---------- Context & Profile API ----------

export async function venueContextApi(ctx) {
  const user = await requireUser(ctx.req);
  const requestedVenueId = ctx.query?.get?.('venueId') || null;
  const context = await V.getVenueContext(user, requestedVenueId);
  sendJson(ctx.res, 200, { ok: true, context });
}

export async function venueProfileApi(ctx) {
  const user = await requireUser(ctx.req);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const profile = await V.getVenueProfile(venueId, user);
  sendJson(ctx.res, 200, { ok: true, profile });
}

const VenueProfilePatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  capacity: z.number().int().positive().max(100_000).nullable().optional(),
  address_public: z.string().trim().max(300).nullable().optional(),
  address_private: z.string().trim().max(500).nullable().optional(),
  city_id: z.string().uuid().nullable().optional(),
  locality_id: z.string().uuid().nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  description: z.string().trim().max(3000).nullable().optional(),
  photos: z.array(z.union([z.string().url(), z.object({ url: z.string().url(), caption: z.string().optional() })])).max(20).optional(),
  facilities: z.array(z.string().trim().max(60)).max(30).optional(),
  operating_hours: z.record(z.string()).optional(),
  contact_name: z.string().trim().max(120).nullable().optional(),
  contact_phone: z.string().trim().max(30).nullable().optional(),
  contact_email: z.string().trim().email().nullable().optional(),
  rules: z.string().trim().max(2000).nullable().optional()
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

export async function updateVenueProfileApi(ctx) {
  const user = await writer(ctx);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const body = parse(VenueProfilePatch, await readJson(ctx.req));
  const updated = await V.updateVenueProfile(venueId, user, body);
  sendJson(ctx.res, 200, { ok: true, venue: updated });
}

// ---------- Events & Analytics API ----------

export async function venueEventsApi(ctx) {
  const user = await requireUser(ctx.req);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const filter = ctx.query?.get?.('filter') || 'all';
  const events = await V.getVenueEvents(venueId, user, { filter });
  sendJson(ctx.res, 200, { ok: true, events });
}

export async function venueAnalyticsApi(ctx) {
  const user = await requireUser(ctx.req);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const analytics = await V.getVenueAnalytics(venueId, user);
  sendJson(ctx.res, 200, { ok: true, analytics });
}

// ---------- Enquiries API ----------

export async function venueEnquiriesApi(ctx) {
  const user = await requireUser(ctx.req);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const status = ctx.query?.get?.('status') || 'all';
  const enquiries = await V.getVenueEnquiries(venueId, user, { status });
  sendJson(ctx.res, 200, { ok: true, enquiries });
}

const CreateEnquiryBody = z.object({
  requester_name: z.string().trim().min(2).max(120),
  requester_email: z.string().trim().email().max(160).nullable().optional(),
  requester_phone: z.string().trim().max(30).nullable().optional(),
  event_name: z.string().trim().min(2).max(160),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD required'),
  start_time: z.string().trim().max(30).optional(),
  end_time: z.string().trim().max(30).optional(),
  expected_guests: z.number().int().positive().max(50_000).default(50),
  budget_notes: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional()
}).strict();

export async function createVenueEnquiryApi(ctx) {
  const user = await getSessionUser(ctx.req).catch(() => null);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  await rateLimit(`enquiry:${ctx.ip}`, 20, 3600);
  const body = parse(CreateEnquiryBody, await readJson(ctx.req));
  const enquiry = await V.createVenueEnquiry(venueId, body, user);
  sendJson(ctx.res, 201, { ok: true, enquiry });
}

const DecideEnquiryBody = z.object({
  action: z.enum(['approve', 'decline']),
  reason: z.string().trim().max(500).optional()
}).strict();

export async function decideVenueEnquiryApi(ctx) {
  const user = await writer(ctx);
  const enquiryId = uuidParam(ctx.params.id);
  const body = parse(DecideEnquiryBody, await readJson(ctx.req));
  const enquiry = await V.decideVenueEnquiry(enquiryId, user, body);
  sendJson(ctx.res, 200, { ok: true, enquiry });
}

// ---------- Staff Coordination API ----------

export async function venueStaffApi(ctx) {
  const user = await requireUser(ctx.req);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const staff = await V.getVenueStaff(venueId, user);
  sendJson(ctx.res, 200, { ok: true, staff });
}

const AddStaffBody = z.object({
  telegram_user_id: z.coerce.number().int().positive(),
  role: z.enum(['admin', 'manager', 'staff'])
}).strict();

export async function addVenueStaffApi(ctx) {
  const user = await writer(ctx);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const body = parse(AddStaffBody, await readJson(ctx.req));
  const result = await V.addVenueStaff(venueId, user, body);
  sendJson(ctx.res, 200, result);
}

const UpdateStaffBody = z.object({
  role: z.enum(['admin', 'manager', 'staff']).optional(),
  status: z.enum(['active', 'revoked']).optional()
}).strict().refine((b) => b.role || b.status, { message: 'Nothing to change' });

export async function updateVenueStaffApi(ctx) {
  const user = await writer(ctx);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const memberId = uuidParam(ctx.params.memberId);
  const body = parse(UpdateStaffBody, await readJson(ctx.req));
  const result = await V.updateVenueStaff(venueId, user, memberId, body);
  sendJson(ctx.res, 200, result);
}

// ---------- Safety & Incident Reports API ----------

export async function venueReportsApi(ctx) {
  const user = await requireUser(ctx.req);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const reports = await V.getVenueReports(venueId, user);
  sendJson(ctx.res, 200, { ok: true, reports });
}

const SubmitReportBody = z.object({
  category: z.string().trim().min(2).max(60),
  body: z.string().trim().min(5).max(3000),
  event_id: z.string().uuid().nullable().optional()
}).strict();

export async function submitVenueReportApi(ctx) {
  const user = await writer(ctx);
  const venueId = uuidParam(ctx.query?.get?.('venueId'));
  const body = parse(SubmitReportBody, await readJson(ctx.req));
  const report = await V.submitVenueReport(venueId, user, body);
  sendJson(ctx.res, 201, { ok: true, report });
}

// ---------- Application API ----------

const ApplyVenueBody = z.object({
  name: z.string().trim().min(2).max(120),
  venue_name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().max(30).optional(),
  city: z.string().trim().min(2).max(80),
  area: z.string().trim().max(120).optional(),
  capacity: z.coerce.number().int().min(1).max(50_000).optional(),
  facilities: z.array(z.string().trim()).optional(),
  message: z.string().trim().max(2000).optional()
}).strict();

export async function applyVenueApi(ctx) {
  const user = await writer(ctx);
  const body = parse(ApplyVenueBody, await readJson(ctx.req));
  const lead = await V.applyForVenue(user, body);
  sendJson(ctx.res, 201, { ok: true, message: 'Application submitted for review', leadId: lead.id });
}
