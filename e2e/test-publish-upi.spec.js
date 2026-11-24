// e2e/test-publish-upi.spec.js
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow } from './helpers.js';

test('verify facilities redesign and direct upi publishing', async ({ page }) => {
  await signInAs(page, 'organiser');
  await page.goto('/organiser/new?fresh=1');

  // Start draft
  await page.getByRole('button', { name: /Party or nightlife/ }).click();
  await expect(page.locator('#f-title')).toBeVisible();

  // Step 1: Basics
  const title = `The Saturday Night Social ${Date.now()}`;
  await page.locator('#f-title').fill(title);
  await page.locator('#f-city').fill('Bengaluru');
  await page.locator('#f-area').fill('Indiranagar');
  await page.locator('#f-venue').fill('Secret Warehouse Indiranagar');

  const tmrw = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  await page.locator('#f-startLocal').fill(`${tmrw}T20:00`);
  await page.locator('#f-endLocal').fill(`${tmrw}T23:00`);

  await page.locator('#f-description').fill('Amazing direct UPI party with great music, visual effects and fun people. 21+ only.');
  const rightsCheckbox = page.locator('#f-imageRightsConfirmed');
  if (await rightsCheckbox.isVisible()) {
    await rightsCheckbox.check();
  }

  // Step 2: Tickets
  await page.getByRole('button', { name: /Next: Tickets/ }).click();
  await expect(page.locator('input[value="direct_upi"]')).toBeVisible();

  await page.locator('input[value="direct_upi"]').check();
  await expect(page.locator('#f-organiserUpiId')).toBeVisible();

  await page.locator('#f-organiserUpiId').fill('organiser@okaxis');
  await page.locator('#f-organiserPayeeName').fill('Party Host');

  const kindSelect = page.locator('select[data-path="tickets.0.kind"]');
  await expect(kindSelect).toBeVisible();
  await kindSelect.selectOption('paid');

  const priceInput = page.locator('input[data-path="tickets.0.pricePaise"]');
  await expect(priceInput).toBeVisible();
  await priceInput.fill('499');

  // Step 3: Features
  await page.getByRole('button', { name: /Next: Features/ }).click();
  await expect(page.getByRole('heading', { name: /Facilities & amenities/i })).toBeVisible();

  // Verify all 5 categories exist
  await expect(page.getByRole('heading', { name: 'Parking', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Food & Beverages', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accessibility', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Medical & Safety', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Other Facilities & Rules', exact: true })).toBeVisible();

  // Test individual facility card toggle
  const valetParking = page.locator('[data-act="toggle-facility"][data-key="valet_parking"]');
  await expect(valetParking).toBeVisible();
  await valetParking.click();
  await expect(valetParking).toHaveClass(/is-selected/);
  await expect(valetParking).toHaveAttribute('aria-checked', 'true');

  // Test "Select all" in Parking category
  const selectAllParking = page.locator('[data-act="select-all-cat"][data-cat="parking"]');
  await selectAllParking.click();
  const parkingSelected = page.locator('.facility-category-section:has-text("Parking") [aria-checked="true"]');
  expect(await parkingSelected.count()).toBe(5);

  // Test "Clear" in Parking category
  const clearParking = page.locator('[data-act="clear-cat"][data-cat="parking"]');
  await clearParking.click();
  expect(await parkingSelected.count()).toBe(0);

  // Toggle specific amenities across categories
  await page.locator('[data-act="toggle-facility"][data-key="free_parking"]').click();
  await page.locator('[data-act="toggle-facility"][data-key="alcohol_available"]').click();
  await page.locator('[data-act="toggle-facility"][data-key="wheelchair_accessible"]').click();
  await page.locator('[data-act="toggle-facility"][data-key="first_aid"]').click();

  // Add custom amenity
  await page.locator('#custom-fac-name').fill('Rooftop Swimming Pool');
  await page.locator('#custom-fac-desc').fill('Complimentary towel service provided');
  await page.locator('button[data-act="add-custom-facility"]').click();
  await expect(page.locator('.custom-facility-item')).toContainText('Rooftop Swimming Pool');

  // Take screenshot of redesigned Facilities UI
  await page.screenshot({ path: 'test-results/facilities-redesign.png', fullPage: false });
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  // Step 4: Preview
  await page.getByRole('button', { name: /^Next/ }).click();
  await expect(page.getByRole('button', { name: /Publish Event/i })).toBeVisible();

  // Click Publish Event to open dialog
  await page.getByRole('button', { name: /Publish Event/i }).click();

  const dialog = page.locator('[data-publish-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /Publish event/i })).toBeVisible();
  await expect(dialog).toContainText('organiser@okaxis');
  await expect(dialog).toContainText('Party Host');

  // Take screenshot of confirmation dialog
  await page.screenshot({ path: 'test-results/publish-dialog.png' });

  // Click Publish Event Now
  const confirmBtn = dialog.locator('[data-act="publish-confirm"]');
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();

  // Wait for published state
  await expect(page.locator('.wz-done')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.wz-done h1')).toContainText('Your event is live');

  // Take screenshot of published confirmation
  await page.screenshot({ path: 'test-results/event-published.png' });
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});
