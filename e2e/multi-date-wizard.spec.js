// e2e/multi-date-wizard.spec.js - Custom Multi-Date Scheduling & Ticket Contradiction E2E
import { test, expect } from '@playwright/test';
import { signInAs, expectNoHorizontalOverflow } from './helpers.js';
import path from 'node:path';
import fs from 'node:fs';

const ARTIFACT_DIR = '/Users/pradeepjakuraa/.gemini/antigravity-cli/brain/6f313897-14aa-4f3b-8320-52b8ec01c32f';
const SHOT_DIR = path.join(ARTIFACT_DIR, 'evidence');
fs.mkdirSync(SHOT_DIR, { recursive: true });

function formatLocalYMD(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

test.describe('Event Creation UX - Multi-Date Scheduling & Accessibility', () => {
  test('Creator configures custom multi-date sessions, resolves payment contradiction, and previews schedule', async ({ page }) => {
    // 1. Sign in as organiser
    await signInAs(page, 'organiser');
    await page.goto('/organiser/new?fresh=1');
    await expectNoHorizontalOverflow(page);

    const tplBtn = page.getByRole('button', { name: /Social meetup or matchmaking/ });
    if (await tplBtn.isVisible().catch(() => false)) await tplBtn.click();

    // Verify Schedule type selector chips
    await expect(page.getByRole('heading', { name: 'Date & time' })).toBeVisible();
    const customDatesChip = page.locator('button[data-act="select-schedule-type"][data-schedule-type="custom_dates"]');
    await expect(customDatesChip).toBeVisible();
    await customDatesChip.click();

    // Fill Basic Details
    await page.getByLabel('Event name').fill('South India Comedy & Music Tour');
    await page.getByLabel(/^City/).fill('Bengaluru');
    await page.getByLabel(/Area or neighbourhood/).fill('Indiranagar');
    await page.getByLabel(/Venue or meeting point/).fill('The Comedy Theatre & Lounge');
    await page.getByLabel('Description').fill('A multi-city four-date comedy and live indie music tour for adults 21+ across South India.');

    // Configure 4 custom sessions
    const d1 = formatLocalYMD(10);
    const d2 = formatLocalYMD(12);
    const d3 = formatLocalYMD(15);
    const d4 = formatLocalYMD(17);

    // Initial session 1 & 2 are created on switching to custom_dates
    const dateInput1 = page.locator('input[data-path="schedule.dates.0.date"]');
    const startInput1 = page.locator('input[data-path="schedule.dates.0.startLocal"]');
    const endInput1 = page.locator('input[data-path="schedule.dates.0.endLocal"]');
    const labelInput1 = page.locator('input[data-path="schedule.dates.0.label"]');

    await dateInput1.fill(d1);
    await startInput1.fill(`${d1}T19:00`);
    await endInput1.fill(`${d1}T22:00`);
    await labelInput1.fill('Opening Night');

    const dateInput2 = page.locator('input[data-path="schedule.dates.1.date"]');
    const startInput2 = page.locator('input[data-path="schedule.dates.1.startLocal"]');
    const endInput2 = page.locator('input[data-path="schedule.dates.1.endLocal"]');
    const labelInput2 = page.locator('input[data-path="schedule.dates.1.label"]');

    await dateInput2.fill(d2);
    await startInput2.fill(`${d2}T19:00`);
    await endInput2.fill(`${d2}T22:00`);
    await labelInput2.fill('Mid-Week Showcase');

    // Add session 3
    await page.getByRole('button', { name: '+ Add another date / session' }).click();
    await page.locator('input[data-path="schedule.dates.2.date"]').fill(d3);
    await page.locator('input[data-path="schedule.dates.2.startLocal"]').fill(`${d3}T19:00`);
    await page.locator('input[data-path="schedule.dates.2.endLocal"]').fill(`${d3}T22:00`);
    await page.locator('input[data-path="schedule.dates.2.label"]').fill('Semi-Final');

    // Add session 4
    await page.getByRole('button', { name: '+ Add another date / session' }).click();
    await page.locator('input[data-path="schedule.dates.3.date"]').fill(d4);
    await page.locator('input[data-path="schedule.dates.3.startLocal"]').fill(`${d4}T19:00`);
    await page.locator('input[data-path="schedule.dates.3.endLocal"]').fill(`${d4}T22:30`);
    await page.locator('input[data-path="schedule.dates.3.label"]').fill('Grand Finale');

    // Capture Step 1 evidence
    await page.screenshot({ path: path.join(SHOT_DIR, 'multi-date-wizard-creator.png'), fullPage: true });

    // Proceed to Step 2: Tickets
    await page.getByRole('button', { name: /Next: Tickets/ }).click();
    await expect(page.getByRole('heading', { name: 'Ticket types' })).toBeVisible();

    // Verify Payment contradiction notice
    const payNotice = page.locator('.notice-warn');
    await expect(payNotice).toBeVisible();
    await expect(payNotice).toContainText('Online payment is not configured yet');

    // Verify quick-add chips exist and are accessible
    const quickAddGeneral = page.locator('button.chip[data-act="add-tier"][data-preset="general"]');
    const quickAddFree = page.locator('button.chip[data-act="add-tier"][data-preset="free"]');
    await expect(quickAddGeneral).toBeVisible();
    await expect(quickAddFree).toBeVisible();

    // Add a paid tier and a free tier
    await quickAddGeneral.click();
    await quickAddFree.click();

    // Check that paid tier displays draft indicator and warning
    const draftPill = page.locator('.pill-draft').first();
    await expect(draftPill).toBeVisible();
    await expect(draftPill).toContainText('Draft — External Checkout Pending');

    // Capture Step 2 evidence
    await page.screenshot({ path: path.join(SHOT_DIR, 'multi-date-tickets-draft-state.png'), fullPage: true });

    // Proceed to Step 3: Features then Step 4: Preview
    await page.getByRole('button', { name: /Next: Features/ }).click();
    await expect(page.getByRole('heading', { name: 'Ask guests questions' })).toBeVisible();

    await page.getByRole('button', { name: /Next: Preview/ }).click();
    await expect(page.getByRole('heading', { name: 'What guests will see' })).toBeVisible();

    // Verify Attendee Preview displays full multi-date schedule
    const attPrev = page.locator('.att-prev');
    await expect(attPrev).toBeVisible();
    await expect(attPrev).toContainText('Schedule & sessions');
    await expect(attPrev).toContainText('Opening Night');
    await expect(attPrev).toContainText('Grand Finale');

    // Verify ticket states in attendee preview
    await expect(attPrev).toContainText('Paid ticket — external checkout not configured');

    // Capture Step 4 evidence
    await page.screenshot({ path: path.join(SHOT_DIR, 'multi-date-attendee-preview.png'), fullPage: true });
  });

  test('Responsive viewports audit: 375px mobile and 768px tablet', async ({ page }) => {
    await signInAs(page, 'organiser');

    // Mobile Viewport (375px)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/organiser/new');
    await expectNoHorizontalOverflow(page);

    // Tablet Viewport (768px)
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/organiser/new');
    await expectNoHorizontalOverflow(page);
  });
});
