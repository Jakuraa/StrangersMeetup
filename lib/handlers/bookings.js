// lib/handlers/bookings.js - Member booking reads (session).
import { sendJson, HttpError, readRawBody } from '../http.js';
import { requireUser } from '../session.js';
import { listUserBookings, getUserBooking, listUserAnnouncements, cancelUserBooking } from '../services/bookings.js';

export async function myBookings({ req, res }) {
  const user = await requireUser(req);
  sendJson(res, 200, { ok: true, bookings: await listUserBookings(user.id) });
}

export async function myAnnouncements({ req, res }) {
  const user = await requireUser(req);
  sendJson(res, 200, { ok: true, announcements: await listUserAnnouncements(user.id) });
}

export async function getBooking({ req, res, params }) {
  const user = await requireUser(req);
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(404, 'not_found', 'Booking not found');
  const booking = await getUserBooking(user.id, params.id);
  if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
  sendJson(res, 200, { ok: true, booking });
}

export async function cancelMyBooking({ req, res, params }) {
  const user = await requireUser(req);
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(404, 'not_found', 'Booking not found');
  let reason = 'Cancelled by attendee';
  try {
    const raw = await readRawBody(req);
    if (raw) {
      const data = JSON.parse(raw);
      if (typeof data.reason === 'string' && data.reason.trim()) {
        reason = data.reason.trim().slice(0, 500);
      }
    }
  } catch {
    // optional body payload
  }
  const result = await cancelUserBooking(user.id, params.id, { reason });
  sendJson(res, 200, result);
}
