// e2e/closed-and-gates.spec.js - Past/cancelled event pages offer no booking, the signed-out admin screen is
// usable by keyboard and phone, and event cards without photos get category-specific art.
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';

const CLOSED = [
  ['local-past-meetup', 'This event has ended', 'Adyar'],
  ['local-cancelled-movie', 'This event has been cancelled', 'Koramangala']
];

for (const [slug, message] of CLOSED) {
  test(`${slug}: status panel, no ticket choice, nothing to submit`, async ({ page }, testInfo) => {
    await page.goto(`/events/${slug}`);
    const box = page.getByRole('complementary', { name: 'Booking' });
    await expect(box.getByRole('heading', { name: message })).toBeVisible();
    await expect(box.getByRole('link', { name: /See upcoming/ })).toBeVisible();
    for (const control of ['radio', 'combobox', 'checkbox', 'textbox']) await expect(box.getByRole(control)).toHaveCount(0);
    await expect(box.getByRole('button')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/exact address appears|Choose a ticket|Number of tickets/);
    await expect(page.locator('main')).not.toContainText('Test venue');
    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, testInfo, `closed-${slug}`);
    // The only way onward is a normal link, reachable by keyboard.
    await box.getByRole('link', { name: /See upcoming/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/events$/);
  });
}

test('signed-out /admin: branded access-required screen, keyboard reachable, 401 status', async ({ page }, testInfo) => {
  const res = await page.goto('/admin');
  expect(res.status()).toBe(401);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to continue' })).toBeVisible();
  await expect(page.locator('header.site-header, .site-header').first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/Loading|Overview|Bookings/);
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'admin-signed-out');
  const cta = page.getByRole('link', { name: 'Continue with Telegram' }).last();
  await cta.focus();
  await expect(cta).toBeFocused();
  await expect(cta).toHaveAttribute('href', '/signin?next=/admin');
  await expect(page.getByRole('link', { name: 'Back to the site' })).toBeVisible();
  const box = await cta.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
});

test('signed-out /admin fits at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('non-admin /admin: 403 access screen with no allowlist hint', async ({ page }, testInfo) => {
  await signInAs(page, 'guest');
  const res = await page.goto('/admin');
  expect(res.status()).toBe(403);
  await expect(page.getByRole('heading', { level: 1, name: 'You don’t have access to this page' })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/allowlist/i);
  await expect(page.getByRole('link', { name: 'Back to the site' })).toBeVisible();
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'admin-forbidden');
});

test('event cards without photos use category-specific art', async ({ page }, testInfo) => {
  await page.goto('/events');
  const arts = page.locator('.card-art');
  expect(await arts.count()).toBeGreaterThan(3);
  const kinds = new Set();
  for (const el of await arts.all()) {
    await expect(el).toHaveAttribute('aria-hidden', 'true');
    await expect(el.locator('svg.card-glyph')).toHaveCount(1);
    kinds.add(await el.evaluate((n) => `${n.className}|${getComputedStyle(n).backgroundColor}`));
  }
  expect(kinds.size, 'different categories look different').toBeGreaterThan(3);
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'events-card-art');
});
