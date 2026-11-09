# Vercel Preview Protection Automation Runbook

**Milestone:** NIGHTLIFEZ M9 — Full Multi-Role E2E, Security, Performance & Accessibility Review  
**Date:** November 2026  
**Status:** Canonical Reference & Implementation Guide (Blocker #6 Resolution)  
**Security Classification:** Confidential — Internal DevOps & QA Only  

---

## 1. Executive Summary & Problem Context (Blocker #6)

Vercel Deployment Protection provides native Single Sign-On (SSO) and password protection for Preview deployments. While this guarantees that preview environments remain private and cannot be crawled by search engines or accessed by unauthenticated internet users, it introduces a barrier for automated Continuous Integration (CI) and synthetic end-to-end (E2E) testing tools (such as Playwright and synthetic monitoring probes).

Historically, projects have attempted unverified workarounds such as:
1. Exposing public authentication bypass query parameters in application code.
2. Disabling preview protection entirely across the team workspace.
3. Introducing synthetic login backdoors in production application routers.

**Under NIGHTLIFEZ Governance Rules, all such bypass mechanisms are strictly forbidden.**  
This document establishes the canonical, server-sanctioned method to automate Playwright and synthetic monitoring against protected Vercel Preview deployments using Vercel's official **Deployment Protection Bypass for Automation** (`x-vercel-protection-bypass`).

---

## 2. Architectural Security Principles

The implementation complies with all NIGHTLIFEZ milestone governance constraints:

| Constraint | How Complied |
|---|---|
| **No Public Bypasses** | No synthetic endpoints or backdoor query flags exist in application code or production routes. |
| **No Production Impact** | Deployment Protection is never disabled in Production. `ENABLE_LIVE_PAYMENTS=false` is preserved. |
| **Encrypted Secret Isolation** | The bypass token is stored exclusively in GitHub Actions Encrypted Secrets (`VERCEL_PROTECTION_BYPASS`) and injected at runtime into test runners. |
| **Preview Protection Intact** | Human visitors browsing without the secret header are still challenged by Vercel SSO or Preview authentication. |
| **Server-Authoritative Validation** | Header validation occurs at Vercel's edge proxy before requests reach the Node.js application process. |

---

## 3. How Vercel Protection Bypass Works

Vercel's edge proxy natively supports the `x-vercel-protection-bypass` request header. When a request matches a configured secret, Vercel allows the request to bypass the Deployment Protection screen and route directly to the serverless function or static asset.

```
       Automated Runner (Playwright CI)
                     │
                     │  HTTP Request
                     │  Header: x-vercel-protection-bypass: <SECRET>
                     ▼
        ┌─────────────────────────┐
        │    Vercel Edge Proxy    │
        │   (Deployment Protect)  │
        └────────────┬────────────┘
                     │
           Secret Matches?
           ┌─────────┴─────────┐
          YES                  NO
           │                   │
           ▼                   ▼
    ┌──────────────┐     ┌──────────────┐
    │  NIGHTLIFEZ  │     │  Vercel SSO  │
    │  Preview App │     │  Login Form  │
    └──────────────┘     └──────────────┘
```

---

## 4. Playwright Configuration for Protected Previews

To enable automated browser tests against protected preview URLs, configure the Playwright HTTP context in `playwright.config.js`:

```javascript
// playwright.config.js snippet for protected previews
import { defineConfig, devices } from '@playwright/test';

const VERCEL_BYPASS_TOKEN = process.env.VERCEL_PROTECTION_BYPASS;
const PREVIEW_BASE_URL = process.env.PREVIEW_BASE_URL || 'http://localhost:3100';

export default defineConfig({
  use: {
    baseURL: PREVIEW_BASE_URL,
    extraHTTPHeaders: VERCEL_BYPASS_TOKEN ? {
      // Vercel standard automation bypass header
      'x-vercel-protection-bypass': VERCEL_BYPASS_TOKEN,
      // Enables setting bypass cookie for subsequent browser navigations
      'x-vercel-set-bypass-cookie': 'samesitenone'
    } : {},
    contextOptions: {
      reducedMotion: 'reduce'
    }
  },
  // Projects matrix (desktop, mobile)
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ]
});
```

### Cookie-Based Navigation for Full Browser Contexts

When a browser navigates via `page.goto()`, individual top-level document requests also need the bypass token. By passing `'x-vercel-set-bypass-cookie': 'samesitenone'`, Vercel responds with a `_vercel_jwt` cookie that persists the bypass across subsequent multi-page navigations within that browser session.

---

## 5. GitHub Actions CI Workflow Setup

Configure the CI workflow to securely inject the token into preview test runs:

```yaml
# .github/workflows/preview-e2e.yml
name: Preview E2E & Multi-Role Acceptance

on:
  deployment_status:

jobs:
  e2e-preview:
    if: github.event.deployment_status.state == 'success' && github.event.deployment_status.environment == 'Preview'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright Browsers
        run: npx playwright install --with-deps chromium

      - name: Run Multi-Role Acceptance on Preview
        env:
          PREVIEW_BASE_URL: ${{ github.event.deployment_status.target_url }}
          VERCEL_PROTECTION_BYPASS: ${{ secrets.VERCEL_PROTECTION_BYPASS }}
          CI: 'true'
        run: |
          npx playwright test e2e/multi-role-acceptance.spec.js

      - name: Upload Test Artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-preview-results
          path: test-results/
          retention-days: 7
```

---

## 6. Verification and Troubleshooting Checklist

1. **Verify Secret Generation:**  
   In the Vercel Project Dashboard: **Settings** $\rightarrow$ **Deployment Protection** $\rightarrow$ **Protection Bypass for Automation** $\rightarrow$ Generate secret and copy the value.

2. **Verify GitHub Secret:**  
   In GitHub Repository: **Settings** $\rightarrow$ **Secrets and variables** $\rightarrow$ **Actions** $\rightarrow$ Create `VERCEL_PROTECTION_BYPASS`.

3. **Verify Header Delivery:**  
   Test locally or from a runner using curl:
   ```bash
   curl -I -H "x-vercel-protection-bypass: <SECRET>" https://<preview-domain>.vercel.app/api/health
   ```
   **Expected Response:** `HTTP/2 200` (returns health JSON rather than `307 Redirect` to SSO).

4. **Verify No Code Modification:**  
   Confirm no lines in `server.js`, `lib/router.js`, or `lib/http.js` check for `VERCEL_PROTECTION_BYPASS` directly; edge handling is done exclusively by Vercel's proxy.
