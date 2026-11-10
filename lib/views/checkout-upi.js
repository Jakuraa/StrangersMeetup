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
  const upiUri = order.upiIntentUrl;
  const qrSvg = order.qrSvg;
  const expiresAt = order.expiresAt;

  const body = html`
  <section class="checkout-wrap" data-order-id="${order.orderId}" data-expires-at="${expiresAt}">
    <div class="wrap checkout-grid">
      <!-- Order Summary Card -->
      <aside class="checkout-summary card">
        <div class="summary-head">
          <span class="badge badge-brand">Secure UPI Checkout</span>
          <h2>${event.title}</h2>
          <p class="muted">${event.city} · ${tier.name} × ${order.quantity}</p>
        </div>
        <div class="summary-price">
          <span class="price-label">Total to Pay</span>
          <span class="price-val">₹${amountRupees}</span>
        </div>
        <div class="summary-meta">
          <p class="order-ref">Order Reference: <code>${order.orderId}</code></p>
          <p class="guarantee"><span class="icon">🔒</span> Direct NPCI UPI verified payment. No card details required.</p>
        </div>
      </aside>

      <!-- Interactive Checkout Panel -->
      <main class="checkout-main card" id="checkout-panel">
        <!-- Live Countdown Timer -->
        <div class="checkout-timer" id="timer-box" role="timer" aria-live="polite">
          <span class="timer-label">Payment session expires in:</span>
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
            <span>or open directly in</span>
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
          <p class="status-text" id="status-text">Awaiting payment authorization...</p>
          <button class="btn btn-ghost btn-sm" id="btn-manual-poll" type="button">Refresh Status</button>
        </div>

        <!-- State Screens (Hidden initially) -->
        <div class="status-screen success-screen" id="success-screen" hidden>
          <div class="success-icon">✓</div>
          <h3>Payment Verified! Booking Confirmed</h3>
          <p>Your ticket has been secured. Your mystery venue address and private group invite are ready.</p>
          <a class="btn btn-primary btn-lg" id="view-booking-btn" href="/me/bookings">View My Ticket Pass →</a>
        </div>

        <div class="status-screen expired-screen" id="expired-screen" hidden>
          <div class="warn-icon">⏳</div>
          <h3>Payment Session Expired</h3>
          <p>This dynamic QR and payment intent have expired to protect your transaction.</p>
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
    .checkout-wrap { padding: 2.5rem 1rem 4rem; }
    .checkout-grid { display: grid; grid-template-columns: 1fr 1.2fr; gap: 2rem; max-width: 960px; margin: 0 auto; }
    @media (max-width: 768px) {
      .checkout-grid { grid-template-columns: 1fr; }
      .checkout-desktop { display: none !important; }
    }
    @media (min-width: 769px) {
      .checkout-mobile { display: none !important; }
    }
    .checkout-summary, .checkout-main { background: var(--bg-card, #121316); border: 1px solid var(--border, #2a2d35); border-radius: 16px; padding: 1.75rem; }
    .summary-head h2 { font-size: 1.35rem; margin: 0.5rem 0 0.25rem; }
    .summary-price { display: flex; justify-content: space-between; align-items: baseline; margin: 1.5rem 0; padding: 1rem 0; border-top: 1px solid var(--border, #2a2d35); border-bottom: 1px solid var(--border, #2a2d35); }
    .price-label { font-size: 0.95rem; color: var(--muted, #8b92a5); }
    .price-val { font-size: 1.75rem; font-weight: 700; color: #f5c518; }
    .summary-meta { font-size: 0.85rem; color: var(--muted, #8b92a5); }
    .checkout-timer { display: flex; justify-content: space-between; align-items: center; background: rgba(245, 197, 24, 0.08); border: 1px solid rgba(245, 197, 24, 0.2); padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .timer-digits { font-family: monospace; font-size: 1.15rem; font-weight: 700; color: #f5c518; }
    .upi-primary-btn { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin: 1rem 0; }
    .app-chooser-divider { text-align: center; margin: 1.25rem 0 0.75rem; font-size: 0.8rem; color: var(--muted, #8b92a5); text-transform: uppercase; letter-spacing: 0.05em; }
    .upi-app-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 0.6rem; margin-bottom: 1rem; }
    .upi-app-chip { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.75rem; background: var(--bg-card-sub, #1a1d24); border: 1px solid var(--border, #2a2d35); border-radius: 8px; color: #fff; text-decoration: none; font-size: 0.85rem; font-weight: 500; transition: border-color 0.2s; }
    .upi-app-chip:hover { border-color: #f5c518; }
    .app-icon { width: 22px; height: 22px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; background: #333; }
    .app-icon.gpay { background: #4285f4; color: #fff; }
    .app-icon.phonepe { background: #5f259f; color: #fff; }
    .app-icon.paytm { background: #00b9f5; color: #fff; }
    .app-icon.cred { background: #1a1a1a; color: #fff; border: 1px solid #444; }
    .app-icon.bhim { background: #0078d4; color: #fff; }
    .qr-container { display: flex; justify-content: center; margin: 1.5rem 0; }
    .qr-container svg { max-width: 280px; height: auto; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
    .supported-apps-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; margin-top: 1rem; }
    .app-badge { font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--muted, #8b92a5); }
    .polling-status { display: flex; align-items: center; justify-content: center; gap: 0.75rem; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border, #2a2d35); font-size: 0.9rem; color: var(--muted, #8b92a5); }
    .spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #f5c518; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-screen { text-align: center; padding: 2rem 1rem; }
    .success-icon { width: 64px; height: 64px; border-radius: 50%; background: #22c55e; color: #fff; font-size: 2rem; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1rem; }
    .warn-icon { font-size: 3rem; margin-bottom: 1rem; }
    .error-icon { width: 64px; height: 64px; border-radius: 50%; background: #ef4444; color: #fff; font-size: 2rem; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 1rem; }
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
