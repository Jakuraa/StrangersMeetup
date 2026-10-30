// mcp/tools/website.js - Read-only website inspection, route auditing, responsiveness checks, and screenshots.
import { chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { APP_ORIGIN, APP_PORT, SCREENSHOTS_DIR, REPO_ROOT } from '../config.js';
import { isSafeLocalPath, isAllowedPublicScreenshotPath, redactSecrets } from '../security.js';

const ALLOWED_VIEWPORT_WIDTHS = [320, 360, 375, 390, 412, 430, 768, 1280];

/**
 * sm_get_project_status - Verifies if the local application server is online and returns health metrics.
 */
export async function getProjectStatus() {
  const targetUrl = `${APP_ORIGIN}/api/health`;
  const startTime = Date.now();

  try {
    const res = await fetch(targetUrl, { signal: AbortSignal.timeout(3000) });
    const durationMs = Date.now() - startTime;
    const data = await res.json().catch(() => null);

    return {
      server_status: res.ok ? 'ONLINE' : 'DEGRADED',
      status_code: res.status,
      port: APP_PORT,
      origin: APP_ORIGIN,
      latency_ms: durationMs,
      health: data,
      database_connected: data?.ok === true && data?.database === 'ok'
    };
  } catch (err) {
    return {
      server_status: 'OFFLINE',
      port: APP_PORT,
      origin: APP_ORIGIN,
      error: `Could not connect to local application server at ${APP_ORIGIN}: ${err.message}`
    };
  }
}

/**
 * sm_list_routes - Scans lib/router.js and returns declared route definitions.
 */
export async function listRoutes({ filter = 'all' } = {}) {
  const routerPath = path.resolve(REPO_ROOT, 'lib/router.js');
  const content = fs.readFileSync(routerPath, 'utf8');

  // Parse ROUTES array literal from router.js
  const routeRegex = /\[\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*,\s*h\('([^']+)'\s*,\s*'([^']+)'\)\s*\]/g;
  const routes = [];
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const [_, method, routePath, handlerFile, handlerName] = match;

    let category = 'page';
    let authRequired = false;

    if (routePath.startsWith('/api/admin') || routePath === '/admin') {
      category = 'admin';
      authRequired = true;
    } else if (routePath.startsWith('/api/organiser') || routePath.startsWith('/organiser')) {
      category = 'organiser';
      authRequired = true;
    } else if (routePath.startsWith('/api/auth') || routePath.startsWith('/auth')) {
      category = 'auth';
      authRequired = false;
    } else if (routePath.startsWith('/api/webhooks') || routePath.startsWith('/api/telegram/webhook')) {
      category = 'webhook';
      authRequired = true;
    } else if (routePath.startsWith('/api/cron')) {
      category = 'cron';
      authRequired = true;
    } else if (routePath.startsWith('/api/')) {
      category = 'api';
      authRequired = false;
    } else if (routePath === '/me' || routePath.startsWith('/bookings/')) {
      category = 'page';
      authRequired = true;
    }

    if (filter === 'all' || filter === category) {
      routes.push({
        method,
        path: routePath,
        category,
        handler: `${handlerFile}.${handlerName}`,
        auth_required: authRequired
      });
    }
  }

  return {
    total_routes: routes.length,
    filter_applied: filter,
    routes
  };
}

/**
 * sm_inspect_page - Performs live HTTP inspection of a local page route.
 */
