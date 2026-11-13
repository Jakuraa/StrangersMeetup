// e2e/venue-dashboard.spec.js - End-to-end verification of Venue Owner Dashboard (/venue).
// Verifies full lifecycle: authentication, overview KPIs, profile editing, event schedule without PII leak,
// booking enquiries decision workflow, staff coordination, safety reports, cross-role gating,
// responsive layouts across 320px-1280px, and axe WCAG 2.1 AA accessibility.
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot, smallTapTargets } from './helpers.js';
import { reseed } from './reseed.js';

test.describe('NIGHTLIFEZ Venue Owner Dashboard Full-Stack E2E Suite', () => {
  test.beforeEach(async () => {
    await reseed();
  });

  test('Journey 1: Venue Owner command centre inspection & full operational workflow', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Authenticate as persona 'venue' (Test Venue Owner Jai)
    await signInAs(page, 'venue');
    await expect(page).toHaveURL(/\/venue/);

    // 2. Verify Command Centre Header
    await expect(page.locator('.venue-heading')).toContainText('Test venue: Rooftop 9');
    await expect(page.locator('#venueStatusBadge')).toHaveText('Active');

    // 3. Verify All 7 Navigation Tabs
    const tabOverview = page.locator('#tabOverview');
    const tabProfile = page.locator('#tabProfile');
    const tabEvents = page.locator('#tabEvents');
    const tabEnquiries = page.locator('#tabEnquiries');
    const tabStaff = page.locator('#tabStaff');
    const tabSafety = page.locator('#tabSafety');
    const tabSettings = page.locator('#tabSettings');

    await expect(tabOverview).toBeVisible();
    await expect(tabProfile).toBeVisible();
    await expect(tabEvents).toBeVisible();
    await expect(tabEnquiries).toBeVisible();
    await expect(tabStaff).toBeVisible();
    await expect(tabSafety).toBeVisible();
    await expect(tabSettings).toBeVisible();

    // 4. Verify Overview & KPI Cards
    await expect(page.locator('#kpiCapacity')).toHaveText('80');
    await expect(page.locator('#panelOverview')).toBeVisible();

    // 5. Profile & Facilities Management
    await tabProfile.click();
    await expect(page.locator('#panelProfile')).toBeVisible();
    await expect(page.locator('#profileDetailsView')).toContainText('Test venue: Rooftop 9');
    await expect(page.locator('#profileDetailsView')).toContainText('80 guests');

    // Click "Edit Details" to open HTML5 <dialog>
    const btnEdit = page.locator('#btnEditProfile');
    await btnEdit.click();
    const editModal = page.locator('#modalEditProfile');
    await expect(editModal).toBeVisible();

    // Edit capacity to 100 and add a rule
    const capInp = editModal.locator('input[name="capacity"]');
    await capInp.fill('100');
    const rulesInp = editModal.locator('textarea[name="rules"]');
    await rulesInp.fill('21+ strictly enforced. Smart casual attire required.');

    // Save changes
    await editModal.locator('button[type="submit"]').click();
    await expect(page.locator('#editProfileMsg')).toContainText('updated successfully');
    await expect(editModal).not.toBeVisible();

    // Verify updated capacity rendered in view
    await expect(page.locator('#profileDetailsView')).toContainText('100 guests');

    // 6. Events Schedule & Attendee PII Shield
    await tabEvents.click();
    await expect(page.locator('#panelEvents')).toBeVisible();
    await expect(page.locator('#eventsListContainer')).toContainText('Test: Board games night');

    // Ensure NO attendee PII is rendered
    const eventsText = await page.locator('#eventsListContainer').innerText();
    expect(eventsText).not.toMatch(/\+91\s?\d{10}/);
    expect(eventsText).not.toMatch(/@([A-Za-z0-9_]+)\b/);

    // 7. Organiser Booking Enquiries & Decision
    await tabEnquiries.click();
    await expect(page.locator('#panelEnquiries')).toBeVisible();
    await expect(page.locator('#enquiriesListContainer')).toContainText('Sunset Deep House Session');

    // Approve the pending enquiry
    const approveBtn = page.locator('button[data-decide-btn="approve"]').first();
    await approveBtn.click();

    const decideModal = page.locator('#modalDecideEnquiry');
    await expect(decideModal).toBeVisible();
    await expect(decideModal).toContainText('Confirm approval');
    await decideModal.locator('#btnConfirmDecision').click();
    await expect(decideModal).not.toBeVisible();

    // 8. Staff Coordination
    await tabStaff.click();
    await expect(page.locator('#panelStaff')).toBeVisible();
    await expect(page.locator('#staffListContainer')).toContainText('Test Venue Owner Jai');

    // Open Add Staff Modal
    await page.locator('#btnAddStaff').click();
    const staffModal = page.locator('#modalAddStaff');
    await expect(staffModal).toBeVisible();
    await staffModal.locator('input[name="telegram_user_id"]').fill('9100000013');
    await staffModal.locator('select[name="role"]').selectOption('manager');
    await staffModal.locator('button[type="submit"]').click();
    await expect(page.locator('#addStaffMsg')).toContainText('Member added successfully');
    await expect(staffModal).not.toBeVisible();

    // 9. Safety Incident Reporting
    await tabSafety.click();
    await expect(page.locator('#panelSafety')).toBeVisible();

    await page.locator('#btnReportIssue').click();
    const reportModal = page.locator('#modalReportIssue');
    await expect(reportModal).toBeVisible();
    await reportModal.locator('select[name="category"]').selectOption('noise_complaint');
    await reportModal.locator('textarea[name="body"]').fill('Guest reported loud sub-bass vibrations at 23:30. Sound limiter activated.');
    await reportModal.locator('button[type="submit"]').click();
    await expect(page.locator('#reportIssueMsg')).toContainText('Incident escalated');
    await expect(reportModal).not.toBeVisible();

    // 10. Account & Notification Settings
    await tabSettings.click();
    await expect(page.locator('#panelSettings')).toBeVisible();
    const quietHoursCheck = page.locator('#settingQuietHours');
    await quietHoursCheck.check();
    await page.locator('#venueSettingsForm button[type="submit"]').click();
    await expect(page.locator('#settingsMsg')).toContainText('Preferences saved');

    // Return to Overview & take desktop screenshot
    await tabOverview.click();
    await screenshot(page, testInfo, 'venue-dashboard-desktop');

    // Ensure zero console errors occurred during the entire test
    expect(consoleErrors).toEqual([]);
  });

  test('Journey 2: Cross-role isolation & unauthenticated gate verification', async ({ page }) => {
    // 1. Unauthenticated visiting /venue
    await page.goto('/venue');
    await expect(page.locator('.venue-gate-card')).toBeVisible();
    await expect(page.locator('.venue-gate-card')).toContainText('Sign in to manage your venue');

    // 2. Authenticate as persona 'guest' (Asha) who does not operate any venue
    await signInAs(page, 'guest');
    await page.goto('/venue');

    // 3. Must render onboarding application form, NOT venue command centre
    await expect(page.locator('#venueApplyForm')).toBeVisible();
    await expect(page.locator('.venue-onboarding-intro')).toContainText('Turn quiet nights into curated, high-margin experiences');
    await expect(page.locator('.venue-header')).not.toBeVisible();
  });

  test('Journey 3: Responsive layouts (320px, 375px, 768px, 1024px, 1280px) & Accessibility (WCAG 2.1 AA)', async ({ page }, testInfo) => {
    await signInAs(page, 'venue');
    await page.goto('/venue');

    const viewports = [
      { name: 'desktop-1280px', width: 1280, height: 900 },
      { name: 'tablet-1024px', width: 1024, height: 768 },
      { name: 'tablet-768px', width: 768, height: 1024 },
      { name: 'mobile-375px', width: 375, height: 812 },
      { name: 'narrow-320px', width: 320, height: 568 }
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expect(page.locator('.venue-header')).toBeVisible();

      // Verify no horizontal page scrolling on any viewport
      await expectNoHorizontalOverflow(page);

      // Verify touch targets on phone width (≥ 44px)
      if (vp.width <= 375) {
        const smalls = await smallTapTargets(page);
        expect(smalls, `Touch targets under 44px at ${vp.width}px`).toEqual([]);
      }

      // Take screenshot of each viewport
      await screenshot(page, testInfo, `venue-dashboard-${vp.name}`);
    }

    // Run Axe automated accessibility audit against WCAG 2.1 AA standards
    await expectAccessible(page);
  });
});
