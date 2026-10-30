// lib/views/organiser.js - Organiser shells (dashboard, wizard, manage) and the draft preview.
// The interactive parts render client-side from /api/organiser/* (public/js/organiser.js).
import { html, raw } from './html.js';
import { layout, pageHeader } from './layout.js';
import { renderEvent } from './event.js';

const ASSETS = raw('<link rel="stylesheet" href="/css/organiser.css?v=1"><script src="/js/organiser.js?v=1" defer></script>');

function jsonScript(id, obj) {
  return raw(`<script type="application/json" id="${id}">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`);
}

function gate(state, next) {
  if (state === 'signed_out') {
    return html`<section class="wrap narrow org-gate">
      <div class="org-gate-card">
        <h2>Sign in to list your event</h2>
        <p>Sign in with Telegram to create and manage events.</p>
        <p><a class="btn btn-tg btn-lg" href="/signin?next=${encodeURIComponent(next)}">Continue with Telegram</a></p>
        <p class="muted small">Quick, passwordless sign-in. Your phone number is never shared with attendees.</p>
      </div>
    </section>`;
  }
  return html`<section class="wrap narrow org-gate">
    <div class="org-gate-card">
      <span class="org-gate-badge">Organiser Onboarding</span>
      <h2>Host your events on StrangersMeetup</h2>
      <p><strong>Organiser access is by invitation while we launch.</strong></p>
      <p class="muted">Tell us about the events you run and we’ll set you up. Your drafts and events stay private to you.</p>
      <ul class="org-gate-features">
        <li><strong>Discovery:</strong> Direct exposure across South India (parties, mixers, dinners, trips).</li>
        <li><strong>Control:</strong> Free or paid tiers, attendee approvals, and private venue protection.</li>
        <li><strong>Community:</strong> Automated private Telegram coordination for confirmed attendees.</li>
      </ul>
      <div class="org-gate-action">
        <a class="btn btn-primary btn-lg" href="/become-a-host">Apply to host</a>
      </div>
    </div>
  </section>`;
}

const PAGES = {
  dashboard: {
    title: 'Your events', path: '/organiser',
    head: () => pageHeader('Organiser', 'Your events', 'Drafts stay private until you publish them.'),
    body: () => html`<section class="wrap org-dash" data-org-dashboard>
      <p class="muted" data-loading>Loading your events…</p>
      <noscript><p>The organiser tools need JavaScript.</p></noscript>
    </section>`
  },
  wizard: {
    title: 'Create an event', path: '/organiser/new',
    head: () => '',
    body: ({ config }) => html`<section class="wz" id="wizard" data-wizard>
      <div class="wrap wz-wrap"><p class="muted" data-loading>Loading the event builder…</p>
      <noscript><p>The event builder needs JavaScript.</p></noscript></div>
    </section>${jsonScript('wz-config', config)}`
  },
  manage: {
    title: 'Manage event', path: '/organiser',
    head: () => '',
    body: ({ eventId }) => html`<section class="wrap org-manage" data-org-manage="${eventId}">
      <p class="muted" data-loading>Loading guests…</p>
      <noscript><p>The organiser tools need JavaScript.</p></noscript>
    </section>`
  }
};

export function renderOrganiserPage({ page, state, csrf = '', config = null, eventId = '' }) {
  const p = PAGES[page];
  const ok = state === 'ok';
  const body = html`<div class="org" data-csrf="${ok ? csrf : ''}">
    ${ok ? p.head() : pageHeader('Organiser', p.title, '')}
    ${ok ? p.body({ config, eventId }) : gate(state, page === 'wizard' ? '/organiser/new' : p.path)}
  </div>`;
  return layout({ title: p.title, description: 'Create and manage your StrangersMeetup events.', path: p.path, body, head: ok ? ASSETS : '', noindex: true, bodyClass: 'org-body' });
}

export function renderDraftPreview({ event, draftId, issues }) {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const banner = html`<div class="preview-bar" role="note">
    <div class="wrap preview-bar-inner">
      <p><strong>Preview</strong> — this draft is not published and only you can see it.
        ${errors ? html`${errors} thing${errors === 1 ? '' : 's'} to finish before publishing.` : 'Ready to publish when you are.'}</p>
      <a class="btn btn-sm btn-ghost" href="/organiser/new?draft=${draftId}">Back to editing</a>
    </div>
  </div>`;
  if (!event) {
    return layout({
      title: 'Preview', description: 'Draft preview', path: '/organiser', noindex: true,
      body: html`${banner}${pageHeader('Preview', 'Almost there', 'Add an event name and a start date and time to see the attendee page.')}`
    });
  }
  return renderEvent(event, { preview: true, previewBanner: banner });
}
