// e2e/organiser-create.spec.js - An organiser creates and publishes an event through the four-step
// wizard; the event goes live with its venue kept private, and the other organiser cannot manage it.
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';

function localInput(daysAhead, hour) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  const ymd = new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return `${ymd}T${String(hour).padStart(2, '0')}:00`;
}

test('organiser publishes a free event from the wizard', async ({ page, browser }, testInfo) => {
  const title = `E2E ${testInfo.project.name} supper club ${Date.now().toString(36)}`;
  page.on('dialog', (d) => d.accept()); // "Start fresh" and "Delete ticket" confirmations
  await signInAs(page, 'organiser');
  await expect(page.getByRole('heading', { name: 'Your events' })).toBeVisible();
  await page.goto('/organiser/new');

  // A seeded or earlier draft may exist; either way, start a fresh "social" event.
  const fresh = page.getByRole('button', { name: 'Start fresh' });
  if (await fresh.isVisible().catch(() => false)) await fresh.click();
  await page.getByRole('button', { name: /Social meetup or matchmaking/ }).click();

  // Step 1: basics
  await page.getByLabel('Event name').fill(title);
  await page.getByLabel('Starts').fill(localInput(14, 19));
  await page.getByLabel(/^Ends/).fill(localInput(14, 22));
  await page.getByLabel(/Venue or meeting point/).fill('E2E private venue — 9 Test Street');
  await page.getByLabel(/^City/).fill('Chennai');
  await page.getByLabel(/Area or neighbourhood/).fill('Alwarpet');
  const priv = page.getByRole('switch', { name: /Keep the address private/ }).or(page.getByLabel(/Keep the address private/));
  if ((await priv.getAttribute('aria-checked')) !== 'true' && !(await priv.isChecked().catch(() => false))) await priv.click();
  await page.getByLabel('Description').fill('A relaxed supper club for people who have never met. All guests must be 21+.');
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'organiser-wizard-basics');
  await page.getByRole('button', { name: /Next: Tickets/ }).click();

  // Step 2: one free tier (paid ones cannot be sold while payments are off)
  const tiers = page.locator('.tier-card');
  for (let n = await tiers.count(); n > 0; n--) {
    await tiers.first().getByRole('button', { name: 'Delete' }).click();
    await expect(tiers).toHaveCount(n - 1);
  }
  await page.getByRole('button', { name: '+ Free entry' }).click();
  await expect(tiers).toHaveCount(1);
  await tiers.first().getByLabel('Quantity available').fill('20');
  await screenshot(page, testInfo, 'organiser-wizard-tickets');
  await page.getByRole('button', { name: /Next: Features/ }).click();

  // Step 3 → 4
  await page.getByRole('button', { name: /^Next/ }).click();
  await expect(page.getByText('Everything needed is in place.')).toBeVisible();
  await expectAccessible(page);
  await screenshot(page, testInfo, 'organiser-wizard-preview');
  await page.getByRole('button', { name: 'Publish event' }).click();
  await page.getByRole('button', { name: 'Publish now' }).click();
  await expect(page.getByRole('heading', { name: 'Your event is live' })).toBeVisible({ timeout: 15_000 });
  const url = await page.locator('.share-url').inputValue();
  await screenshot(page, testInfo, 'organiser-wizard-published');

  // Public page: live, bookable, venue hidden.
  const visitor = await browser.newPage();
  await visitor.goto(new URL(url).pathname);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(title);
  await expect(visitor.locator('body')).toContainText('Alwarpet');
  await expect(visitor.locator('body')).not.toContainText('9 Test Street');
  await visitor.close();

  // The other organiser cannot manage it.
  await page.getByRole('link', { name: 'Manage guests' }).click();
  const eventId = page.url().split('/').pop();
  const other = await browser.newPage();
  await signInAs(other, 'organiser2');
  expect((await other.request.get(`/api/organiser/events/${eventId}/guests`)).status()).toBe(404);
  await other.close();
});
