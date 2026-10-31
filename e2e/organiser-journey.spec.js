// e2e/organiser-journey.spec.js - Phase 3H Organiser Onboarding, Wizard & Dashboard E2E
import { test, expect } from '@playwright/test';
import { signInAs, expectAccessible, expectNoHorizontalOverflow } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';

const SHOT_DIR = process.env.ARTIFACT_IMG_DIR || path.resolve('test-results/screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function localInput(daysAhead, hour) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  const ymd = new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return `${ymd}T${String(hour).padStart(2, '0')}:00`;
}

test.describe('Phase 3H Organiser Onboarding, Wizard & Dashboard Journey', () => {
  test('Part 2: Host Onboarding Page and Application Submission', async ({ page }) => {
    // 1. Visit /become-a-host as public visitor
    await page.goto('/become-a-host');
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

    // Verify key sections
    await expect(page.getByRole('heading', { name: /Become an Organiser & Host/i })).toBeVisible();
    await expect(page.getByText('Curated 21+ Community')).toBeVisible();
    await expect(page.getByText('Secret Venue Privacy')).toBeVisible();
    await expect(page.getByText('Full Event Control')).toBeVisible();
    await expect(page.getByText('Platform Safety & Quality Standards')).toBeVisible();

    // Responsive screenshots across mobile and desktop
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-host-onboarding-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 430, height: 900 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-host-onboarding-430px.png'), fullPage: true });

    await page.setViewportSize({ width: 375, height: 800 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-host-onboarding-375px.png'), fullPage: true });

    await page.setViewportSize({ width: 320, height: 700 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-host-onboarding-320px.png'), fullPage: true });

    // 2. Visit Thank You / Confirmation Screen
    await page.goto('/become-a-host?sent=1');
    await expectNoHorizontalOverflow(page);
    await expect(page.getByRole('heading', { name: /Application Received!/i })).toBeVisible();
    await expect(page.getByText('Curation & Safety Review')).toBeVisible();
    await expect(page.getByText('Host Privilege Activation')).toBeVisible();
    await expect(page.getByText('Draft & Publish Your Event')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-host-thanks-desktop.png'), fullPage: true });
  });

  test('Part 3 & 4: Organiser Dashboard, Wizard Polish & Mystery Venue Teaser', async ({ page, browser }) => {
    page.on('dialog', (d) => d.accept());

    // Sign in as approved organiser
    await signInAs(page, 'organiser');
    await page.goto('/organiser');
    await expectNoHorizontalOverflow(page);

    // Verify Dashboard KPIs and sections
    await expect(page.getByRole('heading', { name: 'Your events' })).toBeVisible();
    await expect(page.locator('.org-kpis')).toBeVisible();
    await expect(page.locator('.org-kpis').getByText('Published Events')).toBeVisible();
    await expect(page.locator('.org-kpis').getByText('Confirmed Guests')).toBeVisible();
    await expect(page.locator('.org-kpis').getByText('Active Drafts')).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-organiser-dash-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 375, height: 800 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-organiser-dash-375px.png'), fullPage: true });

    // Open Wizard with fresh draft
    await page.goto('/organiser/new?fresh=1');
    const tplBtn = page.getByRole('button', { name: /Social meetup or matchmaking/ });
    if (await tplBtn.isVisible().catch(() => false)) await tplBtn.click();

    // Step 1: Basics, Date & Schedule, Location & Mystery Venue
    const title = `Phase 3H Supper Mixer ${Date.now().toString(36)}`;
    await expect(page.getByLabel('Event name')).toBeVisible();
    await page.getByLabel('Event name').fill(title);
    await page.getByLabel('Starts').fill(localInput(10, 19));
    await page.getByLabel(/^Ends/).fill(localInput(10, 22));

    // Verify live duration in when summary
    const whenLive = page.locator('[data-live="when"]');
    await expect(whenLive).toContainText('IST');
    await expect(whenLive).toContainText('3 hr');

    // Location & Mystery Venue switch
    await page.getByLabel(/^City/).fill('Bengaluru');
    await page.getByLabel(/Area or neighbourhood/).fill('Indiranagar');
    await page.getByLabel(/Venue or meeting point/).fill('Secret Penthouse, 100ft Road');

    const privSwitch = page.getByRole('switch', { name: /Keep the address private/ }).or(page.getByLabel(/Keep the address private/));
    if ((await privSwitch.getAttribute('aria-checked')) !== 'true' && !(await privSwitch.isChecked().catch(() => false))) {
      await privSwitch.click();
    }

    // Verify live mystery venue preview teaser box
    const venueTeaser = page.locator('[data-live="venue-preview"] .venue-preview-box.mystery');
    await expect(venueTeaser).toBeVisible();
    await expect(venueTeaser).toContainText('Mystery Venue Active');
    await expect(venueTeaser).toContainText('Indiranagar, Bengaluru');
    await expect(venueTeaser).toContainText('Secret Penthouse, 100ft Road');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-wizard-mystery-venue-preview.png') });

    await page.getByLabel('Description').fill('A secret rooftop dining gathering for creatives and tech leaders. Adults 21+ only with valid government ID.');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-wizard-basics-desktop.png'), fullPage: true });

    // Step 2: Tickets & Capacity
    await page.getByRole('button', { name: /Next: Tickets/ }).click();
    const tiers = page.locator('.tier-card');
    for (let n = await tiers.count(); n > 0; n--) {
      await tiers.first().getByRole('button', { name: 'Delete' }).click();
      await expect(tiers).toHaveCount(n - 1);
    }
    await page.getByRole('button', { name: '+ Free entry' }).click();
    await expect(tiers).toHaveCount(1);
    await tiers.first().getByLabel('Quantity available').fill('25');

    // Verify capacity banner
    const capBanner = page.locator('.capacity-banner');
    await expect(capBanner).toBeVisible();
    await expect(capBanner).toContainText('25 spots');

    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-wizard-tickets-capacity.png'), fullPage: true });

    // Step 3: Features
    await page.getByRole('button', { name: /Next: Features/ }).click();
    await expect(page.getByRole('button', { name: /^Next/ })).toBeVisible();

    // Step 4: Preview & Preflight Review
    await page.getByRole('button', { name: /^Next/ }).click();
    await expect(page.getByText('Everything needed is in place.')).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase3h-wizard-preflight-review.png'), fullPage: true });

    // Publish event
    await page.getByRole('button', { name: 'Publish event' }).click();
    await page.getByRole('button', { name: 'Publish now' }).click();
    await expect(page.getByRole('heading', { name: 'Your event is live' })).toBeVisible();

    const publicUrl = await page.locator('.share-url').inputValue();
    const visitor = await browser.newPage();
    await visitor.goto(new URL(publicUrl).pathname);

    // Verify public view: Mystery venue active, address not leaked
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(visitor.locator('body')).toContainText('Indiranagar');
    await expect(visitor.locator('body')).not.toContainText('Secret Penthouse');
    await expect(visitor.locator('.badge-mystery')).toBeVisible();
    await visitor.close();
  });
});
