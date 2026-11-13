// lib/views/venue.js - Server-rendered shell for the Venue Owner Dashboard.
// Interactive client functionality mounts from public/js/venue.js with styles in public/css/venue.css.
import { html, raw, esc } from './html.js';
import { layout, pageHeader } from './layout.js';

const ASSETS = raw('<link rel="stylesheet" href="/css/venue.css?v=1"><script src="/js/venue.js?v=1" defer></script>');

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

  // Onboarding / Application state for logged-in users who do not yet operate an active venue
  return html`<section class="wrap venue-gate" data-csrf="${csrf}">
    <div class="venue-onboarding-grid">
      <div class="venue-onboarding-intro">
        <span class="venue-badge">Partner With NIGHTLIFEZ</span>
        <h1>Turn quiet nights into curated, high-margin experiences</h1>
        <p class="lede">NIGHTLIFEZ connects vetted event organisers, dinner clubs, and party hosts with South India’s finest venues.</p>
        <ul class="venue-perks-list">
          <li><strong>Direct Organiser Enquiries:</strong> Receive verified booking requests for private dinners, listening sessions, and weekend mixers.</li>
          <li><strong>Capacity &amp; Schedule Control:</strong> Review event concepts and approve dates that fit your operating calendar.</li>
          <li><strong>Zero Attendee Chaos:</strong> Organisers handle RSVPs, ticketing, and door coordination through NIGHTLIFEZ.</li>
          <li><strong>Verified Operator Status:</strong> Trusted badge across our South India discovery feed.</li>
        </ul>
        <div id="applicationStatusBox" class="venue-status-box" hidden></div>
      </div>

      <div class="venue-onboarding-form-card">
        <h2>Submit Venue Application</h2>
        <p class="muted">Tell us about your space. Our venue curation team reviews every application within 24 to 48 hours.</p>
        <form class="lead-form" id="venueApplyForm" novalidate>
          <div class="field-row">
            <label class="field"><span>Your Name *</span><input name="name" type="text" required maxlength="120" value="${esc(user?.alias || '')}"></label>
            <label class="field"><span>Venue Name *</span><input name="venue_name" type="text" required maxlength="160" placeholder="e.g. The Rooftop Lounge"></label>
          </div>
          <div class="field-row">
            <label class="field"><span>Contact Email *</span><input name="email" type="email" required maxlength="160" placeholder="host@venue.com"></label>
            <label class="field"><span>Phone Number</span><input name="phone" type="tel" maxlength="30" placeholder="+91 98765 43210"></label>
          </div>
          <div class="field-row">
            <label class="field"><span>City *</span><input name="city" type="text" required maxlength="80" placeholder="e.g. Chennai, Bengaluru, Kochi"></label>
            <label class="field"><span>Area / Locality</span><input name="area" type="text" maxlength="120" placeholder="e.g. Besant Nagar, Indiranagar"></label>
          </div>
          <label class="field"><span>Capacity (Comfortable group size) *</span><input name="capacity" type="number" min="10" max="5000" placeholder="80"></label>
          <label class="field"><span>Tell us about your venue &amp; vibe</span><textarea name="message" rows="3" maxlength="2000" placeholder="Describe the ambiance, operating timings, sound setup, or beverage offerings..."></textarea></label>
          <button class="btn btn-primary btn-block btn-lg" type="submit">Submit Application</button>
          <p class="form-msg" id="applyMsg" role="status" aria-live="polite"></p>
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
                <button type="button" class="btn btn-outline-cyan btn-sm" id="btnQuickEdit">Edit Profile</button>
                <button type="button" class="btn btn-primary btn-sm" id="btnNewEnquiry">+ New Enquiry</button>
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
                <div class="filter-btn-group" role="group" aria-label="Event time filters">
                  <button type="button" class="filter-btn active" data-event-filter="all">All</button>
                  <button type="button" class="filter-btn" data-event-filter="upcoming">Upcoming</button>
                  <button type="button" class="filter-btn" data-event-filter="past">Completed</button>
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
                <label class="field"><span>Contact Person</span><input name="contact_name" type="text" maxlength="120"></label>
                <label class="field"><span>Contact Phone</span><input name="contact_phone" type="tel" maxlength="30"></label>
              </div>
              <label class="field"><span>Contact Email</span><input name="contact_email" type="email" maxlength="120"></label>
              <label class="field"><span>Public Address (Neighborhood / Area)</span><input name="address_public" type="text" maxlength="300" placeholder="e.g. 5th Main, Indiranagar, Bengaluru"></label>
              <label class="field"><span>Private Address (Gate / Exact Entry for Confirmed Guests)</span><textarea name="address_private" rows="2" maxlength="500" placeholder="e.g. Gate 2, Behind Starbucks, Valet parking entry"></textarea></label>
              <label class="field"><span>Venue Description &amp; Ambiance</span><textarea name="description" rows="3" maxlength="3000"></textarea></label>
              <label class="field"><span>House Rules &amp; Entry Guidelines</span><textarea name="rules" rows="2" maxlength="2000" placeholder="e.g. 21+ only, Smart casuals, Outside drinks prohibited"></textarea></label>

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
