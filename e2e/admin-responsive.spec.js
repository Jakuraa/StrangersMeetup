// e2e/admin-responsive.spec.js - The admin console across 320px, 375px, Pixel 7 (412px), tablet (768px) and
// desktop (1280px): tables become labelled cards when they would not fit, nothing critical is hidden, and the
// console works by keyboard, with named controls and honest loading / empty / error states.
// The server-side role checks are unchanged; these tests drive the real API (state-changing tests re-seed first).
import { test, expect, devices } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow, screenshot } from './helpers.js';
import { openAdminTab, waitAdminReady, inspectTable, mutateApi, focusRing, tabUntil } from './admin-helpers.js';
import { reseed, closeDb } from './reseed.js';
import { tabsFor } from '../lib/admin-roles.js';

// A device descriptor carries defaultBrowserType, which cannot be set inside a describe block.
const { defaultBrowserType, ...pixel7 } = devices['Pixel 7'];
const VIEWPORTS = [
  { name: '320', width: 320, use: { viewport: { width: 320, height: 640 } } },
  { name: '375', width: 375, use: { viewport: { width: 375, height: 667 } } },
  { name: 'pixel7', width: pixel7.viewport.width, use: pixel7 },
  { name: 'tablet', width: 768, use: { viewport: { width: 768, height: 1024 } } },
  { name: 'desktop', width: 1280, use: { viewport: { width: 1280, height: 800 } } }
];
const AXE_AT = new Set(['320', 'pixel7', 'desktop']);
const LONG = 'A'.repeat(300);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.afterAll(closeDb);

