// lib/logger.js - Structured logging without leaking sensitive data

const SENSITIVE_KEYS = new Set([
  'token',
  'telegram_bot_token',
  'bot_token',
  'secret',
  'webhook_secret',
  'app_secret',
  'authorization',
  'cookie',
  'password',
  'api_key'
]);

function sanitize(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitize(item, depth + 1));

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || lower.includes('secret') || lower.includes('token')) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = sanitize(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export const logger = {
  info(message, context = {}) {
    console.log(JSON.stringify({
      level: 'INFO',
      timestamp: new Date().toISOString(),
      message,
      context: sanitize(context)
    }));
  },
  warn(message, context = {}) {
    console.warn(JSON.stringify({
      level: 'WARN',
      timestamp: new Date().toISOString(),
      message,
      context: sanitize(context)
    }));
  },
  error(message, error = null, context = {}) {
    console.error(JSON.stringify({
      level: 'ERROR',
      timestamp: new Date().toISOString(),
      message,
      error: error ? { message: error.message, stack: error.stack } : undefined,
      context: sanitize(context)
    }));
  }
};
