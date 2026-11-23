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

export const VENUE_CATEGORIES = [
  { id: 'rooftop_lounge', label: 'Rooftop Lounge & Skybar' },
  { id: 'cocktail_speakeasy', label: 'Cocktail Bar & Speakeasy' },
  { id: 'nightclub', label: 'Nightclub & Dance Venue' },
  { id: 'cafe_bistro', label: 'Café & Intimate Bistro' },
  { id: 'studio_loft', label: 'Art Studio & Creative Loft' },
  { id: 'resort_farmhouse', label: 'Resort, Villa & Farmhouse' },
  { id: 'brewery_pub', label: 'Microbrewery & Social Pub' },
  { id: 'event_space', label: 'Boutique Event Space' }
];

/**
 * Calculates profile strength percentage and identifies missing fields for completion tracking.
 */
export function calculateProfileStrength(venue) {
  let score = 0;
  const missing = [];
  if (venue.name?.trim()) score += 15; else missing.push('name');
  if (venue.category?.trim()) score += 15; else missing.push('category');
  if (venue.description?.trim()) score += 10; else missing.push('description');
  if (venue.address_public?.trim() || venue.addressPublic?.trim() || venue.city_id || venue.cityId) score += 20; else missing.push('location');
  if (venue.capacity && Number(venue.capacity) > 0) score += 10; else missing.push('capacity');
  const facs = Array.isArray(venue.facilities) ? venue.facilities : [];
  if (facs.length > 0) score += 10; else missing.push('facilities');
  const photos = Array.isArray(venue.photos) ? venue.photos : [];
  if (photos.length > 0) score += 10; else missing.push('photos');
  const hours = venue.operating_hours || venue.operatingHours;
  const hasHours = hours && typeof hours === 'object' && Object.keys(hours).length > 0;
  if (hasHours) score += 5; else missing.push('operating_hours');
  if (venue.contact_email?.trim() || venue.contactEmail?.trim() || venue.contact_phone?.trim() || venue.contactPhone?.trim()) score += 5; else missing.push('contact');
  return { percentage: Math.min(100, score), missing };
}

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
       JOIN venues v ON v.org_id = o.id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
        AND v.status = 'active' AND v.onboarding_completed = true
      LIMIT 1`,
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
         FROM organisations o
        WHERE o.status = 'active'
          AND (o.kind = 'venue_operator' OR EXISTS (SELECT 1 FROM venues v WHERE v.org_id = o.id AND v.status = 'active'))
        ORDER BY o.name`
    )).rows;
  } else {
    orgRows = (await c.query(
      `SELECT o.id, o.name, o.kind, o.status, o.verified_at, m.role
         FROM org_memberships m
         JOIN organisations o ON o.id = m.org_id
        WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
          AND (o.kind = 'venue_operator' OR EXISTS (SELECT 1 FROM venues v WHERE v.org_id = o.id AND v.status = 'active'))
        ORDER BY o.name`,
      [user.id]
    )).rows;
  }

  const orgIds = orgRows.map((o) => o.id);
  let venues = [];
  let draftVenue = null;

  if (isSuperAdmin) {
    const vRes = await c.query(
      `SELECT v.id, v.org_id, v.name, v.category, v.neighbourhood, v.capacity, v.status,
              v.address_public, v.address_private, v.city_id, c.name AS city_name,
              v.locality_id, l.name AS locality_name, v.photos, v.facilities,
              v.operating_hours, v.contact_name, v.contact_phone, v.contact_email,
              v.rules, v.onboarding_completed, v.created_at, o.name AS org_name,
              o.verified_at IS NOT NULL AS org_verified
         FROM venues v
         JOIN organisations o ON o.id = v.org_id
         LEFT JOIN location_cities c ON c.id = v.city_id
         LEFT JOIN location_localities l ON l.id = v.locality_id
        WHERE v.status = 'active' AND v.onboarding_completed = true
        ORDER BY v.name`
    );
    venues = vRes.rows;
  } else if (orgIds.length > 0) {
    const vRes = await c.query(
      `SELECT v.id, v.org_id, v.name, v.category, v.neighbourhood, v.capacity, v.status,
              v.address_public, v.address_private, v.city_id, c.name AS city_name,
              v.locality_id, l.name AS locality_name, v.photos, v.facilities,
              v.operating_hours, v.contact_name, v.contact_phone, v.contact_email,
              v.rules, v.onboarding_completed, v.created_at, o.name AS org_name,
              o.verified_at IS NOT NULL AS org_verified
         FROM venues v
         JOIN organisations o ON o.id = v.org_id
         LEFT JOIN location_cities c ON c.id = v.city_id
         LEFT JOIN location_localities l ON l.id = v.locality_id
        WHERE v.org_id = ANY($1::uuid[]) AND v.status = 'active' AND v.onboarding_completed = true
        ORDER BY v.name`,
      [orgIds]
    );
    venues = vRes.rows;

    const draftRes = await c.query(
      `SELECT v.id, v.org_id, v.name, v.category, v.neighbourhood, v.capacity, v.status,
              v.address_public, v.address_private, v.city_id, c.name AS city_name,
              v.locality_id, l.name AS locality_name, v.photos, v.facilities,
              v.operating_hours, v.contact_name, v.contact_phone, v.contact_email,
              v.rules, v.onboarding_completed, v.onboarding_step, v.created_at, v.updated_at,
              o.name AS org_name, o.verified_at IS NOT NULL AS org_verified
         FROM venues v
         JOIN organisations o ON o.id = v.org_id
         LEFT JOIN location_cities c ON c.id = v.city_id
         LEFT JOIN location_localities l ON l.id = v.locality_id
        WHERE v.org_id = ANY($1::uuid[]) AND (v.status = 'draft' OR v.onboarding_completed = false)
        ORDER BY v.updated_at DESC
        LIMIT 1`,
      [orgIds]
    );
    if (draftRes.rows[0]) {
      const d = draftRes.rows[0];
      draftVenue = {
        id: d.id,
        orgId: d.org_id,
        orgName: d.org_name,
        orgVerified: d.org_verified,
        name: d.name,
        category: d.category || null,
        neighbourhood: d.neighbourhood || null,
        capacity: d.capacity,
        cityId: d.city_id,
        cityName: d.city_name,
        localityId: d.locality_id,
        localityName: d.locality_name,
        addressPublic: d.address_public,
        addressPrivate: d.address_private,
        photos: d.photos || [],
        facilities: d.facilities || [],
        operatingHours: d.operating_hours || {},
        contactName: d.contact_name,
        contactPhone: d.contact_phone,
        contactEmail: d.contact_email,
        rules: d.rules,
        status: d.status,
        onboardingCompleted: Boolean(d.onboarding_completed),
        onboardingStep: d.onboarding_step || 1,
        profileStrength: calculateProfileStrength(d),
        updatedAt: d.updated_at
      };
    }
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
      isSuperAdmin,
      userRole: isSuperAdmin ? 'owner' : (orgRows[0]?.role || null),
      orgs: orgRows.map((o) => ({ id: o.id, name: o.name, verified: Boolean(o.verified_at) })),
      venues: [],
      draftVenue,
      activeVenueId: null,
      activeVenue: null,
      permissions: {
        canManage: isSuperAdmin,
        canManageEnquiries: isSuperAdmin,
        canViewAnalytics: isSuperAdmin,
        canViewEvents: isSuperAdmin,
        canManageStaff: isSuperAdmin
      },
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
    isSuperAdmin,
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
      category: v.category || null,
      neighbourhood: v.neighbourhood || null,
      capacity: v.capacity,
      cityName: v.city_name,
      localityName: v.locality_name,
      status: v.status,
      onboardingCompleted: Boolean(v.onboarding_completed)
    })),
    draftVenue,
    activeVenueId: activeVenue.id,
    activeVenue: {
      id: activeVenue.id,
      orgId: activeVenue.org_id,
      orgName: activeVenue.org_name,
      orgVerified: activeVenue.org_verified,
      name: activeVenue.name,
      category: activeVenue.category || null,
      neighbourhood: activeVenue.neighbourhood || null,
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
      rules: activeVenue.rules,
      status: activeVenue.status,
      onboardingCompleted: Boolean(activeVenue.onboarding_completed),
      profileStrength: calculateProfileStrength(activeVenue)
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
    category: row.category || null,
    neighbourhood: row.neighbourhood || null,
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
    onboardingCompleted: Boolean(row.onboarding_completed),
    profileStrength: calculateProfileStrength(row),
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
      category: patch.category !== undefined ? patch.category : cur.category,
      neighbourhood: patch.neighbourhood !== undefined ? patch.neighbourhood : cur.neighbourhood,
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
          SET name = $2, category = $3, neighbourhood = $4, capacity = $5,
              city_id = $6, locality_id = $7, address_public = $8,
              address_private = $9, lat = $10, lng = $11, description = $12,
              photos = $13::jsonb, facilities = $14::jsonb, operating_hours = $15::jsonb,
              contact_name = $16, contact_phone = $17, contact_email = $18,
              rules = $19, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        venueId, next.name, next.category, next.neighbourhood, next.capacity,
        next.city_id, next.locality_id, next.address_public, next.address_private,
        next.lat, next.lng, next.description, next.photos, next.facilities,
        next.operating_hours, next.contact_name, next.contact_phone, next.contact_email,
        next.rules
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
  const venue = (await c.query('SELECT name, capacity, status, onboarding_completed FROM venues WHERE id = $1', [venueId])).rows[0];
  if (!venue || venue.status !== 'active' || !venue.onboarding_completed) {
    throw new HttpError(404, 'not_found', 'Venue not found or not published');
  }

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
  const venue = (await c.query('SELECT name, capacity, status, onboarding_completed FROM venues WHERE id = $1', [venueId])).rows[0];
  if (!venue || venue.status !== 'active' || !venue.onboarding_completed) {
    throw new HttpError(404, 'not_found', 'Venue not found or not published');
  }

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
  const venue = (await c.query('SELECT org_id, status, onboarding_completed FROM venues WHERE id = $1', [venueId])).rows[0];
  if (!venue || venue.status !== 'active' || !venue.onboarding_completed) {
    throw new HttpError(404, 'not_found', 'Venue not found or not available for enquiries');
  }

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

/**
 * Direct self-service venue onboarding and profile setup.
 * Supports complete publishing (status: active, onboarding_completed: true)
 * as well as save-progress draft flow (is_draft: true).
 */
export async function onboardVenue(user, data, c = db) {
  if (!user?.id) throw new HttpError(401, 'unauthorized', 'Please sign in');

  const isDraft = Boolean(data.is_draft);
  const name = data.name?.trim();
  if (!name && !isDraft) {
    throw new HttpError(400, 'validation', 'Venue name is required');
  }

  return await c.tx(async (tx) => {
    // 1. Resolve or create user's venue_operator organisation
    let org = (await tx.query(
      `SELECT o.id, o.name FROM organisations o
         JOIN org_memberships m ON m.org_id = o.id
        WHERE m.user_id = $1 AND m.role = 'owner' AND o.status = 'active'
          AND (o.kind = 'venue_operator' OR o.kind = 'business')
        ORDER BY o.created_at ASC
        LIMIT 1`,
      [user.id]
    )).rows[0];

    if (!org) {
      const orgName = name ? `${name} Management` : (user.alias ? `${user.alias} Venues` : 'Venue Operator');
      org = (await tx.query(
        `INSERT INTO organisations (kind, name, status, verified_at, created_at)
         VALUES ('venue_operator', $1, 'active', NULL, now())
         RETURNING id, name`,
        [orgName]
      )).rows[0];

      await tx.query(
        `INSERT INTO org_memberships (user_id, org_id, role, status)
         VALUES ($1, $2, 'owner', 'active')
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [user.id, org.id]
      );
    }

    // 2. Grant capabilities: manage_venue and organise_events
    for (const code of ['manage_venue', 'organise_events']) {
      await tx.query(
        `INSERT INTO user_capabilities (user_id, capability_code, status)
         VALUES ($1, $2, 'claimed')
         ON CONFLICT (user_id, capability_code) DO NOTHING`,
        [user.id, code]
      );
    }
    await tx.query('UPDATE users SET organiser_enabled = true WHERE id = $1', [user.id]);

    // 3. Resolve city_id if city name or slug provided
    let cityId = null;
    if (data.city_id) {
      cityId = data.city_id;
    } else if (data.city) {
      const cRow = (await tx.query(
        `SELECT id FROM location_cities
          WHERE lower(name) = lower($1) OR lower(slug) = lower($1)
          LIMIT 1`,
        [data.city.trim()]
      )).rows[0];
      if (cRow) cityId = cRow.id;
    }

    // 4. Duplicate / Anti-Hijacking Check
    if (name && (cityId || data.address_public)) {
      const dup = (await tx.query(
        `SELECT v.id, v.org_id, o.name AS org_name
           FROM venues v
           JOIN organisations o ON o.id = v.org_id
          WHERE lower(trim(v.name)) = lower(trim($1))
            AND (
              ($2::uuid IS NOT NULL AND v.city_id = $2)
              OR ($3::text IS NOT NULL AND lower(trim(v.address_public)) = lower(trim($3)))
            )
            AND v.status = 'active'
            AND v.org_id != $4
          LIMIT 1`,
        [name, cityId, data.address_public?.trim() || null, org.id]
      )).rows[0];

      if (dup) {
        throw new HttpError(
          409,
          'duplicate_venue',
          `A venue named '${name}' is already registered at this location. If you are the rightful owner, you can file a verified ownership claim via NIGHTLIFEZ self-service recovery.`,
          {
            existingVenueId: dup.id,
            claimAllowed: true
          }
        );
      }
    }

    // 5. Check if updating existing venue (by venue_id or existing draft in org)
    let venue = null;
    if (data.venue_id) {
      venue = (await tx.query(
        `SELECT * FROM venues WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [data.venue_id, org.id]
      )).rows[0];
      if (!venue) throw new HttpError(404, 'not_found', 'Venue not found in your organization');
    } else {
      // Check if user has an existing uncompleted venue draft in this org
      venue = (await tx.query(
        `SELECT * FROM venues WHERE org_id = $1 AND (status = 'draft' OR onboarding_completed = false) ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [org.id]
      )).rows[0];
    }

    // Clean up facilities array and photos array
    const facilitiesJson = JSON.stringify(Array.isArray(data.facilities) ? data.facilities : (venue?.facilities || []));
    let photosList = venue?.photos || [];
    if (Array.isArray(data.photos)) {
      photosList = data.photos;
    } else if (typeof data.photos === 'string' && data.photos.trim()) {
      photosList = data.photos.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const photosJson = JSON.stringify(photosList);

    let operatingHours = venue?.operating_hours || {};
    if (data.operating_hours) {
      if (typeof data.operating_hours === 'object') {
        operatingHours = data.operating_hours;
      } else if (typeof data.operating_hours === 'string') {
        operatingHours = { general: data.operating_hours.trim() };
      }
    }

    const onboardingCompleted = !isDraft;
    const capacityVal = data.capacity ? Number(data.capacity) : (venue?.capacity || 50);
    const targetStatus = isDraft
      ? (venue && venue.status === 'active' && venue.onboarding_completed ? 'active' : 'draft')
      : 'active';

    if (venue) {
      // Update existing venue
      venue = (await tx.query(
        `UPDATE venues SET
           name = COALESCE($3, name),
           category = COALESCE($4, category),
           description = COALESCE($5, description),
           address_public = COALESCE($6, address_public),
           address_private = COALESCE($7, address_private),
           city_id = COALESCE($8, city_id),
           neighbourhood = COALESCE($9, neighbourhood),
           capacity = COALESCE($10, capacity),
           facilities = $11::jsonb,
           operating_hours = $12::jsonb,
           contact_name = COALESCE($13, contact_name),
           contact_phone = COALESCE($14, contact_phone),
           contact_email = COALESCE($15, contact_email),
           rules = COALESCE($16, rules),
           photos = $17::jsonb,
           status = $18,
           onboarding_completed = $19,
           onboarding_step = COALESCE($20, onboarding_step),
           updated_at = now()
         WHERE id = $1 AND org_id = $2
         RETURNING *`,
        [
          venue.id,
          org.id,
          name || null,
          data.category?.trim() || null,
          data.description?.trim() || null,
          data.address_public?.trim() || null,
          data.address_private?.trim() || null,
          cityId,
          data.neighbourhood?.trim() || null,
          capacityVal,
          facilitiesJson,
          JSON.stringify(operatingHours),
          data.contact_name?.trim() || null,
          data.contact_phone?.trim() || null,
          data.contact_email?.trim() || null,
          data.rules?.trim() || null,
          photosJson,
          targetStatus,
          onboardingCompleted,
          data.onboarding_step || (onboardingCompleted ? 4 : 2)
        ]
      )).rows[0];
    } else {
      // Insert new venue
      venue = (await tx.query(
        `INSERT INTO venues (
           org_id, name, category, description, address_public, address_private,
           city_id, neighbourhood, capacity, facilities, operating_hours,
           contact_name, contact_phone, contact_email, rules, photos,
           status, onboarding_completed, onboarding_step, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10::jsonb, $11::jsonb,
           $12, $13, $14, $15, $16::jsonb,
           $17, $18, $19, now(), now()
         ) RETURNING *`,
        [
          org.id,
          name || 'Untitled Venue Draft',
          data.category?.trim() || 'event_space',
          data.description?.trim() || null,
          data.address_public?.trim() || null,
          data.address_private?.trim() || null,
          cityId,
          data.neighbourhood?.trim() || null,
          capacityVal,
          facilitiesJson,
          JSON.stringify(operatingHours),
          data.contact_name?.trim() || user.alias || null,
          data.contact_phone?.trim() || null,
          data.contact_email?.trim() || user.email || null,
          data.rules?.trim() || null,
          photosJson,
          targetStatus,
          onboardingCompleted,
          data.onboarding_step || (onboardingCompleted ? 4 : 1)
        ]
      )).rows[0];
    }

    const strength = calculateProfileStrength(venue);
    await audit(`user:${user.id}`, isDraft ? 'venue.save_draft' : 'venue.onboard', venue.id, {
      name: venue.name,
      orgId: org.id,
      isDraft,
      completion: strength.percentage
    }, tx);

    return {
      venue,
      orgId: org.id,
      isDraft,
      completionPercentage: strength.percentage,
      missingFields: strength.missing
    };
  });
}

/**
 * Submits a self-service venue ownership claim/recovery request.
 * Does NOT automatically transfer ownership. Initiates auditable verification.
 */
export async function submitVenueClaim(user, data, c = db) {
  if (!user?.id) throw new HttpError(401, 'unauthorized', 'Please sign in to submit an ownership claim');

  return await c.tx(async (tx) => {
    // 1. Verify target venue exists and is an active published venue
    const venue = (await tx.query(
      `SELECT v.id, v.org_id, v.name, v.contact_email, v.status, o.name AS org_name
         FROM venues v
         JOIN organisations o ON o.id = v.org_id
        WHERE v.id = $1`,
      [data.venue_id]
    )).rows[0];
    if (!venue) throw new HttpError(404, 'not_found', 'Venue not found');

    // 2. Claimant cannot claim a venue their own org already owns
    const isMember = (await tx.query(
      `SELECT 1 FROM org_memberships WHERE user_id = $1 AND org_id = $2 AND status = 'active'`,
      [user.id, venue.org_id]
    )).rows[0];
    if (isMember) {
      throw new HttpError(400, 'already_owned', 'You are already a member of the organisation that owns this venue');
    }

    // 3. Resolve claimant's venue_operator organisation
    let claimantOrg = (await tx.query(
      `SELECT o.id FROM organisations o
         JOIN org_memberships m ON m.org_id = o.id
        WHERE m.user_id = $1 AND m.role = 'owner' AND o.status = 'active'
        ORDER BY o.created_at ASC LIMIT 1`,
      [user.id]
    )).rows[0];

    if (!claimantOrg) {
      claimantOrg = (await tx.query(
        `INSERT INTO organisations (kind, name, status, verified_at, created_at)
         VALUES ('venue_operator', $1, 'active', NULL, now())
         RETURNING id`,
        [`${data.contact_name || user.alias || 'Claimant'} Organisation`]
      )).rows[0];

      await tx.query(
        `INSERT INTO org_memberships (user_id, org_id, role, status)
         VALUES ($1, $2, 'owner', 'active')
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [user.id, claimantOrg.id]
      );
    }

    // 4. Check for existing pending claim by this user for this venue
    const existingClaim = (await tx.query(
      `SELECT id, status, created_at FROM venue_claims
        WHERE venue_id = $1 AND claimant_user_id = $2 AND status IN ('pending_verification', 'reviewing')
        LIMIT 1`,
      [venue.id, user.id]
    )).rows[0];

    if (existingClaim) {
      throw new HttpError(
        409,
        'claim_already_pending',
        'An ownership claim for this venue is already pending verification under your account'
      );
    }

    // 5. Insert auditable claim record (NO automatic ownership transfer!)
    const claim = (await tx.query(
      `INSERT INTO venue_claims (
         venue_id, claimant_user_id, claimant_org_id, claimant_role,
         business_proof_type, business_proof_ref, contact_name, contact_email,
         contact_phone, notes, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending_verification', now(), now())
       RETURNING *`,
      [
        venue.id,
        user.id,
        claimantOrg.id,
        data.claimant_role.trim(),
        data.business_proof_type.trim(),
        data.business_proof_ref.trim(),
        data.contact_name.trim(),
        data.contact_email.trim(),
        data.contact_phone?.trim() || null,
        data.notes?.trim() || null
      ]
    )).rows[0];

    // Audit the claim submission
    await audit(`user:${user.id}`, 'venue.claim.submit', claim.id, {
      venueId: venue.id,
      venueName: venue.name,
      proofType: data.business_proof_type,
      proofRef: data.business_proof_ref
    }, tx);

    return {
      claim,
      venue: { id: venue.id, name: venue.name },
      message: 'Ownership claim submitted successfully. Verification challenge recorded.'
    };
  });
}

/**
 * Returns all venue ownership claims submitted by the user.
 */
export async function getVenueClaims(user, c = db) {
  if (!user?.id) throw new HttpError(401, 'unauthorized', 'Please sign in');
  const { rows } = await c.query(
    `SELECT vc.*, v.name AS venue_name, v.address_public
       FROM venue_claims vc
       JOIN venues v ON v.id = vc.venue_id
      WHERE vc.claimant_user_id = $1
      ORDER BY vc.created_at DESC`,
    [user.id]
  );
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    addressPublic: r.address_public,
    claimantRole: r.claimant_role,
    businessProofType: r.business_proof_type,
    businessProofRef: r.business_proof_ref,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    notes: r.notes,
    status: r.status,
    resolutionNotes: r.resolution_notes,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}