export async function inspectPage({ path: targetPath, persona = 'anonymous' }) {
  if (!isSafeLocalPath(targetPath)) {
    throw new Error(`SSRF / Path violation: '${targetPath}' is not an authorized local route`);
  }

  const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  const fullUrl = `${APP_ORIGIN}${normalizedPath}`;
  const startTime = Date.now();

  let headers = {
    'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'User-Agent': 'StrangersMeetup-MCP-Auditor/1.0'
  };

  // If testing with a seeded persona, retrieve session cookie first
  if (persona && persona !== 'anonymous') {
    try {
      const devRes = await fetch(`${APP_ORIGIN}/api/auth/dev`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona })
      });
      const cookie = devRes.headers.get('set-cookie');
      if (cookie) headers['Cookie'] = cookie.split(';')[0];
    } catch {
      // Continue anonymously if dev login fails
    }
  }

  const res = await fetch(fullUrl, {
    method: 'GET',
    headers,
    redirect: 'manual'
  });

  const durationMs = Date.now() - startTime;
  const status = res.status;
  const contentType = res.headers.get('content-type') || '';
  const location = res.headers.get('location') || null;

  let classification = 'UNKNOWN';
  if (status === 200) classification = 'EXISTS_AND_LOADED_200';
  else if (status === 302 && location && location.includes('/signin')) classification = 'AUTH_REQUIRED_REDIRECT';
  else if (status === 301 || status === 302) classification = 'REDIRECT';
  else if (status === 401 || status === 403) classification = 'FORBIDDEN_403';
  else if (status === 404) classification = 'NOT_FOUND_404';
  else if (status >= 500) classification = 'SERVER_ERROR_500';

  let title = null;
  let canonical = null;

  if (contentType.includes('text/html')) {
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = titleMatch[1].trim();
    const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
    if (canonicalMatch) canonical = canonicalMatch[1].trim();
  }

  return {
    path: normalizedPath,
    full_url: fullUrl,
    status_code: status,
    classification,
    duration_ms: durationMs,
    content_type: contentType,
    redirect_location: location,
    title,
    canonical_url: canonical,
    persona_applied: persona
  };
}

/**
 * sm_capture_screenshot - Uses headless Playwright to capture a screenshot at an exact viewport width.
 * Strictly restricted to public pages and non-privileged personas to protect attendee privacy and secret venues.
 */
export async function captureScreenshot({ path: targetPath, width = 1280, persona = 'anonymous' }) {
  if (!isSafeLocalPath(targetPath)) {
    throw new Error(`SSRF / Path violation: '${targetPath}' is not an authorized local route`);
  }

  if (!isAllowedPublicScreenshotPath(targetPath)) {
    throw new Error(`Access denied: '${targetPath}' is a private or non-whitelisted route. Screenshots are restricted to public pages only.`);
  }

  const ALLOWED_PERSONAS = ['anonymous', 'guest'];
  if (persona && !ALLOWED_PERSONAS.includes(persona)) {
    throw new Error(`Unauthorized persona '${persona}'. Admin and organiser personas are prohibited to protect attendee privacy and undisclosed event addresses.`);
  }

  if (!ALLOWED_VIEWPORT_WIDTHS.includes(width)) {
    throw new Error(`Invalid viewport width ${width}. Supported widths: ${ALLOWED_VIEWPORT_WIDTHS.join(', ')}`);
  }

  const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      viewport: { width, height: 850 },
      reducedMotion: 'reduce'
    });
    const page = await context.newPage();

    if (persona && persona !== 'anonymous') {
      await page.goto(`${APP_ORIGIN}/signin`);
      const personaBtn = page.getByRole('button', { name: new RegExp(persona, 'i') });
      if (await personaBtn.count() > 0) {
        await personaBtn.first().click();
        await page.waitForLoadState('networkidle');
      }
    }

    const fullUrl = `${APP_ORIGIN}${normalizedPath}`;
    const res = await page.goto(fullUrl);
    await page.waitForLoadState('networkidle');

    const cleanName = normalizedPath.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'home';
    const timestamp = Date.now();
    const fileName = `${cleanName}-${width}px-${timestamp}.png`;
    const outputPath = path.resolve(SCREENSHOTS_DIR, fileName);

    const buffer = await page.screenshot({ path: outputPath, fullPage: false });

    return {
      status: 'SUCCESS',
      file_name: fileName,
      file_path: outputPath,
      width,
      height: 850,
      path: normalizedPath,
      persona,
      http_status: res ? res.status() : null,
      size_bytes: buffer.length,
      base64_png: buffer.toString('base64')
    };
  } finally {
    await browser.close();
  }
}

