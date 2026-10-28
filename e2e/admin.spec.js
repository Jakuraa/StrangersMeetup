// e2e/admin.spec.js - The admin console for each role, and refusal for everyone else.
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';

test('super admin sees the console and the roles and audit screens', async ({ page }, testInfo) => {
  await signInAs(page, 'admin');
  await expect(page.locator('.admin-role')).toHaveText(/super admin/i);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
  await screenshot(page, testInfo, 'admin-overview');
  await page.getByRole('button', { name: 'Admins & audit' }).click();
  await expect(page.getByRole('heading', { name: 'Admins' })).toBeVisible();
  await expect(page.locator('main')).toContainText('support');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await screenshot(page, testInfo, 'admin-roles');
});

test('event staff (support) gets a limited console and is refused admin-only actions', async ({ page }, testInfo) => {
  await signInAs(page, 'staff');
  await expect(page.locator('.admin-role')).toHaveText(/support/i);
  await expect(page.getByRole('button', { name: 'Admins & audit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Insights' })).toHaveCount(0);
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
  await expect(page.locator('main')).toContainText('not on the admin allowlist');
  expect((await page.request.get('/api/admin/session')).status()).toBe(403);

  await signInAs(page, 'organiser');
  await page.goto('/admin');
  await expect(page.locator('main')).toContainText('not on the admin allowlist');
  expect((await page.request.get('/api/admin/overview')).status()).toBe(403);
});
