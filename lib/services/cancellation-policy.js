// lib/services/cancellation-policy.js - Event Creator Cancellation & Refund Policy Templates
// Provides standardized, transparent, consumer-compliant cancellation policies:
// Flexible, Standard (default), Strict, and Custom.
// Includes core platform clauses: 100% creator cancel guarantee, postponement protection,
// no-show rules, and 5-7 business days refund processing timeline disclosure.
import { z } from '../validate.js';
import { html, raw, esc } from '../views/html.js';

export const TEMPLATE_KEYS = ['flexible', 'standard', 'strict', 'custom'];

export const POLICY_TEMPLATES = {
  flexible: {
    key: 'flexible',
    name: 'Flexible',
    badge: 'Flexible Policy',
    description: 'Full refund up to 24 hours before event start. Non-refundable within 24 hours.',
    primaryDeadlineHours: 24,
    primaryRefundPercent: 100,
    secondaryDeadlineHours: null,
    secondaryRefundPercent: 0,
    summary: '100% refund up to 24 hours before the event. Non-refundable within 24 hours.'
  },
  standard: {
    key: 'standard',
    name: 'Standard',
    badge: 'Standard Policy',
    description: 'Full refund up to 48 hours before start; 50% refund between 48h and 24h; non-refundable within 24h.',
    primaryDeadlineHours: 48,
    primaryRefundPercent: 100,
    secondaryDeadlineHours: 24,
    secondaryRefundPercent: 50,
    summary: '100% refund up to 48 hours before the event; 50% refund between 48h and 24h; non-refundable within 24 hours.'
  },
  strict: {
    key: 'strict',
    name: 'Strict',
    badge: 'Strict Policy',
    description: 'Full refund up to 7 days before start; 50% refund between 7 days and 48 hours; non-refundable within 48h.',
    primaryDeadlineHours: 168, // 7 days
    primaryRefundPercent: 100,
    secondaryDeadlineHours: 48,
    secondaryRefundPercent: 50,
    summary: '100% refund up to 7 days before the event; 50% refund between 7 days and 48 hours; non-refundable within 48 hours.'
  },
  custom: {
    key: 'custom',
    name: 'Custom',
    badge: 'Custom Policy',
    description: 'Creator-defined deadlines and refund percentages.',
    summary: 'Custom cancellation deadlines and refund percentages set by the host.'
  }
};

export const COMMON_POLICY_CLAUSES = {
  creatorCancellation: '100% full refund automatically if the event is cancelled by the organiser or platform.',
  postponement: '100% full refund upon request if the event date, time, venue, or key programming changes materially.',
  noShow: 'Non-refundable (0%) once the event has started or in the case of a no-show.',
  processingTimeline: 'Approved refunds are returned to the original payment method within 5–7 business days.'
};

export const CancellationPolicyDraft = z.object({
  template: z.enum(TEMPLATE_KEYS).default('standard'),
  primaryDeadlineHours: z.number().int().min(1).max(720).optional(),
  primaryRefundPercent: z.number().int().min(1).max(100).optional(),
  secondaryDeadlineHours: z.number().int().min(1).max(720).nullable().optional(),
  secondaryRefundPercent: z.number().int().min(0).max(100).nullable().optional(),
  customTerms: z.string().max(1000).optional().default('')
}).strict();

const clean = (s) => String(s ?? '').trim();

function fmtHours(h) {
  if (h === 168) return '7 days (168 hours)';
  return `${h} hours`;
}

/**
 * Builds human-readable text for a cancellation policy.
 */
export function renderPolicyText(snapshot) {
  const parts = [];
  const primaryHours = snapshot.primaryDeadlineHours;
  const primaryPct = snapshot.primaryRefundPercent;
  const secHours = snapshot.secondaryDeadlineHours;
  const secPct = snapshot.secondaryRefundPercent;

  const primaryLabel = fmtHours(primaryHours);
  const secLabel = secHours != null ? fmtHours(secHours) : '';

  // 1. Attendee cancellation terms
  if (secHours != null && secPct != null && secPct > 0) {
    parts.push(
      `Attendee cancellation: ${primaryPct}% refund up to ${primaryLabel} before the event; ` +
      `${secPct}% refund between ${primaryLabel} and ${secLabel} before the event. ` +
      `Non-refundable within ${secLabel} of event start.`
    );
  } else {
    parts.push(
      `Attendee cancellation: ${primaryPct}% refund up to ${primaryLabel} before the event. ` +
      `Non-refundable within ${primaryLabel} of event start.`
    );
  }

  // 2. No show policy
  parts.push(`No-show policy: Non-refundable (0%) once the event has started.`);

  // 3. Creator cancellation guarantee
  parts.push(
    `Creator cancellation & material changes: Guaranteed 100% full refund to all attendees if the organiser or platform cancels the event or reschedules materially.`
  );

  // 4. Processing timeline
  parts.push(`Refund timeline: Approved refunds are processed back to the original payment method within 5–7 business days.`);

  // 5. Custom terms if any
  if (snapshot.customTerms) {
    parts.push(`Additional terms: ${snapshot.customTerms}`);
  }

  return parts.join(' ');
}

