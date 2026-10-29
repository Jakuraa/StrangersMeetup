// lib/handlers/health.js - GET /api/health: DB ping + configuration status (names only).
import { db, isDbConfigured } from '../db.js';
import { configStatus } from '../config.js';
import { sendJson } from '../http.js';

export async function health({ res }) {
  let database = 'NOT CONFIGURED';
  if (isDbConfigured()) {
    try {
      database = (await db.ping()) ? 'ok' : 'error';
    } catch {
      database = 'error';
    }
  }
  const config = configStatus();
  const ok = database === 'ok';
  sendJson(res, ok ? 200 : 503, { ok, database, config, version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'local' });
}
