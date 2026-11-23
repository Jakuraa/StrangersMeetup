// lib/views/venue.js - Server-rendered shell for the Venue Owner Dashboard.
// Interactive client functionality mounts from public/js/venue.js with styles in public/css/venue.css.
import { html, raw, esc } from './html.js';
import { layout, pageHeader } from './layout.js';
import { VENUE_CATEGORIES, VENUE_FACILITIES } from '../services/venue.js';

const ASSETS = raw('<link rel="stylesheet" href="/css/venue.css?v=2"><script src="/js/venue.js?v=2" defer></script>');

function gate(state, user = null, csrf = '') {
  if (state === 'signed_out') {
    return html`<section class="wrap narrow venue-gate">
      <div class="venue-gate-card">
        <span class="venue-badge">Venue Partner Portal</span>
        <h1>Sign in to manage your venue</h1>
        <p class="lede">Access your venue command dashboard, booking enquiries, events schedule, and performance telemetry.</p>
        <div class="venue-gate-actions">
          <a class="btn btn-tg btn-lg" href="/signin?next=${encodeURIComponent('/venue')}">Continue with Telegram</a>
        </div>
        <p class="muted small">Quick, passwordless sign-in. Your phone number is never shared with attendees.</p>
      </div>
    </section>`;
  }

  // Direct Self-Service Venue Onboarding for authenticated users who do not yet operate an active venue
  return html`<section class="wrap venue-gate" data-csrf="${csrf}">
    <div class="venue-onboarding-container">
      <div class="venue-onboarding-header text-center">
        <span class="venue-badge">⚡ Instant Self-Service Setup</span>
        <h1 class="venue-onboard-title">Launch Your Venue on NIGHTLIFEZ</h1>
        <p class="lede venue-onboard-lede">Zero waitlists or manual approvals. Fill in your space details to immediately unlock your venue dashboard, event scheduling, and host bookings.</p>
      </div>

      <!-- Profile Strength / Completion Progress Tracker -->
      <div class="venue-strength-card" id="venueStrengthTracker">
        <div class="venue-strength-header">
          <div class="venue-strength-info">
            <span class="strength-label">Profile Completion:</span>
            <span class="strength-percent" id="strengthPercent">0%</span>
            <span class="venue-pill venue-pill-pending" id="onboardStatusPill">Incomplete (Draft)</span>
          </div>
          <span class="strength-hint muted small" id="strengthHint">Fill in venue name, category, and city to start</span>
        </div>
        <div class="venue-progress-track" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" aria-label="Venue Profile Completion">
          <div class="venue-progress-fill" id="strengthProgressBar" style="width: 0%;"></div>
        </div>
      </div>

      <div class="venue-onboarding-card">
        <form class="lead-form venue-onboarding-form" id="venueOnboardForm" name="venueApplyForm" novalidate>
          <!-- Section 1: Venue Identity & Category -->
          <fieldset class="venue-form-section">
            <legend class="venue-section-title">1. Venue Identity &amp; Concept</legend>
            <div class="field-row">
              <label class="field">
                <span>Venue Name *</span>
                <input name="name" id="onboardName" type="text" required maxlength="120" placeholder="e.g. The Glasshouse Studio">
              </label>
              <label class="field">
                <span>Category *</span>
                <select name="category" id="onboardCategory" required>
                  <option value="">Select space category...</option>
                  ${VENUE_CATEGORIES.map(c => html`<option value="${c.id}">${c.label}</option>`)}
                </select>
              </label>
            </div>
            <label class="field">
              <span>Venue Description &amp; Vibe</span>
              <textarea name="description" id="onboardDesc" rows="3" maxlength="3000" placeholder="Describe the ambiance, aesthetic, music vibe, and signature offerings..."></textarea>
            </label>
          </fieldset>

          <!-- Section 2: Location & Neighbourhood -->
          <fieldset class="venue-form-section">
            <legend class="venue-section-title">2. Location &amp; Addresses</legend>
            <div class="field-row">
              <label class="field">
                <span>City *</span>
                <input name="city" id="onboardCity" type="text" required maxlength="80" placeholder="e.g. Bengaluru, Chennai, Kochi">
              </label>
              <label class="field">
                <span>Neighbourhood / Area</span>
                <input name="neighbourhood" id="onboardNeighbourhood" type="text" maxlength="120" placeholder="e.g. Indiranagar, Besant Nagar, Jubilee Hills">
              </label>
            </div>
            <label class="field">
              <span>Public Street Address</span>
              <input name="address_public" id="onboardAddressPublic" type="text" maxlength="300" placeholder="e.g. 100 Feet Road, Indiranagar">
              <span class="field-hint muted small">Displayed publicly on venue profile and event pages.</span>
            </label>
            <label class="field">
              <span>Private Access / Entry Directions</span>
              <textarea name="address_private" id="onboardAddressPrivate" rows="2" maxlength="500" placeholder="e.g. Gate 2 behind cafe, valet parking entry at rear"></textarea>
              <span class="field-hint muted small">Confidential. Disclosed only to confirmed hosts and ticketed attendees.</span>
            </label>
          </fieldset>

          <!-- Section 3: Capacity & Contact Person -->
          <fieldset class="venue-form-section">
            <legend class="venue-section-title">3. Capacity &amp; Point of Contact</legend>
            <div class="field-row">
              <label class="field">
                <span>Total Guest Capacity *</span>
                <input name="capacity" id="onboardCapacity" type="number" min="1" max="50000" required value="100">
              </label>
              <label class="field">
                <span>Contact Person Name</span>
                <input name="contact_name" id="onboardContactName" type="text" maxlength="120" value="${esc(user?.alias || '')}">
              </label>
            </div>
            <div class="field-row">
              <label class="field">
                <span>Contact Phone</span>
                <input name="contact_phone" id="onboardContactPhone" type="tel" maxlength="30" placeholder="+91 98765 43210">
              </label>
              <label class="field">
                <span>Contact Email</span>
                <input name="contact_email" id="onboardContactEmail" type="email" maxlength="120" placeholder="host@venue.com">
              </label>
            </div>
          </fieldset>

          <!-- Section 4: Facilities & Amenities -->
          <fieldset class="venue-form-section">
            <legend class="venue-section-title">4. Facilities &amp; Amenities</legend>
            <p class="muted small" style="margin-bottom: 12px;">Select all features available at your venue for event organisers.</p>
            <div class="facilities-checkbox-grid">
              ${VENUE_FACILITIES.map(fac => html`
                <label class="venue-checkbox-item">
                  <input type="checkbox" name="facilities" value="${fac.id}">
                  <span>${fac.icon} ${fac.label}</span>
                </label>
              `)}
            </div>
          </fieldset>

          <!-- Section 5: Operating Guidelines & Rules -->
          <fieldset class="venue-form-section">
            <legend class="venue-section-title">5. Operating Hours &amp; Guidelines</legend>
            <label class="field">
              <span>Operating Hours Overview</span>
              <input name="operating_hours_note" id="onboardHoursNote" type="text" maxlength="200" placeholder="e.g. Wed–Sun: 6 PM – 1 AM, Closed Mon–Tue">
            </label>
            <label class="field">
              <span>House Rules &amp; Entry Policies</span>
              <textarea name="rules" id="onboardRules" rows="2" maxlength="2000" placeholder="e.g. 21+ only, Smart casual dress code, Outside drinks prohibited"></textarea>
            </label>
          </fieldset>

          <!-- Section 6: Photos & Imagery -->
          <fieldset class="venue-form-section">
            <legend class="venue-section-title">6. Photos &amp; Visual Showcase</legend>
            <p class="muted small" style="margin-bottom: 12px;">Add photo URLs (Unsplash, Cloudinary, AWS S3, etc.) showcasing your space.</p>
            <div class="field-row">
              <label class="field">
                <span>Cover / Main Photo URL</span>
                <input name="photo_url_1" id="onboardPhoto1" type="url" placeholder="https://images.unsplash.com/photo-...">
              </label>
              <label class="field">
                <span>Interior / Ambience Photo URL</span>
                <input name="photo_url_2" id="onboardPhoto2" type="url" placeholder="https://images.unsplash.com/photo-...">
              </label>
            </div>
          </fieldset>

          <!-- Actions -->
          <div class="venue-onboard-actions-row">
            <button class="btn btn-primary btn-lg" type="submit" id="btnLaunchVenue">Complete &amp; Launch Venue Profile</button>
            <button class="btn btn-ghost btn-lg" type="button" id="btnSaveVenueDraft">Save Progress &amp; Continue Later</button>
          </div>
          <p class="form-msg" id="onboardMsg" role="status" aria-live="polite"></p>
        </form>
      </div>
    </div>
  </section>`;
}

