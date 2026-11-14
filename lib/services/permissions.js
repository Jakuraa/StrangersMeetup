// lib/services/permissions.js - The one access gate for organiser, org and venue resources.
// can(user, action, scope) answers yes/no; authorize() throws. A person outside the resource's
// org gets 404 (the resource is not revealed); a member whose role is too low gets 403.
// Platform roles still come from admin_users; org roles come from org_memberships.
import { db } from '../db.js';
import { HttpError } from '../http.js';

/** Org roles allowed to perform each action. */
export const ORG_ACTIONS = {
  'org.view': ['owner', 'admin', 'manager', 'staff'],
  'org.view_members': ['owner', 'admin', 'manager'],
  'org.manage_members': ['owner', 'admin'],
  'org.manage_admins': ['owner'],
  'event.manage': ['owner', 'admin', 'manager'],
  'event.edit': ['owner', 'admin', 'manager'],
  'event.cancel': ['owner', 'admin', 'manager'],
  'event.decide_bookings': ['owner', 'admin', 'manager'],
  'event.view_guests': ['owner', 'admin', 'manager', 'staff'],
  'event.cancel_booking': ['owner', 'admin', 'manager'],
  'event.check_in': ['owner', 'admin', 'manager', 'staff'],
  'event.manual_override': ['owner', 'admin', 'manager'],
  'event.reissue_ticket': ['owner', 'admin', 'manager'],
  'event.manage_staff': ['owner', 'admin'],
  'event.announcements': ['owner', 'admin', 'manager'],
  'event.view_audit': ['owner', 'admin', 'manager'],
  'event.view_inventory': ['owner', 'admin', 'manager', 'staff'],
  'venue.view': ['owner', 'admin', 'manager', 'staff'],
  'venue.view_private': ['owner', 'admin', 'manager', 'staff'],
  'venue.manage': ['owner', 'admin'],
  'venue.manage_details': ['owner', 'admin'],
  'venue.manage_enquiries': ['owner', 'admin', 'manager'],
  'venue.view_enquiries': ['owner', 'admin', 'manager', 'staff'],
  'venue.view_analytics': ['owner', 'admin', 'manager'],
  'venue.view_events': ['owner', 'admin', 'manager', 'staff'],
  'venue.manage_reports': ['owner', 'admin', 'manager'],
  'venue.escalate_report': ['owner', 'admin', 'manager', 'staff']
};

/** Event staff (event_team) roles allowed to perform each action on the assigned event. */
export const EVENT_STAFF_ACTIONS = {
  'event.manage': ['organiser', 'event_manager'],
  'event.edit': ['organiser', 'event_manager'],
  'event.cancel': ['organiser', 'event_manager'],
  'event.decide_bookings': ['organiser', 'event_manager', 'guest_list_manager'],
  'event.view_guests': ['organiser', 'event_manager', 'guest_list_manager', 'assistant'],
  'event.cancel_booking': ['organiser', 'event_manager'],
  'event.check_in': ['organiser', 'event_manager', 'guest_list_manager', 'door_staff'],
  'event.manual_override': ['organiser', 'event_manager'],
  'event.reissue_ticket': ['organiser', 'event_manager'],
  'event.manage_staff': ['organiser', 'event_manager'],
  'event.announcements': ['organiser', 'event_manager'],
  'event.view_audit': ['organiser', 'event_manager'],
  'event.view_inventory': ['organiser', 'event_manager', 'guest_list_manager', 'door_staff', 'assistant']
};

/** Platform (admin_users) roles allowed each action, on any org or event. */
const PLATFORM_ACTIONS = {
  super_admin: Object.keys(ORG_ACTIONS),
  event_manager: [
    'org.view', 'event.manage', 'event.edit', 'event.cancel', 'event.decide_bookings',
    'event.view_guests', 'event.cancel_booking', 'event.check_in', 'event.manual_override',
    'event.reissue_ticket', 'event.manage_staff', 'event.announcements', 'event.view_audit',
    'event.view_inventory', 'venue.view', 'venue.view_events', 'venue.view_enquiries'
  ]
};

export const ACTIONS = [...new Set([...Object.keys(ORG_ACTIONS), ...Object.keys(EVENT_STAFF_ACTIONS)])];

