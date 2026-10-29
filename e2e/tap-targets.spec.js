// e2e/tap-targets.spec.js - Interactive controls are at least 44x44 CSS px at phone widths.
// Phone project only; run at 320 and 375 on the pages people use most.
import { test, expect } from '@playwright/test';
import { signInAs, smallTapTargets } from './helpers.js';

const PAGES = ['/', '/events', '/trips', '/events/local-board-games-night', '/events/local-approval-dinner', '/events/local-paid-workshop',
  '/events/local-sold-out-mixer', '/events/local-past-meetup', '/events/local-cancelled-movie', '/signin', '/membership', '/become-a-host', '/faq', '/admin'];

test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'mobile', 'phone widths only'); });

for (const width of [320, 375]) {
  test(`public pages have 44px touch targets @ ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    const problems = [];
    for (const path of PAGES) {
      await page.goto(path);
      await page.waitForLoadState('load');
      for (const p of await smallTapTargets(page)) problems.push(`${path}: ${p}`);
    }
    expect(problems, 'controls under 44px').toEqual([]);
  });

  test(`menu, member and organiser pages have 44px touch targets @ ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    const problems = [];
    await page.goto('/');
    await page.getByRole('button', { name: /menu/i }).click();
    for (const p of await smallTapTargets(page)) problems.push(`/ (menu open): ${p}`);
    await signInAs(page, 'guest');
    await page.goto('/me');
    await page.waitForLoadState('networkidle');
    for (const p of await smallTapTargets(page)) problems.push(`/me: ${p}`);
    await signInAs(page, 'organiser');
    for (const path of ['/organiser', '/organiser/new']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      for (const p of await smallTapTargets(page)) problems.push(`${path}: ${p}`);
    }
    expect(problems, 'controls under 44px').toEqual([]);
  });
}
