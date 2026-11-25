// e2e/final-acceptance.spec.js - PR #65 Final Acceptance Pass
import { test, expect } from '@playwright/test';
import pg from 'pg';
import fs from 'node:fs';
import { E2E_DATABASE_URL } from './env.js';
import { signInAs, expectNoHorizontalOverflow } from './helpers.js';

const dbUrl = process.env.DATABASE_URL || E2E_DATABASE_URL || 'postgres://localhost:5432/sm_e2e';
const pool = new pg.Pool({ connectionString: dbUrl.includes(':5432') ? dbUrl : dbUrl.replace('localhost/', 'localhost:5432/') });

const VIEWPORTS = [
  { width: 320, height: 640, name: '320px-small-phone' },
  { width: 360, height: 740, name: '360px-android' },
  { width: 375, height: 812, name: '375px-iphone-se' },
  { width: 390, height: 844, name: '390px-iphone-14' },
  { width: 412, height: 915, name: '412px-pixel-7' },
  { width: 430, height: 932, name: '430px-iphone-pro-max' },
  { width: 768, height: 1024, name: '768px-tablet' },
  { width: 1280, height: 800, name: '1280px-desktop' }
];

test.describe('PR #65 Final Acceptance Pass', () => {
  let createdEventSlug = '';
  let createdEventId = '';
  let createdDraftId = '';

  test.beforeAll(async () => {
    fs.mkdirSync('test-results/acceptance', { recursive: true });
  });

  test.afterAll(async () => {
    await pool.end();
  });

  test('1. End-to-end direct UPI event creation, module persistence, and publishing', async ({ page }) => {
    await signInAs(page, 'organiser');
    await page.goto('/organiser/new?fresh=1');

    // Select Party template
    await page.getByRole('button', { name: /Party or nightlife/ }).click();
    await expect(page.locator('#f-title')).toBeVisible();

    const timestamp = Date.now();
    const title = `The Penthouse Rooftop Social ${timestamp}`;
    const tmrw = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

    // Step 1: Basics
    await page.locator('#f-title').fill(title);
    await page.locator('#f-city').fill('Bengaluru');
    await page.locator('#f-area').fill('Indiranagar');
    await page.locator('#f-venue').fill('100ft Road Penthouse');
    await page.locator('#f-startLocal').fill(`${tmrw}T20:00`);
    await page.locator('#f-endLocal').fill(`${tmrw}T23:30`);
    await page.locator('#f-description').fill('Exclusive rooftop experience with direct organiser UPI ticketing, premium cocktails and music.');

    const rightsCheckbox = page.locator('#f-imageRightsConfirmed');
    if (await rightsCheckbox.isVisible()) {
      await rightsCheckbox.check();
    }

    // Step 2: Tickets
    await page.getByRole('button', { name: /Next: Tickets/ }).click();
    await expect(page.locator('input[value="direct_upi"]')).toBeVisible();

    // Select Direct UPI
    await page.locator('input[value="direct_upi"]').check();
    await expect(page.locator('#f-organiserUpiId')).toBeVisible();

    await page.locator('#f-organiserUpiId').fill('host@okhdfcbank');
    await page.locator('#f-organiserPayeeName').fill('Nightlife Host');

    // Configure Paid Tier
    const kindSelect = page.locator('select[data-path="tickets.0.kind"]');
    await expect(kindSelect).toBeVisible();
    await kindSelect.selectOption('paid');

    const priceInput = page.locator('input[data-path="tickets.0.pricePaise"]');
    await expect(priceInput).toBeVisible();
    await priceInput.fill('499');

    const nameInput = page.locator('input[data-path="tickets.0.name"]');
    await nameInput.fill('VIP Access Pass');

    const qtyInput = page.locator('input[data-path="tickets.0.quantity"]');
    await qtyInput.fill('30');

    // Configure Offer in Tickets Step
    const addOfferBtn = page.locator('button[data-act="add-offer"][data-offer="percent10"]');
    await expect(addOfferBtn).toBeVisible();
    await addOfferBtn.click();
    await expect(page.locator('input[data-path="offers.0.name"]')).toBeVisible();

    // Configure Sales Timeline in Tickets Step
    const timelineSwitch = page.locator('button[data-act="toggle"][data-path="salesTimeline.enabled"]');
    await expect(timelineSwitch).toBeVisible();
    await timelineSwitch.click();
    const addPhaseBtn = page.locator('button[data-act="add-sales-phase"][data-phase="early_access"]');
    await expect(addPhaseBtn).toBeVisible();
    await addPhaseBtn.click();
    await expect(page.locator('input[data-path="salesTimeline.phases.0.name"]')).toBeVisible();

    // Configure Venue Section Layout in Tickets Step
    const sectionLayoutBtn = page.locator('button[data-act="set-venue-layout-type"][data-val="section_based"]');
    await expect(sectionLayoutBtn).toBeVisible();
    await sectionLayoutBtn.click();
    const addSecBtn = page.locator('button[data-act="add-venue-section"][data-sec="vip"]');
    await expect(addSecBtn).toBeVisible();
    await addSecBtn.click();
    await expect(page.locator('input[data-path="venueLayout.sections.0.name"]')).toBeVisible();

    // Step 3: Features
    await page.getByRole('button', { name: /Next: Features/ }).click();
    await expect(page.getByRole('heading', { name: /Facilities & amenities/i })).toBeVisible();

    // Select facilities across categories
    await page.locator('[data-act="toggle-facility"][data-key="free_parking"]').click();
    await page.locator('[data-act="toggle-facility"][data-key="valet_parking"]').click();
    await page.locator('[data-act="toggle-facility"][data-key="alcohol_available"]').click();
    await page.locator('[data-act="toggle-facility"][data-key="wheelchair_accessible"]').click();
    await page.locator('[data-act="toggle-facility"][data-key="first_aid"]').click();
    await page.locator('[data-act="toggle-facility"][data-key="smoking_zones"]').click();

    // Add Custom Facility
    await page.locator('#custom-fac-name').fill('Rooftop Poolside Cabana');
    await page.locator('#custom-fac-desc').fill('Complimentary towel service & dedicated lounge server');
    await page.locator('button[data-act="add-custom-facility"]').click();
    await expect(page.locator('.custom-facility-item')).toContainText('Rooftop Poolside Cabana');

    // Step 4: Preview
    await page.getByRole('button', { name: /^Next/ }).click();
    await expect(page.getByRole('button', { name: /Publish Event/i })).toBeVisible();

    // Capture draft ID & CSRF before publishing
    const { draftId } = await page.evaluate(() => {
      const el = document.querySelector('#wz-root');
      return {
        draftId: el ? el.getAttribute('data-draft-id') : null
      };
    });
    createdDraftId = draftId;

    // Open Publish Confirmation Dialog
    await page.getByRole('button', { name: /Publish Event/i }).click();

    const dialog = page.locator('[data-publish-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /Publish event/i })).toBeVisible();
    await expect(dialog).toContainText('host@okhdfcbank');
    await expect(dialog).toContainText('Nightlife Host');

    // Capture Dialog Screenshot
    await page.screenshot({ path: 'test-results/acceptance/publish-dialog-desktop.png' });

    // Confirm Publish
    const confirmBtn = dialog.locator('[data-act="publish-confirm"]');
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Verify Success State
    await expect(page.locator('.wz-done')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.wz-done h1')).toContainText('Your event is live');
    await expect(page.locator('.wz-done')).not.toContainText('Something went wrong');

    // Capture Published Screenshot
    await page.screenshot({ path: 'test-results/acceptance/published-state-desktop.png' });

    // Extract Event Slug & ID from live links
    const eventLink = page.locator('.wz-done a[href*="/events/"]').first();
    await expect(eventLink).toBeVisible();
    const href = await eventLink.getAttribute('href');
    createdEventSlug = href.split('/events/')[1].split('?')[0];

    // ==========================================
    // DATABASE VERIFICATION
    // ==========================================
    const evRow = (await pool.query('SELECT * FROM events WHERE slug = $1', [createdEventSlug])).rows[0];
    expect(evRow, 'Event must exist in database').toBeDefined();
    expect(evRow.status, 'Event status must be published').toBe('published');
    expect(evRow.payment_method, 'Payment method must be direct_upi').toBe('direct_upi');
    expect(evRow.organiser_upi_id).toBe('host@okhdfcbank');
    expect(evRow.organiser_payee_name).toBe('Nightlife Host');
    createdEventId = evRow.id;

    // Verify Ticket Types
    const tickets = (await pool.query('SELECT * FROM ticket_types WHERE event_id = $1', [createdEventId])).rows;
    expect(tickets.length, 'At least 1 ticket tier must exist').toBeGreaterThanOrEqual(1);
    const paidTicket = tickets.find((t) => t.kind === 'paid');
    expect(paidTicket, 'Paid ticket tier must exist').toBeDefined();
    expect(paidTicket.price_paise).toBe(49900);

    // Verify Facilities
    const facilities = (await pool.query('SELECT * FROM event_facilities WHERE event_id = $1', [createdEventId])).rows;
    expect(facilities.length, 'Facilities must persist in database').toBeGreaterThanOrEqual(6);
    const customFac = facilities.find((f) => f.name === 'Rooftop Poolside Cabana');
    expect(customFac, 'Custom facility must persist').toBeDefined();
    expect(customFac.is_custom).toBe(true);

    // Verify Offers
    const offers = (await pool.query('SELECT * FROM event_offers WHERE event_id = $1', [createdEventId])).rows;
    expect(offers.length, 'Offers must persist in database').toBeGreaterThanOrEqual(1);
    if (offers[0].applicable_tier_ids && offers[0].applicable_tier_ids.length > 0) {
      expect(offers[0].applicable_tier_ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }

    // Verify Sales Phases
    const phases = (await pool.query('SELECT * FROM event_sales_phases WHERE event_id = $1', [createdEventId])).rows;
    expect(phases.length, 'Sales phases must persist in database').toBeGreaterThanOrEqual(1);

    // Verify Venue Sections
    const sections = (await pool.query('SELECT * FROM event_venue_sections WHERE event_id = $1', [createdEventId])).rows;
    expect(sections.length, 'Venue sections must persist in database').toBeGreaterThanOrEqual(1);

    // ==========================================
    // REPEATED PUBLISH REQUEST IDEMPOTENCY
    // ==========================================
    if (createdDraftId) {
      await page.evaluate(async (dId) => {
        const csrf = document.querySelector('.org')?.getAttribute('data-csrf') || '';
        await fetch(`/api/organiser/drafts/${encodeURIComponent(dId)}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ version: 1, confirm: true })
        });
      }, createdDraftId);

      const eventsWithSlug = (await pool.query('SELECT count(*)::int as count FROM events WHERE slug = $1', [createdEventSlug])).rows[0].count;
      expect(eventsWithSlug, 'Event slug must not be duplicated in events table').toBe(1);
    }

    // ==========================================
    // PUBLIC EVENT PAGE VERIFICATION
    // ==========================================
    await page.goto(`/events/${createdEventSlug}`);
    await expect(page.locator('h1')).toContainText('The Penthouse Rooftop Social');
    await expect(page.locator('body')).toContainText('VIP Access Pass');
    await expect(page.locator('body')).toContainText('Valet parking');
    await expect(page.locator('body')).toContainText('Rooftop Poolside Cabana');
  });

  test('2. Actionable validation error handling on invalid draft publish', async ({ page }) => {
    await signInAs(page, 'organiser');
    await page.goto('/organiser/new?fresh=1');

    // Create fresh draft via evaluate to inherit exact session cookies and CSRF
    const { ok, draft } = await page.evaluate(async () => {
      const csrf = document.querySelector('.org')?.getAttribute('data-csrf') || '';
      const r = await fetch('/api/organiser/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ template: 'party' })
      });
      const data = await r.json();
      return { ok: data.ok, draft: data.draft };
    });
    expect(ok).toBe(true);

    // Intentionally publish invalid draft (missing title, venue, dates)
    const pubResult = await page.evaluate(async (dId) => {
      const csrf = document.querySelector('.org')?.getAttribute('data-csrf') || '';
      const r = await fetch(`/api/organiser/drafts/${encodeURIComponent(dId)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ version: 1, confirm: true })
      });
      return { status: r.status, data: await r.json() };
    }, draft.id);

    expect(pubResult.status).toBe(422);
    expect(pubResult.data.error).toBe('not_ready');
    expect(Array.isArray(pubResult.data.issues)).toBe(true);
    expect(pubResult.data.issues.length).toBeGreaterThan(0);
    const messages = pubResult.data.issues.map((i) => i.message);
    expect(messages.some((m) => /title|name/i.test(m))).toBe(true);
  });

  test('3. Direct UPI checkout flow and organiser verification lifecycle', async ({ page }) => {
    const ev = (await pool.query(
      `SELECT id, slug, organiser_upi_id, organiser_payee_name
         FROM events
        WHERE payment_method = 'direct_upi' AND status = 'published'
        ORDER BY created_at DESC LIMIT 1`
    )).rows[0];
    expect(ev, 'A published direct UPI event must exist in database').toBeDefined();
    const eventSlug = ev.slug;
    const eventId = ev.id;

    // Attendee signs in as guest persona
    await signInAs(page, 'guest');

    // Go to Direct UPI checkout
    await page.goto(`/checkout/${eventSlug}/upi`);
    await expect(page.locator('body')).toContainText(ev.organiser_payee_name);
    await expect(page.locator('body')).toContainText(ev.organiser_upi_id);

    // Verify dynamic QR or payment container
    await expect(page.locator('#qr-box')).toBeVisible();

    // Submit UTR
    const utrInput = page.locator('#utr-input');
    await expect(utrInput).toBeVisible();
    await utrInput.fill('123456789012');

    const submitBtn = page.locator('#utr-btn');
    await submitBtn.click();
    await expect(page.locator('#utr-msg')).toContainText(/Payment reported|notified/i);

    // Verify tickets are NOT issued yet in database
    const bookingRow = (await pool.query(
      `SELECT b.id, b.status, b.direct_upi_status, b.event_id, count(t.id)::int as ticket_count
         FROM bookings b
         LEFT JOIN tickets t ON t.booking_id = b.id
        WHERE b.event_id = $1
        GROUP BY b.id, b.status, b.direct_upi_status
        ORDER BY b.created_at DESC LIMIT 1`,
      [eventId]
    )).rows[0];

    expect(bookingRow, 'Booking must exist').toBeDefined();
    expect(bookingRow.status).toBe('pending_payment');
    expect(bookingRow.direct_upi_status).toBe('payment_reported');
    expect(bookingRow.ticket_count, 'Ticket must NOT be issued on UTR submission alone').toBe(0);

    // Organiser signs in to confirm payment
    await signInAs(page, 'organiser');
    await page.goto('/organiser');

    const confirmResult = await page.evaluate(async ({ evId, bId }) => {
      const csrf = document.querySelector('.org')?.getAttribute('data-csrf') || '';
      const r = await fetch(`/api/organiser/events/${evId}/payments/${bId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ warningConfirmed: true })
      });
      return { status: r.status, data: await r.json() };
    }, { evId: eventId, bId: bookingRow.id });

    expect(confirmResult.status).toBe(200);
    expect(confirmResult.data.ok).toBe(true);

    // Verify database: status is confirmed, ticket issued exactly once
    const updatedBooking = (await pool.query(
      `SELECT b.id, b.status, b.direct_upi_status, count(t.id)::int as ticket_count
         FROM bookings b
         LEFT JOIN tickets t ON t.booking_id = b.id
        WHERE b.id = $1
        GROUP BY b.id, b.status, b.direct_upi_status`,
      [bookingRow.id]
    )).rows[0];

    expect(updatedBooking.status).toBe('confirmed');
    expect(updatedBooking.direct_upi_status).toBe('payment_confirmed');
    expect(updatedBooking.ticket_count, 'Ticket must be issued exactly once upon organiser confirmation').toBe(1);

    // Repeated confirmation attempt must be idempotent
    await page.evaluate(async ({ evId, bId }) => {
      const csrf = document.querySelector('.org')?.getAttribute('data-csrf') || '';
      await fetch(`/api/organiser/events/${evId}/payments/${bId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ warningConfirmed: true })
      });
    }, { evId: eventId, bId: bookingRow.id });

    const finalTicketCount = (await pool.query(
      'SELECT count(*)::int as count FROM tickets WHERE booking_id = $1',
      [bookingRow.id]
    )).rows[0].count;
    expect(finalTicketCount, 'Ticket count must remain exactly 1 after repeated confirmation').toBe(1);
  });

  // ==========================================
  // VIEWPORT MATRIX & SCREENSHOT INSPECTION
  // ==========================================
  for (const vp of VIEWPORTS) {
    test(`4. Viewport ${vp.width}px (${vp.name}) — UX, layout, navigation & footer audit`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signInAs(page, 'organiser');

      // 1. Organiser Dashboard Shell
      await page.goto('/organiser');
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalOverflow(page);

      // Check footer visibility: Must be hidden on mobile (<= 768px), visible on desktop (1280px)
      const footerDisplay = await page.evaluate(() => {
        const f = document.querySelector('.site-footer');
        return f ? window.getComputedStyle(f).display : 'none';
      });

      if (vp.width <= 768) {
        expect(footerDisplay, `Footer must be hidden on viewport ${vp.width}px`).toBe('none');
        // Mobile bottom navigation check
        const mobileNav = page.locator('.mobile-bottom-nav');
        if (await mobileNav.count() > 0) {
          const navDisplay = await mobileNav.evaluate((el) => window.getComputedStyle(el).display);
          expect(navDisplay, 'Mobile bottom nav must be visible on mobile screens').not.toBe('none');
        }
      } else {
        expect(footerDisplay, `Footer must be displayed on desktop ${vp.width}px`).not.toBe('none');
      }

      await page.screenshot({
        path: `test-results/acceptance/vp-${vp.width}-dashboard.png`,
        fullPage: false
      });

      // 2. Wizard & Facilities Section
      await page.goto('/organiser/new?fresh=1');
      await page.getByRole('button', { name: /Party or nightlife/ }).click();
      await expect(page.locator('#f-title')).toBeVisible();

      // Quick fill basics
      await page.locator('#f-title').fill(`VP Test ${vp.width}`);
      await page.locator('#f-city').fill('Bengaluru');
      await page.locator('#f-area').fill('Indiranagar');
      await page.locator('#f-venue').fill('Venue VP');
      const tmrw = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
      await page.locator('#f-startLocal').fill(`${tmrw}T20:00`);
      await page.locator('#f-endLocal').fill(`${tmrw}T23:00`);
      await page.locator('#f-description').fill('Testing responsive facilities layout across all mobile and desktop devices.');

      // Advance to Tickets step
      await page.getByRole('button', { name: /Next: Tickets/ }).click();
      await expect(page.getByRole('heading', { name: 'Tickets', level: 2 })).toBeVisible();

      // Advance to Features step
      await page.getByRole('button', { name: /Next: Features/ }).click();
      await expect(page.getByRole('heading', { name: /Facilities & amenities/i })).toBeVisible();

      // Select couple of amenities
      await page.locator('[data-act="toggle-facility"][data-key="valet_parking"]').click();
      await page.locator('[data-act="toggle-facility"][data-key="alcohol_available"]').click();

      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: `test-results/acceptance/vp-${vp.width}-facilities.png`,
        fullPage: false
      });

      // Advance to Preview & open dialog
      await page.getByRole('button', { name: /Next: Preview/ }).click();
      await expect(page.getByRole('button', { name: /Publish/i })).toBeVisible();

      await page.screenshot({
        path: `test-results/acceptance/vp-${vp.width}-preview-card.png`,
        fullPage: false
      });

      // Open Publish Confirmation Dialog
      await page.getByRole('button', { name: /Publish/i }).first().click();
      const dialog = page.locator('[data-publish-dialog]');
      await expect(dialog).toBeVisible();

      await expectNoHorizontalOverflow(page);
      await page.screenshot({
        path: `test-results/acceptance/vp-${vp.width}-publish-dialog.png`,
        fullPage: false
      });
    });
  }
});
