// lib/services/venue.js - Core business logic and data access for the Venue Owner Dashboard.
// Enforces strict ownership checks via can() and authorize(). Protects attendee PII by
// aggregating attendance and never returning individual attendee guest lists.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { can, authorize } from './permissions.js';
import { audit } from '../audit.js';

export const VENUE_FACILITIES = [
  { id: 'sound_system', label: 'Sound & DJ Console', icon: '🔊' },
  { id: 'air_conditioning', label: 'Air Conditioning', icon: '❄️' },
  { id: 'bar_license', label: 'Full Bar / Liquor License', icon: '🍸' },
  { id: 'valet_parking', label: 'Valet / Dedicated Parking', icon: '🚗' },
  { id: 'wheelchair_accessible', label: 'Wheelchair Accessible', icon: '♿' },
  { id: 'projector_av', label: 'Projector & AV Screens', icon: '📽️' },
  { id: 'security_bouncers', label: 'Dedicated Security / Bouncers', icon: '🛡️' },
  { id: 'green_room', label: 'Artist Green Room / Backstage', icon: '🎭' },
  { id: 'outdoor_terrace', label: 'Open-Air Terrace / Rooftop', icon: '🌆' },
  { id: 'food_catering', label: 'Kitchen / In-House Catering', icon: '🍽️' },
  { id: 'smoking_zone', label: 'Designated Smoking Zone', icon: '🚬' },
  { id: 'wifi_highspeed', label: 'High-Speed Wi-Fi', icon: '📶' }
];

/**
 * Returns whether user is an active venue operator (or super admin).
 */
export async function isVenueOperator(user, c = db) {
  if (!user?.id) return false;
  if (user.telegram_user_id) {
    const admin = (await c.query(
      `SELECT role FROM admin_users WHERE telegram_user_id = $1 AND active`,
      [user.telegram_user_id]
    )).rows[0];
    if (admin?.role === 'super_admin' || admin?.role === 'event_manager') return true;
  }
  const row = (await c.query(
    `SELECT 1 FROM org_memberships m
       JOIN organisations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
        AND o.kind = 'venue_operator' LIMIT 1`,
    [user.id]
  )).rows[0];
  return Boolean(row);
}

/**
 * Resolves venue context for the authenticated user.
 */
