// lib/services/event-staff.js - Event-scoped staff roles and membership management.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { can, authorize } from './permissions.js';

export const VALID_STAFF_ROLES = ['event_manager', 'door_staff', 'guest_list_manager', 'assistant'];

export const STAFF_ROLE_LABELS = {
  event_manager: 'Event Manager',
  door_staff: 'Door / Check-in Staff',
  guest_list_manager: 'Guest-list Manager',
  assistant: 'Event Assistant (Read-only)'
};

/**
 * List all staff members (active & removed) and pending invites for an event.
 */
export async function listEventStaff(user, eventId, c = db) {
  await authorize(user, 'event.view_guests', { eventId }, c);

  const staffRows = (await c.query(
    `SELECT et.id, et.team_role, et.status, et.created_at, et.updated_at, et.revoked_at, et.notes,
            u.id AS user_id, u.alias, u.telegram_user_id,
            inv.alias AS invited_by_alias,
            rev.alias AS revoked_by_alias
       FROM event_team et
       JOIN users u ON u.id = et.user_id
       LEFT JOIN users inv ON inv.id = et.invited_by
       LEFT JOIN users rev ON rev.id = et.revoked_by
      WHERE et.event_id = $1
      ORDER BY (et.status = 'active') DESC, et.created_at ASC`,
    [eventId]
  )).rows;

  const invites = (await c.query(
    `SELECT esi.id, esi.role, esi.token, esi.invited_alias, esi.status, esi.expires_at, esi.created_at,
            u.alias AS invited_by_alias
       FROM event_staff_invites esi
       JOIN users u ON u.id = esi.invited_by
      WHERE esi.event_id = $1 AND esi.status = 'pending' AND esi.expires_at > now()
      ORDER BY esi.created_at DESC`,
    [eventId]
  )).rows;

  const canManage = await can(user, 'event.manage_staff', { eventId }, c);

  return {
    eventId,
    canManage,
    staff: staffRows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      alias: r.alias || 'Staff Member',
      role: r.team_role,
      roleLabel: STAFF_ROLE_LABELS[r.team_role] || r.team_role,
      status: r.status,
      notes: r.notes || null,
      invitedByAlias: r.invited_by_alias || null,
      revokedByAlias: r.revoked_by_alias || null,
      createdAt: r.created_at,
      revokedAt: r.revoked_at
    })),
    invites: invites.map((i) => ({
      id: i.id,
      role: i.role,
      roleLabel: STAFF_ROLE_LABELS[i.role] || i.role,
      invitedAlias: i.invited_alias || null,
      invitedByAlias: i.invited_by_alias,
      token: canManage ? i.token : null,
      inviteUrl: canManage ? `/staff/join?token=${encodeURIComponent(i.token)}` : null,
      expiresAt: i.expires_at,
      createdAt: i.created_at
    }))
  };
}

/**
 * Assigns or updates a staff member directly by userId.
 */
export async function assignEventStaff(actor, eventId, { userId, role, notes = null }, c = db) {
  if (!VALID_STAFF_ROLES.includes(role)) {
    throw new HttpError(400, 'validation', `Invalid staff role: choose from ${VALID_STAFF_ROLES.join(', ')}`);
  }
  await authorize(actor, 'event.manage_staff', { eventId }, c);

  const targetUser = (await c.query(`SELECT id, alias, status FROM users WHERE id = $1`, [userId])).rows[0];
  if (!targetUser) throw new HttpError(404, 'user_not_found', 'User not found');
  if (targetUser.status !== 'active') throw new HttpError(400, 'user_inactive', 'User account is not active');

  // Prevent demoting event owner
  const event = (await c.query(`SELECT organiser_user_id FROM events WHERE id = $1`, [eventId])).rows[0];
  if (event?.organiser_user_id === userId) {
    throw new HttpError(400, 'owner_immutable', 'The event owner cannot be assigned an event staff role');
  }

  return c.tx(async (txClient) => {
    const existing = (await txClient.query(
      `SELECT * FROM event_team WHERE event_id = $1 AND user_id = $2 FOR UPDATE`,
      [eventId, userId]
    )).rows[0];

    let row;
    if (existing) {
      row = (await txClient.query(
        `UPDATE event_team
            SET team_role = $3,
                status = 'active',
                invited_by = $4,
                revoked_by = NULL,
                revoked_at = NULL,
                notes = COALESCE($5, notes),
                updated_at = now()
          WHERE id = $1 AND event_id = $2
          RETURNING *`,
        [existing.id, eventId, role, actor.id, notes]
      )).rows[0];
    } else {
      row = (await txClient.query(
        `INSERT INTO event_team (event_id, user_id, team_role, status, invited_by, notes)
         VALUES ($1, $2, $3, 'active', $4, $5)
         RETURNING *`,
        [eventId, userId, role, actor.id, notes]
      )).rows[0];
    }

    await audit(`user:${actor.id}`, 'event.staff_assign', row.id, {
      eventId,
      userId,
      role,
      previousRole: existing?.team_role || null,
      previousStatus: existing?.status || null
    }, txClient);

    return {
      ok: true,
      staff: {
        id: row.id,
        userId: row.user_id,
        alias: targetUser.alias,
        role: row.team_role,
        status: row.status
      }
    };
  });
}

/**
 * Revokes a staff member's event access with immediate effect.
 */
