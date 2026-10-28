// lib/views/admin.js - Admin shell. Data is loaded by /js/admin.js from role-checked APIs.
import { html } from './html.js';
import { tabsFor } from '../admin-roles.js';

export function renderAdminShell({ state, role, csrf }) {
  let main;
  if (state === 'signed_out') {
    main = html`<main class="wrap narrow admin-gate"><h1>Admin</h1><p>Please sign in with Telegram first.</p>
      <a class="btn btn-tg" href="/signin?next=/admin">Continue with Telegram</a></main>`;
  } else if (state === 'forbidden') {
    main = html`<main class="wrap narrow admin-gate"><h1>Admin</h1><p>This Telegram account is not on the admin allowlist.</p><p><a href="/">Back to site</a></p></main>`;
  } else {
    main = html`<div class="admin" data-role="${role}" data-csrf="${csrf}">
      <aside class="admin-nav" aria-label="Admin sections">
        <a class="logo" href="/">StrangersMeetup</a>
        <p class="muted admin-role">${role.replace('_', ' ')}</p>
        <nav>
          ${tabsFor(role).map(([tab, label], i) => html`<button data-tab="${tab}"${i === 0 ? html` aria-current="page"` : ''}>${label}</button>`)}
        </nav>
      </aside>
      <main class="admin-main" id="admin-main" aria-live="polite"><p class="muted">Loading…</p></main>
    </div>`;
  }
  return `<!doctype html>${html`<html lang="en-IN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Admin · StrangersMeetup</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap">
<link rel="stylesheet" href="/css/site.css?v=4">
<link rel="stylesheet" href="/css/admin.css?v=2">
</head><body class="admin-body">${main}
${state === 'admin' ? html`<script src="/js/admin.js?v=2" defer></script>` : ''}
</body></html>`}`;
}
