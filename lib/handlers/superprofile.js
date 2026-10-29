// lib/handlers/superprofile.js - POST /api/webhooks/superprofile (alias: /api/membership/superprofile/webhook)
//
// SuperProfile has no signed webhooks; Zapier/Pabbly POST here with the shared secret in X-Webhook-Secret.
// Order: secret check (401, before the body is read or any DB write) → rate limit → parse → apply.
// Duplicate: 200 no-op. Processing error: 500 so the automation retries. The payload is never logged.
import { readRawBody, sendJson, hashIp } from '../http.js';
import { ticketProvider, WebhookSignatureError } from '../payments/index.js';
import { superprofileConfigured } from '../payments/superprofile.js';
import { rateLimit } from '../ratelimit.js';
import { logger } from '../logger.js';
import { WebhookBody, applySuperprofileEvent } from '../services/superprofile.js';
import { applyOrderEvent, isTierProduct } from '../services/orders.js';
import { deliverMany } from '../services/notifications.js';
import { recordIntegrationError } from '../services/insights.js';
import { afterResponse } from '../after.js';

export async function superprofileWebhook({ req, res, ip }) {
  if (!superprofileConfigured()) return sendJson(res, 503, { ok: false, error: 'not_configured' });
  try {
    ticketProvider().verifyWebhook(req.headers);
  } catch (err) {
    if (!(err instanceof WebhookSignatureError)) throw err;
    logger.warn('superprofile webhook rejected: bad secret');
    return sendJson(res, 401, { ok: false });
  }
  await rateLimit(`sp:${hashIp(ip)}`, 300, 60);
  let body;
  try { body = JSON.parse(await readRawBody(req, 32 * 1024)); } catch { return sendJson(res, 400, { ok: false, error: 'invalid_json' }); }
  const p = WebhookBody.safeParse(body);
  if (!p.success) return sendJson(res, 400, { ok: false, error: 'validation', fields: p.error.issues.map((i) => i.path.join('.')) });
  const b = p.data;
  try {
    const orderShaped = ['purchase', 'refund', 'cancelled'].includes(b.event);
    const membership = b.event === 'purchase' && await isTierProduct(b);
    if (!orderShaped || membership) {
      // Membership lifecycle (and abandoned checkouts) keep the counts-only flow.
      if (b.event === 'refund' || b.event === 'cancelled') return sendJson(res, 200, { ok: true, result: 'ignored' });
      const r = await applySuperprofileEvent(b);
      logger.info('superprofile webhook processed', { event: b.event, result: r.result, tierMapped: r.tierMapped });
      return sendJson(res, 200, { ok: true, ...r });
    }
    const r = await applyOrderEvent(b);
    logger.info('superprofile order processed', { event: b.event, result: r.result });
    await afterResponse(() => deliverMany(r.notificationIds));
    sendJson(res, 200, { ok: true, result: r.result, tierMapped: false });
  } catch (err) {
    await recordIntegrationError('superprofile_webhook', 'processing_failed', String(err.code || err.message));
    logger.error('superprofile webhook failed', err);
    sendJson(res, 500, { ok: false });
  }
}
