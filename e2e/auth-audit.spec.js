// e2e/auth-audit.spec.js - Playwright E2E for Telegram multi-account & WhatsApp production signin audit.
import { test, expect } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(process.cwd(), 'test-results', 'evidence');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

test.describe('NIGHTLIFEZ Sign-in Multi-Account & Production Verification', () => {
  test('Clean browser session: consent checkboxes unchecked, no premature OTP step, Telegram switch guidance', async ({ browser }, testInfo) => {
    // 1. Fresh, completely clean browser context with no stored cookies
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto('/signin');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Continue to NIGHTLIFEZ');

    // 2. Invariant: On clean session, OTP verification panel is strictly hidden
    const otpCard = page.locator('[data-wa-otp-card]');
    if (await otpCard.count() > 0) {
      await expect(otpCard).toBeHidden();
    }

    // Invariant: Dummy phone +91 98****1234 is NEVER displayed
    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('+91 98****1234');

    // 3. Switch to Telegram tab
    const tgTab = page.locator('[data-auth-tab="telegram"]');
    await tgTab.click();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeVisible();

    // 4. Invariant: Age confirmation is unchecked for fresh visitor
    const ageCheckbox = page.locator('[data-age-confirm]');
    if (await ageCheckbox.count() > 0) {
      expect(await ageCheckbox.isChecked()).toBe(false);
    }

    // 5. Invariant: Telegram Switch Account guidance is visible and helpful
    const switchTip = page.locator('[data-tg-switch-tip]');
    await expect(switchTip).toBeVisible();
    await expect(switchTip).toContainText('Signing in with a different Telegram account?');
    await expect(switchTip).toContainText('Incognito or Private window');
    await expect(switchTip).toContainText('web.telegram.org');

    await expectAccessible(page, { exclude: ['iframe'] });
    await expectNoHorizontalOverflow(page);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'clean-session-telegram-signin.png'), fullPage: true });
    await context.close();
  });

  test('Direct navigation to /signin?step=otp without active challenge safely defaults to phone step', async ({ browser }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/signin?step=otp');
    // OTP card must be hidden because no active challenge was issued
    const otpCard = page.locator('[data-wa-otp-card]');
    if (await otpCard.count() > 0) {
      await expect(otpCard).toBeHidden();
    }

    const bodyText = await page.textContent('body');
    expect(bodyText).not.toContain('+91 98****1234');

    await context.close();
  });

  test('Mobile (375px): Telegram switch tip and auth layout are fully responsive', async ({ browser }, testInfo) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/signin');
    await page.locator('[data-auth-tab="telegram"]').click();

    await expect(page.locator('[data-tg-switch-tip]')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'mobile-375px-telegram-switch-tip.png'), fullPage: true });
    await context.close();
  });
});
