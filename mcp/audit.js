// mcp/audit.js - Append-only structured audit logger for MCP operations.
import fs from 'node:fs';
import { AUDIT_LOG_FILE, IS_CLOUD_HOSTED } from './config.js';
import { redactSecrets } from './security.js';

/**
 * Sanitizes arguments before writing to audit log, ensuring no passwords or tokens are stored.
 */
function sanitizeAuditArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const copy = { ...args };
  const sensitiveKeys = ['token', 'password', 'key', 'secret', 'auth', 'cookie'];

  for (const k of Object.keys(copy)) {
    if (sensitiveKeys.some(s => k.toLowerCase().includes(s))) {
      copy[k] = '[REDACTED]';
    } else if (typeof copy[k] === 'string') {
      copy[k] = redactSecrets(copy[k]).slice(0, 500); // Bounded size
    }
  }
  return copy;
}

/**
 * Writes an entry to the append-only audit log with restrictive 0600 permissions.
 */
export function logMcpAudit({ tool, args = {}, status, durationMs, error = null, clientIp = '127.0.0.1' }) {
  const entry = {
    timestamp: new Date().toISOString(),
    tool,
    clientIp,
    args: sanitizeAuditArgs(args),
    status, // 'SUCCESS' | 'ERROR' | 'UNAUTHORIZED' | 'RATE_LIMITED'
    durationMs: typeof durationMs === 'number' ? Math.round(durationMs) : null,
    error: error ? redactSecrets(String(error.message || error)).slice(0, 500) : null
  };

  try {
    if (!fs.existsSync(AUDIT_LOG_FILE)) {
      fs.writeFileSync(AUDIT_LOG_FILE, '', { mode: 0o600, flag: 'wx' });
    } else {
      const currentMode = fs.statSync(AUDIT_LOG_FILE).mode & 0o777;
      if (currentMode !== 0o600) {
        fs.chmodSync(AUDIT_LOG_FILE, 0o600);
      }
    }
    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('Failed to write to MCP audit log:', err.message);
  }

  // Cloud readiness: emit structured audit record to stdout for platform log capture
  if (IS_CLOUD_HOSTED || process.env.MCP_LOG_STDOUT === 'true') {
    try {
      console.log(`[mcp-audit] ${JSON.stringify(entry)}`);
    } catch {}
  }
}
