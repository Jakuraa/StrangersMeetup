// e2e/superprofile-checkout.spec.js - Tickets are bought on SuperProfile, on the website only.
import { test, expect } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';

test('a paid event with a SuperProfile product shows an external Book Tickets link', async ({ page }, testInfo) => {
  await page.goto('/events/local-sp-social');
  const book = page.getByRole('link', { name: 'Book Tickets' });
  await expect(book).toBeVisible();
  await expect(book).toHaveAttribute('href', '/checkout/local-sp-social');
  await expect(book).toHaveAttribute('rel', /noopener/);
  await expect(book).toHaveAttribute('target', '_blank');
  await expect(page.locator('main')).toContainText('Secure checkout on SuperProfile');
  await expect(page.locator('input[name*="card" i], input[name*="cvv" i], input[name*="upi" i]')).toHaveCount(0);
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'superprofile-event');
});

test('clicking through redirects to superprofile.bio with a ref, signed out', async ({ request }) => {
  const r = await request.get('/checkout/local-sp-social', { maxRedirects: 0 });
  expect(r.status()).toBe(302);
  const loc = new URL(r.headers().location);
  expect(loc.hostname).toBe('superprofile.bio');
  expect(loc.pathname).toBe('/meetup_host/local-sp-social');
  expect(loc.searchParams.get('ref')).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
});

test('a paid event without a SuperProfile product stays disabled', async ({ page }) => {
  await page.goto('/events/local-sp-unlinked');
  await expect(page.locator('main')).toContainText('Online booking not available yet');
  await expect(page.getByRole('link', { name: 'Book Tickets' })).toHaveCount(0);
  const r = await page.request.get('/checkout/local-sp-unlinked', { maxRedirects: 0 });
  expect(r.status()).toBe(302);
  expect(r.headers().location).toBe('/events/local-sp-unlinked');
});

test('inside the Telegram Mini App there is no buy button', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('sm_in_tg', '1'));
  await page.goto('/events/local-sp-social');
  await expect(page.getByRole('link', { name: 'Book Tickets' })).toBeHidden();
  await expect(page.locator('[data-tg-only]').first()).toBeVisible();
  await expect(page.locator('main')).toContainText('Tickets are sold on our website');
});

for (const width of [320, 375]) {
  test(`no sideways scrolling at ${width}px on a SuperProfile event`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/events/local-sp-social');
    await expectNoHorizontalOverflow(page);
    await page.goto('/events/local-sp-unlinked');
    await expectNoHorizontalOverflow(page);
  });
}
