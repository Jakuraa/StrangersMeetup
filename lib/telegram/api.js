// lib/telegram/api.js - Minimal Bot API client. No mock mode: without a token every call throws
// TelegramNotConfiguredError and callers record the failure (e.g. invite "NOT CONFIGURED").
import { botToken, env } from '../config.js';

export class TelegramNotConfiguredError extends Error {
  constructor() {
    super('NOT CONFIGURED: TELEGRAM_BOT_TOKEN');
    this.code = 'TG_NOT_CONFIGURED';
  }
}

export class TelegramApiError extends Error {
  constructor(method, errorCode, description) {
    super(`Telegram ${method} failed: ${errorCode} ${description}`);
    this.code = 'TG_API_ERROR';
    this.errorCode = errorCode;
    this.description = description;
  }
}

/**
 * Call a Bot API method. TELEGRAM_TEST_ENV=true targets Telegram's test environment
 * (used for sandbox Stars payments).
 */
export async function tg(method, params = {}) {
  const token = botToken();
  if (!token) throw new TelegramNotConfiguredError();
  const testPath = env('TELEGRAM_TEST_ENV') === 'true' ? 'test/' : '';
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${testPath}${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000)
    });
  } catch (err) {
    // Never surface the URL (it contains the token).
    throw new TelegramApiError(method, 0, err.name === 'TimeoutError' ? 'timeout' : 'network error');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new TelegramApiError(method, res.status, 'invalid response');
  }
  if (!data.ok) throw new TelegramApiError(method, data.error_code || res.status, String(data.description || '').slice(0, 200));
  return data.result;
}

/** True when the error means the user has not started the bot / blocked it (DM impossible). */
export function isUnreachableUser(err) {
  return err?.code === 'TG_API_ERROR' && err.errorCode === 403;
}
