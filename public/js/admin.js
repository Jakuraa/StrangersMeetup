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
    var t = el('div', { class: 'toast' + (err ? ' err' : ''), role: 'status', text: msg });
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
  function table(cols, rows, empty) {
    if (!rows.length) return el('p', { class: 'muted', text: empty || 'No data yet.' });
    return el('table', { class: 't' }, [
      el('thead', {}, [el('tr', {}, cols.map(function (c) { return el('th', { text: c[0] }); }))]),
      el('tbody', {}, rows.map(function (r) { return el('tr', {}, cols.map(function (c) { var v = c[1](r); return el('td', {}, [v instanceof Node ? v : String(v === null || v === undefined ? '—' : v)]); })); }))
    ]);
  }
  function btn(label, fn, cls) { return el('button', { class: 'btn btn-sm ' + (cls || 'btn-ghost'), type: 'button', onclick: fn, text: label }); }
  function can(roles) { return roles.indexOf(ROLE) !== -1; }

  /* ---------- tabs ---------- */
  var TABS = {};
  function show(name) {
    document.querySelectorAll('[data-tab]').forEach(function (b) { if (b.getAttribute('data-tab') === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    clear(main).appendChild(el('p', { class: 'muted', text: 'Loading…' }));
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* ignore */ }
    TABS[name]().catch(function (e) { clear(main).appendChild(el('p', { text: (e && e.message) || 'You do not have access to this section.' })); });
  }
  document.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { show(b.getAttribute('data-tab')); }); });

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
        var zero = !Number(i[1]);
        return el('div', { class: 'kpi' }, [el('b', { class: zero ? 'none' : null, text: zero ? 'No data yet' : (i[2] ? i[2](i[1]) : Number(i[1]).toLocaleString('en-IN')) }), el('span', { text: i[0] })]);
      })), el('div', { class: 'panel' }, [el('h2', { text: 'Configuration' }), el('ul', { class: 'config-list' }, Object.keys(r.config).map(function (key) {
        return el('li', {}, [el('strong', { text: key + ': ' }), String(r.config[key])]);
      }))]));
    });
  };

  /* ---------- events ---------- */
  var CATS = ['meetup', 'dating_mixer', 'nightlife', 'dinner_club', 'movie', 'board_games', 'weekend_trip', 'resort_getaway'];
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

  function attendeesPanel(ev) {
    return api('GET', '/api/admin/events/' + ev.id + '/attendees').then(function (r) {
      return el('div', { class: 'panel' }, [el('h2', { text: 'Check-in — ' + ev.title }), table([
        ['Name', function (a) { return a.alias; }], ['Ref', function (a) { return a.ref; }], ['Status', function (a) { return a.status; }],
        ['', function (a) { return a.status === 'confirmed' && can(['super_admin', 'event_manager', 'support']) ? btn('Check in', function () { api('POST', '/api/admin/bookings/' + a.id + '/check-in', {}).then(function () { toast('Checked in'); TABS.events(); }).catch(fail); }) : ''; }]
      ], r.attendees, 'No confirmed attendees yet.')]);
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
          ['Title', function (e) { return el('span', {}, [e.title, e.is_demo ? el('span', { class: 'pill', text: ' Sample' }) : '']); }],
          ['City', function (e) { return e.city; }], ['Status', function (e) { return e.status; }],
          ['Price', function (e) { return e.price_status === 'set' ? rupees(e.ticket_price_paise) : 'TBD'; }],
          ['Booked', function (e) { return e.confirmed + ' / ' + e.capacity; }],
          ['', function (e) {
            return el('div', { class: 'row-actions' }, [
              el('a', { class: 'btn btn-sm btn-ghost', href: '/admin/preview/' + e.id, target: '_blank', rel: 'noopener', text: 'Preview' }),
              btn('Attendees', function () { attendeesPanel(e).then(function (p) { clear(holder).appendChild(p); }).catch(fail); }),
              writer ? btn('Edit', function () { api('GET', '/api/admin/events/' + e.id).then(function (x) { clear(holder).appendChild(eventForm(x.event, TABS.events)); window.scrollTo(0, 0); }).catch(fail); }) : '',
              writer && e.status !== 'published' && e.status !== 'cancelled' ? btn('Publish', status(e, 'published')) : '',
              writer && e.status === 'published' ? btn('Unpublish', status(e, 'draft')) : '',
              writer && e.status !== 'cancelled' ? btn('Cancel', status(e, 'cancelled')) : '',
              writer && e.status !== 'archived' ? btn('Archive', status(e, 'archived')) : ''
            ]);
          }]
        ], r.events, 'No events yet. Create the first real event.')]));
    });
  };

  /* ---------- bookings & payments ---------- */
  TABS.bookings = function (filter) {
    var q = filter ? '?status=' + encodeURIComponent(filter) : '';
    return api('GET', '/api/admin/bookings' + q).then(function (r) {
      var finance = can(['super_admin', 'finance']);
      var sel = el('select', { onchange: function () { TABS.bookings(sel.value); } }, ['', 'pending_payment', 'confirmed', 'checked_in', 'cancelled', 'refunded', 'refund_due'].map(function (s) { return el('option', { value: s, text: s || 'All', selected: s === (filter || '') }); }));
      function refund(pid) { return function () { if (!confirm('Issue a full refund for this payment?')) return; api('POST', '/api/admin/payments/' + pid + '/refund', {}).then(function () { toast('Refund issued'); TABS.bookings(filter); }).catch(fail); }; }
      clear(main).append(el('h1', { text: 'Bookings & payments' }), el('p', {}, [el('label', {}, ['Filter ', sel])]),
        el('div', { class: 'panel' }, [table([
          ['Created', function (b) { return fmtDT(b.created_at); }], ['Event', function (b) { return b.title; }], ['Member', function (b) { return b.alias; }],
          ['Booking', function (b) { return b.status + (b.cancel_reason ? ' (' + b.cancel_reason + ')' : ''); }],
          ['Payment', function (b) { return b.payment_id ? b.provider + ' · ' + b.payment_status + (b.is_test ? ' · test' : '') : '—'; }],
          ['Provider txn', function (b) { return b.provider_txn_id || '—'; }], ['Amount', function (b) { return rupees(b.amount); }],
          ['', function (b) { return finance && b.payment_status === 'paid' ? btn('Refund', refund(b.payment_id)) : ''; }]
        ], r.bookings)]),
        el('h2', { text: 'Membership payments (Stars)' }),
        el('div', { class: 'panel' }, [table([
          ['When', function (p) { return fmtDT(p.created_at); }], ['Member', function (p) { return p.alias; }], ['Charge id', function (p) { return p.provider_txn_id; }],
          ['Stars', function (p) { return p.amount; }], ['Status', function (p) { return p.payment_status + (p.is_test ? ' · test' : ''); }],
          ['', function (p) { return finance && p.payment_status === 'paid' ? btn('Refund', refund(p.payment_id)) : ''; }]
        ], r.membershipPayments)]));
    });
  };

  /* ---------- memberships ---------- */
  TABS.memberships = function (q) {
    return api('GET', '/api/admin/memberships' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (r) {
      var search = el('input', { type: 'search', placeholder: 'Telegram id or name', value: q || '' });
      var form = el('form', { class: 'row-actions' }, [search, el('button', { class: 'btn btn-sm btn-ghost', type: 'submit', text: 'Search' })]);
      form.addEventListener('submit', function (e) { e.preventDefault(); TABS.memberships(search.value); });
      clear(main).append(el('h1', { text: 'Memberships' }), form, el('div', { class: 'panel' }, [table([
        ['Member', function (m) { return m.alias; }], ['Telegram id', function (m) { return m.telegram_user_id; }], ['Tier', function (m) { return m.tier; }],
        ['Status', function (m) { return m.status; }], ['Expires', function (m) { return fmtDT(m.expires_at); }],
        ['', function (m) { return can(['super_admin', 'moderator']) && ['active', 'grace', 'cancelled', 'expired'].indexOf(m.status) !== -1 ? btn('Revoke', function () { if (!confirm('Remove this member from the tier group now?')) return; api('POST', '/api/admin/entitlements/' + m.id + '/revoke', {}).then(function () { toast('Revoked'); TABS.memberships(q); }).catch(fail); }) : ''; }]
      ], r.memberships)]));
    });
  };

  /* ---------- leads & reports ---------- */
  function statusSelect(current, options, onChange) {
    var s = el('select', { onchange: function () { onChange(s.value); } }, options.map(function (o) { return el('option', { value: o, text: o, selected: o === current }); }));
    return s;
  }
  TABS.leads = function () {
    return api('GET', '/api/admin/leads').then(function (r) {
      clear(main).append(el('h1', { text: 'Leads' }), el('div', { class: 'panel' }, [table([
        ['When', function (l) { return fmtDT(l.created_at); }], ['Type', function (l) { return l.type; }],
        ['Details', function (l) { return el('div', {}, Object.keys(l.payload).map(function (k) { return el('div', {}, [el('strong', { text: k + ': ' }), String(l.payload[k])]); })); }],
        ['Status', function (l) { return statusSelect(l.status, ['new', 'contacted', 'closed', 'spam'], function (v) { api('PATCH', '/api/admin/leads/' + l.id, { status: v }).then(function () { toast('Updated'); }).catch(fail); }); }]
      ], r.leads)]));
      if (can(['super_admin', 'moderator'])) {
        main.append(el('h2', { text: 'Safety reports' }), el('div', { class: 'panel' }, [table([
          ['When', function (x) { return fmtDT(x.created_at); }], ['From', function (x) { return (x.alias || '') + ' (' + x.telegram_user_id + ')'; }],
          ['Report', function (x) { return x.body; }],
          ['Status', function (x) { return statusSelect(x.status, ['new', 'reviewing', 'actioned', 'dismissed'], function (v) { api('PATCH', '/api/admin/reports/' + x.id, { status: v }).then(function () { toast('Updated'); }).catch(fail); }); }]
        ], r.reports, 'No reports.')]));
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
          ['', function (m) { return el('div', { class: 'row-actions' }, [
            owner && !m.authorized_by_owner ? btn('Authorise', patch(m, { authorized_by_owner: true })) : '',
            owner && m.authorized_by_owner ? btn('Withdraw', patch(m, { authorized_by_owner: false })) : '',
            m.authorized_by_owner && !m.visible ? btn('Show', patch(m, { visible: true })) : '',
            m.visible ? btn('Hide', patch(m, { visible: false })) : ''
          ]); }]
        ], r.media)]));
    });
  };

  /* ---------- tiers ---------- */
  TABS.tiers = function () {
    return api('GET', '/api/admin/tiers').then(function (r) {
      var owner = ROLE === 'super_admin';
      clear(main).append(el('h1', { text: 'Membership tiers' }),
        el('p', { class: 'muted', text: 'Stars amounts stay empty (“Announcing soon”) until the owner sets them. Only super_admin can edit.' }),
        el('div', {}, r.tiers.map(function (t) {
          var name = el('input', { type: 'text', value: t.name, disabled: !owner });
          var stars = el('input', { type: 'number', min: 1, max: 10000, value: t.stars_amount === null ? '' : t.stars_amount, placeholder: 'Not set', disabled: !owner });
          var chat = el('input', { type: 'text', value: t.telegram_chat_id === null ? '' : t.telegram_chat_id, placeholder: 'Uses TG_CHAT_ID env', disabled: !owner });
          var benefits = el('textarea', { rows: 3, disabled: !owner }); benefits.value = (t.benefits || []).join('\n');
          var active = el('input', { type: 'checkbox', disabled: !owner }); active.checked = t.active;
          var form = el('form', { class: 'admin-form panel' }, [el('h2', { class: 'wide', text: t.code }), el('label', {}, ['Name', name]), el('label', {}, ['Stars / 30 days', stars]),
            el('label', {}, ['Telegram chat id', chat]), el('label', { class: 'check' }, [active, ' Active']), el('label', { class: 'wide' }, ['Benefits (one per line)', benefits]),
            owner ? el('div', { class: 'wide' }, [el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Save' })]) : '']);
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            api('PATCH', '/api/admin/tiers/' + t.id, { name: name.value, stars_amount: stars.value ? Number(stars.value) : null, telegram_chat_id: chat.value.trim() ? Number(chat.value) : null, active: active.checked, benefits: benefits.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) })
              .then(function () { toast('Saved'); }).catch(fail);
          });
          return form;
        })));
    });
  };

  /* ---------- admins & audit ---------- */
  TABS.admins = function () {
    return Promise.all([api('GET', '/api/admin/admins'), api('GET', '/api/admin/audit')]).then(function (rs) {
      var tgid = el('input', { type: 'number', placeholder: 'Telegram user id', required: true });
      var role = el('select', {}, ['event_manager', 'moderator', 'finance', 'support', 'super_admin'].map(function (x) { return el('option', { value: x, text: x }); }));
      var form = el('form', { class: 'row-actions panel' }, [tgid, role, el('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Add / update admin' })]);
      form.addEventListener('submit', function (e) { e.preventDefault(); api('POST', '/api/admin/admins', { telegram_user_id: Number(tgid.value), role: role.value, active: true }).then(function () { toast('Saved'); TABS.admins(); }).catch(fail); });
      clear(main).append(el('h1', { text: 'Admins' }), form, el('div', { class: 'panel' }, [table([
        ['Telegram id', function (a) { return a.telegram_user_id; }], ['Role', function (a) { return a.role; }], ['Active', function (a) { return a.active ? 'yes' : 'no'; }],
        ['', function (a) { return a.active ? btn('Deactivate', function () { api('POST', '/api/admin/admins', { telegram_user_id: a.telegram_user_id, role: a.role, active: false }).then(function () { TABS.admins(); }).catch(fail); }) : ''; }]
      ], rs[0].admins)]), el('h2', { text: 'Audit log' }), el('div', { class: 'panel' }, [table([
        ['When', function (x) { return fmtDT(x.at); }], ['Actor', function (x) { return x.actor; }], ['Action', function (x) { return x.action; }], ['Target', function (x) { return x.target; }],
        ['Details', function (x) { return JSON.stringify(x.details); }]
      ], rs[1].audit)]));
    });
  };

  window.addEventListener('hashchange', function () { var t = location.hash.slice(1); if (TABS[t]) show(t); });
  var initial = (location.hash || '#overview').slice(1);
  show(TABS[initial] ? initial : 'overview');
})();
