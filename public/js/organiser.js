/* StrangersMeetup organiser tools: event wizard (Basics → Tickets → Features → Preview), dashboard
   and guest management. Drafts are saved to the server (versioned); a copy of unsaved edits is
   kept in this browser only as a safety net and reconciled with the server copy on load.
   Every value interpolated into HTML goes through esc(). */
(function () {
  'use strict';
  var root = document.querySelector('.org');
  if (!root) return;
  var CSRF = root.getAttribute('data-csrf') || '';

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"'`]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]; }); }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function store(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null');
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { return null; }
    return null;
  }
  function api(method, path, body, raw) {
    var headers = { 'Accept': 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = CSRF;
    var payload;
    if (raw) { payload = raw.blob; headers['Content-Type'] = raw.type; } else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    return fetch(path, { method: method, headers: headers, credentials: 'same-origin', body: payload })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); })
      .catch(function () { return { ok: false, status: 0, error: 'network', message: 'You appear to be offline.' }; });
  }
  function money(paise) { return paise === 0 ? 'Free' : '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function ago(iso) {
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  function fmtInstant(iso) {
    try { return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); } catch (e) { return iso; }
  }
  /* A local 'YYYY-MM-DDTHH:mm' is already in the event's timezone: format it as-is. */
  function fmtLocal(local, withTime) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local || '')) return '';
    var d = new Date(local + ':00Z');
    var o = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' };
    if (withTime !== false) { o.hour = 'numeric'; o.minute = '2-digit'; }
    return d.toLocaleString('en-IN', o);
  }
  function dayLabel(d) { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  function datesBetween(a, b, max) {
    var out = [];
    if (!/^\d{4}-\d{2}-\d{2}/.test(a || '')) return out;
    var d = new Date(a.slice(0, 10) + 'T00:00:00Z');
    var end = new Date((/^\d{4}-\d{2}-\d{2}/.test(b || '') ? b : a).slice(0, 10) + 'T00:00:00Z');
    while (d <= end && out.length < (max || 31)) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 864e5); }
    return out;
  }
  function copyText(text, btn) {
    var done = function () { if (btn) { var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1600); } };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy this link', text); });
    else window.prompt('Copy this link', text);
  }
  function share(title, url, btn) {
    if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () { /* dismissed */ }); return; }
    window.open('https://wa.me/?text=' + encodeURIComponent(title + ' ' + url), '_blank', 'noopener');
    if (btn) btn.blur();
  }
  function absolute(path) { return location.origin + path; }

  var STATUS = { pending_approval: 'Awaiting your approval', pending_payment: 'Approved — awaiting payment', confirmed: 'Confirmed', checked_in: 'Checked in', declined: 'Declined' };
  var PAY = { not_required: 'No payment needed', unpaid: 'Unpaid', created: 'Awaiting payment confirmation', paid: 'Paid', failed: 'Payment failed', refunded: 'Refunded' };

  /* =====================================================================================
     Dashboard
     ===================================================================================== */
  function initDashboard(el) {
    api('GET', '/api/organiser/context').then(function (r) {
      if (!r.ok) { el.innerHTML = '<p class="form-msg error">' + esc(r.message || 'Could not load your events.') + '</p>'; return; }
      var h = '<p><a class="btn btn-primary" href="/organiser/new?fresh=1">Create an event</a></p>';
      if (!r.checkout.available) h += '<p class="notice">' + esc(r.checkout.message) + '</p>';
      h += '<h2 class="org-h2">Drafts</h2>';
      h += r.drafts.length ? '<ul class="org-list">' + r.drafts.map(function (d) {
        return '<li class="org-item"><div><p class="org-item-title">' + esc(d.data.title || 'Untitled draft') + '</p><p class="muted">Edited ' + esc(ago(d.updatedAt)) + '</p></div>' +
          '<div class="org-item-actions"><a class="btn btn-sm btn-primary" href="/organiser/new?draft=' + esc(d.id) + '">Continue</a>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-discard="' + esc(d.id) + '" data-title="' + esc(d.data.title || 'Untitled draft') + '">Discard</button></div></li>';
      }).join('') + '</ul>' : '<p class="muted">No unfinished drafts.</p>';
      h += '<h2 class="org-h2">Published events</h2>';
      h += r.events.length ? '<ul class="org-list">' + r.events.map(function (e) {
        return '<li class="org-item"><div><p class="org-item-title">' + esc(e.title) + '</p><p class="muted">' + esc(fmtInstant(e.startAt)) + ' · ' + esc(e.city) + ' · ' + esc(e.status) +
          ' · ' + esc(e.confirmed) + '/' + esc(e.capacity) + ' booked' + (e.requests ? ' · <strong>' + esc(e.requests) + ' request' + (e.requests === 1 ? '' : 's') + '</strong>' : '') + '</p></div>' +
          '<div class="org-item-actions"><a class="btn btn-sm btn-primary" href="' + esc(e.manageUrl) + '">Manage</a><a class="btn btn-sm btn-ghost" href="' + esc(e.path) + '">View</a>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-copy="' + esc(absolute(e.path)) + '">Copy link</button></div></li>';
      }).join('') + '</ul>' : '<p class="muted">Nothing published yet.</p>';
      el.innerHTML = h;
    });
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-copy')) copyText(b.getAttribute('data-copy'), b);
      if (b.hasAttribute('data-discard')) {
        if (!window.confirm('Discard “' + b.getAttribute('data-title') + '”? This cannot be undone.')) return;
        api('DELETE', '/api/organiser/drafts/' + encodeURIComponent(b.getAttribute('data-discard'))).then(function () { store('sm_wz_' + b.getAttribute('data-discard'), null); initDashboard(el); });
      }
    });
  }

  /* =====================================================================================
     Manage one event: guests, requests, answers
     ===================================================================================== */
  function initManage(el) {
    var id = el.getAttribute('data-org-manage');
    function load() {
      api('GET', '/api/organiser/events/' + encodeURIComponent(id) + '/guests').then(function (r) {
        if (!r.ok) { el.innerHTML = '<p class="form-msg error">' + esc(r.message || 'Could not load this event.') + '</p>'; return; }
        var e = r.event;
        var url = absolute(e.path);
        var seats = 0, reqs = 0;
        r.guests.forEach(function (g) { if (g.status === 'confirmed' || g.status === 'checked_in') seats += g.quantity; if (g.status === 'pending_approval') reqs++; });
        var h = '<p class="eyebrow">Manage event</p><h1 class="org-title">' + esc(e.title) + '</h1>' +
          '<p class="muted">' + esc(fmtInstant(e.startAt)) + ' · ' + esc(e.status) + '</p>' +
          '<div class="share-row"><input class="share-url" readonly value="' + esc(url) + '" aria-label="Public link">' +
          '<button class="btn btn-sm btn-ghost" type="button" data-copy="' + esc(url) + '">Copy link</button>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-share="' + esc(url) + '" data-title="' + esc(e.title) + '">Share</button>' +
          '<a class="btn btn-sm btn-ghost" href="' + esc(e.path) + '">View page</a></div>' +
          '<p><strong>' + seats + '</strong> of ' + esc(e.capacity) + ' tickets confirmed' + (e.requiresApproval ? ' · <strong>' + reqs + '</strong> waiting for approval' : '') + '</p>';
        if (!r.guests.length) h += '<p class="muted">No bookings yet. Share your link to get started.</p>';
        else h += '<ul class="guest-list">' + r.guests.map(function (g) {
          var answers = r.questions.filter(function (q) { return g.answers[q.id] != null; }).map(function (q) {
            var v = g.answers[q.id];
            return '<div><dt>' + esc(q.label) + '</dt><dd>' + esc(Array.isArray(v) ? v.join(', ') : v) + '</dd></div>';
          }).join('');
          return '<li class="guest"><div class="guest-head"><p class="org-item-title">' + esc(g.alias) + ' <span class="muted">#' + esc(g.ref) + '</span></p>' +
            '<span class="pill pill-' + esc(g.status) + '">' + esc(STATUS[g.status] || g.status) + '</span></div>' +
            '<p class="muted">' + esc(g.ticket || 'Ticket') + ' × ' + esc(g.quantity) + ' · ' + esc(PAY[g.paymentStatus] || g.paymentStatus) + (g.pickup ? ' · Pickup: ' + esc(g.pickup) : '') + ' · Requested ' + esc(ago(g.createdAt)) + '</p>' +
            (answers ? '<dl class="answers">' + answers + '</dl>' : '') +
            (g.status === 'pending_approval' ? '<div class="org-item-actions"><button class="btn btn-sm btn-primary" type="button" data-decide="approve" data-id="' + esc(g.id) + '">Approve</button>' +
              '<button class="btn btn-sm btn-ghost" type="button" data-decide="decline" data-id="' + esc(g.id) + '" data-name="' + esc(g.alias) + '">Decline</button></div>' : '') +
            '</li>';
        }).join('') + '</ul>';
        h += '<p class="form-msg" data-manage-msg role="status" aria-live="polite"></p><p><a class="link-arrow" href="/organiser">All your events</a></p>';
        el.innerHTML = h;
      });
    }
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-copy')) return copyText(b.getAttribute('data-copy'), b);
      if (b.hasAttribute('data-share')) return share(b.getAttribute('data-title'), b.getAttribute('data-share'), b);
      var d = b.getAttribute('data-decide');
      if (!d) return;
      if (d === 'decline' && !window.confirm('Decline ' + b.getAttribute('data-name') + '’s request? They will be told it wasn’t accepted.')) return;
      b.disabled = true;
      api('POST', '/api/organiser/bookings/' + encodeURIComponent(b.getAttribute('data-id')) + '/' + d, {}).then(function (r) {
        if (!r.ok) { var m = $('[data-manage-msg]', el); m.className = 'form-msg error'; m.textContent = r.message || 'That didn’t work.'; b.disabled = false; return; }
        load();
      });
    });
    load();
  }

  /* =====================================================================================
     Wizard
     ===================================================================================== */
  function initWizard(el) {
    var CFG = JSON.parse(($('#wz-config') || {}).textContent || '{}');
    var STEPS = [['basics', 'Basics'], ['tickets', 'Tickets'], ['features', 'Features'], ['preview', 'Preview']];
    var TZ = {}; CFG.timezones.forEach(function (t) { TZ[t[0]] = t[1]; });
    var CAT = {}; CFG.categories.forEach(function (c) { CAT[c[0]] = c[1]; });
    var S = {
      draft: null, data: null, version: 0, step: 'basics', dirty: false, saving: false, again: false, status: 'idle', statusMsg: '',
      issues: [], touched: {}, shown: {}, conflict: null, published: null, uploading: '', choosingTemplate: false, flash: ''
    };
    var params = new URLSearchParams(location.search);
    var saveTimer = null, retryTimer = null;

    function localKey() { return 'sm_wz_' + S.draft.id; }
    function backup() { if (S.draft) store(localKey(), { v: S.version, data: S.data, step: S.step, at: Date.now() }); }
    function meaningful(d) {
      return Boolean(d && ((d.title || '').trim() || (d.description || '').trim() || (d.venue || '').trim() || d.startLocal || d.coverImageId));
    }

    /* ---------- paths ---------- */
    function getPath(obj, path) { return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj); }
    function setPath(obj, path, v) {
      var ks = path.split('.');
      var o = obj;
      for (var i = 0; i < ks.length - 1; i++) {
        if (o[ks[i]] == null) o[ks[i]] = /^\d+$/.test(ks[i + 1]) ? [] : {};
        o = o[ks[i]];
      }
      o[ks[ks.length - 1]] = v;
    }
    function feat(name) { S.data.features = S.data.features || {}; S.data.features[name] = S.data.features[name] || {}; return S.data.features[name]; }

    /* ---------- saving ---------- */
    function setStatus(st, msg) {
      S.status = st; S.statusMsg = msg || '';
      var chip = $('[data-save-status]', el);
      if (!chip) return;
      var text = { idle: '', saving: 'Saving…', saved: 'All changes saved', error: 'Couldn’t save', offline: 'Offline — changes kept on this device', conflict: 'Changed elsewhere — choose a version' }[st];
      chip.className = 'wz-status wz-status-' + st;
      chip.innerHTML = esc(text) + (S.statusMsg ? ' — ' + esc(S.statusMsg) : '') + (st === 'error' || st === 'offline' ? ' <button class="linkish" type="button" data-act="retry-save">Retry</button>' : '');
    }
    function touch() { S.dirty = true; backup(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 900); }
    function save() {
      clearTimeout(saveTimer);
      if (!S.draft || !S.dirty || S.conflict) return Promise.resolve(true);
      if (S.saving) { S.again = true; return S.saving; }
      setStatus('saving');
      var snapshot = JSON.stringify(S.data);
      S.saving = api('PUT', '/api/organiser/drafts/' + encodeURIComponent(S.draft.id), { data: S.data, step: S.step, version: S.version }).then(function (r) {
        S.saving = false;
        if (r.ok) {
          S.version = r.draft.version;
          S.issues = r.draft.issues || [];
          S.issuesData = JSON.parse(snapshot);
          if (JSON.stringify(S.data) === snapshot) { S.dirty = false; store(localKey(), null); } else backup();
          setStatus('saved');
          showErrors();
          if (S.again) { S.again = false; return save(); }
          return true;
        }
        if (r.status === 409 && r.error === 'version_conflict') { S.conflict = r.draft; setStatus('conflict'); render(); return false; }
        if (r.status === 0 || r.status >= 500) {
          setStatus('offline');
          clearTimeout(retryTimer); retryTimer = setTimeout(save, 8000);
          return false;
        }
        setStatus('error', r.message || '');
        return false;
      });
      return S.saving;
    }
    window.addEventListener('online', function () { if (S.dirty) save(); });
    window.addEventListener('beforeunload', function (e) { if (S.dirty) { backup(); e.preventDefault(); e.returnValue = ''; } });

    /* ---------- errors ---------- */
    // Issues come from the server's check of the last saved data. A field edited since then is not
    // flagged with its old issue: showing it would be wrong and would shift the layout mid-tap.
    function edited(path) {
      return Boolean(S.issuesData && path) && JSON.stringify(getPath(S.data, path)) !== JSON.stringify(getPath(S.issuesData, path));
    }
    function issueFor(path) {
      for (var i = 0; i < S.issues.length; i++) if (S.issues[i].field === path && S.issues[i].severity === 'error' && !edited(path)) return S.issues[i];
      return null;
    }
    function showErrors() {
      $$('[data-err-for]', el).forEach(function (p) {
        var path = p.getAttribute('data-err-for');
        var iss = issueFor(path);
        var show = iss && (S.touched[path] || S.shown[S.step]);
        p.textContent = show ? iss.message : '';
        var input = $('[data-path="' + path + '"]', el);
        if (input) { if (show) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
      });
      var sum = $('[data-step-summary]', el);
      if (sum) {
        var n = S.issues.filter(function (i) { return i.step === S.step && i.severity === 'error' && !edited(i.field); }).length;
        sum.textContent = S.shown[S.step] && n ? n + ' thing' + (n === 1 ? '' : 's') + ' to finish here before you can publish. You can keep going and come back.' : '';
      }
    }
    function errId(path) { return 'err-' + path.replace(/[^A-Za-z0-9]/g, '-'); }
    function errSlot(path) { return '<p class="fld-err" id="' + errId(path) + '" data-err-for="' + esc(path) + '" aria-live="polite"></p>'; }

    /* ---------- field builders ---------- */
    function attrs(path, kind) { return ' data-path="' + esc(path) + '"' + (kind ? ' data-kind="' + kind + '"' : '') + ' aria-describedby="' + errId(path) + '"'; }
    function text(path, label, o) {
      o = o || {};
      var v = getPath(S.data, path);
      var id = 'f-' + path.replace(/\W/g, '-');
      return '<div class="fld"><label for="' + id + '">' + esc(label) + (o.optional ? ' <span class="muted">(optional)</span>' : '') + '</label>' +
        (o.help ? '<p class="help">' + esc(o.help) + '</p>' : '') +
        (o.area
          ? '<textarea id="' + id + '" rows="' + (o.rows || 4) + '" maxlength="' + (o.max || 5000) + '"' + attrs(path, o.kind) + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + '>' + esc(o.kind === 'lines' ? (v || []).join('\n') : v || '') + '</textarea>'
          : '<input id="' + id + '" type="' + (o.type || 'text') + '"' + (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '') + (o.max ? ' maxlength="' + o.max + '"' : '') +
            (o.min != null ? ' min="' + o.min + '"' : '') + (o.list ? ' list="' + o.list + '"' : '') + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + (o.required ? ' required' : '') +
            ' value="' + esc(o.display ? o.display(v) : v == null ? '' : v) + '"' + attrs(path, o.kind) + (o.rerender ? ' data-rerender' : '') + '>') +
        errSlot(path) + '</div>';
    }
    function select(path, label, options, o) {
      o = o || {};
      var v = getPath(S.data, path);
      var id = 'f-' + path.replace(/\W/g, '-');
      return '<div class="fld"><label for="' + id + '">' + esc(label) + '</label><select id="' + id + '"' + attrs(path) + (o.rerender ? ' data-rerender' : '') + '>' +
        options.map(function (op) { return '<option value="' + esc(op[0]) + '"' + (String(v == null ? (o.def || '') : v) === String(op[0]) ? ' selected' : '') + '>' + esc(op[1]) + '</option>'; }).join('') +
        '</select>' + errSlot(path) + '</div>';
    }
    function toggle(path, label, desc) {
      var on = Boolean(getPath(S.data, path));
      return '<div class="switch-row"><div><p class="switch-label" id="lbl-' + esc(path.replace(/\W/g, '-')) + '">' + esc(label) + '</p>' + (desc ? '<p class="help">' + esc(desc) + '</p>' : '') + '</div>' +
        '<button type="button" class="switch" role="switch" aria-checked="' + on + '" aria-labelledby="lbl-' + esc(path.replace(/\W/g, '-')) + '" data-act="toggle" data-path="' + esc(path) + '"><span></span></button></div>' + errSlot(path);
    }
    function check(path, label) {
      return '<label class="check"><input type="checkbox"' + attrs(path, 'bool') + (getPath(S.data, path) ? ' checked' : '') + '> <span>' + esc(label) + '</span></label>' + errSlot(path);
    }
    function card(title, body, o) {
      o = o || {};
      return '<section class="wz-card' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' id="' + o.id + '"' : '') + '><h3 class="wz-card-title">' + esc(title) + '</h3>' + (o.desc ? '<p class="help">' + esc(o.desc) + '</p>' : '') + body + '</section>';
    }

    /* ---------- live bits (updated without a full re-render, so typing keeps focus) ---------- */
    function whenSummary() {
      var d = S.data;
      if (!d.startLocal) return 'Pick a start date and time.';
      var tz = TZ[d.timezone || 'Asia/Kolkata'] || d.timezone;
      var s = fmtLocal(d.startLocal);
      if (d.endLocal) {
        var sameDay = d.endLocal.slice(0, 10) === d.startLocal.slice(0, 10);
        s += ' – ' + (sameDay ? new Date(d.endLocal + ':00Z').toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }) : fmtLocal(d.endLocal));
      }
      return s + ' · ' + tz;
    }
    function inventory() {
      var t = S.data.tickets || [];
      var total = 0, free = 0, paid = 0;
      t.forEach(function (x) { var q = Number.isInteger(x.quantity) && x.quantity > 0 ? x.quantity : 0; total += q; if (x.kind === 'free') free += q; else paid += q; });
      return '<table class="inv"><caption class="sr-only">Ticket inventory</caption><thead><tr><th scope="col">Ticket</th><th scope="col">Price</th><th scope="col">Qty</th></tr></thead><tbody>' +
        t.map(function (x) { return '<tr><td>' + esc(x.name || 'Untitled') + ' <span class="pill pill-' + esc(x.kind) + '">' + (x.kind === 'free' ? 'Free' : 'Paid') + '</span></td><td>' + (x.kind === 'free' ? 'Free' : Number.isInteger(x.pricePaise) ? esc(money(x.pricePaise)) : '—') + '</td><td>' + (Number.isInteger(x.quantity) ? esc(x.quantity) : '—') + '</td></tr>'; }).join('') +
        '</tbody><tfoot><tr><th scope="row">Total</th><td>' + free + ' free · ' + paid + ' paid</td><td>' + total + '</td></tr></tfoot></table>';
    }
    function updateLive() {
      var w = $('[data-live="when"]', el); if (w) w.textContent = whenSummary();
      var inv = $('[data-live="inventory"]', el); if (inv) inv.innerHTML = inventory();
      $$('[data-count-for]', el).forEach(function (c) { var v = getPath(S.data, c.getAttribute('data-count-for')) || ''; c.textContent = v.length + ' / ' + c.getAttribute('data-max'); });
    }

    /* ---------- screens ---------- */
    function head() {
      return '<header class="wz-head"><div><h1>Create an event</h1><p class="lede">Nothing goes live until you publish.</p></div>' +
        '<p class="wz-status" data-save-status role="status" aria-live="polite"></p></header>' +
        '<nav aria-label="Steps"><ol class="wz-steps">' + STEPS.map(function (s, i) {
          var cur = s[0] === S.step;
          return '<li><button type="button" data-act="go" data-step="' + s[0] + '"' + (cur ? ' aria-current="step"' : '') + (!S.draft ? ' disabled' : '') + '><span class="wz-num">' + (i + 1) + '</span> ' + s[1] + '</button></li>';
        }).join('') + '</ol></nav>';
    }
    function nav(back, next, nextLabel) {
      return '<p class="wz-summary" data-step-summary role="status"></p><div class="wz-nav">' +
        (back ? '<button class="btn btn-ghost" type="button" data-act="go" data-step="' + back + '">Back</button>' : '<span></span>') +
        '<button class="btn btn-ghost wz-save" type="button" data-act="save-now">Save draft</button>' +
        '<button class="btn btn-primary" type="button" data-act="next" data-step="' + next + '">' + esc(nextLabel) + '</button></div>';
    }
    function conflictBanner() {
      if (!S.conflict) return '';
      return '<div class="wz-alert" role="alert"><p><strong>This draft was changed in another tab or on another device</strong> (' + esc(ago(S.conflict.updatedAt)) + ').</p>' +
        '<div class="org-item-actions"><button class="btn btn-sm btn-primary" type="button" data-act="conflict-theirs">Load that version</button>' +
        '<button class="btn btn-sm btn-ghost" type="button" data-act="conflict-mine">Keep what I have here</button></div></div>';
    }

    function templateGrid(intro) {
      return '<section class="wz-card"><h2 class="wz-card-title">' + esc(intro) + '</h2><p class="help">A starting point only — you can change everything.</p><div class="tpl-grid">' +
        CFG.templates.map(function (t) {
          return '<button type="button" class="tpl" data-act="template" data-key="' + esc(t.key) + '"' + (S.data && S.data.template === t.key ? ' aria-pressed="true"' : '') + '><span class="tpl-label">' + esc(t.label) + '</span><span class="tpl-hint">' + esc(t.hint) + '</span></button>';
        }).join('') + '</div></section>';
    }

    function screenStart(drafts) {
      var latest = drafts && drafts[0];
      var h = head();
      if (latest) {
        h += '<div class="wz-alert" role="region" aria-label="Unfinished draft"><p><strong>You have an unfinished draft:</strong> ' + esc(latest.data.title || 'Untitled draft') + ' <span class="muted">· edited ' + esc(ago(latest.updatedAt)) + '</span></p>' +
          '<div class="org-item-actions"><button class="btn btn-primary btn-sm" type="button" data-act="continue" data-id="' + esc(latest.id) + '">Continue draft</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-act="fresh" data-id="' + esc(latest.id) + '" data-meaningful="' + (meaningful(latest.data) ? '1' : '') + '" data-title="' + esc(latest.data.title || 'Untitled draft') + '">Start fresh</button></div></div>';
      } else {
        h += templateGrid('What are you organising?');
      }
      return h;
    }

    function stepBasics() {
      var d = S.data;
      var tpl = CFG.templates.filter(function (t) { return t.key === d.template; })[0];
      var imgs = d.imageIds || [];
      var cover = d.coverImageId
        ? '<figure class="img-prev"><img src="/media/event-images/' + esc(d.coverImageId) + '" alt="Cover image preview" width="640" height="360"><figcaption class="org-item-actions">' +
          '<label class="btn btn-sm btn-ghost file-btn">Replace<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="cover" class="sr-only"></label>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-act="remove-image" data-id="' + esc(d.coverImageId) + '" data-which="cover">Remove</button></figcaption></figure>'
        : '<label class="drop">' + (S.uploading === 'cover' ? 'Uploading…' : '<strong>Add a cover image</strong><span class="help">JPEG, PNG or WebP. Large photos are resized for you.</span>') +
          '<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="cover" class="sr-only"></label>';
      var gallery = '<div class="thumbs">' + imgs.map(function (id) {
        return '<figure class="thumb"><img src="/media/event-images/' + esc(id) + '" alt="Additional image" width="160" height="110"><button class="btn btn-sm btn-ghost" type="button" data-act="remove-image" data-id="' + esc(id) + '" data-which="gallery" aria-label="Remove image">Remove</button></figure>';
      }).join('') + (imgs.length < CFG.limits.images - 1 ? '<label class="drop drop-sm">' + (S.uploading === 'gallery' ? 'Uploading…' : '+ Add photo') + '<input type="file" accept="image/jpeg,image/png,image/webp" data-upload="gallery" class="sr-only"></label>' : '') + '</div>';
      var venueHelp = d.privateVenue ? 'The exact address. Only guests with a confirmed booking will see it.' : 'Shown on the event page.';
      return (S.choosingTemplate ? templateGrid('Choose a template') : '') +
        card('What kind of event?', '<p class="help">Template: <strong>' + esc(tpl ? tpl.label : 'Something else') + '</strong> <button class="linkish" type="button" data-act="change-template">Change</button></p>' +
          select('category', 'Category', CFG.categories), {}) +
        card('Event name', text('title', 'Event name', { required: true, max: 140, placeholder: 'e.g. Sunday Founders Breakfast' }) + '<p class="help counter" data-count-for="title" data-max="140"></p>') +
        card('Date & time',
          select('timezone', 'Time zone', CFG.timezones, { def: 'Asia/Kolkata' }) +
          '<div class="row2">' + text('startLocal', 'Starts', { type: 'datetime-local', required: true }) +
          text('endLocal', d.multiDay ? 'Ends' : 'Ends', { type: 'datetime-local', optional: !d.multiDay }) + '</div>' +
          toggle('multiDay', 'Multi-day event', 'For trips, festivals and retreats. You can then sell tickets for one day or all days.') +
          '<p class="when" data-live="when" aria-live="polite"></p>') +
        card('Location',
          text('venue', 'Venue or meeting point', { help: venueHelp, max: 300, optional: true }) +
          '<div class="row2">' + text('city', 'City', { max: 60, list: 'wz-cities' }) + text('area', 'Area or neighbourhood', { max: 120, optional: true, help: 'Shown publicly.' }) + '</div>' +
          '<datalist id="wz-cities">' + CFG.cities.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>' +
          text('mapsUrl', 'Google Maps link', { type: 'url', optional: true, max: 500, placeholder: 'https://maps.app.goo.gl/…', help: d.privateVenue ? 'Given only to confirmed guests, as a one-tap map button.' : 'Adds an “Open in Maps” button.' }) +
          toggle('privateVenue', 'Keep the address private until someone books.', 'Guests see the area and city only. The address and map link appear on their booking once it’s confirmed.')) +
        card('Poster & description', '<div class="fld"><p class="lbl">Cover image <span class="muted">(optional)</span></p>' + cover + errSlot('coverImageId') + '</div>' +
          '<div class="fld"><p class="lbl">More photos <span class="muted">(optional, up to ' + (CFG.limits.images - 1) + ')</span></p>' + gallery + '</div>' +
          '<p class="form-msg error" data-upload-msg role="alert"></p>' +
          (d.coverImageId || imgs.length ? check('imageRightsConfirmed', 'I own these images or have permission to use them.') : '') +
          text('description', 'Description', { area: true, rows: 8, max: 5000, help: 'Cover the schedule, what’s included, dress code, accessibility and entry rules (all guests must be 21+).' }) +
          text('hostName', 'Hosted by', { max: 80, optional: true, placeholder: CFG.alias || 'Your name or organisation', help: 'Shown on the event page.' })) +
        nav(null, 'tickets', 'Next: Tickets & payment');
    }

    function stepTickets() {
      var d = S.data;
      var dates = d.multiDay ? datesBetween(d.startLocal, d.endLocal, CFG.limits.days) : [];
      var balance = d.features && d.features.balance && d.features.balance.enabled;
      var tiers = (d.tickets || []).map(function (t, i) {
        var p = 'tickets.' + i;
        return '<li class="tier-card"><div class="tier-card-head"><h4>' + esc(t.name || 'Untitled ticket') + '</h4><span class="pill pill-' + esc(t.kind) + '">' + (t.kind === 'free' ? 'Free' : 'Paid') + '</span></div>' +
          '<div class="row2">' + text(p + '.name', 'Ticket name', { max: 60 }) +
          '<fieldset class="fld seg"><legend>Type</legend>' +
          '<label><input type="radio" name="kind-' + esc(t.id) + '" value="free"' + attrs(p + '.kind') + ' data-rerender' + (t.kind === 'free' ? ' checked' : '') + '> Free</label>' +
          '<label><input type="radio" name="kind-' + esc(t.id) + '" value="paid"' + attrs(p + '.kind') + ' data-rerender' + (t.kind === 'paid' ? ' checked' : '') + '> Paid</label></fieldset></div>' +
          '<div class="row3">' + (t.kind === 'paid' ? text(p + '.pricePaise', 'Price (₹)', { type: 'number', min: 0, inputmode: 'decimal', kind: 'rupees', display: function (v) { return Number.isInteger(v) ? v / 100 : ''; } }) : '<div class="fld"><p class="lbl">Price</p><p class="free-note">Free — no payment is ever collected.</p></div>') +
          text(p + '.quantity', 'Quantity available', { type: 'number', min: 0, inputmode: 'numeric', kind: 'int' }) +
          text(p + '.maxPerBooking', 'Max per booking', { type: 'number', min: 1, inputmode: 'numeric', kind: 'int' }) + '</div>' +
          (d.multiDay ? select(p + '.validOn', 'Valid for', [['all', 'All event days']].concat(dates.map(function (x) { return [x, dayLabel(x)]; })), { def: 'all' }) : '') +
          (balance ? text(p + '.eligibility', 'Who is this ticket for?', { max: 120, optional: true, placeholder: 'e.g. Women, Men, Couples', help: 'Guests confirm they meet this when booking.' }) : '') +
          '<div class="org-item-actions"><button class="btn btn-sm btn-ghost" type="button" data-act="dup-tier" data-i="' + i + '">Duplicate</button>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-act="del-tier" data-i="' + i + '">Delete</button></div></li>';
      }).join('');
      var co = CFG.checkout;
      var payCard = co.available
        ? '<p class="notice">Paid tickets use a hosted checkout' + (co.testMode ? ' in <strong>test mode</strong> (no real money)' : '') + '. A booking is confirmed only after the payment provider confirms payment.</p>'
        : '<p class="notice notice-warn"><strong>Online payment isn’t available yet.</strong> ' + esc(co.message) + '</p>';
      return card('Payment', payCard) +
        card('Ticket types', '<p class="help">Quick add:</p><div class="chips">' + Object.keys(CFG.ticketPresets).map(function (k) {
          return '<button type="button" class="chip" data-act="add-tier" data-preset="' + esc(k) + '">+ ' + esc(CFG.ticketPresets[k].name) + '</button>';
        }).join('') + '</div>' + errSlot('tickets') +
          (tiers ? '<ul class="tier-list">' + tiers + '</ul>' : '<p class="muted">No tickets yet. Add one above.</p>') +
          ((d.tickets || []).length < CFG.limits.tiers ? '<button class="btn btn-ghost btn-sm" type="button" data-act="add-tier" data-preset="general">+ Add another ticket type</button>' : '')) +
        card('Inventory', '<div data-live="inventory"></div>') +
        card('Cancellation & refunds', text('refundPolicy', 'Your cancellation and refund policy', { area: true, rows: 3, max: 1000, optional: !(d.tickets || []).some(function (t) { return t.kind === 'paid'; }),
          placeholder: 'e.g. Full refund up to 48 hours before the event. No refunds after that.', help: 'Shown to guests before they book. Required if any ticket is paid.' })) +
        card('Coming later', '<ul class="later"><li>Advance + balance payments</li><li>Promo codes</li><li>Complimentary passes</li></ul><p class="help">These aren’t available yet, so they can’t be switched on.</p>', { cls: 'wz-card-muted' }) +
        nav('basics', 'features', 'Next: Features');
    }

    function stepFeatures() {
      var f = S.data.features || {};
      var q = f.questions || {}, pk = f.pickup || {}, ct = f.contact || {};
      var items = q.items || [];
      var used = {}; items.forEach(function (x) { used[x.label] = true; });
      var qBody = !q.enabled ? '' : '<p class="help">Quick add:</p><div class="chips">' + Object.keys(CFG.questionPresets).map(function (k) {
        var pr = CFG.questionPresets[k];
        return '<button type="button" class="chip" data-act="add-question" data-preset="' + esc(k) + '"' + (used[pr.label] ? ' disabled' : '') + '>+ ' + esc(pr.label) + '</button>';
      }).join('') + '</div>' +
        '<p class="help">Only ask for what you need. Don’t make Instagram, gender or other personal details required unless the event genuinely depends on it. Answers are visible only to you.</p>' +
        (used.Gender ? '<p class="notice notice-warn">' + esc(CFG.questionPresets.gender.note) + '</p>' : '') +
        errSlot('features.questions.items') +
        '<ol class="q-edit">' + items.map(function (x, i) {
          var p = 'features.questions.items.' + i;
          return '<li class="tier-card">' + text(p + '.label', 'Question', { max: 200 }) +
            '<div class="row2">' + select(p + '.type', 'Answer type', [['short', 'Short answer'], ['long', 'Long answer'], ['single', 'Single choice'], ['multi', 'Multiple choice']], { rerender: true }) +
            '<div class="fld fld-check">' + check(p + '.required', 'Required') + '</div></div>' +
            (x.type === 'single' || x.type === 'multi' ? text(p + '.options', 'Choices (one per line)', { area: true, rows: 3, max: 1000, kind: 'lines' }) : '') +
            '<button class="btn btn-sm btn-ghost" type="button" data-act="del-question" data-i="' + i + '">Remove question</button></li>';
        }).join('') + '</ol>' +
        (items.length < CFG.limits.questions ? '<button class="btn btn-sm btn-ghost" type="button" data-act="add-question" data-preset="">+ Write your own question</button>' : '');
      var pkBody = !pk.enabled ? '' : errSlot('features.pickup.points') + '<ol class="q-edit">' + (pk.points || []).map(function (x, i) {
        var p = 'features.pickup.points.' + i;
        return '<li class="tier-card"><div class="row2">' + text(p + '.name', 'Pickup point', { max: 80, placeholder: 'e.g. Silk Board junction' }) + text(p + '.time', 'Meeting time', { type: 'datetime-local' }) + '</div>' +
          text(p + '.location', 'Exact spot', { max: 200, optional: true, placeholder: 'e.g. Outside the metro exit B' }) +
          '<button class="btn btn-sm btn-ghost" type="button" data-act="del-pickup" data-i="' + i + '">Remove</button></li>';
      }).join('') + '</ol>' + ((pk.points || []).length < CFG.limits.pickups ? '<button class="btn btn-sm btn-ghost" type="button" data-act="add-pickup">+ Add pickup point</button>' : '');
      var ctBody = !ct.enabled ? '' : '<div class="row2">' + text('features.contact.name', 'Contact name', { max: 80 }) +
        text('features.contact.phone', 'WhatsApp number', { type: 'tel', max: 24, inputmode: 'tel', placeholder: '98765 43210' }) + '</div>' +
        '<p class="help">This number is shown only to guests with a confirmed booking — never on the public page.</p>';
      return card('Ask guests questions', toggle('features.questions.enabled', 'Ask questions when guests book', 'Collect what you need to run the event, like dietary needs.') + qBody) +
        card('Approve each guest', toggle('features.approval.enabled', 'Approve every booking yourself', '') +
          '<ul class="explain"><li><strong>What guests see:</strong> a “Request to join” button. Their request waits for you; nothing is charged.</li>' +
          '<li><strong>What you do:</strong> approve or decline each request from your event page. You’ll get a Telegram message for each one.</li>' +
          '<li>Approval never counts as payment. Paid tickets still go through checkout after you approve.</li></ul>') +
        card('Crowd balance', toggle('features.balance.enabled', 'Balance who attends with per-ticket limits', 'Useful for mixers and matchmaking. Create a ticket per group (e.g. “Women”, “Men”, “Couples”), set each one’s quantity, and say who it’s for.') +
          (f.balance && f.balance.enabled ? '<p class="help">Each ticket pauses automatically when its limit is reached and reopens if a spot frees up. Guests see how many are left and confirm they meet the ticket’s eligibility. <button class="linkish" type="button" data-act="go" data-step="tickets">Set eligibility in Tickets</button></p>' : '')) +
        card('Pickup points', toggle('features.pickup.enabled', 'Offer pickup points', 'For trips and treks. Guests choose one when booking; you’ll see it on your guest list.') + pkBody) +
        card('Event contact person', toggle('features.contact.enabled', 'Share an on-ground contact', 'Someone guests can WhatsApp on the day.') + ctBody) +
        card('Coming later', '<ul class="later"><li>Minimum guest threshold</li><li>Promo codes</li><li>Advance + balance payments</li></ul><p class="help">These aren’t available yet, so they can’t be switched on.</p>', { cls: 'wz-card-muted' }) +
        nav('tickets', 'preview', 'Next: Preview');
    }

    function attendeePreview() {
      var d = S.data, f = d.features || {};
      var co = CFG.checkout;
      var where = d.privateVenue ? [d.area, d.city].filter(Boolean).join(', ') + ' — exact address shared with confirmed guests' : [d.venue, d.area, d.city].filter(Boolean).join(', ');
      var tix = (d.tickets || []).map(function (t) {
        var note = t.kind === 'paid' && !co.available ? ' — not bookable until online payment is available' : '';
        var valid = d.multiDay ? (t.validOn && t.validOn !== 'all' ? ' · ' + dayLabel(t.validOn) : ' · all days') : '';
        return '<li><strong>' + esc(t.name || 'Untitled') + '</strong> · ' + (t.kind === 'free' ? 'Free' : Number.isInteger(t.pricePaise) ? esc(money(t.pricePaise)) : 'price missing') +
          ' · ' + esc(Number.isInteger(t.quantity) ? t.quantity : '?') + ' available' + esc(valid) + (f.balance && f.balance.enabled && t.eligibility ? ' · for ' + esc(t.eligibility) : '') + esc(note) + '</li>';
      }).join('');
      var qs = f.questions && f.questions.enabled ? (f.questions.items || []) : [];
      var pts = f.pickup && f.pickup.enabled ? (f.pickup.points || []) : [];
      return '<article class="att-prev" aria-label="What guests will see">' +
        (d.coverImageId ? '<img src="/media/event-images/' + esc(d.coverImageId) + '" alt="" width="800" height="450">' : '<div class="att-art" aria-hidden="true"></div>') +
        '<div class="att-body"><p class="card-meta"><span>' + esc(CAT[d.category] || '') + '</span><span>' + esc(d.city || '') + '</span></p>' +
        '<h3>' + esc(d.title || 'Untitled event') + '</h3><p class="muted">' + esc(whenSummary()) + '</p><p>' + esc(where || 'Location to be added') + '</p>' +
        (d.description ? '<p class="att-desc">' + esc(d.description.slice(0, 700)) + (d.description.length > 700 ? '…' : '') + '</p>' : '') +
        '<h4>Tickets</h4>' + (tix ? '<ul>' + tix + '</ul>' : '<p class="muted">No tickets yet.</p>') +
        '<h4>Entry</h4><ul><li>Adults 21+ only. Guests carry a photo ID.</li>' + (f.approval && f.approval.enabled ? '<li>The host approves each guest.</li>' : '') + '</ul>' +
        (qs.length ? '<h4>Questions at booking</h4><ul>' + qs.map(function (x) { return '<li>' + esc(x.label || 'Untitled question') + (x.required ? ' <span class="muted">(required)</span>' : '') + '</li>'; }).join('') + '</ul>' : '') +
        (pts.length ? '<h4>Pickup points</h4><ul>' + pts.map(function (p) { return '<li>' + esc(p.name || 'Unnamed') + (p.time ? ' · ' + esc(fmtLocal(p.time)) : '') + '</li>'; }).join('') + '</ul>' : '') +
        '<h4>Cancellation & refunds</h4><p>' + esc(d.refundPolicy || 'No policy written yet.') + '</p>' +
        '<p class="muted">Hosted by ' + esc(d.hostName || CFG.alias || 'you') + (f.contact && f.contact.enabled ? ' · on-ground contact shared with confirmed guests' : '') + '</p>' +
        '</div></article>';
    }

    function stepPreview() {
      var errs = S.issues.filter(function (i) { return i.severity === 'error'; });
      var warns = S.issues.filter(function (i) { return i.severity === 'warning'; });
      var label = { basics: 'Basics', tickets: 'Tickets', features: 'Features' };
      var list = function (arr) {
        return '<ul class="issues">' + arr.map(function (i) {
          return '<li><span class="pill">' + esc(label[i.step] || i.step) + '</span> ' + esc(i.message) + ' <button class="linkish" type="button" data-act="fix" data-step="' + esc(i.step) + '" data-field="' + esc(i.field) + '">Fix</button></li>';
        }).join('') + '</ul>';
      };
      return card('Before you publish', errs.length ? '<p>' + errs.length + ' thing' + (errs.length === 1 ? '' : 's') + ' to finish:</p>' + list(errs) : '<p class="ok-line">Everything needed is in place.</p>' +
        (warns.length ? '<p class="help">Worth a look:</p>' + list(warns) : '')) +
        card('What guests will see', attendeePreview()) +
        '<div class="wz-nav wz-nav-final">' +
        '<button class="btn btn-ghost" type="button" data-act="go" data-step="features">Back to edit</button>' +
        '<button class="btn btn-ghost" type="button" data-act="save-now">Save draft</button>' +
        '<a class="btn btn-ghost" href="/organiser/drafts/' + esc(S.draft.id) + '/preview" target="_blank" rel="noopener" data-act="journey">Preview booking journey</a>' +
        '<button class="btn btn-primary" type="button" data-act="publish"' + (errs.length ? ' disabled aria-describedby="pub-why"' : '') + '>Publish event</button></div>' +
        (errs.length ? '<p class="help" id="pub-why">Finish the items above to publish. Your draft is saved.</p>' : '') +
        '<dialog class="wz-dialog" data-publish-dialog aria-labelledby="pub-title"><h2 id="pub-title">Publish “' + esc(S.data.title || 'this event') + '”?</h2>' +
        '<p>It will appear on StrangersMeetup for everyone to see' + ((S.data.features || {}).approval && S.data.features.approval.enabled ? ', and guests can send requests to join.' : ', and guests can start booking.') + '</p>' +
        ((S.data.tickets || []).some(function (t) { return t.kind === 'paid'; }) && !CFG.checkout.available ? '<p class="notice notice-warn">Paid tickets will show as “not available yet” until online payment is configured. Only free tickets can be booked.</p>' : '') +
        '<p class="form-msg error" data-publish-msg role="alert"></p>' +
        '<div class="org-item-actions"><button class="btn btn-ghost" type="button" data-act="publish-cancel">Not yet</button><button class="btn btn-primary" type="button" data-act="publish-confirm">Publish now</button></div></dialog>';
    }

    function screenPublished() {
      var p = S.published;
      return '<section class="wz-card wz-done" tabindex="-1" data-focus><p class="eyebrow">Published</p><h1>Your event is live</h1>' +
        '<p>Share this link with your guests:</p><div class="share-row"><input class="share-url" readonly value="' + esc(p.url) + '" aria-label="Public link">' +
        '<button class="btn btn-sm btn-primary" type="button" data-act="copy" data-url="' + esc(p.url) + '">Copy link</button>' +
        '<button class="btn btn-sm btn-ghost" type="button" data-act="share" data-url="' + esc(p.url) + '">Share</button></div>' +
        '<div class="org-item-actions"><a class="btn btn-ghost" href="' + esc(p.path) + '">View event page</a><a class="btn btn-ghost" href="' + esc(p.manageUrl) + '">Manage guests</a><a class="btn btn-ghost" href="/organiser">All your events</a></div></section>';
    }

    function render(focusSel) {
      var h;
      if (S.published) h = screenPublished();
      else if (!S.draft) h = screenStart(S.startDrafts);
      else {
        var body = { basics: stepBasics, tickets: stepTickets, features: stepFeatures, preview: stepPreview }[S.step]();
        h = head() + conflictBanner() + (S.flash ? '<p class="notice" role="status">' + esc(S.flash) + '</p>' : '') +
          '<div class="wz-step" data-step-body><h2 class="sr-only" tabindex="-1" data-step-heading>' + esc(STEPS.filter(function (s) { return s[0] === S.step; })[0][1]) + '</h2>' + body + '</div>';
      }
      el.innerHTML = '<div class="wrap wz-wrap">' + h + '</div>';
      updateLive();
      showErrors();
      setStatus(S.status, S.statusMsg);
      var f = focusSel && $(focusSel, el);
      if (f) f.focus();
    }

    /* ---------- data events ---------- */
    function readValue(input) {
      var kind = input.getAttribute('data-kind');
      if (kind === 'bool') return input.checked;
      var v = input.value;
      if (kind === 'int') return v === '' ? null : (/^-?\d+$/.test(v.trim()) ? parseInt(v, 10) : NaN);
      if (kind === 'rupees') { if (v === '') return null; var n = Number(v); return isFinite(n) ? Math.round(n * 100) : NaN; }
      if (kind === 'lines') return v.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 12);
      return v;
    }
    function onField(ev) {
      var input = ev.target.closest('[data-path]');
      if (!input || input.getAttribute('data-act')) return;
      var v = readValue(input);
      if (typeof v === 'number' && isNaN(v)) v = null; // non-numeric text: treated as empty, flagged on publish
      setPath(S.data, input.getAttribute('data-path'), v);
      if (input.getAttribute('data-path') === 'multiDay' || input.getAttribute('data-path') === 'privateVenue') input.setAttribute('data-rerender', '');
      touch();
      if (input.hasAttribute('data-rerender') && ev.type === 'change') render('[data-path="' + input.getAttribute('data-path') + '"]');
      else updateLive();
    }
    el.addEventListener('input', onField);
    el.addEventListener('change', function (ev) {
      if (ev.target.matches('[data-upload]')) return upload(ev.target);
      onField(ev);
    });
    el.addEventListener('focusout', function (ev) {
      var input = ev.target.closest && ev.target.closest('[data-path]');
      if (!input) return;
      S.touched[input.getAttribute('data-path')] = true;
      showErrors();
    });

    /* ---------- images ---------- */
    function shrink(file) {
      if (!window.createImageBitmap) return Promise.resolve(file);
      return createImageBitmap(file).then(function (bmp) {
        var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        var c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
        var g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(bmp, 0, 0, c.width, c.height);
        var enc = function (q) { return new Promise(function (res) { c.toBlob(res, 'image/jpeg', q); }); };
        return enc(0.85).then(function (b) { return b && b.size > CFG.limits.imageBytes ? enc(0.7) : b; });
      }).catch(function () { return file; });
    }
    function upload(input) {
      var file = input.files && input.files[0];
      var which = input.getAttribute('data-upload');
      var msg = function (t) { var m = $('[data-upload-msg]', el); if (m) m.textContent = t; };
      if (!file) return;
      if (['image/jpeg', 'image/png', 'image/webp'].indexOf(file.type) === -1) return msg('Use a JPEG, PNG or WebP image.');
      if (file.size > 15 * 1024 * 1024) return msg('That image is over 15 MB. Choose a smaller one.');
      S.uploading = which; render();
      shrink(file).then(function (blob) {
        if (blob.size > CFG.limits.imageBytes) { S.uploading = ''; render(); return msg('That image is still over 2 MB after resizing. Try a smaller one.'); }
        return api('POST', '/api/organiser/drafts/' + encodeURIComponent(S.draft.id) + '/images', undefined, { blob: blob, type: blob.type || file.type }).then(function (r) {
          S.uploading = '';
          if (!r.ok) { render(); return msg(r.message || 'Upload failed. Please try again.'); }
          var old = S.data.coverImageId;
          if (which === 'cover') S.data.coverImageId = r.image.id;
          else S.data.imageIds = (S.data.imageIds || []).concat(r.image.id);
          touch(); render();
          if (which === 'cover' && old) api('DELETE', '/api/organiser/drafts/' + encodeURIComponent(S.draft.id) + '/images/' + encodeURIComponent(old));
        });
      });
    }

    /* ---------- actions ---------- */
    function presetTier(key) {
      var p = clone(CFG.ticketPresets[key] || CFG.ticketPresets.general);
      p.id = uid();
      if (p.kind === 'free') p.pricePaise = 0;
      return p;
    }
    function goStep(step) {
      S.step = step; S.flash = ''; S.dirty = true; backup();
      save().then(function () { if (step === 'preview') refreshIssues(); });
      render('[data-step-heading]');
      window.scrollTo(0, 0);
    }
    function refreshIssues() {
      api('GET', '/api/organiser/drafts/' + encodeURIComponent(S.draft.id) + '/check').then(function (r) {
        if (r.ok) { S.issues = r.issues; CFG.checkout = r.checkout; if (S.step === 'preview') render(); }
      });
    }
    function startDraft(template) {
      return api('POST', '/api/organiser/drafts', { template: template }).then(function (r) {
        if (!r.ok) { window.alert(r.message || 'Could not start a draft.'); return; }
        adopt(r.draft);
        history.replaceState(null, '', '/organiser/new?draft=' + encodeURIComponent(r.draft.id));
        render('[data-step-heading]');
      });
    }
    function adopt(draft) {
      S.draft = draft; S.data = draft.data || {}; S.version = draft.version; S.step = draft.step || 'basics'; S.issues = draft.issues || []; S.dirty = false; S.conflict = null;
      S.issuesData = clone(S.data);
      var local = store(localKey());
      if (local && local.v === draft.version && JSON.stringify(local.data) !== JSON.stringify(draft.data)) {
        S.data = local.data; S.step = local.step || S.step; S.flash = 'Restored changes from this device that hadn’t been saved yet.';
        touch();
      } else if (local && local.v !== draft.version) {
        store(localKey(), null);
        if (JSON.stringify(local.data) !== JSON.stringify(draft.data)) S.flash = 'Loaded your latest saved version. Older unsaved edits on this device were set aside.';
      }
      setStatus(S.dirty ? 'saving' : 'saved');
    }

    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-act]');
      if (!b || b.disabled) return;
      var act = b.getAttribute('data-act');
      var i = parseInt(b.getAttribute('data-i'), 10);
      var t = S.data && S.data.tickets;
      switch (act) {
        case 'continue':
          return api('GET', '/api/organiser/drafts/' + encodeURIComponent(b.getAttribute('data-id'))).then(function (r) {
            if (!r.ok) return window.alert(r.message || 'Could not open that draft.');
            adopt(r.draft); history.replaceState(null, '', '/organiser/new?draft=' + encodeURIComponent(r.draft.id)); render('[data-step-heading]');
          });
        case 'fresh':
          if (b.getAttribute('data-meaningful') && !window.confirm('Start fresh and discard “' + b.getAttribute('data-title') + '”? This cannot be undone.')) return;
          return api('DELETE', '/api/organiser/drafts/' + encodeURIComponent(b.getAttribute('data-id'))).then(function () {
            store('sm_wz_' + b.getAttribute('data-id'), null); S.startDrafts = []; render();
          });
        case 'template':
          if (!S.draft) return startDraft(b.getAttribute('data-key'));
          var tpl = CFG.templates.filter(function (x) { return x.key === b.getAttribute('data-key'); })[0];
          if (!window.confirm('Use the “' + tpl.label + '” template? Its category, ticket and feature defaults replace yours. Your name, dates, location, images and description stay.')) return;
          var dflt = clone(tpl.defaults);
          ['template', 'category', 'multiDay', 'privateVenue', 'tickets', 'features'].forEach(function (k) { S.data[k] = dflt[k]; });
          S.choosingTemplate = false; touch(); return render();
        case 'change-template': S.choosingTemplate = !S.choosingTemplate; return render();
        case 'go': return goStep(b.getAttribute('data-step'));
        case 'next': S.shown[S.step] = true; return goStep(b.getAttribute('data-step'));
        case 'save-now': S.dirty = true; return save();
        case 'retry-save': return save();
        case 'toggle':
          setPath(S.data, b.getAttribute('data-path'), !getPath(S.data, b.getAttribute('data-path')));
          var path = b.getAttribute('data-path');
          if (path === 'features.questions.enabled' && getPath(S.data, path) && !(feat('questions').items || []).length) feat('questions').items = [];
          if (path === 'features.pickup.enabled' && getPath(S.data, path) && !(feat('pickup').points || []).length) feat('pickup').points = [{ id: uid(), name: '', location: '', time: S.data.startLocal || '' }];
          touch(); return render('[data-act="toggle"][data-path="' + path + '"]');
        case 'add-tier':
          S.data.tickets = (t || []).concat(presetTier(b.getAttribute('data-preset'))); touch(); return render('.tier-card:last-child input');
        case 'dup-tier':
          var copy = clone(t[i]); copy.id = uid(); copy.name = (copy.name || 'Ticket') + ' (copy)';
          t.splice(i + 1, 0, copy); touch(); return render();
        case 'del-tier':
          if ((t[i].name || '').trim() && !window.confirm('Delete the “' + t[i].name + '” ticket?')) return;
          t.splice(i, 1); touch(); return render();
        case 'add-question':
          var qs = feat('questions'); qs.items = qs.items || [];
          var pr = b.getAttribute('data-preset') ? clone(CFG.questionPresets[b.getAttribute('data-preset')]) : { label: '', type: 'short', required: false };
          delete pr.note; pr.id = uid();
          qs.items.push(pr); touch(); return render('.q-edit li:last-child input');
        case 'del-question': feat('questions').items.splice(i, 1); touch(); return render();
        case 'add-pickup':
          var pk = feat('pickup'); pk.points = pk.points || [];
          pk.points.push({ id: uid(), name: '', location: '', time: S.data.startLocal || '' }); touch(); return render('.q-edit li:last-child input');
        case 'del-pickup': feat('pickup').points.splice(i, 1); touch(); return render();
        case 'remove-image':
          var id = b.getAttribute('data-id');
          if (b.getAttribute('data-which') === 'cover') S.data.coverImageId = null;
          else S.data.imageIds = (S.data.imageIds || []).filter(function (x) { return x !== id; });
          touch(); render();
          return api('DELETE', '/api/organiser/drafts/' + encodeURIComponent(S.draft.id) + '/images/' + encodeURIComponent(id));
        case 'fix':
          S.shown[b.getAttribute('data-step')] = true;
          goStep(b.getAttribute('data-step'));
          var target = $('[data-path="' + b.getAttribute('data-field') + '"]', el) || $('[data-err-for="' + b.getAttribute('data-field') + '"]', el);
          if (target) { target.scrollIntoView({ block: 'center' }); if (target.focus) target.focus(); }
          return;
        case 'conflict-theirs':
          S.data = S.conflict.data; S.version = S.conflict.version; S.conflict = null; S.dirty = false; store(localKey(), null); setStatus('saved'); return render();
        case 'conflict-mine':
          S.version = S.conflict.version; S.conflict = null; S.dirty = true; render(); return save();
        case 'publish':
          return save().then(function (ok) {
            if (ok === false) return;
            var dlg = $('[data-publish-dialog]', el);
            if (dlg && dlg.showModal) dlg.showModal(); else if (window.confirm('Publish this event now? It becomes visible to everyone.')) publishNow();
          });
        case 'publish-cancel': return $('[data-publish-dialog]', el).close();
        case 'publish-confirm': return publishNow(b);
        case 'copy': return copyText(b.getAttribute('data-url'), b);
        case 'share': return share(S.data.title, b.getAttribute('data-url'), b);
      }
    });

    function publishNow(btn) {
      if (btn) btn.disabled = true;
      var msg = $('[data-publish-msg]', el);
      api('POST', '/api/organiser/drafts/' + encodeURIComponent(S.draft.id) + '/publish', { version: S.version, confirm: true }).then(function (r) {
        if (btn) btn.disabled = false;
        if (r.ok) {
          store(localKey(), null); S.dirty = false; S.published = r;
          var dlg = $('[data-publish-dialog]', el); if (dlg && dlg.open) dlg.close();
          history.replaceState(null, '', '/organiser/new');
          render('[data-focus]'); window.scrollTo(0, 0);
          return;
        }
        if (r.status === 422 && r.issues) { S.issues = r.issues; var dl = $('[data-publish-dialog]', el); if (dl) dl.close(); render(); return; }
        if (r.error === 'version_conflict') { S.conflict = r.draft; var d2 = $('[data-publish-dialog]', el); if (d2) d2.close(); render(); return; }
        if (msg) msg.textContent = r.message || 'Could not publish. Please try again.';
      });
    }

    /* ---------- boot ---------- */
    var draftId = CFG.draftId || params.get('draft');
    if (draftId) {
      api('GET', '/api/organiser/drafts/' + encodeURIComponent(draftId)).then(function (r) {
        if (!r.ok) { el.innerHTML = '<div class="wrap wz-wrap"><p class="form-msg error">' + esc(r.message || 'Draft not found.') + '</p><p><a class="link-arrow" href="/organiser">Your events</a></p></div>'; return; }
        if (r.draft.status === 'published') { el.innerHTML = '<div class="wrap wz-wrap"><p>This draft is already published.</p><p><a class="link-arrow" href="/organiser/events/' + esc(r.draft.eventId) + '">Manage the event</a></p></div>'; return; }
        if (r.draft.status !== 'active') { el.innerHTML = '<div class="wrap wz-wrap"><p>This draft was discarded.</p><p><a class="btn btn-primary" href="/organiser/new?fresh=1">Create an event</a></p></div>'; return; }
        adopt(r.draft); render();
      });
    } else if (params.get('fresh')) {
      S.startDrafts = []; render();
    } else {
      api('GET', '/api/organiser/drafts').then(function (r) { S.startDrafts = (r.drafts || []); render(); });
    }
  }

  var dash = $('[data-org-dashboard]'); if (dash) initDashboard(dash);
  var manage = $('[data-org-manage]'); if (manage) initManage(manage);
  var wz = $('[data-wizard]'); if (wz) initWizard(wz);
})();
