/**
 * Genex Peptides — Global Age Gate Logic
 * Version: 1.0.0
 *
 * Depends on window.AGEGATE_CONFIG being set in the header before this script runs.
 *
 * Config shape:
 *   collectionId    — Webflow CMS collection ID for Age Verification Logs
 *   apiToken        — Webflow CMS API token (write-scoped)
 *   minAge          — Minimum age to allow entry (default: 21)
 *   restrictedStates — { [stateCode]: { blocked: true, reason: string } }
 *
 * Flow:
 *   1. On page load, check sessionStorage — if already verified, show site immediately.
 *   2. Show the age gate overlay.
 *   3. On submit: parse DOB, calculate age, fetch IP geolocation.
 *   4. Apply state rules.
 *   5. Log result to Webflow CMS.
 *   6. Approve → store session flag, hide overlay.
 *      Block → show block message, prevent any further interaction.
 */

(function () {
  "use strict";

  // ─── Config ──────────────────────────────────────────────────────────────────
  const CONFIG = window.AGEGATE_CONFIG || {};
  const COLLECTION_ID = CONFIG.collectionId || "";
  const API_TOKEN = CONFIG.apiToken || "";
  const MIN_AGE = CONFIG.minAge || 21;
  const RESTRICTED_STATES = CONFIG.restrictedStates || {};
  const SESSION_KEY = "genex_age_verified";
  const SESSION_STATE_KEY = "genex_detected_state";

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function generateSessionId() {
    return "sess_" + Math.random().toString(36).substr(2, 12) + "_" + Date.now();
  }

  function getOrCreateSessionId() {
    let sid = sessionStorage.getItem("genex_session_id");
    if (!sid) {
      sid = generateSessionId();
      sessionStorage.setItem("genex_session_id", sid);
    }
    return sid;
  }

  function calculateAge(dob) {
    const today = new Date();
    const birthDate = new Date(dob);
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  }

  async function detectState() {
    try {
      const res = await fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      return data.region_code || null; // e.g. "NJ", "CA", "TX"
    } catch {
      return null;
    }
  }

  async function logVerification({ declaredDob, calculatedAge, detectedState, result, consentGiven }) {
    if (!COLLECTION_ID || !API_TOKEN || API_TOKEN === "00fe6ca7ce4e138fa21895b69c643320cf4365e8588c26420945836f2ba57fd1") {
      console.warn("[AgeGate] CMS logging skipped — API token not configured.");
      return;
    }

    const sessionId = getOrCreateSessionId();
    const timestamp = new Date().toISOString();

    // Build a human-readable name for the CMS item
    const itemName = `${result} — ${detectedState || "Unknown"} — ${timestamp.slice(0, 10)}`;
    const slug = sessionId;

    // Map result string to the option names defined in the CMS field
    const resultOptionMap = {
      approved: "Approved",
      blocked_underage: "Blocked - Underage",
      blocked_state: "Blocked - Restricted State",
      flagged: "Flagged for Review",
    };

    const payload = {
      fieldData: {
        name: itemName,
        slug: slug,
        "verification-timestamp": timestamp,
        "declared-dob": declaredDob,
        "calculated-age": calculatedAge,
        "detected-state": detectedState || "Unknown",
        "verification-result": resultOptionMap[result] || "Flagged for Review",
        "consent-given": consentGiven || false,
        "session-id": sessionId,
      },
      isDraft: false,
      isArchived: false,
    };

    try {
      const res = await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        console.error("[AgeGate] CMS log failed:", err);
      } else {
        console.info("[AgeGate] Verification logged to CMS.");
      }
    } catch (err) {
      console.error("[AgeGate] CMS log network error:", err);
    }
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────

  function showBlockScreen(reason) {
    const overlay = document.getElementById("age-gate-overlay");
    if (!overlay) return;

    overlay.innerHTML = `
      <div class="age-gate-block-screen">
        <div class="age-gate-block-icon">⛔</div>
        <h2 class="age-gate-block-title">Access Denied</h2>
        <p class="age-gate-block-message">${reason}</p>
        <p class="age-gate-block-sub">If you believe this is an error, please contact us directly.</p>
      </div>
    `;

    // Permanently block the page underneath
    document.body.style.overflow = "hidden";
    document.body.style.pointerEvents = "none";
    overlay.style.pointerEvents = "all";
  }

  function showError(msg) {
    let el = document.getElementById("age-gate-error");
    if (!el) {
      el = document.createElement("p");
      el.id = "age-gate-error";
      el.style.cssText = "color:#e74c3c;font-size:14px;margin-top:8px;text-align:center;";
      const form = document.getElementById("age-gate-form");
      if (form) form.appendChild(el);
    }
    el.textContent = msg;
  }

  function clearError() {
    const el = document.getElementById("age-gate-error");
    if (el) el.textContent = "";
  }

  function setLoading(isLoading) {
    const btn = document.querySelector("[fb-age-gate-button='enter'], .age-gate-button");
    if (!btn) return;
    btn.textContent = isLoading ? "Verifying..." : "Enter Website";
    btn.style.opacity = isLoading ? "0.6" : "1";
    btn.style.pointerEvents = isLoading ? "none" : "auto";
  }

  function grantAccess() {
    sessionStorage.setItem(SESSION_KEY, "true");
    const overlay = document.getElementById("age-gate-overlay");
    if (overlay) {
      overlay.style.transition = "opacity 0.4s ease";
      overlay.style.opacity = "0";
      setTimeout(() => {
        overlay.style.display = "none";
        document.body.style.overflow = "";
      }, 400);
    }
  }

  // ─── Main Verification Handler ────────────────────────────────────────────────

  async function handleSubmit(e) {
    e.preventDefault();
    clearError();
    setLoading(true);

    // 1. Collect DOB fields
    const monthEl = document.querySelector("[data-agegate-field='month']");
    const dayEl = document.querySelector("[data-agegate-field='day']");
    const yearEl = document.querySelector("[data-agegate-field='year']");

    if (!monthEl || !dayEl || !yearEl) {
      showError("Could not find date fields. Please refresh and try again.");
      setLoading(false);
      return;
    }

    const month = monthEl.value.trim().padStart(2, "0");
    const day = dayEl.value.trim().padStart(2, "0");
    const year = yearEl.value.trim();

    if (!month || !day || !year || year.length !== 4) {
      showError("Please enter your full date of birth.");
      setLoading(false);
      return;
    }

    const dob = `${year}-${month}-${day}`;
    const dobDate = new Date(dob);

    if (isNaN(dobDate.getTime())) {
      showError("That doesn't look like a valid date. Please check and try again.");
      setLoading(false);
      return;
    }

    const age = calculateAge(dob);

    // 2. Detect state via IP
    const detectedState = await detectState();
    sessionStorage.setItem(SESSION_STATE_KEY, detectedState || "Unknown");

    // 3. Check if underage
    if (age < MIN_AGE) {
      await logVerification({
        declaredDob: dob,
        calculatedAge: age,
        detectedState,
        result: "blocked_underage",
        consentGiven: false,
      });
      setLoading(false);
      showBlockScreen(
        `You must be at least ${MIN_AGE} years of age to access this website.`
      );
      return;
    }

    // 4. Check restricted state
    if (detectedState && RESTRICTED_STATES[detectedState]) {
      const stateRule = RESTRICTED_STATES[detectedState];

      // NJ special case: parental consent flow (future enhancement hook)
      const isNJ = detectedState === "NJ";

      if (stateRule.blocked && !isNJ) {
        await logVerification({
          declaredDob: dob,
          calculatedAge: age,
          detectedState,
          result: "blocked_state",
          consentGiven: false,
        });
        setLoading(false);
        showBlockScreen(
          `We're sorry — due to local regulations, this website is not available in your region (${detectedState}). ${stateRule.reason || ""}`
        );
        return;
      }

      // NJ: log as approved with consent flag (consent UI can be layered later)
      if (isNJ) {
        await logVerification({
          declaredDob: dob,
          calculatedAge: age,
          detectedState,
          result: "approved",
          consentGiven: true, // Presumed for now; extend with actual consent checkbox if needed
        });
        setLoading(false);
        grantAccess();
        return;
      }
    }

    // 5. Approved
    await logVerification({
      declaredDob: dob,
      calculatedAge: age,
      detectedState,
      result: "approved",
      consentGiven: false,
    });

    setLoading(false);
    grantAccess();
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    // If already verified this session, skip the gate immediately
    if (sessionStorage.getItem(SESSION_KEY) === "true") {
      const overlay = document.getElementById("age-gate-overlay");
      if (overlay) overlay.style.display = "none";
      return;
    }

    // Show overlay and lock scroll
    const overlay = document.getElementById("age-gate-overlay");
    if (overlay) {
      overlay.style.display = "flex";
      document.body.style.overflow = "hidden";
    }

    // Bind submit to the enter button
    const enterBtn = document.querySelector("[data-agegate-button='enter']");
    if (enterBtn) {
      enterBtn.addEventListener("click", handleSubmit);
    }

    // Also support Enter key on year field to trigger submit
    const yearField = document.querySelector("[fb-age-gate-field='year']");
    if (yearField) {
      yearField.addEventListener("keydown", (e) => {
        if (e.key === "Enter") handleSubmit(e);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
