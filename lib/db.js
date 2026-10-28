// lib/db.js - Postgres access (pg Pool). Postgres only: there is no SQLite fallback.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

// BIGINT (int8) → JS number when safe; Telegram ids fit in 2^53.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

// DATE → 'YYYY-MM-DD' string. A JS Date would be local midnight and can shift a day in UTC.
pg.types.setTypeParser(1082, (v) => v);

let pool = null;

export class DbNotConfiguredError extends Error {
  constructor() {
    super('DATABASE_URL is not configured');
    this.code = 'DB_NOT_CONFIGURED';
  }
}

export function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new DbNotConfiguredError();
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString) || connectionString.includes('host=/');
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: local || /sslmode=disable/.test(connectionString) ? false : { rejectUnauthorized: true }
  });
  pool.on('error', (err) => logger.error('pg pool error', err));
  return pool;
}

export const db = {
  /** Parameterized query. Always use $1..$n placeholders. */
  async query(text, params = []) {
    return getPool().query(text, params);
  },

  async one(text, params = []) {
    const { rows } = await getPool().query(text, params);
    return rows[0] || null;
  },

  /**
   * Run fn(client) inside a transaction. client.query has the same shape as db.query.
   * Rolls back on any throw.
   */
  async tx(fn) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be broken */ }
      throw err;
    } finally {
      client.release();
    }
  },

  async ping() {
    const { rows } = await getPool().query('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  },

  async close() {
    if (pool) {
      const p = pool;
      pool = null;
      await p.end();
    }
  }
};

/** Apply pending migrations from migrations/*.sql in filename order, tracked in schema_migrations. */
export async function migrate({ log = true } = {}) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.tx(async (c) => {
      // Serialize concurrent migrators (e.g. parallel builds).
      await c.query('SELECT pg_advisory_xact_lock(724501)');
      const again = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (again.rowCount) return;
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      ran.push(file);
    });
    if (log) logger.info('migration applied', { file });
  }
  return ran;
}
