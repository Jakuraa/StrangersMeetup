/* StrangersMeetup site script. Progressive enhancement: every page works without it except
   member actions (sign-in, booking), which need it. No user ids are ever sent from here —
   the server derives identity from the session cookie. */
(function () {
  'use strict';
  var doc = document.documentElement;
  doc.classList.add('js');
  var BOT = document.body.getAttribute('data-bot') || '';
  var state = { me: null, csrf: null };

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /* Only same-origin relative paths; rejects //host, /\host, javascript:, absolute URLs. */
  function sameOriginPath(p) {
    if (typeof p !== 'string' || !/^\/(?![\/\\])/.test(p)) return null;
    try { var u = new URL(p, location.origin); return u.origin === location.origin ? u.pathname + u.search + u.hash : null; } catch (e) { return null; }
  }
  function safeUrl(u) { return /^https:\/\//i.test(String(u || '')) ? esc(u) : '#'; }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  function api(method, path, body) {
    var headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
    return fetch(path, { method: method, headers: headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); });
  }

  function visitor() {
    var v = store('sm_vid');
    if (!v && window.crypto && crypto.randomUUID) { v = crypto.randomUUID(); store('sm_vid', v); }
    return v;
  }
  function track(name, eventId, extra) {
    try {
      var body = { name: name, visitorId: visitor() || undefined, eventId: eventId || undefined };
      Object.keys(extra || {}).forEach(function (k) { if (extra[k]) body[k] = extra[k]; });
      api('POST', '/api/analytics', body);
    } catch (e) { /* ignore */ }
  }
  /* First-party page view: path only, referrer host only, utm_source. No cookies, no query strings. */
  (function () {
    var ref = '';
    try { var r = document.referrer ? new URL(document.referrer) : null; if (r && r.host !== location.host) ref = r.hostname; } catch (e) { /* ignore */ }
    var utm = '';
    try { utm = (new URLSearchParams(location.search).get('utm_source') || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60); } catch (e) { /* ignore */ }
    var path = location.pathname.replace(/[^A-Za-z0-9\-._~/%]/g, '').slice(0, 200) || '/';
    if (path.indexOf('/admin') !== 0) track('page_view', null, { path: path, ref: ref, utm: utm });
  })();

  /* ---------- inside Telegram? ----------
     Digital goods sold inside Telegram apps must use Stars, so web-only checkouts (SuperProfile)
     are hidden in the Mini App. The flag survives in-app navigation for this tab. */
  var inTelegram = false;
  try {
    if (location.hash.indexOf('tgWebAppData') !== -1 || /tgWebApp/.test(location.search) || window.TelegramWebviewProxy) sessionStorage.setItem('sm_in_tg', '1');
    inTelegram = sessionStorage.getItem('sm_in_tg') === '1';
  } catch (e) { inTelegram = Boolean(window.TelegramWebviewProxy); }
  if (inTelegram) {
    $$('[data-web-only]').forEach(function (n) { n.hidden = true; n.setAttribute('aria-hidden', 'true'); });
    $$('[data-tg-only]').forEach(function (n) { n.hidden = false; });
  }
  $$('[data-membership-click]').forEach(function (a) {
    a.addEventListener('click', function () { track('membership_click'); });
  });

  /* ---------- nav ---------- */
  var toggle = $('.nav-toggle');
  if (toggle) toggle.addEventListener('click', function () {
    var nav = $('#site-nav');
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /* ---------- reveals ---------- */
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var reveals = $$('.reveal, .stagger');
  if (!reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        en.target.classList.add('in');
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- cinematic homepage: hero convergence, scroll-scrubbed scenes, header state ---------- */
  var hero = $('[data-cine-hero]');
  var stage = hero && $('.cine-stage', hero);
  var scenesEl = $('[data-scenes]');
  var header = $('.site-header');
  var cinema = document.body.classList.contains('home-cinema');
  function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  if (cinema && header) {
    var syncHeader = function () {
      var limit = hero ? hero.offsetHeight - 80 : 0;
      var past = window.scrollY > limit && !(scenesEl && inside(scenesEl));
      header.classList.toggle('solid', past);
    };
    var inside = function (el) { var r = el.getBoundingClientRect(); return r.top <= 64 && r.bottom > 64; };
    if (toggle) toggle.addEventListener('click', function () { if (toggle.getAttribute('aria-expanded') === 'true') header.classList.add('solid'); else syncHeader(); });
  }

  var sceneItems = scenesEl ? $$('.scene', scenesEl) : [];
  var bars = scenesEl ? $$('.scene-progress span', scenesEl) : [];
  var visual = scenesEl && $('.scenes-visual', scenesEl);
  if (scenesEl && !reduce) {
    scenesEl.classList.add('is-live');
    sceneItems[0].classList.add('on');
  }

  var ticking = false;
  function frame() {
    ticking = false;
    var vh = window.innerHeight;
    if (stage && !reduce) {
      var h = hero.getBoundingClientRect();
      // 0 at rest → 1 once the hero has scrolled ~60% away: the two lights converge.
      stage.style.setProperty('--s', (0.18 + clamp(-h.top / (h.height * 0.6)) * 0.82).toFixed(3));
    }
    if (visual) {
      var r = scenesEl.getBoundingClientRect();
      var p = clamp(-r.top / (r.height - vh));
      var n = sceneItems.length;
      var idx = Math.min(n - 1, Math.floor(p * n));
      sceneItems.forEach(function (s, i) { s.classList.toggle('on', i === idx); s.classList.toggle('past', i < idx); });
      bars.forEach(function (b, i) { b.style.setProperty('--f', clamp(p * n - i).toFixed(3)); });
      visual.style.setProperty('--q', clamp(p * 2.4).toFixed(3));
      visual.style.setProperty('--c', clamp((p - 0.7) * 4).toFixed(3));
    }
    if (syncHeader) syncHeader();
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }
  if (cinema) {
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    frame();
  }

  // Subtle pointer parallax on the hero lights (fine pointers only).
  if (stage && !reduce && window.matchMedia('(pointer: fine)').matches) {
    hero.addEventListener('pointermove', function (e) {
      stage.style.setProperty('--mx', ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
      stage.style.setProperty('--my', ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
    });
  }

  /* ---------- session ---------- */
  function refreshMe() {
    return api('GET', '/api/me').then(function (r) {
      state.me = r.user || null;
      state.csrf = r.csrf || null;
      $$('[data-auth-button]').forEach(function (a) {
        if (state.me) { a.textContent = 'My bookings'; a.setAttribute('aria-label', 'My bookings'); a.setAttribute('href', '/me'); a.classList.remove('btn-tg'); a.classList.add('btn-ghost'); }
      });
      return state.me;
    }).catch(function () { return null; });
  }

  function goSignin() {
    location.href = '/signin?next=' + encodeURIComponent(location.pathname + location.hash);
  }

  function afterAuth(r, msgEl) {
    if (r.ok) {
      state.csrf = r.csrf;
      location.href = sameOriginPath(new URLSearchParams(location.search).get('next')) || '/me';
    } else if (msgEl) {
      msgEl.className = 'form-msg error';
      msgEl.textContent = r.message || 'Sign-in failed. Please try again.';
    }
  }

  /* Telegram Mini App: initData arrives in the URL hash when opened from the bot. */
  function miniApp() {
    if (location.hash.indexOf('tgWebAppData') === -1 && !/tgWebApp/.test(location.search)) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://telegram.org/js/telegram-web-app.js';
      s.onload = function () {
        var wa = window.Telegram && window.Telegram.WebApp;
        if (!wa || !wa.initData) return resolve(false);
        wa.ready();
        api('POST', '/api/auth/telegram', { initData: wa.initData }).then(function (r) {
          if (r.ok) state.csrf = r.csrf;
          var start = wa.initDataUnsafe && wa.initDataUnsafe.start_param;
          if (r.ok && start && /^event_[a-z0-9-]+$/.test(start) && location.pathname === '/') {
            location.replace('/events/' + start.slice(6));
          }
          resolve(r.ok);
        });
      };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  /* Telegram Login Widget on /signin */
  var widget = $('[data-tg-widget]');
  if (widget) {
    var age = $('[data-age-confirm]');
    var msg = $('[data-signin-msg]');
    var sync = function () { widget.setAttribute('aria-disabled', age.checked ? 'false' : 'true'); };
    age.addEventListener('change', sync); sync();
    window.smTelegramAuth = function (user) {
      if (!age.checked) { msg.className = 'form-msg error'; msg.textContent = 'Please confirm you are 21 or older first.'; return; }
      api('POST', '/api/auth/telegram', { widget: user, ageConfirmed: true }).then(function (r) { afterAuth(r, msg); });
    };
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', widget.getAttribute('data-bot'));
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '22');
    s.setAttribute('data-request-access', 'write');
    s.setAttribute('data-onauth', 'smTelegramAuth(user)');
    widget.appendChild(s);
  }

  /* Dev-only sign-in (server refuses it on Vercel). */
  var dev = $('[data-dev-login]');
  if (dev) dev.addEventListener('click', function () {
    api('POST', '/api/auth/dev', { ageConfirmed: true }).then(function (r) { afterAuth(r, $('[data-signin-msg]')); });
  });

  function confirmAge() {
    if (!window.confirm('StrangersMeetup events are for adults only. Do you confirm you are 21 or older?')) return Promise.resolve(false);
    return api('POST', '/api/auth/confirm-age', {}).then(function (r) { return r.ok; });
  }

  /* ---------- booking ---------- */
  function book(btn) {
    var msg = $('[data-book-msg]');
    var eventId = btn.getAttribute('data-book');
    track('book_click', eventId);
    if (!state.me) return goSignin();
    btn.disabled = true;
    msg.className = 'book-msg'; msg.textContent = 'Preparing secure checkout…';
    api('POST', '/api/bookings', { eventId: eventId }).then(function (r) {
      if (r.status === 403 && r.error === 'age_required') {
        return confirmAge().then(function (ok) { btn.disabled = false; msg.textContent = ''; if (ok) book(btn); });
      }
      if (r.ok && /^https:\/\//.test(r.checkoutUrl || '')) { track('checkout_start', eventId); location.href = r.checkoutUrl; return; }
      if (r.ok && r.bookingId) { location.href = '/bookings/' + r.bookingId; return; }
      if (r.status === 401) return goSignin();
      btn.disabled = false;
      msg.className = 'book-msg error';
      msg.textContent = r.message || 'Could not start checkout. Please try again.';
    });
  }
  $$('[data-book]').forEach(function (b) { b.addEventListener('click', function () { book(b); }); });
  if ($('[data-book]')) track('event_view', $('[data-book]').getAttribute('data-book'));

  /* ---------- membership (Telegram Stars) ---------- */
  $$('[data-join-tier]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!state.me) return goSignin();
      b.disabled = true;
      api('POST', '/api/membership/checkout', { tierCode: b.getAttribute('data-join-tier') }).then(function (r) {
        b.disabled = false;
        if (!r.ok) { window.alert(r.message || 'Membership is not available yet.'); return; }
        var wa = window.Telegram && window.Telegram.WebApp;
        if (!/^https:\/\/t\.me\//.test(r.invoiceLink || '')) { window.alert('Membership is not available yet.'); return; }
        if (wa && wa.openInvoice) wa.openInvoice(r.invoiceLink); else location.href = r.invoiceLink;
      });
    });
  });

  /* ---------- lead forms ---------- */
  $$('[data-lead-form]').forEach(function (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msg = $('[data-form-msg]', form);
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = v; });
      $$('.field-error', form).forEach(function (f) { f.classList.remove('field-error'); });
      var btn = $('button[type=submit]', form); btn.disabled = true;
      api('POST', form.getAttribute('action'), data).then(function (r) {
        btn.disabled = false;
        if (r.ok) { form.reset(); msg.className = 'form-msg ok'; msg.textContent = r.message || 'Thank you — we will be in touch.'; return; }
        msg.className = 'form-msg error';
        msg.textContent = r.message || 'Something went wrong. Please try again.';
        (r.fields || []).forEach(function (f) { var el = form.querySelector('[name="' + f.field + '"]'); if (el && el.parentNode) el.parentNode.classList.add('field-error'); });
      });
    });
  });

  /* ---------- member pages ---------- */
  function fmt(iso) {
    try { return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); } catch (e) { return iso; }
  }
  var STATUS = { pending_payment: 'Awaiting payment confirmation', confirmed: 'Confirmed', checked_in: 'Checked in', cancelled: 'Cancelled', refunded: 'Refunded' };

  function renderBookings(el) {
    api('GET', '/api/me/bookings').then(function (r) {
      if (r.status === 401) return goSignin();
      var list = r.bookings || [];
      if (!list.length) { el.innerHTML = '<p>No bookings yet.</p><p><a class="link-arrow" href="/#upcoming">Find an event</a></p>'; return; }
      el.innerHTML = '<ul class="booking-list">' + list.map(function (b) {
        return '<li><p class="card-meta"><span>' + esc(STATUS[b.status] || b.status) + '</span><span>' + esc(b.city) + '</span></p>' +
          '<h3><a href="/bookings/' + esc(b.id) + '">' + esc(b.title) + '</a></h3><p class="muted">' + esc(fmt(b.startAt)) + '</p></li>';
      }).join('') + '</ul>';
    });
  }

  function renderStatus(el) {
    var id = el.getAttribute('data-booking-status');
    var tries = 0;
    var tick = function () {
      api('GET', '/api/bookings/' + encodeURIComponent(id)).then(function (r) {
        if (r.status === 401) return goSignin();
        if (!r.ok) { el.innerHTML = '<p>We could not find that booking.</p>'; return; }
        var b = r.booking;
        var html = '<p class="card-meta"><span>' + esc(STATUS[b.status] || b.status) + '</span>' + (b.isTest ? '<span>Test mode</span>' : '') + '</p>' +
          '<h2>' + esc(b.title) + '</h2><p class="muted">' + esc(fmt(b.startAt)) + ' · ' + esc(b.city) + '</p>';
        if (b.status === 'pending_payment') {
          html += '<p>We are waiting for the payment provider to confirm your payment. This page updates automatically.</p>';
          if (b.checkoutUrl && b.holdActive) html += '<p><a class="btn btn-primary" href="' + safeUrl(b.checkoutUrl) + '">Return to checkout</a></p>';
          if (!b.holdActive) html += '<p class="muted">Your seat hold has expired. If you already paid, we will confirm or refund it automatically.</p>';
        } else if (b.status === 'confirmed' || b.status === 'checked_in') {
          html += '<p><strong>You are in.</strong> ' + (b.venue ? 'Venue: ' + esc(b.venue) + '. ' : '') + 'Your confirmation and private group invite are sent by our Telegram bot.</p>';
          if (b.invite) html += '<p><a class="btn btn-tg" href="' + safeUrl(b.invite.link) + '" rel="noopener">Join the private group</a></p><p class="muted">Single-use invite, valid until ' + esc(fmt(b.invite.expiresAt)) + '.</p>';
          if (BOT) html += '<p><a class="link-arrow" href="https://t.me/' + esc(BOT) + '?start=booking_' + esc(b.id) + '">Open the bot to get a fresh invite</a></p>';
        } else if (b.status === 'refunded') {
          html += '<p>This booking was refunded to your original payment method.</p>';
        }
        el.innerHTML = html;
        if (b.status === 'pending_payment' && tries++ < 40) setTimeout(tick, 3000);
      });
    };
    tick();
  }

  var signout = $('[data-signout]');
  if (signout) signout.addEventListener('click', function () { api('POST', '/api/auth/logout', {}).then(function () { location.href = '/'; }); });

  /* ---------- voluntary profile ---------- */
  var LABELS = {
    female: 'Woman', male: 'Man', non_binary: 'Non-binary', prefer_not_to_say: 'Prefer not to say',
    '21_24': '21–24', '25_29': '25–29', '30_34': '30–34', '35_39': '35–39', '40_plus': '40+',
    nightlife: 'Nightlife', strangers_trips: 'Strangers trips', meetups: 'Meetups', dinners: 'Dinners', weekend_parties: 'Weekend parties',
    dating: 'Dating', matchmaking: 'Matchmaking', board_games: 'Board games', movies: 'Movies'
  };
  function renderProfile(el) {
    api('GET', '/api/me/profile').then(function (r) {
      if (!r.ok) { el.hidden = true; return; }
      var p = r.profile, o = r.options;
      var sel = function (name, opts, cur) {
        return '<label class="field"><span>' + esc(name === 'gender' ? 'Gender' : name === 'age_band' ? 'Age' : 'City') + '</span><select name="' + name + '"><option value="">Not shared</option>' +
          opts.map(function (v) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(LABELS[v] || v) + '</option>'; }).join('') + '</select></label>';
      };
      el.innerHTML = '<form class="lead-form" data-profile-form><h2>About you (optional)</h2>' +
        '<p class="muted">Helps us plan the right events. Every field is optional, only shown to our team as anonymous totals, and you can clear it any time.</p>' +
        sel('gender', o.genders, p.gender) + sel('age_band', o.ageBands, p.ageBand) + sel('city', o.cities, p.city) +
        '<fieldset class="field"><legend>Interests</legend>' + o.interests.map(function (v) {
          return '<label class="check"><input type="checkbox" name="interests" value="' + esc(v) + '"' + (p.interests.indexOf(v) !== -1 ? ' checked' : '') + '> <span>' + esc(LABELS[v] || v) + '</span></label>';
        }).join('') + '</fieldset>' +
        '<button class="btn btn-ghost" type="submit">Save</button> <p class="form-msg" role="status" aria-live="polite" data-profile-msg></p></form>';
      var form = $('[data-profile-form]', el);
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var body = { gender: form.gender.value || null, age_band: form.age_band.value || null, city: form.city.value || null,
          interests: $$('input[name=interests]:checked', form).map(function (i) { return i.value; }) };
        api('PATCH', '/api/me/profile', body).then(function (res) {
          var m = $('[data-profile-msg]', form);
          m.className = 'form-msg ' + (res.ok ? 'ok' : 'error');
          m.textContent = res.ok ? 'Saved.' : (res.message || 'Could not save. Please try again.');
        });
      });
    });
  }

  miniApp().then(refreshMe).then(function () {
    var pf = $('[data-profile]'); if (pf && state.me) renderProfile(pf);
    var mb = $('[data-my-bookings]'); if (mb) renderBookings(mb);
    var bs = $('[data-booking-status]'); if (bs) renderStatus(bs);
  });
})();
