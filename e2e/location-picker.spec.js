// e2e/location-picker.spec.js - Location Picker interactive modal, alias search,
// geolocation permission handling, touch targets, and discovery integration.
import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow, expectAccessible, screenshot } from './helpers.js';

async function openLocationPicker(page) {
  const isMobile = await page.locator('.nav-toggle').isVisible();
  if (isMobile) {
    const menuClass = (await page.locator('#site-nav').getAttribute('class')) || '';
    if (!menuClass.includes('open')) {
      await page.locator('.nav-toggle').click();
    }
    await page.locator('.mobile-loc-wrap [data-loc-trigger]').click();
  } else {
    await page.locator('.header-left [data-loc-trigger]').click();
  }
}

test.describe('Location Intelligence V1 — Location Picker & Discovery', () => {
  test('opens location dialog and displays hubs and tiers', async ({ page }, testInfo) => {
    await page.goto('/events');
    await openLocationPicker(page);

    const dialog = page.locator('[data-location-dialog]');
    await expect(dialog).toBeVisible();

    // Check popular hubs pills
    await expect(dialog.locator('.loc-pill', { hasText: 'Chennai' })).toBeVisible();
    await expect(dialog.locator('.loc-pill', { hasText: 'Bengaluru' })).toBeVisible();
    await expect(dialog.locator('.loc-pill', { hasText: 'Coimbatore' })).toBeVisible();

    // Check device location action button
    const gpsBtn = dialog.locator('[data-loc-gps]');
    await expect(gpsBtn).toBeVisible();

    // Check accessibility
    await expectAccessible(page);
    await screenshot(page, testInfo, 'location-modal-open');

    // Close with Escape key
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('search matching: alias matching finds Bengaluru when typing Bangalore', async ({ page }) => {
    await page.goto('/events');
    await openLocationPicker(page);

    const searchInput = page.locator('[data-loc-search]');
    await searchInput.fill('Bangalore');

    // Bengaluru item should be visible
    const blrItem = page.locator('.loc-city-item[data-city-slug="bengaluru"]');
    await expect(blrItem).toBeVisible();

    // Chennai should be hidden
    const cheItem = page.locator('.loc-city-item[data-city-slug="chennai"]');
    await expect(cheItem).not.toBeVisible();

    // Click Bengaluru to apply
    await blrItem.click();

    // URL should update to include city=bengaluru
    await expect(page).toHaveURL(/city=bengaluru/);
    const triggerLabel = page.locator('[data-loc-current-label]:visible').first();
    await expect(triggerLabel).toHaveText('Bengaluru');
  });

  test('search matching: alias matching finds Coimbatore when typing Kovai', async ({ page }) => {
    await page.goto('/events');
    await openLocationPicker(page);

    const searchInput = page.locator('[data-loc-search]');
    await searchInput.fill('Kovai');

    const cbeItem = page.locator('.loc-city-item[data-city-slug="coimbatore"]');
    await expect(cbeItem).toBeVisible();

    await cbeItem.click();
    await expect(page).toHaveURL(/city=coimbatore/);
    await expect(page.locator('[data-loc-current-label]:visible').first()).toHaveText('Coimbatore');
  });

  test('state filter: filtering by Karnataka shows Karnataka cities only', async ({ page }) => {
    await page.goto('/events');
    await openLocationPicker(page);

    const stateSelect = page.locator('[data-loc-state-filter]');
    await stateSelect.selectOption('Karnataka');

    // Bengaluru and Mysuru should be visible
    await expect(page.locator('.loc-city-item[data-city-slug="bengaluru"]')).toBeVisible();
    await expect(page.locator('.loc-city-item[data-city-slug="mysuru"]')).toBeVisible();

    // Chennai and Kochi should not be visible
    await expect(page.locator('.loc-city-item[data-city-slug="chennai"]')).not.toBeVisible();
    await expect(page.locator('.loc-city-item[data-city-slug="kochi"]')).not.toBeVisible();
  });

  test('geolocation denied: handles permission denied gracefully without crashing', async ({ context, page }) => {
    // Grant no geolocation permission
    await context.clearPermissions();

    await page.goto('/events');
    await openLocationPicker(page);

    const gpsBtn = page.locator('[data-loc-gps]');
    await gpsBtn.click();

    const statusMsg = page.locator('[data-loc-status]');
    await expect(statusMsg).toBeVisible();
    await expect(statusMsg).toContainText(/Please select your city manually/i);

    // Dialog stays open and usable
    await expect(page.locator('[data-location-dialog]')).toBeVisible();
    await expect(page.locator('.loc-city-item[data-city-slug="chennai"]')).toBeVisible();
  });

  test('touch targets and responsiveness at 320px and 375px', async ({ page }) => {
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 667 });
      await page.goto('/events');
      await expectNoHorizontalOverflow(page);

      // Open location dialog
      await openLocationPicker(page);
      await expectNoHorizontalOverflow(page);

      // Check tap targets >= 44px
      const gpsBtnBox = await page.locator('[data-loc-gps]').boundingBox();
      expect(gpsBtnBox.height).toBeGreaterThanOrEqual(44);

      const closeBtnBox = await page.locator('[data-loc-close]').boundingBox();
      expect(closeBtnBox.height).toBeGreaterThanOrEqual(36);

      const cityItemBox = await page.locator('.loc-city-item[data-city-slug="chennai"]').boundingBox();
      expect(cityItemBox.height).toBeGreaterThanOrEqual(44);

      await page.keyboard.press('Escape');
    }
  });
});
