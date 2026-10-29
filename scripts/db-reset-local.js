// scripts/db-reset-local.js - Drop and rebuild a LOCAL StrangersMeetup database, then migrate.
// Usage: npm run db:reset:local -- --yes=<database name> [--seed-demo]
// Refuses unless: not on Vercel, not production, DATABASE_URL is on this machine, --yes names the
// exact database, and that database is empty or already a StrangersMeetup schema. A shared local
// Postgres often holds other projects' databases, so every check is required.
import { fileURLToPath } from 'node:url';
import '../lib/config.js'; // loads a local .env (never on Vercel)
import { db, migrate } from '../lib/db.js';
import { assertSeedAllowed, SeedRefused } from './seed-guard.js';

export const MARKER_MIGRATION = '003_identity_events_bookings.sql';

export function planReset({ argv = process.argv, e = process.env } = {}) {
  const { database } = assertSeedAllowed({ kind: 'reset', e });
  const yes = argv.find((a) => a.startsWith('--yes='))?.slice(6);
  if (!database) throw new SeedRefused('refusing to reset: DATABASE_URL has no database name');
  if (yes !== database) throw new SeedRefused(`refusing to reset: pass --yes=${database} to confirm the database to wipe`);
  return { database, seedDemo: argv.includes('--seed-demo') };
}

/** The database must be empty or carry this project's migration history. */
export async function assertResettable(q = db) {
  const { rows } = await q.query(
    `SELECT count(*)::int AS tables, bool_or(table_name = 'schema_migrations') AS has_migrations
       FROM information_schema.tables WHERE table_schema = 'public'`);
  if (!rows[0].tables) return 'empty';
  if (rows[0].has_migrations) {
    const m = await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [MARKER_MIGRATION]);
    if (m.rowCount) return 'strangersmeetup';
  }
  throw new SeedRefused('refusing to reset: this database has tables but no StrangersMeetup migration history');
}

async function main() {
  let plan;
  try {
    plan = planReset();
    await assertResettable();
  } catch (err) {
    console.error(`[db:reset:local] ${err.message}`);
    await db.close();
    process.exit(1);
  }
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const ran = await migrate({ log: false });
    console.log(`[db:reset:local] ${plan.database}: schema rebuilt, ${ran.length} migrations applied`);
    if (plan.seedDemo) {
      const { seedDemo } = await import('./seed-demo.js');
      console.log(`[db:reset:local] demo events upserted: ${await seedDemo()}`);
    }
  } catch (err) {
    console.error('[db:reset:local] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
