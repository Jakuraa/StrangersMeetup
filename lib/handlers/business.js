// lib/handlers/business.js - Unified Business Command Centre & Self-Service Operations.
// Consolidates Organisers, Venues, Hosts, Suppliers, and Team operations under one workspace.
import { db } from '../db.js';
import { readJson, sendJson, sendHtml, redirect, HttpError } from '../http.js';
import { requireUser, requireCsrf, getSessionUser } from '../session.js';
import { parse, z } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { audit } from '../audit.js';
import { logger } from '../logger.js';
import { renderBusinessDashboard, renderBusinessOnboarding } from '../views/business.js';
import { createBusinessWorkspace } from '../services/member-onboarding.js';
import { scanMediaCleanupCandidates } from '../services/media-lifecycle.js';

export async function getBusinessWorkspace(userId) {
  const ws = (await db.query(
    `SELECT w.*, o.name AS org_name, m.role AS user_role
       FROM business_workspaces w
       JOIN organisations o ON o.id = w.org_id
       JOIN org_memberships m ON m.org_id = w.org_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY w.created_at ASC
      LIMIT 1`,
    [userId]
  )).rows[0];
  return ws || null;
}

/** Legacy form redirect: /become-a-host, /list-your-venue, /partner-with-us -> self-service onboarding. */
export async function legacyApplicationRedirect({ res, pathname }) {
  const clean = pathname.replace(/\/$/, '');
  let type = 'organiser';
  if (clean === '/list-your-venue') type = 'venue';
  if (clean === '/become-a-host') type = 'host';
  if (clean === '/partner-with-us') type = 'supplier';
  redirect(res, `/business/new?type=${type}`);
}

/** GET /business — Main Unified Business Command Centre. */
export async function businessDashboardPage({ req, res }) {
  const user = await getSessionUser(req).catch(() => null);
  if (!user) {
    return redirect(res, `/signin?next=${encodeURIComponent('/business')}`);
  }

  const workspace = await getBusinessWorkspace(user.id);
  if (!workspace) {
    return redirect(res, '/business/new');
  }

  const csrf = user.sessionToken ? 'valid' : '';
  sendHtml(res, 200, renderBusinessDashboard({ user, workspace, csrf }));
}

/** GET /business/new — Self-service Business workspace onboarding page. */
export async function businessOnboardingPage({ req, res, query }) {
  const user = await getSessionUser(req).catch(() => null);
  if (!user) {
    return redirect(res, `/signin?next=${encodeURIComponent('/business/new')}`);
  }

  const initialType = query.get('type') || 'organiser';
  sendHtml(res, 200, renderBusinessOnboarding({ user, initialType }));
}

/** GET /api/business/overview — Telemetry and operational summary for business dashboard. */
export async function getOverviewApi({ req, res }) {
  const user = await requireUser(req);
  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  // Upcoming events
  const { rows: events } = await db.query(
    `SELECT e.id, e.slug, e.title, e.category, e.start_at, e.end_at, e.status, e.city,
            e.capacity, e.ticket_price_paise, e.is_archived, e.media_cleaned_up,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status IN ('confirmed', 'checked_in')) AS confirmed_attendees,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'pending_payment') AS pending_approvals
       FROM events e
      WHERE (e.organiser_org_id = $1 OR e.organiser_user_id = $2) AND COALESCE(e.is_deleted, false) = false
      ORDER BY e.start_at DESC
      LIMIT 10`,
    [ws.org_id, user.id]
  );

  // Recent bookings across all business events
  const { rows: recentBookings } = await db.query(
    `SELECT b.id, b.status, b.created_at, b.amount_paise,
            e.title AS event_title, e.start_at AS event_start,
            u.display_name AS guest_name
       FROM bookings b
       JOIN events e ON e.id = b.event_id
       LEFT JOIN users u ON u.id = b.user_id
      WHERE (e.organiser_org_id = $1 OR e.organiser_user_id = $2)
      ORDER BY b.created_at DESC
      LIMIT 10`,
    [ws.org_id, user.id]
  );

  // Venues linked to workspace
  const { rows: venues } = await db.query(
    `SELECT id, name, status, capacity, city_id, address_public FROM venues WHERE org_id = $1 AND status = 'active' AND onboarding_completed = true`,
    [ws.org_id]
  );

  // Pending venue enquiries
  const { rows: enquiries } = await db.query(
    `SELECT en.*, v.name AS venue_name
       FROM venue_enquiries en
       JOIN venues v ON v.id = en.venue_id
      WHERE v.org_id = $1 AND en.status = 'pending' AND v.status = 'active' AND v.onboarding_completed = true
      ORDER BY en.created_at DESC
      LIMIT 5`,
    [ws.org_id]
  );

  sendJson(res, 200, {
    ok: true,
    workspace: ws,
    metrics: {
      totalEvents: events.length,
      upcomingEvents: events.filter((e) => new Date(e.start_at) >= new Date() && e.status === 'published').length,
      totalVenues: venues.length,
      pendingEnquiries: enquiries.length
    },
    events,
    recentBookings,
    venues,
    enquiries
  });
}

