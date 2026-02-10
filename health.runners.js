// /health.runners.js
// PRODUCTION VERSION - Constraint Satisfaction + Detailed Blocker Reporting + Resource Management
const SCRIPT_VERSION = "2026-02-06T13:30:00Z-PRODUCTION-V3";

const { chromium } = require("playwright");

/**
 * Logging
 */
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
function logInfo(msg, data = null) {
  if (LOG_LEVEL === "silent") return;
  const ts = new Date().toISOString();
  if (data) console.log(`[${ts}] ${msg}`, JSON.stringify(data, null, 2));
  else console.log(`[${ts}] ${msg}`);
}
function logDebug(msg, data = null) {
  if (LOG_LEVEL !== "debug") return;
  logInfo(msg, data);
}

// ------------------------------
// Config
// ------------------------------
const MAX_PAGES_TO_VISIT = Number(process.env.HEALTH_MAX_PAGES || 3);
const MAX_PHONE_TESTS = Number(process.env.HEALTH_MAX_PHONE || 10);
const MAX_EMAIL_TESTS = Number(process.env.HEALTH_MAX_EMAIL || 10);
const NAV_TIMEOUT_MS = Number(process.env.HEALTH_NAV_TIMEOUT_MS || 45000);
const INIT_WAIT_MS = Number(process.env.HEALTH_INIT_WAIT_MS || 3500);
const HEADLESS = (process.env.HEALTH_HEADLESS || "true").toLowerCase() !== "false";
const POST_ACTION_POLL_MS = Number(process.env.HEALTH_POST_ACTION_POLL_MS || 8000);
const FORM_SUBMIT_WAIT_MS = Number(process.env.HEALTH_FORM_WAIT_MS || 15000);

// NEW: Global timeout and concurrency limits
const GLOBAL_TIMEOUT_MS = Number(process.env.HEALTH_GLOBAL_TIMEOUT_MS || 300000); // 5 minutes max per health check
const MAX_CONCURRENT_CHECKS = Number(process.env.HEALTH_MAX_CONCURRENT || 2); // Max 2 health checks at once

// Test identity
const TEST_VALUES = {
  firstName: "Test",
  lastName: "User",
  fullName: "Test User",
  email: process.env.HEALTH_TEST_EMAIL || "test+healthcheck@example.com",
  phone: process.env.HEALTH_TEST_PHONE || "07123456789",
  message: process.env.HEALTH_TEST_MESSAGE || "Tracking health check test submission. Please ignore."
};

// Third-party providers to skip
const THIRD_PARTY_HINTS = [
  "hubspot", "hsforms", "jotform", "typeform", "google.com/forms", "forms.gle",
  "calendly", "marketo", "pardot", "salesforce", "formstack", "wufoo", "cognitoforms"
];

const CONTACT_PAGE_KEYWORDS = [
  "contact", "get-in-touch", "getintouch", "enquire", "enquiry", "inquire", "inquiry",
  "quote", "estimate", "book", "booking", "appointment", "consultation", "request"
];

const COMMON_CONTACT_PATHS = [
  "/contact", "/contact-us", "/contact-us/", "/contactus", "/get-in-touch", "/get-in-touch/",
  "/enquiry", "/enquire", "/book", "/booking"
];

const GENERIC_EVENTS = [
  "page_view", "user_engagement", "scroll", "session_start", "first_visit", "form_start"
];

// NEW: Concurrency control
let activeChecks = 0;
const checkQueue = [];

// ------------------------------
// NEW: Concurrency Manager
// ------------------------------
async function acquireCheckSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    logDebug("Health check slot acquired", { activeChecks, maxConcurrent: MAX_CONCURRENT_CHECKS });
    return;
  }

  // Wait in queue
  return new Promise((resolve) => {
    checkQueue.push(resolve);
    logDebug("Health check queued", { queueLength: checkQueue.length });
  });
}

function releaseCheckSlot() {
  activeChecks--;
  logDebug("Health check slot released", { activeChecks, queueLength: checkQueue.length });
  
  if (checkQueue.length > 0) {
    const next = checkQueue.shift();
    activeChecks++;
    next();
  }
}

// ------------------------------
// NEW: Global Timeout Wrapper
// ------------------------------
async function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;
  
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// ------------------------------
// Helpers
// ------------------------------
function normaliseUrl(input) {
  if (!input) return null;
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function safeUrlObj(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function containsAny(str, needles) {
  const s = (str || "").toLowerCase();
  return needles.some((n) => s.includes(n));
}

function classifyGaBeacon(reqUrl) {
  const u = reqUrl.toLowerCase();
  if (u.includes("/g/collect") || u.includes("/r/collect")) return "GA4";
  if (u.includes("google-analytics.com")) return "GA";
  if (u.includes("googletagmanager.com") || u.includes("gtm.js")) return "GTM";
  if (u.includes("gtag/js")) return "GTAG";
  return "OTHER";
}

function parseEventNameFromUrl(reqUrl) {
  try {
    const u = new URL(reqUrl);
    return u.searchParams.get("en") || null;
  } catch {
    return null;
  }
}

function parseEventNameFromPostData(postData) {
  if (!postData || typeof postData !== "string") return null;
  try {
    const params = new URLSearchParams(postData);
    return params.get("en") || null;
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function safeWait(page, ms) {
  try {
    if (page) {
      await page.waitForTimeout(ms);
    } else {
      await new Promise(resolve => setTimeout(resolve, ms));
    }
  } catch {}
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return { ok: true, mode: "domcontentloaded" };
  } catch (e1) {
    logDebug("⚠️ goto domcontentloaded failed, retry commit", { url, err: e1.message });
    try {
      await page.goto(url, { waitUntil: "commit", timeout: Math.min(30000, NAV_TIMEOUT_MS) });
      return { ok: true, mode: "commit" };
    } catch (e2) {
      return { ok: false, error: `Could not load page: ${e2.message}` };
    }
  }
}

// ------------------------------
// Cookie consent
// ------------------------------
async function handleCookieConsent(page) {
  const out = { banner_found: false, accepted: false, details: null };

  const candidates = [
    "#onetrust-accept-btn-handler",
    "button:has-text('Accept')",
    "button:has-text('Accept All')",
    "button:has-text('Accept all')",
    "button:has-text('I Accept')",
    "button:has-text('Agree')",
    "button:has-text('OK')",
    "button:has-text('Allow all')",
    "button:has-text('Allow All')",
    "a:has-text('Accept')",
    ".cookie-accept",
    ".accept-cookies",
    "[id*='accept'][role='button']",
    "[class*='accept'][role='button']",
    "[aria-label*='accept' i]"
  ];

  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        if (await loc.isVisible({ timeout: 800 })) {
          out.banner_found = true;
          out.details = { selector: sel, scope: "page" };
          await loc.click({ timeout: 1500 }).catch(() => null);
          await safeWait(page, 1200);
          out.accepted = true;
          return out;
        }
      }
    } catch {}
  }

  // iframes
  try {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const sel of candidates) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.count()) {
            if (await loc.isVisible({ timeout: 600 })) {
              out.banner_found = true;
              out.details = { selector: sel, scope: "iframe", frameUrl: frame.url() };
              await loc.click({ timeout: 1500 }).catch(() => null);
              await safeWait(page, 1200);
              out.accepted = true;
              return out;
            }
          }
        } catch {}
      }
    }
  } catch {}

  return out;
}

