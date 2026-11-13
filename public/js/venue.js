// public/js/venue.js - Venue Owner Dashboard client application.
// Manages tabs, modals, real-time KPI updates, enquiries, event schedules, staff, and safety reports.
(function () {
  'use strict';

  var state = {
    csrf: '',
    venueId: null,
    context: null,
    profile: null,
    events: [],
    enquiries: [],
    staff: [],
    reports: [],
    analytics: null,
    eventFilter: 'all',
    enquiryFilter: 'all'
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.from((root || document).querySelectorAll(sel)); };

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function api(method, path, body) {
    var headers = { 'Accept': 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (state.csrf && method !== 'GET' && method !== 'HEAD') {
      headers['X-CSRF-Token'] = state.csrf;
    }

    var res = await fetch(path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    });

    var data = {};
    try { data = await res.json(); } catch (e) { data = { ok: false, error: 'invalid_json' }; }
    if (!res.ok) {
      var err = new Error(data.message || data.error || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showAlert(msg, isError) {
    var el = $('#venueAlert');
    if (!el) return;
    el.textContent = msg;
    el.className = 'venue-alert-banner' + (isError ? ' error' : '');
    el.hidden = false;
    setTimeout(function () { el.hidden = true; }, 5000);
  }

  // ---------- Facilities list ----------
  var ALL_FACILITIES = [
    { id: 'sound_system', label: 'Sound & DJ Console', icon: '🔊' },
    { id: 'air_conditioning', label: 'Air Conditioning', icon: '❄️' },
    { id: 'bar_license', label: 'Full Bar / Liquor License', icon: '🍸' },
    { id: 'valet_parking', label: 'Valet / Dedicated Parking', icon: '🚗' },
    { id: 'wheelchair_accessible', label: 'Wheelchair Accessible', icon: '♿' },
    { id: 'projector_av', label: 'Projector & AV Screens', icon: '📽️' },
    { id: 'security_bouncers', label: 'Dedicated Security / Bouncers', icon: '🛡️' },
    { id: 'green_room', label: 'Artist Green Room / Backstage', icon: '🎭' },
    { id: 'outdoor_terrace', label: 'Open-Air Terrace / Rooftop', icon: '🌆' },
    { id: 'food_catering', label: 'Kitchen / In-House Catering', icon: '🍽️' },
    { id: 'smoking_zone', label: 'Designated Smoking Zone', icon: '🚬' },
    { id: 'wifi_highspeed', label: 'High-Speed Wi-Fi', icon: '📶' }
  ];

  var DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  // ---------- Initialization ----------
  document.addEventListener('DOMContentLoaded', function () {
    var appRoot = $('.venue-app') || $('.venue-gate');
    if (!appRoot) return;

    state.csrf = appRoot.getAttribute('data-csrf') || '';

    // If onboarding form exists
    var applyForm = $('#venueApplyForm');
    if (applyForm) {
      initOnboarding(applyForm);
      return;
    }

    initTabs();
    initModals();
    initFilterButtons();
    loadDashboard();
  });

  // ---------- Onboarding Flow ----------
  function initOnboarding(form) {
    // Check if user has past applications
    api('GET', '/api/venue/context').then(function (res) {
      if (res.ok && res.context && res.context.applications && res.context.applications.length > 0) {
        var box = $('#applicationStatusBox');
        if (box) {
          var app = res.context.applications[0];
          box.hidden = false;
          box.innerHTML = '<h3>Recent Application: ' + esc(app.venueName) + '</h3>' +
            '<p>Status: <span class="venue-pill venue-pill-pending">' + esc(app.status.toUpperCase()) + '</span> — Submitted on ' +
            new Date(app.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '</p>' +
            '<p class="muted small" style="margin-top:6px;">Our venue team is reviewing your space details. You will receive an update once verified.</p>';
        }
      }
    }).catch(function () {});

    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var msg = $('#applyMsg');
      msg.textContent = 'Submitting application…';
      msg.className = 'form-msg';

      var fd = new FormData(form);
      var payload = {
        name: fd.get('name'),
        venue_name: fd.get('venue_name'),
        email: fd.get('email'),
        phone: fd.get('phone') || undefined,
        city: fd.get('city'),
        area: fd.get('area') || undefined,
        capacity: fd.get('capacity') ? Number(fd.get('capacity')) : undefined,
        message: fd.get('message') || undefined
      };

      try {
        var res = await api('POST', '/api/venue/apply', payload);
        msg.textContent = 'Application submitted successfully! Our team will contact you shortly.';
        msg.className = 'form-msg ok';
        form.reset();
      } catch (err) {
        msg.textContent = err.message || 'Could not submit application.';
        msg.className = 'form-msg error';
      }
    });
  }

  // ---------- Tab Navigation ----------
  function initTabs() {
    var tabs = $$('.venue-tab-btn');
    var panels = $$('.venue-panel');

    function switchTab(targetId) {
      tabs.forEach(function (t) {
        var match = t.getAttribute('data-target') === targetId;
        t.classList.toggle('active', match);
        t.setAttribute('aria-selected', match ? 'true' : 'false');
      });

      panels.forEach(function (p) {
        var match = p.id === 'panel' + targetId.charAt(0).toUpperCase() + targetId.slice(1);
        p.classList.toggle('active', match);
        p.hidden = !match;
      });

      window.location.hash = targetId;
    }

    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        switchTab(t.getAttribute('data-target'));
      });
    });

    // Handle hash on load
    if (window.location.hash) {
      var h = window.location.hash.replace('#', '');
      if ($('.venue-tab-btn[data-target="' + h + '"]')) {
        switchTab(h);
      }
    }

    // Direct links inside overview
    var linkEvents = $('#linkAllEvents');
    if (linkEvents) {
      linkEvents.addEventListener('click', function (e) {
        e.preventDefault();
        switchTab('events');
      });
    }
    var linkEnquiries = $('#linkAllEnquiries');
    if (linkEnquiries) {
      linkEnquiries.addEventListener('click', function (e) {
        e.preventDefault();
        switchTab('enquiries');
      });
    }
  }

  // ---------- Filters ----------
  function initFilterButtons() {
    $$('[data-event-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('[data-event-filter]').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.eventFilter = btn.getAttribute('data-event-filter');
        loadEvents();
      });
    });

    $$('[data-enquiry-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        $$('[data-enquiry-filter]').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        state.enquiryFilter = btn.getAttribute('data-enquiry-filter');
        loadEnquiries();
      });
    });
  }

  // ---------- Dialog Modals ----------
  function initModals() {
    $$('[data-close-dialog]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var d = btn.closest('dialog');
        if (d && typeof d.close === 'function') d.close();
      });
    });

    $$('dialog.venue-dialog').forEach(function (d) {
      d.addEventListener('click', function (e) {
        var rect = d.getBoundingClientRect();
        var isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height
          && rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
        if (!isInDialog && typeof d.close === 'function') {
          d.close();
        }
      });
    });

    var btnQuickEdit = $('#btnQuickEdit');
    var btnEditProfile = $('#btnEditProfile');
    var modalEdit = $('#modalEditProfile');
    var openEdit = function () {
      populateEditModal();
      if (modalEdit && typeof modalEdit.showModal === 'function') modalEdit.showModal();
    };
    if (btnQuickEdit) btnQuickEdit.addEventListener('click', openEdit);
    if (btnEditProfile) btnEditProfile.addEventListener('click', openEdit);

    var btnNewEnquiry = $('#btnNewEnquiry');
    var modalNewEnquiry = $('#modalNewEnquiry');
    if (btnNewEnquiry && modalNewEnquiry) {
      btnNewEnquiry.addEventListener('click', function () {
        $('#formNewEnquiry').reset();
        $('#newEnquiryMsg').textContent = '';
        var today = new Date().toISOString().split('T')[0];
        var dateInp = $('#formNewEnquiry input[name="event_date"]');
        if (dateInp) dateInp.min = today;
        modalNewEnquiry.showModal();
      });
    }

    var btnAddStaff = $('#btnAddStaff');
    var modalAddStaff = $('#modalAddStaff');
    if (btnAddStaff && modalAddStaff) {
      btnAddStaff.addEventListener('click', function () {
        $('#formAddStaff').reset();
        $('#addStaffMsg').textContent = '';
        modalAddStaff.showModal();
      });
    }

    var btnReportIssue = $('#btnReportIssue');
    var modalReport = $('#modalReportIssue');
    if (btnReportIssue && modalReport) {
      btnReportIssue.addEventListener('click', function () {
        $('#formReportIssue').reset();
        $('#reportIssueMsg').textContent = '';
        modalReport.showModal();
      });
    }

    bindFormSubmissions();
  }

  // ---------- Data Loading ----------
  async function loadDashboard() {
    try {
      var urlParams = new URLSearchParams(window.location.search);
      var venueParam = urlParams.get('venueId');

      var cRes = await api('GET', '/api/venue/context' + (venueParam ? '?venueId=' + encodeURIComponent(venueParam) : ''));
      state.context = cRes.context;

      if (!state.context || !state.context.hasVenue) {
        window.location.reload();
        return;
      }

      state.venueId = state.context.activeVenueId;
      var venue = state.context.activeVenue;

      // Header info
      var heading = $('#currentVenueName');
      if (heading) heading.textContent = venue.name;

      var verifiedBadge = $('#venueVerifiedBadge');
      if (verifiedBadge) verifiedBadge.hidden = !venue.orgVerified;

      // Venue selector
      var select = $('#venueSelect');
      var wrap = $('#venueSelectorWrap');
      if (state.context.venues && state.context.venues.length > 1 && select && wrap) {
        wrap.hidden = false;
        select.innerHTML = state.context.venues.map(function (v) {
          return '<option value="' + esc(v.id) + '"' + (v.id === state.venueId ? ' selected' : '') + '>' + esc(v.name) + '</option>';
        }).join('');
        select.onchange = function () {
          var nextId = select.value;
          window.location.search = '?venueId=' + encodeURIComponent(nextId);
        };
      }

      // Load all sections in parallel
      await Promise.all([
        loadProfile(),
        loadAnalytics(),
        loadEvents(),
        loadEnquiries(),
        loadStaff(),
        loadReports()
      ]);
    } catch (err) {
      showAlert(err.message || 'Error loading dashboard telemetry.', true);
    }
  }

  async function loadProfile() {
    try {
      var res = await api('GET', '/api/venue/profile?venueId=' + state.venueId);
      state.profile = res.profile;
      renderProfileView(state.profile);
    } catch (err) {
      var el = $('#profileDetailsView');
      if (el) el.innerHTML = '<p class="error">Failed to load profile details.</p>';
    }
  }

  async function loadAnalytics() {
    try {
      var res = await api('GET', '/api/venue/analytics?venueId=' + state.venueId);
      state.analytics = res.analytics;
      renderKPIs(state.analytics);
    } catch (err) {
      console.error('Analytics load error:', err);
    }
  }

  async function loadEvents() {
    var container = $('#eventsListContainer');
    if (!container) return;
    try {
      var res = await api('GET', '/api/venue/events?venueId=' + state.venueId + '&filter=' + state.eventFilter);
      state.events = res.events || [];
      renderEventsList(state.events, container);

      // Render next upcoming event in overview
      var nextEl = $('#overviewNextEvent');
      if (nextEl) {
        var upcoming = state.events.filter(function (e) { return new Date(e.startAt) >= new Date(); });
        if (upcoming.length === 0) {
          nextEl.innerHTML = '<p class="muted">No upcoming events scheduled at this venue.</p>';
        } else {
          var next = upcoming[0];
          nextEl.innerHTML = '<div class="profile-item">' +
            '<h3>' + esc(next.title) + '</h3>' +
            '<p class="muted">Hosted by ' + esc(next.hostName) + ' · ' +
            new Date(next.startAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + '</p>' +
            '<div class="utilization-bar-wrap" style="margin-top:10px;">' +
              '<div class="utilization-bar"><div class="utilization-fill' + (next.utilizationRate >= 90 ? ' high' : '') + '" style="width:' + Math.min(100, next.utilizationRate) + '%;"></div></div>' +
              '<span><strong>' + next.totalBooked + '</strong> / ' + next.venueCapacity + ' guests (' + next.utilizationRate + '%)</span>' +
            '</div>' +
          '</div>';
        }
      }
    } catch (err) {
      container.innerHTML = '<p class="error">Could not load event listings.</p>';
    }
  }

  async function loadEnquiries() {
    var container = $('#enquiriesListContainer');
    if (!container) return;
    try {
      var res = await api('GET', '/api/venue/enquiries?venueId=' + state.venueId + '&status=' + state.enquiryFilter);
      state.enquiries = res.enquiries || [];
      renderEnquiriesList(state.enquiries, container);

      // Update badge
      var pending = state.enquiries.filter(function (e) { return e.status === 'pending'; });
      var badge = $('#enquiryBadge');
      if (badge) {
        if (pending.length > 0) {
          badge.textContent = pending.length;
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }

      // Render overview recent enquiries
      var overviewEl = $('#overviewRecentEnquiries');
      if (overviewEl) {
        if (state.enquiries.length === 0) {
          overviewEl.innerHTML = '<p class="muted">No booking enquiries received yet.</p>';
        } else {
          var recent = state.enquiries.slice(0, 3);
          overviewEl.innerHTML = recent.map(function (e) {
            return '<div style="padding:10px 0; border-bottom:1px solid var(--line);">' +
              '<strong>' + esc(e.eventName) + '</strong> (' + esc(e.expectedGuests) + ' guests)' +
              '<br><span class="muted">' + esc(e.requesterName) + ' · ' + esc(e.eventDate) + ' · ' +
              '<span class="venue-pill venue-pill-' + esc(e.status) + '">' + esc(e.status.toUpperCase()) + '</span></span>' +
            '</div>';
          }).join('');
        }
      }
    } catch (err) {
      container.innerHTML = '<p class="error">Could not load booking enquiries.</p>';
    }
  }

  async function loadStaff() {
    var container = $('#staffListContainer');
    if (!container) return;
    try {
      var res = await api('GET', '/api/venue/staff?venueId=' + state.venueId);
      state.staff = res.staff || [];
      renderStaffList(state.staff, container);
    } catch (err) {
      container.innerHTML = '<p class="error">Could not load staff members.</p>';
    }
  }

  async function loadReports() {
    var container = $('#safetyListContainer');
    if (!container) return;
    try {
      var res = await api('GET', '/api/venue/reports?venueId=' + state.venueId);
      state.reports = res.reports || [];
      renderReportsList(state.reports, container);
    } catch (err) {
      container.innerHTML = '<p class="error">Could not load safety reports.</p>';
    }
  }

  // ---------- Render Views ----------
  function renderKPIs(k) {
    if (!k) return;
    var set = function (id, val) { var el = $(id); if (el) el.textContent = val; };
    set('#kpiCapacity', k.venueCapacity || '—');
    set('#kpiUpcomingEvents', k.upcomingEvents || '0');
    set('#kpiTotalAttendees', (k.totalAttendees || 0).toLocaleString());
    set('#kpiAvgUtilization', (k.avgUtilization || 0) + '%');
    set('#kpiPendingEnquiries', k.pendingEnquiries || '0');
    set('#kpiOpenReports', (k.openReports || 0) + ' active reports');
    var statusEl = $('#kpiSafetyStatus');
    if (statusEl) {
      statusEl.textContent = k.openReports === 0 ? 'Clear' : 'Attention';
      statusEl.style.color = k.openReports === 0 ? '#4ade80' : '#ffd15c';
    }
  }

  function renderProfileView(p) {
    var el = $('#profileDetailsView');
    if (!el) return;

    el.innerHTML = [
      '<div class="profile-item"><dt>Venue Display Name</dt><dd>' + esc(p.name) + '</dd></div>',
      '<div class="profile-item"><dt>Operating Organisation</dt><dd>' + esc(p.orgName) + (p.orgVerified ? ' (Verified)' : '') + '</dd></div>',
      '<div class="profile-item"><dt>Maximum Capacity</dt><dd>' + esc(p.capacity || 'Not specified') + ' guests</dd></div>',
      '<div class="profile-item"><dt>City & Locality</dt><dd>' + esc((p.cityName || '') + (p.localityName ? ', ' + p.localityName : '')) + '</dd></div>',
      '<div class="profile-item"><dt>Public Area</dt><dd>' + esc(p.addressPublic || 'Not specified') + '</dd></div>',
      '<div class="profile-item"><dt>Private Gate / Exact Entry</dt><dd>' + esc(p.addressPrivate || 'Private address shared only with confirmed attendees') + '</dd></div>',
      '<div class="profile-item"><dt>Primary Contact</dt><dd>' + esc((p.contactName || '') + (p.contactPhone ? ' (' + p.contactPhone + ')' : '') + (p.contactEmail ? ' · ' + p.contactEmail : '')) + '</dd></div>',
      '<div class="profile-item" style="grid-column: 1 / -1;"><dt>About & Ambiance</dt><dd>' + esc(p.description || 'No description provided yet.') + '</dd></div>',
      '<div class="profile-item" style="grid-column: 1 / -1;"><dt>House Rules & Entry Policy</dt><dd>' + esc(p.rules || 'Standard NIGHTLIFEZ community and safety guidelines apply.') + '</dd></div>'
    ].join('');

    // Facilities
    var fEl = $('#profileFacilitiesView');
    if (fEl) {
      var activeFacs = p.facilities || [];
      if (activeFacs.length === 0) {
        fEl.innerHTML = '<p class="muted">No specific amenities configured yet.</p>';
      } else {
        fEl.innerHTML = activeFacs.map(function (fId) {
          var item = ALL_FACILITIES.find(function (x) { return x.id === fId; }) || { label: fId, icon: '✓' };
          return '<div class="facility-pill"><span class="facility-icon">' + item.icon + '</span> <span>' + esc(item.label) + '</span></div>';
        }).join('');
      }
    }

    // Hours
    var hEl = $('#profileHoursView');
    if (hEl) {
      var hours = p.operatingHours || {};
      hEl.innerHTML = DAYS.map(function (d) {
        var val = hours[d] || 'Closed';
        return '<div class="hour-card"><span class="hour-day">' + d + '</span><span>' + esc(val) + '</span></div>';
      }).join('');
    }
  }

  function renderEventsList(events, container) {
    if (!events || events.length === 0) {
      container.innerHTML = '<p class="muted" style="padding:20px 0;">No events matching this filter.</p>';
      return;
    }

    var rows = events.map(function (e) {
      var dateStr = new Date(e.startAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      var cap = e.venueCapacity || 100;
      var util = e.utilizationRate || 0;

      return '<tr>' +
        '<td><strong>' + esc(e.title) + '</strong><br><span class="muted">' + esc(e.category) + (e.isDemo ? ' · Demo' : '') + '</span></td>' +
        '<td>' + esc(dateStr) + '</td>' +
        '<td>' + esc(e.hostName) + '</td>' +
        '<td>' +
          '<div class="utilization-bar-wrap">' +
            '<div class="utilization-bar"><div class="utilization-fill' + (util >= 90 ? ' high' : '') + '" style="width:' + Math.min(100, util) + '%;"></div></div>' +
            '<span>' + e.totalBooked + ' / ' + cap + ' (' + util + '%)</span>' +
          '</div>' +
        '</td>' +
        '<td><span class="venue-pill venue-pill-status">' + esc(e.status.toUpperCase()) + '</span></td>' +
      '</tr>';
    }).join('');

    container.innerHTML = '<div class="venue-data-table-wrap">' +
      '<table class="venue-table">' +
        '<thead><tr><th>Event</th><th>Date &amp; Time (IST)</th><th>Host / Organiser</th><th>Attendance / Capacity</th><th>Status</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function renderEnquiriesList(enquiries, container) {
    if (!enquiries || enquiries.length === 0) {
      container.innerHTML = '<p class="muted" style="padding:20px 0;">No organiser requests matching this filter.</p>';
      return;
    }

    var rows = enquiries.map(function (enq) {
      var statusBadge = '<span class="venue-pill venue-pill-' + esc(enq.status) + '">' + esc(enq.status.toUpperCase()) + '</span>';
      var actions = '';
      if (enq.status === 'pending') {
        actions = '<div class="enquiry-action-row">' +
          '<button type="button" class="btn btn-outline-cyan btn-sm" data-decide-btn="approve" data-enquiry-id="' + esc(enq.id) + '" data-event-name="' + esc(enq.eventName) + '">Approve</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-decide-btn="decline" data-enquiry-id="' + esc(enq.id) + '" data-event-name="' + esc(enq.eventName) + '">Decline</button>' +
        '</div>';
      } else if (enq.declineReason) {
        actions = '<span class="muted small">Reason: ' + esc(enq.declineReason) + '</span>';
      } else {
        actions = '<span class="muted small">—</span>';
      }

      return '<tr>' +
        '<td><strong>' + esc(enq.eventName) + '</strong><br><span class="muted">' + esc(enq.notes || 'No extra notes') + '</span></td>' +
        '<td>' + esc(enq.eventDate) + (enq.startTime ? '<br><span class="muted">' + esc(enq.startTime) + ' - ' + esc(enq.endTime || '') + '</span>' : '') + '</td>' +
        '<td><strong>' + esc(enq.requesterName) + '</strong>' +
          (enq.requesterPhone ? '<br><span class="muted">' + esc(enq.requesterPhone) + '</span>' : '') +
          (enq.requesterEmail ? '<br><span class="muted">' + esc(enq.requesterEmail) + '</span>' : '') +
        '</td>' +
        '<td>' + esc(enq.expectedGuests) + ' guests' + (enq.budgetNotes ? '<br><span class="muted">' + esc(enq.budgetNotes) + '</span>' : '') + '</td>' +
        '<td>' + statusBadge + '</td>' +
        '<td>' + actions + '</td>' +
      '</tr>';
    }).join('');

    container.innerHTML = '<div class="venue-data-table-wrap">' +
      '<table class="venue-table">' +
        '<thead><tr><th>Event Request</th><th>Requested Date</th><th>Organiser Contact</th><th>Guest Count</th><th>Status</th><th>Actions</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';

    // Bind decision buttons
    $$('[data-decide-btn]', container).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-decide-btn');
        var enquiryId = btn.getAttribute('data-enquiry-id');
        var eventName = btn.getAttribute('data-event-name');
        openDecisionModal(enquiryId, action, eventName);
      });
    });
  }

  function renderStaffList(staff, container) {
    if (!staff || staff.length === 0) {
      container.innerHTML = '<p class="muted">No team members listed.</p>';
      return;
    }

    var rows = staff.map(function (m) {
      var rolePill = '<span class="venue-pill venue-pill-verified">' + esc(m.role.toUpperCase()) + '</span>';
      return '<tr>' +
        '<td><strong>' + esc(m.alias) + '</strong></td>' +
        '<td>' + rolePill + '</td>' +
        '<td><span class="venue-pill venue-pill-status">' + esc(m.status.toUpperCase()) + '</span></td>' +
        '<td>' + new Date(m.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + '</td>' +
      '</tr>';
    }).join('');

    container.innerHTML = '<div class="venue-data-table-wrap">' +
      '<table class="venue-table">' +
        '<thead><tr><th>Name / Alias</th><th>Role</th><th>Status</th><th>Member Since</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function renderReportsList(reports, container) {
    if (!reports || reports.length === 0) {
      container.innerHTML = '<p class="muted" style="padding:20px 0;">No safety or incident reports on record. All systems normal.</p>';
      return;
    }

    var rows = reports.map(function (r) {
      var dateStr = new Date(r.createdAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      return '<tr>' +
        '<td><strong>' + esc(r.category.replace(/_/g, ' ').toUpperCase()) + '</strong>' +
          (r.eventTitle ? '<br><span class="muted">Linked: ' + esc(r.eventTitle) + '</span>' : '') + '</td>' +
        '<td>' + esc(r.body) + '</td>' +
        '<td><span class="venue-pill venue-pill-pending">' + esc(r.status.toUpperCase()) + '</span></td>' +
        '<td>' + esc(dateStr) + '</td>' +
      '</tr>';
    }).join('');

    container.innerHTML = '<div class="venue-data-table-wrap">' +
      '<table class="venue-table">' +
        '<thead><tr><th>Category</th><th>Description</th><th>Status</th><th>Submitted (IST)</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
  }

  // ---------- Form Submissions ----------
  function bindFormSubmissions() {
    // 1. Edit Profile Form
    var formEdit = $('#formEditProfile');
    if (formEdit) {
      formEdit.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = $('#editProfileMsg');
        msg.textContent = 'Saving venue changes…';
        msg.className = 'form-msg';

        var fd = new FormData(formEdit);
        var selectedFacs = $$('#modalFacilitiesCheckboxes input[type="checkbox"]:checked').map(function (i) { return i.value; });

        var hours = {};
        DAYS.forEach(function (d) {
          var val = fd.get('hours_' + d);
          if (val) hours[d] = val;
        });

        var payload = {
          name: fd.get('name'),
          capacity: fd.get('capacity') ? Number(fd.get('capacity')) : null,
          contact_name: fd.get('contact_name') || null,
          contact_phone: fd.get('contact_phone') || null,
          contact_email: fd.get('contact_email') || null,
          address_public: fd.get('address_public') || null,
          address_private: fd.get('address_private') || null,
          description: fd.get('description') || null,
          rules: fd.get('rules') || null,
          facilities: selectedFacs,
          operating_hours: hours
        };

        try {
          await api('PATCH', '/api/venue/profile?venueId=' + state.venueId, payload);
          msg.textContent = 'Venue profile updated successfully!';
          msg.className = 'form-msg ok';
          showAlert('Venue profile updated.');
          setTimeout(function () {
            $('#modalEditProfile').close();
            loadProfile();
            loadAnalytics();
          }, 800);
        } catch (err) {
          msg.textContent = err.message || 'Error updating profile.';
          msg.className = 'form-msg error';
        }
      });
    }

    // 2. New Enquiry Form
    var formNewEnquiry = $('#formNewEnquiry');
    if (formNewEnquiry) {
      formNewEnquiry.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = $('#newEnquiryMsg');
        msg.textContent = 'Creating enquiry…';
        msg.className = 'form-msg';

        var fd = new FormData(formNewEnquiry);
        var payload = {
          requester_name: fd.get('requester_name'),
          event_name: fd.get('event_name'),
          event_date: fd.get('event_date'),
          expected_guests: Number(fd.get('expected_guests') || 50),
          start_time: fd.get('start_time') || undefined,
          end_time: fd.get('end_time') || undefined,
          requester_email: fd.get('requester_email') || undefined,
          requester_phone: fd.get('requester_phone') || undefined,
          budget_notes: fd.get('budget_notes') || undefined,
          notes: fd.get('notes') || undefined
        };

        try {
          await api('POST', '/api/venue/enquiries?venueId=' + state.venueId, payload);
          msg.textContent = 'Enquiry recorded successfully!';
          msg.className = 'form-msg ok';
          showAlert('Booking enquiry recorded.');
          setTimeout(function () {
            $('#modalNewEnquiry').close();
            loadEnquiries();
            loadAnalytics();
          }, 800);
        } catch (err) {
          msg.textContent = err.message || 'Error creating enquiry.';
          msg.className = 'form-msg error';
        }
      });
    }

    // 3. Add Staff Form
    var formAddStaff = $('#formAddStaff');
    if (formAddStaff) {
      formAddStaff.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = $('#addStaffMsg');
        msg.textContent = 'Adding team member…';
        msg.className = 'form-msg';

        var fd = new FormData(formAddStaff);
        var payload = {
          telegram_user_id: Number(fd.get('telegram_user_id')),
          role: fd.get('role')
        };

        try {
          await api('POST', '/api/venue/staff?venueId=' + state.venueId, payload);
          msg.textContent = 'Member added successfully!';
          msg.className = 'form-msg ok';
          showAlert('Team member added.');
          setTimeout(function () {
            $('#modalAddStaff').close();
            loadStaff();
          }, 800);
        } catch (err) {
          msg.textContent = err.message || 'Error adding staff.';
          msg.className = 'form-msg error';
        }
      });
    }

    // 4. Report Safety Issue Form
    var formReportIssue = $('#formReportIssue');
    if (formReportIssue) {
      formReportIssue.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = $('#reportIssueMsg');
        msg.textContent = 'Submitting report to Trust & Safety…';
        msg.className = 'form-msg';

        var fd = new FormData(formReportIssue);
        var payload = {
          category: fd.get('category'),
          body: fd.get('body')
        };

        try {
          await api('POST', '/api/venue/reports?venueId=' + state.venueId, payload);
          msg.textContent = 'Incident escalated to Trust & Safety.';
          msg.className = 'form-msg ok';
          showAlert('Incident report submitted.');
          setTimeout(function () {
            $('#modalReportIssue').close();
            loadReports();
            loadAnalytics();
          }, 800);
        } catch (err) {
          msg.textContent = err.message || 'Error submitting report.';
          msg.className = 'form-msg error';
        }
      });
    }

    // 5. Decision Form
    var formDecide = $('#formDecideEnquiry');
    if (formDecide) {
      formDecide.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = $('#decideEnquiryMsg');
        msg.textContent = 'Submitting decision…';
        msg.className = 'form-msg';

        var enquiryId = $('#decideEnquiryId').value;
        var action = $('#decideAction').value;
        var fd = new FormData(formDecide);
        var reason = fd.get('reason') || undefined;

        try {
          await api('POST', '/api/venue/enquiries/' + encodeURIComponent(enquiryId) + '/decide', {
            action: action,
            reason: reason
          });
          msg.textContent = 'Decision recorded successfully.';
          msg.className = 'form-msg ok';
          showAlert('Booking enquiry ' + (action === 'approve' ? 'approved' : 'declined') + '.');
          setTimeout(function () {
            $('#modalDecideEnquiry').close();
            loadEnquiries();
            loadAnalytics();
          }, 800);
        } catch (err) {
          msg.textContent = err.message || 'Error updating enquiry.';
          msg.className = 'form-msg error';
        }
      });
    }

    // 6. Settings Form
    var formSettings = $('#venueSettingsForm');
    if (formSettings) {
      // Load user notification preferences
      api('GET', '/api/me/notification-preferences').then(function (res) {
        if (res.ok && res.preferences) {
          var p = res.preferences;
          var qh = $('#settingQuietHours');
          var rem = $('#settingReminders');
          var qs = $('#settingQuietStart');
          var qe = $('#settingQuietEnd');
          if (qh) qh.checked = Boolean(p.quietHoursEnabled);
          if (rem) rem.checked = Boolean(p.remindersEnabled);
          if (qs && p.quietHoursStart) qs.value = p.quietHoursStart;
          if (qe && p.quietHoursEnd) qe.value = p.quietHoursEnd;
        }
      }).catch(function () {});

      formSettings.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = $('#settingsMsg');
        msg.textContent = 'Saving preferences…';
        msg.className = 'form-msg';

        var fd = new FormData(formSettings);
        var payload = {
          quietHoursEnabled: $('#settingQuietHours').checked,
          remindersEnabled: $('#settingReminders').checked,
          quietHoursStart: fd.get('quietHoursStart') || '23:00',
          quietHoursEnd: fd.get('quietHoursEnd') || '08:00'
        };

        try {
          await api('PATCH', '/api/me/notification-preferences', payload);
          msg.textContent = 'Preferences saved successfully.';
          msg.className = 'form-msg ok';
          showAlert('Notification preferences saved.');
        } catch (err) {
          msg.textContent = err.message || 'Error saving preferences.';
          msg.className = 'form-msg error';
        }
      });
    }
  }

  function openDecisionModal(enquiryId, action, eventName) {
    var modal = $('#modalDecideEnquiry');
    if (!modal) return;
    $('#decideEnquiryId').value = enquiryId;
    $('#decideAction').value = action;
    $('#decideEnquiryMsg').textContent = '';

    var prompt = $('#decidePromptText');
    var reasonGroup = $('#declineReasonGroup');
    var btn = $('#btnConfirmDecision');

    if (action === 'approve') {
      prompt.innerHTML = 'Confirm approval of <strong>' + esc(eventName) + '</strong>? The host will be notified of the confirmed date reservation.';
      reasonGroup.hidden = true;
      btn.textContent = 'Approve Reservation';
      btn.className = 'btn btn-primary';
    } else {
      prompt.innerHTML = 'Decline booking request for <strong>' + esc(eventName) + '</strong>?';
      reasonGroup.hidden = false;
      btn.textContent = 'Decline Request';
      btn.className = 'btn btn-outline-pink';
    }

    modal.showModal();
  }

  function populateEditModal() {
    var p = state.profile;
    if (!p) return;
    var form = $('#formEditProfile');
    if (!form) return;

    var setVal = function (name, v) {
      var inp = form.elements[name];
      if (inp) inp.value = v == null ? '' : v;
    };

    setVal('name', p.name);
    setVal('capacity', p.capacity);
    setVal('contact_name', p.contactName);
    setVal('contact_phone', p.contactPhone);
    setVal('contact_email', p.contactEmail);
    setVal('address_public', p.addressPublic);
    setVal('address_private', p.addressPrivate);
    setVal('description', p.description);
    setVal('rules', p.rules);

    // Facilities checkboxes
    var facsContainer = $('#modalFacilitiesCheckboxes');
    if (facsContainer) {
      var active = p.facilities || [];
      facsContainer.innerHTML = ALL_FACILITIES.map(function (f) {
        var isChecked = active.indexOf(f.id) !== -1;
        return '<label class="check">' +
          '<input type="checkbox" value="' + esc(f.id) + '"' + (isChecked ? ' checked' : '') + '> ' +
          '<span>' + f.icon + ' ' + esc(f.label) + '</span>' +
        '</label>';
      }).join('');
    }

    // Operating hours inputs
    var hoursContainer = $('#modalHoursInputs');
    if (hoursContainer) {
      var h = p.operatingHours || {};
      hoursContainer.innerHTML = DAYS.map(function (d) {
        var val = h[d] || '18:00 - 01:00';
        return '<label class="field"><span style="text-transform:capitalize;">' + d + '</span>' +
          '<input name="hours_' + d + '" type="text" value="' + esc(val) + '">' +
        '</label>';
      }).join('');
    }
  }

})();