/**
 * sm_audit_responsive - Tests a page across responsive viewports for overflow and tap targets.
 */
export async function auditResponsive({ path: targetPath, widths = ALLOWED_VIEWPORT_WIDTHS }) {
  if (!isSafeLocalPath(targetPath)) {
    throw new Error(`SSRF / Path violation: '${targetPath}' is not an authorized local route`);
  }

  const normalizedPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
  const testWidths = widths.filter(w => ALLOWED_VIEWPORT_WIDTHS.includes(w));
  const fullUrl = `${APP_ORIGIN}${normalizedPath}`;

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = [];

  try {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    for (const width of testWidths) {
      await page.setViewportSize({ width, height: 750 });
      await page.goto(fullUrl);
      await page.waitForLoadState('load');

      // Check horizontal overflow
      const overflow = await page.evaluate(() => {
        const docEl = document.documentElement;
        const scrollW = docEl.scrollWidth;
        const clientW = docEl.clientWidth;
        const hasOverflow = scrollW > clientW;
        return {
          has_overflow: hasOverflow,
          overflow_px: hasOverflow ? scrollW - clientW : 0
        };
      });

      // Check small tap targets (< 44px)
      const smallTargets = await page.evaluate(() => {
        const min = 44;
        const out = [];
        const interactive = document.querySelectorAll('button, a, input, select, textarea');
        for (const el of interactive) {
          if (el.disabled || el.closest('[hidden], [inert]')) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          if (el.classList.contains('skip') || el.closest('.sr-only, .hp')) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height < min - 0.5 || r.width < min - 0.5) {
            const name = (el.getAttribute('aria-label') || el.textContent || el.name || '').trim().slice(0, 30);
            out.push(`${el.tagName.toLowerCase()}${el.className ? '.' + el.className.split(' ').join('.') : ''} "${name}" (${Math.round(r.width)}x${Math.round(r.height)})`);
          }
        }
        return [...new Set(out)].slice(0, 5); // limit output
      });

      results.push({
        viewport_width: width,
        fits_without_overflow: !overflow.has_overflow,
        overflow_px: overflow.overflow_px,
        tap_target_issues_count: smallTargets.length,
        tap_target_samples: smallTargets
      });
    }

    const allPassed = results.every(r => r.fits_without_overflow && r.tap_target_issues_count === 0);

    return {
      path: normalizedPath,
      overall_status: allPassed ? 'PASS' : 'FAIL',
      viewports_tested: results.length,
      viewport_results: results
    };
  } finally {
    await browser.close();
  }
}

/**
 * sm_audit_auth_flow - Audits authentication routing and security gates.
 */
export async function auditAuthFlow() {
  const gates = [
    { name: 'Public Sign-in Screen', path: '/signin', expectedStatus: 200 },
    { name: 'Signed-Out Member Portal', path: '/me', expectedStatus: 302, redirectPattern: /^\/signin\?next=%2Fme|\/signin\?next=\/me/ },
    { name: 'Signed-Out Organiser Portal', path: '/organiser', expectedStatus: 200, checksContent: 'Sign in with Telegram' },
    { name: 'Signed-Out Admin Portal', path: '/admin', expectedStatus: 401, checksContent: 'The admin area is for the StrangersMeetup team' }
  ];

  const results = [];

  for (const gate of gates) {
    const res = await fetch(`${APP_ORIGIN}${gate.path}`, {
      method: 'GET',
      redirect: 'manual'
    });

    const status = res.status;
    const location = res.headers.get('location');
    const html = await res.text().catch(() => '');

    let passed = status === gate.expectedStatus;
    if (gate.redirectPattern && (!location || !gate.redirectPattern.test(location))) passed = false;
    if (gate.checksContent && !html.includes(gate.checksContent)) passed = false;

    results.push({
      gate_name: gate.name,
      path: gate.path,
      http_status: status,
      location,
      passed
    });
  }

  const allPassed = results.every(r => r.passed);

  return {
    auth_flow_status: allPassed ? 'PASS' : 'FAIL',
    gates_audited: results
  };
}
