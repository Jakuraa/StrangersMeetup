// lib/handlers/payments.js - POST /api/payments/webhook/:provider
// verify signature → webhook_events (unique) → DB transaction → deliver notifications after commit.
// Bad signature: 401. Duplicate: 200 no-op. Processing error: 500 (transaction rolled back,
// including the webhook_events row, so the provider's retry is processed).
import { readRawBody, sendJson } from '../http.js';
import { providerByName } from '../payments/index.js';
import { applyTicketEvent } from '../services/bookings.js';
import { deliverMany } from '../services/notifications.js';
import { logger } from '../logger.js';
import { afterResponse } from '../after.js';
import { recordIntegrationError } from '../services/insights.js';

export async function paymentWebhook({ req, res, params }) {
  if (!['razorpay', 'cashfree'].includes(params.provider)) return sendJson(res, 404, { ok: false });
  const provider = providerByName(params.provider);
  const raw = await readRawBody(req, 256 * 1024);
  let evt;
  try {
    evt = provider.verifyWebhook(req.headers, raw);
  } catch (err) {
    logger.warn('payment webhook rejected', { provider: params.provider, reason: err.code === 'WEBHOOK_SIGNATURE' ? err.message : 'unparseable' });
    return sendJson(res, err.code === 'WEBHOOK_SIGNATURE' ? 401 : 400, { ok: false });
  }
  let r;
  try {
    r = await applyTicketEvent(provider.name, evt);
  } catch (err) {
    await recordIntegrationError('payment_webhook', `${provider.name}_processing_failed`, String(err.code || err.message));
    throw err;
  }
  logger.info('payment webhook processed', { provider: provider.name, type: evt.type, result: r.result });
  // Notifications are already committed to the outbox; delivery failures are retried by cron.
  await afterResponse(() => deliverMany(r.notificationIds));
  sendJson(res, 200, { ok: true, result: r.result });
}