for (const vp of VIEWPORTS) {
  test.describe(`admin @ ${vp.name}`, () => {
    test.use(vp.use);
    test.beforeEach(reseed);
    const cards = vp.width < 1280; // the 7-column Events table needs about 920px of panel width
    const shot = (page, testInfo, name) => screenshot(page, testInfo, `admin-${vp.name}-${name}`);

    test('every section fits, names its tables and keeps every column', async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      await signInAs(page, 'admin');
      await waitAdminReady(page);
      for (const [, label] of tabsFor('super_admin')) {
        await openAdminTab(page, label);
        await expectNoHorizontalOverflow(page);
        const tables = page.locator('#admin-main table.t');
        for (let i = 0; i < await tables.count(); i++) {
          const t = tables.nth(i);
          if (!(await t.isVisible())) continue; // e.g. a collapsed "Table view"
          await expect(t, `${label}: table ${i} needs an accessible name`).toHaveAttribute('aria-label', /.+/);
          const r = await inspectTable(t);
          expect(r.problems, `${label} [${r.headers.join(' | ')}]`).toEqual([]);
          expect(r.panelOverflow, `${label}: the panel scrolls sideways`).toBeLessThanOrEqual(0);
        }
        if (AXE_AT.has(vp.name)) await expectAccessible(page);
      }
    });

    test('events: cards when narrow, a real table on desktop; identity first; actions named and tappable', async ({ page }, testInfo) => {
      await signInAs(page, 'admin');
      await openAdminTab(page, 'Events');
      const t = page.getByRole('table', { name: 'Events' });
      const r = await inspectTable(t);
      expect(r.mode).toBe(cards ? 'cards' : 'table');
      expect(r.problems).toEqual([]);
      expect(r.headers).toEqual(['When', 'Title', 'City', 'Status', 'Price', 'Booked', 'Actions']);
      expect(r.rows).toBeGreaterThanOrEqual(8);
      // Table semantics survive the card layout (rows/columns are still exposed to assistive technology).
      await expect(t.getByRole('columnheader')).toHaveCount(7);
      expect(await t.getByRole('row').count()).toBeGreaterThanOrEqual(9);
      if (cards) {
        const first = t.locator('tbody tr').first();
        const title = await first.locator('td.t-primary').boundingBox();
        const when = await first.locator('td').first().boundingBox();
        expect(title.y, 'the event title leads the card').toBeLessThan(when.y);
        expect(r.minActionHeight, 'actions are at least 44px tall').toBeGreaterThanOrEqual(44);
      } else {
        await expect(t.locator('thead')).toBeVisible();
        await expect(t.locator('.t-lab').first()).toBeHidden();
      }
      const names = await t.locator('.t-actions button, .t-actions a').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim()));
      expect(new Set(names).size, 'every row action has a unique accessible name').toBe(names.length);
      expect(names).toContain('Attendees for Test: Board games night');
      expect(names).toContain('Unpublish Test: Sunday picnic (open for booking)'); // a published event offers Unpublish
      await shot(page, testInfo, 'events');
    });

    test('bookings: member identity, booking status and payment stay readable', async ({ page }, testInfo) => {
      await signInAs(page, 'staff');
      await openAdminTab(page, 'Bookings & payments');
      const t = page.getByRole('table', { name: 'Bookings', exact: true });
      const r = await inspectTable(t);
      expect(r.problems).toEqual([]);
      expect(r.headers).toEqual(['Created', 'Event', 'Member', 'Booking', 'Payment', 'Provider txn', 'Amount', 'Actions']);
      const row = t.locator('tbody tr', { hasText: 'Test Guest Asha' }).filter({ hasText: 'Board games night' });
      await expect(row.locator('td.t-primary')).toContainText('Test Guest Asha');
      await expect(row.locator('.pill', { hasText: 'confirmed' })).toBeVisible();
      await expect(row.getByText('Test: Board games night')).toBeVisible();
      await shot(page, testInfo, 'bookings');
    });

    test('check-in: the list stays open, updates in place, and is audit-logged in full', async ({ page, hasTouch }, testInfo) => {
      await signInAs(page, 'staff');
      await openAdminTab(page, 'Events');
      await page.getByRole('button', { name: 'Attendees for Test: Board games night' }).click();
      const panel = page.getByRole('region', { name: 'Check-in for Test: Board games night' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('heading')).toBeInViewport();
      await expect(panel.getByRole('status')).toHaveText('0 of 1 checked in');
      const t = panel.getByRole('table', { name: 'Attendees of Test: Board games night' });
      const before = await inspectTable(t);
      expect(before.problems).toEqual([]);
      if (AXE_AT.has(vp.name)) await expectAccessible(page);
      await shot(page, testInfo, 'attendees-before');

      const checkIn = panel.getByRole('button', { name: 'Check in Test Guest Asha' });
      await expect(checkIn).toBeInViewport();
      const box = await checkIn.boundingBox();
      if (cards) expect(box.height).toBeGreaterThanOrEqual(44);
      if (hasTouch) await checkIn.tap(); else await checkIn.click();

      await expect(page.getByRole('status').filter({ hasText: 'Checked in Test Guest Asha' })).toBeVisible();
      await expect(panel.getByRole('status').first()).toHaveText('1 of 1 checked in'); // same panel, refreshed in place
      await expect(panel.getByRole('button', { name: /^Check in/ })).toHaveCount(0);
      await expect(panel.locator('.pill', { hasText: 'checked in' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot(page, testInfo, 'attendees-after');

      // The audit log (super admin) records who did it, to which booking, with nothing truncated.
      await signInAs(page, 'admin');
      await openAdminTab(page, 'Admins & audit');
      const audit = page.getByRole('table', { name: 'Audit log' });
      const row = audit.locator('tbody tr', { hasText: 'booking.check_in' }).first();
      await expect(row).toBeVisible();
      await expect(row.locator('td').nth(1).locator('.t-val')).toHaveText(/^admin:[0-9a-f-]{36}:support$/);
      const target = row.locator('td').nth(3).locator('.t-val');
      expect((await target.textContent()).trim()).toMatch(UUID);
      const tb = await target.boundingBox();
      expect(tb.x + tb.width).toBeLessThanOrEqual(vp.width + 1);
      const ai = await inspectTable(audit);
      expect(ai.problems).toEqual([]);
      await shot(page, testInfo, 'audit');
    });

    test('moderation: status controls are named, work through the real API, and respect roles', async ({ page }, testInfo) => {
      await signInAs(page, 'staff');
      await openAdminTab(page, 'Leads & reports');
      const leads = page.getByRole('table', { name: 'Leads' });
      expect((await inspectTable(leads)).problems).toEqual([]);
      await expect(page.getByRole('heading', { name: 'Safety reports' })).toHaveCount(0); // support cannot see reports
      expect((await (await page.request.get('/api/admin/leads')).json()).reports).toEqual([]);
      const select = leads.getByRole('combobox', { name: /^Status of venue lead from/ });
      await select.selectOption('contacted');
      await expect(page.getByRole('status').filter({ hasText: 'Updated' })).toBeVisible();
      await openAdminTab(page, 'Leads & reports');
      await expect(leads.getByRole('combobox', { name: /^Status of venue lead from/ })).toHaveValue('contacted');
      await shot(page, testInfo, 'leads');

      await signInAs(page, 'admin');
      await openAdminTab(page, 'Leads & reports');
      const reports = page.getByRole('table', { name: 'Safety reports' });
      await expect(reports.locator('td.t-primary')).toContainText('TEST-0001'); // the report text leads its card
      await expect(reports).toContainText('Test Guest Asha');                   // and who sent it is still shown
      expect((await inspectTable(reports)).problems).toEqual([]);
      await reports.getByRole('combobox', { name: /^Status of safety report/ }).selectOption('reviewing');
      await expect(page.getByRole('status').filter({ hasText: 'Updated' })).toBeVisible();
      await shot(page, testInfo, 'reports');
    });

    test('states: loading, empty, server error, offline and forbidden', async ({ page }, testInfo) => {
      await signInAs(page, 'admin');
      await waitAdminReady(page);
      const main = page.locator('#admin-main');

      // loading
      await page.route('**/api/admin/leads', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
      await openAdminTab(page, 'Leads & reports', { wait: false });
      await expect(main).toHaveAttribute('aria-busy', 'true');
      await expect(main).toContainText('Loading Leads & reports…');
      await shot(page, testInfo, 'loading');
      await waitAdminReady(page);
      await expect(page.getByRole('table', { name: 'Leads' })).toBeVisible();
      await page.unroute('**/api/admin/leads');

      // server error, then recovery through "Try again"
      await page.route('**/api/admin/leads', (route) => route.fulfill({ status: 500, json: { ok: false, error: 'server_error', message: 'Database is unavailable' } }));
      await openAdminTab(page, 'Leads & reports');
      const alert = main.getByRole('alert');
      await expect(alert).toContainText('Could not load this section');
      await expect(alert).toContainText('Database is unavailable');
      await expectNoHorizontalOverflow(page);
      if (vp.width <= 800) {
        // A short section must not stretch the closed phone nav into an empty dark block.
        const nav = await page.locator('.admin-nav').boundingBox();
        const toggle = await page.locator('.admin-nav-toggle').boundingBox();
        expect(nav.y + nav.height - (toggle.y + toggle.height), 'closed nav hugs its toggle').toBeLessThanOrEqual(24);
      }
      await shot(page, testInfo, 'error');
      await page.unroute('**/api/admin/leads');
      const retry = alert.getByRole('button', { name: 'Try again' });
      expect((await retry.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await retry.click();
      await expect(page.getByRole('table', { name: 'Leads' })).toBeVisible();

      // offline
      await page.route('**/api/admin/leads', (route) => route.abort('failed'));
      await openAdminTab(page, 'Leads & reports');
      await expect(main.getByRole('alert')).toContainText('Network problem');
      await page.unroute('**/api/admin/leads');

      // forbidden: no retry offered
      await page.route('**/api/admin/leads', (route) => route.fulfill({ status: 403, json: { ok: false, error: 'forbidden_role', message: 'Your role cannot do this' } }));
      await openAdminTab(page, 'Leads & reports');
      await expect(main.getByRole('alert')).toContainText('Not available for your role');
      await expect(main.getByRole('button', { name: 'Try again' })).toHaveCount(0);
      await page.unroute('**/api/admin/leads');

      // empty states (real, unmodified responses)
      await openAdminTab(page, 'Memberships');
      await expect(main).toContainText('No memberships yet.');
      await page.getByRole('searchbox', { name: /Search members/ }).fill('zzzz');
      await page.keyboard.press('Enter');
      await expect(main).toContainText('No members match “zzzz”.');
      await openAdminTab(page, 'Bookings & payments');
      await expect(main).toContainText('No membership payments.');
      await page.getByRole('combobox', { name: 'Filter bookings by status' }).selectOption('refunded');
      await expect(main).toContainText('No bookings match this filter.');
      await expectNoHorizontalOverflow(page);
      await openAdminTab(page, 'Media');
      await expect(main).toContainText('No media yet.');
      await shot(page, testInfo, 'empty');
    });

    test('long unbroken text wraps in every table instead of overflowing', async ({ page }, testInfo) => {
      await signInAs(page, 'admin');
      await mutateApi(page, /\/api\/admin\/leads$/, (j) => { j.leads[0].payload.message = LONG; j.reports[0].body = LONG; });
      await mutateApi(page, /\/api\/admin\/events$/, (j) => { j.events[0].title = LONG; });
      await mutateApi(page, /\/api\/admin\/bookings(\?.*)?$/, (j) => { j.bookings[0].alias = LONG; j.bookings[0].title = LONG; });
      await mutateApi(page, /\/api\/admin\/audit$/, (j) => { j.audit[0].actor = `user:${LONG}`; j.audit[0].target = LONG; j.audit[0].details = { note: LONG }; });
      await mutateApi(page, /\/api\/admin\/events\/[0-9a-f-]+\/attendees$/, (j) => {
        j.attendees.unshift({ id: '00000000-0000-4000-8000-000000000000', alias: LONG, ref: '00000000', status: 'confirmed' });
      });
      const cases = [['Leads & reports', ['Leads', 'Safety reports']], ['Events', ['Events']], ['Bookings & payments', ['Bookings']], ['Admins & audit', ['Audit log']]];
      for (const [label, names] of cases) {
        await openAdminTab(page, label);
        for (const name of names) {
          const t = page.getByRole('table', { name, exact: true });
          const r = await inspectTable(t);
          expect(r.problems, `${name}`).toEqual([]);
          expect(r.panelOverflow, `${name}: panel scrolls sideways`).toBeLessThanOrEqual(0);
        }
        await expect(page.locator('#admin-main')).toContainText(LONG); // wrapped, not truncated
        await expectNoHorizontalOverflow(page);
      }
      await openAdminTab(page, 'Events');
      await page.getByRole('button', { name: /^Attendees for / }).first().click();
      const att = page.getByRole('table', { name: /^Attendees of / });
      await expect(att).toContainText(LONG);
      const r = await inspectTable(att);
      expect(r.problems).toEqual([]);
      expect(r.panelOverflow).toBeLessThanOrEqual(0);
      await expectNoHorizontalOverflow(page);
      await shot(page, testInfo, 'long-text');
    });

    test('keyboard: sections, row actions and check-in work with visible focus', async ({ page }, testInfo) => {
      await signInAs(page, 'staff');
      await waitAdminReady(page);
      const main = page.locator('#admin-main');
      if (vp.width <= 800) {
        const toggle = page.locator('.admin-nav-toggle');
        await tabUntil(page, '.admin-nav-toggle');
        const toggleRing = await focusRing(page);
        expect(toggleRing.style).not.toBe('none');
        expect(toggleRing.width).toBeGreaterThanOrEqual(2);
        await page.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await page.keyboard.press('Escape');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle).toBeFocused();
        await page.keyboard.press('Enter');
        await tabUntil(page, '[data-tab="events"]', 5);
        expect((await focusRing(page)).width).toBeGreaterThanOrEqual(2);
        await page.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      } else {
        await tabUntil(page, '[data-tab="events"]');
        const ring = await focusRing(page);
        expect(ring.style).not.toBe('none');
        expect(ring.width).toBeGreaterThanOrEqual(2);
        await page.keyboard.press('Enter');
      }
      await waitAdminReady(page);
      await expect(main.getByRole('heading', { level: 1, name: 'Events' })).toBeFocused(); // focus moves to the new section

      // Reach a row action by keyboard, see where focus is, and use it.
      await tabUntil(page, 'button[aria-label="Attendees for Test: Board games night"]', 60);
      const ring = await focusRing(page);
      expect(ring.style).not.toBe('none');
      expect(ring.width).toBeGreaterThanOrEqual(2);
      await expect(page.locator(':focus')).toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('region', { name: 'Check-in for Test: Board games night' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Check-in — Test: Board games night' })).toBeFocused();
      await tabUntil(page, 'button[aria-label="Check in Test Guest Asha"]', 10);
      expect((await focusRing(page)).width).toBeGreaterThanOrEqual(2);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('region', { name: 'Check-in for Test: Board games night' }).getByRole('status').first()).toHaveText('1 of 1 checked in');
      await shot(page, testInfo, 'keyboard');
    });

    test('section navigation: sidebar on desktop, a full-width Sections button on phones', async ({ page }, testInfo) => {
      await signInAs(page, 'admin');
      await waitAdminReady(page);
      const adminNav = page.locator('.admin-nav');
      const toggle = page.locator('.admin-nav-toggle');
      const nav = page.getByRole('navigation', { name: 'Admin sections' });
      const labels = tabsFor('super_admin').map(([, label]) => label);
      // Every section once, in order, and nothing else in the list (read from the DOM: the phone menu starts closed).
      expect(await page.locator('#admin-sections button').allTextContents()).toEqual(labels);

      if (vp.width > 800) {
        await expect(toggle).toBeHidden();
        await expect(nav).toBeVisible();
        for (const label of labels) await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
        expect(await adminNav.evaluate((n) => n.innerText)).not.toContain('Sections'); // no stray toggle text in the sidebar
        await expect(page.locator('#admin-main').getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
        // Reduced motion (set for the whole suite) must also switch off the cross-page view transition.
        expect(await page.evaluate(() => document.activeViewTransition ?? null)).toBeNull();
        await shot(page, testInfo, 'nav');
      } else {
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAccessibleName('Sections Overview');
        expect(await toggle.evaluate((b) => b.innerText.replace(/\s+/g, ' ').trim())).toBe('Sections Overview');
        await expect(nav).toBeHidden();
        // A real button: filled, at least 44px tall, and as wide as the nav's content box.
        const box = await adminNav.evaluate((n) => {
          const b = n.querySelector('.admin-nav-toggle'); const cs = getComputedStyle(n); const bs = getComputedStyle(b);
          return { width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height, bg: bs.backgroundColor, cursor: bs.cursor,
            avail: n.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
        });
        expect(Math.abs(box.width - box.avail)).toBeLessThanOrEqual(1);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.bg).not.toBe('rgba(0, 0, 0, 0)');
        expect(box.cursor).toBe('pointer');
        await shot(page, testInfo, 'nav-closed');

        // Mouse: open, then close with the same button.
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        for (const label of labels) await expect(nav.getByRole('button', { name: label, exact: true })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await shot(page, testInfo, 'nav-open');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(nav).toBeHidden();

        // Keyboard: Space and Enter open it, Escape closes it and returns focus to the button.
        await toggle.focus();
        await page.keyboard.press('Space');
        await expect(nav).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(nav).toBeHidden();
        await expect(toggle).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(nav).toBeVisible();
        await page.keyboard.press('Enter'); // the same button closes it again
        await expect(nav).toBeHidden();

        // Choosing a section closes the menu and the button names the current section.
        await openAdminTab(page, 'Events');
        await expect(nav).toBeHidden();
        await expect(toggle).toHaveAccessibleName('Sections Events');
      }
      await expectNoHorizontalOverflow(page);
    });

    test('section navigation keeps role filtering: support staff see only their sections', async ({ page }) => {
      await signInAs(page, 'staff');
      await waitAdminReady(page);
      const sections = page.locator('#admin-sections button');
      expect(await sections.allTextContents()).toEqual(tabsFor('support').map(([, label]) => label));
      await expect(sections.filter({ hasText: 'Admins & audit' })).toHaveCount(0);
      // The server still refuses a super-admin API to this role, whatever the layout.
      expect((await page.request.get('/api/admin/admins')).status()).toBe(403);
    });
  });
}
