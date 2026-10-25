// public/js/app.js - StrangersMeetup Minimalist Editorial Client Controller
(function () {
  'use strict';

  const STORAGE_KEY_VERIFIED = 'sm_age_verified_21';
  const STORAGE_KEY_SESSION = 'sm_anon_session_id';

  // State Management
  let sessionId = localStorage.getItem(STORAGE_KEY_SESSION);
  if (!sessionId) {
    sessionId = 's_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
    localStorage.setItem(STORAGE_KEY_SESSION, sessionId);
  }

  let activeScope = 'all';
  let activeCity = 'all';
  let activeCategory = 'all';
  let activeBudget = 'all';
  let currentEvents = [];

  // DOM Elements
  const ageGateDialog = document.getElementById('age-gate-dialog');
  const ageGateForm = document.getElementById('age-gate-form');
  const ageGateError = document.getElementById('age-gate-error');
  const checkoutDialog = document.getElementById('checkout-dialog');
  const checkoutDetails = document.getElementById('checkout-details');
  const checkoutBtn = document.getElementById('checkout-proceed-btn');
  const bookingDialog = document.getElementById('event-booking-dialog');
  const bookingContent = document.getElementById('booking-modal-content');
  const eventsGrid = document.getElementById('events-grid');
  const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
  const mobileNav = document.getElementById('mobile-nav-drawer');

  // 1. Analytics Tracking (Fire-and-forget, privacy conscious)
  async function trackEvent(eventName, payload = {}) {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      await fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventName,
          sessionId,
          tierId: payload.tierId || null,
          regionCode: payload.regionCode || null,
          utmSource: urlParams.get('utm_source'),
          utmMedium: urlParams.get('utm_medium'),
          utmCampaign: urlParams.get('utm_campaign'),
          metadata: payload.metadata || {}
        })
      });
    } catch {
      // Gracefully ignore analytics failures
    }
  }

  // 2. Statutory 21+ Age Gate Verification
  function calculateAge(birthDateString) {
    const today = new Date();
    const birthDate = new Date(birthDateString);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  }

  function checkAgeGateStatus() {
    const verifiedRecord = localStorage.getItem(STORAGE_KEY_VERIFIED);
    if (!verifiedRecord) {
      if (ageGateDialog && typeof ageGateDialog.showModal === 'function') {
        ageGateDialog.showModal();
      }
    }
  }

  if (ageGateForm) {
    ageGateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const dobInput = document.getElementById('dob-input').value;
      const stateInput = document.getElementById('state-input').value;
      const affirmCheckbox = document.getElementById('affirm-checkbox').checked;

      if (!dobInput) {
        showAgeError('Please select your date of birth.');
        return;
      }

      if (!affirmCheckbox) {
        showAgeError('You must explicitly affirm that you are at least 21 years of age.');
        return;
      }

      const age = calculateAge(dobInput);

      if (isNaN(age) || age < 21) {
        trackEvent('age_gate_fail', { metadata: { calculatedAge: age, state: stateInput } });
        showAgeError('StrangersMeetup is strictly restricted to adults aged 21 and older. You cannot enter at this time.');
        return;
      }

      if (['TN', 'PY', 'KA', 'KL'].indexOf(stateInput) === -1) {
        trackEvent('age_gate_fail', { metadata: { state: stateInput, reason: 'unsupported_region' } });
        showAgeError('StrangersMeetup is currently active exclusively in Tamil Nadu, Puducherry, Karnataka, and Kerala.');
        return;
      }

      const declaration = {
        age,
        state: stateInput,
        verifiedAt: new Date().toISOString(),
        disclaimer: 'Self-declared eligibility check. Not an independently verified national ID.'
      };

      localStorage.setItem(STORAGE_KEY_VERIFIED, JSON.stringify(declaration));
      trackEvent('age_gate_pass', { regionCode: stateInput, metadata: { age } });

      if (ageGateDialog) {
        ageGateDialog.close();
      }
    });
  }

  function showAgeError(msg) {
    if (ageGateError) {
      ageGateError.textContent = msg;
      ageGateError.style.display = 'block';
    }
  }

  // 3. Dynamic Events & Trips Fetch & Rendering
  async function loadEvents() {
    if (!eventsGrid) return;

    try {
      let url = '/api/events?';
      if (activeScope !== 'all') url += `scope=${encodeURIComponent(activeScope)}&`;
      if (activeCity !== 'all') url += `city=${encodeURIComponent(activeCity)}&`;
      if (activeCategory !== 'all') url += `category=${encodeURIComponent(activeCategory)}&`;
      if (activeBudget !== 'all') url += `budget=${encodeURIComponent(activeBudget)}&`;

      const res = await fetch(url);
      const data = await res.json();

      if (data.ok && Array.isArray(data.events)) {
        currentEvents = data.events;
        renderEvents(data.events);
      } else {
        eventsGrid.innerHTML = `
          <div style="grid-column: 1/-1; text-align: center; padding: 4rem 1.5rem; color: var(--text-muted); background: var(--bg-surface-card); border-radius: var(--radius-lg); border: 1px solid var(--border-card);">
            <p>No upcoming events matching your selection currently. Try resetting filters or explore other destinations.</p>
          </div>
        `;
      }
    } catch (err) {
      console.warn('Failed to fetch events from API', err);
    }
  }

  function renderEvents(events) {
    if (!eventsGrid) return;

    if (events.length === 0) {
      eventsGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 4rem 1.5rem; background: var(--bg-surface-card); border-radius: var(--radius-lg); border: 1px solid var(--border-card);">
          <h3 style="font-size: 1.35rem; font-weight: 700; margin-bottom: 0.5rem; color: var(--text-primary);">No experiences found</h3>
          <p style="color: var(--text-secondary); max-width: 480px; margin: 0 auto 1.5rem; font-size: 0.92rem;">
            We curate intimate gatherings with strict capacity controls. Select another destination, scope, or clear your filters.
          </p>
          <button type="button" class="btn-secondary" onclick="window.resetAllFilters()">View All Experiences</button>
        </div>
      `;
      return;
    }

    eventsGrid.innerHTML = events.map(function (evt) {
      const dateObj = new Date(evt.startTime);
      const formattedDate = dateObj.toLocaleDateString('en-IN', {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });
      const formattedTime = dateObj.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit'
      });

      let statusBadgeClass = 'badge-open';
      let statusText = 'Open for booking';
      if (evt.ticketingStatus === 'opening_soon') {
        statusBadgeClass = 'badge-opening-soon';
        statusText = 'Opening soon';
      } else if (evt.ticketingStatus === 'sold_out') {
        statusBadgeClass = 'badge-sold-out';
        statusText = 'Sold out';
      } else if (evt.remainingSlots <= 5 && evt.remainingSlots > 0) {
        statusBadgeClass = 'badge-limited';
        statusText = `${evt.remainingSlots} slots left`;
      }

      let scopeLabel = 'South India';
      if (evt.scope === 'domestic_trip') scopeLabel = 'Domestic Trip';
      else if (evt.scope === 'international_trip') scopeLabel = 'International';

      const demoBadgeHtml = evt.isDemo
        ? `<div class="sample-badge">Sample / Demo Event</div>`
        : '';

      const isBookable = evt.ticketingStatus !== 'opening_soon' && evt.ticketingStatus !== 'sold_out';
      const ctaLabel = isBookable ? 'Book Tickets' : (evt.ticketingStatus === 'sold_out' ? 'Waitlist' : 'Details');

      return `
        <article class="event-card" data-event-id="${evt.id}">
          <div class="event-card-media">
            <img 
              class="event-card-img" 
              src="${evt.imageUrl}" 
              alt="${evt.title}"
              loading="lazy"
              decoding="async"
              width="600"
              height="375"
            >
            <div class="event-card-badges">
              <span class="badge-scope">${scopeLabel}</span>
              <span class="badge-status ${statusBadgeClass}">${statusText}</span>
            </div>
          </div>

          <div class="event-card-body">
            ${demoBadgeHtml}
            <div class="event-category-tag">${evt.category.replace('_', ' ')}</div>
            <h3 class="event-card-title">${evt.title}</h3>

            <div class="event-meta-list">
              <div class="event-meta-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                  <circle cx="12" cy="10" r="3"></circle>
                </svg>
                <span>${evt.areaName}</span>
              </div>
              <div class="event-meta-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <span>${formattedDate} • ${evt.durationLabel || formattedTime}</span>
              </div>
            </div>

            <p class="event-card-desc">${evt.description}</p>

            <div class="event-organizer">
              <span>Organized by</span>
              <span class="event-organizer-name">${evt.organizerName}</span>
            </div>

            <div class="event-card-footer">
              <div class="price-block">
                <span class="price-main">${evt.priceLabel}</span>
                <span class="price-sub">${evt.remainingSlots} slots remaining</span>
              </div>

              <div style="display: flex; gap: 0.5rem;">
                <button type="button" class="btn-outline" onclick="window.openEventDetail('${evt.id}')" title="View event details and inclusions">
                  Details
                </button>
                <button type="button" class="${isBookable ? 'btn-primary' : 'btn-secondary'}" onclick="window.openEventBooking('${evt.id}')" ${evt.ticketingStatus === 'sold_out' ? 'disabled' : ''}>
                  ${ctaLabel}
                </button>
              </div>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  // 4. Detailed Event / Trip Modal
  window.openEventDetail = function (eventId) {
    const evt = currentEvents.find(function (e) { return e.id === eventId; });
    if (!evt || !bookingDialog || !bookingContent) return;

    trackEvent('event_detail_view', { eventId, city: evt.city });

    const inclusionsHtml = Array.isArray(evt.inclusions) && evt.inclusions.length > 0
      ? `
        <div style="margin-bottom: 1.25rem;">
          <h4 style="font-size: 0.88rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent-teal); margin-bottom: 0.5rem;">Verified Inclusions</h4>
          <ul style="list-style: none; display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.88rem; color: var(--text-secondary);">
            ${evt.inclusions.map(function (inc) { return `<li>✓ ${inc}</li>`; }).join('')}
          </ul>
        </div>
      `
      : '';

    const exclusionsHtml = Array.isArray(evt.exclusions) && evt.exclusions.length > 0
      ? `
        <div style="margin-bottom: 1.25rem;">
          <h4 style="font-size: 0.88rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.5rem;">Exclusions & Note</h4>
          <ul style="list-style: none; display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.88rem; color: var(--text-secondary);">
            ${evt.exclusions.map(function (exc) { return `<li>✗ ${exc}</li>`; }).join('')}
          </ul>
        </div>
      `
      : '';

    bookingContent.innerHTML = `
      <div class="modal-header">
        <span class="age-badge-pill" style="margin-bottom: 0.5rem; display: inline-block;">${evt.scope.replace('_', ' ').toUpperCase()} • 21+ ONLY</span>
        <h3 id="booking-modal-title" class="modal-title">${evt.title}</h3>
        <p style="color: var(--text-secondary); font-size: 0.92rem;">
          ${evt.areaName} • ${evt.durationLabel}
        </p>
      </div>

      ${evt.isDemo ? `<div class="sample-badge" style="margin-bottom: 1rem;">Sample Development Event (Demo Data)</div>` : ''}

      <div style="max-height: 55vh; overflow-y: auto; padding-right: 0.5rem; margin-bottom: 1.5rem;">
        <p style="font-size: 0.92rem; color: var(--text-secondary); line-height: 1.6; margin-bottom: 1.25rem;">
          ${evt.description}
        </p>

        ${inclusionsHtml}
        ${exclusionsHtml}

        <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1rem; font-size: 0.82rem; color: var(--text-secondary);">
          <strong style="color: var(--text-primary); display: block; margin-bottom: 0.25rem;">🔒 Physical Privacy & Coordination:</strong>
          ${evt.privacyNotice}
        </div>

        <div style="font-size: 0.82rem; color: var(--text-muted); line-height: 1.5;">
          <strong>Cancellation Terms:</strong> ${evt.bookingTerms}
        </div>
      </div>

      <div style="display: flex; gap: 1rem; align-items: center; justify-content: space-between; border-top: 1px solid var(--border-subtle); padding-top: 1.25rem;">
        <div>
          <span style="font-size: 1.3rem; font-weight: 800; color: var(--text-primary);">${evt.priceLabel}</span>
          <span style="display: block; font-size: 0.76rem; color: var(--text-muted);">${evt.remainingSlots} slots available</span>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="btn-secondary" onclick="document.getElementById('event-booking-dialog').close()">
            Close
          </button>
          <button type="button" class="btn-primary" onclick="window.openEventBooking('${evt.id}')">
            Reserve Tickets
          </button>
        </div>
      </div>
    `;

    bookingDialog.showModal();
  };

  // 5. Event Booking Reservation
  window.openEventBooking = function (eventId) {
    const evt = currentEvents.find(function (e) { return e.id === eventId; });
    if (!evt || !bookingDialog || !bookingContent) return;

    trackEvent('event_booking_intent', { eventId, city: evt.city });

    bookingContent.innerHTML = `
      <div class="modal-header">
        <span class="age-badge-pill" style="margin-bottom: 0.5rem; display: inline-block;">Reserve Your Ticket</span>
        <h3 id="booking-modal-title" class="modal-title">${evt.title}</h3>
        <p style="color: var(--text-secondary); font-size: 0.9rem;">
          ${evt.areaName} • ${evt.priceLabel}
        </p>
      </div>

      ${evt.isDemo ? `<div class="sample-badge" style="margin-bottom: 1rem;">Development Sample Event</div>` : ''}

      <div id="booking-status-banner" class="alert-banner" style="display: none;"></div>

      <form id="ticket-booking-form">
        <div class="form-group">
          <label for="attendee-name" class="form-label">Full Name *</label>
          <input type="text" id="attendee-name" class="form-input" required placeholder="e.g. Priya Sundaram">
        </div>

        <div class="form-group">
          <label for="attendee-contact" class="form-label">Telegram Handle or Contact *</label>
          <input type="text" id="attendee-contact" class="form-input" required placeholder="@yourhandle or email / phone">
          <small style="color: var(--text-muted); font-size: 0.75rem; margin-top: 0.2rem;">Used solely to send secret venue coordinates 24 hours prior.</small>
        </div>

        <div class="form-group">
          <label for="ticket-count" class="form-label">Number of Tickets (Max 2)</label>
          <select id="ticket-count" class="form-select">
            <option value="1">1 Ticket (Solo Attendee)</option>
            <option value="2">2 Tickets (+ 21+ Guest)</option>
          </select>
        </div>

        <div class="form-group">
          <label for="booking-notes" class="form-label">Dietary or Accessibility Requests (Optional)</label>
          <input type="text" id="booking-notes" class="form-input" placeholder="e.g. Vegetarian, step-free access">
        </div>

        <div style="display: flex; gap: 1rem; margin-top: 1.5rem;">
          <button type="button" class="btn-secondary" onclick="document.getElementById('event-booking-dialog').close()" style="flex: 1;">
            Cancel
          </button>
          <button type="submit" id="submit-booking-btn" class="btn-primary" style="flex: 1;">
            Confirm Reservation
          </button>
        </div>
      </form>
    `;

    bookingDialog.showModal();

    const form = document.getElementById('ticket-booking-form');
    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        const submitBtn = document.getElementById('submit-booking-btn');
        const statusBanner = document.getElementById('booking-status-banner');

        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing...';

        try {
          const payload = {
            eventId: evt.id,
            attendeeName: document.getElementById('attendee-name').value,
            attendeeContact: document.getElementById('attendee-contact').value,
            ticketCount: parseInt(document.getElementById('ticket-count').value, 10) || 1,
            notes: document.getElementById('booking-notes').value
          };

          const res = await fetch('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();

          if (data.ok) {
            statusBanner.className = 'alert-banner alert-success';
            statusBanner.innerHTML = `
              <strong>✓ ${data.message}</strong>
              <div style="font-size: 0.8rem; margin-top: 0.5rem;">Reservation Ref: ${data.rsvpId}</div>
            `;
            statusBanner.style.display = 'block';
            form.style.display = 'none';

            // Refresh events grid to reflect real tickets_sold update
            loadEvents();
          } else {
            statusBanner.className = 'alert-banner alert-error';
            statusBanner.textContent = data.error || 'Failed to complete reservation.';
            statusBanner.style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Confirm Reservation';
          }
        } catch (err) {
          statusBanner.className = 'alert-banner alert-error';
          statusBanner.textContent = 'Network error. Please try again.';
          statusBanner.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Confirm Reservation';
        }
      });
    }
  };

  // 6. Filter Handlers
  window.filterByScope = function (scope) {
    activeScope = scope;
    document.querySelectorAll('.scope-tab').forEach(function (tab) {
      const isMatch = tab.getAttribute('data-scope') === scope;
      tab.classList.toggle('active', isMatch);
      tab.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    });
    trackEvent('filter_change', { metadata: { scope } });
    loadEvents();
  };

  window.filterByCity = function (city) {
    activeCity = city;
    const select = document.getElementById('filter-city');
    if (select) select.value = city;
    trackEvent('filter_change', { metadata: { city } });
    loadEvents();
  };

  window.filterByCategory = function (category) {
    activeCategory = category;
    const select = document.getElementById('filter-category');
    if (select) select.value = category;
    trackEvent('filter_change', { metadata: { category } });
    loadEvents();
  };

  window.filterByBudget = function (budget) {
    activeBudget = budget;
    const select = document.getElementById('filter-budget');
    if (select) select.value = budget;
    trackEvent('filter_change', { metadata: { budget } });
    loadEvents();
  };

  window.resetAllFilters = function () {
    activeScope = 'all';
    activeCity = 'all';
    activeCategory = 'all';
    activeBudget = 'all';

    document.querySelectorAll('.scope-tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-scope') === 'all');
    });

    const citySelect = document.getElementById('filter-city');
    if (citySelect) citySelect.value = 'all';

    const catSelect = document.getElementById('filter-category');
    if (catSelect) catSelect.value = 'all';

    const budgetSelect = document.getElementById('filter-budget');
    if (budgetSelect) budgetSelect.value = 'all';

    loadEvents();
  };

  // 7. Membership Checkout Trigger (Telegram Stars)
  window.initiateCheckout = async function (tierId) {
    trackEvent('checkout_initiate', { tierId });

    if (!checkoutDialog || !checkoutDetails || !checkoutBtn) {
      window.open('https://t.me/StrangersMeetupBot', '_blank');
      return;
    }

    checkoutDetails.innerHTML = '<p style="color: var(--text-muted);">Generating secure Telegram payment link...</p>';
    checkoutBtn.style.display = 'none';
    checkoutDialog.showModal();

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierId })
      });
      const data = await res.json();

      if (data.ok && data.invoiceLink) {
        checkoutDetails.innerHTML = `
          <div style="background: var(--bg-surface-elevated); padding: 1.25rem; border-radius: var(--radius-md); border: 1px solid var(--border-card); margin-bottom: 1rem;">
            <h4 style="font-size: 1.15rem; font-weight: 700; color: var(--text-primary); margin-bottom: 0.25rem;">${data.tierName}</h4>
            <p style="color: var(--accent-teal); font-weight: 600; font-size: 0.95rem; margin-bottom: 0.75rem;">${data.starsPriceLabel}</p>
            <p style="font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">${data.instructions}</p>
          </div>
          <p style="font-size: 0.75rem; color: var(--text-muted); line-height: 1.4;">
            * Billed exclusively in Telegram Stars. Self-service cancellation available anytime in Telegram settings.
          </p>
        `;
        checkoutBtn.href = data.invoiceLink;
        checkoutBtn.style.display = 'inline-flex';
      } else {
        checkoutDetails.innerHTML = `
          <div class="alert-banner alert-error">
            ${data.error || 'Unable to generate checkout link.'}
          </div>
          <p style="font-size: 0.85rem; color: var(--text-secondary); margin-top: 1rem;">
            You can also connect directly to our Telegram bot to activate membership:
          </p>
        `;
        checkoutBtn.href = 'https://t.me/StrangersMeetupBot';
        checkoutBtn.style.display = 'inline-flex';
      }
    } catch {
      checkoutDetails.innerHTML = `
        <div class="alert-banner alert-error">Network error. Please try again or join directly via Telegram.</div>
      `;
      checkoutBtn.href = 'https://t.me/StrangersMeetupBot';
      checkoutBtn.style.display = 'inline-flex';
    }
  };

  // 8. Mobile Menu Toggle
  if (mobileMenuToggle && mobileNav) {
    mobileMenuToggle.addEventListener('click', function () {
      const expanded = mobileMenuToggle.getAttribute('aria-expanded') === 'true';
      mobileMenuToggle.setAttribute('aria-expanded', !expanded);
      mobileNav.style.display = expanded ? 'none' : 'block';
    });

    mobileNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        mobileNav.style.display = 'none';
        mobileMenuToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // 9. Close Dialogs on Backdrop Click
  document.querySelectorAll('dialog').forEach(function (dialog) {
    dialog.addEventListener('click', function (e) {
      const rect = dialog.getBoundingClientRect();
      const isInDialog = (
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width
      );
      if (!isInDialog && dialog.id !== 'age-gate-dialog') {
        dialog.close();
      }
    });
  });

  // 10. Initial Lifecycle Trigger
  window.addEventListener('DOMContentLoaded', function () {
    checkAgeGateStatus();
    loadEvents();
    trackEvent('editorial_landing_view');
  });

})();
