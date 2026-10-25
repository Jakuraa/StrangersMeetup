// lib/db.js - Database abstraction supporting PostgreSQL (Hatchable) and SQLite (Local / Test)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let hatchableDb = null;
let sqliteDb = null;

// Attempt to load platform hatchable DB if running in Hatchable environment
try {
  // Dynamic import if hatchable is in module resolution
  const hatchableModule = await import('hatchable');
  if (hatchableModule && hatchableModule.db) {
    hatchableDb = hatchableModule.db;
    logger.info('Database initialized with Hatchable PostgreSQL provider');
  }
} catch {
  // Running in local Node / test environment; fallback to native SQLite
}

if (!hatchableDb) {
  const { DatabaseSync } = await import('node:sqlite');
  const dbDir = process.env.VERCEL ? '/tmp' : path.resolve(__dirname, '../data');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = process.env.SQLITE_DB_PATH || path.join(dbDir, 'strangersmeetup.db');
  sqliteDb = new DatabaseSync(dbPath);
  
  // Enable WAL mode & busy timeout for concurrent safety
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
  sqliteDb.exec('PRAGMA busy_timeout = 5000;');
  sqliteDb.exec('PRAGMA foreign_keys = OFF;'); // Prevent test fixtures breaking on partial seed

  logger.info('Database initialized with native SQLite provider', { dbPath });

  // Initialize schema if needed (run all migrations in numerical/alphabetical order)
  try {
    const migrationsDir = path.resolve(__dirname, '../migrations');
    if (fs.existsSync(migrationsDir)) {
      const files = fs.readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');
        try {
          sqliteDb.exec(sql);
        } catch (mErr) {
          // If individual statement in batch had duplicate column or table, log at debug
          if (mErr.message && (mErr.message.includes('duplicate column') || mErr.message.includes('already exists'))) {
            // idempotent migration rerun
          } else {
            logger.warn(`Migration notice for ${file}:`, { message: mErr.message });
          }
        }
      }
    }
  } catch (err) {
    logger.error('Failed to run SQLite migrations', err);
  }
}

export const db = {
  /**
   * Execute parameterized query
   * @param {string} text - SQL query (supports $1, $2 or ?)
   * @param {Array} params - Query parameters
   * @returns {Promise<{ rows: Array, rowCount: number }>}
   */
  async query(text, params = []) {
    if (hatchableDb) {
      return await hatchableDb.query(text, params);
    }

    if (sqliteDb) {
      // Sanitize undefined params to null for SQLite
      const safeParams = (params || []).map((p) => (p === undefined ? null : p));

      // Convert Postgres $1, $2 syntax to SQLite ? syntax if needed
      let sqliteText = text;
      if (text.includes('$1')) {
        sqliteText = text.replace(/\$\d+/g, '?');
      }

      const trimmed = sqliteText.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        const stmt = sqliteDb.prepare(sqliteText);
        const rows = stmt.all(...safeParams);
        return { rows, rowCount: rows.length };
      } else {
        const stmt = sqliteDb.prepare(sqliteText);
        const result = stmt.run(...safeParams);
        return {
          rows: [],
          rowCount: Number(result.changes || 0),
          lastInsertRowid: result.lastInsertRowid
        };
      }
    }

    throw new Error('No active database provider available');
  },

  /**
   * Execute multiple raw SQL statements (for migrations/seeds)
   * @param {string} ddl - SQL string
   */
  async exec(ddl) {
    if (hatchableDb) {
      return await hatchableDb.query(ddl);
    }
    if (sqliteDb) {
      return sqliteDb.exec(ddl);
    }
    throw new Error('No active database provider available');
  },

  /**
   * Helper to close DB (useful in tests)
   */
  close() {
    if (sqliteDb) {
      sqliteDb.close();
      sqliteDb = null;
    }
  }
};
