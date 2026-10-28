// e2e/admin-helpers.js - Helpers for the admin console specs: opening sections on any width,
// inspecting how a table laid itself out, and editing real API responses (long text, errors).
import { expect } from '@playwright/test';

/** Wait until the admin console has finished loading its current section. */
export async function waitAdminReady(page) {
  await expect(page.locator('#admin-main')).not.toHaveAttribute('aria-busy', 'true');
}

/** Open an admin section by its nav label, opening the "Sections" menu first on phone widths. */
export async function openAdminTab(page, label, { wait = true } = {}) {
  const toggle = page.locator('.admin-nav-toggle');
  if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: label, exact: true }).click();
  if (wait) await waitAdminReady(page);
}

/** Press Tab until the focused element matches `selector` (fails if it takes more than `max` presses). */
export async function tabUntil(page, selector, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel) => document.activeElement && document.activeElement.matches(sel), selector)) return i + 1;
  }
  throw new Error(`Tab never reached ${selector} within ${max} presses`);
}

/**
 * Inspect one rendered table: its layout mode ('table' or 'cards'), whether every non-empty cell is visible
 * and inside the viewport, whether each column is still labelled, and the size of its action controls.
 */
export async function inspectTable(table) {
  return table.evaluate((t) => {
    const vw = document.documentElement.clientWidth;
    const visible = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const mode = getComputedStyle(t).display === 'table' ? 'table' : 'cards';
    const heads = [...t.querySelectorAll('thead th')];
    const problems = [];
    for (const tr of t.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        const name = heads[i].textContent.trim();
        if (td.classList.contains('t-none') && mode === 'cards') return;
        if (mode === 'table' && !visible(heads[i])) problems.push(`header "${name}" hidden`);
        if (mode === 'cards' && name !== 'Actions' && !td.classList.contains('t-primary')) {
          const lab = td.querySelector('.t-lab');
          if (!lab || !visible(lab) || lab.textContent.trim() !== name) problems.push(`label "${name}" not visible`);
        }
        const r = td.getBoundingClientRect();
        if (td.children.length && (r.right > vw + 1 || r.left < -1)) problems.push(`cell "${name}" outside viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
      });
    }
    const actions = [...t.querySelectorAll('.t-actions button, .t-actions a.btn, .t-actions select')].map((e) => e.getBoundingClientRect().height);
    const panel = t.closest('.panel');
    return {
      mode, problems, headers: heads.map((h) => h.textContent.trim()),
      panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : 0,
      minActionHeight: actions.length ? Math.min(...actions) : null,
      rows: t.querySelectorAll('tbody tr').length
    };
  });
}

/** Fetch the real API response, let `edit(json)` change it, and serve the result (auth still goes to the server). */
export async function mutateApi(page, glob, edit) {
  await page.route(glob, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    edit(json);
    await route.fulfill({ response: res, json });
  });
}

/** The focused element's computed outline, for "focus is visible" checks. */
export async function focusRing(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, cls: el.className, label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
  });
}
