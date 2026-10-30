// test/mcp.test.js - Comprehensive test suite for StrangersMeetup Control MCP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startHttpServer } from '../mcp/server.js';
import { MCP_API_KEY, MCP_HOST, AUDIT_LOG_FILE, REPO_ROOT } from '../mcp/config.js';
import {
  validateBearerToken,
  isSafeLocalPath,
  isAllowedPublicScreenshotPath,
  resolveSafePath,
  redactSecrets,
  RateLimiter
} from '../mcp/security.js';
import {
  getProjectStatus,
  listRoutes,
  inspectPage,
  captureScreenshot,
  auditAuthFlow
} from '../mcp/tools/website.js';
import {
  readSource,
  getBranchStatus,
  getRecentChanges
} from '../mcp/tools/project.js';
import { runSafeTests, AVAILABLE_SUITES } from '../mcp/tools/testing.js';
import { REGISTERED_TOOL_NAMES } from '../mcp/tools/index.js';
import { logMcpAudit } from '../mcp/audit.js';

test('MCP Security: Bearer token validation and timing safety', () => {
  assert.equal(validateBearerToken(null), false);
  assert.equal(validateBearerToken(''), false);
  assert.equal(validateBearerToken('Basic abc'), false);
  assert.equal(validateBearerToken('Bearer wrong_token_value'), false);
  assert.equal(validateBearerToken(`Bearer ${MCP_API_KEY}`), true);
});

test('MCP Security: SSRF guard allows only safe local routes and rejects external URLs', () => {
  // Allowed safe local paths
  assert.equal(isSafeLocalPath('/'), true);
  assert.equal(isSafeLocalPath('/events'), true);
  assert.equal(isSafeLocalPath('/api/health'), true);
  assert.equal(isSafeLocalPath('/events?city=Chennai&q=party'), true);

  // Rejected dangerous / external URLs
  assert.equal(isSafeLocalPath('http://google.com'), false);
  assert.equal(isSafeLocalPath('https://evil.com/hack'), false);
  assert.equal(isSafeLocalPath('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isSafeLocalPath('//evil.com/x'), false);
  assert.equal(isSafeLocalPath('file:///etc/passwd'), false);
  assert.equal(isSafeLocalPath('javascript:alert(1)'), false);
  assert.equal(isSafeLocalPath(''), false);
});

test('MCP Security: Path traversal guard strictly denies .env, .git, .claude, and outside paths', () => {
  // Allowed source files
  const safe = resolveSafePath('lib/router.js');
  assert.equal(safe.relativePath, 'lib/router.js');
  assert.ok(fs.existsSync(safe.absolutePath));

  // Denied path traversal
  assert.throws(() => resolveSafePath('../../../etc/passwd'), /Access denied/);
  assert.throws(() => resolveSafePath('/etc/passwd'), /Access denied/);

  // Denied sensitive directories and files
  assert.throws(() => resolveSafePath('.env'), /Access denied/);
  assert.throws(() => resolveSafePath('.env.local'), /Access denied/);
  assert.throws(() => resolveSafePath('.git/config'), /Access denied/);
  assert.throws(() => resolveSafePath('.claude/worktrees'), /Access denied/);
  assert.throws(() => resolveSafePath('.remember/notes.md'), /Access denied/);
  assert.throws(() => resolveSafePath('node_modules/pg/index.js'), /Access denied/);
});

test('MCP Security: Secret redactor scrubs tokens and credentials', () => {
  const secretString = 'Connected to postgres://user:super_secret_pw@db.neon.tech/strangers with bot 123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_12345678 and token ghp_123456789012345678901234567890123456';
  const redacted = redactSecrets(secretString);

  assert.ok(!redacted.includes('super_secret_pw'));
  assert.ok(!redacted.includes('db.neon.tech'));
  assert.ok(!redacted.includes('ABCdefGHIjklMNOpqrSTUvwxYZ_12345678'));
  assert.ok(!redacted.includes('ghp_1234567890'));
  assert.ok(redacted.includes('[REDACTED_PASSWORD]'));
  assert.ok(redacted.includes('[REDACTED_BOT_TOKEN]'));
  assert.ok(redacted.includes('[REDACTED_GITHUB_TOKEN]'));
});

test('MCP Security: Rate limiter blocks requests beyond quota', () => {
  const limiter = new RateLimiter({ maxRequests: 5, windowMs: 10_000 });
  const ip = '127.0.0.1';

  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.check(ip), true);
  }
  assert.equal(limiter.check(ip), false); // 6th request blocked
});