// ------------------------------
// Try to expand mobile/hidden menus
// ------------------------------
async function tryExpandMenus(page) {
  const menuSelectors = [
    "button[aria-label*='menu' i]",
    "button[aria-label*='navigation' i]",
    ".hamburger",
    ".menu-toggle",
    "#menu-toggle",
    "[class*='mobile-menu-toggle']",
    "[class*='nav-toggle']"
  ];

  for (const sel of menuSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 1000 }).catch(() => null);
          await safeWait(page, 800);
          logDebug("Expanded menu", { selector: sel });
          return;
        }
      }
    } catch {}
  }
}

// ------------------------------
// Detect tracking setup
// ------------------------------
async function detectTrackingSetup(page, beacons) {
  const tagData = await page.evaluate(() => {
    const tags = { gtm: [], ga4: [], aw: [] };
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const content = (s.innerHTML || "") + " " + (s.src || "");
      const gtm = content.match(/GTM-[A-Z0-9]+/g);
      const ga4 = content.match(/G-[A-Z0-9]+/g);
      const aw = content.match(/AW-[A-Z0-9]+/g);
      if (gtm) tags.gtm.push(...gtm);
      if (ga4) tags.ga4.push(...ga4);
      if (aw) tags.aw.push(...aw);
    }
    const gtmLoaded = !!window.google_tag_manager;
    const gaRuntimePresent = !!window.gtag || !!window.dataLayer;
    return {
      gtm: Array.from(new Set(tags.gtm)),
      ga4: Array.from(new Set(tags.ga4)),
      aw: Array.from(new Set(tags.aw)),
      gtmLoaded,
      gaRuntimePresent
    };
  });

  const beaconCounts = {
    gtm: beacons.filter((b) => b.type === "GTM").length,
    ga4: beacons.filter((b) => b.type === "GA4").length
  };

  const hasAnyTracking =
    tagData.gtm.length > 0 ||
    tagData.ga4.length > 0 ||
    tagData.gtmLoaded ||
    beaconCounts.gtm > 0 ||
    beaconCounts.ga4 > 0;

  return {
    tags_found: { gtm: tagData.gtm, ga4: tagData.ga4, ignored_aw: tagData.aw },
    runtime: { gtm_loaded: tagData.gtmLoaded, ga_runtime_present: tagData.gaRuntimePresent },
    beacon_counts: beaconCounts,
    hasAnyTracking
  };
}

// ------------------------------
// Discover candidate pages
// ------------------------------
async function discoverCandidatePages(page, baseUrl) {
  const origin = safeUrlObj(baseUrl)?.origin || null;

  await tryExpandMenus(page);
  await safeWait(page, 500);

  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map((a) => ({
      href: a.getAttribute("href") || "",
      text: (a.textContent || "").trim().slice(0, 120)
    }));
  });

  const abs = [];
  for (const l of links) {
    try {
      const u = new URL(l.href, baseUrl).toString();
      if (!origin || !u.startsWith(origin)) continue;
      abs.push({ url: u, text: l.text });
    } catch {}
  }

  const scored = abs
    .map((x) => {
      const hay = `${x.url} ${x.text}`.toLowerCase();
      const score = CONTACT_PAGE_KEYWORDS.reduce((acc, k) => (hay.includes(k) ? acc + 1 : acc), 0);
      return { ...x, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const uniqueSorted = scored.filter((x) => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });

  const firstContact = uniqueSorted.find((x) => /contact/.test(x.url.toLowerCase()));
  const rest = uniqueSorted.filter((x) => x !== firstContact);

  let discovered = [firstContact?.url, ...rest.map((x) => x.url)]
    .filter(Boolean)
    .slice(0, Math.max(0, MAX_PAGES_TO_VISIT - 1));

  if (discovered.length === 0 && origin) {
    logDebug("No contact pages found via links, trying common paths");
    for (const path of COMMON_CONTACT_PATHS) {
      const commonUrl = origin + path;
      if (!seen.has(commonUrl)) {
        discovered.push(commonUrl);
        seen.add(commonUrl);
        if (discovered.length >= MAX_PAGES_TO_VISIT - 1) break;
      }
    }
  }

  return discovered;
}

// ------------------------------
// CTA scan
// ------------------------------
async function scanCTAsOnPage(page) {
  return await page.evaluate(() => {
    const phones = Array.from(document.querySelectorAll("a[href^='tel:']"))
      .map((a) => a.getAttribute("href"))
      .filter(Boolean);
    const emails = Array.from(document.querySelectorAll("a[href^='mailto:']"))
      .map((a) => a.getAttribute("href"))
      .filter(Boolean);
    return { phones, emails };
  });
}

function normaliseTelHref(href) {
  if (!href) return null;
  return href.replace(/\s+/g, "").toLowerCase();
}

function normaliseMailtoHref(href) {
  if (!href) return null;
  return href.trim().toLowerCase();
}

function escapeAttrValue(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ------------------------------
// CTA test
// ------------------------------
async function testLinkCTA(page, beacons, rawHref, type) {
  const before = beacons.length;
  const hrefEsc = escapeAttrValue(rawHref);
  const selector =
    type === "phone"
      ? `a[href="${hrefEsc}"], a[href^="tel:"][href="${hrefEsc}"]`
      : `a[href="${hrefEsc}"], a[href^="mailto:"][href="${hrefEsc}"]`;

  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count())) {
      return { status: "NOT_TESTED", reason: "cta_not_found_on_page", beacons_delta: 0 };
    }

    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => null);
      await safeWait(page, 300);

      try {
        await loc.click({ timeout: 3000 });
      } catch (normalClickErr) {
        logDebug("Normal click failed, trying force click", { error: normalClickErr.message });
        try {
          await loc.click({ force: true, timeout: 3000 });
        } catch (forceClickErr) {
          logDebug("Force click failed, trying JS click", { error: forceClickErr.message });
          await loc.evaluate((el) => el.click()).catch(() => null);
        }
      }
    } catch (scrollErr) {
      return {
        status: "NOT_TESTED",
        reason: `element_interaction_failed: ${scrollErr.message}`,
        beacons_delta: 0
      };
    }

    const start = Date.now();
    while (Date.now() - start < POST_ACTION_POLL_MS) {
      await safeWait(page, 800);

      const newGa4 = beacons.slice(before).filter((b) => b.type === "GA4");
      const meaningfulEvents = newGa4.filter((b) => {
        const eventName = (b.event_name || "").toLowerCase();
        return !GENERIC_EVENTS.some(generic => eventName === generic);
      });

      if (meaningfulEvents.length) {
        return {
          status: "PASS",
          reason: null,
          beacons_delta: beacons.length - before,
          ga4_events: uniq(meaningfulEvents.map((b) => b.event_name).filter(Boolean)),
          evidence_urls: meaningfulEvents.slice(0, 5).map((b) => b.url)
        };
      }
    }

    const allNewGa4 = beacons.slice(before).filter((b) => b.type === "GA4");
    const genericEventsSeen = uniq(allNewGa4.map((b) => b.event_name).filter(Boolean));

    return {
      status: "FAIL",
      reason: genericEventsSeen.length
        ? "only_generic_events_fired"
        : "no_ga4_beacon_after_click",
      beacons_delta: beacons.length - before,
      generic_events_seen: genericEventsSeen
    };
  } catch (e) {
    return {
      status: "NOT_TESTED",
      reason: `cta_test_error: ${e.message}`,
      beacons_delta: 0
    };
  }
}