export async function getVenueContext(user, requestedVenueId = null, c = db) {
  if (!user?.id) throw new HttpError(401, 'unauthorized', 'Please sign in');

  // Check if platform admin
  let isSuperAdmin = false;
  if (user.telegram_user_id) {
    const a = (await c.query('SELECT role FROM admin_users WHERE telegram_user_id = $1 AND active', [user.telegram_user_id])).rows[0];
    if (a?.role === 'super_admin') isSuperAdmin = true;
  }

  // Get all venue operator organisations user belongs to
  let orgRows = [];
  if (isSuperAdmin) {
    orgRows = (await c.query(
      `SELECT o.id, o.name, o.kind, o.status, o.verified_at, 'owner'::org_role AS role
         FROM organisations o WHERE o.kind = 'venue_operator' AND o.status = 'active'
        ORDER BY o.name`
    )).rows;
  } else {
    orgRows = (await c.query(
      `SELECT o.id, o.name, o.kind, o.status, o.verified_at, m.role
         FROM org_memberships m
         JOIN organisations o ON o.id = m.org_id
        WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
          AND o.kind = 'venue_operator'
        ORDER BY o.name`,
      [user.id]
    )).rows;
  }

  const orgIds = orgRows.map((o) => o.id);
  let venues = [];
  if (orgIds.length > 0) {
    const vRes = await c.query(
      `SELECT v.id, v.org_id, v.name, v.capacity, v.status, v.address_public, v.address_private,
              v.city_id, c.name AS city_name, v.locality_id, l.name AS locality_name,
              v.photos, v.facilities, v.operating_hours, v.contact_name, v.contact_phone, v.contact_email,
              v.created_at, o.name AS org_name, o.verified_at IS NOT NULL AS org_verified
         FROM venues v
         JOIN organisations o ON o.id = v.org_id
         LEFT JOIN location_cities c ON c.id = v.city_id
         LEFT JOIN location_localities l ON l.id = v.locality_id
        WHERE v.org_id = ANY($1::uuid[]) AND v.status = 'active'
        ORDER BY v.name`,
      [orgIds]
    );
    venues = vRes.rows;
  }

  // Check for any submitted applications / leads by this user
  const leadsRes = await c.query(
    `SELECT id, type, payload, status, created_at, updated_at
       FROM leads
      WHERE type = 'venue'
        AND (payload->>'user_id' = $1 OR payload->>'email' = $2)
      ORDER BY created_at DESC LIMIT 5`,
    [user.id, user.email || '']
  );
  const applications = leadsRes.rows.map((l) => ({
    id: l.id,
    venueName: l.payload?.venue_name || l.payload?.name || 'Venue Application',
    city: l.payload?.city || '',
    area: l.payload?.area || '',
    status: l.status,
    submittedAt: l.created_at,
    updatedAt: l.updated_at
  }));

  const hasVenue = venues.length > 0;
  if (!hasVenue) {
    return {
      hasVenue: false,
      userRole: null,
      orgs: [],
      venues: [],
      activeVenueId: null,
      activeVenue: null,
      permissions: {},
      applications
    };
  }

  // Determine active venue
  let activeVenue = null;
  if (requestedVenueId) {
    activeVenue = venues.find((v) => v.id === requestedVenueId);
  }
  if (!activeVenue) {
    activeVenue = venues[0];
  }

  const activeOrg = orgRows.find((o) => o.id === activeVenue.org_id);
  const userRole = activeOrg?.role || (isSuperAdmin ? 'owner' : null);

  const [canManage, canManageEnquiries, canViewAnalytics, canViewEvents, canManageStaff] = await Promise.all([
    can(user, 'venue.manage', { venueId: activeVenue.id }, c),
    can(user, 'venue.manage_enquiries', { venueId: activeVenue.id }, c),
    can(user, 'venue.view_analytics', { venueId: activeVenue.id }, c),
    can(user, 'venue.view_events', { venueId: activeVenue.id }, c),
    can(user, 'org.manage_members', { orgId: activeVenue.org_id }, c)
  ]);

  return {
    hasVenue: true,
    userRole,
    orgs: orgRows.map((o) => ({
      id: o.id,
      name: o.name,
      role: o.role,
      verified: Boolean(o.verified_at)
    })),
    venues: venues.map((v) => ({
      id: v.id,
      orgId: v.org_id,
      name: v.name,
      capacity: v.capacity,
      cityName: v.city_name,
      localityName: v.locality_name,
      status: v.status
    })),
    activeVenueId: activeVenue.id,
    activeVenue: {
      id: activeVenue.id,
      orgId: activeVenue.org_id,
      orgName: activeVenue.org_name,
      orgVerified: activeVenue.org_verified,
      name: activeVenue.name,
      capacity: activeVenue.capacity,
      cityId: activeVenue.city_id,
      cityName: activeVenue.city_name,
      localityId: activeVenue.locality_id,
      localityName: activeVenue.locality_name,
      addressPublic: activeVenue.address_public,
      addressPrivate: activeVenue.address_private,
      photos: activeVenue.photos || [],
      facilities: activeVenue.facilities || [],
      operatingHours: activeVenue.operating_hours || {},
      contactName: activeVenue.contact_name,
      contactPhone: activeVenue.contact_phone,
      contactEmail: activeVenue.contact_email,
      status: activeVenue.status
    },
    permissions: {
      canManage,
      canManageEnquiries,
      canViewAnalytics,
      canViewEvents,
      canManageStaff
    },
    applications
  };
}

/**
 * Gets full venue profile details.
 */