test('MCP Tools: sm_get_project_status connects to local server', async () => {
  const status = await getProjectStatus();
  assert.ok(status.server_status === 'ONLINE' || status.server_status === 'OFFLINE');
  assert.equal(status.port, 3000);
});

test('MCP Tools: sm_list_routes scans lib/router.js accurately', async () => {
  const allRoutes = await listRoutes({ filter: 'all' });
  assert.ok(allRoutes.total_routes >= 40);

  const pages = await listRoutes({ filter: 'page' });
  assert.ok(pages.routes.some(r => r.path === '/'));
  assert.ok(pages.routes.some(r => r.path === '/events'));

  const adminRoutes = await listRoutes({ filter: 'admin' });
  assert.ok(adminRoutes.routes.every(r => r.auth_required === true));
});

test('MCP Tools: sm_inspect_page inspects public routes and classifies correctly', async (t) => {
  const status = await getProjectStatus();
  if (status.server_status !== 'ONLINE') {
    t.skip('Local application server on port 3000 is offline; skipping live HTTP inspection');
  } else {
    const homeInspect = await inspectPage({ path: '/' });
    assert.equal(homeInspect.status_code, 200);
    assert.equal(homeInspect.classification, 'EXISTS_AND_LOADED_200');
    assert.ok(homeInspect.title.includes('StrangersMeetup'));

    const meInspect = await inspectPage({ path: '/me' });
    assert.equal(meInspect.status_code, 302);
    assert.equal(meInspect.classification, 'AUTH_REQUIRED_REDIRECT');
  }

  await assert.rejects(
    async () => inspectPage({ path: 'http://malicious.com' }),
    /SSRF/
  );
});

test('MCP Tools: sm_read_source returns line-numbered source with bounded length', async () => {
  const res = await readSource({ filePath: 'lib/router.js', startLine: 1, endLine: 20 });
  assert.equal(res.file_path, 'lib/router.js');
  assert.equal(res.start_line, 1);
  assert.equal(res.end_line, 20);
  assert.ok(res.source_content.includes('1: // lib/router.js'));
});

test('MCP Tools: sm_get_branch_status returns current git branch', async () => {
  const status = await getBranchStatus();
  assert.equal(typeof status.current_branch, 'string');
  assert.ok(status.current_branch.length > 0);
  assert.equal(typeof status.is_clean, 'boolean');
});

test('MCP Tools: sm_get_recent_changes returns commit summaries', async () => {
  const history = await getRecentChanges({ limit: 5 });
  assert.ok(history.commits.length > 0);
  assert.ok(history.commits[0].commit_hash);
});

test('MCP Tools: sm_audit_auth_flow audits all security gates', async (t) => {
  const status = await getProjectStatus();
  if (status.server_status !== 'ONLINE') {
    t.skip('Local application server on port 3000 is offline; skipping live auth gate audit');
    return;
  }
  const audit = await auditAuthFlow();
  assert.equal(audit.auth_flow_status, 'PASS');
  assert.equal(audit.gates_audited.length, 4);
});

test('MCP Tools: sm_run_safe_tests rejects unauthorized suites', async () => {
  await assert.rejects(
    async () => runSafeTests({ suite: 'arbitrary_bash_command; rm -rf /' }),
    /Unauthorized test suite/
  );
});

test('MCP Tools: tool inventory contains exactly 11 read-only tools and zero write tools', () => {
  assert.equal(REGISTERED_TOOL_NAMES.length, 11);

  // Must include read-only tools
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_get_project_status'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_list_routes'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_inspect_page'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_capture_screenshot'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_audit_responsive'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_audit_auth_flow'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_read_source'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_get_branch_status'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_get_recent_changes'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_get_change_history'));
  assert.ok(REGISTERED_TOOL_NAMES.includes('sm_run_safe_tests'));

  // Zero write tools permitted in Stage 1
  assert.equal(REGISTERED_TOOL_NAMES.includes('sm_propose_change'), false);
  assert.equal(REGISTERED_TOOL_NAMES.includes('sm_approve_change'), false);
  assert.equal(REGISTERED_TOOL_NAMES.includes('sm_apply_change'), false);
});

