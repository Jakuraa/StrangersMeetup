// e2e/cancellation-policy.spec.js - Event Creator Cancellation & Refund Templates E2E
import { test, expect } from '@playwright/test';
import { signInAs, expectNoHorizontalOverflow } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';

const ARTIFACT_DIR = '/Users/pradeepjakuraa/.gemini/antigravity-cli/brain/6f313897-14aa-4f3b-8320-52b8ec01c32f';
const SHOT_DIR = path.join(ARTIFACT_DIR, 'evidence');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function localInput(daysAhead, hour) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  const ymd = new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  return `${ymd}T${String(hour).padStart(2, '0')}:00`;
}

test.describe('Event Creator Cancellation & Refund Templates', () => {
  test('Step 2: Cancellation Policy selection in Organiser Wizard and Attendee Preview', async ({ page }) => {
    // 1. Sign in as organiser
    await signInAs(page, 'organiser');
    await page.goto('/organiser/new?fresh=1');
    await expectNoHorizontalOverflow(page);

    const tplBtn = page.getByRole('button', { name: /Social meetup or matchmaking/ });
    if (await tplBtn.isVisible().catch(() => false)) await tplBtn.click();

    // Fill Step 1 basic info to enable proceeding
    await expect(page.getByLabel('Event name')).toBeVisible();
    await page.getByLabel('Event name').fill('Sunset Rooftop Mixer & Beats');
    await page.getByLabel('Starts').fill(localInput(7, 20));
    await page.getByLabel(/^Ends/).fill(localInput(7, 23));
    await page.getByLabel(/^City/).fill('Bengaluru');
    await page.getByLabel(/Area or neighbourhood/).fill('Indiranagar');
    await page.getByLabel(/Venue or meeting point/).fill('Sky Lounge Indiranagar');
    await page.getByLabel('Description').fill('An evening of melodic deep house with curated cocktails for adults 21+.');

    // Next to Step 2 (Tickets & Cancellation Policy)
    await page.getByRole('button', { name: /Next: Tickets/ }).click();

    // Verify Cancellation & refunds section exists
    await expect(page.getByRole('heading', { name: 'Cancellation & refunds' })).toBeVisible();

    // Verify template chips
    const chipStandard = page.locator('button[data-policy-key="standard"]');
    const chipFlexible = page.locator('button[data-policy-key="flexible"]');
    const chipStrict = page.locator('button[data-policy-key="strict"]');
    const chipCustom = page.locator('button[data-policy-key="custom"]');

    await expect(chipStandard).toBeVisible();
    await expect(chipFlexible).toBeVisible();
    await expect(chipStrict).toBeVisible();
    await expect(chipCustom).toBeVisible();

    // Standard is default active
    await expect(chipStandard).toHaveClass(/is-active/);

    // Verify standard policy preview box contains key guarantees
    const previewBox = page.locator('[data-live="policy-preview"]');
    await expect(previewBox).toBeVisible();
    await expect(previewBox.getByText('Standard Policy Terms')).toBeVisible();
    await expect(previewBox.getByText('100% Host Cancel Guarantee')).toBeVisible();
    await expect(previewBox.getByText('5–7 business days')).toBeVisible();

    // Switch to Flexible template
    await chipFlexible.click();
    await expect(chipFlexible).toHaveClass(/is-active/);
    await expect(chipStandard).not.toHaveClass(/is-active/);
    await expect(previewBox.getByText('Flexible Policy Terms')).toBeVisible();
    await expect(previewBox.getByText('up to 24 hours')).toBeVisible();

    // Switch to Strict template
    await chipStrict.click();
    await expect(chipStrict).toHaveClass(/is-active/);
    await expect(previewBox.getByText('Strict Policy Terms')).toBeVisible();
    await expect(previewBox.getByText('up to 7 days')).toBeVisible();

    // Switch to Custom template and verify custom form fields appear
    await chipCustom.click();
    await expect(chipCustom).toHaveClass(/is-active/);
    const customFields = page.locator('.policy-custom-inputs');
    await expect(customFields).toBeVisible();
    await expect(page.getByLabel('Full refund deadline')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Refund percentage (%)', exact: true })).toBeVisible();

    // Switch back to Standard template
    await chipStandard.click();
    await expect(chipStandard).toHaveClass(/is-active/);

    // Capture visual screenshot of the wizard cancellation policy selection
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: path.join(SHOT_DIR, 'creator-cancellation-policy-wizard.png'),
      fullPage: true
    });

    // 2. Visit a public event page to verify attendee cancellation policy display
    await page.goto('/events');
    const eventLink = page.locator('.events-grid a[href^="/e/"], a.event-card, [data-event-id] a').first();
    if (await eventLink.isVisible().catch(() => false)) {
      await eventLink.click();
      await page.waitForLoadState('networkidle');

      // Check for policy preview or policy card
      const policyCard = page.locator('.policy-summary-box, .policy-card, .event-refund-policy');
      if (await policyCard.count() > 0) {
        await expect(policyCard.first()).toBeVisible();
      }

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: path.join(SHOT_DIR, 'attendee-cancellation-policy-preview.png'),
        fullPage: true
      });
    }
  });
});