// A personal org counts only while its owner may still organise: the admin organiser switch, or an
// active events admin (the same rule isOrganiser() applies to the wizard).
const PERSONAL_ORG_LIVE = `(o.kind <> 'personal' OR u.organiser_enabled OR EXISTS (
  SELECT 1 FROM admin_users a WHERE a.telegram_user_id = u.telegram_user_id AND a.active AND a.role IN ('super_admin', 'event_manager')))`;

async function platformRole(user, c) {
  if (!user?.telegram_user_id) return null;
  const a = (await c.query('SELECT role FROM admin_users WHERE telegram_user_id = $1 AND active', [user.telegram_user_id])).rows[0];
  return a?.role || null;
}

/**
 * The user's effective role in an org, or null (see PERSONAL_ORG_LIVE for personal orgs).
 */
export async function orgRole(user, orgId, c = db) {
  if (!user?.id || !orgId) return null;
  const r = (await c.query(
    `SELECT m.role FROM org_memberships m
       JOIN organisations o ON o.id = m.org_id
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active' AND o.status = 'active' AND u.status = 'active'
        AND ${PERSONAL_ORG_LIVE}`, [user.id, orgId])).rows[0];
  return r?.role || null;
}

/**
 * Which org a scope belongs to. scope: { orgId } | { event } | { eventId } | { venue } | { venueId }.
 * Events from before migration 012 with no org fall back to their organiser's personal org.
 */
export async function scopeOrgId(scope, c = db) {
  if (!scope) return null;
  if (scope.orgId) return scope.orgId;
  let event = scope.event;
  if (!event && scope.eventId) event = (await c.query('SELECT organiser_org_id, organiser_user_id FROM events WHERE id = $1', [scope.eventId])).rows[0];
  if (event) {
    if (event.organiser_org_id) return event.organiser_org_id;
    if (!event.organiser_user_id) return null;
    return (await c.query('SELECT id FROM organisations WHERE personal_user_id = $1', [event.organiser_user_id])).rows[0]?.id || null;
  }
  if (scope.venue) return scope.venue.org_id;
  if (scope.venueId) return (await c.query('SELECT org_id FROM venues WHERE id = $1', [scope.venueId])).rows[0]?.org_id || null;
  if (scope.enquiryId) return (await c.query('SELECT org_id FROM venue_enquiries WHERE id = $1', [scope.enquiryId])).rows[0]?.org_id || null;
  if (scope.venueReportId) return (await c.query('SELECT v.org_id FROM reports r JOIN venues v ON v.id = r.venue_id WHERE r.id = $1', [scope.venueReportId])).rows[0]?.org_id || null;
  return null;
}

export async function resolveEventId(scope, c = db) {
  if (!scope) return null;
  if (scope.eventId) return scope.eventId;
  if (scope.event?.id) return scope.event.id;
  if (scope.booking?.event_id) return scope.booking.event_id;
  if (scope.bookingId) {
    const b = (await c.query('SELECT event_id FROM bookings WHERE id = $1', [scope.bookingId])).rows[0];
    return b?.event_id || null;
  }
  if (scope.ticketId) {
    const t = (await c.query('SELECT event_id FROM tickets WHERE id = $1', [scope.ticketId])).rows[0];
    return t?.event_id || null;
  }
  return null;
}

/**
 * The user's active event-scoped team role, or null.
 */
export async function eventTeamRole(user, eventId, c = db) {
  if (!user?.id || !eventId) return null;
  const r = (await c.query(
    `SELECT team_role FROM event_team
      WHERE user_id = $1 AND event_id = $2 AND status = 'active'`,
    [user.id, eventId]
  )).rows[0];
  return r?.team_role || null;
}

