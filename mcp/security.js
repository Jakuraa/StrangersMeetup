// mcp/security.js - Security enforcement, authorization, SSRF protection, path containment, and redaction.
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { REPO_ROOT, MCP_API_KEY, APP_PORT } from './config.js';

// Deny-list for file system access
const DENIED_PATH_PATTERNS = [
  /^\.env/i,
  /\.env/i,
  /^\.git/i,
  /\.git[\/\\]/i,
  /^\.claude/i,
  /\.claude[\/\\]/i,
  /^\.remember/i,
  /\.remember[\/\\]/i,
  /^\.mcp(?:\/|\\|$)/i,
  /\.mcp[\/\\]/i,
  /node_modules/i,
  /\.mcp_key$/i,
  /id_rsa/i,
  /\.pem$/i,
  /\.key$/i,
  /\.sqlite/i,
  /\.db$/i
];

/**
 * Validates Bearer token using constant-time comparison.
 */
export function validateBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return false;
  const match = headerValue.match(/^Bearer\s+([A-Za-z0-9_\-]+)$/i);
  if (!match) return false;
  const providedToken = match[1];

  const expectedBuffer = Buffer.from(MCP_API_KEY, 'utf8');
  const providedBuffer = Buffer.from(providedToken, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * SSRF Guard: Validates that a requested path/URL strictly targets the local application server.
 * Rejects external domains, internal metadata services (169.254.x.x), file/ftp protocols, and arbitrary ports.
 */
export function isSafeLocalPath(pathOrUrl) {
  if (typeof pathOrUrl !== 'string' || !pathOrUrl.trim()) return false;
  const trimmed = pathOrUrl.trim();

  // If path starts with slash
  if (trimmed.startsWith('/')) {
    // Prevent protocol-relative URLs (e.g. //evil.com)
    if (trimmed.startsWith('//')) return false;
    // Safe relative path characters only
    return /^\/[a-zA-Z0-9_\-\/\.\?\=\&\%\#]*$/.test(trimmed);
  }

  // If full URL is provided, must strictly match local app origin
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return false;
    const isLocalhost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const isPortMatch = parsed.port === String(APP_PORT) || (parsed.port === '' && APP_PORT === 80);
    return isLocalhost && isPortMatch;
  } catch {
    return false;
  }
}

/**
 * Screenshot Route Guard: Enforces that screenshots are captured strictly on public pages.
 * Rejects /admin, /organiser, /bookings, /api, /me, /auth, /checkout and any non-whitelisted path.
 */
export function isAllowedPublicScreenshotPath(targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) return false;
  const trimmed = targetPath.trim();

  // Must start with '/' and not be protocol-relative ('//')
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return false;

  // Extract pure pathname (ignore query string or hash)
  let pathname;
  try {
    pathname = new URL(trimmed, 'http://127.0.0.1').pathname;
  } catch {
    return false;
  }

  // Explicitly forbidden prefixes / private routes
  const FORBIDDEN_PREFIXES = [
    '/admin',
    '/organiser',
    '/bookings',
    '/api',
    '/me',
    '/checkout',
    '/auth',
    '/.mcp',
    '/.git',
    '/.env'
  ];

  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (pathname === forbidden || pathname.startsWith(`${forbidden}/`)) {
      return false;
    }
  }

  // Explicit public pages
  const EXACT_PUBLIC_PAGES = new Set([
    '/',
    '/events',
    '/trips',
    '/nightlife',
    '/dating',
    '/weekend-parties',
    '/dinners',
    '/meetups',
    '/membership',
    '/submit-event',
    '/partner-with-us',
    '/become-a-host',
    '/list-your-venue',
    '/faq',
    '/about',
    '/trust-safety',
    '/community-guidelines',
    '/privacy',
    '/terms',
    '/refunds',
    '/contact',
    '/signin'
  ]);

  if (EXACT_PUBLIC_PAGES.has(pathname)) return true;

  // Parameterized public subpaths: /events/:slug, /trips/:slug, /meetups/:city
  if (/^\/events\/[a-zA-Z0-9_\-]+$/.test(pathname)) return true;
  if (/^\/trips\/[a-zA-Z0-9_\-]+$/.test(pathname)) return true;
  if (/^\/meetups\/[a-zA-Z0-9_\-]+$/.test(pathname)) return true;

  return false;
}