/**
 * Resolves input into a validated snapshot and rendered policy text.
 * Falls back gracefully to Standard template.
 */
export function resolveCancellationPolicy(input = {}) {
  let tplKey = 'standard';
  let primaryHours = POLICY_TEMPLATES.standard.primaryDeadlineHours;
  let primaryPct = POLICY_TEMPLATES.standard.primaryRefundPercent;
  let secHours = POLICY_TEMPLATES.standard.secondaryDeadlineHours;
  let secPct = POLICY_TEMPLATES.standard.secondaryRefundPercent;
  let customTerms = '';

  if (typeof input === 'string') {
    if (TEMPLATE_KEYS.includes(input)) {
      tplKey = input;
    } else {
      // String could be custom policy text
      tplKey = 'custom';
      customTerms = clean(input).slice(0, 1000);
    }
  } else if (input && typeof input === 'object') {
    if (input.template && TEMPLATE_KEYS.includes(input.template)) {
      tplKey = input.template;
    } else if (input.refundPolicy && !input.template) {
      // Legacy text policy
      tplKey = 'standard';
      customTerms = clean(input.refundPolicy).slice(0, 1000);
    }

    if (tplKey === 'custom') {
      primaryHours = Number.isInteger(input.primaryDeadlineHours) && input.primaryDeadlineHours >= 1
        ? input.primaryDeadlineHours
        : 48;
      primaryPct = Number.isInteger(input.primaryRefundPercent) && input.primaryRefundPercent >= 1 && input.primaryRefundPercent <= 100
        ? input.primaryRefundPercent
        : 100;
      if (Number.isInteger(input.secondaryDeadlineHours) && input.secondaryDeadlineHours < primaryHours && input.secondaryDeadlineHours >= 1) {
        secHours = input.secondaryDeadlineHours;
        secPct = Number.isInteger(input.secondaryRefundPercent) && input.secondaryRefundPercent >= 0 && input.secondaryRefundPercent <= primaryPct
          ? input.secondaryRefundPercent
          : 50;
      } else {
        secHours = null;
        secPct = 0;
      }
      customTerms = clean(input.customTerms || input.refundPolicy || '').slice(0, 1000);
    }
  }

  if (tplKey !== 'custom') {
    const tpl = POLICY_TEMPLATES[tplKey];
    primaryHours = tpl.primaryDeadlineHours;
    primaryPct = tpl.primaryRefundPercent;
    secHours = tpl.secondaryDeadlineHours;
    secPct = tpl.secondaryRefundPercent;
    if (input?.customTerms) {
      customTerms = clean(input.customTerms).slice(0, 1000);
    }
  }

  const tplDef = POLICY_TEMPLATES[tplKey] || POLICY_TEMPLATES.standard;

  let summary = tplDef.summary;
  if (tplKey === 'custom') {
    if (secHours != null && secPct != null && secPct > 0) {
      summary = `${primaryPct}% refund up to ${primaryHours}h before event; ${secPct}% refund between ${primaryHours}h and ${secHours}h; non-refundable within ${secHours}h.`;
    } else {
      summary = `${primaryPct}% refund up to ${primaryHours}h before event; non-refundable within ${primaryHours}h.`;
    }
  }

  const snapshot = {
    template: tplKey,
    name: tplDef.name,
    badge: tplDef.badge,
    description: tplDef.description,
    summary,
    primaryDeadlineHours: primaryHours,
    primaryRefundPercent: primaryPct,
    secondaryDeadlineHours: secHours,
    secondaryRefundPercent: secPct,
    customTerms,
    clauses: { ...COMMON_POLICY_CLAUSES },
    createdAt: new Date().toISOString()
  };

  const renderedText = renderPolicyText(snapshot);

  return { snapshot, renderedText };
}

/**
 * Calculates refund eligibility for an attendee self-cancellation.
 * Compares cancellation timestamp against event start time and the snapshot rules.
 */
