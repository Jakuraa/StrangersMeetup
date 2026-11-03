// lib/handlers/upi-checkout.js - HTTP routes for UPI-first checkout, status polling, and PhonePe webhooks.
import { sendJson, sendHtml, redirect, readRawBody, readJson, hashIp, HttpError } from '../http.js';
import { getSessionUser } from '../session.js';
import { rateLimit } from '../ratelimit.js';
import { db } from '../db.js';
import {
  createUpiPaymentIntent,
  getUpiPaymentStatus,
  claimUpiBooking,
  processUpiWebhook
} from '../services/upi-payments.js';
import { renderUpiCheckout } from '../views/checkout-upi.js';
import { WebhookSignatureError } from '../upi/adapter.js';
import { logger } from '../logger.js';

function isMobileUserAgent(ua = '') {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

/**
 * GET /checkout/:slug/upi - Renders the UPI-First interactive checkout view.
 */
export async function upiCheckoutPage({ req, res, params, query, ip }) {
  const slug = params.slug;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new HttpError(404, 'not_found', 'Event not found');

  await rateLimit(`upi_page:${hashIp(ip)}`, 60, 600);
  const user = await getSessionUser(req);
  if (!user && query.get('guest') !== '1') {
    const nextUrl = req.url || `/checkout/${slug}/upi`;
    return redirect(res, `/signin?next=${encodeURIComponent(nextUrl)}`);
  }

  const ua = req.headers['user-agent'] || '';
  const deviceType = isMobileUserAgent(ua) ? 'mobile' : 'desktop';

  // Fetch event details
  const event = await db.one(
    `SELECT id, slug, title, city, status, start_at, capacity FROM events
     WHERE slug = $1 AND status = 'published'`,
    [slug]
  );
  if (!event) throw new HttpError(404, 'event_not_found', 'This event is not available');

  // Determine tier
  let tierId = query.get('tier') || query.get('ticket_type_id');
  let tier;
  if (tierId) {
    tier = await db.one(
      `SELECT id, name, kind, price_paise, max_per_booking FROM ticket_types
       WHERE id = $1 AND event_id = $2 AND active`,
      [tierId, event.id]
    );
  } else {
    tier = await db.one(
      `SELECT id, name, kind, price_paise, max_per_booking FROM ticket_types
       WHERE event_id = $1 AND active AND kind = 'paid'
       ORDER BY sort_order ASC, price_paise ASC LIMIT 1`,
      [event.id]
    );
  }

  if (!tier || tier.kind !== 'paid') {
    throw new HttpError(404, 'ticket_not_found', 'No paid ticket tier available for checkout');
  }

  const qty = parseInt(query.get('qty') || query.get('quantity'), 10) || 1;

  // Create payment intent
  const order = await createUpiPaymentIntent({
    slug,
    user,
    ticketTypeId: tier.id,
    quantity: qty,
    deviceType,
    clientIp: ip
  });

  const html = renderUpiCheckout({
    order,
    event,
    tier,
    user
  });

  sendHtml(res, 200, html);
}

/**
 * POST /api/checkout/upi/intent - Server API to create UPI payment intent.
 */
export async function createUpiIntentApi({ req, res, ip }) {
  await rateLimit(`upi_intent:${hashIp(ip)}`, 30, 600);
  const user = await getSessionUser(req);
  const body = await readJson(req);

  const slug = body.slug;
  const ticketTypeId = body.ticketTypeId;
  const quantity = body.quantity || 1;
  const ua = req.headers['user-agent'] || '';
  const deviceType = body.deviceType || (isMobileUserAgent(ua) ? 'mobile' : 'desktop');

  if (!slug || !ticketTypeId) {
    throw new HttpError(400, 'validation', 'slug and ticketTypeId are required');
  }

  const order = await createUpiPaymentIntent({
    slug,
    user,
    ticketTypeId,
    quantity,
    deviceType,
    clientIp: ip
  });

  sendJson(res, 200, { ok: true, ...order, order });
}

/**
 * GET /api/checkout/upi/status/:orderId - Client polling endpoint.
 */
export async function getUpiStatusApi({ req, res, params, query, ip }) {
  const orderId = params.id || params.orderid || params.orderId;
  if (!orderId || !/^[A-Za-z0-9_-]{8,80}$/.test(orderId)) {
    throw new HttpError(400, 'validation', 'Invalid order ID');
  }

  await rateLimit(`upi_poll:${hashIp(ip)}`, 180, 60);
  const user = await getSessionUser(req);
  const guestToken = query.get('token') || req.headers['x-guest-token'] || null;
  const checkGateway = query.get('check') === '1';

  const status = await getUpiPaymentStatus(orderId, { user, guestToken, checkGateway });
  sendJson(res, 200, { ok: true, ...status });
}

/**
 * POST /api/checkout/upi/claim - Allows an authenticated attendee to claim a guest booking.
 */
export async function claimUpiBookingApi({ req, res, ip }) {
  await rateLimit(`upi_claim:${hashIp(ip)}`, 30, 600);
  const user = await getSessionUser(req);
  if (!user) {
    throw new HttpError(401, 'unauthorized', 'Must be signed in to claim a booking');
  }

  const body = await readJson(req);
  const orderId = body.orderId;
  const guestToken = body.guestToken || req.headers['x-guest-token'];

  if (!orderId || !guestToken) {
    throw new HttpError(400, 'validation', 'orderId and guestToken are required');
  }

  const claim = await claimUpiBooking({ orderId, guestToken, user });
  sendJson(res, 200, { ok: true, ...claim });
}

/**
 * POST /api/payments/webhook/phonepe - Webhook receiver for PhonePe PG callbacks.
 */
export async function phonepeWebhook({ req, res, ip }) {
  await rateLimit(`phonepe_hook:${hashIp(ip)}`, 300, 60);
  const rawBody = await readRawBody(req, 64 * 1024);

  try {
    const result = await processUpiWebhook({
      headers: req.headers,
      rawBody,
      clientIp: ip
    });
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      logger.warn('PhonePe webhook rejected: bad signature');
      await rateLimit(`phonepe_bad_sig:${hashIp(ip)}`, 20, 600);
      return sendJson(res, 401, { ok: false, error: 'invalid_signature' });
    }
    logger.error('PhonePe webhook error', err);
    sendJson(res, 500, { ok: false, error: 'processing_error' });
  }
}
