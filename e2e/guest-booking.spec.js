// e2e/guest-booking.spec.js - A guest books a free ticket and sees the private venue on the
// confirmed booking; paid and sold-out tickets offer no booking button.
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';

test('guest books a free ticket and gets the private venue on the confirmed booking', async ({ page }, testInfo) => {
  await signInAs(page, 'guest');
  await page.goto('/events/local-sunday-picnic');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sunday picnic');
  await expect(page.locator('main')).not.toContainText('Bandstand lawn');
  await expectAccessible(page);
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'guest-event-before-booking');

  await page.getByRole('radio', { name: /Free entry/ }).check();
  await page.getByRole('button', { name: 'Book now' }).click();
  await page.waitForURL(/\/bookings\/[0-9a-f-]{36}$/);
  const status = page.locator('[data-booking-status]');
  await expect(status).toContainText('You are in.');
  await expect(status).toContainText('Bandstand lawn, gate 3');
  await expectAccessible(page);
  await screenshot(page, testInfo, 'guest-booking-confirmed');

  await page.goto('/me');
  await expect(page.locator('[data-my-bookings]')).toContainText('Test: Sunday picnic');
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'guest-my-bookings');
});

test('paid tickets without a SuperProfile product cannot be booked', async ({ page }) => {
  await signInAs(page, 'guest2');
  await page.goto('/events/local-paid-workshop');
  await expect(page.locator('main')).toContainText('Online booking not available yet');
  await expect(page.getByRole('button', { name: 'Book now' })).toHaveCount(0);
});

test('sold-out events say so and offer no booking', async ({ page }) => {
  await signInAs(page, 'guest2');
  await page.goto('/events/local-sold-out-mixer');
  await expect(page.locator('main')).toContainText('Sold out');
  await expect(page.getByRole('button', { name: 'Book now' })).toHaveCount(0);
});
