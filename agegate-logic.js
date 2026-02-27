/**
 * Genex Peptides — Age Gate Logic v2.0
 *
 * Requires window.AGEGATE_CONFIG in <head>:
 *   window.AGEGATE_CONFIG = { minAge: 21 };
 *
 * DOM expectations (all present in live HTML):
 *   Overlay:  .age-gate
 *   Month:    [fb-age-gate-field="month"]  or  #Month
 *   Day:      [fb-age-gate-field="day"]    or  #Day
 *   Year:     [fb-age-gate-field="year"]   or  #Year
 *   Button:   [fb-age-gate-button="enter"]
 */

(function () {
  "use strict";

  const CONFIG   = window.AGEGATE_CONFIG || {};
  const MIN_AGE  = CONFIG.minAge || 21;
  const SESS_KEY = "genex_age_verified";

  // ─── Element helpers ────────────────────────────────────────────────────────

  function getOverlay() {
    return document.querySelector(".age-gate");
  }

  function getField(name) {
    // Try custom attribute, then legacy fb attribute, then by id
    return (
      document.querySelector("[data-agegate-field='" + name + "']") ||
      document.querySelector("[fb-age-gate-field='" + name + "']") ||
      document.getElementById(name.charAt(0).toUpperCase() + name.slice(1))
    );
  }

  function getButton() {
    return (
      document.querySelector("[data-agegate-button='enter']") ||
      document.querySelector("[fb-age-gate-button='enter']")
    );
  }

  // ─── Age calculation ────────────────────────────────────────────────────────

  function calculateAge(year, month, day) {
    const today = new Date();
    const born  = new Date(year, month - 1, day);
    let age = today.getFullYear() - born.getFullYear();
    const m = today.getMonth() - born.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < born.getDate())) age--;
    return age;
  }

  // ─── UI ─────────────────────────────────────────────────────────────────────

  function showError(msg) {
    let el = document.getElementById("agegate-error");
    if (!el) {
      el = document.createElement("p");
      el.id = "agegate-error";
      el.style.cssText = "color:#e74c3c;font-size:14px;margin-top:10px;text-align:center;width:100%;";
      const btn = getButton();
      if (btn && btn.parentNode) btn.parentNode.insertBefore(el, btn.nextSibling);
    }
    el.textContent = msg;
  }

  function clearError() {
    const el = document.getElementById("agegate-error");
    if (el) el.textContent = "";
  }

  function grantAccess() {
    sessionStorage.setItem(SESS_KEY, "true");
    const overlay = getOverlay();
    if (!overlay) return;
    overlay.style.transition = "opacity 0.4s ease";
    overlay.style.opacity    = "0";
    setTimeout(function () {
      overlay.style.display    = "none";
      document.body.style.overflow = "";
    }, 420);
  }

  function showBlocked(msg) {
    const overlay = getOverlay();
    if (!overlay) return;
    overlay.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:40px;text-align:center;color:#fff;">' +
        '<div style="font-size:48px;margin-bottom:24px;">&#x26D4;</div>' +
        '<h2 style="margin-bottom:16px;">Access Denied</h2>' +
        '<p style="max-width:400px;line-height:1.6;">' + msg + '</p>' +
      '</div>';
    document.body.style.overflow      = "hidden";
    document.body.style.pointerEvents = "none";
    overlay.style.pointerEvents       = "all";
  }

  // ─── Submit handler ─────────────────────────────────────────────────────────

  function handleSubmit(e) {
    e.preventDefault();
    e.stopPropagation();
    clearError();

    const monthEl = getField("month");
    const dayEl   = getField("day");
    const yearEl  = getField("year");

    if (!monthEl || !dayEl || !yearEl) {
      showError("Date fields not found — please refresh and try again.");
      return;
    }

    const month = parseInt(monthEl.value.trim(), 10);
    const day   = parseInt(dayEl.value.trim(), 10);
    const year  = parseInt(yearEl.value.trim(), 10);

    if (!month || !day || !year || yearEl.value.trim().length !== 4) {
      showError("Please enter your full date of birth.");
      return;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      showError("Please enter a valid date.");
      return;
    }

    const age = calculateAge(year, month, day);

    if (isNaN(age) || year < 1900 || year > new Date().getFullYear()) {
      showError("Please enter a valid year.");
      return;
    }

    if (age < MIN_AGE) {
      showBlocked("You must be at least " + MIN_AGE + " years of age to access this website.");
      return;
    }

    grantAccess();
  }

  // ─── Init ───────────────────────────────────────────────────────────────────

  function init() {
    const overlay = getOverlay();

    // Defuse Finsweet/Flowbase by stripping their trigger attributes
    if (overlay) {
      overlay.removeAttribute("fb-age-gate");
      overlay.removeAttribute("fb-age-gate-type");
      overlay.removeAttribute("fb-age-gate-minimum");
      overlay.removeAttribute("fb-age-gate-redirect");
    }

    // Already verified this session — hide and exit
    if (sessionStorage.getItem(SESS_KEY) === "true") {
      if (overlay) overlay.style.display = "none";
      return;
    }

    // Show overlay, lock scroll
    if (overlay) {
      overlay.style.display  = "flex";
      overlay.style.opacity  = "1";
      document.body.style.overflow = "hidden";
    }

    // Wire up the button
    const btn = getButton();
    if (btn) {
      btn.addEventListener("click", handleSubmit);
    } else {
      console.warn("[AgeGate] Enter button not found.");
    }

    // Wire up the form (prevent native Webflow submit / page reload)
    if (overlay) {
      const form = overlay.querySelector("form");
      if (form) form.addEventListener("submit", handleSubmit);
    }

    // Enter key on Year field
    const yearEl = getField("year");
    if (yearEl) {
      yearEl.addEventListener("keydown", function (e) {
        if (e.key === "Enter") handleSubmit(e);
      });
    }

    console.info("[AgeGate] Initialised.", {
      overlay: !!overlay,
      button:  !!btn,
      month:   !!getField("month"),
      day:     !!getField("day"),
      year:    !!getField("year"),
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
