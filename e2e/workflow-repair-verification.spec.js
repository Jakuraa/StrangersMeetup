// e2e/workflow-repair-verification.spec.js - Complete end-to-end verification of
// NIGHTLIFEZ workflow repair: auth destination preservation, draft persistence across refresh,
// checklist clearing, free publishing, attendee RSVP, My Bookings, and UPI settings isolation.
import { test, expect } from '@playwright/test';
import { PERSONAS, expectAccessible, expectNoHorizontalOverflow } from './helpers.js';

function localInput(daysAhead, hour) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  const ymd = new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return `${ymd}T${String(hour).padStart(2, '0')}:00`;
}

test('complete end-to-end product workflow verification', async ({ page, browser }, testInfo) => {
  const eventTitle = `NIGHTLIFEZ Experience ${Date.now().toString(36)}`;
  page.on('dialog', (d) => d.accept());

  // 1. Destination preservation: logged-out user tries to access /organiser/new
  await page.goto('/organiser/new');
  // Expect sign-in gate with Sign in button
  const gateSignIn = page.locator('a[href*="next="]').filter({ hasText: 'Sign in' });
  await expect(gateSignIn).toBeVisible();
  const gateHref = await gateSignIn.getAttribute('href');
  expect(gateHref).toContain('next=%2Forganiser%2Fnew');

  // Follow sign-in and authenticate as organiser
  await page.goto(gateHref);
  await page.getByRole('button', { name: new RegExp(PERSONAS.organiser.alias) }).click();
  // Should land directly on /organiser/new as requested by next parameter
  await page.waitForURL((u) => u.pathname === '/organiser/new');

  // Start a fresh "social" draft
  const freshBtn = page.getByRole('button', { name: 'Start fresh' });
  if (await freshBtn.isVisible().catch(() => false)) await freshBtn.click();
  await page.getByRole('button', { name: /Social meetup or matchmaking/ }).click();

  // Step 1: Basics
  await page.getByLabel('Event name').fill(eventTitle);
  await page.getByLabel('Starts').fill(localInput(10, 20));
  await page.getByLabel(/^Ends/).fill(localInput(10, 23));
  await page.getByLabel(/Venue or meeting point/).fill('The Loft — 42 Indiranagar');
  await page.getByLabel(/^City/).fill('Bengaluru');
  await page.getByLabel(/Area or neighbourhood/).fill('Indiranagar');
  await page.getByLabel('Description').fill('An exclusive rooftop social gathering for verified members. 21+ adults only.');

  // Step 2: Tickets
  await page.getByRole('button', { name: /Next: Tickets/ }).click();
  const tiers = page.locator('.tier-card');
  for (let n = await tiers.count(); n > 0; n--) {
    await tiers.first().getByRole('button', { name: 'Delete' }).click();
    await expect(tiers).toHaveCount(n - 1);
  }
  await page.getByRole('button', { name: '+ General' }).click();
  await expect(tiers).toHaveCount(1);
  await tiers.first().getByLabel(/Ticket display name|Ticket name/i).fill('General RSVP');
  await tiers.first().getByLabel('Quantity available').fill('30');
  await tiers.first().getByLabel('Max per booking').fill('2');

  // Wait for save indicator
  await expect(page.locator('[data-save-status]')).toContainText(/Saved|Ready to publish/i, { timeout: 10_000 });

  // 2. Draft persistence: Reload the page and confirm fields persist
  await page.reload();

  // Wizard resumes on step 'tickets' where we left off; verify persisted ticket values
  await expect(tiers.first().getByLabel(/Ticket display name|Ticket name/i)).toHaveValue('General RSVP');
  await expect(tiers.first().getByLabel('Quantity available')).toHaveValue('30');

  // Navigate back to Step 1 Basics and verify persisted basic fields
  await page.locator('.wz-steps button[data-step="basics"]').click();
  await expect(page.getByLabel('Event name')).toHaveValue(eventTitle);
  await expect(page.getByLabel(/^City/)).toHaveValue('Bengaluru');

  // Return to Tickets
  await page.getByRole('button', { name: /Next: Tickets/ }).click();

  // 3. Validation checklist clearing
  await page.locator('.wz-steps button[data-step="preview"]').click();
  await expect(page.locator('.ok-line')).toContainText('Everything needed is in place');

  // Temporarily break a field to verify checklist shows warning
  await page.locator('.wz-steps button[data-step="basics"]').click();
  await page.getByLabel('Event name').fill('');
  await page.locator('.wz-steps button[data-step="preview"]').click();
  await expect(page.getByText(/Add an event name/i)).toBeVisible();

  // Fix the field and confirm checklist clears immediately
  await page.locator('.wz-steps button[data-step="basics"]').click();
  await page.getByLabel('Event name').fill(eventTitle);
  await page.locator('.wz-steps button[data-step="preview"]').click();
  await expect(page.getByText(/Add an event name/i)).not.toBeVisible();
  await expect(page.locator('.ok-line')).toContainText('Everything needed is in place');

  // 4. Publish Free Event
  await page.getByRole('button', { name: /Publish (Free )?Event/i }).click();
  await page.getByRole('button', { name: /Publish.*Now/i }).click();
  await expect(page.getByRole('heading', { name: 'Your event is live' })).toBeVisible({ timeout: 15_000 });
  const eventPublicUrl = await page.locator('.share-url').inputValue();
  const eventPath = new URL(eventPublicUrl).pathname;

  // 5. Attendee Experience: Open public event page and book free ticket
  const attendeeContext = await browser.newContext();
  const attendeePage = await attendeeContext.newPage();
  await attendeePage.goto('/signin');
  await attendeePage.getByRole('button', { name: new RegExp(PERSONAS.guest.alias) }).click();
  await attendeePage.waitForURL((u) => u.pathname === PERSONAS.guest.landing);

  // Visit the public event page
  await attendeePage.goto(eventPath);
  await expect(attendeePage.getByRole('heading', { level: 1 })).toHaveText(eventTitle);
  await expect(attendeePage.locator('body')).toContainText('General RSVP');
  await expect(attendeePage.locator('body')).toContainText('Free');

  // Book 1 ticket
  await expect(attendeePage.locator('form.tier-form')).toBeVisible();
  await attendeePage.locator('form.tier-form button[type="submit"]').click();
  await attendeePage.waitForURL('**/bookings/**');
  await expect(attendeePage.locator('.digital-pass-card')).toContainText(/#SM-|Digital Pass|Booking confirmed/i, { timeout: 15_000 });

  // Verify ticket appears under My Bookings
  await attendeePage.goto('/me');
  await expect(attendeePage.locator('main')).toContainText(eventTitle);
  await attendeeContext.close();

  // 6. Organiser UPI Details under Business Settings
  await page.goto('/business');
  await page.locator('[data-biz-tab="payments"]').click();
  const upiInput = page.locator('#biz-upi-id');
  const payeeInput = page.locator('#biz-payee-name');
  await expect(upiInput).toBeVisible({ timeout: 10_000 });
  await upiInput.fill('nightlifez.events@okaxis');
  await payeeInput.fill('NIGHTLIFEZ Bengaluru Club');
  await page.locator('[data-save-payment-btn]').click();
  await expect(page.locator('[data-payment-msg]')).toContainText(/saved/i, { timeout: 10_000 });

  // Reload page and re-open tab to verify persistence
  await page.reload();
  await page.locator('[data-biz-tab="payments"]').click();
  await expect(page.locator('#biz-upi-id')).toHaveValue('nightlifez.events@okaxis');
  await expect(page.locator('#biz-payee-name')).toHaveValue('NIGHTLIFEZ Bengaluru Club');
  await expect(page.locator('[data-payment-status-badge]')).toContainText(/Verification Pending|Unverified/i);
});

test('browser test: select every preset (general, early_bird, couple, vip, free) -> Free (₹0) and publish successfully', async ({ page }) => {
  const eventTitle = `Free Presets Suite ${Date.now().toString(36)}`;
  page.on('dialog', (d) => d.accept());

  // Sign in as organiser
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(PERSONAS.organiser.alias) }).click();
  await page.waitForURL((u) => u.pathname === PERSONAS.organiser.landing);

  // Navigate to wizard and start fresh
  await page.goto('/organiser/new');
  const freshBtn = page.getByRole('button', { name: 'Start fresh' });
  if (await freshBtn.isVisible().catch(() => false)) await freshBtn.click();
  await page.getByRole('button', { name: /Social meetup or matchmaking/ }).click();

  // Step 1: Basics
  await page.getByLabel('Event name').fill(eventTitle);
  await page.getByLabel('Starts').fill(localInput(14, 19));
  await page.getByLabel(/^Ends/).fill(localInput(14, 22));
  await page.getByLabel(/Venue or meeting point/).fill('The Grand Ballroom — MG Road');
  await page.getByLabel(/^City/).fill('Bengaluru');
  await page.getByLabel(/Area or neighbourhood/).fill('MG Road');
  await page.getByLabel('Description').fill('Testing every preset chip to verify all tiers default to Free (₹0) and can be published.');

  // Step 2: Tickets
  await page.getByRole('button', { name: /Next: Tickets/ }).click();
  const tiers = page.locator('.tier-card');
  // Clear any pre-existing default tiers
  for (let n = await tiers.count(); n > 0; n--) {
    await tiers.first().getByRole('button', { name: 'Delete' }).click();
    await expect(tiers).toHaveCount(n - 1);
  }

  // Define every preset button to click
  const presets = [
    { button: '+ General', expectedName: 'General' },
    { button: '+ Early bird', expectedName: 'Early bird' },
    { button: '+ Couple', expectedName: 'Couple' },
    { button: '+ VIP', expectedName: 'VIP' },
    { button: '+ Free entry', expectedName: 'Free entry' }
  ];

  for (let i = 0; i < presets.length; i++) {
    const { button, expectedName } = presets[i];
    await page.getByRole('button', { name: button }).click();
    await expect(tiers).toHaveCount(i + 1);

    const card = tiers.nth(i);
    // 1. Confirm displayed ticket type is Free Pass (₹0)
    await expect(card.locator('.free-note').first()).toHaveText('Free Pass (₹0)');
    // 2. Confirm displayed price is Free — ₹0
    await expect(card.locator('.free-note').nth(1)).toHaveText('Free — ₹0');
    // 3. Confirm status pill is Free RSVP (₹0)
    await expect(card.locator('.pill-free')).toHaveText('Free RSVP (₹0)');
    // 4. Confirm no warning pill
    await expect(card.locator('.pill-warn')).toHaveCount(0);
    // 5. Confirm no paid warning help text
    await expect(card.getByText(/Paid tickets are preserved but cannot be published/i)).toHaveCount(0);
  }

  // Confirm no page-level paid alert
  await expect(page.locator('.wz-alert')).toHaveCount(0);

  // Wait for auto-save
  await expect(page.locator('[data-save-status]')).toContainText(/Saved|Ready to publish/i, { timeout: 10_000 });

  // Step 3: Features
  await page.getByRole('button', { name: /Next: Features/ }).click();

  // Step 4: Preview
  await page.getByRole('button', { name: /Next: Preview/ }).click();
  await expect(page.locator('.ok-line')).toContainText('Everything needed is in place');

  // Verify attendee preview cards in preview step show Free
  const previewTiers = page.locator('.ticket-tier, .tier-row, [data-preview-tier]');
  if (await previewTiers.count() > 0) {
    for (let i = 0; i < await previewTiers.count(); i++) {
      await expect(previewTiers.nth(i)).toContainText(/Free|₹0/);
    }
  }

  // Publish event
  await page.getByRole('button', { name: /Publish (Free )?Event/i }).click();
  await page.getByRole('button', { name: /Publish.*Now/i }).click();
  await expect(page.getByRole('heading', { name: 'Your event is live' })).toBeVisible({ timeout: 15_000 });
});
