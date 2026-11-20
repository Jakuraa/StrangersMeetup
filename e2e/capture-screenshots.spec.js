// e2e/capture-screenshots.spec.js - Generates required screenshots at 320px, 375px, 393px, and 1280px (desktop).
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SCREENSHOT_DIR = path.join(process.cwd(), 'test-results', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '320px', width: 320, height: 640 },
  { name: '375px', width: 375, height: 667 },
  { name: '393px', width: 393, height: 852 },
  { name: 'desktop', width: 1280, height: 800 }
];

test.describe('Evidence Screenshot Generation', () => {
  for (const vp of VIEWPORTS) {
    test(`Capture pages at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // 1. Homepage
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `homepage-${vp.name}.png`),
        fullPage: false
      });

      // 2. Events Discovery
      await page.goto('/events');
      await page.waitForLoadState('domcontentloaded');
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `events-${vp.name}.png`),
        fullPage: false
      });

      // 3. Sign In - WhatsApp tab
      await page.goto('/signin');
      await page.waitForLoadState('domcontentloaded');
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `signin-whatsapp-${vp.name}.png`),
        fullPage: false
      });

      // 4. Sign In - Telegram tab (Explicit initiation button)
      await page.locator('[data-auth-tab="telegram"]').click();
      await page.waitForTimeout(300);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `signin-telegram-${vp.name}.png`),
        fullPage: false
      });
    });
  }
});
