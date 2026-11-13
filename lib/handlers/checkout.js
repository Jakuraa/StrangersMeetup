// lib/handlers/checkout.js - GET /checkout/:slug → 302 to the event's SuperProfile page.
// Works signed out (paying is never gated on signing in). HEAD requests (link previews, crawlers)
// never create an intent.
import { redirect, hashIp, HttpError } from '../http.js';
import { getSessionUser } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import { createCheckoutIntent } from '../services/checkout.js';
import { db } from '../db.js';
import { upiCheckoutEnabled } from '../config.js';

export async function checkoutRedirect({ req, res, params, query, ip }) {
  const slug = params.slug;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new HttpError(404, 'not_found', 'Not found');
  if (req.method === 'HEAD') return redirect(res, `/events/${slug}`);
  await rateLimit(`co:${hashIp(ip)}`, 30, 600);

  const ev = await db.one('SELECT checkout_mode FROM events WHERE slug = $1', [slug]);
  if (ev?.checkout_mode === 'upi_direct') {
    if (!upiCheckoutEnabled()) return redirect(res, `/events/${slug}`);
    const qStr = query.toString() ? `?${query.toString()}` : '';
    return redirect(res, `/checkout/${slug}/upi${qStr}`);
  }

  const user = await getSessionUser(req);
  const intent = await createCheckoutIntent({
    slug, user, ticketTypeId: query.get('tier') || null, qty: query.get('qty') || 1
  });
  res.setHeader('Cache-Control', 'no-store');
  if (!intent) return redirect(res, `/events/${slug}`);
  redirect(res, intent.url);
}
