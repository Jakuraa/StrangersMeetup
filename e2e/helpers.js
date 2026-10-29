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

/**
 * Interactive controls whose touch target is under `min` px in either direction. A radio/checkbox is measured by
 * its label (the label is what a thumb hits); links inside a sentence are exempt (WCAG 2.5.8 inline exception).
 * Hidden/disabled controls are skipped. Run at phone widths.
 */
export async function smallTapTargets(page, min = 44) {
  return page.evaluate((min) => {
    const out = [];
    const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab]';
    for (const el of document.querySelectorAll(sel)) {
      if (el.disabled || el.closest('[hidden], [inert]')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.classList.contains('skip') || el.closest('.sr-only, .hp')) continue;
      if (el.matches('input[type=radio], input[type=checkbox]')) {
        const lb = el.labels?.[0] || el.closest('label');
        if (lb && lb.getBoundingClientRect().height >= min) continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.matches('a') && !el.closest('nav, header, footer, .card, .crumbs, .btn')) {
        const own = [...el.parentElement.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
        if (own.length >= 4) continue; // inline in a sentence
      }
      // Text controls are as wide as their words; icon-only controls must be square-ish 44px.
      const label = (el.getAttribute('aria-label') || el.textContent || el.name || '').trim();
      const textual = el.textContent.trim().length > 0 && !el.matches('input, select, textarea');
      if (r.height < min - 0.5 || (!textual && r.width < min - 0.5)) {
        const name = label.slice(0, 30);
        out.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return [...new Set(out)];
  }, min);
}
