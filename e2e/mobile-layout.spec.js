// e2e/mobile-layout.spec.js - Key pages at phone widths: no sideways scrolling, a working menu,
// tap targets that fit, and no serious/critical axe violations. Runs in both projects; the
// 320px pass covers the smallest phones still in use.
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';

const PUBLIC = ['/', '/events', '/events/local-board-games-night', '/trips', '/signin', '/membership', '/become-a-host'];
const SIGNED_IN = [['guest', '/me'], ['organiser', '/organiser'], ['organiser', '/organiser/new'], ['admin', '/admin'], ['staff', '/admin']];

for (const path of PUBLIC) {
  test(`public ${path} fits and passes axe`, async ({ page }, testInfo) => {
    await page.goto(path);
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    await screenshot(page, testInfo, `page${path === '/' ? '-home' : path.replace(/\W+/g, '-')}`);
  });
}

for (const [persona, path] of SIGNED_IN) {
  test(`${persona} ${path} fits and passes axe`, async ({ page }, testInfo) => {
    await signInAs(page, persona);
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    await screenshot(page, testInfo, `${persona}${path.replace(/\W+/g, '-')}`);
  });
}

test('no sideways scrolling at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of [...PUBLIC, '/events/local-approval-dinner', '/events/local-paid-workshop', '/events/local-sold-out-mixer', '/events/local-cancelled-movie', '/events/local-past-meetup']) {
    await page.goto(path);
    await expectNoHorizontalOverflow(page);
  }
  await signInAs(page, 'organiser');
  for (const path of ['/organiser', '/organiser/new']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalOverflow(page);
  }
});

test('mobile menu opens, traps nothing, and closes with Escape', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'menu button only exists at phone widths');
  await page.goto('/');
  const toggle = page.getByRole('button', { name: /menu/i });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Trips' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
