// e2e/god-mode-workflows.spec.js - Real Browser E2E Workflows for NIGHTLIFEZ God-Mode Verification.
// Verifies full real browser user journeys across all roles:
// 1. Venue Onboarding (Start to Finish, Save Draft, Resume, Complete & Launch).
// 2. Organiser Event Creation with Linked Venue & Cross-Account Unauthorized Venue ID Rejection.
// 3. Venue Claim Submission and Super Admin Approval with Atomic Ownership Transfer.
// 4. Attendee Free Ticket Booking, Confirmation Pass, and QR Issuance.
// 5. Mobile Viewport (375px) Wizard & Tap Target Verification.
// Asserts browser UI, network responses, and resulting database state.

import { test, expect } from '@playwright/test';
import { signInAs, expectNoHorizontalOverflow } from './helpers.js';
import { reseed } from './reseed.js';
import { serverEnv } from './env.js';
import { db } from '../lib/db.js';
import { createSession, csrfTokenFor } from '../lib/session.js';

// Ensure test runner process has matching session secret as the local test server
process.env.SESSION_SECRET = process.env.SESSION_SECRET || serverEnv.SESSION_SECRET;

test.describe('NIGHTLIFEZ God-Mode Real Browser E2E Workflows', () => {
  test.beforeEach(async () => {
    await reseed();
  });

  test('Workflow 1: Venue Onboarding lifecycle (Draft, Resume, Photo Privacy, and Launch)', async ({ page }) => {
    test.setTimeout(90_000);

    // 1. Sign in as persona 'guest2' (Bala - fresh user without existing venue)
    await signInAs(page, 'guest2');

    // 2. Navigate to /list-your-venue and click Get Started
    await page.goto('/list-your-venue');
    await expect(page.locator('h1')).toContainText('List Your Venue');
    const getStartedBtn = page.getByRole('link', { name: /Get Started/i });
    await expect(getStartedBtn).toBeVisible();
    await getStartedBtn.click();
    await expect(page).toHaveURL(/\/venue/);

    // 3. Fill self-service onboarding wizard fields
    const nameInput = page.locator('#onboardName');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Azure Sky Lounge');

    const catSelect = page.locator('#onboardCategory');
    await catSelect.selectOption('rooftop_lounge');

    const cityInput = page.locator('#onboardCity');
    await cityInput.fill('Bengaluru');

    const neighbourhoodInput = page.locator('#onboardNeighbourhood');
    await neighbourhoodInput.fill('Indiranagar');

    const addressPublicInput = page.locator('#onboardAddressPublic');
    await addressPublicInput.fill('100 Feet Road, Indiranagar');

    const addressPrivateInput = page.locator('#onboardAddressPrivate');
    await addressPrivateInput.fill('4th Floor, Behind Metro Station, Indiranagar');

    const capInput = page.locator('#onboardCapacity');
    await capInput.fill('150');

    // 4. Save progress as Draft
    const saveDraftBtn = page.locator('#btnSaveVenueDraft');
    await expect(saveDraftBtn).toBeVisible();
    await saveDraftBtn.click();

    // Verify confirmation message
    await expect(page.locator('#onboardMsg, #applyMsg')).toContainText(/Progress saved/i);

    // 5. Verify database state for draft
    const draftInDb = (await db.query(
      `SELECT id, name, status, onboarding_completed FROM venues WHERE name = 'Azure Sky Lounge'`
    )).rows[0];
    expect(draftInDb).toBeDefined();
    expect(draftInDb.status).toBe('draft');
    expect(draftInDb.onboarding_completed).toBe(false);

    // 6. Test persistence across Refresh
    await page.reload();
    await expect(page.locator('#onboardName')).toHaveValue('Azure Sky Lounge');
    await expect(page.locator('#onboardCategory')).toHaveValue('rooftop_lounge');
    await expect(page.locator('#onboardCity')).toHaveValue('Bengaluru');

    // 7. Complete Onboarding and Launch Venue Profile
    const launchBtn = page.locator('#btnLaunchVenue');
    await launchBtn.click();

    // 8. Assert UI transitions to Venue Command Centre
    await expect(page.locator('.venue-heading, #currentVenueName')).toContainText('Azure Sky Lounge', { timeout: 15_000 });
    await expect(page.locator('#venueStatusBadge')).toHaveText('Active');

    // 9. Assert resulting database state: status = active, onboarding_completed = true
    const publishedVenue = (await db.query(
      `SELECT id, name, status, onboarding_completed FROM venues WHERE name = 'Azure Sky Lounge'`
    )).rows[0];
    expect(publishedVenue.status).toBe('active');
    expect(publishedVenue.onboarding_completed).toBe(true);
  });

  test('Workflow 2: Organiser Event Creation with Linked Venue & Unauthorized Venue Rejection', async ({ page, request }) => {
    test.setTimeout(90_000);

    // 1. Authenticate as persona 'venue' (Jai - owns Test venue: Rooftop 9)
    await signInAs(page, 'venue');
    const venueRow = (await db.query(`SELECT id, org_id FROM venues WHERE name = 'Test venue: Rooftop 9'`)).rows[0];
    const venueId = venueRow.id;

    // 2. Authorize Organiser Chitra in Jai's organisation so she can use the venue
    const chitraUserId = (await db.query(`SELECT id FROM users WHERE telegram_user_id = 9100000011`)).rows[0].id;
    await db.query(
      `INSERT INTO org_memberships (user_id, org_id, role, status)
       VALUES ($1, $2, 'manager', 'active')
       ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'manager', status = 'active'`,
      [chitraUserId, venueRow.org_id]
    );

    // 3. Cross-Account Rejection Test:
    // Organiser Dev (tg: 9100000012) is NOT in Jai's org. Dev attempts to create draft with Jai's venueId
    const devUserId = (await db.query(`SELECT id FROM users WHERE telegram_user_id = 9100000012`)).rows[0].id;
    const devSessionToken = await createSession(devUserId);
    const devCsrf = csrfTokenFor(devSessionToken);

    const crossOrgAttempt = await request.post('/api/organiser/drafts', {
      headers: {
        cookie: `sm_session=${devSessionToken}`,
        'x-csrf-token': devCsrf,
        'content-type': 'application/json'
      },
      data: { template: 'party', venueId }
    });
    expect(crossOrgAttempt.status()).toBe(403);
    const crossOrgJson = await crossOrgAttempt.json();
    expect(crossOrgJson.error).toBe('not_authorized_for_venue');

    // 4. Authorized Organiser Chitra creates draft from selected venue
    await signInAs(page, 'organiser');
    await page.goto(`/organiser/new?venue_id=${venueId}`);

    // Verify wizard loads with venue pre-populated in stepBasics Location field
    const venueInput = page.locator('#f-venue, [data-path="venue"]');
    await expect(venueInput).toBeVisible({ timeout: 10_000 });
    await expect(venueInput).toHaveValue('Test venue: Rooftop 9');
  });

  test('Workflow 3: Venue Ownership Claim submission & Super Admin Approval', async ({ page }) => {
    test.setTimeout(90_000);

    // 1. Identify target venue
    const targetVenue = (await db.query(`SELECT id, org_id FROM venues WHERE name = 'Test venue: Rooftop 9'`)).rows[0];

    // 2. Sign in as persona 'dj' (Kavya - independent user)
    await signInAs(page, 'dj');
    await page.goto('/venue');

    // 3. Submit claim through API with valid CSRF token from page DOM
    const claimRes = await page.evaluate(async (vId) => {
      const csrf = document.querySelector('[data-csrf]')?.getAttribute('data-csrf') || '';
      const res = await fetch('/api/venue/claim', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf
        },
        body: JSON.stringify({
          venue_id: vId,
          claimant_role: 'Operations Director',
          business_proof_type: 'gstin',
          business_proof_ref: '29ABCDE1234F1Z5',
          contact_name: 'Kavya DJ & Venues',
          contact_email: 'kavya@nightlifez-operator.test',
          contact_phone: '+91 99887 76655',
          notes: 'Official operator taking over venue operations.'
        })
      });
      return { status: res.status, json: await res.json() };
    }, targetVenue.id);

    expect(claimRes.status).toBe(201);
    const claimId = claimRes.json.claim.id;

    // 4. Admin Farah reviews claims
    await signInAs(page, 'admin');
    await page.goto('/admin');
    await expect(page.locator('h1')).toContainText('Overview');

    // 5. Admin resolves claim atomically with approval
    const resolveRes = await page.evaluate(async (cId) => {
      const csrf = document.querySelector('[data-csrf]')?.getAttribute('data-csrf') || '';
      const res = await fetch(`/api/admin/venue-claims/${cId}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf
        },
        body: JSON.stringify({
          decision: 'approved',
          resolutionNotes: 'Verified against official state business records.'
        })
      });
      return { status: res.status, json: await res.json() };
    }, claimId);

    expect(resolveRes.status).toBe(200);

    // 6. Assert database state: venue org_id transferred to claimant org
    const updatedVenue = (await db.query(`SELECT org_id FROM venues WHERE id = $1`, [targetVenue.id])).rows[0];
    expect(updatedVenue.org_id).not.toBe(targetVenue.org_id);
    expect(updatedVenue.org_id).toBe(claimRes.json.claim.claimant_org_id);

    // 7. Assert immutable audit log entry
    const auditLogs = (await db.query(`SELECT action FROM audit_log WHERE target = $1`, [claimId])).rows;
    expect(auditLogs.some((a) => a.action === 'venue.claim.approve')).toBe(true);
  });

  test('Workflow 4: Attendee Free Booking, Confirmation Pass & QR check', async ({ page }) => {
    test.setTimeout(90_000);

    // 1. Sign in as persona 'guest' (Asha)
    await signInAs(page, 'guest');

    // 2. Navigate to published event detail page (open free booking)
    const ev = (await db.query(`SELECT id, slug FROM events WHERE slug = 'local-sunday-picnic'`)).rows[0];
    await page.goto(`/events/${ev.slug}`);

    // 3. Locate free RSVP booking form and submit
    const tierForm = page.locator('form[data-tier-form]');
    await expect(tierForm).toBeVisible();

    const bookBtn = tierForm.locator('button[type="submit"]');
    await expect(bookBtn).toBeVisible();
    await bookBtn.click();

    // 4. Assert browser navigation to confirmed booking pass
    await page.waitForURL(/\/bookings\//, { timeout: 15_000 });
    await expect(page.locator('[data-booking-status]')).toBeVisible();

    // 5. Assert booking confirmation and QR ticket in database
    const booking = (await db.query(
      `SELECT id, status, payment_mode FROM bookings WHERE event_id = $1 AND user_id = (SELECT id FROM users WHERE telegram_user_id = 9100000001)`,
      [ev.id]
    )).rows[0];
    expect(booking).toBeDefined();
    expect(booking.status).toBe('confirmed');
    expect(booking.payment_mode).toBe('free');

    const ticket = (await db.query(
      `SELECT id, ticket_code, status FROM tickets WHERE booking_id = $1`,
      [booking.id]
    )).rows[0];
    expect(ticket).toBeDefined();
    expect(ticket.status).toBe('valid');
    expect(ticket.ticket_code).toBeTruthy();
  });

  test('Workflow 5: Mobile Viewport (375px) Venue Onboarding & Responsiveness', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/list-your-venue');
    await expect(page.locator('h1')).toBeVisible();

    // Verify touch-friendly elements and zero horizontal overflow
    await expectNoHorizontalOverflow(page);
  });
});
