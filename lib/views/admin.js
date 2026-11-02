// lib/views/admin.js - Admin shell. Data is loaded by /js/admin.js from role-checked APIs.
import { html } from './html.js';
import { tabsFor } from '../admin-roles.js';
import { layout } from './layout.js';

/** Signed-out and not-an-admin screens use the public site chrome. They carry no admin data, scripts or role hints. */
function accessScreen(state) {
  const out = state === 'signed_out';
  const body = html`<section class="section"><div class="wrap narrow access-screen">
    <p class="eyebrow">Admin</p>
    <h1>${out ? 'Sign in to continue' : 'You don’t have access to this page'}</h1>
    <p class="lede">${out
      ? 'The admin area is for the NIGHTLIFEZ team. Sign in with Telegram to continue.'
      : 'This area is for the NIGHTLIFEZ team. If you think you should have access, ask the site owner.'}</p>
    <div class="access-actions">
      ${out ? html`<a class="btn btn-tg btn-lg" href="/signin?next=/admin">Continue with Telegram</a>` : ''}
      <a class="btn btn-ghost btn-lg" href="/">Back to the site</a>
    </div>
  </div></section>`;
  return layout({
    title: out ? 'Sign in required' : 'Access denied',
    description: 'Admin area for the NIGHTLIFEZ team.',
    path: '/admin',
    body,
    noindex: true
  });
}

export function renderAdminShell({ state, role, csrf }) {
  if (state === 'signed_out' || state === 'forbidden') return accessScreen(state);
  const tabs = tabsFor(role);
  const main = html`<div class="admin" data-role="${role}" data-csrf="${csrf}">
      <div class="admin-nav">
        <div class="admin-brand"><a class="logo" href="/">NIGHTLIFEZ</a><p class="muted admin-role">${role.replace('_', ' ')}</p></div>
        <button class="admin-nav-toggle" type="button" aria-expanded="false" aria-controls="admin-sections"><span class="admin-nav-toggle-label">Sections</span> <strong data-current-tab>${tabs[0][1]}</strong></button>
        <nav id="admin-sections" aria-label="Admin sections">
          ${tabs.map(([tab, label], i) => html`<button type="button" data-tab="${tab}"${i === 0 ? html` aria-current="page"` : ''}>${label}</button>`)}
        </nav>
      </div>
      <main class="admin-main" id="admin-main"><p class="muted" role="status">Loading…</p></main>
      <div class="sr-only" id="admin-status" role="status" aria-live="polite"></div>
    </div>`;
  return `<!doctype html>${html`<html lang="en-IN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Admin · NIGHTLIFEZ</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap">
<link rel="stylesheet" href="/css/site.css?v=11">
<link rel="stylesheet" href="/css/admin.css?v=7">
</head><body class="admin-body">${main}
<script src="/js/admin.js?v=5" defer></script>
</body></html>`}`;
}