// ------------------------------
// Form detection
// ------------------------------
async function pickBestFirstPartyFormOnPage(page, pageUrl) {
  const iframeInfos = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => (f.getAttribute("src") || "").trim()).filter(Boolean)
  );
  const thirdPartyIframes = iframeInfos.filter((src) => containsAny(src.toLowerCase(), THIRD_PARTY_HINTS));

  const formCandidates = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll("form"));
    const out = [];
    function textOf(el) { return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400); }
    function attr(el, name) { return (el && el.getAttribute && el.getAttribute(name)) || ""; }
    function has(el, selector) { try { return !!el.querySelector(selector); } catch { return false; } }

    for (let i = 0; i < forms.length; i++) {
      const f = forms[i];
      const action = attr(f, "action");
      const id = attr(f, "id");
      const cls = attr(f, "class");
      const aria = attr(f, "aria-label");
      const inputs = f.querySelectorAll("input, textarea, select");
      const inputCount = inputs.length;

      const hasTextarea = has(f, "textarea");
      const hasEmail = has(f, "input[type='email']") || Array.from(inputs).some((x) => (attr(x, "name") || "").toLowerCase().includes("email"));
      const hasPhone = has(f, "input[type='tel']") || Array.from(inputs).some((x) => (attr(x, "name") || "").toLowerCase().includes("phone"));
      const hasName = Array.from(inputs).some((x) => {
        const n = (attr(x, "name") || "").toLowerCase();
        const p = (attr(x, "placeholder") || "").toLowerCase();
        return n.includes("name") || p.includes("name");
      });

      const submitText = (() => {
        const btn =
          f.querySelector("button[type='submit']") ||
          f.querySelector("input[type='submit']") ||
          Array.from(f.querySelectorAll("button")).find((b) => /send|submit|enquir|quote|request|book/i.test(textOf(b))) ||
          null;
        return btn ? textOf(btn) : "";
      })();

      const aroundText = textOf(f.closest("section") || f.closest("div") || f.parentElement);
      const hay = `${id} ${cls} ${aria} ${submitText} ${aroundText}`.toLowerCase();
      const isNewsletter = /newsletter|subscribe|subscription/.test(hay);
      const isSearch = /search/.test(hay) && inputCount <= 2;
      const isLogin = /login|sign in|password/.test(hay);

      let score = 0;
      if (hasEmail) score += 2;
      if (hasTextarea) score += 3;
      if (hasName) score += 1;
      if (hasPhone) score += 1;
      if (/send|submit|enquir|quote|request|book|contact/i.test(submitText)) score += 2;
      if (/contact|get in touch|enquir|quote|estimate|book/i.test(hay)) score += 2;
      if (isNewsletter) score -= 5;
      if (isSearch) score -= 5;
      if (isLogin) score -= 7;

      out.push({ index: i, action, inputCount, hasEmail, hasTextarea, hasPhone, hasName, submitText, score });
    }

    out.sort((a, b) => (b.score - a.score) || (b.inputCount - a.inputCount));
    return out;
  });

  const best = formCandidates.find((f) => f.score >= 1) || formCandidates[0] || null;
  let bestIsThirdPartyByAction = false;
  if (best && best.action) {
    try {
      const actionUrl = new URL(best.action, pageUrl);
      const pageOrigin = new URL(pageUrl).origin;
      const actionLower = actionUrl.href.toLowerCase();
      if (actionUrl.origin !== pageOrigin && containsAny(actionLower, THIRD_PARTY_HINTS)) {
        bestIsThirdPartyByAction = true;
      }
    } catch {}
  }

  return {
    third_party_iframes: thirdPartyIframes,
    best_form: best ? { ...best, third_party_by_action: bestIsThirdPartyByAction } : null
  };
}

// ------------------------------
// CONSTRAINT SATISFACTION: Smart field filling
// ------------------------------
async function fillFormFieldSmart(el, value, fieldType) {
  try {
    // Special handling for phone fields (masked inputs, lazy loading, etc.)
    if (fieldType === 'phone') {
      await el.focus().catch(() => null);
      await safeWait(null, 100);
      await el.clear().catch(() => null);
      await el.type(value, { delay: 50 }).catch(() => null);
      await el.blur().catch(() => null);
      await safeWait(null, 100);
      
      const actualValue = await el.inputValue().catch(() => '');
      return actualValue.replace(/\D/g, '').includes(value.replace(/\D/g, '').substring(0, 8));
    }
    
    // Standard fill for other fields
    await el.fill(value, { timeout: 1200 }).catch(() => null);
    await safeWait(null, 80);
    
    const actualValue = await el.inputValue().catch(() => '');
    return actualValue === value || actualValue.includes(value);
  } catch {
    return false;
  }
}

