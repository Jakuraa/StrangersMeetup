// lib/handlers/telegram.js - POST /api/telegram/webhook
// 1) constant-time check of X-Telegram-Bot-Api-Secret-Token  2) dedupe by update_id
// 3) route; on failure release the dedupe row and return 500 so Telegram retries.
import { db } from '../db.js';
import { readRawBody, sendJson, safeEqual } from '../http.js';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { handleUpdate } from '../telegram/bot.js';
import { TelegramNotConfiguredError } from '../telegram/api.js';
import { recordIntegrationError } from '../services/insights.js';

export async function telegramWebhook({ req, res }) {
  const expected = env('TELEGRAM_WEBHOOK_SECRET');
  const got = req.headers['x-telegram-bot-api-secret-token'];
  if (!expected || typeof got !== 'string' || !safeEqual(got, expected)) {
    logger.warn('telegram webhook rejected: bad secret');
    return sendJson(res, 401, { ok: false });
  }
  let update;
  try {
    update = JSON.parse(await readRawBody(req, 256 * 1024));
  } catch {
    return sendJson(res, 400, { ok: false });
  }
  if (!Number.isSafeInteger(update?.update_id)) return sendJson(res, 400, { ok: false });

  const key = String(update.update_id);
  const ins = await db.query(
    `INSERT INTO webhook_events (provider, event_id) VALUES ('telegram_update', $1) ON CONFLICT DO NOTHING RETURNING id`, [key]);
  if (!ins.rowCount) return sendJson(res, 200, { ok: true, duplicate: true });

  try {
    const kind = await handleUpdate(update);
    await db.query(`UPDATE webhook_events SET processed_at = now(), result = $2 WHERE id = $1`, [ins.rows[0].id, kind]);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof TelegramNotConfiguredError) {
      // Cannot reply without a token; acknowledge so Telegram does not retry forever.
      await db.query(`UPDATE webhook_events SET processed_at = now(), result = 'not_configured' WHERE id = $1`, [ins.rows[0].id]);
      return sendJson(res, 200, { ok: true });
    }
    await db.query('DELETE FROM webhook_events WHERE id = $1', [ins.rows[0].id]);
    await recordIntegrationError('telegram_webhook', 'update_failed', String(err.code || err.message));
    logger.error('telegram update failed', err, { updateId: update.update_id });
    sendJson(res, 500, { ok: false });
  }
}
