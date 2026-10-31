import { test, expect } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';

const SHOT_DIR = process.env.ARTIFACT_IMG_DIR || path.resolve('test-results/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

test.describe('Website UX & Showcase Verification', () => {
  test('homepage renders, fits, passes axe, and captures screenshot', async ({ page }, testInfo) => {
    await page.goto('/');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

    const shotPath = path.join(SHOT_DIR, `${testInfo.project.name}-home.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    expect(fs.existsSync(shotPath)).toBe(true);
  });

  test('events discovery with search renders, fits, and captures screenshot', async ({ page }, testInfo) => {
    await page.goto('/events?q=board');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    await expect(page.locator('.search-notice')).toBeVisible();

    const shotPath = path.join(SHOT_DIR, `${testInfo.project.name}-search.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    expect(fs.existsSync(shotPath)).toBe(true);
  });

  test('signin preview guidance card renders, fits, and captures screenshot', async ({ page }, testInfo) => {
    await page.goto('/signin');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

    const shotPath = path.join(SHOT_DIR, `${testInfo.project.name}-signin.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    expect(fs.existsSync(shotPath)).toBe(true);
  });
});
