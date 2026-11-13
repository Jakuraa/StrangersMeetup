// playwright.config.js - Browser suite (development only). Usage: npm run test:e2e
// Needs a local Postgres database for the suite: createdb sm_e2e (or set E2E_DATABASE_URL).
import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE, assertE2eSafe, serverEnv } from './e2e/env.js';

assertE2eSafe();

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',
  fullyParallel: false,
  workers: 1, // one shared seeded database
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  expect: { timeout: 10_000 },
  use: {
    baseURL: E2E_BASE,
    trace: 'retain-on-failure',
    // Scroll-reveal fades would make axe measure half-transparent text; the site has a reduced-motion fallback.
    contextOptions: { reducedMotion: 'reduce' },
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop', testIgnore: /admin-responsive/, use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', testIgnore: /admin-responsive/, use: { ...devices['Pixel 7'] } },
    // The admin viewport matrix (320, 375, Pixel 7, tablet, desktop) sets its own viewport per describe block.
    { name: 'responsive', testMatch: /admin-responsive/, use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'node server.js',
    url: `${E2E_BASE}/api/health`,
    env: serverEnv,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
