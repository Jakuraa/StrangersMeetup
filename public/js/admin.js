/* StrangersMeetup admin client. All authorisation is enforced server-side; this only renders.
   DOM is built with textContent (never innerHTML with data). */
(function () {
  'use strict';
  var root = document.querySelector('.admin');
  if (!root) return;
  var CSRF = root.getAttribute('data-csrf');
  var ROLE = root.getAttribute('data-role');
  var main = document.getElementById('admin-main');

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function toast(msg, err) {
    var t = el('div', { class: 'toast' + (err ? ' err' : ''), role: err ? 'alert' : 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }
  function api(method, path, body) {
    var h = { Accept: 'application/json' };
    if (method !== 'GET') { h['Content-Type'] = 'application/json'; h['X-CSRF-Token'] = CSRF; }
    return fetch(path, { method: method, headers: h, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; if (!r.ok) throw j; return j; }); });
  }
  function fail(e) { toast((e && (e.message || e.error)) || 'Request failed', true); }
  var fmtDT = function (d) { return d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; };
  var rupees = function (p) { return p === null || p === undefined ? '—' : '₹' + (Number(p) / 100).toLocaleString('en-IN'); };
  /* Tables: a real <table> on wide screens; below the container breakpoint (admin.css) every row becomes a
     labelled card. All columns are kept. Explicit ARIA roles keep table semantics when CSS changes `display`.
     cols: [header, render(row)] — an empty header marks the actions column (still named "Actions" for AT).
     opts: { name: accessible name of the table, primary: index of the identity column shown first on cards }. */
  function table(cols, rows, empty, opts) {
    opts = opts || {};
    if (!rows.length) return el('p', { class: 'muted empty', text: empty || 'None.' });
    var primary = opts.primary === undefined ? 0 : opts.primary;
    return el('table', { class: 't' + (cols.length > 6 ? ' t-wide' : ''), role: 'table', 'aria-label': opts.name || null }, [
      el('thead', { role: 'rowgroup' }, [el('tr', { role: 'row' }, cols.map(function (c) {
        return el('th', { role: 'columnheader', scope: 'col' }, [c[0] ? c[0] : el('span', { class: 'sr-only', text: 'Actions' })]);
      }))]),
      el('tbody', { role: 'rowgroup' }, rows.map(function (r) {
        return el('tr', { role: 'row' }, cols.map(function (c, i) {
          var v = c[1](r);
          var node = v instanceof Node ? v : String(v === null || v === undefined ? '—' : v);
          var none = node === '';
          return el('td', { role: 'cell', class: (c[0] ? '' : 't-actions') + (i === primary ? ' t-primary' : '') + (none ? ' t-none' : '') }, [
            c[0] ? el('span', { class: 't-lab', 'aria-hidden': 'true', text: c[0] }) : null,
            none ? null : el('div', { class: 't-val' }, [node])
          ]);
        }));
      }))
    ]);
  }
  /* about: what the button acts on, appended to the accessible name ("Check in Asha"). */
  function btn(label, fn, cls, about) { return el('button', { class: 'btn btn-sm ' + (cls || 'btn-ghost'), type: 'button', onclick: fn, text: label, 'aria-label': about ? label + ' ' + about : null }); }
  function can(roles) { return roles.indexOf(ROLE) !== -1; }

  /* ---------- tabs ---------- */
  var TABS = {};
  var statusEl = document.getElementById('admin-status');
  var navToggle = document.querySelector('.admin-nav-toggle');
  var sections = document.getElementById('admin-sections');
  function announce(msg) { if (statusEl) statusEl.textContent = msg; }
  function setMenu(open) {
    if (!navToggle) return;
    sections.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (navToggle) {
    navToggle.addEventListener('click', function () { setMenu(navToggle.getAttribute('aria-expanded') !== 'true'); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && navToggle.getAttribute('aria-expanded') === 'true') { setMenu(false); navToggle.focus(); }
    });
  }
  function errorPanel(e, retry) {
    var forbidden = e && e.status === 403;
    var offline = e instanceof TypeError;
    var msg = forbidden ? 'Your admin role does not include this section.'
      : offline ? 'Network problem — check your connection and try again.'
      : (e && (e.message || e.error)) || 'Something went wrong. Try again.';
    return el('div', { class: 'panel state', role: 'alert' }, [
      el('h1', { text: forbidden ? 'Not available for your role' : 'Could not load this section' }), el('p', { text: msg }),
      forbidden ? null : el('button', { class: 'btn btn-primary', type: 'button', onclick: retry, text: 'Try again' })]);
  }
  function focusHeading(opts) {
    var h = main.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus(opts || {}); }
  }
  function show(name, opts) {
    var label = '';
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      if (b.getAttribute('data-tab') === name) { b.setAttribute('aria-current', 'page'); label = b.textContent; } else b.removeAttribute('aria-current');
    });
    var cur = document.querySelector('[data-current-tab]'); if (cur && label) cur.textContent = label;
    clear(main).appendChild(el('p', { class: 'muted', role: 'status', text: 'Loading ' + (label || 'section') + '…' }));
    main.setAttribute('aria-busy', 'true');
    announce('Loading ' + label);
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    TABS[name]().then(function () {
      main.removeAttribute('aria-busy');
      announce(label + ' loaded');
      if (opts && opts.focus) focusHeading();
    }).catch(function (e) {
      main.removeAttribute('aria-busy');
      clear(main).appendChild(errorPanel(e, function () { show(name, { focus: true }); }));
      announce('Could not load ' + label);
      if (opts && opts.focus) focusHeading();
    });
  }
  document.querySelectorAll('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () { setMenu(false); show(b.getAttribute('data-tab'), { focus: true }); });
  });

  TABS.overview = function () {
    return api('GET', '/api/admin/overview').then(function (r) {
      var k = r.kpis;
      var items = [
        ['Members (active)', k.members], ['Users', k.users], ['Upcoming real events', k.upcoming_events], ['Upcoming sample events', k.upcoming_demo_events],
        ['Confirmed bookings', k.confirmed_bookings], ['Paid (test)', k.paid_test_paise, rupees], ['Paid (live)', k.paid_live_paise, rupees],
        ['Stars received', k.paid_stars], ['Failed payments', k.failed_payments], ['Invite failures', k.invite_failures],
        ['Memberships expiring ≤7d', k.expiring_memberships], ['Refunds due', k.refunds_due], ['New leads', k.new_leads], ['New reports', k.new_reports],
        ['Alert subscribers', k.alert_subscribers]
      ];
      clear(main).append(el('h1', { text: 'Overview' }), el('div', { class: 'kpis' }, items.map(function (i) {
        // A zero from the database is a real zero; it is shown as 0.
        return el('div', { class: 'kpi' }, [el('b', { text: i[2] ? i[2](i[1]) : Number(i[1]).toLocaleString('en-IN') }), el('span', { text: i[0] })]);
      })), el('div', { class: 'panel' }, [el('h2', { text: 'Configuration' }), el('ul', { class: 'config-list' }, Object.keys(r.config).map(function (key) {
        return el('li', {}, [el('strong', { text: key + ': ' }), String(r.config[key])]);
      }))]));
    });
  };

  /* ---------- events ---------- */
  var CATS = ['meetup', 'dating_mixer', 'matchmaking', 'nightlife', 'weekend_party', 'dinner_club', 'movie', 'board_games', 'weekend_trip', 'resort_getaway'];
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(new Date(iso).getTime() + 5.5 * 3600e3);
    return d.toISOString().slice(0, 16);
  }
  function fromLocalInput(v) { return v ? v + ':00+05:30' : null; }

  function eventForm(ev, onDone) {
    ev = ev || { venue_privacy: 'disclosed_after_booking', category: 'meetup', inclusions: [], exclusions: [] };
    var f = {};
    function input(name, label, type, value, extra) {
      var i = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', Object.assign({ name: name }, type !== 'textarea' && type !== 'select' ? { type: type } : {}, extra || {}));
      if (type === 'select') (extra.options || []).forEach(function (o) { i.appendChild(el('option', { value: o, text: o, selected: o === value })); });
      else if (type === 'checkbox') i.checked = Boolean(value);
      else i.value = value === null || value === undefined ? '' : value;
      f[name] = i;
      return el('label', { class: (extra && extra.wide) ? 'wide' + (type === 'checkbox' ? ' check' : '') : (type === 'checkbox' ? 'check' : null) }, type === 'checkbox' ? [i, ' ' + label] : [label, i]);
    }
    var form = el('form', { class: 'admin-form panel' }, [
      input('title', 'Title', 'text', ev.title, { required: true, wide: true }),
      input('slug', 'Slug (url)', 'text', ev.slug, { required: true }),
      input('category', 'Category', 'select', ev.category, { options: CATS }),
      input('city', 'City', 'text', ev.city, { required: true }),
      input('area_public', 'Area (public)', 'text', ev.area_public),
      input('venue_private', 'Venue / address', 'text', ev.venue_private),
      input('venue_privacy', 'Venue privacy', 'select', ev.venue_privacy, { options: ['disclosed_after_booking', 'public'] }),
      input('start_at', 'Starts (IST)', 'datetime-local', toLocalInput(ev.start_at), { required: true }),
      input('end_at', 'Ends (IST)', 'datetime-local', toLocalInput(ev.end_at)),
      input('capacity', 'Capacity', 'number', ev.capacity, { min: 1, required: true }),
      input('ticket_price_rupees', 'Ticket price ₹ (blank = to be announced)', 'number', ev.ticket_price_paise ? ev.ticket_price_paise / 100 : '', { min: 1, step: '1' }),
      input('organizer', 'Hosted by', 'text', ev.organizer),
      input('gender_policy', 'Group balance policy (e.g. gender-balanced tables)', 'text', ev.gender_policy),
      input('summary', 'Summary (1–2 lines)', 'textarea', ev.summary, { wide: true, rows: 2 }),
      input('description', 'Description', 'textarea', ev.description, { wide: true, rows: 5 }),
      input('inclusions', 'Included (one per line)', 'textarea', (ev.inclusions || []).join('\n'), { wide: true, rows: 3 }),
      input('exclusions', 'Not included (one per line)', 'textarea', (ev.exclusions || []).join('\n'), { wide: true, rows: 2 }),
      input('refund_policy', 'Refund policy', 'textarea', ev.refund_policy, { wide: true, rows: 2 }),
      input('bookmyshow_url', 'BookMyShow URL (optional)', 'url', ev.bookmyshow_url),
      input('external_payment_url', 'External payment URL (optional)', 'url', ev.external_payment_url),
      input('telegram_chat_id', 'Telegram chat id (blank = events group)', 'text', ev.telegram_chat_id),
      input('cover_media_id', 'Cover media id (authorised media only)', 'text', ev.cover_media_id),
      input('food_available', 'Food available', 'checkbox', ev.food_available),
      input('stay_available', 'Stay available', 'checkbox', ev.stay_available),
      input('is_demo', 'Sample / demo listing (shown with a “Sample” label)', 'checkbox', ev.is_demo, { wide: true }),
      el('div', { class: 'wide row-actions' }, [el('button', { class: 'btn btn-primary', type: 'submit', text: ev.id ? 'Save changes' : 'Create draft' }), btn('Cancel', onDone)])
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var lines = function (v) { return v.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); };
      var price = f.ticket_price_rupees.value.trim();
      var body = {
        title: f.title.value, slug: f.slug.value, category: f.category.value, city: f.city.value, area_public: f.area_public.value,
        venue_private: f.venue_private.value, venue_privacy: f.venue_privacy.value, start_at: fromLocalInput(f.start_at.value), end_at: fromLocalInput(f.end_at.value),
        capacity: Number(f.capacity.value), ticket_price_paise: price ? Math.round(Number(price) * 100) : null, organizer: f.organizer.value,
        gender_policy: f.gender_policy.value, summary: f.summary.value, description: f.description.value, inclusions: lines(f.inclusions.value),
        exclusions: lines(f.exclusions.value), refund_policy: f.refund_policy.value, bookmyshow_url: f.bookmyshow_url.value,
        external_payment_url: f.external_payment_url.value, telegram_chat_id: f.telegram_chat_id.value.trim() || null,
        cover_media_id: f.cover_media_id.value.trim() || null, food_available: f.food_available.checked, stay_available: f.stay_available.checked, is_demo: f.is_demo.checked
      };
      (ev.id ? api('PATCH', '/api/admin/events/' + ev.id, body) : api('POST', '/api/admin/events', body))
        .then(function () { toast('Saved'); onDone(); })
        .catch(function (err) { fail(err); (err.fields || []).forEach(function (x) { if (f[x.field]) f[x.field].setCustomValidity(x.message); }); });
    });
    return form;
  }

  var pill = function (text) { return el('span', { class: 'pill pill-' + String(text).replace(/\W+/g, '-'), text: String(text).replace(/_/g, ' ') }); };

  /* Renders the check-in list for one event into `holder`. After a check-in it refreshes in place, so
     door staff keep the list open instead of reopening it for every guest. */
  function loadAttendees(ev, holder, opts) {
    opts = opts || {};
    return api('GET', '/api/admin/events/' + ev.id + '/attendees').then(function (r) {
      var canCheck = can(['super_admin', 'event_manager', 'support']);
      var done = r.attendees.filter(function (a) { return a.status === 'checked_in'; }).length;
      var heading = el('h2', { text: 'Check-in — ' + ev.title, tabindex: '-1' });
      var panel = el('div', { class: 'panel', role: 'region', 'aria-label': 'Check-in for ' + ev.title }, [heading,
        el('p', { class: 'muted', role: 'status', text: r.attendees.length ? done + ' of ' + r.attendees.length + ' checked in' : '' }),
        table([
          ['Name', function (a) { return a.alias || 'Unnamed guest'; }], ['Ref', function (a) { return a.ref; }], ['Status', function (a) { return pill(a.status); }],
          ['', function (a) {
            return a.status === 'confirmed' && canCheck ? btn('Check in', function (e) {
              var b = e.currentTarget; b.disabled = true;
              api('POST', '/api/admin/bookings/' + a.id + '/check-in', {}).then(function () {
                toast('Checked in ' + (a.alias || a.ref));
                return loadAttendees(ev, holder, { keepScroll: true });
              }).catch(function (err) { b.disabled = false; fail(err); });
            }, null, a.alias || a.ref) : '';
          }]
        ], r.attendees, 'No confirmed attendees yet.', { name: 'Attendees of ' + ev.title })]);
      clear(holder).appendChild(panel);
      heading.focus({ preventScroll: Boolean(opts.keepScroll) });
    });
  }

  TABS.events = function () {
    return api('GET', '/api/admin/events').then(function (r) {
      var writer = can(['super_admin', 'event_manager']);
      var holder = el('div');
      function status(ev, s) { return function () { if (s === 'cancelled' && !confirm('Cancel this event? Attendees are told by DM; refunds are issued from Bookings.')) return; api('POST', '/api/admin/events/' + ev.id + '/status', { status: s }).then(function () { toast('Status: ' + s); TABS.events(); }).catch(fail); }; }
      clear(main).append(el('h1', { text: 'Events' }),
        writer ? el('p', {}, [btn('New event', function () { clear(holder).appendChild(eventForm(null, TABS.events)); }, 'btn-primary')]) : '',
        holder,
        el('div', { class: 'panel' }, [table([
          ['When', function (e) { return fmtDT(e.start_at); }],
          ['Title', function (e) { return el('span', {}, [e.title, e.is_demo ? el('span', { class: 'pill', text: 'Sample' }) : '']); }],
          ['City', function (e) { return e.city; }], ['Status', function (e) { return pill(e.status); }],
          ['Price', function (e) { return e.price_status === 'set' ? rupees(e.ticket_price_paise) : 'TBD'; }],
          ['Booked', function (e) { return e.confirmed + ' / ' + e.capacity; }],
          ['', function (e) {
            return el('div', { class: 'row-actions' }, [
              el('a', { class: 'btn btn-sm btn-ghost', href: '/admin/preview/' + e.id, target: '_blank', rel: 'noopener', text: 'Preview', 'aria-label': 'Preview ' + e.title + ' (opens in a new tab)' }),
              btn('Attendees', function () { loadAttendees(e, holder).catch(fail); }, null, 'for ' + e.title),
              writer ? btn('Edit', function () { api('GET', '/api/admin/events/' + e.id).then(function (x) { clear(holder).appendChild(eventForm(x.event, TABS.events)); window.scrollTo(0, 0); }).catch(fail); }, null, e.title) : '',
              writer && e.status !== 'published' && e.status !== 'cancelled' ? btn('Publish', status(e, 'published'), null, e.title) : '',
              writer && e.status === 'published' ? btn('Unpublish', status(e, 'draft'), null, e.title) : '',
              writer && e.status !== 'cancelled' ? btn('Cancel', status(e, 'cancelled'), null, e.title) : '',
              writer && e.status !== 'archived' ? btn('Archive', status(e, 'archived'), null, e.title) : ''
            ]);
          }]
        ], r.events, 'No events yet. Create the first real event.', { name: 'Events', primary: 1 })]));
    });
  };

  /* ---------- bookings & payments ---------- */
  TABS.bookings = function (filter) {
    var q = filter ? '?status=' + encodeURIComponent(filter) : '';
    return api('GET', '/api/admin/bookings' + q).then(function (r) {
      var finance = can(['super_admin', 'finance']);
      var sel = el('select', { 'aria-label': 'Filter bookings by status', onchange: function () { TABS.bookings(sel.value); } }, ['', 'pending_payment', 'confirmed', 'checked_in', 'cancelled', 'refunded', 'refund_due'].map(function (s) { return el('option', { value: s, text: s || 'All', selected: s === (filter || '') }); }));
      function refund(pid) { return function () { if (!confirm('Issue a full refund for this payment?')) return; api('POST', '/api/admin/payments/' + pid + '/refund', {}).then(function () { toast('Refund issued'); TABS.bookings(filter); }).catch(fail); }; }
      clear(main).append(el('h1', { text: 'Bookings & payments' }), el('p', {}, [el('label', {}, ['Filter ', sel])]),
        el('div', { class: 'panel' }, [table([
          ['Created', function (b) { return fmtDT(b.created_at); }], ['Event', function (b) { return b.title; }], ['Member', function (b) { return b.alias; }],
          ['Booking', function (b) { return el('span', {}, [pill(b.status), b.cancel_reason ? ' ' + b.cancel_reason : '']); }],
          ['Payment', function (b) { return b.payment_id ? b.provider + ' · ' + b.payment_status + (b.is_test ? ' · test' : '') : '—'; }],
          ['Provider txn', function (b) { return b.provider_txn_id || '—'; }], ['Amount', function (b) { return rupees(b.amount); }],
          ['', function (b) { return finance && b.payment_status === 'paid' ? btn('Refund', refund(b.payment_id), null, (b.alias || 'member') + ', ' + b.title) : ''; }]
        ], r.bookings, 'No bookings match this filter.', { name: 'Bookings', primary: 2 })]),
        el('h2', { text: 'Membership payments (Stars)' }),
        el('div', { class: 'panel' }, [table([
          ['When', function (p) { return fmtDT(p.created_at); }], ['Member', function (p) { return p.alias; }], ['Charge id', function (p) { return p.provider_txn_id; }],
          ['Stars', function (p) { return p.amount; }], ['Status', function (p) { return p.payment_status + (p.is_test ? ' · test' : ''); }],
          ['', function (p) { return finance && p.payment_status === 'paid' ? btn('Refund', refund(p.payment_id), null, 'Stars payment from ' + (p.alias || 'member')) : ''; }]
        ], r.membershipPayments, 'No membership payments.', { name: 'Membership payments (Stars)', primary: 1 })]));
    });
  };

  /* ---------- memberships ---------- */
  TABS.memberships = function (q) {
    return api('GET', '/api/admin/memberships' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (r) {
      var search = el('input', { type: 'search', placeholder: 'Telegram id or name', 'aria-label': 'Search members by Telegram id or name', value: q || '' });
      var form = el('form', { class: 'row-actions' }, [search, el('button', { class: 'btn btn-sm btn-ghost', type: 'submit', text: 'Search' })]);
      form.addEventListener('submit', function (e) { e.preventDefault(); TABS.memberships(search.value); });
      clear(main).append(el('h1', { text: 'Memberships' }), form, el('div', { class: 'panel' }, [table([
        ['Member', function (m) { return m.alias; }], ['Telegram id', function (m) { return m.telegram_user_id; }], ['Tier', function (m) { return m.tier; }],
        ['Status', function (m) { return pill(m.status); }], ['Expires', function (m) { return fmtDT(m.expires_at); }],
        ['', function (m) { return can(['super_admin', 'moderator']) && ['active', 'grace', 'cancelled', 'expired'].indexOf(m.status) !== -1 ? btn('Revoke', function () { if (!confirm('Remove this member from the tier group now?')) return; api('POST', '/api/admin/entitlements/' + m.id + '/revoke', {}).then(function () { toast('Revoked'); TABS.memberships(q); }).catch(fail); }, null, m.alias || m.telegram_user_id) : ''; }]
      ], r.memberships, q ? 'No members match \u201c' + q + '\u201d.' : 'No memberships yet.', { name: 'Memberships' })]));
    });
  };

  /* ---------- leads & reports ---------- */
  function statusSelect(current, options, onChange, label) {
    var s = el('select', { 'aria-label': label || 'Status', onchange: function () { onChange(s.value); } }, options.map(function (o) { return el('option', { value: o, text: o, selected: o === current }); }));
    return s;
  }
  TABS.leads = function () {
    return api('GET', '/api/admin/leads').then(function (r) {
      clear(main).append(el('h1', { text: 'Leads' }), el('div', { class: 'panel' }, [table([
        ['When', function (l) { return fmtDT(l.created_at); }], ['Type', function (l) { return l.type; }],
        ['Details', function (l) { return el('div', {}, Object.keys(l.payload).map(function (k) { return el('div', {}, [el('strong', { text: k + ': ' }), String(l.payload[k])]); })); }],
        ['Status', function (l) { return statusSelect(l.status, ['new', 'contacted', 'closed', 'spam'], function (v) { api('PATCH', '/api/admin/leads/' + l.id, { status: v }).then(function () { toast('Updated'); }).catch(fail); }, 'Status of ' + l.type + ' lead from ' + fmtDT(l.created_at)); }]
      ], r.leads, 'No leads yet.', { name: 'Leads', primary: 1 })]));
      if (can(['super_admin', 'moderator'])) {
        main.append(el('h2', { text: 'Safety reports' }), el('div', { class: 'panel' }, [table([
          ['When', function (x) { return fmtDT(x.created_at); }], ['From', function (x) { return (x.alias || '') + ' (' + x.telegram_user_id + ')'; }],
          ['Report', function (x) { return el('div', { class: 't-text', text: x.body }); }],
          ['Status', function (x) { return statusSelect(x.status, ['new', 'reviewing', 'actioned', 'dismissed'], function (v) { api('PATCH', '/api/admin/reports/' + x.id, { status: v }).then(function () { toast('Updated'); }).catch(fail); }, 'Status of safety report from ' + fmtDT(x.created_at)); }]
        ], r.reports, 'No reports.', { name: 'Safety reports', primary: 2 })]));
      }
    });
  };

  /* ---------- media ---------- */
  TABS.media = function () {
    return api('GET', '/api/admin/media').then(function (r) {
      var owner = ROLE === 'super_admin';
      var type = el('select', {}, ['photo', 'video', 'review'].map(function (t) { return el('option', { value: t, text: t }); }));
      var url = el('input', { type: 'url', placeholder: 'https://… (photo/video)' });
      var caption = el('input', { type: 'text', placeholder: 'Caption or review text' });
      var author = el('input', { type: 'text', placeholder: 'Author alias (reviews)' });
      var auth = el('input', { type: 'checkbox' });
      var form = el('form', { class: 'admin-form panel' }, [el('label', {}, ['Type', type]), el('label', {}, ['URL', url]), el('label', { class: 'wide' }, ['Caption / text', caption]), el('label', {}, ['Author', author]),
        owner ? el('label', { class: 'check wide' }, [auth, ' I (owner) authorise this item for public use']) : '',
        el('div', { class: 'wide' }, [el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Add media' })])]);
      form.addEventListener('submit', function (e) { e.preventDefault(); api('POST', '/api/admin/media', { type: type.value, url: url.value || null, caption: caption.value || null, author_alias: author.value || null, authorized_by_owner: owner && auth.checked, visible: false }).then(function () { toast('Added (hidden)'); TABS.media(); }).catch(fail); });
      function patch(m, body) { return function () { api('PATCH', '/api/admin/media/' + m.id, body).then(function () { TABS.media(); }).catch(fail); }; }
      clear(main).append(el('h1', { text: 'Media' }), el('p', { class: 'muted', text: 'Only owner-authorised items can be shown on the site. Nothing is shown when this list is empty.' }), form,
        el('div', { class: 'panel' }, [table([
          ['Type', function (m) { return m.type; }], ['Content', function (m) { return m.url ? el('a', { href: m.url, target: '_blank', rel: 'noopener', text: m.url }) : m.caption; }],
          ['Authorised', function (m) { return m.authorized_by_owner ? 'yes' : 'no'; }], ['Visible', function (m) { return m.visible ? 'yes' : 'no'; }],
          ['', function (m) { var what = m.type + ' ' + (m.caption || m.url || '').slice(0, 40); return el('div', { class: 'row-actions' }, [
            owner && !m.authorized_by_owner ? btn('Authorise', patch(m, { authorized_by_owner: true }), null, what) : '',
            owner && m.authorized_by_owner ? btn('Withdraw', patch(m, { authorized_by_owner: false }), null, what) : '',
            m.authorized_by_owner && !m.visible ? btn('Show', patch(m, { visible: true }), null, what) : '',
            m.visible ? btn('Hide', patch(m, { visible: false }), null, what) : ''
          ]); }]
        ], r.media, 'No media yet. Nothing is shown on the site.', { name: 'Media', primary: 1 })]));
    });
  };

  /* ---------- tiers ---------- */
  TABS.tiers = function () {
    return api('GET', '/api/admin/tiers').then(function (r) {
      var owner = ROLE === 'super_admin';
      clear(main).append(el('h1', { text: 'Membership tiers' }),
        el('p', { class: 'muted', text: 'Prices stay unset (“Announcing soon”) until the owner approves them. SuperProfile tiers show no price here — the price lives on SuperProfile. Only super_admin can edit.' }),
        el('div', {}, r.tiers.map(function (t) {
          var name = el('input', { type: 'text', value: t.name, disabled: !owner });
          var stars = el('input', { type: 'number', min: 1, max: 10000, value: t.stars_amount === null ? '' : t.stars_amount, placeholder: 'Not set', disabled: !owner });
          var chat = el('input', { type: 'text', value: t.telegram_chat_id === null ? '' : t.telegram_chat_id, placeholder: 'Uses TG_CHAT_ID env', disabled: !owner });
          var benefits = el('textarea', { rows: 3, disabled: !owner }); benefits.value = (t.benefits || []).join('\n');
          var active = el('input', { type: 'checkbox', disabled: !owner }); active.checked = t.active;
          var provider = el('select', { disabled: !owner }, [['telegram_stars', 'Telegram Stars (in Telegram)'], ['superprofile', 'SuperProfile (web checkout)']].map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === t.access_provider }); }));
          var spUrl = el('input', { type: 'url', value: t.superprofile_url || '', placeholder: 'https://superprofile.bio/…', disabled: !owner });
          var spRef = el('input', { type: 'text', value: t.superprofile_product_ref || '', placeholder: 'Product name/id as sent by the automation', disabled: !owner });
          var form = el('form', { class: 'admin-form panel' }, [el('h2', { class: 'wide', text: t.code }), el('label', {}, ['Name', name]), el('label', {}, ['Stars / 30 days', stars]),
            el('label', {}, ['Telegram chat id', chat]), el('label', { class: 'check' }, [active, ' Active']),
            el('label', {}, ['Sold via', provider]), el('label', {}, ['SuperProfile product URL', spUrl]), el('label', {}, ['SuperProfile product reference', spRef]),
            el('label', { class: 'wide' }, ['Benefits (one per line)', benefits]),
            owner ? el('div', { class: 'wide' }, [el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Save' })]) : '']);
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            api('PATCH', '/api/admin/tiers/' + t.id, { name: name.value, stars_amount: stars.value ? Number(stars.value) : null, telegram_chat_id: chat.value.trim() ? Number(chat.value) : null, active: active.checked, benefits: benefits.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
              access_provider: provider.value, superprofile_url: spUrl.value.trim() || null, superprofile_product_ref: spRef.value.trim() || null })
              .then(function () { toast('Saved'); }).catch(fail);
          });
          return form;
        })));
    });
  };


  /* ---------- insights ----------
     A metric is { available, value, reason?, note? }. Unavailable metrics render as "Unavailable"
     with the reason — never as 0. A real zero renders as 0. */
  var INSIGHT_DAYS = 30;
  function metricText(m, fmt) {
    if (!m || !m.available) return null;
    if (m.unit === '%') return m.value + '%';
    if (m.unit === 'paise') return rupees(m.value);
    if (m.unit === 'stars') return Number(m.value).toLocaleString('en-IN') + ' ⭐';
    return fmt ? fmt(m.value) : Number(m.value).toLocaleString('en-IN');
  }
  function tile(label, m) {
    var txt = metricText(m);
    var kids = [txt === null ? el('b', { class: 'none', text: 'Unavailable' }) : el('b', { text: txt }), el('span', { text: label })];
    var why = m && (m.available ? m.note : m.reason);
    if (m && m.available && m.unit === '%' && m.denominator) why = m.numerator + ' of ' + m.denominator + (why ? ' · ' + why : '');
    if (why) kids.push(el('small', { class: 'kpi-note', text: why }));
    return el('div', { class: 'kpi' + (txt === null ? ' kpi-na' : '') }, kids);
  }
  function unavailable(m) { return el('p', { class: 'na-note', text: 'Unavailable — ' + m.reason }); }
  function bars(rows, opts) {
    // Horizontal magnitude bars, single hue. Suppressed buckets show "<5", no bar.
    opts = opts || {};
    if (!rows.length) return el('p', { class: 'muted', text: opts.empty || 'None in this window (0).' });
    var max = Math.max.apply(null, rows.map(function (r) { return r.count || 0; }).concat([1]));
    return el('div', { class: 'hbars', role: 'table' }, rows.map(function (r) {
      var label = opts.label ? opts.label(r.label) : r.label;
      var val = r.suppressed ? '<5' : Number(r.count).toLocaleString('en-IN');
      return el('div', { class: 'hbar', role: 'row', title: label + ': ' + val }, [
        el('span', { class: 'hbar-l', role: 'cell', text: label }),
        el('span', { class: 'hbar-track', 'aria-hidden': 'true' }, [r.suppressed || !r.count ? null : el('span', { class: 'hbar-fill', style: 'width:' + Math.max(1, Math.round((r.count / max) * 100)) + '%' })]),
        el('span', { class: 'hbar-v', role: 'cell', text: val })
      ]);
    }));
  }
  function columns(data, key, label, since) {
    // Daily single-series columns over the whole window (days without rows are real zeros);
    // hover title per bar; table view follows.
    if (!data.length) return el('p', { class: 'muted', text: 'No days with data in this window (0).' });
    var byDay = {};
    data.forEach(function (r) { byDay[r.day] = r; });
    var rows = [];
    var istDay = function (t) { return new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10); };
    for (var t = new Date(since).getTime(); istDay(t) <= istDay(Date.now()); t += 864e5) {
      var d = istDay(t);
      var o = { day: d }; o[key] = byDay[d] ? byDay[d][key] : 0;
      rows.push(o);
    }
    var max = Math.max.apply(null, rows.map(function (r) { return r[key]; }).concat([1]));
    return el('div', {}, [
      el('div', { class: 'cols', role: 'img', 'aria-label': label + ' per day' }, rows.map(function (r) {
        return el('span', { class: 'col', title: r.day + ': ' + r[key] + ' ' + label.toLowerCase() }, [r[key] ? el('span', { class: 'col-fill', style: 'height:' + Math.max(2, Math.round((r[key] / max) * 100)) + '%' }) : null]);
      })),
      el('div', { class: 'cols-axis muted small' }, [el('span', { text: rows[0].day }), el('span', { text: rows[rows.length - 1].day })]),
      el('details', {}, [el('summary', { text: 'Table view' }), table([['Day', function (r) { return r.day; }], [label, function (r) { return r[key]; }]], data, null, { name: label + ' per day' })])
    ]);
  }
  function section(title, kids, note) {
    return el('div', { class: 'panel' }, [el('h2', { text: title })].concat(note ? [el('p', { class: 'muted', text: note })] : []).concat(kids));
  }
  function block(title, m, render) {
    return el('div', { class: 'subpanel' }, [el('h3', { text: title }), m.available ? render(m.value, m) : unavailable(m)].concat(m.available && m.note ? [el('p', { class: 'muted small', text: m.note })] : []));
  }
  var CAT_LABEL = { meetup: 'Meetup', dating_mixer: 'Dating mixer', nightlife: 'Nightlife', dinner_club: 'Dinner club', movie: 'Movie night', board_games: 'Board games', weekend_trip: 'Strangers trip', resort_getaway: 'Resort getaway', weekend_party: 'Weekend party', matchmaking: 'Matchmaking' };
  var HUMAN = { female: 'Woman', male: 'Man', non_binary: 'Non-binary', prefer_not_to_say: 'Prefer not to say', '21_24': '21–24', '25_29': '25–29', '30_34': '30–34', '35_39': '35–39', '40_plus': '40+' };
  function human(v) { return HUMAN[v] || CAT_LABEL[v] || String(v).replace(/_/g, ' '); }

  TABS.insights = function () {
    return api('GET', '/api/admin/insights?days=' + INSIGHT_DAYS).then(function (r) {
      var x = r.insights;
      var picker = el('div', { class: 'row-actions' }, [7, 30, 90, 365].map(function (d) {
        return el('button', { class: 'btn btn-sm ' + (d === x.windowDays ? 'btn-primary' : 'btn-ghost'), type: 'button', 'aria-pressed': d === x.windowDays ? 'true' : 'false', text: d === 365 ? '1 year' : d + ' days', onclick: function () { INSIGHT_DAYS = d; show('insights'); } });
      }));
      var t = x.traffic, g = x.registrations, b = x.bookings, v = x.revenue, c = x.conversions, m = x.membership, d = x.demographics, f = x.failures;
      clear(main).append(
        el('h1', { text: 'Insights' }),
        el('p', { class: 'muted', text: 'From this site’s own database only. “Unavailable” means we have no data source for it — it is not zero. Generated ' + fmtDT(x.generatedAt) + '.' }),
        picker,
        section('Visitors', [
          el('div', { class: 'kpis' }, [tile('Visitors', t.visitors), tile('Page views', t.pageViews), tile('Signups ÷ visitors', c.visitorToSignup)]),
          block('Daily visitors', t.daily, function (rows) { return columns(rows, 'visitors', 'Visitors', x.since); }),
          el('div', { class: 'two' }, [block('Top pages', t.topPaths, function (rows) { return bars(rows); }), block('Top sources (referrer host / utm_source)', t.topReferrers, function (rows) { return bars(rows, { empty: 'No external referrers in this window.' }); })])
        ], t.trackingSince ? 'First-party tracking since ' + fmtDT(t.trackingSince) + '.' : null),
        section('Registrations', [
          el('div', { class: 'kpis' }, [tile('Users (all time)', g.totalUsers), tile('New in window', g.newUsers), tile('Confirmed 21+', g.ageConfirmed), tile('Started the bot', g.botStarted), tile('Event alert subscribers', g.alertSubscribers), tile('Restricted accounts', g.restricted)]),
          block('Signups per day', g.daily, function (rows) { return columns(rows, 'count', 'Signups', x.since); })
        ]),
        section('Paid members', [
          el('h3', { text: 'Telegram Stars' }),
          el('div', { class: 'kpis' }, [tile('Active', m.stars.active), tile('New in window', m.stars.newInWindow), tile('Renewals in window', m.stars.renewalsInWindow), tile('Expiring ≤ 7 days', m.stars.expiring7d), tile('Revoked in window', m.stars.revokedInWindow), tile('Expired, removal pending', m.stars.expiredAwaitingRemoval)]),
          el('h3', { text: 'SuperProfile' }),
          el('div', { class: 'kpis' }, [tile('Active', m.superprofile.active), tile('New in window', m.superprofile.newInWindow), tile('Repeat purchases in window', m.superprofile.renewalsInWindow), tile('Expired in window', m.superprofile.expiredInWindow), tile('Abandoned checkouts', m.superprofile.abandonedInWindow), tile('Unmapped products', m.superprofile.unmappedProducts)])
        ], m.note),
        section('Revenue', [el('div', { class: 'kpis' }, [tile('Live ticket gross', v.liveTicketGross), tile('Live refunded', v.liveTicketRefunded), tile('Sandbox ticket gross', v.sandboxTicketGross), tile('Paid tickets', v.paidTickets), tile('Stars received', v.starsReceived), tile('SuperProfile (reported)', v.superprofile)])]),
        section('Bookings & conversions', [
          el('div', { class: 'kpis' }, [tile('Upcoming events (ours)', b.upcomingInternalEvents), tile('Upcoming external listings', b.upcomingExternalListings), tile('Upcoming sample events', b.upcomingSampleEvents), tile('Event view → Book click', c.eventViewToBookClick), tile('Booking started → confirmed', c.bookingStartToConfirmed), tile('Membership clicks', c.membershipClicks)]),
          el('div', { class: 'two' }, [
            block('Funnel', c.funnel, function (rows) { return bars(rows.map(function (s) { return { label: s.step, count: s.count }; })); }),
            block('Bookings by status (created in window)', b.byStatus, function (rows) { return bars(rows, { label: human }); })
          ]),
          block('Confirmed bookings by format', b.confirmedByCategory, function (rows) { return bars(rows, { label: human }); }),
          block('Upcoming event fill', b.upcomingFill, function (rows) {
            return table([['Event', function (e) { return e.title; }], ['Starts', function (e) { return fmtDT(e.start_at); }], ['Confirmed', function (e) { return e.confirmed + ' / ' + e.capacity; }], ['Live holds', function (e) { return e.holds; }]], rows, 'No upcoming events of ours (0).', { name: 'Upcoming event fill' });
          })
        ]),
        section('Audience (voluntary)', [el('div', { class: 'two' }, [
          block('Gender', d.gender, function (rows, mm) { return el('div', {}, [bars(rows, { label: human }), el('p', { class: 'muted small', text: mm.respondents + ' of ' + mm.of + ' users answered' })]); }),
          block('Age', d.ageBand, function (rows, mm) { return el('div', {}, [bars(rows, { label: human }), el('p', { class: 'muted small', text: mm.respondents + ' of ' + mm.of + ' users answered' })]); }),
          block('City', d.city, function (rows, mm) { return el('div', {}, [bars(rows), el('p', { class: 'muted small', text: mm.respondents + ' of ' + mm.of + ' users answered' })]); }),
          block('Interests', d.interests, function (rows, mm) { return el('div', {}, [bars(rows, { label: human }), el('p', { class: 'muted small', text: mm.respondents + ' of ' + mm.of + ' users answered' })]); })
        ])], d.note),
        section('Discovery feeds', [
          block('Feeds', x.discovery.feeds, function (rows) {
            return table([['Feed', function (q) { return q.name; }], ['Health', function (q) { return el('span', { class: 'pill pill-' + q.health, text: q.health.replace('_', ' ') }); }],
              ['Last fetch', function (q) { return fmtDT(q.last_fetched_at); }], ['Last success', function (q) { return fmtDT(q.last_success_at); }], ['Fails in a row', function (q) { return q.consecutive_failures; }],
              ['Items', function (q) { return q.last_item_count; }], ['Pending', function (q) { return q.pending; }], ['Error', function (q) { return q.last_error; }]], rows, 'No feeds added yet.', { name: 'Discovery feed health' });
          }),
          block('Moderation queue', x.discovery.queue, function (q) { return el('div', { class: 'kpis' }, [tile('Pending', { available: true, value: q.pending }), tile('Pending submissions', { available: true, value: q.pending_submissions }), tile('Pending without a date', { available: true, value: q.pending_without_date }), tile('Flagged duplicates', { available: true, value: q.duplicate })]); })
        ]),
        section('Failures', [
          el('div', { class: 'kpis' }, [tile('Overdue notifications', f.overdueNotifications), tile('Unprocessed webhooks (>10 min)', f.unprocessedWebhooks), tile('Refunds due', f.refundsDue)]),
          el('div', { class: 'two' }, [
            block('Failed payments by reason', f.failedPayments, function (rows) { return bars(rows); }),
            block('Failed Telegram notifications by kind', f.failedNotifications, function (rows) { return table([['Kind', function (q) { return q.label; }], ['Count', function (q) { return q.count; }], ['Latest error', function (q) { return q.sampleError; }]], rows, 'None in this window (0).', { name: 'Failed Telegram notifications' }); })
          ]),
          block('Integration errors', f.integrationErrors, function (rows) { return table([['Source', function (q) { return q.source; }], ['Kind', function (q) { return q.kind; }], ['Count', function (q) { return q.n; }], ['Last', function (q) { return fmtDT(q.last_at); }], ['Latest detail', function (q) { return q.last_detail; }]], rows, 'None in this window (0).', { name: 'Integration errors' }); })
        ]),
        section('Configuration (names only)', [el('ul', { class: 'config-list' }, Object.keys(x.config).map(function (key) { return el('li', {}, [el('strong', { text: key + ': ' }), String(x.config[key])]); }))])
      );
    });
  };

  /* ---------- discovery: feeds + moderation ---------- */
  var CAND_STATUS = 'pending';
  TABS.discovery = function () {
    return Promise.all([api('GET', '/api/admin/feeds'), api('GET', '/api/admin/candidates?status=' + CAND_STATUS)]).then(function (rs) {
      var ff = {};
      function fi(name, label, type, extra) { var i = el(type === 'select' ? 'select' : 'input', Object.assign({ name: name }, type === 'select' ? {} : { type: type }, extra || {})); ff[name] = i; return el('label', {}, [label, i]); }
      var catSel = fi('default_category', 'Default format (optional)', 'select');
      ff.default_category.appendChild(el('option', { value: '', text: '—' })); CATS.forEach(function (c) { ff.default_category.appendChild(el('option', { value: c, text: human(c) })); });
      var citySel = fi('default_city', 'Default city (optional)', 'select');
      ['', 'Chennai', 'Bengaluru', 'Coimbatore', 'Kochi', 'Puducherry'].forEach(function (c) { ff.default_city.appendChild(el('option', { value: c, text: c || '—' })); });
      var feedForm = el('form', { class: 'admin-form panel' }, [
        el('h2', { class: 'wide', text: 'Add a feed' }),
        el('p', { class: 'wide muted', text: 'Only add RSS/Atom feeds you are allowed to use (publisher permission or published terms). robots.txt is checked on every fetch. Items go to the queue below — nothing is published automatically.' }),
        fi('name', 'Name', 'text', { required: true }), fi('url', 'Feed URL (https)', 'url', { required: true }), fi('site_url', 'Publisher site (https, for attribution link)', 'url'),
        fi('attribution', 'Attribution shown on listings (e.g. publisher name)', 'text', { required: true }), catSel, citySel,
        el('label', { class: 'wide' }, ['Permission basis (required)', (ff.permission_basis = el('textarea', { name: 'permission_basis', rows: 2, required: true, placeholder: 'e.g. Email from the organiser on 2026-10-20 allowing us to list their public events with a link back.' }))]),
        el('div', { class: 'wide' }, [el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Add feed' })])
      ]);
      feedForm.addEventListener('submit', function (e) {
        e.preventDefault();
        api('POST', '/api/admin/feeds', { name: ff.name.value, url: ff.url.value, site_url: ff.site_url.value, attribution: ff.attribution.value, permission_basis: ff.permission_basis.value, default_category: ff.default_category.value, default_city: ff.default_city.value, active: true })
          .then(function () { toast('Feed added'); show('discovery'); }).catch(fail);
      });
      var feeds = rs[0].feeds;
      var feedTable = table([
        ['Feed', function (f) { return el('div', {}, [el('strong', { text: f.name }), el('div', { class: 'muted small', text: f.url })]); }],
        ['Status', function (f) { return (f.active ? '' : 'paused · ') + (f.last_status || 'never fetched') + (f.consecutive_failures ? ' (' + f.consecutive_failures + ' fails)' : ''); }],
        ['Last fetch', function (f) { return fmtDT(f.last_fetched_at); }], ['Last error', function (f) { return f.last_error; }],
        ['Permission', function (f) { return f.permission_basis; }],
        ['', function (f) {
          return el('div', { class: 'row-actions' }, [
            btn('Fetch now', function () { api('POST', '/api/admin/feeds/' + f.id + '/fetch', {}).then(function (r) { toast(r.result.status + ' · ' + r.result.new + ' new · ' + r.result.dup + ' duplicate'); show('discovery'); }).catch(fail); }, null, f.name),
            btn(f.active ? 'Pause' : 'Resume', function () {
              api('PATCH', '/api/admin/feeds/' + f.id, { name: f.name, url: f.url, site_url: f.site_url, attribution: f.attribution, permission_basis: f.permission_basis, default_category: f.default_category, default_city: f.default_city, active: !f.active }).then(function () { show('discovery'); }).catch(fail);
            }, null, f.name)
          ]);
        }]
      ], feeds, 'No feeds yet.', { name: 'Feeds' });

      var statusTabs = el('div', { class: 'row-actions' }, ['pending', 'duplicate', 'approved', 'rejected'].map(function (s) {
        return el('button', { class: 'btn btn-sm ' + (s === CAND_STATUS ? 'btn-primary' : 'btn-ghost'), type: 'button', text: s, onclick: function () { CAND_STATUS = s; show('discovery'); } });
      }));
      var cands = rs[1].candidates;
      var list = cands.length ? el('div', {}, cands.map(candidateCard)) : el('p', { class: 'muted', text: 'Nothing ' + CAND_STATUS + '.' });
      clear(main).append(el('h1', { text: 'Discovery' }), el('h2', { text: 'Moderation queue' }), statusTabs, list, el('h2', { text: 'Feeds' }), feedForm, el('div', { class: 'panel' }, [feedTable]));
    });
  };

  function candidateCard(c) {
    var source = c.origin === 'feed' ? 'Feed: ' + (c.feed_name || '?') : 'Submission' + (c.submitter_contact ? ' from ' + c.submitter_contact : '');
    var head = el('div', {}, [
      el('p', { class: 'muted small', text: source + ' · received ' + fmtDT(c.created_at) }),
      el('h3', { text: c.title }),
      c.summary ? el('p', { text: c.summary }) : null,
      el('p', { class: 'small' }, [
        'When: ', c.start_at ? fmtDT(c.start_at) : el('strong', { text: 'no event date in source — confirm on the source page' }),
        ' · City: ' + (c.city || '—') + ' · Venue: ' + (c.venue || '—'),
        c.link ? el('span', {}, [' · ', el('a', { href: c.link, target: '_blank', rel: 'noopener nofollow', text: 'Source page' })]) : ' · no https link'
      ]),
      c.duplicate_title ? el('p', { class: 'na-note', text: 'Possible duplicate of: ' + c.duplicate_title }) : null,
      c.review_note ? el('p', { class: 'muted small', text: 'Note: ' + c.review_note }) : null,
      c.event_slug ? el('p', { class: 'small' }, [el('a', { href: '/admin/preview/' + c.event_id, target: '_blank', text: 'Preview created event' })]) : null
    ]);
    if (c.status !== 'pending' && c.status !== 'duplicate') return el('div', { class: 'panel' }, [head]);
    var f = {};
    function inp(name, label, type, value, extra) {
      var i = el(type === 'select' ? 'select' : 'input', Object.assign({ name: name }, type === 'select' ? {} : { type: type }, extra || {}));
      if (type === 'select') (extra.options || []).forEach(function (o) { i.appendChild(el('option', { value: o[0], text: o[1], selected: o[0] === value })); });
      else if (type === 'checkbox') i.checked = Boolean(value); else i.value = value || '';
      f[name] = i;
      return el('label', { class: type === 'checkbox' ? 'check' : null }, type === 'checkbox' ? [i, ' ' + label] : [label, i]);
    }
    var form = el('form', { class: 'admin-form' }, [
      inp('mode', 'List as', 'select', c.link ? 'external' : 'internal', { options: [['external', 'External listing (book on organiser page)'], ['internal', 'Our own event (draft)']] }),
      inp('title', 'Title', 'text', c.title, { required: true }),
      inp('category', 'Format', 'select', c.category || 'meetup', { options: CATS.map(function (k) { return [k, human(k)]; }) }),
      inp('city', 'City', 'text', c.city, { required: true }),
      inp('start_at', 'Starts (IST) — verify on source', 'datetime-local', toLocalInput(c.start_at), { required: true }),
      inp('end_at', 'Ends (IST)', 'datetime-local', toLocalInput(c.end_at)),
      inp('venue', 'Venue (shown publicly for external)', 'text', c.venue),
      inp('external_url', 'Booking / details link (https)', 'url', c.link),
      inp('source_name', 'Attribute to', 'text', c.feed_attribution || c.organizer),
      inp('publish', 'Publish now (external only)', 'checkbox', false),
      el('div', { class: 'wide row-actions' }, [
        el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Approve' }),
        btn('Reject', function () { api('POST', '/api/admin/candidates/' + c.id + '/reject', { status: 'rejected' }).then(function () { toast('Rejected'); show('discovery'); }).catch(fail); }),
        c.status === 'pending' ? btn('Mark duplicate', function () { api('POST', '/api/admin/candidates/' + c.id + '/reject', { status: 'duplicate' }).then(function () { toast('Marked duplicate'); show('discovery'); }).catch(fail); }) : null
      ])
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      api('POST', '/api/admin/candidates/' + c.id + '/approve', {
        mode: f.mode.value, title: f.title.value, category: f.category.value, city: f.city.value, start_at: fromLocalInput(f.start_at.value), end_at: fromLocalInput(f.end_at.value),
        summary: c.summary ? c.summary.slice(0, 300) : null, venue: f.venue.value, external_url: f.external_url.value, source_name: f.source_name.value, publish: f.publish.checked
      }).then(function (r) { toast('Approved — event ' + r.event.status); show('discovery'); }).catch(fail);
    });
    return el('div', { class: 'panel' }, [head, form]);
  }

  /* ---------- integrations ---------- */
  TABS.integrations = function () {
    var calls = [api('GET', '/api/admin/integrations/telegram').catch(function (e) { return { error: e }; }), api('GET', '/api/admin/superprofile').catch(function (e) { return { error: e }; })];
    return Promise.all(calls).then(function (rs) {
      var out = [el('h1', { text: 'Integrations' })];
      var t = rs[0].telegram;
      if (rs[0].error) out.push(el('div', { class: 'panel' }, [el('h2', { text: 'Telegram' }), el('p', { text: (rs[0].error.message || 'Not available for your role') })]));
      else {
        var yes = function (v) { return v ? 'yes' : 'NO'; };
        var rows = [['Bot token set', yes(t.tokenConfigured)], ['Bot username set', yes(t.usernameConfigured)], ['Webhook secret set', yes(t.webhookSecretConfigured)], ['Telegram Login (OIDC) set', yes(t.loginOidcConfigured)], ['Test environment', t.testEnvironment ? 'yes' : 'no']];
        if (t.bot) rows.push(['getMe', t.bot.ok ? '@' + t.bot.username + (t.bot.usernameMatches ? '' : ' (does NOT match TELEGRAM_BOT_USERNAME)') : 'FAILED: ' + t.bot.error]);
        if (t.webhook) rows.push(['Webhook URL', t.webhook.ok ? (t.webhook.url || '(none set)') + (t.webhook.matchesThisDeployment ? ' ✓ this deployment' : ' — expected ' + t.expectedWebhook) : 'FAILED: ' + t.webhook.error]);
        if (t.webhook && t.webhook.ok) rows.push(['Pending updates', String(t.webhook.pendingUpdates)], ['Last webhook error', t.webhook.lastError ? fmtDT(t.webhook.lastErrorAt) + ' — ' + t.webhook.lastError : 'none']);
        out.push(el('div', { class: 'panel' }, [el('h2', { text: 'Telegram (live check)' }), t.available ? null : unavailable({ reason: t.reason }),
          table([['Check', function (r) { return r[0]; }], ['Result', function (r) { return r[1]; }]], rows, null, { name: 'Telegram checks' }),
          t.available ? el('h3', { text: 'Chats (bot must be admin with invite + ban rights)' }) : null,
          t.available ? table([['Chat', function (c) { return c.name; }], ['Id', function (c) { return c.chatId; }], ['Title', function (c) { return c.title; }],
            ['Bot status', function (c) { return c.skipped || c.botStatus || c.memberError || c.chatError || c.error; }], ['Invite', function (c) { return c.canInvite === null || c.canInvite === undefined ? '—' : yes(c.canInvite); }],
            ['Ban/remove', function (c) { return c.canRestrict === null || c.canRestrict === undefined ? '—' : yes(c.canRestrict); }], ['OK', function (c) { return c.skipped ? 'n/a' : yes(c.ok); }]], t.chats, null, { name: 'Telegram chats' }) : null]));
      }
      var s = rs[1];
      if (s.error) out.push(el('div', { class: 'panel' }, [el('h2', { text: 'SuperProfile' }), el('p', { text: s.error.message || 'Not available for your role' })]));
      else out.push(el('div', { class: 'panel' }, [
        el('h2', { text: 'SuperProfile' }),
        el('p', { text: s.configured ? 'Webhook secret is set. Point a Zapier/Pabbly “Webhook” step at ' + location.origin + s.webhookPath + ' with header X-Webhook-Secret.' : 'Not connected: SUPERPROFILE_WEBHOOK_SECRET is not set on this deployment.' }),
        el('p', { class: 'muted small', text: 'Map each SuperProfile product to a tier in “Membership tiers” (product reference). Buyer emails are stored only as keyed hashes.' }),
        table([['Received', function (e) { return fmtDT(e.received_at); }], ['Event', function (e) { return e.event_type; }], ['Product', function (e) { return e.product_ref; }], ['Tier', function (e) { return e.tier || 'unmapped'; }],
          ['Amount', function (e) { return e.amount_paise === null ? '—' : rupees(e.amount_paise); }], ['Email?', function (e) { return e.has_email ? 'hashed' : 'none'; }]], s.events, 'No SuperProfile events received.', { name: 'SuperProfile events' })
      ]));
      clear(main).append.apply(main, out);
    });
  };

  /* ---------- admins & audit ---------- */
  TABS.admins = function () {
    return Promise.all([api('GET', '/api/admin/admins'), api('GET', '/api/admin/audit')]).then(function (rs) {
      var tgid = el('input', { type: 'number', placeholder: 'Telegram user id', 'aria-label': 'Telegram user id', required: true });
      var role = el('select', { 'aria-label': 'Role' }, ['event_manager', 'moderator', 'finance', 'support', 'super_admin'].map(function (x) { return el('option', { value: x, text: x }); }));
      var form = el('form', { class: 'row-actions panel' }, [tgid, role, el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Add / update admin' })]);
      form.addEventListener('submit', function (e) { e.preventDefault(); api('POST', '/api/admin/admins', { telegram_user_id: Number(tgid.value), role: role.value, active: true }).then(function () { toast('Saved'); TABS.admins(); }).catch(fail); });
      clear(main).append(el('h1', { text: 'Admins' }), form, el('div', { class: 'panel' }, [table([
        ['Telegram id', function (a) { return a.telegram_user_id; }], ['Role', function (a) { return a.role; }], ['Active', function (a) { return a.active ? 'yes' : 'no'; }],
        ['', function (a) { return a.active ? btn('Deactivate', function () { api('POST', '/api/admin/admins', { telegram_user_id: a.telegram_user_id, role: a.role, active: false }).then(function () { TABS.admins(); }).catch(fail); }, null, 'admin ' + a.telegram_user_id) : ''; }]
      ], rs[0].admins, 'No admins.', { name: 'Admins' })]), el('h2', { text: 'Audit log' }), el('div', { class: 'panel' }, [table([
        ['When', function (x) { return fmtDT(x.at); }], ['Actor', function (x) { return x.actor; }], ['Action', function (x) { return x.action; }], ['Target', function (x) { return x.target; }],
        ['Details', function (x) { return el('code', { class: 't-code', text: JSON.stringify(x.details) }); }]
      ], rs[1].audit, 'No audit entries yet.', { name: 'Audit log', primary: 2 })]));
    });
  };

  window.addEventListener('hashchange', function () { var t = location.hash.slice(1); if (TABS[t]) show(t, { focus: true }); });
  var initial = (location.hash || '#overview').slice(1);
  show(TABS[initial] ? initial : 'overview');
})();
