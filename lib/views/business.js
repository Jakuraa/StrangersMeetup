// lib/views/business.js - Unified Business Command Centre & Self-Service Onboarding Views.
// Consolidates Organisers, Venues, Hosts, Suppliers, and Team operations under one workspace.
import { html, raw } from './html.js';
import { layout, pageHeader } from './layout.js';
import { CITIES } from '../services/events.js';

export function renderBusinessDashboard({ user, workspace, csrf = '' } = {}) {
  const wsName = workspace?.org_name || 'Business Workspace';
  const role = workspace?.user_role || 'owner';
  const businessType = workspace?.business_type || 'organiser';

  const typeLabels = {
    organiser: 'Event Organiser',
    venue: 'Venue Operator',
    host: 'Host & Community Lead',
    supplier: 'Service Partner / Supplier'
  };
  const typeDisplay = typeLabels[businessType] || 'Business Partner';

  const body = html`
  <div class="business-dashboard-wrap" data-business-hub data-csrf="${csrf}">
    <!-- Workspace Header & Mode Switching Bar -->
    <header class="biz-header">
      <div class="wrap">
        <div class="biz-header-content">
          <div class="biz-identity">
            <div class="biz-avatar" aria-hidden="true">🏢</div>
            <div>
              <div class="biz-title-row">
                <h1 class="biz-name">${wsName}</h1>
                <span class="pill pill-mode-biz">${typeDisplay}</span>
                <span class="pill pill-role">${role}</span>
              </div>
              <p class="biz-tagline muted small">Discover. Connect. Experience. — NIGHTLIFEZ Business Operations</p>
            </div>
          </div>
          <div class="biz-quick-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-mode-switch-btn data-target-mode="attendee" title="Switch back to personal attendee pass and recommendations">
              👤 Switch to Attendee Mode
            </button>
            <a class="btn btn-outline btn-sm" href="/venue" title="Venue Management">
              🏛️ Venue Portal
            </a>
            <a class="btn btn-primary btn-sm" href="/organiser/new" title="Create a new nightlife experience or meetup">
              + Create Event
            </a>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <nav class="biz-tabs" role="tablist" aria-label="Business dashboard sections">
          <button class="biz-tab-btn active" type="button" role="tab" data-biz-tab="overview" aria-selected="true">📊 Overview</button>
          <button class="biz-tab-btn" type="button" role="tab" data-biz-tab="events" aria-selected="false">🎉 Events &amp; Experiences</button>
          <button class="biz-tab-btn" type="button" role="tab" data-biz-tab="venues" aria-selected="false">🏛️ Venues &amp; Spaces</button>
          <button class="biz-tab-btn" type="button" role="tab" data-biz-tab="team" aria-selected="false">👥 Team &amp; Hosts</button>
          <button class="biz-tab-btn" type="button" role="tab" data-biz-tab="suppliers" aria-selected="false">🤝 Partners &amp; Services</button>
          <button class="biz-tab-btn" type="button" role="tab" data-biz-tab="media" aria-selected="false">💾 Media Lifecycle</button>
          <button class="biz-tab-btn" type="button" role="tab" data-biz-tab="analytics" aria-selected="false">📈 Analytics</button>
        </nav>
      </div>
    </header>

    <main class="section section-flush">
      <div class="wrap">
        <!-- Error & Status Notification -->
        <div class="form-msg" data-biz-msg role="status" aria-live="polite"></div>

        <!-- TAB 1: OVERVIEW -->
        <section class="biz-section-panel" data-biz-panel="overview">
          <div class="biz-metrics-grid" data-overview-metrics>
            <div class="biz-metric-card">
              <span class="metric-label">Active Listings</span>
              <span class="metric-val" data-metric-active-events>—</span>
              <span class="metric-hint muted">Published nightlife &amp; social events</span>
            </div>
            <div class="biz-metric-card">
              <span class="metric-label">Confirmed Attendees</span>
              <span class="metric-val" data-metric-attendees>—</span>
              <span class="metric-hint muted">Across all upcoming events</span>
            </div>
            <div class="biz-metric-card">
              <span class="metric-label">Managed Venues</span>
              <span class="metric-val" data-metric-venues>—</span>
              <span class="metric-hint muted">Active locations in South India</span>
            </div>
            <div class="biz-metric-card">
              <span class="metric-label">Pending Enquiries</span>
              <span class="metric-val" data-metric-enquiries>—</span>
              <span class="metric-hint muted">Venue bookings requiring response</span>
            </div>
          </div>

          <div class="biz-overview-grid">
            <!-- Upcoming Events Block -->
            <div class="biz-card">
              <div class="biz-card-head">
                <h2>Upcoming Experiences</h2>
                <a href="/organiser/new" class="btn btn-outline-cyan btn-sm">+ New Event</a>
              </div>
              <div data-overview-events-list>
                <p class="muted">Loading scheduled experiences…</p>
              </div>
            </div>

            <!-- Recent Bookings Feed -->
            <div class="biz-card">
              <div class="biz-card-head">
                <h2>Recent Attendee Bookings</h2>
              </div>
              <div data-overview-bookings-list>
                <p class="muted">Loading recent attendee bookings…</p>
              </div>
            </div>
          </div>

          <!-- Media Cost & Storage Optimization Callout -->
          <div class="biz-callout-card" style="margin-top: 24px;">
            <div class="callout-icon" aria-hidden="true">💾</div>
            <div class="callout-body">
              <h3>Media Storage &amp; Asset Management</h3>
              <p class="muted small">NIGHTLIFEZ automatically identifies abandoned draft uploads and expired event media past retention periods while safeguarding verified bookings and financial audit records.</p>
              <button type="button" class="btn btn-ghost btn-sm" data-biz-tab-trigger="media">Inspect Reclaimable Media →</button>
            </div>
          </div>
        </section>

        <!-- TAB 2: EVENTS -->
        <section class="biz-section-panel" data-biz-panel="events" hidden>
          <div class="biz-card">
            <div class="biz-card-head">
              <div>
                <h2>Events &amp; Experience Management</h2>
                <p class="muted small">Create, duplicate, manage attendee capacities, or cancel events with attendee notifications.</p>
              </div>
              <a href="/organiser/new" class="btn btn-primary btn-sm">+ Create New Event</a>
            </div>
            <div class="table-responsive" data-events-table-wrap>
              <table class="biz-table" data-events-table>
                <thead>
                  <tr>
                    <th>Event Title</th>
                    <th>City / Venue</th>
                    <th>Date &amp; Time</th>
                    <th>Status</th>
                    <th>Confirmed Attendees</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody data-events-tbody>
                  <tr><td colspan="6" class="muted">Loading events…</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <!-- TAB 3: VENUES -->
        <section class="biz-section-panel" data-biz-panel="venues" hidden>
          <div class="biz-card">
            <div class="biz-card-head">
              <div>
                <h2>Managed Venues &amp; Spaces</h2>
                <p class="muted small">Spaces, lounges, and clubs linked to your business workspace.</p>
              </div>
              <button type="button" class="btn btn-outline-cyan btn-sm" data-toggle-venue-form>+ Add Venue</button>
            </div>

            <!-- New Venue Form (Collapsible) -->
            <div class="biz-form-box" data-venue-create-box hidden style="margin-bottom: 24px;">
              <h3>Add New Venue or Space</h3>
              <form data-create-venue-form>
                <div class="form-row">
                  <div class="field">
                    <label for="venue-name">Venue Name <span class="required-indicator">*</span></label>
                    <input type="text" id="venue-name" name="name" required placeholder="e.g. Indigo Lounge &amp; Rooftop" maxlength="160">
                  </div>
                  <div class="field">
                    <label for="venue-city">City <span class="required-indicator">*</span></label>
                    <select id="venue-city" name="city" required>
                      <option value="">Select city</option>
                      ${CITIES.map((c) => html`<option value="${c.name}">${c.name} (${c.state})</option>`)}
                    </select>
                  </div>
                </div>
                <div class="form-row">
                  <div class="field">
                    <label for="venue-address">Public Address</label>
                    <input type="text" id="venue-address" name="addressPublic" placeholder="e.g. 100 Feet Road, Indiranagar" maxlength="300">
                  </div>
                  <div class="field">
                    <label for="venue-capacity">Comfortable Capacity</label>
                    <input type="number" id="venue-capacity" name="capacity" min="1" max="10000" placeholder="e.g. 150">
                  </div>
                </div>
                <div class="form-row">
                  <div class="field">
                    <label for="venue-email">Contact Email</label>
                    <input type="email" id="venue-email" name="contactEmail" placeholder="venue@example.com" maxlength="160">
                  </div>
                  <div class="field">
                    <label for="venue-phone">Contact Phone</label>
                    <input type="tel" id="venue-phone" name="contactPhone" placeholder="+91 9876543210" maxlength="30">
                  </div>
                </div>
                <div class="field">
                  <label for="venue-description">Description &amp; Amenities</label>
                  <textarea id="venue-description" name="description" rows="3" placeholder="Audio setup, stage, licensing details, curfews, etc." maxlength="2000"></textarea>
                </div>
                <div class="actions-row">
                  <button type="button" class="btn btn-ghost btn-sm" data-cancel-venue-form>Cancel</button>
                  <button type="submit" class="btn btn-primary btn-sm">Save Venue</button>
                </div>
              </form>
            </div>

            <div data-venues-list>
              <p class="muted">Loading venues…</p>
            </div>
          </div>
        </section>

        <!-- TAB 4: TEAM & HOSTS -->
        <section class="biz-section-panel" data-biz-panel="team" hidden>
          <div class="biz-card">
            <div class="biz-card-head">
              <div>
                <h2>Workspace Team &amp; Hosts</h2>
                <p class="muted small">Team members with role-based access for door scans, booking management, and event hosting.</p>
              </div>
            </div>
            <div class="table-responsive">
              <table class="biz-table" data-team-table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody data-team-tbody>
                  <tr><td colspan="4" class="muted">Loading team members…</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <!-- TAB 5: SUPPLIERS & PARTNERS -->
        <section class="biz-section-panel" data-biz-panel="suppliers" hidden>
          <div class="biz-card">
            <div class="biz-card-head">
              <div>
                <h2>Service Partners &amp; Suppliers</h2>
                <p class="muted small">DJs, sound systems, photographers, bar services, and lighting contractors available for nightlife events.</p>
              </div>
              <button type="button" class="btn btn-outline-cyan btn-sm" data-toggle-supplier-form>+ Add Service Listing</button>
            </div>

            <!-- New Supplier Form (Collapsible) -->
            <div class="biz-form-box" data-supplier-create-box hidden style="margin-bottom: 24px;">
              <h3>Add Supplier / Service Listing</h3>
              <form data-create-supplier-form>
                <div class="field">
                  <label for="supplier-category">Service Category <span class="required-indicator">*</span></label>
                  <select id="supplier-category" name="category" required>
                    <option value="">Select category</option>
                    <option value="dj">DJ / Artist</option>
                    <option value="sound_audio">Sound &amp; Audio Engineering</option>
                    <option value="photography_video">Photography &amp; Aftermovie</option>
                    <option value="bar_cocktails">Mixology &amp; Bar Services</option>
                    <option value="lighting_visuals">Lighting &amp; Visual FX</option>
                    <option value="catering">Catering &amp; Food Curation</option>
                    <option value="security">Security &amp; Bouncers</option>
                  </select>
                </div>
                <div class="field">
                  <label for="supplier-portfolio">Portfolio / Instagram URLs (one per line)</label>
                  <textarea id="supplier-portfolio" name="portfolioUrls" rows="2" placeholder="https://instagram.com/djexample"></textarea>
                </div>
                <div class="field">
                  <label for="supplier-pricing">Pricing Notes</label>
                  <input type="text" id="supplier-pricing" name="pricingNotes" placeholder="e.g. ₹15,000 / 3-hour set + travel" maxlength="500">
                </div>
                <div class="actions-row">
                  <button type="button" class="btn btn-ghost btn-sm" data-cancel-supplier-form>Cancel</button>
                  <button type="submit" class="btn btn-primary btn-sm">Save Service</button>
                </div>
              </form>
            </div>

            <div data-suppliers-list>
              <p class="muted">Loading service partners…</p>
            </div>
          </div>
        </section>

        <!-- TAB 6: MEDIA & COST OPTIMIZATION -->
        <section class="biz-section-panel" data-biz-panel="media" hidden>
          <div class="biz-card">
            <div class="biz-card-head">
              <div>
                <h2>Media Lifecycle &amp; Cost Optimization</h2>
                <p class="muted small">Reclaim Postgres storage from abandoned draft assets and completed event galleries while strictly preserving verified attendee passes and audit logs.</p>
              </div>
            </div>

            <div class="media-scanner-box">
              <div class="scanner-header">
                <div>
                  <h3>Safe On-Demand Media Scan</h3>
                  <p class="muted small">Select an event to calculate reclaimable storage and inspect candidates before running cleanup.</p>
                </div>
                <div class="scanner-controls">
                  <select id="cleanup-event-select" class="clean-select" aria-label="Select event for media cleanup scan">
                    <option value="">Choose an event…</option>
                  </select>
                  <button type="button" class="btn btn-primary btn-sm" data-scan-media-btn>Calculate Reclaimable Media</button>
                </div>
              </div>

              <div class="media-preview-results" data-media-preview-results hidden style="margin-top: 20px;">
                <div class="preview-stats-row">
                  <div class="stat-pill">
                    <span class="label">Eligible Images</span>
                    <strong data-preview-count>0</strong>
                  </div>
                  <div class="stat-pill">
                    <span class="label">Reclaimable Storage</span>
                    <strong data-preview-bytes>0 KB</strong>
                  </div>
                </div>
                <div class="preview-actions" style="margin-top: 16px;">
                  <button type="button" class="btn btn-danger btn-sm" data-run-cleanup-btn>Clean Up Reclaimable Media Now</button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- TAB 7: ANALYTICS -->
        <section class="biz-section-panel" data-biz-panel="analytics" hidden>
          <div class="biz-card">
            <div class="biz-card-head">
              <div>
                <h2>Attendance &amp; Conversion Analytics</h2>
                <p class="muted small">Performance metrics across your published experiences.</p>
              </div>
            </div>
            <div class="table-responsive">
              <table class="biz-table" data-analytics-table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date</th>
                    <th>Total Bookings</th>
                    <th>Attended</th>
                    <th>Cancelled</th>
                    <th>Attendance Rate</th>
                  </tr>
                </thead>
                <tbody data-analytics-tbody>
                  <tr><td colspan="6" class="muted">Loading analytics…</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

      </div>
    </main>

    <!-- EVENT CANCELLATION MODAL -->
    <div class="modal-backdrop" data-cancel-modal hidden role="dialog" aria-modal="true" aria-labelledby="cancel-modal-title">
      <div class="modal-window">
        <h3 id="cancel-modal-title">Cancel Event &amp; Notify Attendees</h3>
        <p class="muted small">Cancelling an event updates its status, blocks new bookings, and notifies all confirmed attendees. An explicit cancellation reason is mandatory.</p>
        
        <form data-cancel-event-form>
          <input type="hidden" name="eventId" data-cancel-event-id>
          
          <div class="field">
            <label for="cancel-reason">Cancellation Reason <span class="required-indicator">*</span></label>
            <select id="cancel-reason" name="reasonCategory" required>
              <option value="">Select primary reason</option>
              <option value="Severe weather or outdoor conditions">Severe weather or outdoor conditions</option>
              <option value="Venue technical / licensing issue">Venue technical / licensing issue</option>
              <option value="Artist / host unavailable">Artist / host unavailable</option>
              <option value="Rescheduling to future date">Rescheduling to future date</option>
              <option value="Low attendee threshold not reached">Low attendee threshold not reached</option>
              <option value="other">Other reason (please describe below)</option>
            </select>
          </div>

          <div class="field">
            <label for="cancel-details">Detailed Explanation for Attendees <span class="required-indicator">*</span></label>
            <textarea id="cancel-details" name="reasonDetails" rows="3" required minlength="10" maxlength="1000" placeholder="Explain the circumstances clearly. This explanation will be included in attendee notifications."></textarea>
          </div>

          <div class="field">
            <label for="cancel-refund-notes">Refund / Credit Instructions (Optional)</label>
            <input type="text" id="cancel-refund-notes" name="refundNotes" maxlength="1000" placeholder="e.g. 100% refund initiated via UPI/gateway within 48h.">
          </div>

          <div class="actions-row">
            <button type="button" class="btn btn-ghost btn-sm" data-close-cancel-modal>Never Mind</button>
            <button type="submit" class="btn btn-danger btn-sm" data-confirm-cancel-btn>Confirm Event Cancellation</button>
          </div>
        </form>
      </div>
    </div>
  </div>`;

  return layout({
    title: 'Business Command Centre | NIGHTLIFEZ',
    description: 'Unified business command centre for event organisers, venues, hosts and nightlife suppliers.',
    path: '/business',
    body,
    noindex: true
  });
}