export async function getVenueProfile(venueId, user, c = db) {
  await authorize(user, 'venue.view', { venueId }, c);
  const row = (await c.query(
    `SELECT v.*, o.name AS org_name, o.verified_at IS NOT NULL AS org_verified,
            c.name AS city_name, l.name AS locality_name
       FROM venues v
       JOIN organisations o ON o.id = v.org_id
       LEFT JOIN location_cities c ON c.id = v.city_id
       LEFT JOIN location_localities l ON l.id = v.locality_id
      WHERE v.id = $1`,
    [venueId]
  )).rows[0];

  if (!row) throw new HttpError(404, 'not_found', 'Venue not found');

  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    orgVerified: row.org_verified,
    name: row.name,
    capacity: row.capacity,
    cityId: row.city_id,
    cityName: row.city_name,
    localityId: row.locality_id,
    localityName: row.locality_name,
    addressPublic: row.address_public,
    addressPrivate: row.address_private,
    lat: row.lat,
    lng: row.lng,
    description: row.description,
    photos: row.photos || [],
    facilities: row.facilities || [],
    operatingHours: row.operating_hours || {},
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    rules: row.rules,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Updates venue profile and operational settings.
 */
export async function updateVenueProfile(venueId, user, patch, c = db) {
  return await c.tx(async (tx) => {
    await authorize(user, 'venue.manage_details', { venueId }, tx);
    const cur = (await tx.query('SELECT * FROM venues WHERE id = $1 FOR UPDATE', [venueId])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Venue not found');

    const next = {
      name: patch.name !== undefined ? patch.name : cur.name,
      capacity: patch.capacity !== undefined ? patch.capacity : cur.capacity,
      city_id: patch.city_id !== undefined ? patch.city_id : cur.city_id,
      locality_id: patch.locality_id !== undefined ? patch.locality_id : cur.locality_id,
      address_public: patch.address_public !== undefined ? patch.address_public : cur.address_public,
      address_private: patch.address_private !== undefined ? patch.address_private : cur.address_private,
      lat: patch.lat !== undefined ? patch.lat : cur.lat,
      lng: patch.lng !== undefined ? patch.lng : cur.lng,
      description: patch.description !== undefined ? patch.description : cur.description,
      photos: patch.photos !== undefined ? JSON.stringify(patch.photos) : JSON.stringify(cur.photos || []),
      facilities: patch.facilities !== undefined ? JSON.stringify(patch.facilities) : JSON.stringify(cur.facilities || []),
      operating_hours: patch.operating_hours !== undefined ? JSON.stringify(patch.operating_hours) : JSON.stringify(cur.operating_hours || {}),
      contact_name: patch.contact_name !== undefined ? patch.contact_name : cur.contact_name,
      contact_phone: patch.contact_phone !== undefined ? patch.contact_phone : cur.contact_phone,
      contact_email: patch.contact_email !== undefined ? patch.contact_email : cur.contact_email,
      rules: patch.rules !== undefined ? patch.rules : cur.rules
    };

    const updated = (await tx.query(
      `UPDATE venues
          SET name = $2, capacity = $3, city_id = $4, locality_id = $5,
              address_public = $6, address_private = $7, lat = $8, lng = $9,
              description = $10, photos = $11::jsonb, facilities = $12::jsonb,
              operating_hours = $13::jsonb, contact_name = $14, contact_phone = $15,
              contact_email = $16, rules = $17, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        venueId, next.name, next.capacity, next.city_id, next.locality_id,
        next.address_public, next.address_private, next.lat, next.lng,
        next.description, next.photos, next.facilities, next.operating_hours,
        next.contact_name, next.contact_phone, next.contact_email, next.rules
      ]
    )).rows[0];

    await audit(`user:${user.id}`, 'venue.update_profile', venueId, { fields: Object.keys(patch) }, tx);
    return updated;
  });
}

/**
 * Returns events hosted at this venue with privacy-preserved attendance metrics.
 * NEVER leaks attendee PII (guest lists / individual ticket rows).
 */
export async function getVenueEvents(venueId, user, { filter = 'all' } = {}, c = db) {
  await authorize(user, 'venue.view_events', { venueId }, c);
  const venue = (await c.query('SELECT name, capacity FROM venues WHERE id = $1', [venueId])).rows[0];
  if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');

  let timeClause = '';
  if (filter === 'upcoming') {
    timeClause = 'AND e.start_at >= now()';
  } else if (filter === 'past') {
    timeClause = 'AND e.start_at < now()';
  }

  // Matches either explicit venue_id or venue_private text matching venue name
  const query = `
    SELECT e.id, e.slug, e.title, e.category, e.start_at, e.end_at, e.status, e.is_demo,
           e.capacity AS event_capacity, e.city, e.area_public,
           COALESCE(u.alias, o.name, 'NIGHTLIFEZ Host') AS host_name,
           (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'confirmed') AS total_booked,
           (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id AND b.status = 'checked_in') AS total_checked_in
      FROM events e
      LEFT JOIN users u ON u.id = e.organiser_user_id
      LEFT JOIN organisations o ON o.id = e.organiser_org_id
     WHERE (e.venue_id = $1 OR (e.venue_id IS NULL AND e.venue_private ILIKE '%' || $2 || '%'))
       ${timeClause}
     ORDER BY e.start_at DESC
     LIMIT 100
  `;

  const { rows } = await c.query(query, [venueId, venue.name]);

  return rows.map((e) => {
    const venueCapacity = venue.capacity || e.event_capacity || 100;
    const utilizationRate = venueCapacity > 0 ? Math.round((e.total_booked / venueCapacity) * 100) : 0;
    return {
      id: e.id,
      slug: e.slug,
      title: e.title,
      category: e.category,
      startAt: e.start_at,
      endAt: e.end_at,
      status: e.status,
      isDemo: e.is_demo,
      cityName: e.city,
      areaPublic: e.area_public,
      hostName: e.host_name,
      eventCapacity: e.event_capacity,
      venueCapacity,
      totalBooked: e.total_booked,
      totalCheckedIn: e.total_checked_in,
      utilizationRate
    };
  });
}

/**
 * Returns venue operational and footfall analytics.
 */
export async function getVenueAnalytics(venueId, user, c = db) {
  await authorize(user, 'venue.view_analytics', { venueId }, c);
  const venue = (await c.query('SELECT name, capacity FROM venues WHERE id = $1', [venueId])).rows[0];
  if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');

  const stats = (await c.query(
    `SELECT
       count(*)::int AS total_events,
       count(*) FILTER (WHERE e.start_at >= now())::int AS upcoming_events,
       count(*) FILTER (WHERE e.start_at < now())::int AS completed_events,
       COALESCE(SUM(b.booked_count), 0)::int AS total_attendees,
       COALESCE(MAX(b.booked_count), 0)::int AS peak_attendance
     FROM events e
     LEFT JOIN (
       SELECT event_id, count(*)::int AS booked_count
         FROM bookings
        WHERE status IN ('confirmed', 'checked_in')
        GROUP BY event_id
     ) b ON b.event_id = e.id
    WHERE (e.venue_id = $1 OR (e.venue_id IS NULL AND e.venue_private ILIKE '%' || $2 || '%'))`,
    [venueId, venue.name]
  )).rows[0];

  const pendingEnquiries = (await c.query(
    `SELECT count(*)::int AS cnt FROM venue_enquiries WHERE venue_id = $1 AND status = 'pending'`,
    [venueId]
  )).rows[0]?.cnt || 0;

  const openReports = (await c.query(
    `SELECT count(*)::int AS cnt FROM reports WHERE venue_id = $1 AND status IN ('new', 'reviewing')`,
    [venueId]
  )).rows[0]?.cnt || 0;

  const cap = venue.capacity || 100;
  const avgUtilization = stats.total_events > 0 && cap > 0
    ? Math.min(100, Math.round((stats.total_attendees / (stats.total_events * cap)) * 100))
    : 0;

  return {
    venueCapacity: cap,
    totalEvents: stats.total_events || 0,
    upcomingEvents: stats.upcoming_events || 0,
    completedEvents: stats.completed_events || 0,
    totalAttendees: stats.total_attendees || 0,
    peakAttendance: stats.peak_attendance || 0,
    avgUtilization,
    pendingEnquiries,
    openReports
  };
}

/**
 * Lists booking enquiries for this venue.
 */
export async function getVenueEnquiries(venueId, user, { status = 'all' } = {}, c = db) {
  await authorize(user, 'venue.view_enquiries', { venueId }, c);

  let statusClause = '';
  const params = [venueId];
  if (status && status !== 'all') {
    params.push(status);
    statusClause = 'AND ve.status = $2';
  }

  const { rows } = await c.query(
    `SELECT ve.id, ve.venue_id, ve.org_id, ve.requester_name, ve.requester_email, ve.requester_phone,
            ve.event_name, ve.event_date, ve.start_time, ve.end_time, ve.expected_guests,
            ve.budget_notes, ve.notes, ve.status, ve.decline_reason, ve.created_at, ve.updated_at
       FROM venue_enquiries ve
      WHERE ve.venue_id = $1 ${statusClause}
      ORDER BY ve.created_at DESC`,
    params
  );

  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    orgId: r.org_id,
    requesterName: r.requester_name,
    requesterEmail: r.requester_email,
    requesterPhone: r.requester_phone,
    eventName: r.event_name,
    eventDate: r.event_date,
    startTime: r.start_time,
    endTime: r.end_time,
    expectedGuests: r.expected_guests,
    budgetNotes: r.budget_notes,
    notes: r.notes,
    status: r.status,
    declineReason: r.decline_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

/**
 * Creates an organiser booking enquiry for a venue.
 */
export async function createVenueEnquiry(venueId, data, requesterUser = null, c = db) {
  const venue = (await c.query('SELECT org_id FROM venues WHERE id = $1', [venueId])).rows[0];
  if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');

  const row = (await c.query(
    `INSERT INTO venue_enquiries (
       venue_id, org_id, requester_user_id, requester_name, requester_email, requester_phone,
       event_name, event_date, start_time, end_time, expected_guests, budget_notes, notes, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
     RETURNING *`,
    [
      venueId, venue.org_id, requesterUser?.id || null, data.requester_name,
      data.requester_email || null, data.requester_phone || null, data.event_name,
      data.event_date, data.start_time || null, data.end_time || null,
      data.expected_guests || 50, data.budget_notes || null, data.notes || null
    ]
  )).rows[0];

  await audit(
    requesterUser ? `user:${requesterUser.id}` : 'guest',
    'venue.enquiry.create',
    row.id,
    { venueId, eventName: data.event_name },
    c
  );

  return row;
}

/**
 * Approves or declines an organiser booking enquiry.
 */
export async function decideVenueEnquiry(enquiryId, user, { action, reason = null }, c = db) {
  return await c.tx(async (tx) => {
    await authorize(user, 'venue.manage_enquiries', { enquiryId }, tx);
    const cur = (await tx.query('SELECT * FROM venue_enquiries WHERE id = $1 FOR UPDATE', [enquiryId])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Enquiry not found');

    const nextStatus = action === 'approve' ? 'approved' : 'declined';
    const updated = (await tx.query(
      `UPDATE venue_enquiries
          SET status = $2, decline_reason = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [enquiryId, nextStatus, action === 'decline' ? reason : null]
    )).rows[0];

    await audit(`user:${user.id}`, 'venue.enquiry.decide', enquiryId, { action, reason }, tx);
    return updated;
  });
}

/**
 * Returns staff / team members for the venue organisation.
 */
export async function getVenueStaff(venueId, user, c = db) {
  const venue = (await c.query('SELECT org_id FROM venues WHERE id = $1', [venueId])).rows[0];
  if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');

  await authorize(user, 'org.view_members', { orgId: venue.org_id }, c);
  const { rows } = await c.query(
    `SELECT m.user_id, m.role, m.status, m.created_at, u.alias, u.telegram_user_id
       FROM org_memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1
      ORDER BY (m.role = 'owner') DESC, m.created_at ASC`,
    [venue.org_id]
  );

  return rows.map((m) => ({
    userId: m.user_id,
    alias: m.alias || 'Staff Member',
    role: m.role,
    status: m.status,
    since: m.created_at
  }));
}

/**
 * Adds a new staff member to the venue organisation.
 */
export async function addVenueStaff(venueId, user, { telegram_user_id, role }, c = db) {
  return await c.tx(async (tx) => {
    const venue = (await tx.query('SELECT org_id FROM venues WHERE id = $1', [venueId])).rows[0];
    if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');

    await authorize(user, 'org.manage_members', { orgId: venue.org_id }, tx);
    const target = (await tx.query('SELECT id FROM users WHERE telegram_user_id = $1', [telegram_user_id])).rows[0];
    if (!target) throw new HttpError(404, 'user_not_found', 'User has not signed in to NIGHTLIFEZ yet');

    const cur = (await tx.query('SELECT role FROM org_memberships WHERE user_id = $1 AND org_id = $2', [target.id, venue.org_id])).rows[0];
    if (cur?.role === 'owner') throw new HttpError(409, 'is_owner', 'Cannot modify the owner membership');

    await tx.query(
      `INSERT INTO org_memberships (user_id, org_id, role, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', updated_at = now()`,
      [target.id, venue.org_id, role]
    );

    await audit(`user:${user.id}`, 'venue.staff.add', venue.org_id, { targetUserId: target.id, role }, tx);
    return { ok: true };
  });
}

/**
 * Updates or revokes a staff member's access.
 */
export async function updateVenueStaff(venueId, user, targetUserId, { role, status }, c = db) {
  return await c.tx(async (tx) => {
    const venue = (await tx.query('SELECT org_id FROM venues WHERE id = $1', [venueId])).rows[0];
    if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');

    await authorize(user, 'org.manage_members', { orgId: venue.org_id }, tx);
    const cur = (await tx.query('SELECT role FROM org_memberships WHERE user_id = $1 AND org_id = $2 FOR UPDATE', [targetUserId, venue.org_id])).rows[0];
    if (!cur) throw new HttpError(404, 'not_found', 'Staff member not found');
    if (cur.role === 'owner') throw new HttpError(409, 'is_owner', 'Cannot modify the owner membership');

    await tx.query(
      `UPDATE org_memberships
          SET role = COALESCE($3, role), status = COALESCE($4, status), updated_at = now()
        WHERE user_id = $1 AND org_id = $2`,
      [targetUserId, venue.org_id, role || null, status || null]
    );

    await audit(`user:${user.id}`, 'venue.staff.update', venue.org_id, { targetUserId, role, status }, tx);
    return { ok: true };
  });
}

/**
 * Returns safety reports associated with this venue.
 */
export async function getVenueReports(venueId, user, c = db) {
  await authorize(user, 'venue.manage_reports', { venueId }, c);
  const { rows } = await c.query(
    `SELECT r.id, r.category, r.body, r.status, r.created_at, r.event_id, e.title AS event_title
       FROM reports r
       LEFT JOIN events e ON e.id = r.event_id
      WHERE r.venue_id = $1
         OR (r.venue_id IS NULL AND r.event_id IN (SELECT id FROM events WHERE venue_id = $1))
      ORDER BY r.created_at DESC LIMIT 50`,
    [venueId]
  );

  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    body: r.body,
    status: r.status,
    eventId: r.event_id,
    eventTitle: r.event_title || null,
    createdAt: r.created_at
  }));
}

