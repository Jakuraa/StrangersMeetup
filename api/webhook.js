// api/webhook.js - Telegram Bot API Webhook Handler
import { verifyWebhookSecret, answerPreCheckoutQuery } from '../lib/telegram.js';
import { validatePreCheckoutQuery, processSuccessfulPayment } from '../lib/entitlements.js';
import { db } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import crypto from 'node:crypto';

export const access = 'public';
export const methods = ['POST'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  }

  // 1. Authenticate secret token header
  const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
  const isAuthorized = await verifyWebhookSecret(secretHeader);

  if (!isAuthorized) {
    logger.warn('Unauthorized webhook request rejected (invalid or missing secret token)');
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid secret token' }));
  }

  const update = req.body;
  if (!update || typeof update !== 'object') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: 'Invalid update payload' }));
  }

  const updateId = update.update_id;
  logger.info('Telegram webhook received update', { updateId });

  try {
    // 2. Handle pre_checkout_query (Mandatory 10-second response window)
    if (update.pre_checkout_query) {
      const pcq = update.pre_checkout_query;
      logger.info('Processing pre_checkout_query', {
        id: pcq.id,
        currency: pcq.currency,
        total_amount: pcq.total_amount,
        fromId: pcq.from?.id
      });

      const validation = await validatePreCheckoutQuery(pcq);
      if (validation.ok) {
        await answerPreCheckoutQuery(pcq.id, true);
        logger.info('Approved pre_checkout_query', { id: pcq.id });
      } else {
        await answerPreCheckoutQuery(pcq.id, false, validation.error);
        logger.warn('Rejected pre_checkout_query', { id: pcq.id, error: validation.error });
      }

      // Record event
      await db.query(
        `INSERT INTO webhook_events (id, update_id, event_type, telegram_user_id, status, error_message, raw_payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (update_id) DO NOTHING`,
        [
          `wh_${crypto.randomBytes(8).toString('hex')}`,
          updateId,
          'pre_checkout_query',
          pcq.from?.id || null,
          validation.ok ? 'SUCCESS' : 'REJECTED',
          validation.error || null,
          JSON.stringify(pcq)
        ]
      );

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, handled: 'pre_checkout_query' }));
    }

    // 3. Handle successful_payment (Subscription checkout or renewal)
    if (update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      const fromUser = update.message.from;
      logger.info('Processing successful_payment', {
        chargeId: sp.telegram_payment_charge_id,
        amount: sp.total_amount,
        currency: sp.currency,
        isRecurring: sp.is_recurring,
        fromId: fromUser?.id
      });

      const result = await processSuccessfulPayment(sp, fromUser);

      // Record event idempotently
      try {
        await db.query(
          `INSERT INTO webhook_events (id, update_id, event_type, idempotency_key, telegram_user_id, status, raw_payload_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            `wh_${crypto.randomBytes(8).toString('hex')}`,
            updateId,
            'successful_payment',
            result.status === 'DUPLICATE' ? `${sp.telegram_payment_charge_id}_dup_${updateId}` : sp.telegram_payment_charge_id,
            fromUser?.id || null,
            result.status,
            JSON.stringify(sp)
          ]
        );
      } catch (logErr) {
        logger.info('Duplicate webhook event not re-logged', { updateId, error: logErr.message });
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, handled: 'successful_payment', result }));
    }

    // Safely acknowledge other Bot updates (chat member changes, commands, etc.)
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, ignored: true }));
  } catch (err) {
    logger.error('Unhandled error in webhook handler', err, { updateId });
    // Telegram will retry if 500 is returned, but we return 200 after logging unrecoverable errors to avoid infinite retry loops on corrupt payloads
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