export function calculateRefundEligibility(policySnapshot, eventStartAt, cancelDate = new Date()) {
  const startMs = new Date(eventStartAt).getTime();
  const cancelMs = new Date(cancelDate).getTime();
  if (isNaN(startMs) || isNaN(cancelMs)) {
    throw new Error('Invalid dates provided for refund eligibility calculation');
  }

  const snapshot = policySnapshot || POLICY_TEMPLATES.standard;
  const hoursUntilEvent = (startMs - cancelMs) / (1000 * 60 * 60);

  if (hoursUntilEvent <= 0) {
    return {
      eligible: false,
      refundPercent: 0,
      window: 'past_event',
      hoursUntilEvent: Math.max(0, hoursUntilEvent),
      reason: 'Event has already started or concluded. No-show / post-start policy applies (0% refund).'
    };
  }

  const primaryHours = snapshot.primaryDeadlineHours ?? 48;
  const primaryPct = snapshot.primaryRefundPercent ?? 100;
  const secHours = snapshot.secondaryDeadlineHours ?? null;
  const secPct = snapshot.secondaryRefundPercent ?? 0;

  if (hoursUntilEvent >= primaryHours) {
    return {
      eligible: primaryPct > 0,
      refundPercent: primaryPct,
      window: 'primary',
      hoursUntilEvent,
      reason: `Cancelled ${Math.round(hoursUntilEvent)}h before event (before ${primaryHours}h deadline). Entitled to ${primaryPct}% refund.`
    };
  }

  if (secHours != null && hoursUntilEvent >= secHours) {
    return {
      eligible: secPct > 0,
      refundPercent: secPct,
      window: 'secondary',
      hoursUntilEvent,
      reason: `Cancelled ${Math.round(hoursUntilEvent)}h before event (between ${primaryHours}h and ${secHours}h deadline). Entitled to ${secPct}% refund.`
    };
  }

  return {
    eligible: false,
    refundPercent: 0,
    window: 'non_refundable',
    hoursUntilEvent,
    reason: `Cancelled ${Math.round(hoursUntilEvent)}h before event (within ${secHours != null ? secHours : primaryHours}h non-refundable window). 0% refund per agreed cancellation policy.`
  };
}

/**
 * Renders compact policy preview box HTML for checkout and booking box.
 */
export function renderPolicySummaryHtml(policy) {
  const p = policy || POLICY_TEMPLATES.standard;
  return html`
    <div class="policy-preview-box" data-policy-preview>
      <div class="policy-preview-header">
        <span class="policy-badge">${p.badge || 'Standard Policy'}</span>
        <span class="policy-guarantee" title="Guaranteed 100% refund if the event is cancelled by the organiser">🛡️ 100% Creator Guarantee</span>
      </div>
      <p class="policy-preview-text">${p.summary || 'Standard cancellation terms apply.'}</p>
      <p class="policy-processing-note">Approved refunds return to original payment method in 5–7 business days.</p>
    </div>
  `;
}

/**
 * Renders full structured policy card HTML for event details prose section.
 */
export function renderPolicyCardHtml(policy, customText) {
  const p = policy || POLICY_TEMPLATES.standard;
  return html`
    <section class="prose policy-card-section" id="cancellation-policy">
      <h2>Cancellation &amp; Refund Policy</h2>
      <div class="policy-card">
        <div class="policy-card-header">
          <span class="policy-badge policy-badge-lg">${p.badge || 'Standard Policy'}</span>
          <span class="policy-guarantee-pill">🛡️ 100% Refund if Host Cancels</span>
        </div>
        <ul class="policy-card-rules">
          <li><strong>Attendee cancellation:</strong> ${p.summary || customText || 'Standard refund terms apply.'}</li>
          <li><strong>Host cancellation guarantee:</strong> 100% full refund automatically if the host or platform cancels the event.</li>
          <li><strong>Rescheduling &amp; material changes:</strong> 100% refund upon request if the date, venue or core format changes materially.</li>
          <li><strong>No-show policy:</strong> Non-refundable once the event begins or for unattended bookings.</li>
          <li><strong>Processing timeline:</strong> Refunds are returned to your original payment method within 5–7 business days.</li>
        </ul>
        ${p.customTerms ? html`<p class="policy-custom-terms"><strong>Host notes:</strong> ${p.customTerms}</p>` : ''}
        <p class="policy-faq-link"><a href="/refunds">NIGHTLIFEZ Billing &amp; Refunds FAQ →</a></p>
      </div>
    </section>
  `;
}
