// public/js/app.js - StrangersMeetup Client Controller

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

  // DOM Elements
  const ageGateDialog = document.getElementById('age-gate-dialog');
  const ageGateForm = document.getElementById('age-gate-form');
  const ageGateError = document.getElementById('age-gate-error');
  const checkoutDialog = document.getElementById('checkout-dialog');
  const checkoutDetails = document.getElementById('checkout-details');
  const checkoutBtn = document.getElementById('checkout-proceed-btn');
  const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
  const mobileNav = document.getElementById('mobile-nav-drawer');

  // 1. Analytics Helper
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
      // Fire & forget
    }
  }

  // 2. Age Gate Verification
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
        showAgeError('You must explicitly declare and affirm that you are at least 21 years of age.');
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
        showAgeError('StrangersMeetup is currently launching exclusively in Tamil Nadu, Puducherry, Karnataka, and Kerala.');
        return;
      }

      // Verified
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

  // 3. Checkout Initiation Flow
  window.initiateCheckout = async function (tierId) {
    trackEvent('tier_selection', { tierId });

    if (!checkoutDialog) return;

    checkoutDetails.innerHTML = '<p style="text-align:center; padding: 2rem;">Generating official Telegram Stars recurring checkout link...</p>';
    checkoutBtn.style.display = 'none';
    checkoutDialog.showModal();

    try {
      trackEvent('checkout_initiation', { tierId });
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierId })
      });

      const data = await res.json();
      if (!data.ok) {
        checkoutDetails.innerHTML = `
          <div style="color: #fb7185; padding: 1rem; background: rgba(244,63,94,0.1); border-radius: 8px;">
            <strong>Checkout Error:</strong> ${data.error || 'Failed to initialize checkout link.'}
          </div>
        `;
        return;
      }

      checkoutDetails.innerHTML = `
        <div style="text-align: left; margin-bottom: 1.5rem;">
          <h4 style="font-size: 1.25rem; font-weight: 800; margin-bottom: 0.4rem; color: #00f0d4;">
            ${data.tier.name} Membership
          </h4>
          <p style="color: #9aa8b2; font-size: 0.9rem; margin-bottom: 1rem;">
            Target positioning: ₹${data.tier.inrTarget}/month (billed in Telegram Stars).
          </p>
          <div style="background: #07090b; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 1rem; margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.88rem;">
              <span style="color: #9aa8b2;">Billed Amount:</span>
              <strong style="color: #00f0d4;">${data.tier.starsPrice} Telegram Stars (XTR)</strong>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem; font-size: 0.88rem;">
              <span style="color: #9aa8b2;">Billing Cycle:</span>
              <span>Every 30 Days (Recurring)</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 0.88rem;">
              <span style="color: #9aa8b2;">Delivery:</span>
              <span>Direct Telegram Channel Invite</span>
            </div>
          </div>
          <p style="font-size: 0.82rem; color: #64748b; line-height: 1.5;">
            • You will be redirected to Telegram's secure in-app Stars checkout.<br>
            • You can cancel auto-renewal at any time in Telegram (Settings > Subscriptions).<br>
            • Upon verified payment, your unique private channel invite link is unlocked automatically.
          </p>
        </div>
      `;

      checkoutBtn.href = data.invoiceLink;
      checkoutBtn.style.display = 'inline-flex';
    } catch (err) {
      checkoutDetails.innerHTML = `
        <div style="color: #fb7185; padding: 1rem;">
          <strong>Network Error:</strong> Could not reach checkout server. Please try again.
        </div>
      `;
    }
  };

  // Close Dialogs when clicking outside
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

  // Mobile Menu Toggle
  if (mobileMenuToggle && mobileNav) {
    mobileMenuToggle.addEventListener('click', function () {
      const expanded = mobileMenuToggle.getAttribute('aria-expanded') === 'true';
      mobileMenuToggle.setAttribute('aria-expanded', !expanded);
      mobileNav.style.display = expanded ? 'none' : 'block';
    });
  }

  // 4. Initial Trigger
  window.addEventListener('DOMContentLoaded', function () {
    checkAgeGateStatus();
    trackEvent('landing_page_view');
  });

})();
