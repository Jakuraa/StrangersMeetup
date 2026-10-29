// test/card-art.test.js - Event cards without a cover photo get a category-specific, decorative fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventCard } from '../lib/views/components.js';
import { CATEGORY_LABELS } from '../lib/services/events.js';

const card = (category, extra = {}) => String(eventCard({
  slug: 'x', title: 'T', category, categoryLabel: CATEGORY_LABELS[category], city: 'Chennai', area: '', startAt: '2030-01-01T10:00:00Z',
  inclusions: [], state: 'open', stateLabel: 'Bookings open', isTrip: false, priceLabel: 'Free', coverUrl: null, ...extra
}));

test('every category has its own decorative fallback art, hidden from assistive tech', () => {
  const seen = new Set();
  for (const category of Object.keys(CATEGORY_LABELS)) {
    const out = card(category);
    assert.match(out, new RegExp(`class="card-art card-art-${category}" aria-hidden="true"`), category);
    const svg = out.match(/<svg class="card-glyph"[\s\S]*?<\/svg>/);
    assert.ok(svg, `${category} has a glyph`);
    assert.doesNotMatch(svg[0], /<title|aria-label|role=/, 'decorative only');
    seen.add(svg[0]);
  }
  assert.equal(seen.size, Object.keys(CATEGORY_LABELS).length, 'no two categories share the same glyph');
});

test('unknown categories fall back to the plain art, and real cover photos win', () => {
  assert.match(card('something_new'), /card-art card-art-something_new/);
  assert.doesNotMatch(card('something_new'), /<svg/);
  const withCover = card('meetup', { coverUrl: '/media/abc.jpg' });
  assert.match(withCover, /<img class="card-img" src="\/media\/abc.jpg"/);
  assert.doesNotMatch(withCover, /card-art/);
});
