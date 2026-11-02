// mcp/config.js - Configuration and environment isolation for the StrangersMeetup Control MCP.
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const MCP_DIR = path.resolve(REPO_ROOT, '.mcp');
export const SCREENSHOTS_DIR = path.resolve(MCP_DIR, 'screenshots');
export const AUDIT_LOG_FILE = path.resolve(MCP_DIR, 'audit.jsonl');

// Ensure runtime directories exist with restrictive permissions (0700)
if (!fs.existsSync(MCP_DIR)) fs.mkdirSync(MCP_DIR, { recursive: true, mode: 0o700 });
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true, mode: 0o700 });

export const MCP_PORT = parseInt(process.env.PORT || process.env.MCP_PORT || '3333', 10);

// Cloud-hosting detection: Render or container deployment
export const IS_CLOUD_HOSTED = Boolean(
  process.env.RENDER ||
  process.env.MCP_HOST === '0.0.0.0' ||
  (process.env.NODE_ENV === 'production' && !process.env.MCP_LOCAL)
);

// Bind to 0.0.0.0 in cloud containers (Render), 127.0.0.1 in local development
export const MCP_HOST = process.env.MCP_HOST || (IS_CLOUD_HOSTED ? '0.0.0.0' : '127.0.0.1');

export const APP_PORT = parseInt(process.env.APP_PORT || '3000', 10);
export const APP_ORIGIN = process.env.WEBSITE_URL || process.env.PUBLIC_SITE_URL || `http://127.0.0.1:${APP_PORT}`;

// Bearer API Key management: loads from MCP_API_KEY env or generates a local high-entropy key
function loadOrGenerateApiKey() {
  if (process.env.MCP_API_KEY && process.env.MCP_API_KEY.length >= 16) {
    return process.env.MCP_API_KEY;
  }
  // In production cloud environments, fail closed if no explicit key is configured
  if (IS_CLOUD_HOSTED) {
    throw new Error('MCP_API_KEY environment variable is required in production/cloud environments');
  }
  const keyFile = path.resolve(MCP_DIR, '.mcp_key');
  if (fs.existsSync(keyFile)) {
    const existing = fs.readFileSync(keyFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const generated = `sm_mcp_${crypto.randomBytes(24).toString('hex')}`;
  try {
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  } catch {}
  return generated;
}

export const MCP_API_KEY = loadOrGenerateApiKey();

/**
 * Strips remote database credentials and sensitive secrets from the MCP process environment
 * to prevent accidental leak or misuse.
 */
export function sanitizeMcpEnvironment() {
  const sensitiveVars = [
    'DATABASE_URL',
    'DATABASE_URL_UNPOOLED',
    'PREVIEW_DATABASE_URL',
    'CRON_SECRET',
    'SESSION_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'SUPERPROFILE_API_KEY',
    'SUPERPROFILE_WEBHOOK_SECRET',
    'ADMIN_BOOTSTRAP_TELEGRAM_ID'
  ];

  for (const v of sensitiveVars) {
    if (process.env[v] && !process.env[v].includes('localhost') && !process.env[v].includes('127.0.0.1')) {
      delete process.env[v];
    }
  }
}

// Sanitize on module load
sanitizeMcpEnvironment();