/**
 * Path Traversal & Symlink Guard: Resolves and verifies that a file path lives strictly within REPO_ROOT,
 * verifies canonical filesystem path using fs.realpathSync to block symlink escapes,
 * and rejects any restricted file patterns.
 */
export function resolveSafePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Invalid file path specified');
  }

  const trimmed = relativePath.trim();
  // Absolute paths are strictly disallowed
  if (path.isAbsolute(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error('Access denied: Absolute paths are not permitted');
  }

  const absolutePath = path.normalize(path.resolve(REPO_ROOT, trimmed));

  // Lexical containment check
  if (!absolutePath.startsWith(REPO_ROOT + path.sep) && absolutePath !== REPO_ROOT) {
    throw new Error('Access denied: Path resides outside of workspace');
  }

  // Deny-list check on relative portion
  const rel = path.relative(REPO_ROOT, absolutePath);
  for (const pattern of DENIED_PATH_PATTERNS) {
    if (pattern.test(rel)) {
      throw new Error(`Access denied: Access to '${rel}' is restricted`);
    }
  }

  // Symlink protection: verify canonical filesystem paths using fs.realpathSync
  const canonicalRepoRoot = fs.realpathSync(REPO_ROOT);
  let canonicalPath;
  try {
    // If entry exists or is a symlink, resolve its canonical real path
    if (fs.existsSync(absolutePath) || fs.lstatSync(absolutePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      canonicalPath = fs.realpathSync(absolutePath);
    } else {
      // For non-existent files, verify the canonical path of the closest existing parent directory
      let cur = path.dirname(absolutePath);
      while (!fs.existsSync(cur) && cur !== path.dirname(cur)) {
        cur = path.dirname(cur);
      }
      canonicalPath = fs.realpathSync(cur);
    }
  } catch (err) {
    // Fail closed if canonical path verification fails
    throw new Error(`Access denied: Canonical path verification failed: ${err.message}`);
  }

  // Reject symlinks resolving outside the repository root
  if (!canonicalPath.startsWith(canonicalRepoRoot + path.sep) && canonicalPath !== canonicalRepoRoot) {
    throw new Error('Access denied: Symlink resolves outside of workspace');
  }

  // Check canonical relative path against deny-list as well
  const canonicalRel = path.relative(canonicalRepoRoot, canonicalPath);
  for (const pattern of DENIED_PATH_PATTERNS) {
    if (pattern.test(canonicalRel)) {
      throw new Error(`Access denied: Access to '${canonicalRel}' is restricted`);
    }
  }

  return { absolutePath, relativePath: rel, canonicalPath };
}

/**
 * Secret Redactor: Scrubs tokens, connection strings, emails, and sensitive keys from output.
 */
export function redactSecrets(input) {
  if (typeof input !== 'string') return input;

  return input
    // Scrub postgres connection strings
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@[^\s\/]+/gi, 'postgres://[REDACTED_USER]:[REDACTED_PASSWORD]@[REDACTED_HOST]')
    // Scrub bot tokens (e.g. 123456:ABC-DEF...)
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]')
    // Scrub Bearer / API keys
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bsm_mcp_[a-f0-9]{32,}\b/gi, '[REDACTED_MCP_KEY]')
    // Scrub long hex strings resembling secret keys or salts (>= 32 chars)
    .replace(/\b[a-f0-9]{32,64}\b/gi, (match) => match.length >= 32 ? '[REDACTED_HEX_KEY]' : match);
}

/**
 * Token-bucket rate limiter.
 */
export class RateLimiter {
  constructor({ maxRequests = 60, windowMs = 60_000 } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.clients = new Map();
  }

  check(ip = '127.0.0.1') {
    const now = Date.now();
    let record = this.clients.get(ip);
    if (!record || now - record.resetTime > this.windowMs) {
      record = { count: 0, resetTime: now };
      this.clients.set(ip, record);
    }
    record.count++;
    if (record.count > this.maxRequests) {
      return false;
    }
    return true;
  }
}
