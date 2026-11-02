// e2e/admin.spec.js - The admin console for each role, and refusal for everyone else.
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';
import { openAdminTab } from './admin-helpers.js';

test('super admin sees the console and the roles and audit screens', async ({ page }, testInfo) => {
  test.setTimeout(90_000); // axe on the dense overview takes ~30s on a loaded runner
  await signInAs(page, 'admin');
  await expect(page.locator('.admin-role')).toHaveText(/super admin/i);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
  await screenshot(page, testInfo, 'admin-overview');
  await openAdminTab(page, 'Admins & audit');
  await expect(page.getByRole('heading', { name: 'Admins' })).toBeVisible();
  await expect(page.locator('main')).toContainText('support');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'admin-roles');
});

test('event staff (support) gets a limited console and is refused admin-only actions', async ({ page }, testInfo) => {
  await signInAs(page, 'staff');
  await expect(page.locator('.admin-role')).toHaveText(/support/i);
  const toggle = page.locator('.admin-nav-toggle');
  if (await toggle.isVisible()) await toggle.click(); // phone widths: the section list is collapsed
  const sections = page.getByRole('navigation', { name: 'Admin sections' });
  await expect(sections.getByRole('button', { name: 'Events', exact: true })).toBeVisible();
  await expect(sections.getByRole('button', { name: 'Admins & audit' })).toHaveCount(0);
  await expect(sections.getByRole('button', { name: 'Insights' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'staff-overview');
  for (const [method, path] of [['GET', '/api/admin/audit'], ['GET', '/api/admin/insights'], ['POST', '/api/admin/admins']]) {
    const r = await page.request.fetch(path, { method, data: method === 'POST' ? {} : undefined, headers: { 'x-csrf-token': 'x' } });
    expect(r.status(), `${method} ${path}`).toBe(403);
  }
  expect((await page.request.get('/api/admin/bookings')).status()).toBe(200);
});

test('guests and organisers are refused the console', async ({ page }) => {
  await signInAs(page, 'guest');
  await page.goto('/admin');
  await expect(page.locator('main')).toContainText('You don’t have access to this page');
  expect((await page.request.get('/api/admin/session')).status()).toBe(403);

  await signInAs(page, 'organiser');
  await page.goto('/admin');
  await expect(page.locator('main')).toContainText('You don’t have access to this page');
  expect((await page.request.get('/api/admin/overview')).status()).toBe(403);
});