/**
 * Renders the 10-screen Self-Service Business Onboarding Wizard.
 */
export function renderBusinessOnboarding({ user, initialType = 'organiser' } = {}) {
  const body = html`
  <section class="section section-flush biz-onboarding-section">
    <div class="wrap narrow biz-onboarding-wrap" data-biz-onboarding data-initial-type="${initialType}">
      
      <!-- Progress Indicator -->
      <div class="biz-progress-bar" role="progressbar" aria-valuemin="1" aria-valuemax="10" aria-valuenow="1">
        <div class="biz-progress-track">
          <div class="biz-progress-fill" data-biz-progress-fill style="width: 10%;"></div>
        </div>
        <div class="biz-steps-indicator">
          <span class="biz-step-badge" data-biz-step-badge>Step 1 of 10</span>
          <span class="biz-step-label" data-biz-step-label>Business Type</span>
        </div>
      </div>

      <div class="biz-card onboarding-card">
        <!-- Error & Status Notification -->
        <div class="form-msg" data-biz-onboard-msg role="status" aria-live="polite"></div>

        <!-- SCREEN 1: Business Type Selection -->
        <div class="biz-step-panel" data-biz-step="1">
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">🏢</span>
            <h2>Select Your Business Profile</h2>
            <p class="muted">Choose how you operate within South India's premier nightlife &amp; social experiences platform.</p>
          </div>

          <div class="type-selection-grid" role="radiogroup" aria-label="Business Type">
            <label class="biz-type-card ${initialType === 'organiser' ? 'selected' : ''}">
              <input type="radio" name="bizType" value="organiser" ${initialType === 'organiser' ? 'checked' : ''}>
              <div class="card-content">
                <span class="card-icon" aria-hidden="true">🎉</span>
                <strong>Event Organiser &amp; Collective</strong>
                <p>Host parties, secret DJ sets, festivals, and curated nightlife gatherings.</p>
              </div>
            </label>

            <label class="biz-type-card ${initialType === 'venue' ? 'selected' : ''}">
              <input type="radio" name="bizType" value="venue" ${initialType === 'venue' ? 'checked' : ''}>
              <div class="card-content">
                <span class="card-icon" aria-hidden="true">🏛️</span>
                <strong>Venue Operator</strong>
                <p>Nightclubs, rooftop lounges, beach resorts, warehouses, and boutique spaces.</p>
              </div>
            </label>

            <label class="biz-type-card ${initialType === 'host' ? 'selected' : ''}">
              <input type="radio" name="bizType" value="host" ${initialType === 'host' ? 'checked' : ''}>
              <div class="card-content">
                <span class="card-icon" aria-hidden="true">🍷</span>
                <strong>Host &amp; Community Curator</strong>
                <p>Curated supper clubs, cocktail mixers, game nights, and social meetups.</p>
              </div>
            </label>

            <label class="biz-type-card ${initialType === 'supplier' ? 'selected' : ''}">
              <input type="radio" name="bizType" value="supplier" ${initialType === 'supplier' ? 'checked' : ''}>
              <div class="card-content">
                <span class="card-icon" aria-hidden="true">🎧</span>
                <strong>Service Partner &amp; Supplier</strong>
                <p>DJs, sound &amp; lighting technicians, mixologists, photographers, security.</p>
              </div>
            </label>
          </div>

          <div class="actions-row" style="margin-top: 24px;">
            <button type="button" class="btn btn-primary btn-block btn-lg" data-biz-next="2">Continue →</button>
          </div>
        </div>

        <!-- SCREEN 2: Entity & Brand Details -->
        <div class="biz-step-panel" data-biz-step="2" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">📝</span>
            <h2>Business &amp; Brand Identity</h2>
            <p class="muted">Tell us about your brand or business entity.</p>
          </div>
          <form data-biz-form="2">
            <div class="field">
              <label for="biz-brand-name">Business / Brand Name <span class="required-indicator">*</span></label>
              <input type="text" id="biz-brand-name" name="name" required minlength="2" maxlength="120" placeholder="e.g. Neon Horizon Events">
            </div>
            <div class="field">
              <label for="biz-contact-email">Business Contact Email</label>
              <input type="email" id="biz-contact-email" name="contactEmail" placeholder="team@brand.com" maxlength="160">
            </div>
            <div class="field">
              <label for="biz-contact-phone">WhatsApp Business Contact</label>
              <input type="tel" id="biz-contact-phone" name="contactPhone" placeholder="+91 9876543210" maxlength="30">
            </div>
            <div class="field">
              <label for="biz-website">Website or Instagram Profile (Optional)</label>
              <input type="url" id="biz-website" name="website" placeholder="https://instagram.com/yourbrand">
            </div>
            <div class="field">
              <label for="biz-gstin">GSTIN / Registration Number (Optional)</label>
              <input type="text" id="biz-gstin" name="gstin" placeholder="29ABCDE1234F1Z5" maxlength="25">
            </div>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="1">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Next: Operating Hubs →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 3: Operating Locations -->
        <div class="biz-step-panel" data-biz-step="3" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">📍</span>
            <h2>Operating Hubs &amp; Markets</h2>
            <p class="muted">Where do you host events or offer services?</p>
          </div>
          <form data-biz-form="3">
            <div class="field">
              <label for="biz-primary-city">Primary City / Hub <span class="required-indicator">*</span></label>
              <select id="biz-primary-city" name="primaryCity" required>
                <option value="">Select primary hub</option>
                <optgroup label="South India">
                  ${CITIES.filter((c) => c.region === 'South').map((c) => html`<option value="${c.name}">${c.name} (${c.state})</option>`)}
                </optgroup>
                <optgroup label="West India">
                  ${CITIES.filter((c) => c.region === 'West').map((c) => html`<option value="${c.name}">${c.name} (${c.state})</option>`)}
                </optgroup>
                <optgroup label="North India">
                  ${CITIES.filter((c) => c.region === 'North').map((c) => html`<option value="${c.name}">${c.name} (${c.state})</option>`)}
                </optgroup>
              </select>
            </div>
            <div class="field">
              <label>Secondary Operating Hubs</label>
              <div class="city-chips-wrap">
                ${['Bangalore', 'Chennai', 'Hyderabad', 'Kochi', 'Goa', 'Coimbatore'].map((hub) => html`
                  <label class="lang-chip">
                    <input type="checkbox" name="secondaryHubs" value="${hub}">
                    <span>${hub}</span>
                  </label>
                `)}
              </div>
            </div>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="2">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Next: Brand Assets →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 4: Brand Assets & Bio -->
        <div class="biz-step-panel" data-biz-step="4" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">✨</span>
            <h2>Brand Profile &amp; Bio</h2>
            <p class="muted">How your brand appears to nightlife enthusiasts.</p>
          </div>
          <form data-biz-form="4">
            <div class="field">
              <label for="biz-tagline">Tagline</label>
              <input type="text" id="biz-tagline" name="tagline" placeholder="e.g. Elevating Bangalore's Underground Dance Scene" maxlength="160">
            </div>
            <div class="field">
              <label for="biz-bio">Brand Bio</label>
              <textarea id="biz-bio" name="bio" rows="3" placeholder="Tell the community what makes your experiences special..." maxlength="1000"></textarea>
            </div>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="3">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Next: Space Profile →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 5: Venue & Space Profile -->
        <div class="biz-step-panel" data-biz-step="5" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">🏛️</span>
            <h2>Venue &amp; Space Profile</h2>
            <p class="muted">Applicable for venue owners, or optional for mobile organisers.</p>
          </div>
          <form data-biz-form="5">
            <div class="field">
              <label for="biz-space-type">Venue Type</label>
              <select id="biz-space-type" name="spaceType">
                <option value="none">Not applicable (Mobile / Pop-up)</option>
                <option value="nightclub">Nightclub / Bar</option>
                <option value="rooftop">Rooftop Lounge</option>
                <option value="resort">Resort / Villa</option>
                <option value="warehouse">Warehouse / Industrial</option>
                <option value="studio">Boutique Art Studio</option>
              </select>
            </div>
            <div class="field">
              <label for="biz-space-cap">Typical Capacity</label>
              <input type="number" id="biz-space-cap" name="capacity" placeholder="e.g. 200" min="10" max="10000">
            </div>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="4">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Next: Services &amp; Capabilities →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 6: Services & Equipment -->
        <div class="biz-step-panel" data-biz-step="6" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">🎧</span>
            <h2>Services &amp; Capabilities</h2>
            <p class="muted">Highlight equipment and technical services you provide.</p>
          </div>
          <form data-biz-form="6">
            <div class="field">
              <label>Specialist Capabilities</label>
              <div class="city-chips-wrap">
                ${['Professional Sound System', 'Intelligent Lighting FX', 'Live DJ Sets', 'Craft Cocktail Bar', 'Event Photography', 'Bouncer / Door Security', 'Ticketing & RSVP'].map((serv) => html`
                  <label class="lang-chip">
                    <input type="checkbox" name="services" value="${serv}">
                    <span>${serv}</span>
                  </label>
                `)}
              </div>
            </div>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="5">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Next: Host Profile →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 7: Host / Community Profile -->
        <div class="biz-step-panel" data-biz-step="7" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">👥</span>
            <h2>Host &amp; Community Format</h2>
            <p class="muted">What format do your gatherings follow?</p>
          </div>
          <form data-biz-form="7">
            <div class="field">
              <label for="biz-curation-vibe">Community Vibe</label>
              <input type="text" id="biz-curation-vibe" name="vibe" placeholder="e.g. Underground Techno, Intimate Supper Clubs, Sunset Chill" maxlength="120">
            </div>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="6">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Next: Team Setup →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 8: Team & Role Setup -->
        <div class="biz-step-panel" data-biz-step="8" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">🤝</span>
            <h2>Team &amp; Door Staff Setup</h2>
            <p class="muted">You can invite managers and door staff anytime from your dashboard.</p>
          </div>
          <form data-biz-form="8">
            <p class="muted small">As the account creator, you are assigned as the <strong>Workspace Owner</strong> with full access to event publishing, finances, and team delegation.</p>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="7">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Next: Trust &amp; Safety →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 9: Verification & Trust Tier -->
        <div class="biz-step-panel" data-biz-step="9" hidden>
          <div class="step-hero">
            <span class="step-icon" aria-hidden="true">🔒</span>
            <h2>21+ Trust &amp; Safety Compliance</h2>
            <p class="muted">All business partners uphold our community charter.</p>
          </div>
          <form data-biz-form="9">
            <div class="onboarding-legal-card">
              <p><strong>NIGHTLIFEZ Partner Charter:</strong></p>
              <ul class="small muted" style="padding-left: 20px; margin: 8px 0;">
                <li>Strictly enforce 21+ age policy and physical ID checks at licensed venue doors.</li>
                <li>Zero tolerance for harassment, substance tampering, or unsafe environments.</li>
                <li>Prompt communication of event schedule changes or cancellations to attendees.</li>
              </ul>
            </div>
            <label class="check consent-check-row">
              <input type="checkbox" id="biz-safety-agreement" name="safetyAgreed" required>
              <span><strong>I agree to the NIGHTLIFEZ Partner Code of Conduct</strong> and declare that our operations comply with local regulations and 21+ safety guidelines.</span>
            </label>
            <div class="actions-row">
              <button type="button" class="btn btn-ghost btn-sm" data-biz-prev="8">← Back</button>
              <button type="submit" class="btn btn-primary btn-lg">Activate Workspace →</button>
            </div>
          </form>
        </div>

        <!-- SCREEN 10: Launch & Activation -->
        <div class="biz-step-panel" data-biz-step="10" hidden>
          <div class="step-hero">
            <div class="completion-badge-icon" aria-hidden="true">🚀</div>
            <h2>Workspace Activated!</h2>
            <p class="muted">Your business account is ready. Welcome to NIGHTLIFEZ.</p>
          </div>
          <div class="biz-summary-card">
            <h3>Ready to Host South India's Best Nights?</h3>
            <p class="muted small">Manage upcoming events, scan tickets at the door, and track attendance all from your unified command centre.</p>
          </div>
          <div class="actions-row" style="flex-direction: column; gap: 12px; margin-top: 24px;">
            <a href="/organiser/new" class="btn btn-primary btn-lg btn-block">+ Create Your First Event</a>
            <a href="/business" class="btn btn-ghost btn-block">Go to Business Command Centre →</a>
          </div>
        </div>

      </div>
    </div>
  </section>`;

  return layout({
    title: 'Business Onboarding | NIGHTLIFEZ',
    description: 'Self-service business onboarding for organisers, venues, hosts and suppliers.',
    path: '/business/new',
    body,
    noindex: true
  });
}
