// e2e/attendee-journey.spec.js - Phase 3D End-to-End Attendee Journey & Mystery Venue Unlock
import { test, expect } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';

const SHOT_DIR = process.env.ARTIFACT_IMG_DIR || path.resolve('/Users/pradeepjakuraa/.gemini/antigravity-cli/brain/7f74d945-b586-4b54-8d34-633de3b778cf/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

test.describe('Phase 3D Attendee Discovery, Booking & Mystery Venue Journey', () => {
  test('complete attendee journey: instant discovery, reviewer signin, free booking, and venue unlock', async ({ page }) => {
    // 1. Discovery catalog (/events)
    await page.goto('/events');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

    // Verify Mystery Venue badge on event cards
    const mysteryBadge = page.locator('.badge-mystery').first();
    await expect(mysteryBadge).toBeVisible();
    await expect(mysteryBadge).toContainText('Mystery Venue');

    // 2. Instant Discovery: Category filter test with history pushState
    const initialUrl = page.url();
    const categorySelect = page.locator('form[data-filters] select[name="category"]');
    if (await categorySelect.isVisible()) {
      await categorySelect.selectOption('nightlife');
      await page.waitForTimeout(400); // Allow async fetch & DOM swap
      expect(page.url()).toContain('category=nightlife');
      await expect(page.locator('.card-title').filter({ hasText: 'Indiranagar Rooftop' })).toBeVisible();

      // Test browser back navigation (popstate)
      await page.goBack();
      await page.waitForTimeout(400);
      expect(page.url()).toBe(initialUrl);
    }

    // 3. Navigate to Event Detail Page
    await page.goto('/events/sample-bengaluru-indiranagar-rooftop-mixer');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

    // Verify Mystery Venue branded teaser in details
    const mysteryTeaser = page.locator('.mystery-venue-teaser');
    await expect(mysteryTeaser).toBeVisible();
    await expect(mysteryTeaser).toContainText('Mystery Venue — Revealed after confirmed booking');

    // Ensure private address is NOT exposed anywhere in the HTML source before booking
    const htmlContent = await page.content();
    expect(htmlContent).not.toContain('Secret Terrace, 12th Main Road');

    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3d-event-detail.png'), fullPage: false });

    // 4. Sign in as Preview Reviewer
    await page.goto('/signin?next=' + encodeURIComponent('/events/sample-bengaluru-indiranagar-rooftop-mixer'));
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('.preview-reviewer-box')).toBeVisible();

    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3d-signin-reviewer.png'), fullPage: false });

    // Click "Sign in as Preview Reviewer"
    await Promise.all([
      page.waitForURL('**/events/sample-bengaluru-indiranagar-rooftop-mixer'),
      page.locator('.preview-reviewer-form button').click()
    ]);

    // 5. Book Free Ticket
    await expect(page.locator('form.tier-form')).toBeVisible();
    await page.locator('form.tier-form button[type="submit"]').click();

    // Should redirect to confirmed booking pass
    await page.waitForURL('**/bookings/**');
    await expectNoHorizontalOverflow(page);

    // 6. Confirmed Pass & Unlocked Mystery Venue
    await expect(page.locator('.unlocked-venue-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.unlocked-venue-badge')).toContainText('Venue Unlocked');
    await expect(page.locator('.unlocked-venue-addr')).toContainText('Secret Terrace, 12th Main Road, Indiranagar');

    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3d-booking-confirmed.png'), fullPage: false });

    // 7. Attendee Booking History (/me)
    await page.goto('/me');
    await expectNoHorizontalOverflow(page);
    await expect(page.locator('.booking-list')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.booking-list')).toContainText('Indiranagar Rooftop Social & Cocktails');

    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3d-attendee-my-bookings.png'), fullPage: false });
  });

  test('mobile responsive viewports: 320px, 375px, 430px', async ({ page }) => {
    // 320px Ultra-compact iPhone SE
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/events');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3d-mobile-320px.png'), fullPage: false });

    // 375px Standard iPhone
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/events/sample-bengaluru-indiranagar-rooftop-mixer');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3d-mobile-375px.png'), fullPage: false });

    // 430px Large iPhone Pro Max
    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto('/events');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3d-mobile-430px.png'), fullPage: false });
  });
});
