// lib/services/event-announcements.js - Event announcements and operational updates.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { audit } from '../audit.js';
import { authorize } from './permissions.js';
import { enqueue } from './notifications.js';

export async function listEventAnnouncements(user, eventId, c = db) {
  // Allow organisers, event staff, and attendees of the event
  const isStaffOrOrg = await authorize(user, 'event.view_guests', { eventId }, c).then(() => true).catch(() => false);
  if (!isStaffOrOrg) {
    const isAttendee = (await c.query(
      `SELECT 1 FROM bookings WHERE event_id = $1 AND user_id = $2 AND status IN ('confirmed', 'checked_in')`,
      [eventId, user.id]
    )).rowCount > 0;
    if (!isAttendee) throw new HttpError(404, 'not_found', 'Event not found');
  }

  const { rows } = await c.query(
    `SELECT ea.id, ea.title, ea.message, ea.is_pinned, ea.created_at,
            u.alias AS sender_alias
       FROM event_announcements ea
       JOIN users u ON u.id = ea.sender_user_id
      WHERE ea.event_id = $1
      ORDER BY ea.is_pinned DESC, ea.created_at DESC`,
    [eventId]
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    message: r.message,
    isPinned: Boolean(r.is_pinned),
    createdAt: r.created_at,
    senderAlias: r.sender_alias || 'Event Team'
  }));
}

export async function createEventAnnouncement(actor, eventId, { title, message, isPinned = false, notifyAttendees = true } = {}, c = db) {
  await authorize(actor, 'event.announcements', { eventId }, c);

  const t = typeof title === 'string' ? title.trim() : '';
  const m = typeof message === 'string' ? message.trim() : '';

  if (!t || t.length < 3 || t.length > 120) {
    throw new HttpError(400, 'validation', 'Title must be between 3 and 120 characters', {
      fields: [{ field: 'title', message: '3-120 characters required' }]
    });
  }
  if (!m || m.length < 5 || m.length > 3000) {
    throw new HttpError(400, 'validation', 'Message must be between 5 and 3000 characters', {
      fields: [{ field: 'message', message: '5-3000 characters required' }]
    });
  }

  return c.tx(async (txClient) => {
    const row = (await txClient.query(
      `INSERT INTO event_announcements (event_id, sender_user_id, title, message, is_pinned, notify_attendees)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [eventId, actor.id, t, m, Boolean(isPinned), Boolean(notifyAttendees)]
    )).rows[0];

    let notificationCount = 0;
    if (notifyAttendees) {
      const attendees = (await txClient.query(
        `SELECT DISTINCT user_id FROM bookings WHERE event_id = $1 AND status IN ('confirmed', 'checked_in')`,
        [eventId]
      )).rows;

      for (const a of attendees) {
        await enqueue(txClient, {
          kind: 'event_update',
          userId: a.user_id,
          eventId,
          announcementId: row.id,
          title: t,
          text: m,
          dedupeKey: `ann:${row.id}:${a.user_id}`
        });
        notificationCount++;
      }
    }

    await audit(`user:${actor.id}`, 'event.announcement_create', row.id, {
      eventId,
      title: t,
      notifyAttendees: Boolean(notifyAttendees),
      recipientCount: notificationCount
    }, txClient);

    return {
      ok: true,
      announcement: {
        id: row.id,
        title: row.title,
        message: row.message,
        isPinned: row.is_pinned,
        createdAt: row.created_at
      },
      notifiedAttendees: notificationCount
    };
  });
}