// ------------------------------
// CONSTRAINT SATISFACTION: Detect blockers
// ------------------------------
async function detectSubmissionBlockers(page, form, submitButton) {
  const blockers = {
    submitDisabled: false,
    requiredFieldsEmpty: [],
    requiredCheckboxesUnchecked: [],
    requiredRadiosUnselected: [],
    validationErrors: [],
    captchaDetected: false,
    captchaType: null
  };
  
  // Check submit button
  try {
    blockers.submitDisabled = await submitButton.isDisabled().catch(() => false);
  } catch {}
  
  // DETECT CAPTCHA (reCAPTCHA, hCaptcha, Turnstile)
  try {
    // reCAPTCHA v2
    if (await page.locator('.g-recaptcha, iframe[src*="recaptcha"]').count()) {
      blockers.captchaDetected = true;
      blockers.captchaType = 'reCAPTCHA v2';
    }
    // reCAPTCHA v3 (invisible)
    else if (await page.evaluate(() => typeof grecaptcha !== 'undefined').catch(() => false)) {
      blockers.captchaDetected = true;
      blockers.captchaType = 'reCAPTCHA v3 (invisible)';
    }
    // hCaptcha
    else if (await page.locator('.h-captcha, iframe[src*="hcaptcha"]').count()) {
      blockers.captchaDetected = true;
      blockers.captchaType = 'hCaptcha';
    }
    // Cloudflare Turnstile
    else if (await page.locator('[class*="cf-turnstile"], iframe[src*="turnstile"]').count()) {
      blockers.captchaDetected = true;
      blockers.captchaType = 'Cloudflare Turnstile';
    }
  } catch {}
  
  // Find required empty fields
  try {
    const requiredFields = await form.locator('input[required], textarea[required], select[required]').all();
    for (const field of requiredFields) {
      const value = await field.inputValue().catch(() => '');
      const isVisible = await field.isVisible().catch(() => false);
      if (isVisible && !value) {
        const name = await field.getAttribute('name').catch(() => '');
        const id = await field.getAttribute('id').catch(() => '');
        const type = await field.getAttribute('type').catch(() => '');
        const placeholder = await field.getAttribute('placeholder').catch(() => '');
        blockers.requiredFieldsEmpty.push({ 
          name: name || id || 'unknown', 
          type,
          placeholder: placeholder || ''
        });
      }
    }
  } catch {}
  
  // Find required unchecked checkboxes
  try {
    const requiredCheckboxes = await form.locator('input[type="checkbox"][required]').all();
    for (const checkbox of requiredCheckboxes) {
      const isChecked = await checkbox.isChecked().catch(() => false);
      const isVisible = await checkbox.isVisible().catch(() => false);
      if (isVisible && !isChecked) {
        const name = await checkbox.getAttribute('name').catch(() => '');
        const id = await checkbox.getAttribute('id').catch(() => '');
        const label = await checkbox.evaluate((el) => {
          const labelEl = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
          return labelEl ? labelEl.textContent.trim().substring(0, 100) : '';
        }).catch(() => '');
        blockers.requiredCheckboxesUnchecked.push({
          name: name || id || 'unknown',
          label
        });
      }
    }
  } catch {}
  
  // Find required radio groups with no selection
  try {
    const radioGroups = new Map();
    const radios = await form.locator('input[type="radio"][required]').all();
    
    for (const radio of radios) {
      const name = await radio.getAttribute('name').catch(() => '');
      if (!name) continue;
      
      if (!radioGroups.has(name)) {
        radioGroups.set(name, { radios: [], hasSelection: false, label: '' });
      }
      
      radioGroups.get(name).radios.push(radio);
      const isChecked = await radio.isChecked().catch(() => false);
      if (isChecked) {
        radioGroups.get(name).hasSelection = true;
      }
      
      // Get label for the group (from first radio)
      if (!radioGroups.get(name).label) {
        const label = await radio.evaluate((el) => {
          const labelEl = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
          return labelEl ? labelEl.textContent.trim().substring(0, 100) : '';
        }).catch(() => '');
        radioGroups.get(name).label = label;
      }
    }
    
    for (const [name, group] of radioGroups) {
      if (!group.hasSelection && group.radios.length > 0) {
        const isVisible = await group.radios[0].isVisible().catch(() => false);
        if (isVisible) {
          blockers.requiredRadiosUnselected.push({
            name,
            label: group.label,
            optionCount: group.radios.length
          });
        }
      }
    }
  } catch {}
  
  // Find validation errors
  try {
    const errorSelectors = [
      '[role="alert"]',
      '.error:visible',
      '.invalid-feedback:visible',
      '.field-error:visible',
      '.validation-error:visible',
      '.wpcf7-not-valid-tip:visible',
      '.parsley-errors-list:visible',
      '.help-block.error:visible'
    ];
    
    for (const selector of errorSelectors) {
      const errors = await page.locator(selector).all();
      for (const error of errors) {
        const text = await error.textContent().catch(() => '');
        if (text && text.trim()) {
          blockers.validationErrors.push(text.trim());
        }
      }
    }
  } catch {}
  
  return blockers;
}

