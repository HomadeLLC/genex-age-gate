<script>
/**
 * Homade Age Gate v1
 * - Webflow-friendly: uses data-ag attributes
 * - State-aware rules (config)
 * - Optional server verification + audit trail
 *
 * NOTE:
 * - If you do NOT implement the server endpoint, this still gates the UI,
 *   but it is NOT a regulator-grade audit trail (client storage can be cleared/forged).
 */
(function () {
  'use strict';

  // =========================
  // CONFIG
  // =========================
  var CFG = {
    minAgeDefault: 21,

    // State-specific overrides/flags (example)
    // If you need exceptions, encode them here.
    // You can also set manualReview states (example).
    stateRules: {
      // 'CA': { minAge: 21 },
      // 'TX': { minAge: 21 },
      // 'NJ': { minAge: 21, allowParentalOverride: true }, // if you truly need it
    },

    // Storage key for local "verified" status.
    // If you add the server endpoint, store a signed token instead.
    storageKey: 'ag_verification',

    // How long a verification is valid (days)
    ttlDays: 30,

    // If you implement a server endpoint, put it here:
    // endpoint: 'https://yourdomain.com/api/age-verify'
    endpoint: null,

    // If endpoint is null, we do client-only evaluation.
    // Client-only: OK for UX gating; NOT strong compliance.
    mode: 'client', // 'client' | 'server'

    // If true, allow "manual review" state - blocks checkout but allows browsing.
    allowBrowseOnManualReview: true,

    // If true, force state selection (recommended).
    requireState: true
  };

  // =========================
  // UTIL
  // =========================
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function nowMs() { return Date.now(); }

  function toISO(ms) {
    try { return new Date(ms).toISOString(); } catch (e) { return ''; }
  }

  function clampInt(n, min, max) {
    var x = parseInt(String(n), 10);
    if (isNaN(x)) return null;
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function computeAge(year, month, day) {
    // month: 1-12
    var dob = new Date(year, month - 1, day);
    if (isNaN(dob.getTime())) return null;

    var today = new Date();
    var age = today.getFullYear() - dob.getFullYear();
    var m = today.getMonth() - dob.getMonth();

    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    return age;
  }

  function isValidDOB(year, month, day) {
    var d = new Date(year, month - 1, day);
    return d &&
      d.getFullYear() === year &&
      (d.getMonth() + 1) === month &&
      d.getDate() === day;
  }

  function getEffectiveRule(state) {
    if (!state) return { minAge: CFG.minAgeDefault };
    var r = CFG.stateRules[String(state).toUpperCase()];
    if (!r) return { minAge: CFG.minAgeDefault };
    return {
      minAge: (typeof r.minAge === 'number' ? r.minAge : CFG.minAgeDefault),
      manualReview: !!r.manualReview,
      allowParentalOverride: !!r.allowParentalOverride
    };
  }

  function setText(el, text) {
    if (!el) return;
    el.textContent = text || '';
  }

  function setVisible(el, show) {
    if (!el) return;
    el.style.display = show ? '' : 'none';
  }

  function disableCheckout(disabled) {
    var nodes = qsa('[data-ag-checkout="1"]');
    nodes.forEach(function (el) {
      // If it's a link/button, block interaction
      el.style.pointerEvents = disabled ? 'none' : '';
      el.style.opacity = disabled ? '0.55' : '';
      el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      if (disabled) {
        el.setAttribute('data-ag-disabled', '1');
      } else {
        el.removeAttribute('data-ag-disabled');
      }
    });
  }

  function readStored() {
    try {
      var raw = localStorage.getItem(CFG.storageKey);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.verifiedAt) return null;

      var ttlMs = CFG.ttlDays * 24 * 60 * 60 * 1000;
      if (nowMs() - obj.verifiedAt > ttlMs) return null;

      return obj;
    } catch (e) {
      return null;
    }
  }

  function writeStored(obj) {
    try {
      localStorage.setItem(CFG.storageKey, JSON.stringify(obj));
    } catch (e) {}
  }

  function clearStored() {
    try { localStorage.removeItem(CFG.storageKey); } catch (e) {}
  }

  async function postJSON(url, payload) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'include'
    });

    var txt = await res.text();
    var data = null;
    try { data = JSON.parse(txt); } catch (e) {}

    if (!res.ok) {
      var msg = (data && data.error) ? data.error : ('Request failed: ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  // =========================
  // INIT + ELEMENTS
  // =========================
  var overlay = qs('[data-ag="overlay"]');
  if (!overlay) return; // No age gate on this page

  var mm = qs('[data-ag="dob-mm"]', overlay);
  var dd = qs('[data-ag="dob-dd"]', overlay);
  var yyyy = qs('[data-ag="dob-yyyy"]', overlay);
  var stateEl = qs('[data-ag="state"]', overlay);
  var consentEl = qs('[data-ag="consent"]', overlay);
  var submitBtn = qs('[data-ag="submit"]', overlay);
  var resetBtn = qs('[data-ag="reset"]', overlay);

  var errEl = qs('[data-ag="error"]', overlay);
  var statusEl = qs('[data-ag="status"]', overlay);

  function openGate() {
    setVisible(overlay, true);
    overlay.setAttribute('aria-hidden', 'false');
    disableCheckout(true);
  }

  function closeGate() {
    setVisible(overlay, false);
    overlay.setAttribute('aria-hidden', 'true');
    disableCheckout(false);
  }

  function showError(msg) {
    setText(errEl, msg);
    setVisible(errEl, !!msg);
  }

  function showStatus(msg) {
    setText(statusEl, msg);
    setVisible(statusEl, !!msg);
  }

  function bootstrapFromStored() {
    var stored = readStored();
    if (stored && stored.decision === 'allow') {
      closeGate();
      showStatus('Verified');
      return true;
    }
    if (stored && stored.decision === 'manual_review') {
      // Allow browse, block checkout
      setVisible(overlay, false);
      overlay.setAttribute('aria-hidden', 'true');
      disableCheckout(true);
      showStatus('Verification pending review');
      return true;
    }
    return false;
  }

  // Prevent flash: hide gate ASAP until we decide
  // (Assumes overlay is visible by default in Designer)
  overlay.style.display = 'none';

  // Decide initial state
  var hasStored = bootstrapFromStored();
  if (!hasStored) {
    openGate();
  }

  // Reset handler
  if (resetBtn) {
    resetBtn.addEventListener('click', function (e) {
      e.preventDefault();
      clearStored();
      openGate();
      showStatus('');
      showError('');
    });
  }

  // =========================
  // SUBMIT
  // =========================
  if (!submitBtn) return;

  submitBtn.addEventListener('click', async function (e) {
    e.preventDefault();
    showError('');

    var m = clampInt(mm && mm.value, 1, 12);
    var d = clampInt(dd && dd.value, 1, 31);
    var y = clampInt(yyyy && yyyy.value, 1900, 2100);

    if (m === null || d === null || y === null || !isValidDOB(y, m, d)) {
      showError('Please enter a valid date of birth.');
      return;
    }

    var state = stateEl ? String(stateEl.value || '').trim().toUpperCase() : '';
    if (CFG.requireState && !state) {
      showError('Please select your state.');
      return;
    }

    var consent = consentEl ? !!consentEl.checked : true;
    if (!consent) {
      showError('Please confirm the certification checkbox.');
      return;
    }

    // CLIENT MODE
    if (CFG.mode === 'client' || !CFG.endpoint) {
      var rule = getEffectiveRule(state);
      var age = computeAge(y, m, d);
      if (age === null) {
        showError('Unable to validate your date of birth.');
        return;
      }

      if (rule.manualReview) {
        var mr = {
          decision: 'manual_review',
          verifiedAt: nowMs(),
          state: state,
          minAgeApplied: rule.minAge,
          mode: 'client'
        };
        writeStored(mr);

        if (CFG.allowBrowseOnManualReview) {
          setVisible(overlay, false);
          overlay.setAttribute('aria-hidden', 'true');
          disableCheckout(true);
          showStatus('Verification pending review');
          return;
        }

        showError('Unable to verify automatically. Please contact support.');
        return;
      }

      if (age >= rule.minAge) {
        var ok = {
          decision: 'allow',
          verifiedAt: nowMs(),
          state: state,
          minAgeApplied: rule.minAge,
          mode: 'client'
        };
        writeStored(ok);
        closeGate();
        showStatus('Verified');
        return;
      }

      // deny
      var no = {
        decision: 'deny',
        verifiedAt: nowMs(),
        state: state,
        minAgeApplied: rule.minAge,
        mode: 'client'
      };
      writeStored(no);
      showError('You are not eligible to enter this site.');
      disableCheckout(true);
      return;
    }

    // SERVER MODE
    try {
      submitBtn.setAttribute('disabled', 'disabled');
      submitBtn.style.opacity = '0.7';

      var payload = {
        dob: { mm: m, dd: d, yyyy: y },
        stateSelected: state,
        consent: consent,
        page: location.href,
        tsClient: toISO(nowMs())
      };

      var resp = await postJSON(CFG.endpoint, payload);

      // Expected response:
      // {
      //   decision: "allow" | "deny" | "manual_review",
      //   verificationId: "...",
      //   token: "signed-jwt-or-hmac",
      //   stateUsed: "IL",
      //   minAgeApplied: 21
      // }
      if (!resp || !resp.decision) throw new Error('Invalid verification response.');

      writeStored({
        decision: resp.decision,
        verifiedAt: nowMs(),
        verificationId: resp.verificationId || null,
        token: resp.token || null,
        state: resp.stateUsed || state,
        minAgeApplied: resp.minAgeApplied || CFG.minAgeDefault,
        mode: 'server'
      });

      if (resp.decision === 'allow') {
        closeGate();
        showStatus('Verified');
        return;
      }

      if (resp.decision === 'manual_review') {
        setVisible(overlay, false);
        overlay.setAttribute('aria-hidden', 'true');
        disableCheckout(true);
        showStatus('Verification pending review');
        return;
      }

      showError('You are not eligible to enter this site.');
      disableCheckout(true);
    } catch (err) {
      showError(err && err.message ? err.message : 'Verification failed. Please try again.');
      disableCheckout(true);
    } finally {
      submitBtn.removeAttribute('disabled');
      submitBtn.style.opacity = '';
    }
  });

})();
</script>