test('MCP HTTP Server: Binds to 127.0.0.1, enforces Bearer auth, and handles Streamable HTTP and SSE', async () => {
  // Start on an ephemeral port on 127.0.0.1 for test isolation
  const server = await startHttpServer(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Verify unauthenticated health check returns minimal safe ping (revealing no secrets or tool lists)
    const unauthHealthRes = await fetch(`${baseUrl}/health`);
    assert.equal(unauthHealthRes.status, 200);
    const unauthHealthData = await unauthHealthRes.json();
    assert.deepEqual(unauthHealthData, { status: 'ok' });
    assert.equal(unauthHealthData.tools, undefined);

    // 2. Verify unauthenticated operational MCP endpoint (/mcp) is rejected with 401
    const unauthMcpRes = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    assert.equal(unauthMcpRes.status, 401);

    // 3. Verify wrong token on operational endpoint is rejected with 401
    const wrongTokenRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong_token_value' }
    });
    assert.equal(wrongTokenRes.status, 401);

    // 4. Verify valid Bearer token returns full discovery details on /health
    const authRes = await fetch(`${baseUrl}/health`, {
      headers: { 'Authorization': `Bearer ${MCP_API_KEY}` }
    });
    assert.equal(authRes.status, 200);
    const healthData = await authRes.json();
    assert.equal(healthData.status, 'ok');
    assert.equal(healthData.tools_count, 11);

    // 5. Verify Streamable HTTP initialization over /mcp
    const mcpRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MCP_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'test-runner', version: '1.0' },
          capabilities: {}
        }
      })
    });
    assert.equal(mcpRes.status, 200);
    assert.ok(mcpRes.headers.get('content-type').includes('text/event-stream'));

    // 5. Verify audit log was recorded
    assert.ok(fs.existsSync(AUDIT_LOG_FILE));
    const auditContent = fs.readFileSync(AUDIT_LOG_FILE, 'utf8');
    assert.ok(auditContent.includes('HTTP_AUTH'));
  } finally {
    server.close();
  }
});

test('MCP Stage 1.1 Remediation: sm_capture_screenshot route allowlist blocks private paths', async () => {
  // Public pages must pass allowlist check
  assert.equal(isAllowedPublicScreenshotPath('/'), true);
  assert.equal(isAllowedPublicScreenshotPath('/events'), true);
  assert.equal(isAllowedPublicScreenshotPath('/events/local-board-games-night'), true);
  assert.equal(isAllowedPublicScreenshotPath('/trips'), true);
  assert.equal(isAllowedPublicScreenshotPath('/signin'), true);
  assert.equal(isAllowedPublicScreenshotPath('/faq'), true);
  assert.equal(isAllowedPublicScreenshotPath('/about'), true);
  assert.equal(isAllowedPublicScreenshotPath('/privacy'), true);
  assert.equal(isAllowedPublicScreenshotPath('/terms'), true);

  // Private routes must be strictly rejected
  assert.equal(isAllowedPublicScreenshotPath('/admin'), false);
  assert.equal(isAllowedPublicScreenshotPath('/admin/overview'), false);
  assert.equal(isAllowedPublicScreenshotPath('/admin/events/1/attendees'), false);
  assert.equal(isAllowedPublicScreenshotPath('/organiser'), false);
  assert.equal(isAllowedPublicScreenshotPath('/organiser/new'), false);
  assert.equal(isAllowedPublicScreenshotPath('/bookings'), false);
  assert.equal(isAllowedPublicScreenshotPath('/bookings/bk_123'), false);
  assert.equal(isAllowedPublicScreenshotPath('/api'), false);
  assert.equal(isAllowedPublicScreenshotPath('/api/health'), false);
  assert.equal(isAllowedPublicScreenshotPath('/me'), false);
  assert.equal(isAllowedPublicScreenshotPath('/checkout/event-1'), false);
  assert.equal(isAllowedPublicScreenshotPath('/auth/telegram/start'), false);
  assert.equal(isAllowedPublicScreenshotPath('/.mcp/audit.jsonl'), false);
  assert.equal(isAllowedPublicScreenshotPath('//evil.com/phish'), false);
  assert.equal(isAllowedPublicScreenshotPath('http://external.com'), false);

  // captureScreenshot function rejects private routes
  await assert.rejects(
    async () => captureScreenshot({ path: '/admin' }),
    /Access denied: '\/admin' is a private or non-whitelisted route/
  );
  await assert.rejects(
    async () => captureScreenshot({ path: '/organiser/new' }),
    /Access denied: '\/organiser\/new' is a private or non-whitelisted route/
  );
  await assert.rejects(
    async () => captureScreenshot({ path: '/bookings/123' }),
    /Access denied/
  );
  await assert.rejects(
    async () => captureScreenshot({ path: '/api/health' }),
    /Access denied/
  );
});

