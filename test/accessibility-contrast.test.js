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

test('WCAG 2.2 AA - Centralised tokens meet 4.5:1 text and 3:1 non-text contrast across all surfaces', () => {
  const surfaces = [
    { name: 'surface-base', hex: '#0E1224' },
    { name: 'surface-card', hex: '#171B34' },
    { name: 'surface-elevated', hex: '#222749' },
    { name: 'surface-input', hex: '#0B0E1E' }
  ];

  const primaryInk = '#FFFFFF';
  const secondaryInk = '#F1F3FA';
  const mutedInk = '#A3ABC9';
  const focusRing = '#06D6A0';
  const borderStrong = '#6670B0';
  const errorText = '#FF6B8B';
  const successText = '#06D6A0';
  const warningText = '#FFC033';

  for (const s of surfaces) {
    // Primary text >= 4.5:1 (actually > 12:1)
    const ratioPri = contrastRatio(primaryInk, s.hex);
    assert.ok(ratioPri >= 4.5, `Primary text on ${s.name} must meet 4.5:1 (got ${ratioPri.toFixed(2)})`);

    // Secondary text >= 4.5:1 (actually > 10:1)
    const ratioSec = contrastRatio(secondaryInk, s.hex);
    assert.ok(ratioSec >= 4.5, `Secondary text on ${s.name} must meet 4.5:1 (got ${ratioSec.toFixed(2)})`);

    // Muted secondary text >= 4.5:1
    const ratioMuted = contrastRatio(mutedInk, s.hex);
    assert.ok(ratioMuted >= 4.5, `Muted text on ${s.name} must meet 4.5:1 (got ${ratioMuted.toFixed(2)})`);

    // Focus ring >= 3.0:1
    const ratioFocus = contrastRatio(focusRing, s.hex);
    assert.ok(ratioFocus >= 3.0, `Focus ring on ${s.name} must meet 3:1 (got ${ratioFocus.toFixed(2)})`);

    // Status texts >= 4.5:1
    const ratioErr = contrastRatio(errorText, s.hex);
    assert.ok(ratioErr >= 4.5, `Error text on ${s.name} must meet 4.5:1 (got ${ratioErr.toFixed(2)})`);

    const ratioSucc = contrastRatio(successText, s.hex);
    assert.ok(ratioSucc >= 4.5, `Success text on ${s.name} must meet 4.5:1 (got ${ratioSucc.toFixed(2)})`);

    const ratioWarn = contrastRatio(warningText, s.hex);
    assert.ok(ratioWarn >= 4.5, `Warning text on ${s.name} must meet 4.5:1 (got ${ratioWarn.toFixed(2)})`);
  }

  // Non-text boundary line against card surface and base
  const ratioBorderCard = contrastRatio(borderStrong, '#171B34');
  assert.ok(ratioBorderCard >= 3.0, `Boundary border on card surface must meet 3:1 (got ${ratioBorderCard.toFixed(2)})`);
});