/** GET /api/business/events — List business events with filters. */
export async function listEventsApi({ req, res }) {
  const user = await requireUser(req);
  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const { rows: events } = await db.query(
    `SELECT e.*,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status IN ('confirmed', 'checked_in')) AS confirmed_attendees,
            (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'pending_payment') AS pending_approvals,
            c.reason AS cancellation_reason, c.created_at AS cancelled_at
       FROM events e
       LEFT JOIN event_cancellations c ON c.event_id = e.id
      WHERE (e.organiser_org_id = $1 OR e.organiser_user_id = $2) AND COALESCE(e.is_deleted, false) = false
      ORDER BY e.start_at DESC`,
    [ws.org_id, user.id]
  );

  sendJson(res, 200, { ok: true, events });
}

/** POST /api/business/events/:id/duplicate — Duplicate an existing event as draft. */
export async function duplicateEventApi({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const eventId = params.id;
  const original = (await db.query(
    `SELECT * FROM events WHERE id = $1 AND (organiser_user_id = $2 OR organiser_org_id IN (
       SELECT org_id FROM org_memberships WHERE user_id = $2 AND status = 'active'
     ))`,
    [eventId, user.id]
  )).rows[0];

  if (!original) throw new HttpError(404, 'not_found', 'Event not found');

  const newSlug = `${original.slug}-copy-${Date.now().toString(36)}`;
  const newTitle = `Copy of ${original.title}`.slice(0, 160);

  const duplicate = (await db.query(
    `INSERT INTO events (
       organiser_user_id, organiser_org_id, venue_id, slug, title, description,
       category, start_at, end_at, capacity, ticket_price_paise, price_status, features, city,
       venue_private, ticketing, requires_approval, booking_questions, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::event_category, $8, $9, $10, $11, $12::price_status, $13::jsonb, $14, $15, $16, $17, $18::jsonb, 'draft')
     RETURNING *`,
    [
      user.id,
      original.organiser_org_id,
      original.venue_id,
      newSlug,
      newTitle,
      original.description,
      original.category,
      original.start_at,
      original.end_at,
      original.capacity,
      original.ticket_price_paise || null,
      original.ticket_price_paise ? 'set' : 'tbd',
      JSON.stringify(original.features || {}),
      original.city,
      original.venue_private || original.area_public || 'Secret Venue',
      original.ticketing || 'single',
      Boolean(original.requires_approval),
      JSON.stringify(original.booking_questions || []),
    ]
  )).rows[0];

  await audit(user.alias || user.id, 'event.duplicate', duplicate.id, { originalId: eventId });
  sendJson(res, 201, { ok: true, event: duplicate });
}

const CancelEventBody = z.object({
  reason: z.string().min(5).max(1000),
  refundNotes: z.string().max(1000).optional()
}).strict();

/** POST /api/business/events/:id/cancel — Explicit event cancellation with mandatory reason. */
export async function cancelEventApi({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const eventId = params.id;
  const body = parse(CancelEventBody, await readJson(req));

  const result = await db.tx(async (client) => {
    const event = (await client.query(
      `SELECT e.id, e.title, e.status, e.start_at
         FROM events e
        WHERE e.id = $1 AND (e.organiser_user_id = $2 OR e.organiser_org_id IN (
          SELECT org_id FROM org_memberships WHERE user_id = $2 AND status = 'active'
        )) FOR UPDATE`,
      [eventId, user.id]
    )).rows[0];

    if (!event) throw new HttpError(404, 'not_found', 'Event not found');
    if (event.status === 'cancelled') {
      throw new HttpError(409, 'already_cancelled', 'Event is already cancelled');
    }

    // 1. Update event status
    await client.query(`UPDATE events SET status = 'cancelled' WHERE id = $1`, [eventId]);

    // 2. Count affected attendees
    const attendees = (await client.query(
      `SELECT count(*)::int AS count FROM bookings WHERE event_id = $1 AND status IN ('confirmed', 'pending_payment')`,
      [eventId]
    )).rows[0];
    const attendeeCount = attendees ? Number(attendees.count) : 0;

    // 3. Record cancellation audit record
    await client.query(
      `INSERT INTO event_cancellations (event_id, cancelled_by_user_id, reason, refund_notes, attendee_count_notified)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event_id) DO UPDATE SET
         reason = EXCLUDED.reason,
         refund_notes = EXCLUDED.refund_notes`,
      [eventId, user.id, body.reason, body.refundNotes || null, attendeeCount]
    );

    // 4. Record immutable system audit
    await audit(user.alias || user.id, 'event.cancel', eventId, {
      reason: body.reason,
      attendeeCount
    }, client);

    logger.info('event cancelled', { eventId, reason: body.reason, attendeeCount });
    return { cancelled: true, attendeeCount };
  });

  sendJson(res, 200, { ok: true, ...result });
}

/** DELETE /api/business/events/:id — Soft-delete event with dependency safeguards. */
export async function deleteEventApi({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const eventId = params.id;
  await db.tx(async (client) => {
    const event = (await client.query(
      `SELECT e.id, e.title, e.status
         FROM events e
        WHERE e.id = $1 AND (e.organiser_user_id = $2 OR e.organiser_org_id IN (
          SELECT org_id FROM org_memberships WHERE user_id = $2 AND status = 'active'
        )) FOR UPDATE`,
      [eventId, user.id]
    )).rows[0];

    if (!event) throw new HttpError(404, 'not_found', 'Event not found');

    // Dependency check: prevent deletion if active paid bookings exist without refund
    const unsettled = (await client.query(
      `SELECT count(*)::int AS cnt FROM bookings WHERE event_id = $1 AND status = 'confirmed'`,
      [eventId]
    )).rows[0];

    if (unsettled && Number(unsettled.cnt) > 0 && event.status !== 'cancelled') {
      throw new HttpError(409, 'unsettled_bookings', 'Cannot delete event with confirmed bookings. Please cancel the event first.');
    }

    // Soft delete
    await client.query(
      `UPDATE events SET is_deleted = true, deleted_at = now() WHERE id = $1`,
      [eventId]
    );

    await audit(user.alias || user.id, 'event.delete', eventId, { title: event.title }, client);
  });

  sendJson(res, 200, { ok: true, deleted: true });
}

/** GET /api/business/media/cleanup-preview?eventId=... — Inspect reclaimable media before deletion. */
export async function getCleanupPreviewApi({ req, res, query }) {
  const user = await requireUser(req);
  const eventId = query.get('eventId');
  if (!eventId) throw new HttpError(400, 'validation', 'eventId is required');

  const { rows: images } = await db.query(
    `SELECT img.id, img.byte_size, img.content_type, img.created_at, e.title, e.status, e.start_at
       FROM event_images img
       JOIN events e ON (e.draft_id = img.draft_id OR e.gallery @> jsonb_build_array('/media/event-images/' || img.id::text))
      WHERE e.id = $1 AND (e.organiser_user_id = $2 OR e.organiser_org_id IN (
        SELECT org_id FROM org_memberships WHERE user_id = $2 AND status = 'active'
      ))`,
    [eventId, user.id]
  );

  const totalBytes = images.reduce((acc, img) => acc + Number(img.byte_size || 0), 0);

  sendJson(res, 200, {
    ok: true,
    eventId,
    imageCount: images.length,
    reclaimableBytes: totalBytes,
    images: images.map((i) => ({ id: i.id, byteSize: i.byte_size, contentType: i.content_type }))
  });
}

/** POST /api/business/media/cleanup-now — On-demand media cleanup triggered by authorized business owner. */
export async function runCleanupNowApi({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const body = parse(z.object({ eventId: z.string().uuid() }).strict(), await readJson(req));
  const eventId = body.eventId;

  const result = await db.tx(async (client) => {
    const event = (await client.query(
      `SELECT e.id, e.title, e.status
         FROM events e
        WHERE e.id = $1 AND (e.organiser_user_id = $2 OR e.organiser_org_id IN (
          SELECT org_id FROM org_memberships WHERE user_id = $2 AND status = 'active'
        )) FOR UPDATE`,
      [eventId, user.id]
    )).rows[0];

    if (!event) throw new HttpError(404, 'not_found', 'Event not found');

    const { rows: images } = await client.query(
      `SELECT img.id, img.byte_size
         FROM event_images img
         JOIN events e ON (e.draft_id = img.draft_id OR e.gallery @> jsonb_build_array('/media/event-images/' || img.id::text))
        WHERE e.id = $1`,
      [eventId]
    );

    let deletedCount = 0;
    let deletedBytes = 0;

    for (const img of images) {
      const del = await client.query('DELETE FROM event_images WHERE id = $1', [img.id]);
      if (del.rowCount > 0) {
        deletedCount++;
        deletedBytes += Number(img.byte_size || 0);
      }
    }

    await client.query(
      `UPDATE events SET media_cleaned_up = true, media_cleaned_up_at = now() WHERE id = $1`,
      [eventId]
    );

    await client.query(
      `INSERT INTO media_cleanup_jobs (job_type, event_id, initiated_by_user_id, status, items_scanned, items_deleted, bytes_reclaimed)
       VALUES ('manual_event', $1, $2, 'completed', $3, $4, $5)`,
      [eventId, user.id, images.length, deletedCount, deletedBytes]
    );

    await audit(user.alias || user.id, 'media.cleanup_manual', eventId, {
      deletedCount,
      deletedBytes
    }, client);

    logger.info('manual media cleanup completed', { eventId, deletedCount, deletedBytes });
    return { deletedCount, deletedBytes };
  });

  sendJson(res, 200, { ok: true, ...result });
}

/** GET /api/business/venues — List venues managed by workspace. */
export async function listVenuesApi({ req, res }) {
  const user = await requireUser(req);
  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const { rows: venues } = await db.query(
    `SELECT v.*, count(e.id)::int AS linked_events_count
       FROM venues v
       LEFT JOIN events e ON e.venue_id = v.id AND NOT e.is_deleted
      WHERE v.org_id = $1
      GROUP BY v.id
      ORDER BY v.created_at DESC`,
    [ws.org_id]
  );

  sendJson(res, 200, { ok: true, venues });
}

const CreateVenueBody = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  city: z.string().max(100).optional(),
  addressPublic: z.string().max(300).optional(),
  capacity: z.number().int().min(1).max(10000).optional(),
  contactEmail: z.string().email().max(160).optional(),
  contactPhone: z.string().max(30).optional()
}).strict();

/** POST /api/business/venues — Self-service venue creation. */
export async function createVenueApi({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const p = parse(CreateVenueBody, await readJson(req));
  const venue = (await db.query(
    `INSERT INTO venues (org_id, name, description, address_public, capacity, contact_email, contact_phone, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
     RETURNING *`,
    [ws.org_id, p.name.trim(), p.description || null, p.addressPublic || p.city || null, p.capacity || null, p.contactEmail || null, p.contactPhone || null]
  )).rows[0];

  sendJson(res, 201, { ok: true, venue });
}

/** PATCH /api/business/venues/:id — Update venue profile. */
export async function updateVenueApi({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const venueId = params.id;
  const p = parse(CreateVenueBody.partial(), await readJson(req));

  const venue = (await db.query(
    `UPDATE venues SET
       name = COALESCE($3, name),
       description = COALESCE($4, description),
       address_public = COALESCE($5, address_public),
       capacity = COALESCE($6, capacity),
       contact_email = COALESCE($7, contact_email),
       contact_phone = COALESCE($8, contact_phone),
       updated_at = now()
     WHERE id = $1 AND org_id = $2
     RETURNING *`,
    [venueId, ws.org_id, p.name?.trim(), p.description, p.addressPublic, p.capacity, p.contactEmail, p.contactPhone]
  )).rows[0];

  if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');
  sendJson(res, 200, { ok: true, venue });
}

/** GET /api/business/team — List team members and roles. */
export async function listTeamApi({ req, res }) {
  const user = await requireUser(req);
  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const { rows: members } = await db.query(
    `SELECT m.id, m.role, m.status, m.created_at,
            u.id AS user_id, u.display_name, u.alias
       FROM org_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY m.created_at ASC`,
    [ws.org_id]
  );

  sendJson(res, 200, { ok: true, members });
}

/** GET /api/business/suppliers — List suppliers and service categories. */
export async function listSuppliersApi({ req, res }) {
  const user = await requireUser(req);
  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const { rows: suppliers } = await db.query(
    `SELECT * FROM business_suppliers WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [ws.id]
  );

  sendJson(res, 200, { ok: true, suppliers });
}

const CreateSupplierBody = z.object({
  category: z.string().min(1).max(80),
  portfolioUrls: z.array(z.string().url()).max(10).optional(),
  serviceAreas: z.array(z.string().max(80)).max(20).optional(),
  pricingNotes: z.string().max(500).optional()
}).strict();

/** POST /api/business/suppliers — Create supplier listing. */
export async function createSupplierApi({ req, res }) {
  const user = await requireUser(req);
  requireCsrf(req, user);

  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const p = parse(CreateSupplierBody, await readJson(req));
  const supplier = (await db.query(
    `INSERT INTO business_suppliers (workspace_id, category, portfolio_urls, service_areas, pricing_notes, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING *`,
    [ws.id, p.category, p.portfolioUrls || [], p.serviceAreas || [], p.pricingNotes || null]
  )).rows[0];

  sendJson(res, 201, { ok: true, supplier });
}

/** GET /api/business/analytics — Business analytics (views, bookings, attendance). */
export async function getAnalyticsApi({ req, res }) {
  const user = await requireUser(req);
  const ws = await getBusinessWorkspace(user.id);
  if (!ws) throw new HttpError(404, 'workspace_not_found', 'No business workspace found');

  const { rows: analytics } = await db.query(
    `SELECT e.id AS event_id, e.title, e.start_at,
            count(b.id)::int AS total_bookings,
            sum(CASE WHEN b.status = 'checked_in' THEN 1 ELSE 0 END)::int AS attended_count,
            sum(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END)::int AS confirmed_count,
            sum(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END)::int AS cancelled_count
       FROM events e
       LEFT JOIN bookings b ON b.event_id = e.id
      WHERE (e.organiser_org_id = $1 OR e.organiser_user_id = $2) AND COALESCE(e.is_deleted, false) = false
      GROUP BY e.id, e.title, e.start_at
      ORDER BY e.start_at DESC
      LIMIT 20`,
    [ws.org_id, user.id]
  );

  sendJson(res, 200, { ok: true, analytics });
}
