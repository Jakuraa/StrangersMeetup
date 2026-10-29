// lib/ratelimit.js - Fixed-window rate limiting stored in Postgres.
import { db } from './db.js';
import { HttpError } from './http.js';

/**
 * Count a hit for `key`; throw 429 when more than `limit` hits occur within `windowSeconds`.
 */
export async function rateLimit(key, limit, windowSeconds) {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const { rows } = await db.query(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowStart]
  );
  if (rows[0].count > limit) {
    const retryAfter = Math.ceil((windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000);
    throw new HttpError(429, 'rate_limited', 'Too many requests. Please try again later.', { retryAfter });
  }
}

export async function pruneRateLimits() {
  const r = await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  return r.rowCount;
}