/**
 * Submits an operational or safety issue report/escalation for a venue.
 */
export async function submitVenueReport(venueId, user, { category, body, event_id = null }, c = db) {
  await authorize(user, 'venue.escalate_report', { venueId }, c);
  const row = (await c.query(
    `INSERT INTO reports (user_id, venue_id, event_id, category, body, status)
     VALUES ($1, $2, $3, $4, $5, 'new')
     RETURNING *`,
    [user.id, venueId, event_id || null, category, body]
  )).rows[0];

  await audit(`user:${user.id}`, 'venue.report.submit', row.id, { venueId, category }, c);
  return row;
}

/**
 * Submits a new venue application / partnership lead linked to user.
 */
export async function applyForVenue(user, data, c = db) {
  const payload = {
    user_id: user.id,
    user_alias: user.alias,
    name: data.name,
    venue_name: data.venue_name,
    email: data.email,
    phone: data.phone || null,
    city: data.city,
    area: data.area || null,
    capacity: data.capacity ? Number(data.capacity) : null,
    facilities: data.facilities || [],
    message: data.message || null
  };

  const row = (await c.query(
    `INSERT INTO leads (type, payload, status)
     VALUES ('venue', $1::jsonb, 'new')
     RETURNING *`,
    [JSON.stringify(payload)]
  )).rows[0];

  await audit(`user:${user.id}`, 'venue.apply', row.id, { venueName: data.venue_name }, c);
  return row;
}