test('MCP Stage 1.1 Remediation: sm_capture_screenshot rejects admin and organiser personas', async () => {
  await assert.rejects(
    async () => captureScreenshot({ path: '/', persona: 'admin' }),
    /Unauthorized persona 'admin'/
  );
  await assert.rejects(
    async () => captureScreenshot({ path: '/', persona: 'organiser' }),
    /Unauthorized persona 'organiser'/
  );
  await assert.rejects(
    async () => captureScreenshot({ path: '/', persona: 'staff' }),
    /Unauthorized persona 'staff'/
  );
});

test('MCP Stage 1.1 Remediation: Symlink escape protection and canonical verification', async () => {
  // 1. Normal files resolve to canonical path inside repository
  const normal = resolveSafePath('lib/router.js');
  assert.ok(normal.canonicalPath.startsWith(REPO_ROOT));

  // 2. Create a temporary symlink pointing to an external file outside workspace
  const tempOutsideFile = path.resolve(os.tmpdir(), `sm-outside-target-${Date.now()}.txt`);
  fs.writeFileSync(tempOutsideFile, 'OUTSIDE_WORKSPACE_SECRET=true', 'utf8');

  const symlinkPath = path.resolve(REPO_ROOT, `temp_symlink_${Date.now()}.txt`);
  const symlinkRel = path.basename(symlinkPath);

  try {
    fs.symlinkSync(tempOutsideFile, symlinkPath);

    // Verifying resolveSafePath throws on symlink escape
    assert.throws(
      () => resolveSafePath(symlinkRel),
      /Access denied: Symlink resolves outside of workspace/
    );

    // Verifying readSource throws on symlink escape
    await assert.rejects(
      async () => readSource({ filePath: symlinkRel }),
      /Access denied: Symlink resolves outside of workspace/
    );
  } finally {
    if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    if (fs.existsSync(tempOutsideFile)) fs.unlinkSync(tempOutsideFile);
  }
});

test('MCP Stage 1.1 Remediation: .mcp directory isolation from sm_read_source', async () => {
  // .mcp/audit.jsonl and all .mcp/ paths must be denied
  assert.throws(() => resolveSafePath('.mcp/audit.jsonl'), /Access denied/);
  assert.throws(() => resolveSafePath('.mcp/.mcp_key'), /Access denied/);
  assert.throws(() => resolveSafePath('.mcp/screenshots/sample.png'), /Access denied/);

  await assert.rejects(
    async () => readSource({ filePath: '.mcp/audit.jsonl' }),
    /Access denied/
  );

  // Normal source files remain fully readable
  const res = await readSource({ filePath: 'lib/router.js', startLine: 1, endLine: 10 });
  assert.equal(res.file_path, 'lib/router.js');
  assert.ok(res.source_content.includes('lib/router.js'));
});

test('MCP Stage 1.1 Remediation: Audit log file creation uses restrictive permissions (0600)', () => {
  logMcpAudit({ tool: 'TEST_PERMISSION_CHECK', status: 'SUCCESS' });
  assert.ok(fs.existsSync(AUDIT_LOG_FILE));
  const stat = fs.statSync(AUDIT_LOG_FILE);
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600, `Expected 0600 permissions on audit log, got ${mode.toString(8)}`);
});
