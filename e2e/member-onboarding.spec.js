// e2e/member-onboarding.spec.js - E2E tests for new member onboarding flow and responsive layouts.
import { test, expect } from '@playwright/test';
import { expectNoHorizontalOverflow } from './helpers.js';
import { makeUserUnonboarded, reseed } from './reseed.js';

test.describe('New Member Onboarding Journey', () => {
  test.beforeEach(async () => {
    await makeUserUnonboarded('Test Guest Bala');
  });

  test.afterAll(async () => {
    await reseed();
  });

  test('Complete onboarding flow: Welcome -> Age -> Profile -> Interests -> Optional -> Complete', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 }); // Mobile viewport (iPhone 14/15)

    // 1. Visit /onboarding while unauthenticated -> redirected to /signin
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/signin/);

    // 2. Sign in as Bala (un-onboarded test user)
    await page.getByRole('button', { name: /Test Guest Bala/ }).click();
    await page.waitForURL(/\/onboarding/);

    const container = page.locator('[data-onboarding-container]');
    await expect(container).toBeVisible();

    // Verify progress header exists
    const progressFill = page.locator('[data-progress-fill]');
    await expect(progressFill).toBeVisible();

    // Verify Step 1: Welcome is visible
    const step1 = page.locator('[data-step-panel="1"]');
    await expect(step1).toBeVisible();
    await expect(step1.locator('.onboarding-title')).toContainText('Welcome to NIGHTLIFEZ');

    // Click "Get Started →"
    const startBtn = page.locator('[data-onboard-action="next-step"][data-target-step="2"]');
    await startBtn.click();

    // Step 2: 21+ Age confirmation
    const step2 = page.locator('[data-step-panel="2"]');
    await expect(step2).toBeVisible();
    const ageCheck = page.locator('#onboard-age-check');
    await ageCheck.check();
    expect(await ageCheck.isChecked()).toBe(true);

    const step2Submit = page.locator('[data-onboard-submit="2"]');
    await step2Submit.click();

    // Step 3: Basic Profile
    const step3 = page.locator('[data-step-panel="3"]');
    await expect(step3).toBeVisible();

    await page.locator('#onboard-display-name').fill('Priya Sharma');
    await page.locator('#onboard-gender').selectOption('female');
    await page.locator('#onboard-city').selectOption('Bengaluru');

    const step3Submit = page.locator('[data-onboard-submit="3"]');
    await step3Submit.click();

    // Step 4: Interests Selection
    const step4 = page.locator('[data-step-panel="4"]');
    await expect(step4).toBeVisible();

    // Select 2 interest chips
    await page.locator('label:has(input[value="parties_nightlife"])').click();
    await page.locator('label:has(input[value="dining_food"])').click();

    // Verify active count indicator
    await expect(page.locator('[data-interests-counter]')).toContainText('2 interests selected');

    const step4Submit = page.locator('[data-onboard-submit="4"]');
    await step4Submit.click();

    // Step 5: Optional profile
    const step5 = page.locator('[data-step-panel="5"]');
    await expect(step5).toBeVisible();

    // Fill bio
    await page.locator('#onboard-bio').fill('Love exploring new restaurants and live music events.');
    const langEnglish = page.locator('label:has(input[value="English"])');
    if (await langEnglish.count() > 0) await langEnglish.click();

    const step5Submit = page.locator('[data-onboard-submit="5"]');
    await step5Submit.click();

    // Step 6: Personalised Completion Screen
    const step6 = page.locator('[data-step-panel="6"]');
    await expect(step6).toBeVisible();
    await expect(page.locator('[data-welcome-subheading]')).toContainText('Priya Sharma');

    // Complete onboarding
    const finishBtn = page.locator('[data-onboard-action="finish-onboarding"]');
    await finishBtn.click();
    await page.waitForLoadState('domcontentloaded');

    // Verify redirection to /me
    await expect(page).toHaveURL(/\/me/);
    await expect(page.locator('[data-attendee-hub]')).toBeVisible();

    // Verify subsequent visit to /onboarding redirects immediately to /me
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/me/);
  });

  test('Responsive viewports on /onboarding have no horizontal overflow', async ({ page }) => {
    // Sign in as Bala to view /onboarding
    await page.goto('/signin');
    await page.getByRole('button', { name: /Test Guest Bala/ }).click();
    await page.waitForURL(/\/onboarding/);

    const widths = [320, 360, 375, 393, 430, 768, 1024, 1280];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await expectNoHorizontalOverflow(page);
    }
  });

  test('Sign-out button in focused onboarding header revokes session cleanly', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/signin');
    await page.getByRole('button', { name: /Test Guest Bala/ }).click();
    await page.waitForURL(/\/onboarding/);

    const signoutBtn = page.locator('header [data-signout]');
    await expect(signoutBtn).toBeVisible();
    await signoutBtn.click();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/\/signin/);

    // Ensure session is gone: visiting /me redirects to /signin
    await page.goto('/me');
    await expect(page).toHaveURL(/\/signin/);
  });
});