export function renderVenuePage({ state = 'ok', user = null, csrf = '' } = {}) {
  const isOk = state === 'ok';

  let body = '';
  if (!isOk) {
    body = gate(state, user, csrf);
  } else {
    body = html`
      <div class="venue-app" data-csrf="${csrf}">
        <!-- Top Operational Header -->
        <header class="venue-header">
          <div class="wrap venue-header-inner">
            <div class="venue-brand-bar">
              <div class="venue-title-group">
                <span class="venue-eyebrow">Venue Command Centre</span>
                <div class="venue-name-row">
                  <h1 class="venue-heading" id="currentVenueName">Loading Venue…</h1>
                  <span class="venue-pill venue-pill-verified" id="venueVerifiedBadge" hidden>Verified Venue</span>
                  <span class="venue-pill venue-pill-status" id="venueStatusBadge">Active</span>
                </div>
              </div>
              <div class="venue-controls">
                <div class="venue-selector-wrap" id="venueSelectorWrap" hidden>
                  <label for="venueSelect" class="sr-only">Switch Venue</label>
                  <select id="venueSelect" class="venue-select" aria-label="Select Venue"></select>
                </div>
                <a href="/organiser/new" class="btn btn-primary btn-sm" id="btnCreateVenueEvent">+ Host / Create Event</a>
                <button type="button" class="btn btn-outline-cyan btn-sm" id="btnQuickEdit">Edit Profile</button>
                <button type="button" class="btn btn-ghost btn-sm" id="btnNewEnquiry">+ New Enquiry</button>
              </div>
            </div>

            <!-- Navigation Tabs -->
            <nav class="venue-tabs" role="tablist" aria-label="Venue Dashboard Sections">
              <button type="button" class="venue-tab-btn active" role="tab" id="tabOverview" data-target="overview" aria-selected="true" aria-controls="panelOverview">📊 Overview &amp; KPIs</button>
              <button type="button" class="venue-tab-btn" role="tab" id="tabProfile" data-target="profile" aria-selected="false" aria-controls="panelProfile">🏢 Profile &amp; Facilities</button>
              <button type="button" class="venue-tab-btn" role="tab" id="tabEvents" data-target="events" aria-selected="false" aria-controls="panelEvents">📅 Event Schedule</button>
              <button type="button" class="venue-tab-btn" role="tab" id="tabEnquiries" data-target="enquiries" aria-selected="false" aria-controls="panelEnquiries">📩 Organiser Enquiries <span class="tab-badge" id="enquiryBadge" hidden>0</span></button>
              <button type="button" class="venue-tab-btn" role="tab" id="tabStaff" data-target="staff" aria-selected="false" aria-controls="panelStaff">👥 Staff &amp; Team</button>
              <button type="button" class="venue-tab-btn" role="tab" id="tabSafety" data-target="safety" aria-selected="false" aria-controls="panelSafety">🛡️ Trust &amp; Safety</button>
              <button type="button" class="venue-tab-btn" role="tab" id="tabSettings" data-target="settings" aria-selected="false" aria-controls="panelSettings">⚙️ Settings</button>
            </nav>
          </div>
        </header>

        <!-- Main Operational Workspace -->
        <main class="wrap venue-main" id="venueMain">
          <!-- Live Feedback Banner -->
          <div class="venue-alert-banner" id="venueAlert" role="alert" aria-live="polite" hidden></div>

          <!-- Section 1: Overview & Analytics -->
          <section class="venue-panel active" id="panelOverview" role="tabpanel" aria-labelledby="tabOverview">
            <div class="venue-kpi-grid">
              <article class="kpi-card">
                <span class="kpi-label">Venue Capacity</span>
                <span class="kpi-val" id="kpiCapacity">—</span>
                <span class="kpi-sub" id="kpiCapacitySub">Standard setup</span>
              </article>
              <article class="kpi-card">
                <span class="kpi-label">Upcoming Events</span>
                <span class="kpi-val highlight-cyan" id="kpiUpcomingEvents">—</span>
                <span class="kpi-sub">Next 30 days</span>
              </article>
              <article class="kpi-card">
                <span class="kpi-label">Total Attendees Hosted</span>
                <span class="kpi-val highlight-pink" id="kpiTotalAttendees">—</span>
                <span class="kpi-sub">Lifetime guest footfall</span>
              </article>
              <article class="kpi-card">
                <span class="kpi-label">Avg Capacity Utilization</span>
                <span class="kpi-val" id="kpiAvgUtilization">—%</span>
                <span class="kpi-sub">Attendance vs capacity</span>
              </article>
              <article class="kpi-card">
                <span class="kpi-label">Pending Enquiries</span>
                <span class="kpi-val highlight-gold" id="kpiPendingEnquiries">—</span>
                <span class="kpi-sub">Awaiting decision</span>
              </article>
              <article class="kpi-card">
                <span class="kpi-label">Safety Status</span>
                <span class="kpi-val" id="kpiSafetyStatus">Good</span>
                <span class="kpi-sub" id="kpiOpenReports">0 active reports</span>
              </article>
            </div>

            <!-- Overview Content: Next Event & Recent Enquiries -->
            <div class="venue-overview-layout">
              <div class="venue-box">
                <div class="venue-box-header">
                  <h2>Next Upcoming Event</h2>
                  <a href="#events" class="link-cyan" id="linkAllEvents">View full schedule &rarr;</a>
                </div>
                <div id="overviewNextEvent"><p class="muted">Loading next event…</p></div>
              </div>

              <div class="venue-box">
                <div class="venue-box-header">
                  <h2>Recent Organiser Requests</h2>
                  <a href="#enquiries" class="link-cyan" id="linkAllEnquiries">View all enquiries &rarr;</a>
                </div>
                <div id="overviewRecentEnquiries"><p class="muted">Loading recent enquiries…</p></div>
              </div>
            </div>
          </section>

          <!-- Section 2: Profile & Facilities -->
          <section class="venue-panel" id="panelProfile" role="tabpanel" aria-labelledby="tabProfile" hidden>
            <div class="venue-box">
              <div class="venue-box-header">
                <div>
                  <h2>Venue Profile &amp; Business Information</h2>
                  <p class="muted">Public details displayed to event organisers and confirmed attendees.</p>
                </div>
                <button type="button" class="btn btn-outline-cyan btn-sm" id="btnEditProfile">Edit Details</button>
              </div>

              <div class="profile-details-grid" id="profileDetailsView">
                <p class="muted">Loading venue profile…</p>
              </div>

              <hr class="venue-divider">

              <h3>Facilities &amp; Amenities</h3>
              <div class="facilities-grid" id="profileFacilitiesView"></div>

              <hr class="venue-divider">

              <h3>Operating Hours &amp; Guidelines</h3>
              <div class="hours-grid" id="profileHoursView"></div>

              <hr class="venue-divider">

              <div class="venue-box-header">
                <div>
                  <h3>Photo Gallery &amp; Showcase</h3>
                  <p class="muted">Visual imagery shown on your venue listing and event pages.</p>
                </div>
              </div>
              <div class="venue-gallery-grid" id="profileGalleryView">
                <p class="muted">Loading photo gallery…</p>
              </div>
              <form id="formAddPhoto" class="venue-add-photo-bar" style="margin-top: 14px; display: flex; gap: 8px;">
                <input type="url" id="newPhotoUrl" class="input" placeholder="Paste image URL (https://...)" required style="flex: 1;">
                <button type="submit" class="btn btn-outline-cyan btn-sm">+ Add Photo</button>
              </form>
            </div>
          </section>

          <!-- Section 3: Event Schedule -->
          <section class="venue-panel" id="panelEvents" role="tabpanel" aria-labelledby="tabEvents" hidden>
            <div class="venue-box">
              <div class="venue-box-header">
                <div>
                  <h2>Associated Events Schedule</h2>
                  <p class="muted">Events hosted at your venue. Strictly isolated: individual attendee PII is protected.</p>
                </div>
                <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                  <a href="/organiser/new" class="btn btn-primary btn-sm" id="btnScheduleEvent">+ Create Event at Venue</a>
                  <div class="filter-btn-group" role="group" aria-label="Event time filters">
                    <button type="button" class="filter-btn active" data-event-filter="all">All</button>
                    <button type="button" class="filter-btn" data-event-filter="upcoming">Upcoming</button>
                    <button type="button" class="filter-btn" data-event-filter="past">Completed</button>
                  </div>
                </div>
              </div>

              <div id="eventsListContainer"><p class="muted">Loading event listings…</p></div>
            </div>
          </section>

          <!-- Section 4: Organiser Enquiries -->
          <section class="venue-panel" id="panelEnquiries" role="tabpanel" aria-labelledby="tabEnquiries" hidden>
            <div class="venue-box">
              <div class="venue-box-header">
                <div>
                  <h2>Organiser Requests &amp; Booking Enquiries</h2>
                  <p class="muted">Incoming private venue booking requests from event organisers.</p>
                </div>
                <div class="filter-btn-group" role="group" aria-label="Enquiry status filters">
                  <button type="button" class="filter-btn active" data-enquiry-filter="all">All</button>
                  <button type="button" class="filter-btn" data-enquiry-filter="pending">Pending</button>
                  <button type="button" class="filter-btn" data-enquiry-filter="approved">Approved</button>
                  <button type="button" class="filter-btn" data-enquiry-filter="declined">Declined</button>
                </div>
              </div>

              <div id="enquiriesListContainer"><p class="muted">Loading booking enquiries…</p></div>
            </div>
          </section>

          <!-- Section 5: Staff Coordination -->
          <section class="venue-panel" id="panelStaff" role="tabpanel" aria-labelledby="tabStaff" hidden>
            <div class="venue-box">
              <div class="venue-box-header">
                <div>
                  <h2>Staff &amp; Team Coordination</h2>
                  <p class="muted">Team members with operational access to this venue organisation.</p>
                </div>
                <button type="button" class="btn btn-outline-cyan btn-sm" id="btnAddStaff">+ Add Staff</button>
              </div>

              <div id="staffListContainer"><p class="muted">Loading team members…</p></div>
            </div>
          </section>

          <!-- Section 6: Safety & Escalation -->
          <section class="venue-panel" id="panelSafety" role="tabpanel" aria-labelledby="tabSafety" hidden>
            <div class="venue-box">
              <div class="venue-box-header">
                <div>
                  <h2>Trust, Safety &amp; Incident Escalation</h2>
                  <p class="muted">Confidential safety reports and direct operational escalations to NIGHTLIFEZ Trust &amp; Safety.</p>
                </div>
                <button type="button" class="btn btn-outline-pink btn-sm" id="btnReportIssue">🚨 Escalate Incident</button>
              </div>

              <div id="safetyListContainer"><p class="muted">Loading safety reports…</p></div>
            </div>
          </section>

          <!-- Section 7: Settings -->
          <section class="venue-panel" id="panelSettings" role="tabpanel" aria-labelledby="tabSettings" hidden>
            <div class="venue-box">
              <div class="venue-box-header">
                <div>
                  <h2>Notifications &amp; Account Settings</h2>
                  <p class="muted">Configure alerts and venue operational policies.</p>
                </div>
              </div>

              <form class="lead-form" id="venueSettingsForm">
                <h3>Quiet Hours &amp; Notification Windows</h3>
                <p class="muted">Mute non-urgent automated notifications in Asia/Kolkata timezone during quiet hours.</p>
                <label class="check">
                  <input type="checkbox" id="settingQuietHours" name="quietHoursEnabled">
                  <span>Enable Quiet Hours</span>
                </label>
                <div class="field-row" id="quietHoursRange">
                  <label class="field"><span>Quiet Hours Start</span><input type="time" id="settingQuietStart" name="quietHoursStart" value="23:00"></label>
                  <label class="field"><span>Quiet Hours End</span><input type="time" id="settingQuietEnd" name="quietHoursEnd" value="08:00"></label>
                </div>

                <hr class="venue-divider">

                <h3>Booking Notifications</h3>
                <label class="check">
                  <input type="checkbox" id="settingReminders" name="remindersEnabled" checked>
                  <span>Receive instant Telegram alerts for new booking enquiries</span>
                </label>

                <div class="form-action-row">
                  <button type="submit" class="btn btn-primary">Save Settings</button>
                  <p class="form-msg" id="settingsMsg" role="status" aria-live="polite"></p>
                </div>
              </form>
            </div>
          </section>
        </main>

        <!-- Modern Web Dialog Modals -->
        <!-- 1. Edit Profile Modal -->
        <dialog id="modalEditProfile" class="venue-dialog" aria-labelledby="modalEditTitle">
          <div class="venue-dialog-inner">
            <header class="venue-dialog-header">
              <h2 id="modalEditTitle">Edit Venue Profile</h2>
              <button type="button" class="venue-dialog-close" data-close-dialog aria-label="Close modal">&times;</button>
            </header>
            <form id="formEditProfile" class="venue-dialog-form">
              <div class="field-row">
                <label class="field"><span>Venue Name *</span><input name="name" type="text" required maxlength="120"></label>
                <label class="field"><span>Total Guest Capacity *</span><input name="capacity" type="number" min="1" max="100000" required></label>
              </div>
              <div class="field-row">
                <label class="field">
                  <span>Category</span>
                  <select name="category" id="editProfileCategory">
                    <option value="">Select Category...</option>
                    ${VENUE_CATEGORIES.map(c => html`<option value="${c.id}">${c.label}</option>`)}
                  </select>
                </label>
                <label class="field"><span>Neighbourhood / Locality</span><input name="neighbourhood" type="text" maxlength="120" placeholder="e.g. Indiranagar, Besant Nagar"></label>
              </div>
              <div class="field-row">
                <label class="field"><span>Contact Person</span><input name="contact_name" type="text" maxlength="120"></label>
                <label class="field"><span>Contact Phone</span><input name="contact_phone" type="tel" maxlength="30"></label>
              </div>
              <label class="field"><span>Contact Email</span><input name="contact_email" type="email" maxlength="120"></label>
              <label class="field"><span>Public Address (Neighborhood / Area)</span><input name="address_public" type="text" maxlength="300" placeholder="e.g. 5th Main, Indiranagar, Bengaluru"></label>
              <label class="field"><span>Private Address (Gate / Exact Entry for Confirmed Guests)</span><textarea name="address_private" rows="2" maxlength="500" placeholder="e.g. Gate 2, Behind Starbucks, Valet parking entry"></textarea></label>
              <label class="field"><span>Venue Description &amp; Ambiance</span><textarea name="description" rows="3" maxlength="3000"></textarea></label>
              <label class="field"><span>House Rules &amp; Entry Guidelines</span><textarea name="rules" rows="2" maxlength="2000" placeholder="e.g. 21+ only, Smart casuals, Outside drinks prohibited"></textarea></label>
              <label class="field"><span>Photo URLs (one per line)</span><textarea name="photos_text" id="editProfilePhotos" rows="2" placeholder="https://... photo URL"></textarea></label>

              <h3>Facilities &amp; Equipment</h3>
              <div class="facilities-checkbox-grid" id="modalFacilitiesCheckboxes"></div>

              <h3>Operating Hours</h3>
              <div class="hours-inputs-grid" id="modalHoursInputs"></div>

              <div class="venue-dialog-actions">
                <button type="button" class="btn btn-ghost" data-close-dialog>Cancel</button>
                <button type="submit" class="btn btn-primary">Save Changes</button>
              </div>
              <p class="form-msg" id="editProfileMsg" role="status" aria-live="polite"></p>
            </form>
          </div>
        </dialog>

        <!-- 2. Create Enquiry Modal -->
        <dialog id="modalNewEnquiry" class="venue-dialog" aria-labelledby="modalEnquiryTitle">
          <div class="venue-dialog-inner">
            <header class="venue-dialog-header">
              <h2 id="modalEnquiryTitle">Record Booking Request</h2>
              <button type="button" class="venue-dialog-close" data-close-dialog aria-label="Close modal">&times;</button>
            </header>
            <form id="formNewEnquiry" class="venue-dialog-form">
              <div class="field-row">
                <label class="field"><span>Organiser / Host Name *</span><input name="requester_name" type="text" required maxlength="120"></label>
                <label class="field"><span>Event Title *</span><input name="event_name" type="text" required maxlength="160" placeholder="e.g. Sunset Rooftop Social"></label>
              </div>
              <div class="field-row">
                <label class="field"><span>Event Date *</span><input name="event_date" type="date" required></label>
                <label class="field"><span>Expected Guests *</span><input name="expected_guests" type="number" min="1" max="50000" value="50" required></label>
              </div>
              <div class="field-row">
                <label class="field"><span>Start Time</span><input name="start_time" type="text" placeholder="19:00"></label>
                <label class="field"><span>End Time</span><input name="end_time" type="text" placeholder="23:30"></label>
              </div>
              <div class="field-row">
                <label class="field"><span>Organiser Email</span><input name="requester_email" type="email" maxlength="160"></label>
                <label class="field"><span>Organiser Phone</span><input name="requester_phone" type="tel" maxlength="30"></label>
              </div>
              <label class="field"><span>Budget / Rate Notes</span><input name="budget_notes" type="text" maxlength="500" placeholder="e.g. Minimum F&B spend ₹40,000"></label>
              <label class="field"><span>Notes &amp; Requirements</span><textarea name="notes" rows="2" maxlength="2000" placeholder="Sound requirements, layout preferences..."></textarea></label>
              <div class="venue-dialog-actions">
                <button type="button" class="btn btn-ghost" data-close-dialog>Cancel</button>
                <button type="submit" class="btn btn-primary">Create Enquiry</button>
              </div>
              <p class="form-msg" id="newEnquiryMsg" role="status" aria-live="polite"></p>
            </form>
          </div>
        </dialog>

        <!-- 3. Add Staff Modal -->
        <dialog id="modalAddStaff" class="venue-dialog" aria-labelledby="modalStaffTitle">
          <div class="venue-dialog-inner">
            <header class="venue-dialog-header">
              <h2 id="modalStaffTitle">Add Team Member</h2>
              <button type="button" class="venue-dialog-close" data-close-dialog aria-label="Close modal">&times;</button>
            </header>
            <form id="formAddStaff" class="venue-dialog-form">
              <p class="muted">Add a team member using their numeric Telegram User ID. The person must have signed in to NIGHTLIFEZ at least once.</p>
              <label class="field"><span>Telegram User ID *</span><input name="telegram_user_id" type="number" required placeholder="e.g. 9100000014"></label>
              <label class="field"><span>Role *</span>
                <select name="role" required>
                  <option value="manager">Manager (Can manage bookings &amp; view telemetry)</option>
                  <option value="staff">Staff (Operational &amp; door support)</option>
                  <option value="admin">Admin (Full venue operations)</option>
                </select>
              </label>
              <div class="venue-dialog-actions">
                <button type="button" class="btn btn-ghost" data-close-dialog>Cancel</button>
                <button type="submit" class="btn btn-primary">Add Member</button>
              </div>
              <p class="form-msg" id="addStaffMsg" role="status" aria-live="polite"></p>
            </form>
          </div>
        </dialog>

        <!-- 4. Escalate Incident Modal -->
        <dialog id="modalReportIssue" class="venue-dialog" aria-labelledby="modalReportTitle">
          <div class="venue-dialog-inner">
            <header class="venue-dialog-header">
              <h2 id="modalReportTitle">Escalate Safety Incident</h2>
              <button type="button" class="venue-dialog-close" data-close-dialog aria-label="Close modal">&times;</button>
            </header>
            <form id="formReportIssue" class="venue-dialog-form">
              <p class="muted">Direct confidential report to NIGHTLIFEZ Trust &amp; Safety operations team.</p>
              <label class="field"><span>Category *</span>
                <select name="category" required>
                  <option value="noise_complaint">Noise / Curfew Complaint</option>
                  <option value="overcrowding">Overcrowding Concern</option>
                  <option value="security_issue">Security / Altercation Incident</option>
                  <option value="property_damage">Property Damage</option>
                  <option value="medical_first_aid">Medical / First Aid Request</option>
                  <option value="organizer_misconduct">Organiser Policy Violation</option>
                  <option value="other">Other Operational Incident</option>
                </select>
              </label>
              <label class="field"><span>Incident Description &amp; Details *</span><textarea name="body" rows="4" required minlength="5" maxlength="3000" placeholder="Please detail the event name, timing, individuals involved, and immediate actions taken..."></textarea></label>
              <div class="venue-dialog-actions">
                <button type="button" class="btn btn-ghost" data-close-dialog>Cancel</button>
                <button type="submit" class="btn btn-outline-pink">Submit Escalation</button>
              </div>
              <p class="form-msg" id="reportIssueMsg" role="status" aria-live="polite"></p>
            </form>
          </div>
        </dialog>

        <!-- 5. Enquiry Decision Dialog -->
        <dialog id="modalDecideEnquiry" class="venue-dialog" aria-labelledby="modalDecideTitle">
          <div class="venue-dialog-inner">
            <header class="venue-dialog-header">
              <h2 id="modalDecideTitle">Decide Booking Request</h2>
              <button type="button" class="venue-dialog-close" data-close-dialog aria-label="Close modal">&times;</button>
            </header>
            <form id="formDecideEnquiry" class="venue-dialog-form">
              <input type="hidden" name="enquiry_id" id="decideEnquiryId">
              <input type="hidden" name="action" id="decideAction">
              <p id="decidePromptText" class="lead-prompt"></p>
              <div id="declineReasonGroup" hidden>
                <label class="field"><span>Reason for declining (shared with host)</span><textarea name="reason" rows="2" maxlength="500" placeholder="e.g. Venue booked for private wedding, maintenance scheduled..."></textarea></label>
              </div>
              <div class="venue-dialog-actions">
                <button type="button" class="btn btn-ghost" data-close-dialog>Cancel</button>
                <button type="submit" class="btn btn-primary" id="btnConfirmDecision">Confirm</button>
              </div>
              <p class="form-msg" id="decideEnquiryMsg" role="status" aria-live="polite"></p>
            </form>
          </div>
        </dialog>
      </div>
    `;
  }

  return layout({
    title: isOk ? 'Venue Command Centre' : 'Venue Partners',
    description: 'NIGHTLIFEZ Venue Partner Command Dashboard: bookings, event schedules, capacity telemetry, and safety.',
    path: '/venue',
    body,
    head: isOk ? ASSETS : (state === 'onboarding' ? ASSETS : ''),
    noindex: true,
    bodyClass: 'venue-body'
  });
}
