/*!
 * Genex Age Gate (Homade) v1.0.1
 * - Webflow-friendly via data-ag attributes
 * - Default overlay can be display:none in Designer; script force-shows on publish
 * - Cookie-based verification cache (optional localStorage fallback)
 * - State-aware rules (simple config object)
 * - Optional server mode via CFG.endpoint for audit trail + signed token
 *
 * Required attributes in Webflow:
 *  - Overlay wrapper:        data-ag="overlay"
 *  - DOB month input:        data-ag="dob-mm"
 *  - DOB day input:          data-ag="dob-dd"
 *  - DOB year input:         data-ag="dob-yyyy"
 *  - Submit button:          data-ag="submit"
 * Optional:
 *  - State select:           data-ag="state"
 *  - Consent checkbox:       data-ag="consent"
 *  - Error text element:     data-ag="error"
 *  - Status text element:    data-ag="status"
 *  - Reset link/button:      data-ag="reset"
 *  - Checkout triggers:      data-ag-checkout="1"
 *
 * Notes:
 *  - If CFG.mode === 'client', there is NO real audit trail. For compliance logging,
 *    set CFG.endpoint and CFG.mode='server' and implement the endpoint.
 */

(function () {
  'use strict';

  // =========================
  // CONFIG
  // =========================
  var CFG = {
    // Minimum age if state-specific rule not provided
    minAgeDefault: 21,

    // State rules: override minAge or force manual review by state
    // Example:
    // stateRules: { IL: { minAge: 21 }, NJ: { minAge: 21, manualReview: true } }
    stateRules: {},

    // Storage strategy:
    // - 'cookie' recommended (survives across tabs, easy)
    // - 'localStorage' ok too
    storage: 'cookie', // 'cookie' | 'localStorage'

    // Cookie/localStorage key
    key: 'ag_verified',

    // How long verification is valid
    ttlDays: 30,

    // Overlay should display as flex or block when shown (set to match your layout)
    overlayDisplay: 'flex',

    // Require state selection (recommended). If false, state can be blank -> uses default rule.
    requireState: false,

    // Require consent checkbox if present
    requireConsent: true,

    // Allow browse but block checkout for manual review outcomes
    allowBrowseOnManualReview: true,

    // Mode:
    // - 'client' = calculate decision in browser
    // - 'server' = POST to endpoint and obey server decision (audit/logging capable)
    mode: 'client', // 'client' | 'server'

    // If mode is server, set endpoint to your verification API
    // endpoint: 'https://your-worker-domain/api/age-verify'
    endpoint: null,

    // Debug logs in console
    debug: true
  };

  // =========================
  // UTILS
  // =========================
  function log() {
    if (!CFG.debug) return;
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[AgeGate]');
      console.log.apply(console, args);
    } catch (e) {}
  }

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function nowMs() {
    return Date.now();
  }

  function toISO(ms) {
    try {
      return new Date(ms).toISOString();
    } catch (e) {
      return '';
    }
  }

  function clampInt(n, min, max) {
    var x = parseInt(String(n), 10);
    if (isNaN(x)) return null;
    if (x < min) return min;
    if (x > max) return max;
    return x;
  }

  function isValidDOB(year, month, day) {
    var d = new Date(year, month - 1, day);
    return (
      d &&
      d.getFullYear() === year &&
      d.getMonth() + 1 === month &&
      d.getDate() === day
    );
  }

  function computeAge(year, month, day) {
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

  function getEffectiveRule(state) {
    if (!state) return { minAge: CFG.minAgeDefault };
    var key = String(state).toUpperCase();
    var r = CFG.stateRules[key];
    if (!r) return { minAge: CFG.minAgeDefault };
    return {
      minAge: typeof r.minAge === 'number' ? r.minAge : CFG.minAgeDefault,
      manualReview: !!r.manualReview
    };
  }

  // -------------------------
  // Cookie/localStorage
  // -------------------------
  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie =
      encodeURIComponent(name) +
      '=' +
      encodeURIComponent(value) +
      '; expires=' +
      d.toUTCString() +
      '; path=/; SameSite=Lax';
  }

  function getCookie(name) {
    var n = encodeURIComponent(name) + '=';
    var parts = document.cookie.split('; ');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.indexOf(n) === 0) return decodeURIComponent(p.substring(n.length));
    }
    return null;
  }

  function deleteCookie(name) {
    document.cookie =
      encodeURIComponent(name) +
      '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax';
  }

  function readStored() {
    var raw = null;

    if (CFG.storage === 'cookie') {
      raw = getCookie(CFG.key);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        // support simple legacy cookie values like "1"
        if (raw === '1') {
          return { decision: 'allow', verifiedAt: nowMs(), mode: 'cookie-legacy' };
        }
        return null;
      }
    }

    // localStorage
    try {
      raw = localStorage.getItem(CFG.key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e2) {
      return null;
    }
  }

  function writeStored(obj) {
    if (!obj) return;
    if (CFG.storage === 'cookie') {
      // store JSON in cookie (keep it small)
      try {
        setCookie(CFG.key, JSON.stringify(obj), CFG.ttlDays);
      } catch (e) {
        // fallback to simple value
        setCookie(CFG.key, '1', CFG.ttlDays);
      }
      return;
    }

    try {
      localStorage.setItem(CFG.key, JSON.stringify(obj));
    } catch (e2) {}
  }

  function clearStored() {
    if (CFG.storage === 'cookie') {
      deleteCookie(CFG.key);
      return;
    }
    try {
      localStorage.removeItem(CFG.key);
    } catch (e) {}
  }

  function isStoredValid(obj) {
    if (!obj || !obj.verifiedAt) return false;
    var ttlMs = CFG.ttlDays * 24 * 60 * 60 * 1000;
    return nowMs() - obj.verifiedAt <= ttlMs;
  }

  // -------------------------
  // Network
  // -------------------------
  function postJSON(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try {
          data = JSON.parse(txt);
        } catch (e) {}
        if (!res.ok) {
          var msg = data && data.error ? data.error : 'Request failed: ' + res.status;
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  // =========================
  // ELEMENTS
  // =========================
  var overlay = qs('[data-ag="overlay"]');
  if (!overlay) {
    log('No overlay found. Expected [data-ag="overlay"].');
    return;
  }

  var mm = qs('[data-ag="dob-mm"]', overlay);
  var dd = qs('[data-ag="dob-dd"]', overlay);
  var yyyy = qs('[data-ag="dob-yyyy"]', overlay);
  var stateEl = qs('[data-ag="state"]', overlay);
  var consentEl = qs('[data-ag="consent"]', overlay);
  var submitBtn = qs('[data-ag="submit"]', overlay);
  var resetBtn = qs('[data-ag="reset"]', overlay);

  var errEl = qs('[data-ag="error"]', overlay);
  var statusEl = qs('[data-ag="status"]', overlay);

  // =========================
  // VISIBILITY + CHECKOUT GATING
  // =========================
  function setText(el, text) {
    if (!el) return;
    el.textContent = text || '';
  }

  function showError(msg) {
    setText(errEl, msg);
    if (errEl) errEl.style.display = msg ? '' : 'none';
  }

  function showStatus(msg) {
    setText(statusEl, msg);
    if (statusEl) statusEl.style.display = msg ? '' : 'none';
  }

  function disableCheckout(disabled) {
    var nodes = qsa('[data-ag-checkout="1"]');
    nodes.forEach(function (el) {
      el.style.pointerEvents = disabled ? 'none' : '';
      el.style.opacity = disabled ? '0.55' : '';
      el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    });
  }

  // IMPORTANT: Because you publish the overlay as display:none, we MUST force a display value here.
  function openGate() {
    overlay.style.display = CFG.overlayDisplay || 'block';
    overlay.style.visibility = 'visible';
    overlay.setAttribute('aria-hidden', 'false');
    disableCheckout(true);
    log('openGate()', {
      overlayDisplay: getComputedStyle(overlay).display,
      cookie: CFG.storage === 'cookie' ? getCookie(CFG.key) : null
    });
  }

  function closeGate() {
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    disableCheckout(false);
    log('closeGate()');
  }

  // =========================
  // BOOTSTRAP
  // =========================
  // Keep it out of your way in Designer by default (you publish display:none),
  // but do not change that here until we've evaluated stored verification.
  log('loaded', { href: location.href });
  log('overlay found?', true, 'initial computed display:', getComputedStyle(overlay).display);

  var stored = readStored();
  if (stored && isStoredValid(stored)) {
    if (stored.decision === 'allow') {
      closeGate();
      showStatus('Verified');
    } else if (stored.decision === 'manual_review') {
      // allow browse, block checkout
      overlay.style.display = 'none';
      overlay.setAttribute('aria-hidden', 'true');
      disableCheckout(true);
      showStatus('Verification pending review');
      log('manual_review (stored) -> browse allowed, checkout blocked');
    } else if (stored.decision === 'deny') {
      // deny stays gated
      openGate();
      showError('You are not eligible to enter this site.');
    } else {
      // unknown decision -> open gate
      openGate();
    }
  } else {
    // no valid stored verification -> open gate
    openGate();
  }

  // Reset handler
  if (resetBtn) {
    resetBtn.addEventListener('click', function (e) {
      e.preventDefault();
      clearStored();
      showError('');
      showStatus('');
      openGate();
    });
  }

  // Submit handler
  if (!submitBtn) {
    log('Missing submit button: expected [data-ag="submit"] inside overlay.');
    // Still keep gate open to be safe
    openGate();
    return;
  }

  submitBtn.addEventListener('click', function (e) {
    e.preventDefault();
    showError('');

    // Basic element presence checks
    if (!mm || !dd || !yyyy) {
      showError('Age verification form is not configured correctly.');
      log('Missing DOB fields. Required: [data-ag="dob-mm"], [data-ag="dob-dd"], [data-ag="dob-yyyy"]');
      return;
    }

    var m = clampInt(mm.value, 1, 12);
    var d = clampInt(dd.value, 1, 31);
    var y = clampInt(yyyy.value, 1900, 2100);

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
    if (CFG.requireConsent && consentEl && !consent) {
      showError('Please confirm the certification checkbox.');
      return;
    }

    // =========================
    // CLIENT MODE
    // =========================
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
          overlay.style.display = 'none';
          overlay.setAttribute('aria-hidden', 'true');
          disableCheckout(true);
          showStatus('Verification pending review');
          log('client decision manual_review');
          return;
        }

        showError('Unable to verify automatically. Please contact support.');
        disableCheckout(true);
        log('client decision manual_review (browse blocked)');
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
        log('client decision allow', { age: age, minAge: rule.minAge, state: state || null });
        return;
      }

      var no = {
        decision: 'deny',
        verifiedAt: nowMs(),
        state: state,
        minAgeApplied: rule.minAge,
        mode: 'client'
      };
      writeStored(no);
      openGate();
      showError('You are not eligible to enter this site.');
      disableCheckout(true);
      log('client decision deny', { age: age, minAge: rule.minAge, state: state || null });
      return;
    }

    // =========================
    // SERVER MODE
    // =========================
    submitBtn.setAttribute('disabled', 'disabled');
    submitBtn.style.opacity = '0.7';

    var payload = {
      dob: { mm: m, dd: d, yyyy: y },
      stateSelected: state,
      consent: consent,
      page: location.href,
      tsClient: toISO(nowMs())
    };

    postJSON(CFG.endpoint, payload)
      .then(function (resp) {
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
          log('server decision allow', resp);
          return;
        }

        if (resp.decision === 'manual_review') {
          overlay.style.display = 'none';
          overlay.setAttribute('aria-hidden', 'true');
          disableCheckout(true);
          showStatus('Verification pending review');
          log('server decision manual_review', resp);
          return;
        }

        openGate();
        showError('You are not eligible to enter this site.');
        disableCheckout(true);
        log('server decision deny', resp);
      })
      .catch(function (err) {
        openGate();
        disableCheckout(true);
        showError((err && err.message) ? err.message : 'Verification failed. Please try again.');
        log('server error', err);
      })
      .finally(function () {
        submitBtn.removeAttribute('disabled');
        submitBtn.style.opacity = '';
      });
  });
})();
