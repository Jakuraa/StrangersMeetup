// lib/handlers/bookings.js - Member booking endpoints (session + CSRF).
import { readJson, sendJson, HttpError, hashIp } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { parse, z } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { ticketProvider } from '../payments/index.js';
import { createBooking as createBookingSvc, listUserBookings, getUserBooking } from '../services/bookings.js';

const Body = z.object({ eventId: z.string().uuid() }).strict();

export async function createBooking({ req, res, ip }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`book:${user.id}`, 10, 600);
  await rateLimit(`bookip:${hashIp(ip)}`, 30, 600);
  const { eventId } = parse(Body, await readJson(req));
  const r = await createBookingSvc(user, eventId, ticketProvider());
  sendJson(res, 200, { ok: true, ...r });
}

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
