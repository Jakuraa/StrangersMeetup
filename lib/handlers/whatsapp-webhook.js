// lib/handlers/whatsapp-webhook.js - Webhook verification and event ingestion for Meta WhatsApp Cloud API.
import { HttpError, readRawBody, sendJson } from '../http.js';
import { logger } from '../logger.js';
import { getWhatsAppConfig, getWhatsAppProvider } from '../services/whatsapp-provider.js';
import { updateDeliveryReceipt, handleOptOutKeyword } from '../services/notification-dispatcher.js';

const OPT_OUT_KEYWORDS = new Set(['STOP', 'UNSUBSCRIBE', 'OPTOUT', 'CANCEL', 'BLOCK', 'QUIT']);

/**
 * GET /api/webhooks/whatsapp — Meta webhook verification challenge.
 */
export async function verifyWebhook({ res, query }) {
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  const challenge = query.get('hub.challenge');

  const config = getWhatsAppConfig();
  const expectedToken = config.webhookVerifyToken || 'nightlifez_webhook_verify_token';

  if (mode === 'subscribe' && token === expectedToken) {
    logger.info('meta whatsapp webhook verification challenge accepted');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(challenge || '');
    return;
  }

  logger.warn('meta whatsapp webhook verification challenge failed', { mode, tokenProvided: Boolean(token) });
  throw new HttpError(403, 'forbidden', 'Verification token mismatch');
}

/**
 * POST /api/webhooks/whatsapp — Meta webhook notification receiver.
 */
export async function handleWebhook({ req, res }) {
  const rawBody = await readRawBody(req);
  const signature = req.headers['x-hub-signature-256'];
  const provider = getWhatsAppProvider();

  const config = getWhatsAppConfig();
  // Only enforce signature check if secret is configured
  if (config.webhookSecret || process.env.NODE_ENV === 'test') {
    if (!signature || !provider.verifyWebhookSignature({ rawBody, signatureHeader: signature })) {
      logger.warn('meta whatsapp webhook signature verification failed');
      throw new HttpError(401, 'invalid_signature', 'Invalid webhook signature');
    }
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Malformed JSON payload');
  }

  if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return sendJson(res, 200, { ok: true, ignored: true });
  }

  for (const entry of body.entry) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const val = change.value;
      if (!val) continue;

      // 1. Process delivery and read receipts
      if (Array.isArray(val.statuses)) {
        for (const s of val.statuses) {
          const providerMessageId = s.id;
          const status = s.status; // 'sent', 'delivered', 'read', 'failed'
          const timestamp = s.timestamp ? new Date(parseInt(s.timestamp, 10) * 1000) : new Date();
          const err = s.errors?.[0]?.message || s.errors?.[0]?.title;

          await updateDeliveryReceipt({
            providerMessageId,
            status,
            timestamp,
            errorMessage: err
          });
        }
      }

      // 2. Process incoming user messages (keyword opt-outs e.g. STOP)
      if (Array.isArray(val.messages)) {
        for (const msg of val.messages) {
          if (msg.type === 'text') {
            const text = (msg.text?.body || '').trim().toUpperCase();
            if (OPT_OUT_KEYWORDS.has(text)) {
              const rawFrom = String(msg.from || '').replace(/^\+/, '');
              const normalizedPhone = `+${rawFrom}`;
              logger.info('received whatsapp STOP keyword from user', {
                sender: normalizedPhone.slice(0, 5) + '****'
              });
              await handleOptOutKeyword({
                destination: normalizedPhone,
                channel: 'whatsapp',
                reason: 'keyword_opt_out'
              });
            }
          }
        }
      }
    }
  }

  return sendJson(res, 200, { ok: true });
}
