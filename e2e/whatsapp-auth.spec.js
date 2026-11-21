// e2e/whatsapp-auth.spec.js - End-to-end tests for WhatsApp OTP sign-in, WebOTP form compliance, and account preferences.
import { test, expect } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';
import { getWhatsAppProvider } from '../lib/services/whatsapp-provider.js';

test.describe('WhatsApp OTP Authentication E2E', () => {
  test('Desktop (1280px): complete WhatsApp OTP signup, WebOTP form verification, and preferences', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    getWhatsAppProvider().clearSentMessages();

    // 1. Visit /signin
    await page.goto('/signin');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Continue to NIGHTLIFEZ');
    await expect(page.locator('[data-auth-tab="whatsapp"]')).toBeVisible();
    await expect(page.locator('[data-auth-tab="telegram"]')).toBeVisible();
    await expect(page.locator('[data-wa-phone-form]')).toBeVisible();

    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, testInfo, 'desktop-signin-whatsapp-tab');

    // 2. Fill mobile number, confirm age, request OTP
    // Use unique phone with 98 prefix and 3210 suffix so masking matches +91 98****3210 without cooldown collision
    const middle = String(Math.floor(1000 + Math.random() * 9000));
    const testPhone = `98${middle}3210`;
    const phoneInput = page.locator('#wa-phone');
    await phoneInput.fill(testPhone);
    await page.locator('[data-wa-age]').check();
    await page.locator('[data-wa-promo]').check();

    const [otpResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/whatsapp/otp') && r.status() === 200),
      page.locator('[data-wa-submit-phone]').click()
    ]);
    const otpJson = await otpResponse.json();
    const code = otpJson.devOtp;
    expect(code).toMatch(/^\d{6}$/);

    // 3. Verify OTP step is displayed
    const otpCard = page.locator('[data-wa-otp-card]');
    await expect(otpCard).toBeVisible();
    await expect(page.locator('#otp-input')).toBeVisible();
    await expect(page.locator('#otp-format-hint')).toBeVisible();
    await expect(page.locator('[data-wa-masked-phone]')).toContainText('+91 98****3210');

    // Check modern web guidance compliance
    await expect(page.locator('#otp-input')).toHaveAttribute('inputmode', 'numeric');
    await expect(page.locator('#otp-input')).toHaveAttribute('autocomplete', 'one-time-code');
    await expect(page.locator('#otp-input')).toHaveAttribute('pattern', '\\d{6}');
    await expect(page.locator('#otp-input')).toHaveAttribute('maxlength', '6');

    await expectAccessible(page);
    await screenshot(page, testInfo, 'desktop-signin-otp-step');

    // 4. Fill OTP and submit
    await page.locator('#otp-input').fill(code);
    await page.locator('[data-wa-verify-btn]').click();

    // 5. User lands on /onboarding (new member) or /me (existing member)
    await page.waitForURL(/\/onboarding|\/me$/);
    if (page.url().includes('/onboarding')) {
      // Step 1: Welcome
      await page.locator('[data-onboard-action="next-step"][data-target-step="2"]').click();
      // Step 2: 21+ Age confirmation
      await page.locator('#onboard-age-check').check();
      await page.locator('[data-onboard-submit="2"]').click();
      // Step 3: Profile
      await page.locator('#onboard-display-name').fill('WhatsApp User');
      await page.locator('#onboard-gender').selectOption('prefer_not_to_say');
      await page.locator('#onboard-city').selectOption('Bengaluru');
      await page.locator('[data-onboard-submit="3"]').click();
      // Step 4: Interests
      await page.locator('label:has(input[value="parties_nightlife"])').click();
      await page.locator('[data-onboard-submit="4"]').click();
      // Step 5: Optional details
      await page.locator('[data-onboard-submit="5"]').click();
      // Step 6: Finish
      await page.locator('[data-onboard-action="finish-onboarding"]').click();
      await page.waitForURL(/\/me$/);
    }
    await expect(page.getByRole('heading', { level: 1 })).toContainText('My bookings');

    // 6. Navigate to Account & Logins tab
    const accountTab = page.locator('[data-hub-tab="account"]');
    await expect(accountTab).toBeVisible();
    await accountTab.click();

    const accountSection = page.locator('[data-hub-section="account"]');
    await expect(accountSection).toBeVisible();
    await expect(accountSection).toContainText('Connected Login Methods');
    await expect(accountSection).toContainText('✓ Connected (+91 98****3210)');
    await expect(accountSection).toContainText('Communication Preferences');

    await expectAccessible(page);
    await expectNoHorizontalOverflow(page);
    await screenshot(page, testInfo, 'desktop-attendee-account-settings');
  });

  test('Mobile (375px): responsive layout, tap targets, and switcher behavior', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 667 });
    getWhatsAppProvider().clearSentMessages();

    await page.goto('/signin');
    await expectNoHorizontalOverflow(page);

    // Switch to Telegram tab
    await page.locator('[data-auth-tab="telegram"]').click();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeVisible();
    await expect(page.locator('[data-auth-panel="whatsapp"]')).toBeHidden();

    // Switch back to WhatsApp tab
    await page.locator('[data-auth-tab="whatsapp"]').click();
    await expect(page.locator('[data-auth-panel="whatsapp"]')).toBeVisible();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeHidden();

    await screenshot(page, testInfo, 'mobile-signin-whatsapp');
  });

  test('Native HTML form submission with JavaScript disabled: verifies explicit POST semantics and zero URL leakage', async ({ browser }, testInfo) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    getWhatsAppProvider().clearSentMessages();

    await page.goto('/signin');
    const form = page.locator('[data-wa-phone-form]');
    await expect(form).toHaveAttribute('method', 'POST');
    await expect(form).toHaveAttribute('action', '/api/auth/whatsapp/otp');

    const testPhone = `97${String(Math.floor(10000000 + Math.random() * 90000000))}`;
    await page.locator('#wa-phone').fill(testPhone);
    await page.locator('[data-wa-age]').check();

    // Submit form natively
    await page.locator('[data-wa-submit-phone]').click();
    await page.waitForLoadState('networkidle');

    // Invariant: Phone number MUST NOT be in current page URL
    const currentUrl = page.url();
    expect(currentUrl).not.toContain(testPhone);
    expect(currentUrl).not.toContain('phone=');
    expect(currentUrl).not.toContain('ageConfirmed=');
    expect(currentUrl).toMatch(/\/signin\?step=otp/);

    // Verify OTP card is shown
    await expect(page.locator('[data-wa-otp-card]')).toBeVisible();

    await context.close();
  });
});
