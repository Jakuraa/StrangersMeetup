// e2e/env.js - Environment for the browser suite. The server under test always runs with
// DEV_LOGIN=true against a dedicated database on this machine; anything else is refused before a
// server starts or a row is written.
import { isLocalDatabaseUrl } from '../lib/db.js';

export const E2E_PORT = Number(process.env.E2E_PORT || 3100);
export const E2E_BASE = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL || 'postgres://localhost/sm_e2e';

export function assertE2eSafe(e = process.env) {
  if (e.VERCEL) throw new Error('e2e: refusing to run on a deployment');
  if (e.NODE_ENV === 'production' || e.VERCEL_ENV === 'production') throw new Error('e2e: refusing to run with a production environment');
  if (!isLocalDatabaseUrl(E2E_DATABASE_URL)) throw new Error(`e2e: E2E_DATABASE_URL must be a database on this machine (got a remote host)`);
}

/** Exactly what the server process sees. No .env is read, so a real DATABASE_URL can never leak in. */
export const serverEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  SKIP_DOTENV: 'true',
  NODE_ENV: 'development',
  PORT: String(E2E_PORT),
  DATABASE_URL: E2E_DATABASE_URL,
  DEV_LOGIN: 'true',
  SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
  PUBLIC_SITE_URL: E2E_BASE,
  ENABLE_LIVE_PAYMENTS: 'false',
  LOG_SILENT: 'true'
};
