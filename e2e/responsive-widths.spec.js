// e2e/responsive-widths.spec.js - Verify responsive layout across all requested widths
// 320, 360, 375, 393, 430, 768, 1024, and desktop (1280)
import { test, expect } from '@playwright/test';
import { signInAs, expectNoHorizontalOverflow } from './helpers.js';

const WIDTHS = [320, 360, 375, 393, 430, 768, 1024, 1280];
const PUBLIC_PAGES = [
  '/',
  '/events',
  '/events/local-board-games-night',
  '/events/local-approval-dinner',
  '/events/local-paid-workshop',
  '/events/local-sold-out-mixer',
  '/events/local-cancelled-movie',
  '/events/local-past-meetup',
  '/nightlife',
  '/dating',
  '/trips',
  '/signin',
  '/membership',
  '/become-a-host',
  '/list-your-venue',
  '/partner-with-us',
  '/faq',
  '/terms',
  '/privacy',
  '/community-guidelines',
  '/contact'
];

for (const width of WIDTHS) {
  test.describe(`Viewport ${width}px`, () => {
    for (const path of PUBLIC_PAGES) {
      test(`public ${path} has no horizontal overflow @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 750 });
        await page.goto(path);
        await page.waitForLoadState('load');
        await expectNoHorizontalOverflow(page);
      });
    }

    test(`guest /me has no horizontal overflow @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 750 });
      await signInAs(page, 'guest');
      await page.goto('/me');
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalOverflow(page);
    });

    test(`organiser /organiser & /organiser/new have no horizontal overflow @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 750 });
      await signInAs(page, 'organiser');
      for (const p of ['/organiser', '/organiser/new']) {
        await page.goto(p);
        await page.waitForLoadState('networkidle');
        await expectNoHorizontalOverflow(page);
      }
    });
  });
}
