// e2e/telegram-explicit-login.spec.js - E2E tests for explicit Telegram login initiation, age confirmation, and session logout.
import { test, expect } from '@playwright/test';
import { expectAccessible, expectNoHorizontalOverflow } from './helpers.js';

test.describe('Telegram Explicit Initiation & Session Logout', () => {
  test('Telegram tab selection does not inject widget script; requires explicit click and age confirmation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // Track network requests to telegram.org
    let telegramScriptRequested = false;
    page.on('request', (req) => {
      if (req.url().includes('telegram.org/js/telegram-widget.js')) {
        telegramScriptRequested = true;
      }
    });

    // 1. Visit /signin
    await page.goto('/signin');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Continue to NIGHTLIFEZ');

    // 2. Switch to Telegram tab
    const tgTab = page.locator('[data-auth-tab="telegram"]');
    await tgTab.click();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeVisible();

    // Invariant: Selecting the Telegram tab MUST NOT load the widget script automatically
    expect(telegramScriptRequested).toBe(false);
    expect(await page.locator('script[src*="telegram-widget.js"]').count()).toBe(0);

    // Initial UI state: button visible, widget wrapper hidden, age checkbox unchecked
    const startBtn = page.locator('[data-tg-start-btn]');
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toContainText('Continue with Telegram');

    const widgetWrap = page.locator('[data-tg-widget-wrap]');
    await expect(widgetWrap).toBeHidden();

    const ageCheckbox = page.locator('[data-age-confirm]');
    await expect(ageCheckbox).toBeVisible();
    expect(await ageCheckbox.isChecked()).toBe(false);

    // 3. Click "Continue with Telegram" WITHOUT checking age confirmation
    await startBtn.click();

    // Verify validation message is shown and script is NOT injected
    const errorMsg = page.locator('[data-tg-error]');
    await expect(errorMsg).toBeVisible();
    await expect(errorMsg).toContainText('confirm you are 21 or older');
    expect(telegramScriptRequested).toBe(false);
    expect(await page.locator('script[src*="telegram-widget.js"]').count()).toBe(0);
    await expect(widgetWrap).toBeHidden();

    // 4. Check the age confirmation checkbox
    await ageCheckbox.check();
    expect(await ageCheckbox.isChecked()).toBe(true);

    // 5. Click "Continue with Telegram" WITH age confirmation checked
    await startBtn.click();

    // Invariant: Button is hidden, widget wrapper is revealed, and script injection begins
    await expect(startBtn).toBeHidden();
    await expect(widgetWrap).toBeVisible();

    // The script element is appended to DOM
    await page.waitForFunction(() => !!document.querySelector('script[src*="telegram-widget.js"]'), { timeout: 5000 });
    expect(await page.locator('script[src*="telegram-widget.js"]').count()).toBe(1);

    // Loading indicator is rendered
    const loadingEl = page.locator('[data-tg-widget-loading]');
    await expect(loadingEl).toBeVisible();

    // Accessibility and overflow checks
    await expectAccessible(page, { exclude: ['iframe', '[data-tg-widget]'] });
    await expectNoHorizontalOverflow(page);
  });

  test('Switching between WhatsApp and Telegram retains proper state', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/signin');

    // Default to WhatsApp
    await expect(page.locator('[data-auth-panel="whatsapp"]')).toBeVisible();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeHidden();

    // Switch to Telegram
    await page.locator('[data-auth-tab="telegram"]').click();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeVisible();
    await expect(page.locator('[data-auth-panel="whatsapp"]')).toBeHidden();

    // Switch back to WhatsApp
    await page.locator('[data-auth-tab="whatsapp"]').click();
    await expect(page.locator('[data-auth-panel="whatsapp"]')).toBeVisible();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeHidden();

    // Switch back to Telegram again
    await page.locator('[data-auth-tab="telegram"]').click();
    await expect(page.locator('[data-auth-panel="telegram"]')).toBeVisible();
    await expect(page.locator('[data-tg-start-btn]')).toBeVisible();

    await expectNoHorizontalOverflow(page);
  });

  test('Signout clears session and redirects to signin with clean state', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // Perform WhatsApp OTP signin to obtain active session
    await page.goto('/signin');
    const middle = String(Math.floor(1000 + Math.random() * 9000));
    const testPhone = `98${middle}4455`;
    await page.locator('#wa-phone').fill(testPhone);
    await page.locator('[data-wa-age]').check();

    const [otpResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/whatsapp/otp') && r.status() === 200),
      page.locator('[data-wa-submit-phone]').click()
    ]);
    const { devOtp } = await otpResponse.json();

    await page.locator('#otp-input').fill(devOtp);
    await page.locator('[data-wa-verify-btn]').click();
    await page.waitForURL(/\/onboarding|\/me$/);

    // Verify session exists
    let cookies = await page.context().cookies();
    let sessionCookie = cookies.find((c) => c.name === 'sm_session');
    expect(sessionCookie).toBeTruthy();

    // Click sign out (works in focused onboarding header or attendee hub)
    const signoutBtn = page.locator('[data-signout]').first();
    await expect(signoutBtn).toBeVisible();
    await signoutBtn.click();

    // Should redirect to /signin
    await page.waitForURL(/\/signin/);

    // Session cookie must be cleared or expired
    cookies = await page.context().cookies();
    sessionCookie = cookies.find((c) => c.name === 'sm_session');
    expect(!sessionCookie || sessionCookie.value === '').toBe(true);

    // Refresh the page
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Continue to NIGHTLIFEZ');

    // Attempting to visit /me redirects back to /signin
    await page.goto('/me');
    await page.waitForURL(/\/signin\?next=%2Fme/);

    // Verify Telegram tab on this page is also in clean state
    await page.locator('[data-auth-tab="telegram"]').click();
    await expect(page.locator('[data-tg-start-btn]')).toBeVisible();
    expect(await page.locator('script[src*="telegram-widget.js"]').count()).toBe(0);
  });

  test('Mobile drawer signout button functions on small viewport (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    // Login via WhatsApp
    await page.goto('/signin');
    const middle = String(Math.floor(1000 + Math.random() * 9000));
    const testPhone = `98${middle}7788`;
    await page.locator('#wa-phone').fill(testPhone);
    await page.locator('[data-wa-age]').check();

    const [otpResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/auth/whatsapp/otp') && r.status() === 200),
      page.locator('[data-wa-submit-phone]').click()
    ]);
    const { devOtp } = await otpResponse.json();

    await page.locator('#otp-input').fill(devOtp);
    await page.locator('[data-wa-verify-btn]').click();
    await page.waitForURL(/\/onboarding|\/me$/);

    if (page.url().includes('/onboarding')) {
      const headerSignout = page.locator('header [data-signout]');
      await expect(headerSignout).toBeVisible();
      await headerSignout.click();
    } else {
      // Open mobile hamburger menu
      const navToggle = page.locator('.nav-toggle');
      await expect(navToggle).toBeVisible();
      await navToggle.click();

      // Mobile signout button should be visible in drawer
      const mobileSignoutBtn = page.locator('.mobile-signout-btn');
      await expect(mobileSignoutBtn).toBeVisible();
      await mobileSignoutBtn.click();
    }

    // Verify redirected to /signin
    await page.waitForURL(/\/signin/);

    // Trying to visit /me redirects
    await page.goto('/me');
    await page.waitForURL(/\/signin\?next=%2Fme/);
  });
});
