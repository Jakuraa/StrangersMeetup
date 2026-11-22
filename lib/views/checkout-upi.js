// lib/views/checkout-upi.js - Responsive UPI-first checkout view.
// Adapts between Mobile (direct intent launch & app chooser) and Desktop (dynamic QR & live polling).

import { html, raw } from './html.js';
import { layout } from './layout.js';

export function renderUpiCheckout({
  order,
  event,
  tier,
  user,
  csrfToken = ''
}) {
  const amountRupees = (order.amountPaise / 100).toFixed(2);
  const baseRupees = order.baseAmountPaise !== undefined
    ? (order.baseAmountPaise / 100).toFixed(2)
    : (tier.price_paise ? ((tier.price_paise * (order.quantity || 1)) / 100).toFixed(2) : amountRupees);
  const feeRupees = order.feePaise !== undefined
    ? (order.feePaise / 100).toFixed(2)
    : Math.max(0, Number(amountRupees) - Number(baseRupees)).toFixed(2);
  const feePct = order.feePercentage || 5;
  const organiserDestination = order.organiserUpiId || event.organiser_upi_id || 'Organiser Verified UPI';
  const upiUri = order.upiIntentUrl;
  const qrSvg = order.qrSvg;
  const expiresAt = order.expiresAt;
  const unitPrice = tier.price_paise ? (tier.price_paise / 100).toFixed(2) : amountRupees;
  const admitCount = Number.isInteger(tier.admit_count) && tier.admit_count > 0 ? tier.admit_count : (tier.category === 'couple' ? 2 : tier.category === 'group' ? 4 : 1);
  const totalAdmit = (order.quantity || 1) * admitCount;

  const body = html`
  <section class="checkout-wrap" data-order-id="${order.orderId}" data-expires-at="${expiresAt}">
    <div class="wrap checkout-grid">
      <!-- Order Summary Card -->
      <aside class="checkout-summary card">
        <div class="summary-head">
          <div class="badge-row">
            ${order.isTest ? html`<span class="badge badge-test">Sandbox Test Mode</span>` : html`<span class="badge badge-brand">UPI Checkout</span>`}
            ${tier.category ? html`<span class="badge badge-category">${tier.category.toUpperCase()} PASS</span>` : ''}
          </div>
          <h2>${event.title}</h2>
          <p class="summary-loc">${event.city} · ${tier.name} × ${order.quantity}</p>
          ${totalAdmit > 1 ? html`<p class="summary-admit">👥 Admits ${totalAdmit} guests total (${admitCount} per pass)</p>` : ''}
        </div>

        <div class="summary-breakdown">
          <div class="breakdown-row">
            <span class="breakdown-label">Organiser ticket price (${tier.name} × ${order.quantity})</span>
            <span class="breakdown-val">₹${baseRupees}</span>
          </div>
          <div class="breakdown-row fee-row">
            <span class="breakdown-label">NIGHTLIFEZ infrastructure fee (${feePct}%)</span>
            <span class="breakdown-val">₹${feeRupees}</span>
          </div>
        </div>

        <div class="summary-price">
          <span class="price-label">Total Payable</span>
          <span class="price-val">₹${amountRupees}</span>
        </div>
        <div class="summary-meta">
          <p class="order-ref">Order Reference: <code>${order.orderId}</code></p>
          <div class="payment-dest-notice">
            <p class="dest-target"><strong>Payment Destination:</strong> <code>${organiserDestination}</code></p>
            <p class="dest-expl muted small">The 5% infrastructure fee is payable by the organiser to NIGHTLIFEZ and is not collected or held by NIGHTLIFEZ. The full attendee payment of ₹${amountRupees} is transferred directly to the organiser.</p>
          </div>
          <p class="guarantee"><span class="icon">🔒</span> Direct UPI payment. Booking pass issued upon server confirmation.</p>
        </div>
      </aside>

      <!-- Interactive Checkout Panel -->
      <main class="checkout-main card" id="checkout-panel">
        ${order.isTest ? html`
        <div class="sandbox-banner" role="note">
          <p>🧪 <strong>Test Environment:</strong> Order <code>${order.orderId}</code> is running in sandbox test mode. No real money will be charged. Automated confirmation simulates provider webhook processing.</p>
        </div>` : ''}

        <!-- Live Countdown Timer -->
        <div class="checkout-timer" id="timer-box" role="timer" aria-live="polite">
          <span class="timer-label">Seat reservation holds for:</span>
          <span class="timer-digits" id="timer-digits">15:00</span>
        </div>

        <!-- Mobile: UPI Intent & Quick App Chooser -->
        <div class="checkout-mobile" id="mobile-checkout">
          <h3 class="panel-title">Pay with UPI on this device</h3>
          <p class="panel-sub">Tap below to open your preferred UPI application and approve payment.</p>

          <a class="btn btn-primary btn-lg btn-block upi-primary-btn" id="upi-intent-link" href="${upiUri}">
            <span class="btn-icon">⚡</span> Pay with Any UPI App
          </a>

          <div class="app-chooser-divider">
            <span>or choose your preferred app</span>
          </div>

          <div class="upi-app-grid">
            <a class="upi-app-chip" href="${order.appIntents.gpay}">
              <span class="app-icon gpay">G</span>
              <span class="app-name">Google Pay</span>
            </a>
            <a class="upi-app-chip" href="${order.appIntents.phonepe}">
              <span class="app-icon phonepe">Pe</span>
              <span class="app-name">PhonePe</span>
            </a>
            <a class="upi-app-chip" href="${order.appIntents.paytm}">
              <span class="app-icon paytm">Pt</span>
              <span class="app-name">Paytm</span>
            </a>
            <a class="upi-app-chip" href="${order.appIntents.cred}">
              <span class="app-icon cred">C</span>
              <span class="app-name">CRED</span>
            </a>
            <a class="upi-app-chip" href="${order.appIntents.bhim}">
              <span class="app-icon bhim">B</span>
              <span class="app-name">BHIM UPI</span>
            </a>
          </div>

          <p class="mobile-note muted small">
            Returning from the UPI app? We automatically verify payment confirmation with the banking network.
          </p>
        </div>

        <!-- Desktop: Dynamic Scannable QR -->
        <div class="checkout-desktop" id="desktop-checkout">
          <h3 class="panel-title">Scan QR code to pay</h3>
          <p class="panel-sub">Open any UPI app on your mobile phone and scan this dynamic code.</p>

          <div class="qr-container" id="qr-box">
            ${raw(qrSvg)}
          </div>

          <div class="supported-apps-row">
            <span class="app-badge">Google Pay</span>
            <span class="app-badge">PhonePe</span>
            <span class="app-badge">Paytm</span>
            <span class="app-badge">CRED</span>
            <span class="app-badge">BHIM</span>
            <span class="app-badge">Any Bank UPI</span>
          </div>
        </div>

        <!-- Polling & Verification Status Banner -->
        <div class="polling-status" id="polling-status">
          <div class="spinner" aria-hidden="true"></div>
          <p class="status-text" id="status-text">Awaiting payment authorization from bank...</p>
          <button class="btn btn-ghost btn-sm" id="btn-manual-poll" type="button">Refresh Status</button>
        </div>

        <!-- State Screens (Hidden initially) -->
        <div class="status-screen success-screen" id="success-screen" hidden>
          <div class="success-icon">✓</div>
          <h3>Booking Confirmed</h3>
          <p>Your booking has been confirmed and digital ticket pass issued.</p>
          <a class="btn btn-primary btn-lg" id="view-booking-btn" href="/me/bookings">View My Ticket Pass →</a>
        </div>

        <div class="status-screen expired-screen" id="expired-screen" hidden>
          <div class="warn-icon">⏳</div>
          <h3>Payment Session Expired</h3>
          <p>This dynamic QR and seat hold have expired to release inventory.</p>
          <a class="btn btn-primary" href="/events/${event.slug}">Start New Checkout</a>
        </div>

        <div class="status-screen failed-screen" id="failed-screen" hidden>
          <div class="error-icon">✕</div>
          <h3>Payment Was Not Completed</h3>
          <p id="failed-msg">The transaction could not be verified or was declined.</p>
          <a class="btn btn-primary" href="/events/${event.slug}">Try Again</a>
        </div>
      </main>
    </div>
  </section>

  <style>
    .checkout-wrap { padding: 2.5rem 1rem 4rem; background: var(--surface-base, #0E1224); min-height: 80vh; }
    .checkout-grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 2rem; max-width: 960px; margin: 0 auto; }
    @media (max-width: 768px) {
      .checkout-grid { grid-template-columns: 1fr; }
      .checkout-desktop { display: none !important; }
    }
    @media (min-width: 769px) {
      .checkout-mobile { display: none !important; }
    }
    .checkout-summary, .checkout-main { background: var(--surface-card, #171B34); border: 1px solid var(--border-strong, #6670B0); border-radius: 16px; padding: 1.75rem; color: var(--fg-primary, #FFFFFF); box-shadow: 0 8px 32px rgba(0,0,0,0.35); }
    .badge-row { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
    .badge-category { background: rgba(6, 214, 160, 0.15); color: #06D6A0; border: 1px solid rgba(6, 214, 160, 0.35); font-size: 0.75rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 6px; letter-spacing: 0.05em; }
    .summary-head h2 { font-size: 1.45rem; margin: 0.25rem 0 0.4rem; color: var(--fg-primary, #FFFFFF); }
    .summary-loc { color: var(--fg-secondary, #F1F3FA); margin-bottom: 0.35rem; }
    .summary-admit { color: #06D6A0; font-size: 0.9rem; font-weight: 600; margin-bottom: 0.75rem; }
    .summary-breakdown { padding: 1rem 0; border-top: 1px solid var(--border-strong, #6670B0); border-bottom: 1px solid var(--border-strong, #6670B0); display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.92rem; }
    .breakdown-row { display: flex; justify-content: space-between; align-items: center; color: var(--fg-secondary, #F1F3FA); }
    .free-fee { color: #06D6A0; font-weight: 600; }
    .summary-price { display: flex; justify-content: space-between; align-items: baseline; margin: 1.25rem 0; }
    .price-label { font-size: 1rem; color: var(--fg-secondary, #F1F3FA); font-weight: 600; }
    .price-val { font-size: 1.85rem; font-weight: 800; color: #FFD166; letter-spacing: -0.02em; }
    .summary-meta { font-size: 0.85rem; color: var(--fg-muted, #A3ABC9); }
    .summary-meta code { background: var(--surface-input, #0B0E1E); border: 1px solid var(--border-strong, #6670B0); padding: 0.2rem 0.4rem; border-radius: 4px; color: var(--fg-primary, #FFFFFF); }
    .checkout-timer { display: flex; justify-content: space-between; align-items: center; background: rgba(255, 209, 102, 0.1); border: 1px solid rgba(255, 209, 102, 0.35); padding: 0.75rem 1rem; border-radius: 10px; margin-bottom: 1.5rem; }
    .timer-digits { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.25rem; font-weight: 800; color: #FFD166; }
    .panel-title { color: var(--fg-primary, #FFFFFF); font-size: 1.25rem; margin-bottom: 0.35rem; }
    .panel-sub { color: var(--fg-muted, #A3ABC9); font-size: 0.9rem; margin-bottom: 1.25rem; }
    .upi-primary-btn { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin: 1rem 0; font-weight: 700; background: #06D6A0; color: #0E1224; border: none; border-radius: 12px; padding: 0.9rem 1.5rem; text-decoration: none; font-size: 1.05rem; }
    .upi-primary-btn:hover { background: #05b88a; }
    .app-chooser-divider { text-align: center; margin: 1.25rem 0 0.85rem; font-size: 0.8rem; color: var(--fg-muted, #A3ABC9); text-transform: uppercase; letter-spacing: 0.05em; }
    .upi-app-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.6rem; margin-bottom: 1rem; }
    .upi-app-chip { display: flex; align-items: center; gap: 0.5rem; padding: 0.65rem 0.85rem; background: var(--surface-input, #0B0E1E); border: 1px solid var(--border-strong, #6670B0); border-radius: 10px; color: var(--fg-primary, #FFFFFF); text-decoration: none; font-size: 0.88rem; font-weight: 600; transition: border-color 0.2s, background 0.2s; }
    .upi-app-chip:hover { border-color: #06D6A0; background: var(--surface-elevated, #222749); }
    .app-icon { width: 24px; height: 24px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 800; background: #333; }
    .app-icon.gpay { background: #4285f4; color: #fff; }
    .app-icon.phonepe { background: #5f259f; color: #fff; }
    .app-icon.paytm { background: #00b9f5; color: #fff; }
    .app-icon.cred { background: #1a1a1a; color: #fff; border: 1px solid #444; }
    .app-icon.bhim { background: #0078d4; color: #fff; }
    .qr-container { display: flex; justify-content: center; margin: 1.5rem 0; }
    .qr-container svg { max-width: 260px; height: auto; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); background: #ffffff; padding: 12px; }
    .supported-apps-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; margin-top: 1rem; }
    .app-badge { font-size: 0.75rem; padding: 0.25rem 0.6rem; border-radius: 6px; background: rgba(255,255,255,0.08); color: var(--fg-secondary, #F1F3FA); border: 1px solid var(--border-strong, #6670B0); }
    .polling-status { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border-strong, #6670B0); font-size: 0.9rem; color: var(--fg-muted, #A3ABC9); }
    .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #06D6A0; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-screen { text-align: center; padding: 2.5rem 1rem; }
    .success-icon { width: 68px; height: 68px; border-radius: 50%; background: #06D6A0; color: #0E1224; font-size: 2.2rem; font-weight: 900; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1.25rem; }
    .warn-icon { font-size: 3rem; margin-bottom: 1rem; }
    .badge-test { background: rgba(251, 191, 36, 0.18); color: #FBBF24; border: 1px solid rgba(251, 191, 36, 0.4); }
    .sandbox-banner { background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.35); color: #FDE68A; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.25rem; font-size: 0.88rem; line-height: 1.4; }
    .sandbox-banner code { color: #FFF; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; }
    .error-icon { width: 68px; height: 68px; border-radius: 50%; background: #EF476F; color: #fff; font-size: 2.2rem; font-weight: 900; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1.25rem; }
  </style>

  <script>
    (function() {
      var wrap = document.querySelector('.checkout-wrap');
      if (!wrap) return;
      var orderId = wrap.getAttribute('data-order-id');
      var expiresAt = new Date(wrap.getAttribute('data-expires-at')).getTime();
      var timerDigits = document.getElementById('timer-digits');
      var statusText = document.getElementById('status-text');
      var manualPollBtn = document.getElementById('btn-manual-poll');
      var panel = document.getElementById('checkout-panel');
      var successScreen = document.getElementById('success-screen');
      var expiredScreen = document.getElementById('expired-screen');
      var failedScreen = document.getElementById('failed-screen');
      var pollingStatus = document.getElementById('polling-status');
      var viewBookingBtn = document.getElementById('view-booking-btn');

      // Countdown timer
      var timerInterval = setInterval(function() {
        var now = Date.now();
        var leftMs = expiresAt - now;
        if (leftMs <= 0) {
          clearInterval(timerInterval);
          timerDigits.textContent = '00:00';
          showExpired();
          return;
        }
        var totalSec = Math.floor(leftMs / 1000);
        var mins = Math.floor(totalSec / 60);
        var secs = totalSec % 60;
        timerDigits.textContent = (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
      }, 1000);

      function showSuccess(bookingId) {
        clearInterval(timerInterval);
        document.getElementById('mobile-checkout').hidden = true;
        document.getElementById('desktop-checkout').hidden = true;
        document.getElementById('timer-box').hidden = true;
        pollingStatus.hidden = true;
        if (bookingId) viewBookingBtn.href = '/bookings/' + bookingId;
        successScreen.hidden = false;
      }

      function showExpired() {
        document.getElementById('mobile-checkout').hidden = true;
        document.getElementById('desktop-checkout').hidden = true;
        pollingStatus.hidden = true;
        expiredScreen.hidden = false;
      }

      function showFailed(reason) {
        document.getElementById('mobile-checkout').hidden = true;
        document.getElementById('desktop-checkout').hidden = true;
        pollingStatus.hidden = true;
        if (reason) document.getElementById('failed-msg').textContent = reason;
        failedScreen.hidden = false;
      }

      function checkStatus() {
        fetch('/api/checkout/upi/status/' + encodeURIComponent(orderId))
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (!data || !data.ok) return;
            if (data.status === 'succeeded') {
              showSuccess(data.bookingId);
            } else if (data.status === 'expired') {
              showExpired();
            } else if (data.status === 'failed' || data.status === 'cancelled') {
              showFailed(data.message);
            }
          })
          .catch(function() {});
      }

      // Auto-poll every 3.5 seconds
      var pollInterval = setInterval(function() {
        checkStatus();
      }, 3500);

      if (manualPollBtn) {
        manualPollBtn.addEventListener('click', function() {
          statusText.textContent = 'Checking with gateway...';
          checkStatus();
          setTimeout(function() { statusText.textContent = 'Awaiting payment authorization...'; }, 1500);
        });
      }
    })();
  </script>
  `;

  return layout({
    title: `Checkout — ${event.title}`,
    description: `Pay securely with UPI for ${event.title}`,
    path: `/checkout/${event.slug}`,
    body,
    noindex: true
  });
}
