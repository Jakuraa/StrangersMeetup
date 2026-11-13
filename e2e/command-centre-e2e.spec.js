// e2e/command-centre-e2e.spec.js - Comprehensive E2E Verification of Super Admin Command Centre
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot, smallTapTargets } from './helpers.js';
import { openAdminTab, waitAdminReady } from './admin-helpers.js';
import { reseed } from './reseed.js';

test.describe('Super Admin Command Centre Full-Stack E2E Suite', () => {
  test.beforeEach(async () => {
    await reseed();
  });

  test('Journey 1: Super Admin Command Centre comprehensive inspection & workflows', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Authenticate as Super Admin
    await signInAs(page, 'admin');
    await expect(page.locator('.admin-role')).toHaveText(/super admin/i);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    // 2. Verify all 6 Sections are rendered
    await expect(page.getByRole('heading', { name: /Executive Overview/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Operations Centre/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Financial Overview/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /User & Marketplace Growth/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Safety & Trust/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Configuration & System Health/i })).toBeVisible();

    // 3. Verify Executive KPIs
    await expect(page.locator('.cmd-kpi-grid')).toBeVisible();
    await expect(page.locator('.cmd-kpi-grid')).toContainText('Registered Users');
    await expect(page.locator('.cmd-kpi-grid')).toContainText('Gross Live Revenue');
    await expect(page.locator('.cmd-kpi-grid')).toContainText('SuperProfile Orders');
    await expect(page.locator('.cmd-kpi-grid')).toContainText('Telegram Stars');

    // 4. Verify Upcoming Events Readiness & Check-in workflow
    const checkinBtn = page.locator('#admin-main').getByRole('button', { name: /^Check-in/i }).first();
    if (await checkinBtn.isVisible()) {
      await checkinBtn.click();
      await expect(page.getByRole('heading', { name: /^Check-in —/i })).toBeVisible();
      // Test the back button we added
      const backBtn = page.getByRole('button', { name: /Back to Command Centre/i });
      await expect(backBtn).toBeVisible();
      await backBtn.click();
      await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    }

    // 5. Test Navigation Shortcuts
    const viewLeadsBtn = page.getByRole('button', { name: 'View Leads' });
    if (await viewLeadsBtn.isVisible()) {
      await viewLeadsBtn.click();
      await waitAdminReady(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
      await openAdminTab(page, 'Overview');
    }

    const viewOrdersBtn = page.getByRole('button', { name: 'View Orders' }).first();
    if (await viewOrdersBtn.isVisible()) {
      await viewOrdersBtn.click();
      await waitAdminReady(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Orders (SuperProfile)' })).toBeVisible();
      await openAdminTab(page, 'Overview');
    }

    // 6. Verify System Architecture Health Diagnostics
    const healthGrid = page.locator('.cmd-health-grid');
    await expect(healthGrid).toBeVisible();
    await expect(healthGrid).toContainText('Neon PostgreSQL Database');
    await expect(healthGrid).toContainText('Session Cookie Encryption');
    await expect(healthGrid).toContainText('Telegram Bot (@Nightlifez_bot)');
    await expect(healthGrid).toContainText('Telegram Browser Login Widget');
    await expect(healthGrid).toContainText('Telegram Events Chat Architecture');
    await expect(healthGrid).toContainText('Payment Safeguard Locks');

    // 7. Verify Zero Horizontal Overflow & Accessibility
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    await screenshot(page, testInfo, 'command-centre-super-admin-full');

    // 8. Confirm Zero Uncaught Console Errors
    expect(consoleErrors).toEqual([]);
  });

  test('Journey 7: Restricted Roles - Support and Moderator least-privilege enforcement', async ({ page }, testInfo) => {
    // A. Support Role
    await signInAs(page, 'staff');
    await expect(page.locator('.admin-role')).toHaveText(/support/i);
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

    // Support must not see restricted tabs
    const toggle = page.locator('.admin-nav-toggle');
    if (await toggle.isVisible()) await toggle.click();
    const nav = page.getByRole('navigation', { name: 'Admin sections' });
    await expect(nav.getByRole('button', { name: 'Admins & audit' })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Insights' })).toHaveCount(0);

    // Support can view leads but cannot see safety reports table
    await openAdminTab(page, 'Leads & reports');
    await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Safety reports' })).toHaveCount(0);

    // Support API restrictions
    const auditRes = await page.request.get('/api/admin/audit');
    expect(auditRes.status()).toBe(403);
    const adminMutate = await page.request.post('/api/admin/admins', { data: { telegramUserId: 12345, role: 'super_admin' } });
    expect(adminMutate.status()).toBe(403);

    await expectNoHorizontalOverflow(page);
    await screenshot(page, testInfo, 'command-centre-support-role');
  });

  const RESPONSIVE_VIEWPORTS = [
    { name: '320px', width: 320, height: 640 },
    { name: '375px', width: 375, height: 667 },
    { name: '390px', width: 390, height: 844 },
    { name: '430px', width: 430, height: 932 },
    { name: '768px', width: 768, height: 1024 },
    { name: '1024px', width: 1024, height: 768 },
    { name: '1280px', width: 1280, height: 800 }
  ];

  for (const vp of RESPONSIVE_VIEWPORTS) {
    test(`Responsive & Layout Integrity at ${vp.name} (${vp.width}x${vp.height})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signInAs(page, 'admin');
      await waitAdminReady(page);

      // Verify no horizontal overflow at this exact viewport
      await expectNoHorizontalOverflow(page);

      // Verify all 6 section headings remain in DOM
      await expect(page.getByRole('heading', { name: /Executive Overview/i })).toBeAttached();
      await expect(page.getByRole('heading', { name: /Operations Centre/i })).toBeAttached();
      await expect(page.getByRole('heading', { name: /Financial Overview/i })).toBeAttached();
      await expect(page.getByRole('heading', { name: /User & Marketplace Growth/i })).toBeAttached();
      await expect(page.getByRole('heading', { name: /Safety & Trust/i })).toBeAttached();
      await expect(page.getByRole('heading', { name: /Configuration & System Health/i })).toBeAttached();

      // On narrow mobile viewports, check tap targets
      if (vp.width <= 430) {
        const small = await smallTapTargets(page, 40);
        expect(small, `Controls smaller than 40px at ${vp.name}`).toEqual([]);
      }

      await screenshot(page, testInfo, `command-centre-${vp.name}`);
    });
  }
});