// ------------------------------
// CONSTRAINT SATISFACTION: Fix blockers
// ------------------------------
async function fixSubmissionBlockers(page, form, blockers) {
  let fixed = false;
  
  // Fix required checkboxes
  for (const checkbox of blockers.requiredCheckboxesUnchecked) {
    try {
      const checkboxName = typeof checkbox === 'string' ? checkbox : checkbox.name;
      const checkboxEl = form.locator(`input[type="checkbox"][name="${checkboxName}"], input[type="checkbox"][id="${checkboxName}"]`).first();
      if (await checkboxEl.count()) {
        await checkboxEl.check({ timeout: 1000 }).catch(() => null);
        await safeWait(page, 100);
        fixed = true;
      }
    } catch {}
  }
  
  // Fix required radio buttons (select first option)
  for (const radio of blockers.requiredRadiosUnselected) {
    try {
      const radioName = typeof radio === 'string' ? radio : radio.name;
      const firstRadio = form.locator(`input[type="radio"][name="${radioName}"]`).first();
      if (await firstRadio.count()) {
        await firstRadio.check({ timeout: 1000 }).catch(() => null);
        await safeWait(page, 100);
        fixed = true;
      }
    } catch {}
  }
  
  // Try to fill empty required fields
  for (const field of blockers.requiredFieldsEmpty) {
    try {
      const fieldEl = form.locator(`input[name="${field.name}"], input[id="${field.name}"], select[name="${field.name}"], select[id="${field.name}"], textarea[name="${field.name}"], textarea[id="${field.name}"]`).first();
      if (await fieldEl.count()) {
        const tag = await fieldEl.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        const type = field.type?.toLowerCase() || '';
        
        if (tag === 'select') {
          // Select first valid option
          await fieldEl.evaluate((sel) => {
            const options = Array.from(sel.querySelectorAll('option'));
            const candidate = options.find((o) => {
              const v = (o.getAttribute('value') || '').trim();
              const t = (o.textContent || '').trim().toLowerCase();
              if (!v) return false;
              if (t.includes('select') || t.includes('choose')) return false;
              return true;
            });
            if (candidate) {
              sel.value = candidate.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }).catch(() => null);
          fixed = true;
        } else if (type === 'email') {
          await fillFormFieldSmart(fieldEl, TEST_VALUES.email, 'email');
          fixed = true;
        } else if (type === 'tel') {
          await fillFormFieldSmart(fieldEl, TEST_VALUES.phone, 'phone');
          fixed = true;
        } else if (tag === 'textarea') {
          await fillFormFieldSmart(fieldEl, TEST_VALUES.message, 'textarea');
          fixed = true;
        } else {
          await fillFormFieldSmart(fieldEl, TEST_VALUES.fullName, 'text');
          fixed = true;
        }
      }
    } catch {}
  }
  
  return fixed;
}

// ------------------------------
// Form fill + submit WITH CONSTRAINT SATISFACTION
// ------------------------------
async function testBestFirstPartyForm(page, beacons, pageUrl, formMeta) {
  if (!formMeta || !formMeta.best_form) {
    return { status: "NOT_TESTED", reason: "no_first_party_form_found" };
  }
  if (formMeta.best_form.third_party_by_action) {
    return { status: "NOT_TESTED", reason: "third_party_form_action" };
  }

  const formIndex = formMeta.best_form.index;
  const form = page.locator("form").nth(formIndex);

  try {
    if (!(await form.count())) {
      return { status: "NOT_TESTED", reason: "form_locator_not_found" };
    }
    
    await form.scrollIntoViewIfNeeded().catch(() => null);
    await safeWait(page, 400);

    const fields = form.locator("input, textarea, select");
    const fieldCount = await fields.count();
    if (fieldCount < 2) {
      return { status: "NOT_TESTED", reason: "form_too_small" };
    }

    // ============================================
    // PHASE 1: FILL ALL FIELDS
    // ============================================
    for (let i = 0; i < fieldCount; i++) {
      const el = fields.nth(i);
      try {
        if (!(await el.isVisible({ timeout: 300 }))) continue;
        if (!(await el.isEnabled({ timeout: 300 }))) continue;

        const tag = await el.evaluate((n) => n.tagName.toLowerCase());
        const type = (await el.getAttribute("type")) || "";
        const name = (await el.getAttribute("name")) || "";
        const id = (await el.getAttribute("id")) || "";
        const placeholder = (await el.getAttribute("placeholder")) || "";
        const ariaLabel = (await el.getAttribute("aria-label")) || "";

        const hay = `${type} ${name} ${id} ${placeholder} ${ariaLabel}`.toLowerCase();
        if (type.toLowerCase() === "hidden") continue;

        if (tag === "select") {
          const did = await el.evaluate((sel) => {
            const options = Array.from(sel.querySelectorAll("option"));
            const candidate = options.find((o) => {
              const v = (o.getAttribute("value") || "").trim();
              const t = (o.textContent || "").trim().toLowerCase();
              if (!v) return false;
              if (t.includes("select") || t.includes("choose")) return false;
              return true;
            });
            if (!candidate) return false;
            sel.value = candidate.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          });
          if (did) await safeWait(page, 120);
        } else if (type.toLowerCase() === "checkbox") {
          const shouldTick = /consent|agree|privacy|terms|gdpr|policy/.test(hay);
          if (shouldTick) {
            await el.check({ timeout: 1000 }).catch(() => null);
            await safeWait(page, 120);
          }
        } else if (tag === "textarea" || /message|enquir|inquir|comment/.test(hay)) {
          await fillFormFieldSmart(el, TEST_VALUES.message, 'textarea');
        } else if (type.toLowerCase() === "email" || hay.includes("email")) {
          await fillFormFieldSmart(el, TEST_VALUES.email, 'email');
        } else if (type.toLowerCase() === "tel" || hay.includes("phone") || hay.includes("tel")) {
          await fillFormFieldSmart(el, TEST_VALUES.phone, 'phone');
        } else if (/first/.test(hay) && /name/.test(hay)) {
          await fillFormFieldSmart(el, TEST_VALUES.firstName, 'text');
        } else if (/last/.test(hay) && /name/.test(hay)) {
          await fillFormFieldSmart(el, TEST_VALUES.lastName, 'text');
        } else if (/name/.test(hay)) {
          await fillFormFieldSmart(el, TEST_VALUES.fullName, 'text');
        } else if (!type || type.toLowerCase() === "text") {
          await fillFormFieldSmart(el, TEST_VALUES.fullName, 'text');
        }
      } catch {}
    }

    // Wait for JS validation
    await safeWait(page, 1500);

    // ============================================
    // PHASE 2: FIND SUBMIT BUTTON
    // ============================================
    const submitCandidates = [
      "button[type='submit']",
      "input[type='submit']",
      "button:has-text('Send')",
      "button:has-text('Submit')",
      "button:has-text('Enquire')",
      "button:has-text('Enquiry')",
      "button:has-text('Request')",
      "button:has-text('Get Quote')",
      "button:has-text('Book')",
      "button:has-text('Contact')"
    ];

    let submit = null;
    for (const sel of submitCandidates) {
      const loc = form.locator(sel).first();
      try {
        if (await loc.count()) {
          if (await loc.isVisible({ timeout: 600 })) {
            submit = loc;
            break;
          }
        }
      } catch {}
    }
    
    if (!submit) {
      return { status: "NOT_TESTED", reason: "no_submit_button_found" };
    }

    // ============================================
    // PHASE 3: CONSTRAINT SATISFACTION LOOP
    // ============================================
    const MAX_FIX_ATTEMPTS = 3;
    let fixAttempts = 0;
    let isSubmittable = false;
    let finalBlockers = null;
    
    while (fixAttempts < MAX_FIX_ATTEMPTS) {
      const blockers = await detectSubmissionBlockers(page, form, submit);
      finalBlockers = blockers; // Keep track of last blockers detected
      
      // If submit enabled and no critical blockers, we're good
      if (!blockers.submitDisabled && 
          blockers.requiredFieldsEmpty.length === 0 &&
          blockers.requiredCheckboxesUnchecked.length === 0 &&
          blockers.requiredRadiosUnselected.length === 0 &&
          !blockers.captchaDetected) {
        isSubmittable = true;
        break;
      }
      
      // Try to fix blockers
      const fixed = await fixSubmissionBlockers(page, form, blockers);
      
      if (!fixed) break; // Can't fix anything
      
      await safeWait(page, 1200);
      fixAttempts++;
    }

    // ============================================
    // PHASE 4: ONLY SUBMIT IF SUBMITTABLE
    // ============================================
    if (!isSubmittable) {
      // Build detailed reason message
      const blockerDetails = [];
      
      if (finalBlockers.captchaDetected) {
        blockerDetails.push(`CAPTCHA detected (${finalBlockers.captchaType}) - cannot be bypassed by automation`);
      }
      
      if (finalBlockers.submitDisabled) {
        blockerDetails.push('Submit button is disabled');
      }
      
      if (finalBlockers.requiredFieldsEmpty.length > 0) {
        blockerDetails.push(`Required fields not filled (${finalBlockers.requiredFieldsEmpty.length}): ${finalBlockers.requiredFieldsEmpty.map(f => `${f.name} (${f.type}${f.placeholder ? ': ' + f.placeholder : ''})`).join(', ')}`);
      }
      
      if (finalBlockers.requiredCheckboxesUnchecked.length > 0) {
        blockerDetails.push(`Required checkboxes not checked (${finalBlockers.requiredCheckboxesUnchecked.length}): ${finalBlockers.requiredCheckboxesUnchecked.map(c => `${c.name}${c.label ? ' - ' + c.label : ''}`).join(', ')}`);
      }
      
      if (finalBlockers.requiredRadiosUnselected.length > 0) {
        blockerDetails.push(`Required radio groups not selected (${finalBlockers.requiredRadiosUnselected.length}): ${finalBlockers.requiredRadiosUnselected.map(r => `${r.name}${r.label ? ' - ' + r.label : ''} (${r.optionCount} options)`).join(', ')}`);
      }
      
      if (finalBlockers.validationErrors.length > 0) {
        blockerDetails.push(`Validation errors: ${finalBlockers.validationErrors.join('; ')}`);
      }
      
      const detailedReason = blockerDetails.length > 0 
        ? blockerDetails.join(' | ') 
        : 'Form constraints not satisfied after 3 attempts';
      
      return { 
        status: "NOT_TESTED", 
        reason: "form_not_submittable_constraints_not_satisfied",
        detailed_reason: detailedReason,
        blockers: finalBlockers,
        constraint_attempts: fixAttempts
      };
    }

    const beforeBeaconIdx = beacons.length;
    const beforeUrl = page.url();

    await submit.scrollIntoViewIfNeeded().catch(() => null);
    await safeWait(page, 300);

    let navigated = false;
    
    // Multi-method submission
    try {
      await Promise.race([
        page.waitForNavigation({ timeout: 9000 }).then(() => { navigated = true; }),
        submit.click({ timeout: 3000 })
      ]);
    } catch {
      try {
        await submit.click({ force: true, timeout: 3000 });
      } catch {
        try {
          await submit.evaluate((el) => el.click());
        } catch {
          try {
            await form.evaluate((f) => {
              if (f.submit && typeof f.submit === 'function') f.submit();
              else if (f.requestSubmit) f.requestSubmit();
            });
          } catch {
            try {
              const textField = form.locator('input[type="text"], input[type="email"], input[type="tel"]').first();
              if (await textField.count()) {
                await textField.press('Enter');
              }
            } catch {}
          }
        }
      }
    }

    await safeWait(page, FORM_SUBMIT_WAIT_MS);

    const afterUrl = page.url();
    const urlChanged = afterUrl !== beforeUrl;

    const successSignal = await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("thank you") ||
        text.includes("thanks for") ||
        text.includes("message has been sent") ||
        text.includes("we will be in touch") ||
        text.includes("successfully sent") ||
        text.includes("submission successful") ||
        text.includes("form submitted")
      );
    });

    const submittedSuccessfully = urlChanged || navigated || successSignal;

    const newGa4 = beacons.slice(beforeBeaconIdx).filter((b) => b.type === "GA4");
    
    const meaningfulEvents = newGa4.filter((b) => {
      const eventName = (b.event_name || "").toLowerCase();
      if (eventName === "page_view" && urlChanged) return true;
      return !GENERIC_EVENTS.some(generic => eventName === generic);
    });

    if (meaningfulEvents.length > 0) {
      return {
        status: "PASS",
        reason: null,
        submittedSuccessfully,
        submit_evidence: { urlChanged, successSignal, navigated, beforeUrl, afterUrl },
        ga4_events: uniq(meaningfulEvents.map((b) => b.event_name).filter(Boolean)),
        evidence_urls: meaningfulEvents.slice(0, 5).map((b) => b.url)
      };
    }

    if (submittedSuccessfully) {
      const genericEventsSeen = uniq(newGa4.map((b) => b.event_name).filter(Boolean));
      return {
        status: "FAIL",
        reason: "submitted_but_no_meaningful_ga4_event",
        submittedSuccessfully,
        submit_evidence: { urlChanged, successSignal, navigated, beforeUrl, afterUrl },
        ga4_events: genericEventsSeen,
        note: "Form submitted successfully but only saw generic events. No conversion event fired."
      };
    }

    const validationText = await page
      .evaluate(() => {
        const els = Array.from(
          document.querySelectorAll(
            "[role='alert'], .error, .wpcf7-not-valid-tip, .wpcf7-response-output, .error-message, .validation-error"
          )
        );
        return els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 3).join(" | ");
      })
      .catch(() => "");

    const pageContent = await page.evaluate(() => {
      return {
        title: document.title,
        bodyText: document.body.innerText.slice(0, 500),
        url: window.location.href
      };
    }).catch(() => null);

    return {
      status: "NOT_TESTED",
      reason: validationText 
        ? `validation_blocked: ${validationText}` 
        : "submit_not_confirmed",
      ga4_events: uniq(newGa4.map((b) => b.event_name).filter(Boolean)),
      debug_page_state: pageContent
    };
  } catch (e) {
    return { 
      status: "NOT_TESTED", 
      reason: `form_test_error: ${e.message}` 
    };
  }
}

