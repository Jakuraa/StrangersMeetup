// scripts/seed-guard.js - Refuse to seed or reset anything that might be a real database.
// demo  : sample events (is_demo=true). Local DBs, or a remote preview DB with SEED_ALLOW_REMOTE=true.
// reset : drop and rebuild the schema. Local DBs only, never with a remote URL, never in production.
// local : test personas + their events (seed-local.js). Local DBs only; there is no remote override.
import { isLocalDatabaseUrl, databaseName } from '../lib/db.js';

export class SeedRefused extends Error {}

export function assertSeedAllowed({ kind, e = process.env } = {}) {
  const url = e.DATABASE_URL;
  if (!url) throw new SeedRefused('DATABASE_URL is not set');
  if (e.VERCEL_ENV === 'production' || e.NODE_ENV === 'production') {
    throw new SeedRefused(`refusing to ${kind === 'reset' ? 'reset' : 'seed'}: this looks like production (VERCEL_ENV/NODE_ENV)`);
  }
  const local = isLocalDatabaseUrl(url);
  if (kind === 'reset') {
    if (e.VERCEL || !local) throw new SeedRefused('refusing to reset: only a database on this machine can be reset');
    return { local, database: databaseName(url) };
  }
  if (kind === 'local') {
    if (e.VERCEL || !local) throw new SeedRefused('refusing to seed test personas: only a database on this machine can hold them');
    return { local, database: databaseName(url) };
  }
  if (!local && e.SEED_ALLOW_REMOTE !== 'true') {
    throw new SeedRefused('refusing to seed a non-local database; set SEED_ALLOW_REMOTE=true only for a dedicated preview database');
  }
  return { local, database: databaseName(url) };
}
