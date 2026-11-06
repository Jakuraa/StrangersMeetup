// lib/handlers/saved-events.js - HTTP handlers for attendee saved events / bookmarks.
import { sendJson, readJson, HttpError } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import { saveEvent, unsaveEvent, listSavedEvents, listSavedEventIds, isEventSaved } from '../services/saved-events.js';

export async function getMySavedEvents({ req, res }) {
  const user = await requireUser(req);
  const events = await listSavedEvents(user.id);
  sendJson(res, 200, { ok: true, events });
}

export async function getMySavedEventIds({ req, res }) {
  const user = await requireUser(req);
  const savedIds = await listSavedEventIds(user.id);
  sendJson(res, 200, { ok: true, savedIds });
}

export async function saveEventHandler({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`save:${user.id}`, 60, 60);

  let eventId = params.id || params.eventId;
  if (!eventId) {
    const body = await readJson(req).catch(() => ({}));
    eventId = body.eventId;
  }
  if (!eventId) throw new HttpError(400, 'missing_event_id', 'Event ID required');

  const result = await saveEvent(user.id, eventId);
  sendJson(res, 200, result);
}

export async function unsaveEventHandler({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`unsave:${user.id}`, 60, 60);

  let eventId = params.id || params.eventId;
  if (!eventId) {
    const body = await readJson(req).catch(() => ({}));
    eventId = body.eventId;
  }
  if (!eventId) throw new HttpError(400, 'missing_event_id', 'Event ID required');

  const result = await unsaveEvent(user.id, eventId);
  sendJson(res, 200, result);
}

export async function toggleSaveEventHandler({ req, res, params }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`togglesave:${user.id}`, 60, 60);

  let eventId = params.id || params.eventId;
  if (!eventId) {
    const body = await readJson(req).catch(() => ({}));
    eventId = body.eventId;
  }
  if (!eventId) throw new HttpError(400, 'missing_event_id', 'Event ID required');

  const currentlySaved = await isEventSaved(user.id, eventId);
  const result = currentlySaved
    ? await unsaveEvent(user.id, eventId)
    : await saveEvent(user.id, eventId);

  sendJson(res, 200, result);
}
