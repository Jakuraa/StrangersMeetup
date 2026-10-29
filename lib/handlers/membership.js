// lib/handlers/membership.js - POST /api/membership/checkout → Telegram Stars invoice link;
// POST /api/membership/superprofile/webhook ← SuperProfile purchase/expiry (via Zapier/Pabbly).
import { readJson, readRawBody, sendJson, hashIp, safeEqual } from '../http.js';
import { requireUser, requireCsrf } from '../session.js';
import { parse, z } from '../validate.js';
import { rateLimit } from '../ratelimit.js';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { createMembershipInvoice } from '../services/membership.js';
import {
  superprofileConfigured, applySuperprofileEvent, WebhookBody, SUPERPROFILE_SECRET_HEADER
} from '../services/superprofile.js';
import { recordIntegrationError } from '../services/insights.js';

const Body = z.object({ tierCode: z.string().regex(/^[a-z0-9_]{1,24}$/) });

export async function membershipCheckout({ req, res, ip }) {
  const user = await requireUser(req);
  requireCsrf(req, user);
  await rateLimit(`mem:${hashIp(ip)}`, 10, 600);
  const { tierCode } = parse(Body, await readJson(req));
  const { invoiceLink, tier } = await createMembershipInvoice(user, tierCode);
  sendJson(res, 200, { ok: true, invoiceLink, tier });
}

// Auth: shared secret in X-Webhook-Secret (SuperProfile itself does not sign requests).
// Duplicate: 200 no-op. Processing error: 500 so the automation retries. The payload is never logged.
export async function superprofileWebhook({ req, res, ip }) {
  if (!superprofileConfigured()) return sendJson(res, 503, { ok: false, error: 'not_configured' });
  const got = req.headers[SUPERPROFILE_SECRET_HEADER];
  if (typeof got !== 'string' || !safeEqual(got, env('SUPERPROFILE_WEBHOOK_SECRET'))) {
    logger.warn('superprofile webhook rejected: bad secret');
    return sendJson(res, 401, { ok: false });
  }
  await rateLimit(`sp:${hashIp(ip)}`, 300, 60);
  let body;
  try { body = JSON.parse(await readRawBody(req, 32 * 1024)); } catch { return sendJson(res, 400, { ok: false, error: 'invalid_json' }); }
  const p = WebhookBody.safeParse(body);
  if (!p.success) return sendJson(res, 400, { ok: false, error: 'validation', fields: p.error.issues.map((i) => i.path.join('.')) });
  try {
    const r = await applySuperprofileEvent(p.data);
    logger.info('superprofile webhook processed', { event: p.data.event, result: r.result, tierMapped: r.tierMapped });
    sendJson(res, 200, { ok: true, ...r });
  } catch (err) {
    await recordIntegrationError('superprofile_webhook', 'processing_failed', String(err.code || err.message));
    logger.error('superprofile webhook failed', err);
    sendJson(res, 500, { ok: false });
  }
}