/** Decide one action. Returns { allowed, member, role } where member says whether the user belongs to the org or event team. */
export async function check(user, action, scope, c = db) {
  if (!ORG_ACTIONS[action] && !EVENT_STAFF_ACTIONS[action]) throw new Error(`unknown action ${action}`);
  if (!user?.id) return { allowed: false, member: false };
  const pRole = await platformRole(user, c);
  if (pRole && PLATFORM_ACTIONS[pRole]?.includes(action)) return { allowed: true, member: true, role: pRole, platformRole: pRole };

  // Check event-level team membership first if scoped to an event
  const eventId = await resolveEventId(scope, c);
  let staffRole = null;
  if (eventId) {
    staffRole = await eventTeamRole(user, eventId, c);
    if (staffRole) {
      const allowed = Boolean(EVENT_STAFF_ACTIONS[action]?.includes(staffRole));
      if (allowed) return { allowed: true, member: true, role: staffRole, eventStaff: true };
    }
  }

  // Check organisation-level membership
  const orgId = await scopeOrgId(scope, c);
  const role = await orgRole(user, orgId, c);
  if (role) {
    const allowed = Boolean(ORG_ACTIONS[action]?.includes(role));
    return { allowed, member: true, role, orgRole: role };
  }

  // If user has an event staff role on this event but it doesn't allow the action, they are a member with insufficient role (403)
  if (staffRole) return { allowed: false, member: true, role: staffRole, eventStaff: true };

  return { allowed: false, member: false };
}

export async function can(user, action, scope, c = db) {
  return (await check(user, action, scope, c)).allowed;
}

/** Throw unless allowed: 404 to outsiders (nothing is revealed), 403 to members with too low a role. */
export async function authorize(user, action, scope, c = db, { notFound = 'Not found' } = {}) {
  const r = await check(user, action, scope, c);
  if (r.allowed) return r;
  if (r.member) throw new HttpError(403, 'forbidden', 'Your role in this organisation does not allow that.');
  throw new HttpError(404, 'not_found', notFound);
}

/** Org ids where the user holds an active role that allows `action` (for list scoping). */
export async function orgIdsFor(user, action, c = db) {
  if (!user?.id) return [];
  const roles = ORG_ACTIONS[action] || [];
  if (!roles.length) return [];
  const { rows } = await c.query(
    `SELECT m.org_id FROM org_memberships m
       JOIN organisations o ON o.id = m.org_id
       JOIN users u ON u.id = m.user_id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active' AND u.status = 'active'
        AND ${PERSONAL_ORG_LIVE} AND m.role = ANY($2::org_role[])`, [user.id, roles]);
  return rows.map((r) => r.org_id);
}

/** Event ids where the user holds an active event staff role that allows `action`. */
export async function eventIdsFor(user, action, c = db) {
  if (!user?.id) return [];
  const roles = EVENT_STAFF_ACTIONS[action] || [];
  if (!roles.length) return [];
  const { rows } = await c.query(
    `SELECT event_id FROM event_team WHERE user_id = $1 AND status = 'active' AND team_role = ANY($2::text[])`,
    [user.id, roles]
  );
  return rows.map((r) => r.event_id);
}

/**
 * The user's personal org (created on first need), with an owner membership and the
 * organise_events capability. Idempotent; safe inside any transaction.
 */
export async function ensurePersonalOrg(user, c = db) {
  await c.query(
    `INSERT INTO organisations (kind, name, personal_user_id) VALUES ('personal', $2, $1)
     ON CONFLICT (personal_user_id) DO NOTHING`, [user.id, (user.alias || '').trim() || 'Personal']);
  const org = (await c.query('SELECT id FROM organisations WHERE personal_user_id = $1', [user.id])).rows[0];
  await c.query(
    `INSERT INTO org_memberships (user_id, org_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (user_id, org_id) DO NOTHING`, [user.id, org.id]);
  // Same rule as the migration 012 backfill and PERSONAL_ORG_LIVE: organiser switch OR active event admin.
  await c.query(
    `INSERT INTO user_capabilities (user_id, capability_code, status)
     SELECT u.id, 'organise_events',
       CASE WHEN (u.organiser_enabled OR EXISTS (
         SELECT 1 FROM admin_users a WHERE a.telegram_user_id = u.telegram_user_id AND a.active AND a.role IN ('super_admin', 'event_manager')
       )) THEN 'verified' ELSE 'revoked' END::capability_status
       FROM users u WHERE u.id = $1
     ON CONFLICT (user_id, capability_code) DO NOTHING`, [user.id]);
  return org.id;
}

/** Keep the organise_events capability in step with the admin organiser switch. */
export async function setOrganiseCapability(userId, enabled, c = db) {
  await c.query(
    `INSERT INTO user_capabilities (user_id, capability_code, status) VALUES ($1, 'organise_events', $2)
     ON CONFLICT (user_id, capability_code) DO UPDATE SET status = EXCLUDED.status`,
    [userId, enabled ? 'verified' : 'revoked']);
}