// ------------------------------
// NEW: Main runner with GUARANTEED cleanup
// ------------------------------
async function trackingHealthCheckSiteInternal(url) {
  const startTs = nowIso();
  const targetUrl = normaliseUrl(url);

  const results = {
    ok: true,
    script_version: SCRIPT_VERSION,
    url: targetUrl,
    timestamp: startTs,

    pages_visited: [],
    cookie_consent: { banner_found: false, accepted: false, details: null },

    tracking: {
      tags_found: { gtm: [], ga4: [], ignored_aw: [] },
      runtime: { gtm_loaded: false, ga_runtime_present: false },
      beacon_counts: { gtm: 0, ga4: 0 },
      has_tracking: false
    },

    ctas: {
      phones: { found: 0, tested: 0, items: [] },
      emails: { found: 0, tested: 0, items: [] }
    },

    forms: {
      third_party_iframes_found: [],
      pages: []
    },

    evidence: { network_beacons: [] },
    issues: [],
    site_status: "ERROR"
  };

  const beacons = [];
  let browser = null;
  let context = null;
  let page = null;

  try {
    logInfo(`🔍 [${SCRIPT_VERSION}] Starting tracking health check`, { url: targetUrl });

    browser = await chromium.launch({
      headless: HEADLESS,
      timeout: 90000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    context = await browser.newContext();
    page = await context.newPage();

    // Request listener with automatic cleanup
    const requestHandler = (request) => {
      const reqUrl = request.url();
      const type = classifyGaBeacon(reqUrl);

      const lower = reqUrl.toLowerCase();
      const relevant =
        lower.includes("google-analytics.com") ||
        lower.includes("googletagmanager.com") ||
        lower.includes("analytics.google.com") ||
        lower.includes("/g/collect") ||
        lower.includes("/r/collect") ||
        lower.includes("gtm.js") ||
        lower.includes("gtag/js");

      if (!relevant) return;

      let eventName = null;
      if (type === "GA4") {
        eventName = parseEventNameFromUrl(reqUrl);
        if (!eventName) {
          const pd = request.postData();
          eventName = parseEventNameFromPostData(pd);
        }
      }

      beacons.push({
        url: reqUrl,
        timestamp: nowIso(),
        type,
        event_name: eventName
      });
    };

    page.on("request", requestHandler);

    const load = await safeGoto(page, targetUrl);
    if (!load.ok) throw new Error(load.error);
    results.pages_visited.push(page.url());

    await safeWait(page, INIT_WAIT_MS);

    results.cookie_consent = await handleCookieConsent(page);
    await safeWait(page, 1200);

    const tracking = await detectTrackingSetup(page, beacons);
    results.tracking.tags_found = tracking.tags_found;
    results.tracking.runtime = tracking.runtime;
    results.tracking.beacon_counts = tracking.beacon_counts;
    results.tracking.has_tracking = tracking.hasAnyTracking;

    if (!results.tracking.has_tracking) {
      results.site_status = "BUILD_REQUIRED";
      results.issues.push("No GTM/GA4 detected (build required)");
      results.evidence.network_beacons = beacons;
      return results;
    }

    const discovered = await discoverCandidatePages(page, targetUrl);
    const pagesToVisit = [targetUrl, ...discovered].slice(0, MAX_PAGES_TO_VISIT);

    const allPhonesNorm = new Set();
    const allEmailsNorm = new Set();
    const testedPhonesNorm = new Set();
    const testedEmailsNorm = new Set();

    for (let i = 0; i < pagesToVisit.length; i++) {
      const pUrl = pagesToVisit[i];

      const r = await safeGoto(page, pUrl);
      if (!r.ok) {
        results.issues.push(`Could not load page: ${pUrl}`);
        continue;
      }

      const actualUrl = page.url();
      if (!results.pages_visited.includes(actualUrl)) results.pages_visited.push(actualUrl);

      await safeWait(page, 1200);

      const ctas = await scanCTAsOnPage(page);

      for (const rawTel of ctas.phones || []) {
        const norm = normaliseTelHref(rawTel);
        if (!norm) continue;
        allPhonesNorm.add(norm);

        const canTestMore = results.ctas.phones.tested < MAX_PHONE_TESTS;
        const firstSeen = !testedPhonesNorm.has(norm);

        if (firstSeen && canTestMore) {
          testedPhonesNorm.add(norm);
          const item = await testLinkCTA(page, beacons, rawTel, "phone");
          results.ctas.phones.tested++;
          results.ctas.phones.items.push({
            href: rawTel,
            href_normalised: norm,
            page_url: actualUrl,
            status: item.status,
            reason: item.reason || null,
            ga4_events: item.ga4_events || [],
            beacons_delta: item.beacons_delta || 0,
            evidence_urls: item.evidence_urls || [],
            generic_events_seen: item.generic_events_seen || []
          });
        }
      }

      for (const rawMail of ctas.emails || []) {
        const norm = normaliseMailtoHref(rawMail);
        if (!norm) continue;
        allEmailsNorm.add(norm);

        const canTestMore = results.ctas.emails.tested < MAX_EMAIL_TESTS;
        const firstSeen = !testedEmailsNorm.has(norm);

        if (firstSeen && canTestMore) {
          testedEmailsNorm.add(norm);
          const item = await testLinkCTA(page, beacons, rawMail, "email");
          results.ctas.emails.tested++;
          results.ctas.emails.items.push({
            href: rawMail,
            href_normalised: norm,
            page_url: actualUrl,
            status: item.status,
            reason: item.reason || null,
            ga4_events: item.ga4_events || [],
            beacons_delta: item.beacons_delta || 0,
            evidence_urls: item.evidence_urls || [],
            generic_events_seen: item.generic_events_seen || []
          });
        }
      }

      const formMeta = await pickBestFirstPartyFormOnPage(page, actualUrl);

      if (formMeta.third_party_iframes?.length) {
        results.forms.third_party_iframes_found.push(
          ...formMeta.third_party_iframes.map((src) => ({ page_url: actualUrl, iframe_src: src }))
        );
      }

      const formTest = await testBestFirstPartyForm(page, beacons, actualUrl, formMeta);
      results.forms.pages.push({
        page_url: actualUrl,
        best_form_meta: formMeta.best_form
          ? {
              index: formMeta.best_form.index,
              score: formMeta.best_form.score,
              inputCount: formMeta.best_form.inputCount,
              hasEmail: formMeta.best_form.hasEmail,
              hasTextarea: formMeta.best_form.hasTextarea,
              submitText: formMeta.best_form.submitText,
              third_party_by_action: formMeta.best_form.third_party_by_action
            }
          : null,
        status: formTest.status,
        reason: formTest.reason || null,
        detailed_reason: formTest.detailed_reason || null,
        blockers: formTest.blockers || null,
        constraint_attempts: formTest.constraint_attempts || 0,
        submittedSuccessfully: formTest.submittedSuccessfully ?? null,
        submit_evidence: formTest.submit_evidence ?? null,
        ga4_events: formTest.ga4_events ?? [],
        evidence_urls: formTest.evidence_urls ?? [],
        note: formTest.note ?? null,
        debug_page_state: formTest.debug_page_state ?? null
      });

      if (formTest.status === "PASS" || formTest.status === "FAIL") {
        logInfo(`✅ Got definitive form result (${formTest.status}) on page ${i+1}/${pagesToVisit.length}, stopping crawl`);
        break;
      }

      await safeWait(page, 400);
    }

    results.ctas.phones.found = allPhonesNorm.size;
    results.ctas.emails.found = allEmailsNorm.size;

    const anyCtaPass =
      results.ctas.phones.items.some((x) => x.status === "PASS") ||
      results.ctas.emails.items.some((x) => x.status === "PASS");

    const formPass = results.forms.pages.some((x) => x.status === "PASS");
    const formFail = results.forms.pages.some((x) => x.status === "FAIL");

    const ctaFail =
      results.ctas.phones.items.some((x) => x.status === "FAIL") ||
      results.ctas.emails.items.some((x) => x.status === "FAIL");

    const anyPass = anyCtaPass || formPass;
    const anyFail = formFail || ctaFail;

    const allTestedPassed = anyPass && !anyFail;
    const somePassSomeFail = anyPass && anyFail;
    const trackingSetupButBroken = anyFail && !anyPass;

    if (allTestedPassed) results.site_status = "HEALTHY";
    else if (somePassSomeFail) results.site_status = "PARTIAL";
    else if (trackingSetupButBroken) results.site_status = "FAILED";
    else results.site_status = "NOT_FULLY_TESTED";

    if (formFail) results.issues.push("At least one form submitted but no meaningful GA4 event fired");
    if (ctaFail) results.issues.push("At least one CTA click produced no meaningful GA4 beacon");

    results.evidence.network_beacons = beacons;

    logInfo("✅ Health check complete", {
      url: targetUrl,
      site_status: results.site_status,
      pages_visited: results.pages_visited.length,
      forms_tested: results.forms.pages.length,
      phone_tested: results.ctas.phones.tested,
      email_tested: results.ctas.emails.tested
    });

    return results;
  } catch (error) {
    logInfo("❌ Fatal error in health check", { url: targetUrl, error: error.message });
    results.ok = false;
    results.site_status = "ERROR";
    results.issues.push(`Error: ${error.message}`);
    results.evidence.network_beacons = beacons;
    return results;
  } finally {
    // GUARANTEED CLEANUP - Multiple attempts
    const cleanupStart = Date.now();
    logDebug("Starting cleanup", { url: targetUrl });

    // Remove request listener
    if (page) {
      try {
        page.removeAllListeners("request");
      } catch (e) {
        logDebug("Failed to remove request listeners", { error: e.message });
      }
    }

    // Close page
    if (page) {
      try {
        await page.close({ timeout: 5000 }).catch(() => null);
        logDebug("Page closed");
      } catch (e) {
        logDebug("Failed to close page", { error: e.message });
      }
    }

    // Close context
    if (context) {
      try {
        await context.close({ timeout: 5000 }).catch(() => null);
        logDebug("Context closed");
      } catch (e) {
        logDebug("Failed to close context", { error: e.message });
      }
    }

    // Close browser
    if (browser) {
      try {
        await browser.close({ timeout: 10000 }).catch(() => null);
        logDebug("Browser closed");
      } catch (e) {
        logDebug("Failed to close browser gracefully, forcing...", { error: e.message });
        try {
          // Force kill browser process
          if (browser.process()) {
            browser.process().kill('SIGKILL');
          }
        } catch (killErr) {
          logDebug("Failed to force kill browser", { error: killErr.message });
        }
      }
    }

    const cleanupDuration = Date.now() - cleanupStart;
    logDebug("Cleanup completed", { url: targetUrl, duration_ms: cleanupDuration });
  }
}

// ------------------------------
// NEW: Public API with timeout + concurrency
// ------------------------------
async function trackingHealthCheckSite(url) {
  // Acquire concurrency slot
  await acquireCheckSlot();
  
  try {
    // Wrap with global timeout
    const result = await withTimeout(
      trackingHealthCheckSiteInternal(url),
      GLOBAL_TIMEOUT_MS,
      `Health check timed out after ${GLOBAL_TIMEOUT_MS}ms`
    );
    
    return result;
  } catch (error) {
    // Timeout or other error
    logInfo("❌ Health check failed or timed out", { url, error: error.message });
    
    return {
      ok: false,
      script_version: SCRIPT_VERSION,
      url: normaliseUrl(url),
      timestamp: nowIso(),
      pages_visited: [],
      cookie_consent: { banner_found: false, accepted: false, details: null },
      tracking: {
        tags_found: { gtm: [], ga4: [], ignored_aw: [] },
        runtime: { gtm_loaded: false, ga_runtime_present: false },
        beacon_counts: { gtm: 0, ga4: 0 },
        has_tracking: false
      },
      ctas: {
        phones: { found: 0, tested: 0, items: [] },
        emails: { found: 0, tested: 0, items: [] }
      },
      forms: {
        third_party_iframes_found: [],
        pages: []
      },
      evidence: { network_beacons: [] },
      issues: [`Global timeout or error: ${error.message}`],
      site_status: "ERROR"
    };
  } finally {
    // Always release concurrency slot
    releaseCheckSlot();
  }
}

module.exports = {
  trackingHealthCheckSite
};
