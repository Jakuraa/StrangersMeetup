/* NIGHTLIFEZ site script. Progressive enhancement: every page works without it except
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
  function setMenu(open) {
    $('#site-nav').classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (toggle) {
    toggle.addEventListener('click', function () { setMenu(toggle.getAttribute('aria-expanded') !== 'true'); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setMenu(false); toggle.focus(); }
    });
    $('#site-nav').addEventListener('click', function (ev) { if (ev.target.closest('a')) setMenu(false); });
  }

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
      $$('[data-auth-button], [data-nav-auth-link]').forEach(function (a) {
        if (state.me) {
          if (state.me.onboardingCompleted) {
            a.textContent = 'My bookings';
            a.setAttribute('aria-label', 'My bookings');
            a.setAttribute('href', '/me');
            if (a.hasAttribute('data-auth-button')) {
              a.classList.remove('btn-tg', 'btn-primary');
              a.classList.add('btn-ghost');
            }
          } else {
            a.textContent = 'Complete Profile';
            a.setAttribute('aria-label', 'Complete onboarding profile');
            a.setAttribute('href', '/onboarding');
            if (a.hasAttribute('data-auth-button')) {
              a.classList.remove('btn-tg', 'btn-ghost');
              a.classList.add('btn-primary');
            }
          }
        } else {
          if (a.hasAttribute('data-nav-auth-link')) {
            a.textContent = 'Sign in';
            a.setAttribute('href', '/signin');
          }
          if (a.hasAttribute('data-auth-button')) {
            a.textContent = 'Continue with Telegram';
            a.setAttribute('aria-label', 'Continue with Telegram');
            a.setAttribute('href', '/signin');
            a.classList.remove('btn-ghost', 'btn-primary');
            a.classList.add('btn-tg');
          }
        }
      });
      $$('[data-nav-signout-li]').forEach(function (el) {
        el.hidden = !state.me;
      });
      $$('[data-bottom-nav]').forEach(function (bNav) {
        if (location.pathname === '/onboarding' || location.pathname === '/signin') {
          bNav.hidden = true;
        } else {
          bNav.hidden = false;
        }
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
      var target = sameOriginPath(new URLSearchParams(location.search).get('next')) || '/me';
      if (r.redirect) {
        location.href = r.redirect;
      } else if (r.user && !r.user.onboardingCompleted) {
        location.href = '/onboarding' + (target !== '/me' ? '?next=' + encodeURIComponent(target) : '');
      } else {
        location.href = target;
      }
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

  /* Switcher for WhatsApp vs Telegram tabs on /signin */
  var authTabs = $$('[data-auth-tab]');
  if (authTabs.length) {
    authTabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.getAttribute('data-auth-tab');
        authTabs.forEach(function (t) {
          var isActive = t === tab;
          t.classList.toggle('active', isActive);
          t.classList.toggle('wa-tab', isActive && target === 'whatsapp');
          t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        $$('[data-auth-panel]').forEach(function (panel) {
          panel.hidden = panel.getAttribute('data-auth-panel') !== target;
        });
      });
    });
  }

  /* Shortcut to switch to Telegram tab from unavailable card */
  $$('[data-switch-to-telegram]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tgTab = $('[data-auth-tab="telegram"]');
      if (tgTab) tgTab.click();
    });
  });

  /* WhatsApp OTP Authentication on /signin */
  var waPhoneForm = $('[data-wa-phone-form]');
  var waOtpCard = $('[data-wa-otp-card]');
  if (waPhoneForm && waOtpCard) {
    // Defense-in-depth: scrub any legacy sensitive query parameters from browser address bar
    try {
      if (window.history && window.history.replaceState && location.search) {
        var currentParams = new URLSearchParams(location.search);
        var sensitiveKeys = ['phone', 'ageConfirmed', 'promotionalOptIn', 'otp', 'code'];
        var hasSensitive = false;
        sensitiveKeys.forEach(function (k) {
          if (currentParams.has(k)) {
            currentParams.delete(k);
            hasSensitive = true;
          }
        });
        if (hasSensitive) {
          var cleanSearch = currentParams.toString();
          var cleanUrl = location.pathname + (cleanSearch ? '?' + cleanSearch : '') + location.hash;
          window.history.replaceState(null, document.title, cleanUrl);
        }
      }
    } catch (e) { /* ignore */ }

    var signinMsg = $('[data-signin-msg]');
    var currentChallengeId = null;
    var currentPhone = null;
    var currentPromoOptIn = false;
    var countdownTimer = null;
    var otpAbortController = null;

    var stopSmsOtpListener = function () {
      if (otpAbortController) {
        otpAbortController.abort();
        otpAbortController = null;
      }
    };

    var startSmsOtpListener = function () {
      var otpInput = document.getElementById('otp-input');
      var otpForm = document.getElementById('otp-form');
      if (!otpInput || !('OTPCredential' in window)) return;
      stopSmsOtpListener();
      var ac = new AbortController();
      otpAbortController = ac;
      navigator.credentials.get({
        otp: { transport: ['sms'] },
        signal: ac.signal
      }).then(function (otp) {
        if (!otp) return;
        otpInput.value = otp.code;
        if (otpForm && otpForm.requestSubmit) {
          otpForm.requestSubmit();
        }
      }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        console.error('WebOTP verification error:', err);
      });
    };

    var startCountdown = function (seconds) {
      if (countdownTimer) clearInterval(countdownTimer);
      var resendBtn = $('[data-wa-resend-btn]');
      if (!resendBtn) return;
      resendBtn.disabled = true;
      var remaining = seconds || 60;
      resendBtn.textContent = 'Resend code (' + remaining + 's)';
      countdownTimer = setInterval(function () {
        remaining--;
        if (remaining <= 0) {
          clearInterval(countdownTimer);
          countdownTimer = null;
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend code via WhatsApp';
        } else {
          resendBtn.textContent = 'Resend code (' + remaining + 's)';
        }
      }, 1000);
    };

    waPhoneForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var phoneInput = $('#wa-phone');
      var ageCheck = $('[data-wa-age]');
      var promoCheck = $('[data-wa-promo]');
      var submitBtn = $('[data-wa-submit-phone]');

      if (!ageCheck.checked) {
        signinMsg.className = 'form-msg error';
        signinMsg.textContent = 'Please confirm you are 21 or older to continue.';
        return;
      }

      var rawDigits = phoneInput.value.replace(/\D/g, '');
      if (rawDigits.length !== 10 || !/^[6-9]/.test(rawDigits)) {
        signinMsg.className = 'form-msg error';
        signinMsg.textContent = 'Please enter a valid 10-digit Indian mobile number (starts with 6-9).';
        phoneInput.focus();
        return;
      }

      var fullPhone = '+91' + rawDigits;
      currentPhone = fullPhone;
      currentPromoOptIn = Boolean(promoCheck && promoCheck.checked);

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending WhatsApp OTP…';
      signinMsg.className = 'form-msg';
      signinMsg.textContent = '';

      api('POST', '/api/auth/whatsapp/otp', {
        phone: fullPhone,
        promotionalOptIn: currentPromoOptIn
      }).then(function (r) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send WhatsApp OTP';

        if (!r.ok) {
          signinMsg.className = 'form-msg error';
          signinMsg.textContent = r.message || 'Failed to send WhatsApp OTP. Please try again.';
          return;
        }

        currentChallengeId = r.challengeId;
        var maskedEl = $('[data-wa-masked-phone]');
        if (maskedEl) maskedEl.textContent = r.phoneMasked || fullPhone;

        var phoneStep = $('[data-wa-step="phone"]');
        if (phoneStep) phoneStep.hidden = true;
        waOtpCard.hidden = false;

        var otpInput = $('#otp-input');
        if (otpInput) {
          otpInput.value = '';
          otpInput.focus();
        }

        startCountdown(r.resendAfterSeconds || 60);
        startSmsOtpListener();
      }).catch(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send WhatsApp OTP';
        signinMsg.className = 'form-msg error';
        signinMsg.textContent = 'Network error while requesting OTP. Please try again.';
      });
    });

    var verifyForm = $('[data-wa-verify-form]');
    if (verifyForm) {
      verifyForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        stopSmsOtpListener();

        var otpInput = $('#otp-input');
        var verifyBtn = $('[data-wa-verify-btn]');
        var code = (otpInput.value || '').trim();

        if (!/^\d{6}$/.test(code)) {
          signinMsg.className = 'form-msg error';
          signinMsg.textContent = 'Please enter the complete 6-digit verification code.';
          otpInput.focus();
          return;
        }

        verifyBtn.disabled = true;
        verifyBtn.textContent = 'Verifying code…';
        signinMsg.className = 'form-msg';
        signinMsg.textContent = '';

        api('POST', '/api/auth/whatsapp/verify', {
          challengeId: currentChallengeId,
          phone: currentPhone,
          code: code,
          promotionalOptIn: currentPromoOptIn
        }).then(function (r) {
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify & Continue';

          if (!r.ok) {
            signinMsg.className = 'form-msg error';
            signinMsg.textContent = r.message || 'Invalid or expired OTP code.';
            otpInput.value = '';
            otpInput.focus();
            return;
          }

          afterAuth(r, signinMsg);
        }).catch(function () {
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify & Continue';
          signinMsg.className = 'form-msg error';
          signinMsg.textContent = 'Network error while verifying OTP.';
        });
      });
    }

    var changePhoneBtn = $('[data-wa-change-phone]');
    if (changePhoneBtn) {
      changePhoneBtn.addEventListener('click', function () {
        stopSmsOtpListener();
        if (countdownTimer) clearInterval(countdownTimer);
        currentChallengeId = null;
        currentPhone = null;
        try {
          var isHttps = location.protocol === 'https:';
          document.cookie = 'sm_wa_step=; path=/; max-age=0; samesite=lax' + (isHttps ? '; secure' : '');
        } catch (e) { /* ignore */ }
        waOtpCard.hidden = true;
        var phoneStep = $('[data-wa-step="phone"]');
        if (phoneStep) phoneStep.hidden = false;
        var phoneInput = $('#wa-phone');
        if (phoneInput) {
          phoneInput.focus();
          if (phoneInput.select) phoneInput.select();
        }
        var maskedEl = $('[data-wa-masked-phone]');
        if (maskedEl) maskedEl.textContent = '';
        var otpInput = $('#otp-input');
        if (otpInput) otpInput.value = '';
        signinMsg.className = 'form-msg';
        signinMsg.textContent = '';
      });
    }

    var resendBtn = $('[data-wa-resend-btn]');
    if (resendBtn) {
      resendBtn.addEventListener('click', function () {
        if (!currentPhone) return;
        resendBtn.disabled = true;
        resendBtn.textContent = 'Sending new OTP…';
        api('POST', '/api/auth/whatsapp/otp', {
          phone: currentPhone,
          promotionalOptIn: currentPromoOptIn
        }).then(function (r) {
          if (!r.ok) {
            signinMsg.className = 'form-msg error';
            signinMsg.textContent = r.message || 'Could not resend OTP. Please wait before retrying.';
            resendBtn.disabled = false;
            resendBtn.textContent = 'Resend code via WhatsApp';
            return;
          }
          currentChallengeId = r.challengeId;
          startCountdown(r.resendAfterSeconds || 60);
          startSmsOtpListener();
          signinMsg.className = 'form-msg ok';
          signinMsg.textContent = 'A new 6-digit code has been sent to your WhatsApp.';
        });
      });
    }
  }

  /* Telegram Login Widget on /signin — Explicit user initiation flow */
  var widget = $('[data-tg-widget]');
  var tgStartBtn = $('[data-tg-start-btn]');
  if (widget) {
    var age = $('[data-age-confirm]');
    var msg = $('[data-signin-msg]');
    var actionWrap = $('[data-tg-action-wrap]');
    var widgetWrap = $('[data-tg-widget-wrap]');
    var loadingEl = $('[data-tg-widget-loading]');
    var widgetInjected = false;
    var widgetLoading = false;
    var pendingUser = null;

    var doAuth = function (u) {
      if (msg) {
        msg.className = 'form-msg';
        msg.textContent = 'Verifying Telegram sign-in…';
      }
      api('POST', '/api/auth/telegram', { widget: u, ageConfirmed: true }).then(function (r) {
        afterAuth(r, msg);
      });
    };

    var sync = function () {
      widget.setAttribute('aria-disabled', age && age.checked ? 'false' : 'true');
      if (age && age.checked && pendingUser) {
        var u = pendingUser;
        pendingUser = null;
        doAuth(u);
      }
    };
    if (age) age.addEventListener('change', sync);

    window.smTelegramAuth = function (user) {
      if (!age || !age.checked) {
        pendingUser = user;
        if (msg) {
          msg.className = 'form-msg error';
          msg.textContent = 'Please confirm you are 21 or older above to complete sign-in.';
        }
        return;
      }
      doAuth(user);
    };

    function startTelegramLogin() {
      if (widgetInjected || widgetLoading) return;

      // 1. Explicit 21+ age confirmation required before loading widget
      if (!age || !age.checked) {
        if (msg) {
          msg.className = 'form-msg error';
          msg.textContent = 'Please confirm you are 21 or older to continue with Telegram.';
          msg.setAttribute('data-tg-error', '');
        }
        if (age) age.focus();
        return;
      }

      if (msg) {
        msg.className = 'form-msg';
        msg.textContent = '';
        msg.removeAttribute('data-tg-error');
      }

      widgetLoading = true;
      if (tgStartBtn) tgStartBtn.disabled = true;
      if (actionWrap) actionWrap.hidden = true;
      if (widgetWrap) widgetWrap.hidden = false;
      if (loadingEl) loadingEl.hidden = false;

      // 2. Generate secure state nonce for CSRF & replay protection
      var stateNonce = '';
      if (window.crypto && window.crypto.getRandomValues) {
        var arr = new Uint8Array(16);
        window.crypto.getRandomValues(arr);
        stateNonce = Array.from(arr, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      } else {
        stateNonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }
      var isHttps = location.protocol === 'https:';
      document.cookie = 'sm_tg_state=' + encodeURIComponent(stateNonce) + '; path=/; max-age=600; samesite=lax' + (isHttps ? '; secure' : '');
      document.cookie = 'sm_tg_state=' + encodeURIComponent(stateNonce) + '; path=/auth/telegram; max-age=600; samesite=lax' + (isHttps ? '; secure' : '');

      var targetNext = sameOriginPath(new URLSearchParams(location.search).get('next')) || '/me';
      var callbackUrl = window.location.origin + '/auth/telegram/widget-callback?state=' + encodeURIComponent(stateNonce) + '&next=' + encodeURIComponent(targetNext);

      // 3. Inject Telegram widget script only upon explicit user click
      var existingScript = widget.querySelector('script[src*="telegram-widget.js"]');
      if (!existingScript) {
        var s = document.createElement('script');
        s.async = true;
        s.src = 'https://telegram.org/js/telegram-widget.js?22';
        s.setAttribute('data-telegram-login', widget.getAttribute('data-bot'));
        s.setAttribute('data-size', 'large');
        s.setAttribute('data-radius', '22');
        s.setAttribute('data-request-access', 'write');
        s.setAttribute('data-auth-url', callbackUrl);
        s.setAttribute('data-onauth', 'smTelegramAuth(user)');

        s.onerror = function () {
          widgetLoading = false;
          widgetInjected = false;
          if (loadingEl) loadingEl.hidden = true;
          if (actionWrap) actionWrap.hidden = false;
          if (tgStartBtn) tgStartBtn.disabled = false;
          if (widgetWrap) widgetWrap.hidden = true;
          if (msg) {
            msg.className = 'form-msg error';
            msg.textContent = 'Unable to connect to Telegram. Please check your internet connection and try again.';
          }
        };

        s.onload = function () {
          widgetInjected = true;
          widgetLoading = false;
          setTimeout(function () {
            if (loadingEl) loadingEl.hidden = true;
          }, 1500);
        };

        widget.appendChild(s);
      }

      try {
        var obs = new MutationObserver(function () {
          var ifr = widget.querySelector('iframe');
          if (ifr) {
            widgetInjected = true;
            widgetLoading = false;
            if (loadingEl) loadingEl.hidden = true;
            if (!ifr.getAttribute('title')) {
              ifr.setAttribute('title', 'Log in with Telegram');
            }
          }
        });
        obs.observe(widget, { childList: true, subtree: true });
      } catch (e) { /* ignore */ }
    }

    if (tgStartBtn) {
      tgStartBtn.addEventListener('click', startTelegramLogin);
    }
  }

  /* Local test personas (the server returns 404 unless persona sign-in is enabled on this machine). */
  $$('[data-dev-login]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var msg = $('[data-signin-msg]');
      api('POST', '/api/auth/dev', { persona: btn.getAttribute('data-dev-login') }).then(function (r) {
        if (r.ok && r.landing) { location.href = sameOriginPath(new URLSearchParams(location.search).get('next')) || r.landing; return; }
        msg.className = 'form-msg error'; msg.textContent = r.message || 'Persona sign-in failed.';
      });
    });
  });

  function confirmAge() {
    if (!window.confirm('NIGHTLIFEZ events are for adults only. Do you confirm you are 21 or older?')) return Promise.resolve(false);
    return api('POST', '/api/auth/confirm-age', {}).then(function (r) { return r.ok; });
  }

  /* ---------- booking ---------- */
  /* Paid tickets are bought on SuperProfile, on the website only: the buy link carries data-web-only and
     is hidden inside the Telegram Mini App (see "inside Telegram?" above). */
  $$('[data-sp-buy]').forEach(function (a) {
    var id = a.getAttribute('data-sp-buy');
    track('event_view', id);
    a.addEventListener('click', function () { track('checkout_start', id); });
  });

  /* ---------- organiser events: choose a ticket tier ---------- */
  $$('[data-tier-form]').forEach(function (form) {
    var eventId = form.getAttribute('data-tier-form');
    if (!eventId) return; /* draft preview: booking is switched off */
    var qty = $('[data-qty]', form);
    var eligWrap = $('[data-elig-wrap]', form);
    var msg = $('[data-book-msg]', form);
    var btn = $('button[type="submit"]', form);
    track('event_view', eventId);
    function syncTier() {
      var r = $('input[name="ticketTypeId"]:checked', form);
      if (!r) return;
      var max = parseInt(r.getAttribute('data-max'), 10) || 1;
      var cur = Math.min(parseInt(qty.value, 10) || 1, max);
      qty.innerHTML = '';
      for (var i = 1; i <= max; i++) { var o = document.createElement('option'); o.value = String(i); o.textContent = String(i); o.selected = i === cur; qty.appendChild(o); }
      var elig = r.getAttribute('data-elig') || '';
      eligWrap.hidden = !elig;
      $('[data-elig-text]', form).textContent = elig;
      if (!elig) $('input[name="eligibilityConfirmed"]', form).checked = false;
    }
    form.addEventListener('change', function (ev) { if (ev.target.name === 'ticketTypeId') syncTier(); });
    function submit() {
      var r = $('input[name="ticketTypeId"]:checked', form);
      $$('.field-error', form).forEach(function (f) { f.classList.remove('field-error'); });
      if (!r) { msg.className = 'book-msg error'; msg.textContent = 'Choose a ticket first.'; return; }
      track('book_click', eventId);
      if (r.getAttribute('data-paid')) {
        /* Paid tier: hand over to SuperProfile (works signed out). Not available inside the Mini App. */
        var path = form.getAttribute('data-checkout-path');
        if (inTelegram || !path) { msg.className = 'book-msg error'; msg.textContent = 'Paid tickets are sold on our website. Open NIGHTLIFEZ in your browser to book.'; return; }
        track('checkout_start', eventId);
        location.href = path + '?tier=' + encodeURIComponent(r.value) + '&qty=' + encodeURIComponent(parseInt(qty.value, 10) || 1);
        return;
      }
      if (!state.me) return goSignin();
      var body = { ticketTypeId: r.value, quantity: parseInt(qty.value, 10) || 1, answers: {} };
      if (!eligWrap.hidden) body.eligibilityConfirmed = $('input[name="eligibilityConfirmed"]', form).checked;
      var pk = $('[name="pickupPointId"]', form);
      if (pk) body.pickupPointId = pk.value || null;
      $$('[name^="answers."]', form).forEach(function (inp) {
        var k = inp.name.slice(8);
        if (inp.type === 'checkbox') { body.answers[k] = body.answers[k] || []; if (inp.checked) body.answers[k].push(inp.value); }
        else if (inp.type === 'radio') { if (inp.checked) body.answers[k] = inp.value; }
        else if (inp.value.trim()) body.answers[k] = inp.value;
      });
      btn.disabled = true;
      msg.className = 'book-msg'; msg.textContent = 'One moment…';
      api('POST', '/api/events/' + encodeURIComponent(eventId) + '/book', body).then(function (res) {
        if (res.status === 401) return goSignin();
        if (res.status === 403 && res.error === 'age_required') {
          return confirmAge().then(function (ok) { btn.disabled = false; msg.textContent = ''; if (ok) submit(); });
        }
        if (!res.ok) {
          btn.disabled = false;
          msg.className = 'book-msg error';
          msg.textContent = res.message || 'Could not book. Please try again.';
          (res.fields || []).forEach(function (f) {
            var n = form.querySelector('[data-field="' + f.field + '"]') || (form.querySelector('[name="' + f.field + '"]') || {}).parentNode;
            if (n && n.classList) n.classList.add('field-error');
          });
          return;
        }
        location.href = '/bookings/' + encodeURIComponent(res.bookingId) + (res.existing ? '?existing=1' : '');
      });
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); submit(); });
  });

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
  var STATUS = { pending_approval: 'Request sent — awaiting the host', declined: 'Not accepted', pending_payment: 'Awaiting payment confirmation', confirmed: 'Confirmed', checked_in: 'Checked in', cancelled: 'Cancelled', refunded: 'Refunded' };
  var PAYMENT = { not_required: 'No payment needed', created: 'Waiting for the payment provider to confirm', paid: 'Paid', failed: 'Payment failed', refunded: 'Refunded' };

  var currentBookingFilter = 'all';
  var allBookingsCache = [];

  function filterAndDisplayBookings(el, filter) {
    currentBookingFilter = filter || 'all';
    var list = allBookingsCache;
    var filtered = list.filter(function (b) {
      if (currentBookingFilter === 'upcoming') return !b.isPast;
      if (currentBookingFilter === 'past') return b.isPast;
      return true;
    });

    if (!list.length) {
      el.innerHTML = '<div class="empty-state bookings-empty-state">' +
        '<div class="empty-state-icon" aria-hidden="true">🎟️</div>' +
        '<p class="empty-state-title">No bookings yet</p>' +
        '<p class="muted">When you reserve a spot for a meetup, dinner, party or trip, your digital passes and secret venue locations will be saved here.</p>' +
        '<p><a class="btn btn-primary btn-sm" href="/events">Explore upcoming events</a></p>' +
        '</div>';
      return;
    }

    if (!filtered.length) {
      el.innerHTML = '<div class="empty-state"><p class="empty-state-title">No ' + esc(currentBookingFilter) + ' bookings</p><p class="muted">You do not have any ' + esc(currentBookingFilter) + ' bookings.</p></div>';
      return;
    }

    el.innerHTML = '<ul class="booking-list">' + filtered.map(function (b) {
      var shortRef = b.id ? b.id.slice(0, 8).toUpperCase() : '';
      var checkinNotice = b.isCheckedIn ? '<span class="pill pill-checked_in" style="margin-left:6px;">✓ Checked In</span>' : '';
      return '<li class="booking-card-item">' +
        '<div class="booking-card-top">' +
        '<div><span class="pill pill-' + esc(b.status) + '">' + esc(STATUS[b.status] || b.status) + '</span>' + checkinNotice + '</div>' +
        '<span class="muted small">#SM-' + esc(shortRef) + '</span>' +
        '</div>' +
        '<h3><a href="/bookings/' + esc(b.id) + '">' + esc(b.title) + '</a></h3>' +
        '<p class="muted">' + esc(fmt(b.startAt)) + ' · ' + esc(b.city) + '</p>' +
        '<div class="booking-card-actions">' +
        '<a class="btn btn-outline-cyan btn-sm" href="/bookings/' + esc(b.id) + '">View Pass &amp; Venue →</a>' +
        (b.slug ? '<a class="btn btn-ghost btn-sm" href="/events/' + esc(b.slug) + '">Event Details</a>' : '') +
        '</div>' +
        '</li>';
    }).join('') + '</ul>';
  }

  function renderBookings(el) {
    api('GET', '/api/me/bookings').then(function (r) {
      if (r.status === 401) return goSignin();
      allBookingsCache = r.bookings || [];
      filterAndDisplayBookings(el, currentBookingFilter);
    });
  }

  function renderSavedEvents(el) {
    api('GET', '/api/me/saved-events').then(function (r) {
      if (r.status === 401) return;
      var list = r.events || [];
      if (!list.length) {
        el.innerHTML = '<div class="empty-state saved-empty-state">' +
          '<div class="empty-state-icon" aria-hidden="true">🔖</div>' +
          '<p class="empty-state-title">No saved events yet</p>' +
          '<p class="muted">Tap the bookmark icon on any event to save it here for quick access later.</p>' +
          '<p><a class="btn btn-primary btn-sm" href="/events">Explore upcoming events</a></p>' +
          '</div>';
        return;
      }
      el.innerHTML = '<ul class="saved-events-grid card-grid">' + list.map(function (e) {
        var href = (e.isTrip ? '/trips/' : '/events/') + e.slug;
        return '<article class="card event-card" data-event-id="' + esc(e.id) + '">' +
          '<div class="card-body">' +
          '<p class="card-meta"><span>' + esc(e.categoryLabel || e.category) + '</span><span>' + esc(e.city) + '</span></p>' +
          '<h3 class="card-title"><a class="card-link" href="' + esc(href) + '">' + esc(e.title) + '</a></h3>' +
          '<p class="card-when">' + esc(fmt(e.startAt)) + (e.area ? ' · ' + esc(e.area) : '') + '</p>' +
          '<div class="card-foot">' +
          '<span class="price">' + esc(e.priceLabel || 'Free') + '</span>' +
          '<div style="display:flex; gap:6px;">' +
          '<a class="btn btn-sm btn-primary" href="' + esc(href) + '">View Details</a>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-unsave-event="' + esc(e.id) + '" title="Remove from saved">Remove</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</article>';
      }).join('') + '</ul>';
    });
  }

  function renderMyAnnouncements(el) {
    api('GET', '/api/me/announcements').then(function (r) {
      if (r.status === 401) return;
      var list = r.announcements || [];
      if (!list.length) {
        el.innerHTML = '<div class="empty-state announcements-empty-state">' +
          '<div class="empty-state-icon" aria-hidden="true">📢</div>' +
          '<p class="empty-state-title">No host announcements yet</p>' +
          '<p class="muted">Operational updates, venue reminders, and door announcements from hosts of your events will appear here.</p>' +
          '</div>';
        return;
      }
      el.innerHTML = '<div class="announcements-feed">' + list.map(function (a) {
        return '<div class="announcement-item' + (a.isPinned ? ' is-pinned' : '') + '">' +
          '<div class="announcement-head">' +
          '<strong>' + esc(a.eventTitle) + '</strong>' +
          '<span class="muted small">' + esc(fmt(a.createdAt)) + '</span>' +
          '</div>' +
          '<h4 class="announcement-title">' + (a.isPinned ? '📌 ' : '') + esc(a.title) + '</h4>' +
          '<p class="announcement-body">' + esc(a.message) + '</p>' +
          '<p class="muted small"><a href="/events/' + esc(a.eventSlug) + '">View event page →</a></p>' +
          '</div>';
      }).join('') + '</div>';
    });
  }

  function initAttendeeHub() {
    var hub = $('[data-attendee-hub]');
    if (!hub) return;
    var tabBtns = $$('[data-hub-tab]', hub);
    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-hub-tab');
        tabBtns.forEach(function (b) {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
        });
        $$('[data-hub-section]', hub).forEach(function (sec) {
          var isTarget = sec.getAttribute('data-hub-section') === tab;
          sec.hidden = !isTarget;
        });
        if (tab === 'account') {
          renderAccountSettings();
        }
      });
    });

    var accountBox = $('[data-account-settings]', hub);
    function renderAccountSettings() {
      if (!accountBox) return;
      accountBox.innerHTML = '<p class="muted">Loading connected accounts and preferences…</p>';
      Promise.all([
        api('GET', '/api/me/identities'),
        api('GET', '/api/me/communication-preferences')
      ]).then(function (results) {
        var idRes = results[0];
        var prefRes = results[1];
        if (!idRes.ok || !prefRes.ok) {
          accountBox.innerHTML = '<p class="form-msg error">Could not load account settings.</p>';
          return;
        }

        var wa = idRes.identities.whatsapp;
        var tg = idRes.identities.telegram;
        var prefs = prefRes.preferences;

        var html = '<div class="identity-card">' +
          '<h3 style="margin-bottom: 4px;">Connected Login Methods</h3>' +
          '<p class="muted" style="font-size: .88rem; margin-bottom: 12px;">Link both WhatsApp and Telegram to access your tickets and receive operational updates across either service.</p>' +
          '<div class="identity-row">' +
            '<div class="identity-meta">' +
              '<span class="identity-label">WhatsApp</span>' +
              '<span class="identity-status ' + (wa.linked ? 'connected' : '') + '">' +
                (wa.linked ? '✓ Connected (' + wa.phoneMasked + ')' : 'Not Connected') +
              '</span>' +
            '</div>' +
            '<div class="identity-action">' +
              (wa.linked
                ? (tg.linked ? '<button type="button" class="btn btn-ghost btn-sm" data-unlink-wa>Disconnect</button>' : '<span class="muted" style="font-size: .85rem;">Sole Login Method</span>')
                : '<a href="/signin" class="btn btn-wa btn-sm">Connect WhatsApp</a>') +
            '</div>' +
          '</div>' +
          '<div class="identity-row">' +
            '<div class="identity-meta">' +
              '<span class="identity-label">Telegram</span>' +
              '<span class="identity-status ' + (tg.linked ? 'connected' : '') + '">' +
                (tg.linked ? '✓ Connected (Telegram ID: ' + tg.telegramUserId + ')' : 'Not Connected') +
              '</span>' +
            '</div>' +
            '<div class="identity-action">' +
              (tg.linked
                ? '<span class="muted" style="font-size: .85rem;">Active</span>'
                : '<a href="/auth/telegram/start?next=/me" class="btn btn-tg btn-sm">Connect Telegram</a>') +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="identity-card" style="margin-top: 16px;">' +
          '<h3 style="margin-bottom: 4px;">Communication Preferences</h3>' +
          '<p class="muted" style="font-size: .88rem; margin-bottom: 12px;">Manage how and where NIGHTLIFEZ sends you notifications.</p>' +
          '<div class="identity-row">' +
            '<div class="identity-meta">' +
              '<span class="identity-label">Essential Transactional Notices</span>' +
              '<span class="muted" style="font-size: .82rem;">Booking confirmations, QR entry passes, and schedule changes.</span>' +
            '</div>' +
            '<div class="identity-action">' +
              '<span class="badge" style="background: rgba(37, 211, 102, 0.15); color: #25D366; font-size: .8rem; padding: 4px 10px; border-radius: 999px;">Always Active</span>' +
            '</div>' +
          '</div>' +
          '<div class="identity-row">' +
            '<div class="identity-meta">' +
              '<span class="identity-label">WhatsApp Event Announcements &amp; Promotional Offers</span>' +
              '<span class="muted" style="font-size: .82rem;">Curated weekend parties, secret meetups, and exclusive nightlife invites. Optional &amp; separate from transactional passes.</span>' +
            '</div>' +
            '<div class="identity-action">' +
              '<button type="button" class="btn btn-ghost btn-sm" data-toggle-promo-wa>' +
                (prefs.whatsapp && prefs.whatsapp.promotional ? '✓ Opted In' : 'Opted Out') +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>';

        accountBox.innerHTML = html;

        var unlinkBtn = $('[data-unlink-wa]', accountBox);
        if (unlinkBtn) {
          unlinkBtn.addEventListener('click', function () {
            if (!confirm('Are you sure you want to disconnect WhatsApp? You will need Telegram to sign in.')) return;
            api('POST', '/api/auth/whatsapp/unlink', {}).then(function (r) {
              if (r.ok) {
                renderAccountSettings();
              } else {
                alert(r.message || 'Could not disconnect WhatsApp.');
              }
            });
          });
        }

        var promoToggle = $('[data-toggle-promo-wa]', accountBox);
        if (promoToggle) {
          promoToggle.addEventListener('click', function () {
            var currentStatus = prefs.whatsapp && prefs.whatsapp.promotional;
            var nextStatus = currentStatus ? 'opted_out' : 'opted_in';
            api('PATCH', '/api/me/communication-preferences', {
              channel: 'whatsapp',
              purpose: 'promotional',
              status: nextStatus
            }).then(function (r) {
              if (r.ok) {
                renderAccountSettings();
              }
            });
          });
        }
      });
    }

    var filterBtns = $$('[data-booking-filter]', hub);
    filterBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var filter = btn.getAttribute('data-booking-filter');
        filterBtns.forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        var mb = $('[data-my-bookings]', hub);
        if (mb) filterAndDisplayBookings(mb, filter);
      });
    });
  }

  function initSaveEventHandlers() {
    document.addEventListener('click', function (ev) {
      var saveBtn = ev.target && ev.target.closest ? ev.target.closest('[data-save-event]') : null;
      if (saveBtn) {
        ev.preventDefault();
        var eventId = saveBtn.getAttribute('data-save-event');
        var isSaved = saveBtn.classList.contains('is-saved');
        if (!state.me) {
          return goSignin();
        }
        var nextState = !isSaved;
        var updateBtn = function (btn, saved) {
          btn.classList.toggle('is-saved', saved);
          btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
          btn.setAttribute('aria-label', saved ? 'Remove from saved events' : 'Save event');
          var svg = btn.querySelector('svg');
          if (svg) svg.setAttribute('fill', saved ? 'currentColor' : 'none');
          var span = btn.querySelector('span');
          if (span) span.textContent = saved ? 'Saved' : 'Save';
        };

        updateBtn(saveBtn, nextState);
        var method = nextState ? 'POST' : 'DELETE';
        api(method, '/api/events/' + encodeURIComponent(eventId) + '/save').then(function (r) {
          if (!r.ok) {
            updateBtn(saveBtn, isSaved);
          }
        }).catch(function () {
          updateBtn(saveBtn, isSaved);
        });
        return;
      }

      var unsaveBtn = ev.target && ev.target.closest ? ev.target.closest('[data-unsave-event]') : null;
      if (unsaveBtn) {
        ev.preventDefault();
        var eid = unsaveBtn.getAttribute('data-unsave-event');
        api('DELETE', '/api/events/' + encodeURIComponent(eid) + '/save').then(function (r) {
          if (r.ok) {
            var card = unsaveBtn.closest('.card');
            if (card) card.remove();
            var se = $('[data-saved-events]');
            if (se && !se.querySelectorAll('.card').length) {
              renderSavedEvents(se);
            }
          }
        });
        return;
      }
    });
  }

  function renderStatus(el) {
    var id = el.getAttribute('data-booking-status');
    var isExistingRedirect = new URLSearchParams(location.search).get('existing') === '1';
    var tries = 0;
    var tick = function () {
      api('GET', '/api/bookings/' + encodeURIComponent(id)).then(function (r) {
        if (r.status === 401) return goSignin();
        if (!r.ok) {
          el.innerHTML = '<div class="empty-state"><p class="empty-state-title">Booking not found</p><p class="muted">We could not find this booking. It may belong to another account or have expired.</p><p><a class="btn btn-primary btn-sm" href="/me">View your bookings</a> <a class="btn btn-ghost btn-sm" href="/events">Explore events</a></p></div>';
          return;
        }
        var b = r.booking;
        var shortRef = b.id ? b.id.slice(0, 8).toUpperCase() : '';
        var statusLabel = STATUS[b.status] || b.status;
        var html = '';
        if (isExistingRedirect) {
          html += '<div class="booking-notice booking-notice-info" role="status">' +
            '<span class="notice-icon" aria-hidden="true">ℹ️</span>' +
            '<div class="booking-notice-content">' +
            '<strong>You already hold a pass for this event</strong>' +
            '<p class="muted">Your existing booking pass and entry details are shown below.</p>' +
            '</div></div>';
        }

        html += '<div class="digital-pass-card">' +
          '<div class="digital-pass-header">' +
          '<div class="pass-brand"><span class="pass-badge-icon" aria-hidden="true">🎟️</span> <span>NIGHTLIFEZ Pass</span></div>' +
          '<span class="pill pill-' + esc(b.status) + '">' + esc(statusLabel) + '</span>' +
          '</div>' +
          '<div class="pass-ref"><span class="pass-label">Pass Reference</span><span class="pass-code">#SM-' + esc(shortRef) + '</span></div>' +
          '<h2 class="pass-title">' + esc(b.title) + '</h2>' +
          '<p class="pass-datetime">' + esc(fmt(b.startAt)) + ' · ' + esc(b.city) + '</p>';

        var facts = '';
        if (b.ticket) facts += '<div><dt>Ticket</dt><dd>' + esc(b.ticket.name) + ' × ' + esc(b.ticket.quantity) + (b.amountLabel ? ' · ' + esc(b.amountLabel) : '') + '</dd></div>';
        if (b.paymentStatus && PAYMENT[b.paymentStatus]) facts += '<div><dt>Payment</dt><dd>' + esc(PAYMENT[b.paymentStatus]) + '</dd></div>';
        if (b.pickup) facts += '<div><dt>Pickup</dt><dd>' + esc(b.pickup.name) + (b.pickup.location ? ' — ' + esc(b.pickup.location) : '') + (b.pickup.time ? ' · ' + esc(new Date(b.pickup.time + ':00Z').toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })) : '') + '</dd></div>';
        if (b.contact) facts += '<div><dt>On-ground contact</dt><dd>' + esc(b.contact.name || '') + ' · <a href="' + safeUrl(b.contact.whatsappUrl) + '" rel="noopener">WhatsApp ' + esc(b.contact.phone) + '</a></dd></div>';
        if (b.mapsUrl) facts += '<div><dt>Map</dt><dd><a href="' + safeUrl(b.mapsUrl) + '" target="_blank" rel="noopener nofollow">Open in Maps</a></dd></div>';
        if (facts) html += '<dl class="pass-facts">' + facts + '</dl>';

        if (b.status === 'pending_approval') {
          html += '<div class="mystery-venue-card"><p><span class="mystery-badge-icon" aria-hidden="true">🔒</span> <strong>Mystery Venue:</strong> The exact address will be unlocked here once your booking is approved by the host.</p></div>';
          html += '<p>The host reviews each request. You’ll get a Telegram message when they decide — nothing is charged before then.</p>';
        } else if (b.status === 'declined') {
          html += '<p>The host couldn’t accept your request this time. You have not been charged.</p>';
        } else if (b.status === 'pending_payment') {
          html += '<p>We are waiting for SuperProfile to confirm your payment. If you already paid, send <strong>/claim</strong> to our Telegram bot with your SuperProfile order ID.</p>';
        } else if (b.status === 'confirmed' || b.status === 'checked_in') {
          if (b.isCheckedIn || b.status === 'checked_in') {
            html += '<div class="checkin-notice-banner" role="status">' +
              '<span class="checkin-notice-icon" aria-hidden="true">✓</span>' +
              '<div><strong>Admitted at the door</strong><p class="muted small">' + (b.checkedInAt ? 'Checked in at ' + esc(fmt(b.checkedInAt)) : 'Your ticket has been validated and checked in.') + '</p></div>' +
              '</div>';
          }
          if (b.tickets && b.tickets.length > 0) {
            html += '<div class="digital-pass-tickets">' +
              b.tickets.map(function (tk, idx) {
                return '<div class="ticket-qr-card' + (tk.status === 'checked_in' ? ' ticket-used' : '') + '">' +
                  '<div class="ticket-qr-header">' +
                  '<strong>Pass #' + (idx + 1) + (tk.ticketTypeName ? ' · ' + esc(tk.ticketTypeName) : '') + '</strong>' +
                  '<span class="pill pill-' + esc(tk.status) + '">' + esc(tk.status === 'checked_in' ? 'Checked In' : tk.status) + '</span>' +
                  '</div>' +
                  (tk.qrSvg ? '<div class="ticket-qr-graphic" aria-label="Ticket QR code">' + tk.qrSvg + '</div>' : '') +
                  '<div class="ticket-code-display"><code>' + esc(tk.ticketCode) + '</code></div>' +
                  (tk.status === 'checked_in' ? '<p class="muted small text-center">✓ Admitted' + (tk.checkedInAt ? ' · ' + esc(fmt(tk.checkedInAt)) : '') + '</p>' : '<p class="muted small text-center">Present this QR code at the door for entry</p>') +
                  '</div>';
              }).join('') +
              '</div>';
          }
          if (b.venue) {
            html += '<div class="unlocked-venue-card"><div class="unlocked-venue-badge"><span class="unlocked-icon" aria-hidden="true">🔓</span> <strong>Venue Unlocked</strong></div><p class="unlocked-venue-addr">' + esc(b.venue) + '</p>' + (b.mapsUrl ? '<p><a class="btn btn-outline-cyan btn-sm" href="' + safeUrl(b.mapsUrl) + '" target="_blank" rel="noopener">Open in Google Maps</a></p>' : '') + '</div>';
          }
          if (b.announcements && b.announcements.length > 0) {
            html += '<div class="booking-announcements-card">' +
              '<h3>📢 Updates from your host</h3>' +
              b.announcements.map(function (a) {
                return '<div class="announcement-mini-item">' +
                  '<strong>' + (a.isPinned ? '📌 ' : '') + esc(a.title) + '</strong> <span class="muted small">· ' + esc(fmt(a.createdAt)) + '</span>' +
                  '<p>' + esc(a.message) + '</p>' +
                  '</div>';
              }).join('') +
              '</div>';
          }
          html += '<p><strong>You are in.</strong> ' + (b.ticket ? 'Your booking pass is confirmed.' : 'Your confirmation and private group invite are sent by our Telegram bot.') + '</p>';
          if (b.invite) html += '<p><a class="btn btn-tg" href="' + safeUrl(b.invite.link) + '" rel="noopener">Join the private group</a></p><p class="muted">Single-use invite, valid until ' + esc(fmt(b.invite.expiresAt)) + '.</p>';
          if (BOT) html += '<p><a class="link-arrow" href="https://t.me/' + esc(BOT) + '?start=booking_' + esc(b.id) + '">Open the bot to get a fresh invite</a></p>';
        } else if (b.status === 'cancelled') {
          html += '<div class="booking-notice booking-notice-warning" role="status">' +
            '<span class="notice-icon" aria-hidden="true">✕</span>' +
            '<div class="booking-notice-content">' +
            '<strong>Reservation Cancelled</strong>' +
            '<p class="muted">This booking has been cancelled and admission passes have been revoked.</p>' +
            '</div></div>';
        } else if (b.status === 'refunded') {
          html += '<p>This booking was refunded to your original payment method.</p>';
        }
        html += '<div class="pass-footer-note"><p class="muted small">Show this digital pass at the entrance for verification.</p></div>' +
          '</div>';

        var canCancel = ['confirmed', 'pending_approval'].indexOf(b.status) !== -1 && !b.isCheckedIn;
        if (canCancel) {
          html += '<div class="booking-cancel-section mt-4 text-center">' +
            '<button type="button" class="btn btn-outline-danger btn-sm" data-cancel-booking="' + esc(b.id) + '">Cancel Reservation</button>' +
            '</div>';
        }

        html += '<div class="booking-nav-actions">' +
          '<a class="btn btn-primary btn-sm" href="/me">View All My Bookings</a>' +
          '<a class="btn btn-outline-cyan btn-sm" href="/events">Explore More Events</a>' +
          (b.slug ? '<a class="btn btn-ghost btn-sm" href="/events/' + esc(b.slug) + '">Back to Event</a>' : '') +
          (b.eventId ? '<a class="btn btn-ghost btn-sm" href="/trust-safety?event=' + esc(b.eventId) + '#report">Report an Issue</a>' : '') +
          '</div>';

        el.innerHTML = html;

        var cancelBtn = el.querySelector('[data-cancel-booking]');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', function () {
            if (!confirm('Are you sure you want to cancel your reservation? Any tickets will be revoked and your seat released.')) return;
            cancelBtn.disabled = true;
            cancelBtn.textContent = 'Cancelling...';
            api('POST', '/api/me/bookings/' + encodeURIComponent(b.id) + '/cancel', { reason: 'Attendee requested cancellation' }).then(function (res) {
              if (res.ok) {
                toast('Reservation cancelled');
                tick();
              } else {
                alert(res.error?.message || 'Failed to cancel reservation');
                cancelBtn.disabled = false;
                cancelBtn.textContent = 'Cancel Reservation';
              }
            }).catch(function (err) {
              alert(err.message || 'Network error');
              cancelBtn.disabled = false;
              cancelBtn.textContent = 'Cancel Reservation';
            });
          });
        }
        if (b.status === 'pending_payment' && tries++ < 40) setTimeout(tick, 3000);
      });
    };
    tick();
  }

  $$('[data-signout]').forEach(function (signout) {
    signout.addEventListener('click', function (ev) {
      if (ev) ev.preventDefault();
      signout.disabled = true;
      signout.textContent = 'Signing out…';
      api('POST', '/api/auth/logout', {}).then(function () {
        state.me = null;
        state.csrf = null;
        try { sessionStorage.clear(); } catch (e) {}
        try { localStorage.removeItem('sm_in_tg'); } catch (e) {}
        window.location.replace('/signin');
      }).catch(function () {
        state.me = null;
        state.csrf = null;
        window.location.replace('/signin');
      });
    });
  });

  /* ---------- Member Onboarding Experience (6 Steps) ---------- */
  function initOnboarding() {
    var container = $('[data-onboarding-container]');
    if (!container) return;

    var nextUrl = container.getAttribute('data-next') || '/me';
    var progressFill = $('[data-progress-fill]', container);
    var stepBadge = $('[data-step-badge]', container);
    var stepLabel = $('[data-step-label]', container);
    var msgEl = $('[data-onboarding-msg]', container);

    var STEP_NAMES = {
      1: 'Welcome',
      2: 'Age Verification',
      3: 'Basic Profile',
      4: 'Your Interests',
      5: 'About You (Optional)',
      6: 'You’re In!'
    };

    var currentStep = 1;
    var profileData = {
      displayName: '',
      gender: '',
      city: '',
      ageConfirmed: false,
      interests: [],
      bio: '',
      languages: []
    };

    function showMsg(text, type) {
      if (!msgEl) return;
      msgEl.className = 'form-msg ' + (type || '');
      msgEl.textContent = text || '';
    }

    function goToStep(step) {
      currentStep = Math.max(1, Math.min(6, step));
      if (progressFill) {
        progressFill.style.width = ((currentStep / 6) * 100) + '%';
      }
      if (stepBadge) {
        stepBadge.textContent = 'Step ' + currentStep + ' of 6';
      }
      if (stepLabel) {
        stepLabel.textContent = STEP_NAMES[currentStep] || '';
      }
      $$('[data-step-panel]', container).forEach(function (panel) {
        var pStep = parseInt(panel.getAttribute('data-step-panel'), 10);
        panel.hidden = pStep !== currentStep;
      });
      showMsg('', '');
      try {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        window.scrollTo(0, 0);
      }
    }

    // Step navigation actions
    container.addEventListener('click', function (ev) {
      var nextBtn = ev.target.closest('[data-onboard-action="next-step"]');
      if (nextBtn) {
        var tStep = parseInt(nextBtn.getAttribute('data-target-step'), 10);
        goToStep(tStep);
        return;
      }
      var prevBtn = ev.target.closest('[data-onboard-action="prev-step"]');
      if (prevBtn) {
        var pStep = parseInt(prevBtn.getAttribute('data-target-step'), 10);
        goToStep(pStep);
        return;
      }
      var rejectAgeBtn = ev.target.closest('[data-onboard-action="reject-age"]');
      if (rejectAgeBtn) {
        api('POST', '/api/onboarding/age', { confirmed: false }).then(function () {
          var step2Form = $('[data-step-form="2"]', container);
          if (step2Form) step2Form.hidden = true;
          var u21Notice = $('[data-under-21-notice]', container);
          if (u21Notice) u21Notice.hidden = false;
        });
        return;
      }
      var skipOptBtn = ev.target.closest('[data-onboard-action="skip-optional"]');
      if (skipOptBtn) {
        goToStep(6);
        updateCompletionScreen();
        return;
      }
      var finishBtn = ev.target.closest('[data-onboard-action="finish-onboarding"]');
      if (finishBtn) {
        finishBtn.disabled = true;
        finishBtn.textContent = 'Finalizing your membership…';
        api('POST', '/api/onboarding/complete', {}).then(function (r) {
          if (r.ok) {
            var target = nextUrl && /^\/(?![\/\\])[\w\-./?=&#%]*$/.test(nextUrl) ? nextUrl : '/me';
            window.location.replace(target);
          } else {
            finishBtn.disabled = false;
            finishBtn.textContent = 'Explore Experiences →';
            showMsg(r.message || 'Could not complete onboarding. Please verify required fields.', 'error');
          }
        }).catch(function () {
          finishBtn.disabled = false;
          finishBtn.textContent = 'Explore Experiences →';
          showMsg('Network error while completing profile.', 'error');
        });
        return;
      }
    });

    // Form Submissions
    var step2Form = $('[data-step-form="2"]', container);
    if (step2Form) {
      step2Form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var check = $('#onboard-age-check', step2Form);
        if (!check || !check.checked) {
          showMsg('Please confirm you are 21 years of age or older to proceed.', 'error');
          return;
        }
        var btn = $('[data-onboard-submit="2"]', step2Form);
        if (btn) btn.disabled = true;
        api('POST', '/api/onboarding/age', { confirmed: true }).then(function (r) {
          if (btn) btn.disabled = false;
          if (r.ok && r.eligible) {
            profileData.ageConfirmed = true;
            goToStep(3);
          } else {
            showMsg('Age eligibility could not be verified.', 'error');
          }
        }).catch(function () {
          if (btn) btn.disabled = false;
          showMsg('Network error while verifying age.', 'error');
        });
      });
    }

    var step3Form = $('[data-step-form="3"]', container);
    if (step3Form) {
      step3Form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var nameInput = $('#onboard-display-name', step3Form);
        var genderSelect = $('#onboard-gender', step3Form);
        var citySelect = $('#onboard-city', step3Form);
        var dName = (nameInput.value || '').trim();
        var gender = genderSelect.value;
        var city = citySelect.value;

        if (!dName) {
          showMsg('Please enter your display name.', 'error');
          nameInput.focus();
          return;
        }
        if (!gender) {
          showMsg('Please select your gender.', 'error');
          genderSelect.focus();
          return;
        }
        if (!city) {
          showMsg('Please select your city.', 'error');
          citySelect.focus();
          return;
        }

        var btn = $('[data-onboard-submit="3"]', step3Form);
        if (btn) btn.disabled = true;
        api('POST', '/api/onboarding/profile', {
          displayName: dName,
          gender: gender,
          city: city
        }).then(function (r) {
          if (btn) btn.disabled = false;
          if (r.ok) {
            profileData.displayName = dName;
            profileData.gender = gender;
            profileData.city = city;
            goToStep(4);
          } else {
            showMsg(r.message || 'Failed to save basic profile.', 'error');
          }
        }).catch(function () {
          if (btn) btn.disabled = false;
          showMsg('Network error while saving profile.', 'error');
        });
      });
    }

    var step4Form = $('[data-step-form="4"]', container);
    if (step4Form) {
      var syncInterestsCounter = function () {
        var checked = $$('input[name="interest"]:checked', step4Form);
        var counter = $('[data-interests-counter]', step4Form);
        if (counter) {
          if (checked.length === 0) {
            counter.innerHTML = '<span class="form-msg error" style="margin:0;">Select at least 1 interest to continue.</span>';
          } else {
            counter.innerHTML = '<span class="interests-active-count">✓ ' + checked.length + ' interest' + (checked.length > 1 ? 's' : '') + ' selected</span>';
          }
        }
        $$('.interest-chip-card', step4Form).forEach(function (card) {
          var inp = $('input[type="checkbox"]', card);
          card.classList.toggle('is-selected', Boolean(inp && inp.checked));
        });
      };

      step4Form.addEventListener('change', syncInterestsCounter);

      step4Form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var checked = $$('input[name="interest"]:checked', step4Form).map(function (inp) { return inp.value; });
        if (checked.length < 1) {
          showMsg('Please select at least one interest to continue.', 'error');
          return;
        }
        var btn = $('[data-onboard-submit="4"]', step4Form);
        if (btn) btn.disabled = true;
        api('POST', '/api/onboarding/interests', { interests: checked }).then(function (r) {
          if (btn) btn.disabled = false;
          if (r.ok) {
            profileData.interests = checked;
            goToStep(5);
          } else {
            showMsg(r.message || 'Failed to save interests.', 'error');
          }
        }).catch(function () {
          if (btn) btn.disabled = false;
          showMsg('Network error while saving interests.', 'error');
        });
      });
    }

    var step5Form = $('[data-step-form="5"]', container);
    if (step5Form) {
      step5Form.addEventListener('change', function () {
        $$('.lang-chip', step5Form).forEach(function (chip) {
          var inp = $('input[type="checkbox"]', chip);
          chip.classList.toggle('is-selected', Boolean(inp && inp.checked));
        });
      });

      step5Form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var bioVal = ($('#onboard-bio', step5Form).value || '').trim();
        var langs = $$('input[name="language"]:checked', step5Form).map(function (inp) { return inp.value; });
        var btn = $('[data-onboard-submit="5"]', step5Form);
        if (btn) btn.disabled = true;
        api('POST', '/api/onboarding/optional', {
          bio: bioVal || undefined,
          languages: langs.length ? langs : undefined
        }).then(function (r) {
          if (btn) btn.disabled = false;
          if (r.ok) {
            profileData.bio = bioVal;
            profileData.languages = langs;
            goToStep(6);
            updateCompletionScreen();
          } else {
            showMsg(r.message || 'Failed to save additional info.', 'error');
          }
        }).catch(function () {
          if (btn) btn.disabled = false;
          showMsg('Network error while saving additional info.', 'error');
        });
      });
    }

    function updateCompletionScreen() {
      var subHeading = $('[data-welcome-subheading]', container);
      var name = profileData.displayName || (state.me && state.me.displayName) || 'there';
      if (subHeading) {
        subHeading.textContent = 'Welcome to NIGHTLIFEZ, ' + name + '! Your community pass is active.';
      }
    }

    // Load initial server-side status to resume incomplete onboarding seamlessly
    api('GET', '/api/onboarding/status').then(function (r) {
      if (!r.ok) return;
      if (r.completed) {
        // Already completed, redirect to next destination
        var target = nextUrl && /^\/(?![\/\\])[\w\-./?=&#%]*$/.test(nextUrl) ? nextUrl : '/me';
        window.location.replace(target);
        return;
      }
      var p = r.profile || {};
      profileData.displayName = p.displayName || '';
      profileData.gender = p.gender || '';
      profileData.city = p.city || '';
      profileData.ageConfirmed = Boolean(p.ageConfirmed);
      profileData.interests = p.interests || [];
      profileData.bio = p.bio || '';
      profileData.languages = p.languages || [];

      // Pre-fill inputs
      var nameInput = $('#onboard-display-name', container);
      if (nameInput && profileData.displayName) nameInput.value = profileData.displayName;
      var genderSelect = $('#onboard-gender', container);
      if (genderSelect && profileData.gender) genderSelect.value = profileData.gender;
      var citySelect = $('#onboard-city', container);
      if (citySelect && profileData.city) citySelect.value = profileData.city;
      var ageCheck = $('#onboard-age-check', container);
      if (ageCheck && profileData.ageConfirmed) ageCheck.checked = true;
      var bioText = $('#onboard-bio', container);
      if (bioText && profileData.bio) bioText.value = profileData.bio;

      // Check existing interests
      (profileData.interests || []).forEach(function (intKey) {
        var inp = container.querySelector('input[name="interest"][value="' + esc(intKey) + '"]');
        if (inp) {
          inp.checked = true;
          var card = inp.closest('.interest-chip-card');
          if (card) card.classList.add('is-selected');
        }
      });
      if (step4Form) syncInterestsCounter();

      // Check existing languages
      (profileData.languages || []).forEach(function (lang) {
        var inp = container.querySelector('input[name="language"][value="' + esc(lang) + '"]');
        if (inp) {
          inp.checked = true;
          var chip = inp.closest('.lang-chip');
          if (chip) chip.classList.add('is-selected');
        }
      });

      // Resume at current incomplete step
      var resumeStep = 1;
      if (r.currentStep && r.currentStep >= 1) {
        resumeStep = Math.min(r.currentStep + 1, 6);
      }
      goToStep(resumeStep);
    }).catch(function () {
      var initStep = parseInt(container.getAttribute('data-initial-step'), 10) || 1;
      goToStep(initStep);
    });
  }

  /* ---------- voluntary profile ---------- */
  var LABELS = {
    female: 'Woman', male: 'Man', non_binary: 'Non-binary', prefer_not_to_say: 'Prefer not to say',
    '21_24': '21–24', '25_29': '25–29', '30_34': '30–34', '35_39': '35–39', '40_plus': '40+',
    nightlife: 'Nightlife', weekend_trips: 'Weekend trips', strangers_trips: 'Weekend trips', meetups: 'Meetups', dinners: 'Dinners', weekend_parties: 'Weekend parties',
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

  /* ---------- safety reporting & user blocking ---------- */
  function renderSafetyReport(el) {
    var params = new URLSearchParams(location.search);
    var prefillEvent = params.get('event') || '';
    if (!state.me) {
      var bot = el.getAttribute('data-bot');
      var supportEmail = el.getAttribute('data-support-email');
      var botPart = bot
        ? 'send <code>/report</code> to <a class="link-cyan" href="https://t.me/' + esc(bot) + '" target="_blank" rel="noopener">@' + esc(bot) + '</a> on Telegram'
        : 'send <code>/report</code> to our Telegram bot';
      var emailPart = supportEmail
        ? ' or email <a class="link-cyan" href="mailto:' + esc(supportEmail) + '">' + esc(supportEmail) + '</a>'
        : '';
      el.innerHTML = '<div class="safety-box">' +
        '<h3>Submit a Confidential Safety Report</h3>' +
        '<p class="muted">To submit a confidential report online, please <a class="link-cyan" href="/signin">sign in with Telegram</a> first. You can also ' + botPart + emailPart + '. If you are in immediate danger, call 112.</p>' +
        '</div>';
      return;
    }
    el.innerHTML = '<form class="lead-form safety-form" data-report-form>' +
      '<h3>Submit a Confidential Safety Report</h3>' +
      '<p class="muted">Reports are confidential and reviewed directly by platform moderators. If you are in immediate danger, call 112.</p>' +
      '<label class="field"><span>Reason for report</span><select name="category" required>' +
      '<option value="">Select a reason</option>' +
      '<option value="harassment">Harassment or abusive behaviour</option>' +
      '<option value="fraud_suspicious">Suspicious or fraudulent event</option>' +
      '<option value="unwanted_contact">Unwanted contact or messaging</option>' +
      '<option value="safety_concern">Safety concern at an event</option>' +
      '<option value="policy_violation">Conduct or policy violation</option>' +
      '<option value="other">Other safety concern</option>' +
      '</select></label>' +
      '<label class="field"><span>Details (required)</span><textarea name="body" rows="4" minlength="10" maxlength="3000" placeholder="Please describe what happened, when, and where. Include any names, handles or relevant details..." required></textarea></label>' +
      (prefillEvent ? '<input type="hidden" name="eventId" value="' + esc(prefillEvent) + '">' : '') +
      '<button class="btn btn-primary" type="submit">Submit Confidential Report</button>' +
      '<p class="form-msg" role="status" aria-live="polite" data-report-msg></p>' +
      '</form>';

    var form = $('[data-report-form]', el);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = $('button[type=submit]', form);
      var msg = $('[data-report-msg]', form);
      var category = form.category.value;
      var body = form.body.value;
      var eventId = form.eventId ? form.eventId.value : null;
      btn.disabled = true;
      msg.className = 'form-msg';
      msg.textContent = 'Submitting report…';
      api('POST', '/api/reports', { category: category, body: body, eventId: eventId || null }).then(function (r) {
        if (!r.ok) {
          btn.disabled = false;
          msg.className = 'form-msg error';
          msg.textContent = r.message || 'Could not submit report. Please try again.';
          return;
        }
        form.reset();
        btn.disabled = false;
        msg.className = 'form-msg ok';
        msg.textContent = 'Thank you. Your report has been submitted to moderators and will be reviewed confidentially.';
      }).catch(function (err) {
        btn.disabled = false;
        msg.className = 'form-msg error';
        msg.textContent = err.message || 'Network error. Please try again.';
      });
    });
  }

  function renderSafetySettings(el) {
    function loadBlocks() {
      api('GET', '/api/me/blocks').then(function (r) {
        if (!r.ok) return;
        var blocks = r.blocks || [];
        var html = '<div class="safety-settings-card">' +
          '<h2>Safety &amp; Blocked Users</h2>' +
          '<p class="muted">Blocked users cannot book your hosted events and you will not see their events.</p>';
        if (!blocks.length) {
          html += '<p class="muted small">You have not blocked any users.</p>';
        } else {
          html += '<ul class="blocked-users-list">' + blocks.map(function (b) {
            return '<li class="blocked-user-item">' +
              '<div><strong>' + esc(b.alias) + '</strong> <span class="muted small">· Blocked ' + esc(fmt(b.createdAt)) + '</span></div>' +
              '<button class="btn btn-ghost btn-sm" type="button" data-unblock-id="' + esc(b.blockedUserId) + '">Unblock</button>' +
              '</li>';
          }).join('') + '</ul>';
        }
        html += '<div class="safety-actions">' +
          '<a class="btn btn-outline-cyan btn-sm" href="/trust-safety#report">Submit a Safety Report</a>' +
          '</div></div>';
        el.innerHTML = html;

        $$('[data-unblock-id]', el).forEach(function (btn) {
          btn.addEventListener('click', function () {
            var uid = btn.getAttribute('data-unblock-id');
            btn.disabled = true;
            api('DELETE', '/api/me/blocks/' + encodeURIComponent(uid)).then(function () {
              loadBlocks();
            });
          });
        });
      });
    }
    loadBlocks();
  }

  /* ---------- location picker modal & discovery integration ---------- */
  function initLocationPicker() {
    var dialog = $('[data-location-dialog]');
    var triggers = $$('[data-loc-trigger]');
    var closeBtn = dialog && $('[data-loc-close]', dialog);
    var searchInput = dialog && $('[data-loc-search]', dialog);
    var stateFilter = dialog && $('[data-loc-state-filter]', dialog);
    var gpsBtn = dialog && $('[data-loc-gps]', dialog);
    var statusMsg = dialog && $('[data-loc-status]', dialog);
    var emptyState = dialog && $('[data-loc-empty]', dialog);
    var resetSearchBtn = dialog && $('[data-loc-reset-search]', dialog);
    var cityItems = dialog ? $$('.loc-city-item', dialog) : [];
    var tierSections = dialog ? $$('.loc-tier-section', dialog) : [];
    var pillBtns = dialog ? $$('.loc-pill', dialog) : [];
    var labels = $$('[data-loc-current-label]');
    var citySelects = $$('[data-header-city]');

    var params = new URLSearchParams(location.search);
    var curCity = params.get('city');
    var curLat = params.get('lat');
    var curLng = params.get('lng');

    function updateLabel(text) {
      labels.forEach(function (lbl) { lbl.textContent = text; });
    }

    // Set initial label
    if (curLat && curLng) {
      updateLabel('Near You (📍 50km)');
    } else if (curCity) {
      var found = cityItems.filter(function (btn) {
        return btn.getAttribute('data-city-slug') === curCity.toLowerCase();
      })[0];
      if (found) {
        updateLabel(found.getAttribute('data-city-name'));
        citySelects.forEach(function (s) { s.value = curCity; });
      } else {
        updateLabel(curCity.charAt(0).toUpperCase() + curCity.slice(1));
      }
    } else {
      updateLabel('All Cities');
    }

    if (!dialog) return;

    function openDialog() {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      triggers.forEach(function (t) { t.setAttribute('aria-expanded', 'true'); });
      if (statusMsg) statusMsg.textContent = '';
      if (searchInput) {
        searchInput.value = '';
        filterCities();
        setTimeout(function () { searchInput.focus(); }, 50);
      }
    }

    function closeDialog() {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
      triggers.forEach(function (t) { t.setAttribute('aria-expanded', 'false'); });
    }

    triggers.forEach(function (t) {
      t.addEventListener('click', function (e) {
        e.preventDefault();
        openDialog();
      });
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', closeDialog);
    }

    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) closeDialog();
    });

    dialog.addEventListener('cancel', function () {
      triggers.forEach(function (t) { t.setAttribute('aria-expanded', 'false'); });
    });

    function filterCities() {
      var q = (searchInput ? searchInput.value : '').trim().toLowerCase();
      var selectedState = (stateFilter ? stateFilter.value : '').trim().toLowerCase();
      var visibleTotal = 0;

      tierSections.forEach(function (sec) {
        var items = $$('.loc-city-item', sec);
        var visibleInTier = 0;
        items.forEach(function (item) {
          var name = (item.getAttribute('data-city-name') || '').toLowerCase();
          var slug = (item.getAttribute('data-city-slug') || '').toLowerCase();
          var state = (item.getAttribute('data-state') || '').toLowerCase();
          var aliases = (item.getAttribute('data-aliases') || '').toLowerCase();

          var matchesState = !selectedState || state === selectedState;
          var matchesQ = !q || name.indexOf(q) !== -1 || slug.indexOf(q) !== -1 || aliases.indexOf(q) !== -1;

          var show = matchesState && matchesQ;
          var li = item.closest('li');
          if (li) li.hidden = !show;
          if (show) {
            visibleInTier++;
            visibleTotal++;
          }
        });
        sec.hidden = (visibleInTier === 0);
      });

      if (emptyState) {
        emptyState.hidden = (visibleTotal > 0);
      }
    }

    if (searchInput) searchInput.addEventListener('input', filterCities);
    if (stateFilter) stateFilter.addEventListener('change', filterCities);
    if (resetSearchBtn) {
      resetSearchBtn.addEventListener('click', function () {
        if (searchInput) searchInput.value = '';
        if (stateFilter) stateFilter.value = '';
        filterCities();
        if (searchInput) searchInput.focus();
      });
    }

    function applyCity(slug, name) {
      closeDialog();
      updateLabel(name || 'All Cities');
      citySelects.forEach(function (s) { s.value = slug || ''; });

      var targetPath = '/events';
      var u = new URL(location.href);
      u.pathname = targetPath;
      u.searchParams.delete('lat');
      u.searchParams.delete('lng');
      u.searchParams.delete('radius_km');
      if (slug) {
        u.searchParams.set('city', slug);
      } else {
        u.searchParams.delete('city');
      }

      var nextUrl = u.pathname + u.search;
      if (typeof window.__smLoadDiscovery === 'function') {
        window.__smLoadDiscovery(nextUrl, true);
      } else {
        location.href = nextUrl;
      }
    }

    cityItems.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-city-slug') || '';
        var name = btn.getAttribute('data-city-name') || 'All Cities';
        applyCity(slug, name);
      });
    });

    pillBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slug = btn.getAttribute('data-city-slug') || '';
        var name = btn.getAttribute('data-city-name') || 'All Cities';
        applyCity(slug, name);
      });
    });

    citySelects.forEach(function (sel) {
      sel.addEventListener('change', function () {
        var val = sel.value;
        var found = cityItems.filter(function (b) { return b.getAttribute('data-city-slug') === val; })[0];
        applyCity(val, found ? found.getAttribute('data-city-name') : (val ? val.toUpperCase() : 'All Cities'));
      });
    });

    if (gpsBtn) {
      gpsBtn.addEventListener('click', function () {
        if (!navigator.geolocation) {
          if (statusMsg) {
            statusMsg.textContent = 'Geolocation is not supported by your browser.';
            statusMsg.className = 'loc-status-msg loc-status-err';
          }
          return;
        }

        if (statusMsg) {
          statusMsg.textContent = 'Locating your device…';
          statusMsg.className = 'loc-status-msg loc-status-loading';
        }
        gpsBtn.disabled = true;

        navigator.geolocation.getCurrentPosition(
          function (pos) {
            gpsBtn.disabled = false;
            var lat = pos.coords.latitude;
            var lng = pos.coords.longitude;
            if (statusMsg) {
              statusMsg.textContent = 'Location found! Finding events near you…';
              statusMsg.className = 'loc-status-msg loc-status-ok';
            }
            setTimeout(function () {
              closeDialog();
              updateLabel('Near You (📍 50km)');
              var targetPath = '/events';
              var u = new URL(location.href);
              u.pathname = targetPath;
              u.searchParams.delete('city');
              u.searchParams.set('lat', lat.toFixed(4));
              u.searchParams.set('lng', lng.toFixed(4));
              u.searchParams.set('radius_km', '50');

              var nextUrl = u.pathname + u.search;
              if (typeof window.__smLoadDiscovery === 'function') {
                window.__smLoadDiscovery(nextUrl, true);
              } else {
                location.href = nextUrl;
              }
            }, 400);
          },
          function (err) {
            gpsBtn.disabled = false;
            if (statusMsg) {
              statusMsg.className = 'loc-status-msg loc-status-err';
              if (err.code === 1 /* PERMISSION_DENIED */) {
                statusMsg.textContent = 'Location permission denied. Please select your city manually below.';
              } else if (err.code === 2 /* POSITION_UNAVAILABLE */) {
                statusMsg.textContent = 'Location unavailable. Please select your city manually below.';
              } else if (err.code === 3 /* TIMEOUT */) {
                statusMsg.textContent = 'Location request timed out. Please select your city manually below.';
              } else {
                statusMsg.textContent = 'Could not determine location. Please select your city manually below.';
              }
            }
          },
          { timeout: 8000, enableHighAccuracy: false, maximumAge: 300000 }
        );
      });
    }
  }

  initLocationPicker();

  /* ---------- instant attendee discovery (progressive enhancement) ---------- */
  function initInstantDiscovery() {
    var feed = $('[data-discovery-feed]');
    if (!feed) return;

    var announcer = $('[data-discovery-announcer]');
    if (!announcer) {
      announcer = document.createElement('div');
      announcer.setAttribute('data-discovery-announcer', '1');
      announcer.setAttribute('role', 'status');
      announcer.setAttribute('aria-live', 'polite');
      announcer.className = 'sr-only';
      feed.prepend(announcer);
    }

    var debounceTimer = null;
    function announce(msg) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        announcer.textContent = msg;
      }, 150);
    }

    var activeAbort = null;

    function loadDiscoveryUrl(url, push) {
      if (activeAbort && activeAbort.abort) activeAbort.abort();
      activeAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;

      var results = $('[data-discovery-results]', feed);
      if (results) results.classList.add('is-loading');

      var fetchOptions = {
        headers: { 'Accept': 'text/html' }
      };
      if (activeAbort) fetchOptions.signal = activeAbort.signal;

      fetch(url, fetchOptions).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      }).then(function (htmlStr) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(htmlStr, 'text/html');

        var newFeed = doc.querySelector('[data-discovery-feed]');
        if (!newFeed) { location.href = url; return; }

        var updateDOM = function () {
          // Update search notice banner
          var oldNotice = feed.querySelector('.search-notice');
          var newNotice = newFeed.querySelector('.search-notice');
          if (oldNotice && newNotice) oldNotice.replaceWith(newNotice);
          else if (oldNotice && !newNotice) oldNotice.remove();
          else if (!oldNotice && newNotice) {
            var formEl = feed.querySelector('[data-filters]');
            if (formEl) formEl.before(newNotice);
            else feed.prepend(newNotice);
          }

          // Update filters form values
          var oldFilters = feed.querySelector('[data-filters]');
          var newFilters = newFeed.querySelector('[data-filters]');
          if (oldFilters && newFilters) {
            oldFilters.innerHTML = newFilters.innerHTML;
          }

          // Update results grid
          var oldResults = feed.querySelector('[data-discovery-results]');
          var newResults = newFeed.querySelector('[data-discovery-results]');
          if (oldResults && newResults) {
            oldResults.innerHTML = newResults.innerHTML;
            oldResults.classList.remove('is-loading');
          }
        };

        if (document.startViewTransition && !reduce) {
          var transition = document.startViewTransition(updateDOM);
          transition.finished.finally(function () {
            var resultsHeading = feed.querySelector('h1, h2');
            if (resultsHeading && document.activeElement === document.body) {
              resultsHeading.setAttribute('tabindex', '-1');
              resultsHeading.focus();
            }
          });
        } else {
          updateDOM();
        }

        // Update document title
        if (doc.title) document.title = doc.title;

        // Push state if requested
        if (push) {
          history.pushState({ url: url }, '', url);
        }

        // Sync header city selector and location label
        var uObj = new URL(url, location.origin);
        var currentCity = uObj.searchParams.get('city') || '';
        var currentLat = uObj.searchParams.get('lat');
        var currentLng = uObj.searchParams.get('lng');
        $$('[data-header-city]').forEach(function (sel) {
          sel.value = currentCity;
        });
        $$('[data-loc-current-label]').forEach(function (lbl) {
          if (currentLat && currentLng) {
            lbl.textContent = 'Near You (📍 50km)';
          } else if (currentCity) {
            var found = document.querySelector('.loc-city-item[data-city-slug="' + currentCity.toLowerCase() + '"]');
            lbl.textContent = found ? found.getAttribute('data-city-name') : currentCity.charAt(0).toUpperCase() + currentCity.slice(1);
          } else {
            lbl.textContent = 'All Cities';
          }
        });

        // Accessible announcement
        var count = feed.querySelectorAll('.card').length;
        if (count > 0) {
          announce(count + ' upcoming event' + (count === 1 ? '' : 's') + ' found.');
        } else {
          announce('No upcoming events found matching your filters.');
        }

        bindFilterEvents();
      }).catch(function (err) {
        if (err.name === 'AbortError') return;
        location.href = url;
      });
    }

    window.__smLoadDiscovery = loadDiscoveryUrl;

    function onFilterChange() {
      var form = feed.querySelector('[data-filters]');
      if (!form) return;
      var fd = new FormData(form);
      var params = new URLSearchParams();
      fd.forEach(function (v, k) {
        if (v && v.trim()) params.set(k, v.trim());
      });
      var action = form.getAttribute('action') || '/events';
      var newUrl = action + (params.toString() ? '?' + params.toString() : '');
      loadDiscoveryUrl(newUrl, true);
    }

    function bindFilterEvents() {
      var form = feed.querySelector('[data-filters]');
      if (!form) return;
      if (!form.getAttribute('data-async-bound')) {
        form.setAttribute('data-async-bound', '1');
        form.addEventListener('change', function (ev) {
          if (ev.target && (ev.target.name === 'city' || ev.target.name === 'category' || ev.target.name === 'when' || ev.target.name === 'price' || ev.target.name === 'sort')) {
            onFilterChange();
          }
        });
        form.addEventListener('submit', function (ev) {
          ev.preventDefault();
          onFilterChange();
        });
      }

      var clearLinks = feed.querySelectorAll('.clear-search, .filter-clear');
      clearLinks.forEach(function (a) {
        if (!a.getAttribute('data-async-bound')) {
          a.setAttribute('data-async-bound', '1');
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            loadDiscoveryUrl(a.getAttribute('href'), true);
          });
        }
      });
    }

    bindFilterEvents();

    window.addEventListener('popstate', function () {
      loadDiscoveryUrl(location.href, false);
    });
  }

  /* ---------- promotional carousel ---------- */
  var carousel = $('[data-promo-carousel]');
  if (carousel) {
    var slides = $$('.carousel-slide', carousel);
    var dots = $$('[data-carousel-dot]', carousel);
    var prevBtn = $('[data-carousel-prev]', carousel);
    var nextBtn = $('[data-carousel-next]', carousel);
    var currentSlide = 0;
    var timer = null;

    function showSlide(idx) {
      if (!slides.length) return;
      currentSlide = (idx + slides.length) % slides.length;
      slides.forEach(function (s, i) { s.classList.toggle('is-active', i === currentSlide); });
      dots.forEach(function (d, i) { d.classList.toggle('active', i === currentSlide); });
    }

    function autoNext() { showSlide(currentSlide + 1); }
    function startTimer() { if (!timer) timer = setInterval(autoNext, 6000); }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    if (prevBtn) prevBtn.addEventListener('click', function () { stopTimer(); showSlide(currentSlide - 1); startTimer(); });
    if (nextBtn) nextBtn.addEventListener('click', function () { stopTimer(); showSlide(currentSlide + 1); startTimer(); });
    dots.forEach(function (dot, i) {
      dot.addEventListener('click', function () { stopTimer(); showSlide(i); startTimer(); });
    });

    carousel.addEventListener('mouseenter', stopTimer);
    carousel.addEventListener('mouseleave', startTimer);
    startTimer();
  }

  initInstantDiscovery();

  miniApp().then(refreshMe).then(function () {
    initOnboarding();
    initAttendeeHub();
    initSaveEventHandlers();
    var pf = $('[data-profile]'); if (pf && state.me) renderProfile(pf);
    var mb = $('[data-my-bookings]'); if (mb) renderBookings(mb);
    var se = $('[data-saved-events]'); if (se && state.me) renderSavedEvents(se);
    var ma = $('[data-my-announcements]'); if (ma && state.me) renderMyAnnouncements(ma);
    var bs = $('[data-booking-status]'); if (bs) renderStatus(bs);
    var sr = $('[data-safety-report]'); if (sr) renderSafetyReport(sr);
    var ss = $('[data-safety-settings]'); if (ss && state.me) renderSafetySettings(ss);
    var tf = $('form[data-tier-form]');
    if (tf && state.me) {
      api('GET', '/api/me/bookings').then(function (r) {
        if (!r.ok || !r.bookings) return;
        var existing = r.bookings.find(function (b) {
          return b.slug && location.pathname.indexOf('/events/' + b.slug) === 0;
        });
        if (existing && !$('.already-booked-banner', tf.parentNode)) {
          var bnr = document.createElement('div');
          bnr.className = 'already-booked-banner';
          bnr.setAttribute('role', 'status');
          bnr.innerHTML = '<span class="already-booked-icon" aria-hidden="true">🎟️</span>' +
            '<div class="already-booked-text">' +
            '<p><strong>You have a pass for this event (' + esc(STATUS[existing.status] || existing.status) + ').</strong></p>' +
            '<p><a class="link-arrow" href="/bookings/' + esc(existing.id) + '">View your digital ticket pass &amp; venue details →</a></p>' +
            '</div>';
          tf.parentNode.insertBefore(bnr, tf);
        }
      });
    }
  });
})();
