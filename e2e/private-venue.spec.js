// e2e/private-venue.spec.js - A private venue is shown only on its own confirmed booking: never to
// visitors, other guests, a guest whose request is pending, or the public events API.
import { test, expect } from '@playwright/test';
import { signInAs } from './helpers.js';

const VENUE = 'Elliot’s Beach Rd';

test('visitors never see the private venue', async ({ page, request }) => {
  await page.goto('/events/local-board-games-night');
  await expect(page.locator('main')).toContainText('Besant Nagar');
  await expect(page.locator('body')).not.toContainText(VENUE);
  const html = await (await request.get('/events/local-board-games-night')).text();
  expect(html).not.toContain('Elliot');
  const api = await (await request.get('/api/events')).json();
  for (const e of api.events) expect(e.venue).toBe('');
  expect(JSON.stringify(api)).not.toContain('Elliot');
});

test('a guest without a booking does not see it; the booked guest does; the URL leaks nothing', async ({ browser }) => {
  const other = await browser.newPage();
  await signInAs(other, 'guest2');
  await other.goto('/events/local-board-games-night');
  await expect(other.locator('body')).not.toContainText(VENUE);
  await other.close();

  const booked = await browser.newPage();
  await signInAs(booked, 'guest');
  await booked.locator('[data-my-bookings] a', { hasText: 'Board games night' }).click();
  await booked.waitForURL(/\/bookings\//);
  await expect(booked.locator('[data-booking-status]')).toContainText(VENUE);
  const bookingUrl = booked.url();
  await booked.close();

  const intruder = await browser.newPage();
  await signInAs(intruder, 'guest2');
  await intruder.goto(bookingUrl);
  await expect(intruder.locator('[data-booking-status]')).not.toContainText(VENUE);
  expect((await intruder.request.get(`/api/bookings/${bookingUrl.split('/').pop()}`)).status()).toBe(404);
  await intruder.close();
});

test('a pending approval request does not reveal the venue', async ({ page }) => {
  await signInAs(page, 'guest2');
  await page.locator('[data-my-bookings] a', { hasText: 'Dinner club' }).click();
  await page.waitForURL(/\/bookings\//);
  await expect(page.locator('[data-booking-status]')).toContainText(/awaiting|request/i);
  await expect(page.locator('body')).not.toContainText('Khader Nawaz Khan');
});
