// lib/logger.js - Structured JSON logs. Never log tokens, initData, cookies or payment payloads.
import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();

const SENSITIVE = /(token|secret|password|authorization|cookie|initdata|init_data|hash|signature|payload|api_key|key_secret|invite_link|link)/i;

function sanitize(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : sanitize(v, depth + 1);
  }
  return out;
}

function write(level, message, context, error) {
  if (process.env.LOG_SILENT === 'true') return;
  const store = requestContext.getStore();
  const line = {
    level,
    ts: new Date().toISOString(),
    reqId: store?.reqId,
    msg: message,
    ctx: context && Object.keys(context).length ? sanitize(context) : undefined,
    err: error ? { name: error.name, message: String(error.message || '').slice(0, 300), code: error.code } : undefined
  };
  const s = JSON.stringify(line);
  if (level === 'error') console.error(s);
  else if (level === 'warn') console.warn(s);
  else console.log(s);
}

export const logger = {
  info: (message, context = {}) => write('info', message, context),
  warn: (message, context = {}) => write('warn', message, context),
  error: (message, error = null, context = {}) => write('error', message, context, error)
};
