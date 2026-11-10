// lib/services/saved-events.js - Attendee bookmarked/saved events service.
// Supports saving, unsaving, and listing events bookmarked by the signed-in user.
import { db } from '../db.js';
import { HttpError } from '../http.js';
import { toPublicEvent, TIERS_SQL, SEAT_HOLDING_SQL } from './events.js';

const SAVED_SELECT = `
  SELECT e.*,
         (SELECT COALESCE(sum(b.quantity), 0)::int FROM bookings b WHERE b.event_id = e.id AND ${SEAT_HOLDING_SQL}) AS seats_taken,
         (SELECT m.url FROM media m WHERE m.id = e.cover_media_id AND m.authorized_by_owner AND m.visible) AS cover_url,
         ${TIERS_SQL} AS tiers,
         s.created_at AS saved_at
    FROM saved_events s
    JOIN events e ON e.id = s.event_id
`;

/**
 * Save / bookmark an event for a user.
 */
export async function saveEvent(userId, eventId, c = db) {
  if (!userId) throw new HttpError(401, 'unauthorized', 'Sign in required to save events');
  if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) throw new HttpError(400, 'invalid_event', 'Invalid event ID');

  const ev = await c.one(`SELECT id, status FROM events WHERE id = $1`, [eventId]);
  if (!ev) throw new HttpError(404, 'not_found', 'Event not found');

  const { rows } = await c.query(
    `INSERT INTO saved_events (user_id, event_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, event_id) DO NOTHING
     RETURNING id, created_at`,
    [userId, eventId]
  );

  return { ok: true, saved: true, eventId, created: rows.length > 0 };
}

/**
 * Unsave / remove bookmark for an event.
 */
export async function unsaveEvent(userId, eventId, c = db) {
  if (!userId) throw new HttpError(401, 'unauthorized', 'Sign in required');
  if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) throw new HttpError(400, 'invalid_event', 'Invalid event ID');

  const r = await c.query(
    `DELETE FROM saved_events WHERE user_id = $1 AND event_id = $2`,
    [userId, eventId]
  );

  return { ok: true, saved: false, eventId, removed: r.rowCount > 0 };
}

/**
 * Check if a single event is saved by a user.
 */
export async function isEventSaved(userId, eventId, c = db) {
  if (!userId || !eventId) return false;
  const row = await c.one(
    `SELECT 1 FROM saved_events WHERE user_id = $1 AND event_id = $2 LIMIT 1`,
    [userId, eventId]
  );
  return Boolean(row);
}

/**
 * List all event IDs saved by a user (for fast badge/button rendering).
 */
export async function listSavedEventIds(userId, c = db) {
  if (!userId) return [];
  const { rows } = await c.query(
    `SELECT event_id FROM saved_events WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((r) => r.event_id);
}

/**
 * List full public representations of all events saved by a user.
 */
export async function listSavedEvents(userId, c = db) {
  if (!userId) return [];
  const { rows } = await c.query(
    `${SAVED_SELECT}
     WHERE s.user_id = $1 AND e.status IN ('published', 'cancelled')
     ORDER BY s.created_at DESC`,
    [userId]
  );
  return rows.map((r) => {
    const pub = toPublicEvent(r);
    pub.savedAt = r.saved_at ? new Date(r.saved_at).toISOString() : null;
    pub.isSaved = true;
    return pub;
  });
}
