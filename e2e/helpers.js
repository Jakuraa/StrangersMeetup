// e2e/helpers.js - Persona sign-in through the real /signin picker, axe checks, layout checks and
// screenshots (written to test-results/screenshots/ for review).
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PERSONAS } from '../lib/dev-personas.js';

export { PERSONAS };

/** Sign in by clicking the persona on /signin; resolves once the persona's landing page loads. */
export async function signInAs(page, persona) {
  await page.goto('/signin');
  await page.getByRole('button', { name: new RegExp(PERSONAS[persona].alias) }).click();
  await page.waitForURL((u) => u.pathname === PERSONAS[persona].landing);
}

/** No serious or critical WCAG 2 A/AA violations. */
export async function expectAccessible(page, { exclude = [] } = {}) {
  let axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const sel of exclude) axe = axe.exclude(sel);
  const { violations } = await axe.analyze();
  const bad = violations.filter((v) => ['serious', 'critical'].includes(v.impact))
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad, 'axe serious/critical violations').toEqual([]);
}

export async function expectNoHorizontalOverflow(page) {
  const { overflow, culprits } = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const culprits = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > w + 1)
      .slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
    return { overflow: document.documentElement.scrollWidth - w, culprits };
  });
  expect(overflow, `${page.url()} scrolls sideways: ${culprits.join(', ')}`).toBeLessThanOrEqual(0);
}

export async function screenshot(page, testInfo, name) {
  await page.screenshot({ path: `test-results/screenshots/${testInfo.project.name}-${name}.png`, fullPage: true });
}
