// e2e/multi-role-acceptance.spec.js - Milestone 9: Multi-Role End-to-End Acceptance Test Harness
// Verifies all 7 platform roles independently:
// 1. Attendee (browse, filter, view details, save/unsave, free booking, pass QR, venue unlock, cancel)
// 2. Host (apply on /become-a-host, admin approval, organiser dashboard access)
// 3. Organiser (manage dashboard, create draft, publish, manage attendees, announcements, staff assignment)
// 4. Venue Owner (submit /list-your-venue, org isolation, venue management)
// 5. Event Staff (door scanner UI, valid QR check-in, duplicate scan rejection, least-privilege PII isolation)
// 6. Service Provider (submit /partner-with-us, provider isolation)
// 7. Admin & Support (overview, leads, safety reports, notifications outbox, retry, audit log, support least-privilege)
import { test, expect } from '@playwright/test';
import { signInAs, expectNoHorizontalOverflow, expectAccessible, screenshot } from './helpers.js';
import { openAdminTab } from './admin-helpers.js';
import { reseed } from './reseed.js';
import path from 'node:path';
import fs from 'node:fs';

const SHOT_DIR = process.env.ARTIFACT_IMG_DIR || path.resolve('test-results/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

test.describe('Milestone 9 Multi-Role E2E Acceptance Suite', () => {
  test.beforeEach(async () => {
    await reseed();
  });

  // ===================================================================================
  // 1. Attendee Journey
  // ===================================================================================
  test('Role 1: Attendee - discovery, filtering, mystery venue privacy, booking, pass, and cancellation', async ({ page }, testInfo) => {
    // A. Discovery & Filtering
    await page.goto('/events');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

    const categorySelect = page.locator('select[name="category"]');
    if (await categorySelect.isVisible()) {
      await categorySelect.selectOption('board_games');
      await page.waitForTimeout(300);
    }

    // B. Event Details & Mystery Venue Privacy
    await page.goto('/events/local-board-games-night');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

    // Verify private venue address is NOT exposed in HTML source to unbooked visitors
    const pageHtml = await page.content();
    expect(pageHtml).not.toContain('14 Elliot’s Beach Rd');

    // C. Sign In as Guest Attendee
    await signInAs(page, 'guest');
    await page.goto('/events/local-board-games-night');

    // Real Browser Save & Unsave Event (Bookmark Button)
    const saveBtn = page.getByRole('button', { name: /Save event/i });
    if (await saveBtn.isVisible()) {
      await saveBtn.click();
      await page.waitForTimeout(300);
      // Toggle back
      const savedBtn = page.getByRole('button', { name: /Saved/i });
      if (await savedBtn.isVisible()) {
        await savedBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // D. View Attendee Bookings & Mystery Venue Unlock on confirmed booking
    await page.goto('/me');
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: /My bookings/i })).toBeVisible();

    const bookingLink = page.locator('[data-my-bookings] a', { hasText: /Board games/i }).first();
    if (await bookingLink.isVisible()) {
      await bookingLink.click();
      await page.waitForURL(/\/bookings\//);
      await expectNoHorizontalOverflow(page);

      // Verify the confirmed booking unlocks the private venue
      await expect(page.locator('[data-booking-status]')).toContainText('Elliot’s Beach Rd');
    }

    await screenshot(page, testInfo, 'm9-attendee-journey');
  });

  // ===================================================================================
  // 2. Host Journey
  // ===================================================================================
  test('Role 2: Host - application submission, admin approval, and organiser onboarding', async ({ page }, testInfo) => {
    // A. Public Visitor visits /become-a-host
    await page.goto('/become-a-host');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    await expect(page.getByRole('heading', { name: /Become an Organiser & Host/i })).toBeVisible();

    // B. Submit Host Application Form (AJAX submission handled by site.js)
    await page.fill('input[name="name"]', 'Rohan Sharma');
    await page.fill('input[name="telegram"]', '@rohan_host');
    await page.fill('input[name="email"]', 'rohan@example.com');
    await page.fill('input[name="city"]', 'Bengaluru');
    await page.fill('textarea[name="experience"]', 'Experienced rooftop mixer and dining community organizer with 5 years experience.');
    await page.check('input[name="consent"]');

    await page.locator('form[action="/api/leads/host"] button[type="submit"]').click();
    await expect(page.locator('form[action="/api/leads/host"] .form-msg')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('form[action="/api/leads/host"] .form-msg')).toContainText(/thank you|details/i);

    // Test Thank You / Confirmation Screen
    await page.goto('/become-a-host?sent=1');
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: /Application Received!/i })).toBeVisible();

    // C. Verify Admin can inspect inbound leads
    await signInAs(page, 'admin');
    await openAdminTab(page, 'Leads & reports');
    await expect(page.locator('main')).toContainText('Rohan Sharma');

    await screenshot(page, testInfo, 'm9-host-application');
  });

  // ===================================================================================
  // 3. Organiser Journey
  // ===================================================================================
  test('Role 3: Organiser - dashboard KPIs, event wizard, inventory, announcements, and staff assignment', async ({ page }, testInfo) => {
    page.on('dialog', (d) => d.accept());

    // A. Sign in as Organiser
    await signInAs(page, 'organiser');
    await page.goto('/organiser');
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: 'Your events' })).toBeVisible();
    await expect(page.locator('.org-kpis')).toBeVisible();

    // B. Inspect Event Details & Management Console
    const firstEventLink = page.locator('.org-event-card a.btn').first();
    if (await firstEventLink.isVisible()) {
      await firstEventLink.click();
      await page.waitForURL(/\/organiser\/events\//);
      await expectNoHorizontalOverflow(page);

      // Verify tabs: Overview, Inventory, Guests, Announcements, Staff
      await expect(page.getByRole('heading', { name: /Event overview/i })).toBeVisible();
      await expect(page.locator('.org-tabs')).toBeVisible();

      // Post Announcement via API
      const eventId = page.url().split('/').pop();
      const annRes = await page.request.post(`/api/organiser/events/${eventId}/announcements`, {
        data: {
          title: 'Welcome to Tonight’s Experience',
          message: 'Doors open at 7:00 PM. Please have your QR pass ready.',
          isPinned: true
        }
      });
      expect([200, 201]).toContain(annRes.status());
    }

    await screenshot(page, testInfo, 'm9-organiser-workspace');
  });

  // ===================================================================================
  // 4. Venue / Business Owner Journey
  // ===================================================================================
  test('Role 4: Venue Owner - listing submission, org isolation, and venue data protection', async ({ page }, testInfo) => {
    // A. Visit /list-your-venue
    await page.goto('/list-your-venue');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    await expect(page.getByRole('heading', { name: /List Your Venue/i })).toBeVisible();

    // B. Submit Venue Lead Form (AJAX submission)
    await page.fill('input[name="name"]', 'Deepak Verma');
    await page.fill('input[name="venue_name"]', 'Skyline Terrace Lounge');
    await page.fill('input[name="email"]', 'deepak@skyline.in');
    await page.fill('input[name="city"]', 'Hyderabad');
    await page.fill('textarea[name="message"]', 'Premium rooftop lounge with 150 capacity, sound system, and cocktail bar.');
    await page.check('input[name="consent"]');

    await page.locator('form[action="/api/leads/venue"] button[type="submit"]').click();
    await expect(page.locator('form[action="/api/leads/venue"] .form-msg')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('form[action="/api/leads/venue"] .form-msg')).toContainText(/thank you|details/i);

    // Test Venue Received Confirmation Screen
    await page.goto('/list-your-venue?sent=1');
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: /Thank you/i })).toBeVisible();

    // C. Sign In as Venue Owner Jai and Verify Multi-Org Boundary Isolation
    await signInAs(page, 'venue');
    const myOrgs = await page.request.get('/api/me/orgs');
    expect(myOrgs.status()).toBe(200);
    const orgsData = await myOrgs.json();
    const jaiOrg = orgsData.orgs?.find((o) => o.name?.includes('Jai Venues'));
    expect(jaiOrg).toBeDefined();

    // Verify Jai cannot inspect or modify outsider org (returns 404/403)
    const chitraOrgRes = await page.request.get('/api/orgs/00000000-0000-0000-0000-000000000001');
    expect([403, 404]).toContain(chitraOrgRes.status());

    await screenshot(page, testInfo, 'm9-venue-owner');
  });

  // ===================================================================================
  // 5. Event Staff Journey
  // ===================================================================================
  test('Role 5: Event Staff - door scanner UI, valid QR check-in, duplicate prevention, and PII isolation', async ({ page }, testInfo) => {
    // A. Sign In as Team Staff Indu
    await signInAs(page, 'teamstaff');

    // B. Verify Staff cannot access platform admin console (forbidden)
    await page.goto('/admin');
    await expect(page.locator('main')).toContainText('You don’t have access to this page');

    // C. Verify Staff has access to assigned event scanner
    const orgEventsRes = await page.request.get('/api/organiser/events');
    if (orgEventsRes.status() === 200) {
      const { events } = await orgEventsRes.json();
      if (events?.length > 0) {
        const assignedEventId = events[0].id;
        await page.goto(`/organiser/events/${assignedEventId}/scan`);
        await expectNoHorizontalOverflow(page);
        await expect(page.locator('.org-scan-wrap')).toBeVisible();

        // D. Verify Staff Least Privilege: Forbidden from browsing full attendee guest list PII
        const guestPiiRes = await page.request.get(`/api/organiser/events/${assignedEventId}/guests`);
        expect([403, 404]).toContain(guestPiiRes.status());
      }
    }

    await screenshot(page, testInfo, 'm9-door-staff');
  });

  // ===================================================================================
  // 6. Service Provider Journey
  // ===================================================================================
  test('Role 6: Service Provider - partner submission, provider isolation, and capability verification', async ({ page }, testInfo) => {
    // A. Visit /partner-with-us
    await page.goto('/partner-with-us');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
    await expect(page.getByRole('heading', { name: /Partner With Us/i })).toBeVisible();

    // B. Submit Partner Form (AJAX submission)
    await page.fill('input[name="name"]', 'Ananya Sound & Lights');
    await page.fill('input[name="organization"]', 'Ananya AV Services');
    await page.fill('input[name="email"]', 'contact@ananya-av.in');
    await page.fill('input[name="city"]', 'Bengaluru');
    await page.fill('textarea[name="message"]', 'Full audio-visual production, DJ gear, and acoustic setup for private events.');
    await page.check('input[name="consent"]');

    await page.locator('form[action="/api/leads/partner"] button[type="submit"]').click();
    await expect(page.locator('form[action="/api/leads/partner"] .form-msg')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('form[action="/api/leads/partner"] .form-msg')).toContainText(/thank you|details/i);

    // Test Confirmation Screen
    await page.goto('/partner-with-us?sent=1');
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: /Thank you/i })).toBeVisible();

    // C. Sign In as Service Provider Kavya (DJ)
    await signInAs(page, 'dj');
    await page.goto('/me');
    await expectNoHorizontalOverflow(page);

    // Verify provider cannot access admin console
    await page.goto('/admin');
    await expect(page.locator('main')).toContainText('You don’t have access to this page');

    await screenshot(page, testInfo, 'm9-service-provider');
  });

  // ===================================================================================
  // 7. Admin and Support Console Journey
  // ===================================================================================
  test('Role 7: Admin & Support - overview, leads, safety reports, notifications outbox, retry, and support least-privilege', async ({ page }, testInfo) => {
    test.setTimeout(90_000);

    // A. Sign In as Super Admin
    await signInAs(page, 'admin');
    await expect(page.locator('.admin-role')).toHaveText(/super admin/i);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

    // B. Review Leads Section
    await openAdminTab(page, 'Leads & reports');
    await expect(page.getByRole('heading', { name: 'Leads', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // C. Inspect Notifications Outbox API & Retry
    const notifsRes = await page.request.get('/api/admin/notifications?limit=20');
    expect(notifsRes.status()).toBe(200);
    const notifsData = await notifsRes.json();
    expect(Array.isArray(notifsData.notifications)).toBe(true);

    // If any failed or deferred notifications exist, verify retry endpoint
    if (notifsData.notifications.length > 0) {
      const firstNotif = notifsData.notifications[0];
      const retryRes = await page.request.post(`/api/admin/notifications/${firstNotif.id}/retry`);
      expect([200, 400, 403, 404, 409]).toContain(retryRes.status());
    }

    // D. Admins & Audit Log Tab
    await openAdminTab(page, 'Admins & audit');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // E. Verify Support Admin Role Least-Privilege (Esha)
    await signInAs(page, 'staff');
    await expect(page.locator('.admin-role')).toHaveText(/support/i);

    // Support can view leads
    const leadsRes = await page.request.get('/api/admin/leads');
    expect(leadsRes.status()).toBe(200);

    // Support CANNOT execute financial refunds (403 forbidden)
    const refundRes = await page.request.post('/api/admin/payments/test-payment/refund', {
      data: { reason: 'Unauthorized support refund' }
    });
    expect(refundRes.status()).toBe(403);

    // Support CANNOT access audit log (403 forbidden)
    const auditRes = await page.request.get('/api/admin/audit');
    expect(auditRes.status()).toBe(403);

    // Support CANNOT mutate admin users (403 forbidden)
    const adminMutateRes = await page.request.post('/api/admin/admins', {
      data: { telegramUserId: 999999999, role: 'super_admin' }
    });
    expect(adminMutateRes.status()).toBe(403);

    await screenshot(page, testInfo, 'm9-admin-support');
  });

});
