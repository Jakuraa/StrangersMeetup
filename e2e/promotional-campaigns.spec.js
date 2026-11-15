// e2e/promotional-campaigns.spec.js - Playwright E2E for WhatsApp promotional opt-in, account preferences, and organiser campaigns.
import { test, expect } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow, screenshot, signInAs } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';

const EVIDENCE_DIR = '/Users/pradeepjakuraa/.gemini/antigravity-cli/brain/6f313897-14aa-4f3b-8320-52b8ec01c32f/evidence';

test.describe('WhatsApp Promotional Marketing & Organiser Campaigns E2E', () => {
  test('Desktop (1280px): marketing consent on signup, account preferences, and organiser campaign workflow', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // 1. Visit /signin and verify marketing consent checkbox
    await page.goto('/signin');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Continue to NIGHTLIFEZ');
    await expect(page.locator('[data-auth-tab="whatsapp"]')).toBeVisible();

    const promoCheckbox = page.locator('#wa-promo-optin');
    await expect(promoCheckbox).toBeVisible();
    // Invariant: Unchecked by default!
    expect(await promoCheckbox.isChecked()).toBe(false);

    const promoHint = page.locator('#wa-promo-hint');
    await expect(promoHint).toContainText('Optional. Unchecked by default. Separate from essential login OTPs');

    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);

    const signinShotPath = path.join(EVIDENCE_DIR, 'whatsapp-marketing-consent-signup.png');
    await page.screenshot({ path: signinShotPath, fullPage: true });

    // 2. Sign in as organiser persona
    await signInAs(page, 'organiser');
    await page.waitForURL(/\/organiser$/);

    // 3. Find first managed event and go to manage page
    const manageLink = page.locator('a[href^="/organiser/events/"]').first();
    await expect(manageLink).toBeVisible();
    await manageLink.click();
    await page.waitForURL(/\/organiser\/events\/[a-f0-9-]+$/);

    // 4. Click WhatsApp Promotion tab
    const promoTab = page.locator('button[data-tab="promotions"]');
    await expect(promoTab).toBeVisible();
    await promoTab.click();

    // Verify WhatsApp promotion panel loads
    const audienceStat = page.locator('[data-audience-count]');
    await expect(audienceStat).toBeVisible();
    await expect(page.locator('.wa-bubble-preview')).toBeVisible();

    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);

    const promoTabShotPath = path.join(EVIDENCE_DIR, 'organiser-whatsapp-promotion-tab.png');
    await page.screenshot({ path: promoTabShotPath, fullPage: true });

    // 5. Create a campaign draft
    const titleInput = page.locator('#campaign-title-input');
    await expect(titleInput).toBeVisible();
    const createBtn = page.locator('[data-create-campaign-form] button[type="submit"]');
    await createBtn.click();

    // Wait for campaign to appear in history
    await page.waitForSelector('[data-dispatch-campaign], [data-approve-campaign]');

    // Approve campaign if draft
    const approveBtn = page.locator('[data-approve-campaign]').first();
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
      await page.waitForTimeout(500);
    }

    // Dispatch simulated campaign
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    const dispatchBtn = page.locator('[data-dispatch-campaign]').first();
    if (await dispatchBtn.isVisible()) {
      await dispatchBtn.click();
      await page.waitForTimeout(1000);
    }

    // View delivery logs
    const logsBtn = page.locator('[data-view-logs]').first();
    if (await logsBtn.isVisible()) {
      await logsBtn.click();
      await page.waitForTimeout(500);
    }

    const campaignLogsShotPath = path.join(EVIDENCE_DIR, 'organiser-whatsapp-campaign-logs.png');
    await page.screenshot({ path: campaignLogsShotPath, fullPage: true });

    // 6. Navigate to /me and verify communication preferences
    await page.goto('/me');
    const accountTab = page.locator('[data-hub-tab="account"]');
    await expect(accountTab).toBeVisible();
    await accountTab.click();

    await expect(page.locator('[data-toggle-promo-wa]')).toBeVisible();
    await expectAccessible(page);

    const accountShotPath = path.join(EVIDENCE_DIR, 'whatsapp-marketing-preferences-me.png');
    await page.screenshot({ path: accountShotPath, fullPage: true });
  });

  test('Mobile (375px): responsive layout, tap targets, and consent UX', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/signin');
    await expect(page.locator('#wa-promo-optin')).toBeVisible();
    expect(await page.locator('#wa-promo-optin').isChecked()).toBe(false);

    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, testInfo, 'mobile-whatsapp-marketing-signup');
  });
});
