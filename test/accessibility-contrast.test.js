import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Computes relative luminance of an sRGB hex color as defined in WCAG 2.2:
 * https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
 */
function relativeLuminance(hex) {
  const cleanHex = hex.replace('#', '').trim();
  const r8 = parseInt(cleanHex.slice(0, 2), 16) / 255;
  const g8 = parseInt(cleanHex.slice(2, 4), 16) / 255;
  const b8 = parseInt(cleanHex.slice(4, 6), 16) / 255;

  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const r = toLinear(r8);
  const g = toLinear(g8);
  const b = toLinear(b8);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Computes contrast ratio between two hex colors:
 * (L1 + 0.05) / (L2 + 0.05) where L1 is the lighter color.
 */
function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test('WCAG 2.2 AA - Text contrast on dark backgrounds meets 4.5:1 ratio', () => {
  const bg = '#090B16';
  const surface = '#121424';
  const ink = '#FFFFFF';
  const ink2 = '#E2E4F0';
  const cyan = '#00D9FF';

  // Primary text on background and surface
  const ratioInkBg = contrastRatio(ink, bg);
  const ratioInkSurface = contrastRatio(ink, surface);
  assert.ok(ratioInkBg >= 15, `White on dark bg should exceed 15:1 (got ${ratioInkBg.toFixed(2)})`);
  assert.ok(ratioInkSurface >= 15, `White on surface should exceed 15:1 (got ${ratioInkSurface.toFixed(2)})`);

  // Secondary text ink-2
  const ratioInk2Bg = contrastRatio(ink2, bg);
  assert.ok(ratioInk2Bg >= 10, `Ink-2 on dark bg should exceed 10:1 (got ${ratioInk2Bg.toFixed(2)})`);

  // Neon Cyan accent text on dark background
  const ratioCyanBg = contrastRatio(cyan, bg);
  assert.ok(ratioCyanBg >= 4.5, `Neon cyan text on dark bg must meet WCAG AA 4.5:1 (got ${ratioCyanBg.toFixed(2)})`);
});

test('WCAG 2.2 AA - Non-text UI boundaries and focus rings meet 3:1 ratio', () => {
  const bg = '#090B16';
  const surface = '#121424';
  const focusRing = '#00D9FF'; // Neon cyan focus ring
  const lineStrong = '#6169A3'; // Accessible component border

  // Focus ring against dark background and surfaces
  const ratioFocusBg = contrastRatio(focusRing, bg);
  const ratioFocusSurface = contrastRatio(focusRing, surface);
  assert.ok(ratioFocusBg >= 3.0, `Focus ring on bg must meet 3:1 (got ${ratioFocusBg.toFixed(2)})`);
  assert.ok(ratioFocusSurface >= 3.0, `Focus ring on surface must meet 3:1 (got ${ratioFocusSurface.toFixed(2)})`);

  // Strong boundary border against dark surface
  const ratioBorder = contrastRatio(lineStrong, surface);
  assert.ok(ratioBorder >= 3.0, `UI boundary line on surface must meet 3:1 (got ${ratioBorder.toFixed(2)})`);
});
