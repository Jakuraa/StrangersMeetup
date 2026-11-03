// lib/handlers/bookings.js - Member booking reads (session).
import { sendJson, HttpError } from '../http.js';
import { requireUser } from '../session.js';
import { listUserBookings, getUserBooking } from '../services/bookings.js';

export async function myBookings({ req, res }) {
  const user = await requireUser(req);
  sendJson(res, 200, { ok: true, bookings: await listUserBookings(user.id) });
}

export async function getBooking({ req, res, params }) {
  const user = await requireUser(req);
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) throw new HttpError(404, 'not_found', 'Booking not found');
  const booking = await getUserBooking(user.id, params.id);
  if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');
  sendJson(res, 200, { ok: true, booking });
}
