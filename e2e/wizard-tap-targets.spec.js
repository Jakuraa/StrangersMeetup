// e2e/wizard-tap-targets.spec.js - Organiser wizard controls have 44px hit areas on phones
// (feature switches, the "Fix" link, "+ ticket" buttons) and keep their desktop size elsewhere.
import { test, expect } from '@playwright/test';
import { signInAs, screenshot } from './helpers.js';

async function openWizard(page) {
  page.on('dialog', (d) => d.accept());
  await signInAs(page, 'organiser');
  await page.goto('/organiser/new');
  const fresh = page.getByRole('button', { name: 'Start fresh' });
  if (await fresh.isVisible().catch(() => false)) await fresh.click();
  await page.getByRole('button', { name: /Social meetup or matchmaking/ }).click();
  await expect(page.getByLabel('Event name')).toBeVisible();
}

for (const width of [320, 375]) {
  test(`wizard switches, Fix link and + ticket buttons are 44px @ ${width}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'phone widths only');
    await page.setViewportSize({ width, height: 700 });
    await openWizard(page);

    // Tickets step: every "+ ticket" button (presets and "+ Add another ticket type").
    await page.getByRole('button', { name: /Next: Tickets/ }).click();
    await page.getByRole('button', { name: '+ Free entry' }).click();
    const adders = page.locator('[data-act="add-tier"]');
    expect(await adders.count()).toBeGreaterThan(1);
    for (const b of await adders.all()) expect((await b.boundingBox()).height, await b.innerText()).toBeGreaterThanOrEqual(44);
    await screenshot(page, testInfo, `wizard-tickets-${width}`);

    // Features step: every switch.
    await page.getByRole('button', { name: /Next: Features/ }).click();
    const switches = page.getByRole('switch');
    expect(await switches.count()).toBeGreaterThanOrEqual(4);
    for (const s of await switches.all()) {
      const b = await s.boundingBox();
      expect(b.height).toBeGreaterThanOrEqual(44);
      expect(b.width).toBeGreaterThanOrEqual(44);
    }
    // Tapping the padding above the visible track still toggles it.
    const sw = switches.first();
    const b = await sw.boundingBox();
    const before = await sw.getAttribute('aria-checked');
    await page.mouse.click(b.x + b.width / 2, b.y + 2);
    await expect(sw).not.toHaveAttribute('aria-checked', before);
    await screenshot(page, testInfo, `wizard-features-${width}`);

    // Preview step: Fix links (an unfinished draft lists issues).
    await page.getByRole('button', { name: /^Next/ }).click();
    const fixes = page.getByRole('button', { name: 'Fix', exact: true });
    await expect(fixes.first()).toBeVisible();
    for (const f of await fixes.all()) {
      const fb = await f.boundingBox();
      expect(fb.width).toBeGreaterThanOrEqual(44);
      expect(fb.height).toBeGreaterThanOrEqual(44);
    }
    const sizes = await fixes.first().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el.parentElement).fontSize]);
    expect(sizes[0]).toBe(sizes[1]);
    await screenshot(page, testInfo, `wizard-preview-${width}`);
  });
}

test('wizard controls keep their desktop size', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop only');
  await openWizard(page);
  await page.getByRole('button', { name: /Next: Tickets/ }).click();
  expect((await page.locator('.chip[data-act="add-tier"]').first().boundingBox()).height).toBe(40);
  await page.getByRole('button', { name: /Next: Features/ }).click();
  const b = await page.getByRole('switch').first().boundingBox();
  expect([b.width, b.height]).toEqual([52, 32]);
  await screenshot(page, testInfo, 'wizard-features-desktop');
  await page.getByRole('button', { name: /^Next/ }).click();
  const fb = await page.getByRole('button', { name: 'Fix', exact: true }).first().boundingBox();
  expect(fb.height).toBeLessThan(30);
});