export async function revokeEventStaff(actor, eventId, staffId, c = db) {
  await authorize(actor, 'event.manage_staff', { eventId }, c);

  return c.tx(async (txClient) => {
    const row = (await txClient.query(
      `SELECT * FROM event_team WHERE (id = $1 OR user_id = $1) AND event_id = $2 FOR UPDATE`,
      [staffId, eventId]
    )).rows[0];

    if (!row) throw new HttpError(404, 'staff_not_found', 'Staff member not found on this event');
    if (row.status === 'removed') {
      return { ok: true, staffId: row.id, status: 'removed' };
    }

    const now = new Date();
    await txClient.query(
      `UPDATE event_team
          SET status = 'removed',
              revoked_at = $2,
              revoked_by = $3,
              updated_at = $2
        WHERE id = $1`,
      [row.id, now, actor.id]
    );

    await audit(`user:${actor.id}`, 'event.staff_revoke', row.id, {
      eventId,
      targetUserId: row.user_id,
      previousRole: row.team_role
    }, txClient);

    return { ok: true, staffId: row.id, status: 'removed' };
  });
}

/**
 * Creates a single-use staff invite token.
 */
export async function createStaffInvite(actor, eventId, { role, invitedAlias = null, ttlHours = 48 } = {}, c = db) {
  if (!VALID_STAFF_ROLES.includes(role)) {
    throw new HttpError(400, 'validation', `Invalid staff role: choose from ${VALID_STAFF_ROLES.join(', ')}`);
  }
  await authorize(actor, 'event.manage_staff', { eventId }, c);

  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);

  const invite = (await c.query(
    `INSERT INTO event_staff_invites (event_id, role, token, invited_by, invited_alias, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [eventId, role, token, actor.id, invitedAlias || null, expiresAt]
  )).rows[0];

  await audit(`user:${actor.id}`, 'event.staff_invite_create', invite.id, {
    eventId,
    role,
    invitedAlias
  }, c);

  return {
    ok: true,
    inviteId: invite.id,
    token: invite.token,
    role: invite.role,
    expiresAt: invite.expires_at,
    inviteUrl: `/staff/join?token=${encodeURIComponent(invite.token)}`
  };
}

/**
 * Validates a staff invite token without consuming it.
 */
export async function getStaffInvite(token, c = db) {
  if (!token || typeof token !== 'string') throw new HttpError(400, 'validation', 'Invite token is required');

  const invite = (await c.query(
    `SELECT esi.*, e.title AS event_title, e.start_at AS event_start_at, e.city AS event_city,
            u.alias AS invited_by_alias
       FROM event_staff_invites esi
       JOIN events e ON e.id = esi.event_id
       JOIN users u ON u.id = esi.invited_by
      WHERE esi.token = $1`,
    [token.trim()]
  )).rows[0];

  if (!invite) throw new HttpError(404, 'invalid_invite', 'This invite link is invalid or does not exist');
  if (invite.status !== 'pending' || new Date(invite.expires_at) <= new Date()) {
    throw new HttpError(410, 'expired_invite', 'This invite link has expired or has already been used');
  }

  return {
    id: invite.id,
    eventId: invite.event_id,
    eventTitle: invite.event_title,
    eventCity: invite.event_city,
    eventStartAt: invite.event_start_at,
    role: invite.role,
    roleLabel: STAFF_ROLE_LABELS[invite.role] || invite.role,
    invitedByAlias: invite.invited_by_alias,
    expiresAt: invite.expires_at
  };
}

/**
 * Consumes a staff invite token and adds the user to event_team.
 */
export async function acceptStaffInvite(user, token, c = db) {
  if (!user || !user.id) throw new HttpError(401, 'unauthorized', 'Please sign in to accept this staff invitation');

  return c.tx(async (txClient) => {
    const invite = (await txClient.query(
      `SELECT * FROM event_staff_invites WHERE token = $1 FOR UPDATE`,
      [token.trim()]
    )).rows[0];

    if (!invite) throw new HttpError(404, 'invalid_invite', 'This invite link is invalid');
    if (invite.status !== 'pending' || new Date(invite.expires_at) <= new Date()) {
      throw new HttpError(410, 'expired_invite', 'This invite link has expired or has already been used');
    }

    // Add or update event_team row
    const existing = (await txClient.query(
      `SELECT * FROM event_team WHERE event_id = $1 AND user_id = $2 FOR UPDATE`,
      [invite.event_id, user.id]
    )).rows[0];

    let row;
    if (existing) {
      row = (await txClient.query(
        `UPDATE event_team
            SET team_role = $3,
                status = 'active',
                invited_by = $4,
                revoked_by = NULL,
                revoked_at = NULL,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [existing.id, invite.event_id, invite.role, invite.invited_by]
      )).rows[0];
    } else {
      row = (await txClient.query(
        `INSERT INTO event_team (event_id, user_id, team_role, status, invited_by)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING *`,
        [invite.event_id, user.id, invite.role, invite.invited_by]
      )).rows[0];
    }

    // Mark invite accepted
    await txClient.query(
      `UPDATE event_staff_invites
          SET status = 'accepted',
              accepted_by = $2,
              accepted_at = now()
        WHERE id = $1`,
      [invite.id, user.id]
    );

    await audit(`user:${user.id}`, 'event.staff_invite_accept', invite.id, {
      eventId: invite.event_id,
      role: invite.role,
      teamMemberId: row.id
    }, txClient);

    return {
      ok: true,
      eventId: invite.event_id,
      role: invite.role,
      roleLabel: STAFF_ROLE_LABELS[invite.role] || invite.role
    };
  });
}
