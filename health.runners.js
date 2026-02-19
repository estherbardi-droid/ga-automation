// /health-check-v6.js
// INTELLIGENT TRACKING HEALTH CHECK - Complete Rewrite
// Features: Smart form detection, constraint satisfaction, third-party fallback, detailed reporting
const SCRIPT_VERSION = "2026-02-12T18:00:00Z-V6-INTELLIGENT";

const { chromium } = require("playwright");
const fs = require("fs").promises;
const path = require("path");

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
// Configuration
// ------------------------------
const MAX_PAGES_TO_VISIT = Number(process.env.HEALTH_MAX_PAGES || 3);
const MAX_PHONE_TESTS = Number(process.env.HEALTH_MAX_PHONE || 10);
const MAX_EMAIL_TESTS = Number(process.env.HEALTH_MAX_EMAIL || 10);
const NAV_TIMEOUT_MS = Number(process.env.HEALTH_NAV_TIMEOUT_MS || 45000);
const INIT_WAIT_MS = Number(process.env.HEALTH_INIT_WAIT_MS || 3500);
const HEADLESS = false;
const POST_ACTION_POLL_MS = Number(process.env.HEALTH_POST_ACTION_POLL_MS || 8000);
const FORM_SUBMIT_WAIT_MS = Number(process.env.HEALTH_FORM_WAIT_MS || 15000);
const GLOBAL_TIMEOUT_MS = Number(process.env.HEALTH_GLOBAL_TIMEOUT_MS || 300000);
const MAX_CONCURRENT_CHECKS = Number(process.env.HEALTH_MAX_CONCURRENT || 2);

// Test identity
const TEST_VALUES = {
  firstName: "Test",
  lastName: "User",
  fullName: "Test User",
  email: process.env.HEALTH_TEST_EMAIL || "test+healthcheck@example.com",
  phone: process.env.HEALTH_TEST_PHONE || "07123456789",
  message: process.env.HEALTH_TEST_MESSAGE || "Tracking health check test submission. Please ignore.",
  company: "Test Company Ltd",
  postcode: "SW1A 1AA",
  city: "London",
  address: "123 Test Street",
  subject: "General Enquiry",
};

// Generic events that don't count as conversions
const GENERIC_EVENTS = [
  "page_view",
  "user_engagement",
  "scroll",
  "session_start",
  "first_visit",
  "form_start",
];

// Contact page keywords
const CONTACT_PAGE_KEYWORDS = [
  "contact",
  "get-in-touch",
  "getintouch",
  "enquire",
  "enquiry",
  "inquire",
  "inquiry",
  "quote",
  "estimate",
  "book",
  "booking",
  "appointment",
  "consultation",
  "request",
];

const COMMON_CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/contact-us/",
  "/contactus",
  "/get-in-touch",
  "/get-in-touch/",
  "/enquiry",
  "/enquire",
  "/book",
  "/booking",
];

// Third-party form providers
const THIRD_PARTY_HINTS = [
  "hubspot",
  "hsforms",
  "jotform",
  "typeform",
  "google.com/forms",
  "forms.gle",
  "calendly",
  "marketo",
  "pardot",
  "salesforce",
  "formstack",
  "wufoo",
  "cognitoforms",
];

// Concurrency control
let activeChecks = 0;
const checkQueue = [];

// ------------------------------
// Utility Functions
// ------------------------------
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
  return [...new Set((arr || []).filter(Boolean))];
}

function containsAny(str, needles) {
  const s = (str || "").toLowerCase();
  return needles.some((n) => s.includes(n));
}

function classifyGaBeacon(reqUrl) {
  const u = (reqUrl || "").toLowerCase();
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
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  } catch {}
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return { ok: true, mode: "domcontentloaded" };
  } catch (e1) {
    logDebug("⚠️ goto domcontentloaded failed, retry commit", {
      url,
      err: e1.message,
    });
    try {
      await page.goto(url, {
        waitUntil: "commit",
        timeout: Math.min(30000, NAV_TIMEOUT_MS),
      });
      return { ok: true, mode: "commit" };
    } catch (e2) {
      return { ok: false, error: `Could not load page: ${e2.message}` };
    }
  }
}

// ------------------------------
// Concurrency Management
// ------------------------------
async function acquireCheckSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    logDebug("Health check slot acquired", {
      activeChecks,
      maxConcurrent: MAX_CONCURRENT_CHECKS,
    });
    return;
  }

  return new Promise((resolve) => {
    checkQueue.push(resolve);
    logDebug("Health check queued", { queueLength: checkQueue.length });
  });
}

function releaseCheckSlot() {
  activeChecks--;
  logDebug("Health check slot released", {
    activeChecks,
    queueLength: checkQueue.length,
  });

  if (checkQueue.length > 0) {
    const next = checkQueue.shift();
    activeChecks++;
    next();
  }
}

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
// Human Behavior Simulation
// ------------------------------
async function simulateHumanBrowsing(page) {
  try {
    await page.evaluate(() => {
      window.scrollBy(0, Math.random() * 300);
    });
    await safeWait(null, randomDelay(500, 1000));

    const viewport = page.viewportSize();
    if (viewport) {
      await page.mouse.move(
        Math.random() * viewport.width,
        Math.random() * viewport.height,
        { steps: 10 }
      );
    }
    await safeWait(null, randomDelay(300, 700));
  } catch {}
}

// ------------------------------
// Cookie Consent
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
    "[aria-label*='accept' i]",
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
// Menu Expansion
// ------------------------------
async function tryExpandMenus(page) {
  const menuSelectors = [
    "button[aria-label*='menu' i]",
    "button[aria-label*='navigation' i]",
    ".hamburger",
    ".menu-toggle",
    "#menu-toggle",
    "[class*='mobile-menu-toggle']",
    "[class*='nav-toggle']",
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
// Tracking Detection
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
      gaRuntimePresent,
    };
  });

  const beaconCounts = {
    gtm: beacons.filter((b) => b.type === "GTM").length,
    ga4: beacons.filter((b) => b.type === "GA4").length,
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
    hasAnyTracking,
  };
}

// ------------------------------
// Page Discovery
// ------------------------------
async function discoverCandidatePages(page, baseUrl) {
  const origin = safeUrlObj(baseUrl)?.origin || null;

  await tryExpandMenus(page);
  await safeWait(page, 500);

  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href]")).map((a) => ({
      href: a.getAttribute("href") || "",
      text: (a.textContent || "").trim().slice(0, 120),
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
      const score = CONTACT_PAGE_KEYWORDS.reduce(
        (acc, k) => (hay.includes(k) ? acc + 1 : acc),
        0
      );
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
// CTA Scanning
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
// CTA Testing
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
      return { status: "NOT_TESTED", reason: "CTA not found on page", beacons_delta: 0 };
    }

    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => null);
      await safeWait(page, 300);

      try {
        await loc.click({ timeout: 3000 });
      } catch (normalClickErr) {
        logDebug("Normal click failed, trying force click", {
          error: normalClickErr.message,
        });
        try {
          await loc.click({ force: true, timeout: 3000 });
        } catch (forceClickErr) {
          logDebug("Force click failed, trying JS click", {
            error: forceClickErr.message,
          });
          await loc.evaluate((el) => el.click()).catch(() => null);
        }
      }
    } catch (scrollErr) {
      return {
        status: "NOT_TESTED",
        reason: `Element interaction failed: ${scrollErr.message}`,
        beacons_delta: 0,
      };
    }

    const start = Date.now();
    while (Date.now() - start < POST_ACTION_POLL_MS) {
      await safeWait(page, 800);

      const newGa4 = beacons.slice(before).filter((b) => b.type === "GA4");
      const meaningfulEvents = newGa4.filter((b) => {
        const eventName = (b.event_name || "").toLowerCase();
        return !GENERIC_EVENTS.some((generic) => eventName === generic);
      });

      if (meaningfulEvents.length) {
        return {
          status: "PASS",
          reason: null,
          beacons_delta: beacons.length - before,
          ga4_events: uniq(meaningfulEvents.map((b) => b.event_name).filter(Boolean)),
          evidence_urls: meaningfulEvents.slice(0, 5).map((b) => b.url),
        };
      }
    }

    const allNewGa4 = beacons.slice(before).filter((b) => b.type === "GA4");
    const genericEventsSeen = uniq(allNewGa4.map((b) => b.event_name).filter(Boolean));

    return {
      status: "FAIL",
      reason: genericEventsSeen.length
        ? "Only generic events fired (no conversion event)"
        : "No GA4 beacon fired after click",
      beacons_delta: beacons.length - before,
      generic_events_seen: genericEventsSeen,
    };
  } catch (e) {
    return {
      status: "NOT_TESTED",
      reason: `CTA test error: ${e.message}`,
      beacons_delta: 0,
    };
  }
}

// ------------------------------
// INTELLIGENT FORM DETECTION
// ------------------------------
async function discoverAllFormsOnPage(page, pageUrl) {
  // Detect dynamic forms by scrolling and clicking triggers
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
  await safeWait(page, 1500);

  const triggers = [
    'button:has-text("Contact")',
    'button:has-text("Enquire")',
    'a:has-text("Get in touch")',
    '[class*="modal-trigger"]',
    '[class*="popup-trigger"]',
  ];

  for (const trigger of triggers) {
    try {
      const btn = page.locator(trigger).first();
      if (await btn.count() && await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 1500 }).catch(() => null);
        await safeWait(page, 1000);
      }
    } catch {}
  }

  // Discover all forms
  const formCandidates = await page.evaluate((pageUrl) => {
    const forms = Array.from(document.querySelectorAll("form"));
    const out = [];

    function textOf(el) {
      return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400);
    }
    function attr(el, name) {
      return (el && el.getAttribute && el.getAttribute(name)) || "";
    }
    function has(el, selector) {
      try {
        return !!el.querySelector(selector);
      } catch {
        return false;
      }
    }

    for (let i = 0; i < forms.length; i++) {
      const f = forms[i];
      const action = attr(f, "action");
      const id = attr(f, "id");
      const cls = attr(f, "class");
      const aria = attr(f, "aria-label");
      const inputs = f.querySelectorAll("input, textarea, select");
      const inputCount = inputs.length;

      const hasTextarea = has(f, "textarea");
      const hasEmail =
        has(f, "input[type='email']") ||
        Array.from(inputs).some((x) => (attr(x, "name") || "").toLowerCase().includes("email"));
      const hasPhone =
        has(f, "input[type='tel']") ||
        Array.from(inputs).some((x) => (attr(x, "name") || "").toLowerCase().includes("phone"));
      const hasName = Array.from(inputs).some((x) => {
        const n = (attr(x, "name") || "").toLowerCase();
        const p = (attr(x, "placeholder") || "").toLowerCase();
        return n.includes("name") || p.includes("name");
      });
      const hasFileUpload = has(f, "input[type='file']");

      const submitText = (() => {
        const btn =
          f.querySelector("button[type='submit']") ||
          f.querySelector("input[type='submit']") ||
          Array.from(f.querySelectorAll("button")).find((b) =>
            /send|submit|enquir|quote|request|book/i.test(textOf(b))
          ) ||
          null;
        return btn ? textOf(btn) : "";
      })();

      const aroundText = textOf(f.closest("section") || f.closest("div") || f.parentElement);
      const hay = `${id} ${cls} ${aria} ${submitText} ${aroundText}`.toLowerCase();

      // Detect search/filter forms
      const hasSearchInput = has(f, "input[type='search']") ||
        Array.from(inputs).some((x) => {
          const n = (attr(x, "name") || "").toLowerCase();
          const id = (attr(x, "id") || "").toLowerCase();
          const p = (attr(x, "placeholder") || "").toLowerCase();
          return /^q$|^s$|search|keyword|make|model|postcode|price|min|max|sort|filter|year|mileage|transmission/i.test(n) ||
                 /^q$|^s$|search|keyword|make|model|postcode|price|min|max|sort|filter|year|mileage|transmission/i.test(id) ||
                 /^q$|^s$|search|keyword|make|model|postcode|price|min|max|sort|filter|year|mileage|transmission/i.test(p);
        });

      const searchLikeSubmit = /search|find|filter|apply|vehicles|inventory|results|view\s+stock/i.test(submitText);
      const isSiteSearch = (inputCount <= 2 && !hasEmail && !hasTextarea) && (hasSearchInput || searchLikeSubmit);
      const isSearchLike = hasSearchInput || searchLikeSubmit || (/search/.test(hay) && inputCount <= 3 && !hasEmail);
      const isNewsletter = /newsletter|subscribe|subscription/.test(hay) && !hasTextarea;
      const isLogin = /login|sign in|password/.test(hay);

      let score = 0;

      // Hard exclusions
      if (isSearchLike) score -= 999;
      if (isSiteSearch) score -= 999;
      if (isNewsletter) score -= 999;
      if (isLogin) score -= 999;

      // Lead form signals
      if (hasTextarea) score += 3;
      if (hasEmail && hasName) score += 3;
      if (hasEmail) score += 2;
      if (hasName) score += 1;
      if (hasPhone) score += 1;
      if (/send|submit|enquir|request|get quote|book|contact|callback/i.test(submitText)) score += 2;
      if (/contact|get in touch|enquir|quote|booking/i.test(hay)) score += 2;

      // Check if third-party by action
      let isThirdPartyByAction = false;
      if (action) {
        try {
          const actionUrl = new URL(action, pageUrl);
          const pageOrigin = new URL(pageUrl).origin;
          const actionLower = actionUrl.href.toLowerCase();
          const thirdPartyHints = [
            "hubspot", "hsforms", "jotform", "typeform", "google.com/forms",
            "forms.gle", "calendly", "marketo", "pardot", "salesforce",
            "formstack", "wufoo", "cognitoforms"
          ];
          if (actionUrl.origin !== pageOrigin && thirdPartyHints.some(hint => actionLower.includes(hint))) {
            isThirdPartyByAction = true;
          }
        } catch {}
      }

      out.push({
        index: i,
        action,
        inputCount,
        hasEmail,
        hasTextarea,
        hasPhone,
        hasName,
        hasFileUpload,
        submitText,
        score,
        isThirdPartyByAction,
      });
    }

    return out;
  }, pageUrl);

  // Filter for lead forms only (score >= 3)
  const leadForms = formCandidates.filter(f => f.score >= 3);

  // Sort by score
  leadForms.sort((a, b) => b.score - a.score || b.inputCount - a.inputCount);

  // Classify as first-party or third-party
  const firstPartyForms = leadForms.filter(f => !f.isThirdPartyByAction);
  const thirdPartyForms = leadForms.filter(f => f.isThirdPartyByAction);

  // Check for third-party iframes
  const iframeInfos = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe"))
      .map((f) => (f.getAttribute("src") || "").trim())
      .filter(Boolean)
  );
  const thirdPartyIframes = iframeInfos.filter((src) =>
    containsAny(src.toLowerCase(), THIRD_PARTY_HINTS)
  );

  return {
    firstPartyForms,
    thirdPartyForms,
    thirdPartyIframes,
    totalLeadForms: leadForms.length,
    totalFormsScanned: formCandidates.length,
  };
}

// ------------------------------
// INTELLIGENT FIELD DETECTION & FILLING
// ------------------------------
async function detectFieldType(element, page) {
  try {
    const tag = await element.evaluate((el) => el.tagName.toLowerCase());
    const type = (await element.getAttribute("type")) || "";
    const name = (await element.getAttribute("name")) || "";
    const id = (await element.getAttribute("id")) || "";
    const placeholder = (await element.getAttribute("placeholder")) || "";
    const ariaLabel = (await element.getAttribute("aria-label")) || "";
    
    // Try to find associated label
    const labelText = await element.evaluate((el) => {
      const label = el.closest("label") || (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
      return label ? (label.textContent || "").trim().toLowerCase() : "";
    });

    const combined = `${type} ${name} ${id} ${placeholder} ${ariaLabel} ${labelText}`.toLowerCase();

    if (tag === "select") return { type: "select", tag };
    if (type === "checkbox") return { type: "checkbox", tag };
    if (type === "radio") return { type: "radio", tag };
    if (type === "file") return { type: "file", tag };
    if (type === "date") return { type: "date", tag };
    if (type === "hidden") return { type: "hidden", tag };

    if (/email|e-mail/.test(combined)) return { type: "email", tag };
    if (/phone|tel|mobile|cell/.test(combined)) return { type: "phone", tag };
    if (/first.*name|fname|forename/.test(combined)) return { type: "first_name", tag };
    if (/last.*name|lname|surname/.test(combined)) return { type: "last_name", tag };
    if (/^name$|full.*name|your.*name/.test(combined)) return { type: "full_name", tag };
    if (/message|comment|enquiry|inquiry|question|details/.test(combined)) return { type: "message", tag };
    if (/company|organisation|organization|business/.test(combined)) return { type: "company", tag };
    if (/postcode|postal|zip/.test(combined)) return { type: "postcode", tag };
    if (/address/.test(combined)) return { type: "address", tag };
    if (/city|town/.test(combined)) return { type: "city", tag };
    if (/country/.test(combined)) return { type: "country", tag };
    if (/subject|topic|regarding/.test(combined)) return { type: "subject", tag };
    if (tag === "textarea") return { type: "message", tag };

    return { type: "text", tag };
  } catch {
    return { type: "unknown", tag: "unknown" };
  }
}

async function fillFormFieldSmart(page, element, fieldInfo) {
  try {
    const { type, tag } = fieldInfo;

    // Skip hidden fields
    if (type === "hidden") return { success: true, skipped: true };

    // Check if visible and enabled
    const isVisible = await element.isVisible({ timeout: 500 }).catch(() => false);
    const isEnabled = await element.isEnabled({ timeout: 500 }).catch(() => false);
    
    if (!isVisible || !isEnabled) {
      return { success: true, skipped: true, reason: "not_visible_or_disabled" };
    }

    // Move mouse to field (human-like)
    const box = await element.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
      await safeWait(null, randomDelay(100, 300));
    }

    // SELECT dropdowns
    if (tag === "select") {
      const selected = await element.evaluate((sel) => {
        const options = Array.from(sel.querySelectorAll("option"));
        const validOptions = options.filter((opt) => {
          const value = opt.value?.trim();
          const text = opt.textContent?.trim().toLowerCase();
          if (!value || value === "" || value === "0") return false;
          if (text.includes("select") || text.includes("choose") || text.includes("--")) return false;
          return true;
        });
        if (validOptions.length > 0) {
          sel.value = validOptions[0].value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return validOptions[0].value;
        }
        return null;
      });
      return { success: !!selected, value: selected };
    }

    // CHECKBOXES
    if (type === "checkbox") {
      const name = await element.getAttribute("name") || "";
      const id = await element.getAttribute("id") || "";
      const combined = `${name} ${id}`.toLowerCase();
      
      // Only check if it's consent/privacy/terms related
      if (/consent|agree|privacy|terms|gdpr|policy|accept/.test(combined)) {
        await element.check({ timeout: 1500 }).catch(() => null);
        await safeWait(page, randomDelay(100, 300));
        return { success: true };
      }
      return { success: true, skipped: true, reason: "non_consent_checkbox" };
    }

    // RADIO BUTTONS
    if (type === "radio") {
      const name = await element.getAttribute("name");
      if (name) {
        const firstInGroup = page.locator(`input[type="radio"][name="${name}"]`).first();
        await firstInGroup.check({ timeout: 1500 }).catch(() => null);
        await safeWait(page, randomDelay(100, 300));
        return { success: true };
      }
      return { success: false, reason: "radio_no_name" };
    }

    // FILE UPLOAD
    if (type === "file") {
      try {
        // Create a dummy text file
        const tmpDir = "/tmp";
        const dummyPath = path.join(tmpDir, "health-check-test.txt");
        await fs.writeFile(dummyPath, "This is a test file for form submission validation.");
        await element.setInputFiles(dummyPath);
        await safeWait(page, randomDelay(200, 400));
        return { success: true };
      } catch (fileErr) {
        return { success: false, reason: `file_upload_failed: ${fileErr.message}` };
      }
    }

    // DATE INPUTS
    if (type === "date") {
      await element.click();
      await safeWait(page, randomDelay(200, 400));
      await element.fill("2025-06-15").catch(() => null);
      await safeWait(page, randomDelay(100, 300));
      return { success: true };
    }

    // TEXT INPUTS (email, phone, name, message, etc.)
    const valueMap = {
      email: TEST_VALUES.email,
      phone: TEST_VALUES.phone,
      first_name: TEST_VALUES.firstName,
      last_name: TEST_VALUES.lastName,
      full_name: TEST_VALUES.fullName,
      message: TEST_VALUES.message,
      company: TEST_VALUES.company,
      postcode: TEST_VALUES.postcode,
      city: TEST_VALUES.city,
      address: TEST_VALUES.address,
      subject: TEST_VALUES.subject,
      text: TEST_VALUES.fullName,
    };

    const value = valueMap[type] || TEST_VALUES.fullName;

    await element.click();
    await safeWait(null, randomDelay(200, 500));

    // Clear first
    await element.clear().catch(() => null);
    await safeWait(null, randomDelay(50, 150));

    // Type with realistic delays
    const delay = type === "phone" ? randomDelay(80, 200) : randomDelay(50, 150);
    for (const char of value) {
      await element.type(char, { delay: randomDelay(50, 150) });
    }

    await safeWait(null, randomDelay(300, 700));
    await element.blur();
    await safeWait(null, randomDelay(100, 300));

    const actualValue = await element.inputValue().catch(() => "");
    const success = actualValue === value || actualValue.includes(value);
    
    return { success, value: actualValue };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ------------------------------
// CAPTCHA DETECTION
// ------------------------------
async function detectCaptcha(page, formLocator = null) {
  try {
    // If we have a form locator, check CAPTCHA inside the form
    const searchScope = formLocator || page;
    
    // Check for reCAPTCHA v2 - must be VISIBLE
    const recaptchaElements = await searchScope.locator('.g-recaptcha, iframe[src*="recaptcha/api2"]').all();
    for (const elem of recaptchaElements) {
      const isVisible = await elem.isVisible().catch(() => false);
      if (isVisible) {
        return { detected: true, type: "reCAPTCHA v2", bypassable: false };
      }
    }
    
    // Check for reCAPTCHA v3 (invisible) - only if we're checking the whole page
    if (!formLocator) {
      const hasRecaptchaV3 = await page.evaluate(() => typeof window.grecaptcha !== "undefined").catch(() => false);
      if (hasRecaptchaV3) {
        return { detected: true, type: "reCAPTCHA v3 (invisible)", bypassable: true };
      }
    }
    
    // Check for hCaptcha - must be VISIBLE
    const hcaptchaElements = await searchScope.locator('.h-captcha, iframe[src*="hcaptcha"]').all();
    for (const elem of hcaptchaElements) {
      const isVisible = await elem.isVisible().catch(() => false);
      if (isVisible) {
        return { detected: true, type: "hCaptcha", bypassable: false };
      }
    }
    
    // Check for Cloudflare Turnstile - must be VISIBLE
    const turnstileElements = await searchScope.locator('[class*="cf-turnstile"], iframe[src*="turnstile"]').all();
    for (const elem of turnstileElements) {
      const isVisible = await elem.isVisible().catch(() => false);
      if (isVisible) {
        return { detected: true, type: "Cloudflare Turnstile", bypassable: false };
      }
    }
  } catch {}
  
  return { detected: false, type: null, bypassable: false };
}

// ------------------------------
// CONSTRAINT SATISFACTION - Detect Blockers
// ------------------------------
async function detectSubmissionBlockers(page, form, submitButton) {
  const blockers = {
    submitDisabled: false,
    requiredFieldsEmpty: [],
    requiredCheckboxesUnchecked: [],
    requiredRadiosUnselected: [],
    validationErrors: [],
  };

  try {
    blockers.submitDisabled = await submitButton.isDisabled().catch(() => false);
  } catch {}

  // Required fields
  try {
    const requiredFields = await form
      .locator("input[required], textarea[required], select[required]")
      .all();
    
    for (const field of requiredFields) {
      const value = await field.inputValue().catch(() => "");
      const isVisible = await field.isVisible().catch(() => false);
      const tag = await field.evaluate(el => el.tagName.toLowerCase());
      
      if (isVisible && !value && tag !== "select") {
        const name = await field.getAttribute("name").catch(() => "");
        const id = await field.getAttribute("id").catch(() => "");
        const type = await field.getAttribute("type").catch(() => "");
        const placeholder = await field.getAttribute("placeholder").catch(() => "");
        blockers.requiredFieldsEmpty.push({
          name: name || id || "unknown",
          type,
          placeholder: placeholder || "",
        });
      } else if (isVisible && tag === "select") {
        const selectedValue = await field.evaluate(sel => sel.value);
        if (!selectedValue || selectedValue === "" || selectedValue === "0") {
          const name = await field.getAttribute("name").catch(() => "");
          const id = await field.getAttribute("id").catch(() => "");
          blockers.requiredFieldsEmpty.push({
            name: name || id || "unknown",
            type: "select",
            placeholder: "",
          });
        }
      }
    }
  } catch {}

  // Required checkboxes
  try {
    const requiredCheckboxes = await form
      .locator('input[type="checkbox"][required]')
      .all();
    
    for (const checkbox of requiredCheckboxes) {
      const isChecked = await checkbox.isChecked().catch(() => false);
      const isVisible = await checkbox.isVisible().catch(() => false);
      
      if (isVisible && !isChecked) {
        const name = await checkbox.getAttribute("name").catch(() => "");
        const id = await checkbox.getAttribute("id").catch(() => "");
        const label = await checkbox.evaluate((el) => {
          const labelEl = el.closest("label") || (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
          return labelEl ? (labelEl.textContent || "").trim().substring(0, 100) : "";
        }).catch(() => "");
        
        blockers.requiredCheckboxesUnchecked.push({
          name: name || id || "unknown",
          label,
        });
      }
    }
  } catch {}

  // Required radio groups
  try {
    const radioGroups = new Map();
    const radios = await form.locator('input[type="radio"][required]').all();

    for (const radio of radios) {
      const name = await radio.getAttribute("name").catch(() => "");
      if (!name) continue;

      if (!radioGroups.has(name)) {
        radioGroups.set(name, { radios: [], hasSelection: false, label: "" });
      }

      radioGroups.get(name).radios.push(radio);
      const isChecked = await radio.isChecked().catch(() => false);
      if (isChecked) radioGroups.get(name).hasSelection = true;

      if (!radioGroups.get(name).label) {
        const label = await radio.evaluate((el) => {
          const labelEl = el.closest("label") || (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
          return labelEl ? (labelEl.textContent || "").trim().substring(0, 100) : "";
        }).catch(() => "");
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
            optionCount: group.radios.length,
          });
        }
      }
    }
  } catch {}

  // Validation errors
  try {
    const errorSelectors = [
      '[role="alert"]',
      ".error",
      ".invalid-feedback",
      ".field-error",
      ".validation-error",
      ".wpcf7-not-valid-tip",
      ".parsley-errors-list",
      ".help-block.error",
    ];

    for (const selector of errorSelectors) {
      const errors = await page.locator(selector).all();
      for (const error of errors) {
        const isVisible = await error.isVisible().catch(() => false);
        if (!isVisible) continue;
        const text = await error.textContent().catch(() => "");
        if (text && text.trim()) blockers.validationErrors.push(text.trim());
      }
    }
  } catch {}

  return blockers;
}

// ------------------------------
// CONSTRAINT SATISFACTION - Fix Blockers
// ------------------------------
async function fixSubmissionBlockers(page, form, blockers) {
  let fixed = false;

  // Fix required checkboxes
  for (const checkbox of blockers.requiredCheckboxesUnchecked) {
    try {
      const checkboxName = typeof checkbox === "string" ? checkbox : checkbox.name;
      const checkboxEl = form
        .locator(
          `input[type="checkbox"][name="${checkboxName}"], input[type="checkbox"][id="${checkboxName}"]`
        )
        .first();
      if (await checkboxEl.count()) {
        await checkboxEl.check({ timeout: 1500 }).catch(() => null);
        await safeWait(page, 150);
        fixed = true;
      }
    } catch {}
  }

  // Fix required radio buttons
  for (const radio of blockers.requiredRadiosUnselected) {
    try {
      const radioName = typeof radio === "string" ? radio : radio.name;
      const firstRadio = form.locator(`input[type="radio"][name="${radioName}"]`).first();
      if (await firstRadio.count()) {
        await firstRadio.check({ timeout: 1500 }).catch(() => null);
        await safeWait(page, 150);
        fixed = true;
      }
    } catch {}
  }

  // Fix required fields
  for (const field of blockers.requiredFieldsEmpty) {
    try {
      const fieldEl = form
        .locator(
          `input[name="${field.name}"], input[id="${field.name}"], select[name="${field.name}"], select[id="${field.name}"], textarea[name="${field.name}"], textarea[id="${field.name}"]`
        )
        .first();
      
      if (await fieldEl.count()) {
        const fieldInfo = await detectFieldType(fieldEl, page);
        const result = await fillFormFieldSmart(page, fieldEl, fieldInfo);
        if (result.success) fixed = true;
      }
    } catch {}
  }

  return fixed;
}

// ------------------------------
// TEST FIRST-PARTY FORM
// ------------------------------
async function testFirstPartyForm(page, beacons, pageUrl, formMeta) {
  const formIndex = formMeta.index;
  const form = page.locator("form").nth(formIndex);

  try {
    if (!(await form.count())) {
      return { status: "NOT_TESTED", reason: "Form element not found on page" };
    }

    await form.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => null);
    await safeWait(page, 500);

    // PHASE 1: Fill all fields
    const fields = form.locator("input, textarea, select");
    const fieldCount = await fields.count();

    if (fieldCount < 2) {
      return { status: "NOT_TESTED", reason: "Form has less than 2 fields (likely not a lead form)" };
    }

    logDebug(`Filling form with ${fieldCount} fields`, { pageUrl, formIndex });

    for (let i = 0; i < fieldCount; i++) {
      const field = fields.nth(i);
      
      if (i > 0) {
        await safeWait(page, randomDelay(500, 1500)); // Human-like delay between fields
      }

      const fieldInfo = await detectFieldType(field, page);
      const result = await fillFormFieldSmart(page, field, fieldInfo);
      
      logDebug(`Field ${i + 1}/${fieldCount}:`, { type: fieldInfo.type, success: result.success });
    }

    await safeWait(page, 1500);

    // PHASE 2: Find submit button
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
      "button:has-text('Contact')",
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
      return { status: "NOT_TESTED", reason: "No submit button found in form" };
    }

    // PHASE 3: Constraint satisfaction loop (max 3 attempts)
    const MAX_FIX_ATTEMPTS = 3;
    let fixAttempts = 0;
    let isSubmittable = false;
    let finalBlockers = null;

    while (fixAttempts < MAX_FIX_ATTEMPTS) {
      const blockers = await detectSubmissionBlockers(page, form, submit);
      finalBlockers = blockers;

      // Check if form is submittable (ignoring CAPTCHA for now - we'll try to submit anyway)
      if (
        !blockers.submitDisabled &&
        blockers.requiredFieldsEmpty.length === 0 &&
        blockers.requiredCheckboxesUnchecked.length === 0 &&
        blockers.requiredRadiosUnselected.length === 0
      ) {
        isSubmittable = true;
        break;
      }

      // Try to fix blockers
      const fixed = await fixSubmissionBlockers(page, form, blockers);
      if (!fixed) break; // No more fixes possible

      await safeWait(page, 1200);
      fixAttempts++;
    }

    // If not submittable due to regular constraints, return detailed blocker info
    if (!isSubmittable) {
      const blockerDetails = [];

      if (finalBlockers?.submitDisabled) {
        blockerDetails.push("Submit button is disabled");
      }
      if (finalBlockers?.requiredFieldsEmpty?.length > 0) {
        blockerDetails.push(
          `Required fields not filled (${finalBlockers.requiredFieldsEmpty.length}): ${finalBlockers.requiredFieldsEmpty
            .map(f => `${f.name} (${f.type}${f.placeholder ? ": " + f.placeholder : ""})`)
            .join(", ")}`
        );
      }
      if (finalBlockers?.requiredCheckboxesUnchecked?.length > 0) {
        blockerDetails.push(
          `Required checkboxes not checked (${finalBlockers.requiredCheckboxesUnchecked.length}): ${finalBlockers.requiredCheckboxesUnchecked
            .map(c => `${c.name}${c.label ? " - " + c.label : ""}`)
            .join(", ")}`
        );
      }
      if (finalBlockers?.requiredRadiosUnselected?.length > 0) {
        blockerDetails.push(
          `Required radio groups not selected (${finalBlockers.requiredRadiosUnselected.length}): ${finalBlockers.requiredRadiosUnselected
            .map(r => `${r.name}${r.label ? " - " + r.label : ""} (${r.optionCount} options)`)
            .join(", ")}`
        );
      }
      if (finalBlockers?.validationErrors?.length > 0) {
        blockerDetails.push(`Validation errors: ${finalBlockers.validationErrors.join("; ")}`);
      }

      const detailedReason = blockerDetails.length > 0
        ? blockerDetails.join(" | ")
        : "Form constraints not satisfied after 3 attempts";

      return {
        status: "NOT_TESTED",
        reason: detailedReason,
        constraint_attempts: fixAttempts,
        blockers: finalBlockers,
      };
    }

    // PHASE 4: Submit the form
    const beforeBeaconIdx = beacons.length;
    const beforeUrl = page.url();

    await submit.scrollIntoViewIfNeeded().catch(() => null);
    await safeWait(page, 300);

    let navigated = false;

    try {
      await Promise.race([
        page.waitForNavigation({ timeout: 9000 }).then(() => { navigated = true; }).catch(() => null),
        submit.click({ timeout: 3000 }),
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
              if (f.submit && typeof f.submit === "function") f.submit();
              else if (f.requestSubmit) f.requestSubmit();
            });
          } catch {
            try {
              const textField = form.locator('input[type="text"], input[type="email"], input[type="tel"]').first();
              if (await textField.count()) await textField.press("Enter");
            } catch {}
          }
        }
      }
    }

    await safeWait(page, FORM_SUBMIT_WAIT_MS);

    const afterUrl = page.url();
    const urlChanged = afterUrl !== beforeUrl;

    // Detect search/results page navigation
    const searchResultsPatterns = [
      /\/search/i,
      /\/results/i,
      /\/used-vehicles/i,
      /\/vehicles/i,
      /\/inventory/i,
      /\/stock/i,
      /[?&]q=/i,
      /[?&]search=/i,
      /[?&]make=/i,
      /[?&]model=/i,
    ];

    const navigatedToSearchResults = urlChanged && searchResultsPatterns.some(pattern => pattern.test(afterUrl));

    if (navigatedToSearchResults) {
      return {
        status: "NOT_TESTED",
        reason: "Search form detected - navigated to search/results page (not a lead form)",
        submit_evidence: { urlChanged, navigatedToSearchResults, beforeUrl, afterUrl },
      };
    }

    // Thank you page patterns
    const thankYouPatterns = [
      /\/thank-you/i,
      /\/thankyou/i,
      /\/thanks/i,
      /\/contact\/thanks/i,
      /\/success/i,
      /\/confirmation/i,
      /\/submitted/i,
    ];

    const navigatedToThankYou = urlChanged && thankYouPatterns.some(pattern => pattern.test(afterUrl));

    const successSignal = await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("thank you") ||
        text.includes("thanks for") ||
        text.includes("message has been sent") ||
        text.includes("message sent") ||
        text.includes("we'll be in touch") ||
        text.includes("we will be in touch") ||
        text.includes("successfully sent") ||
        text.includes("submission successful") ||
        text.includes("form submitted")
      );
    }).catch(() => false);

    let submittedSuccessfully = navigatedToThankYou || successSignal || urlChanged;

    // Check GA4 beacons
    const newGa4 = beacons.slice(beforeBeaconIdx).filter((b) => b.type === "GA4");
    const meaningfulEvents = newGa4.filter((b) => {
      const eventName = (b.event_name || "").toLowerCase();
      if (eventName === "page_view" && urlChanged) return true;
      return !GENERIC_EVENTS.some((generic) => eventName === generic);
    });

    if (meaningfulEvents.length > 0) {
      return {
        status: "PASS",
        reason: null,
        submittedSuccessfully,
        submit_evidence: { urlChanged, successSignal, navigated, navigatedToThankYou, beforeUrl, afterUrl },
        ga4_events: uniq(meaningfulEvents.map((b) => b.event_name).filter(Boolean)),
        evidence_urls: meaningfulEvents.slice(0, 5).map((b) => b.url),
      };
    }

    if (submittedSuccessfully) {
      const genericEventsSeen = uniq(newGa4.map((b) => b.event_name).filter(Boolean));
      return {
        status: "FAIL",
        reason: "Form submitted successfully but no meaningful GA4 conversion event fired",
        submittedSuccessfully,
        submit_evidence: { urlChanged, successSignal, navigated, navigatedToThankYou, beforeUrl, afterUrl },
        ga4_events: genericEventsSeen,
      };
    }

    // Validation blocked or submit not confirmed
    // NOW check if CAPTCHA was the blocker
    const captchaCheck = await detectCaptcha(page, form);
    
    if (captchaCheck.detected && !captchaCheck.bypassable) {
      return {
        status: "NOT_TESTED",
        reason: `CAPTCHA detected (${captchaCheck.type}) - cannot be bypassed by automation`,
        submittedSuccessfully: false,
        blockers: { captcha: captchaCheck }
      };
    }
    
    const validationText = await page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll(
          "[role='alert'], .error, .wpcf7-not-valid-tip, .wpcf7-response-output, .error-message, .validation-error"
        )
      );
      return els
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" | ");
    }).catch(() => "");

    return {
      status: "NOT_TESTED",
      reason: validationText ? `Validation blocked: ${validationText}` : "Form submission not confirmed (no URL change or success signal)",
      ga4_events: uniq(newGa4.map((b) => b.event_name).filter(Boolean)),
    };

  } catch (e) {
    return { status: "NOT_TESTED", reason: `Form test error: ${e.message}` };
  }
}

// ------------------------------
// TEST THIRD-PARTY IFRAME FORM
// ------------------------------
async function testThirdPartyIframeForm(page, beacons, iframeSrc) {
  try {
    // Try to access iframe
    const iframeSelector = `iframe[src*="${iframeSrc.split('/')[2]}"]`; // Match domain
    const iframe = page.frameLocator(iframeSelector);
    
    const form = iframe.locator('form').first();
    const formExists = await form.count().catch(() => 0);
    
    if (formExists === 0) {
      return {
        status: "NOT_TESTED",
        reason: "Cannot access third-party iframe form content (CORS blocked or form not found)",
        iframe_src: iframeSrc,
      };
    }

    // Try to fill and submit (same logic as first-party, but simpler)
    const fields = iframe.locator('input, textarea, select');
    const fieldCount = await fields.count();

    for (let i = 0; i < fieldCount; i++) {
      const field = fields.nth(i);
      const fieldInfo = await detectFieldType(field, page);
      await fillFormFieldSmart(page, field, fieldInfo);
      await safeWait(page, randomDelay(300, 800));
    }

    const submit = iframe.locator('button[type="submit"], input[type="submit"]').first();
    if (!(await submit.count())) {
      return {
        status: "NOT_TESTED",
        reason: "No submit button found in third-party iframe form",
        iframe_src: iframeSrc,
      };
    }

    const beforeBeaconIdx = beacons.length;
    await submit.click({ timeout: 3000 }).catch(() => null);
    await safeWait(page, FORM_SUBMIT_WAIT_MS);

    const newGa4 = beacons.slice(beforeBeaconIdx).filter((b) => b.type === "GA4");
    const meaningfulEvents = newGa4.filter((b) => {
      const eventName = (b.event_name || "").toLowerCase();
      return !GENERIC_EVENTS.some((generic) => eventName === generic);
    });

    if (meaningfulEvents.length > 0) {
      return {
        status: "PASS",
        reason: null,
        iframe_src: iframeSrc,
        ga4_events: uniq(meaningfulEvents.map((b) => b.event_name).filter(Boolean)),
      };
    }

    return {
      status: "FAIL",
      reason: "Third-party iframe form submitted but no meaningful GA4 event fired",
      iframe_src: iframeSrc,
      ga4_events: uniq(newGa4.map((b) => b.event_name).filter(Boolean)),
    };

  } catch (e) {
    return {
      status: "NOT_TESTED",
      reason: `Third-party iframe form error: ${e.message}`,
      iframe_src: iframeSrc,
    };
  }
}

// ------------------------------
// TEST ALL FORMS ON PAGE (Priority Logic)
// ------------------------------
async function testAllFormsOnPage(page, beacons, pageUrl) {
  const formDiscovery = await discoverAllFormsOnPage(page, pageUrl);
  
  const results = {
    page_url: pageUrl,
    total_forms_scanned: formDiscovery.totalFormsScanned,
    total_lead_forms_found: formDiscovery.totalLeadForms,
    first_party_forms: [],
    third_party_forms: [],
    third_party_iframes: formDiscovery.thirdPartyIframes,
    tested_third_party: false,
    reason_for_third_party_test: null,
  };

  // PRIORITY 1: Test first-party forms
  if (formDiscovery.firstPartyForms.length > 0) {
    logInfo(`Found ${formDiscovery.firstPartyForms.length} first-party lead forms on ${pageUrl}`);

    for (const formMeta of formDiscovery.firstPartyForms) {
      const result = await testFirstPartyForm(page, beacons, pageUrl, formMeta);
      
      results.first_party_forms.push({
        form_index: formMeta.index,
        form_meta: formMeta,
        status: result.status,
        reason: result.reason || null,
        submittedSuccessfully: result.submittedSuccessfully || null,
        ga4_events: result.ga4_events || [],
        evidence_urls: result.evidence_urls || [],
        submit_evidence: result.submit_evidence || null,
        constraint_attempts: result.constraint_attempts || 0,
        blockers: result.blockers || null,
      });

      // If ANY first-party form PASSES → Stop, don't test third-party
      if (result.status === "PASS") {
        results.reason_for_third_party_test = "First-party form passed - third-party forms not tested";
        logInfo(`✅ First-party form passed on ${pageUrl} - skipping third-party forms`);
        return results;
      }
    }

    // If we reach here, all first-party forms either FAILED or NOT_TESTED
    const allFailed = results.first_party_forms.every(f => f.status === "FAIL");
    const allNotTested = results.first_party_forms.every(f => f.status === "NOT_TESTED");

    if (allFailed) {
      results.reason_for_third_party_test = "All first-party forms failed - testing third-party as fallback";
    } else if (allNotTested) {
      results.reason_for_third_party_test = "All first-party forms blocked - testing third-party as fallback";
    } else {
      results.reason_for_third_party_test = "First-party forms had mixed issues - testing third-party as fallback";
    }
  } else {
    results.reason_for_third_party_test = "No first-party forms found - testing third-party forms";
  }

  // PRIORITY 2: Test third-party forms (only if first-party didn't pass)
  const thirdPartyToTest = [
    ...formDiscovery.thirdPartyForms,
    ...formDiscovery.thirdPartyIframes.map(src => ({ isIframe: true, src })),
  ];

  if (thirdPartyToTest.length > 0) {
    results.tested_third_party = true;
    logInfo(`Testing ${thirdPartyToTest.length} third-party forms/iframes on ${pageUrl}`);

    for (const item of thirdPartyToTest) {
      let result;

      if (item.isIframe) {
        result = await testThirdPartyIframeForm(page, beacons, item.src);
      } else {
        result = await testFirstPartyForm(page, beacons, pageUrl, item);
        result.is_third_party = true;
      }

      results.third_party_forms.push(result);

      // If third-party PASSES, we can stop
      if (result.status === "PASS") {
        logInfo(`✅ Third-party form passed on ${pageUrl}`);
        break;
      }
    }
  }

  return results;
}

// ------------------------------
// MAIN HEALTH CHECK LOGIC
// ------------------------------
async function trackingHealthCheckSiteInternal(url) {
  const startTs = nowIso();
  const targetUrl = normaliseUrl(url);

  const results = {
    ok: true,
    script_version: SCRIPT_VERSION,
    url: targetUrl,
    timestamp: startTs,

    overall_status: null,
    why: null,
    needs_improvement: [],

    pages_visited: [],
    cookie_consent: { banner_found: false, accepted: false, details: null },

    tracking: {
      tags_found: { gtm: [], ga4: [], ignored_aw: [] },
      runtime: { gtm_loaded: false, ga_runtime_present: false },
      beacon_counts: { gtm: 0, ga4: 0 },
      has_tracking: false,
    },

    ctas: {
      phones: { found: 0, tested: 0, passed: 0, failed: 0, items: [] },
      emails: { found: 0, tested: 0, passed: 0, failed: 0, items: [] },
    },

    forms: {
      total_pages_with_forms: 0,
      pages: [],
    },

    evidence: { network_beacons: [] },
  };

  const beacons = [];
  let browser = null;
  let context = null;
  let page = null;

  try {
    logInfo(`🔍 [${SCRIPT_VERSION}] Starting intelligent tracking health check`, { url: targetUrl });

    browser = await chromium.launch({
      headless: HEADLESS,
      timeout: 90000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-GB",
      timezoneId: "Europe/London",
    });

    page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en", "en-US"] });
    });

    // Network beacon listener
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
        event_name: eventName,
      });
    };

    page.on("request", requestHandler);

    // Load homepage
    const load = await safeGoto(page, targetUrl);
    if (!load.ok) throw new Error(load.error);
    results.pages_visited.push(page.url());

    await safeWait(page, INIT_WAIT_MS);
    await simulateHumanBrowsing(page);

    // Handle cookie consent
    results.cookie_consent = await handleCookieConsent(page);
    await safeWait(page, 1200);

    // Wait for GTM/GA4 to load (up to 10 seconds)
    const trackingLoadTimeout = 10000;
    const trackingCheckStart = Date.now();
    let trackingLoaded = false;
    
    while (Date.now() - trackingCheckStart < trackingLoadTimeout && !trackingLoaded) {
      const hasTracking = await page.evaluate(() => {
        // Check if GTM or GA4 is present
        const hasGTM = !!window.google_tag_manager || 
                       document.querySelector('script[src*="googletagmanager.com/gtm.js"]') !== null;
        const hasGA4 = !!window.gtag || 
                       !!window.dataLayer || 
                       document.querySelector('script[src*="googletagmanager.com/gtag/js"]') !== null;
        return hasGTM || hasGA4;
      }).catch(() => false);
      
      if (hasTracking) {
        trackingLoaded = true;
        logDebug("Tracking codes loaded", { timeWaited: Date.now() - trackingCheckStart });
        await safeWait(page, 1000); // Extra wait for tracking to initialize
      } else {
        await safeWait(page, 500);
      }
    }

    // Detect tracking
    const tracking = await detectTrackingSetup(page, beacons);
    results.tracking.tags_found = tracking.tags_found;
    results.tracking.runtime = tracking.runtime;
    results.tracking.beacon_counts = tracking.beacon_counts;
    results.tracking.has_tracking = tracking.hasAnyTracking;

    if (!results.tracking.has_tracking) {
      results.overall_status = "FAIL";
      results.why = "No tracking codes detected on site";
      results.needs_improvement.push("BUILD_REQUIRED: No GTM/GA4 implementation found");
      results.evidence.network_beacons = beacons;
      return results;
    }

    // Check for multiple tracking tags
    if (tracking.tags_found.gtm.length > 1) {
      results.needs_improvement.push(
        `Multiple GTM tags detected: ${tracking.tags_found.gtm.join(", ")} - should only have one`
      );
    }
    if (tracking.tags_found.ga4.length > 1) {
      results.needs_improvement.push(
        `Multiple GA4 tags detected: ${tracking.tags_found.ga4.join(", ")} - should only have one`
      );
    }

    // Discover contact pages
    const discovered = await discoverCandidatePages(page, targetUrl);
    const pagesToVisit = [targetUrl, ...discovered].slice(0, MAX_PAGES_TO_VISIT);

    logInfo(`Will visit ${pagesToVisit.length} pages for CTA testing`, { pages: pagesToVisit });

    // Track unique CTAs across all pages
    const allPhonesNorm = new Set();
    const allEmailsNorm = new Set();
    const testedPhonesNorm = new Set();
    const testedEmailsNorm = new Set();

    // Visit each page and test CTAs + Forms
    for (let i = 0; i < pagesToVisit.length; i++) {
      const pUrl = pagesToVisit[i];

      const r = await safeGoto(page, pUrl);
      if (!r.ok) {
        logInfo(`⚠️ Could not load page: ${pUrl}`);
        continue;
      }

      const actualUrl = page.url();
      if (!results.pages_visited.includes(actualUrl)) results.pages_visited.push(actualUrl);

      await safeWait(page, 1200);

      // Scan for CTAs
      const ctas = await scanCTAsOnPage(page);

      // Test Phone CTAs
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

          const itemResult = {
            href: rawTel,
            href_normalised: norm,
            page_url: actualUrl,
            status: item.status,
            reason: item.reason || null,
            ga4_events: item.ga4_events || [],
            beacons_delta: item.beacons_delta || 0,
            evidence_urls: item.evidence_urls || [],
            generic_events_seen: item.generic_events_seen || [],
          };

          results.ctas.phones.items.push(itemResult);

          if (item.status === "PASS") results.ctas.phones.passed++;
          if (item.status === "FAIL") results.ctas.phones.failed++;
        }
      }

      // Test Email CTAs
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

          const itemResult = {
            href: rawMail,
            href_normalised: norm,
            page_url: actualUrl,
            status: item.status,
            reason: item.reason || null,
            ga4_events: item.ga4_events || [],
            beacons_delta: item.beacons_delta || 0,
            evidence_urls: item.evidence_urls || [],
            generic_events_seen: item.generic_events_seen || [],
          };

          results.ctas.emails.items.push(itemResult);

          if (item.status === "PASS") results.ctas.emails.passed++;
          if (item.status === "FAIL") results.ctas.emails.failed++;
        }
      }

      // Test Forms (with priority logic)
      const formResults = await testAllFormsOnPage(page, beacons, actualUrl);
      
      if (formResults.total_lead_forms_found > 0) {
        results.forms.total_pages_with_forms++;
      }

      results.forms.pages.push(formResults);

      // Check if we got a definitive form result (PASS or FAIL)
      const hasPassingForm = [
        ...formResults.first_party_forms,
        ...formResults.third_party_forms,
      ].some(f => f.status === "PASS");

      const hasFailingForm = [
        ...formResults.first_party_forms,
        ...formResults.third_party_forms,
      ].some(f => f.status === "FAIL");

      if (hasPassingForm || hasFailingForm) {
        logInfo(
          `Got definitive form result on page ${i + 1}/${pagesToVisit.length} - stopping crawl`,
          { hasPassingForm, hasFailingForm }
        );
        break;
      }

      await safeWait(page, 400);
    }

    // Update CTA counts
    results.ctas.phones.found = allPhonesNorm.size;
    results.ctas.emails.found = allEmailsNorm.size;

    // ========================================
    // CLASSIFICATION LOGIC
    // ========================================
    
    // Collect all form results
    const allFormResults = results.forms.pages.flatMap(p => [
      ...p.first_party_forms,
      ...p.third_party_forms,
    ]);

    // Calculate form stats
    const formsPassed = allFormResults.filter(f => f.status === "PASS").length;
    const formsFailed = allFormResults.filter(f => f.status === "FAIL").length;
    const formsNotTested = allFormResults.filter(f => f.status === "NOT_TESTED").length;
    const formsTested = formsPassed + formsFailed;
    const formsFound = allFormResults.length;

    // Determine status for each CTA category
    const categoryStatus = {
      phones: null,
      emails: null,
      forms: null,
    };

    // Phones
    if (results.ctas.phones.found === 0) {
      categoryStatus.phones = "NOT_PRESENT"; // No phones on site
    } else if (results.ctas.phones.tested === 0) {
      categoryStatus.phones = "NOT_TESTED"; // Phones exist but couldn't be tested
    } else if (results.ctas.phones.passed === 0 && results.ctas.phones.failed > 0) {
      categoryStatus.phones = "ALL_FAILED"; // All tested phones failed
    } else if (results.ctas.phones.passed > 0) {
      categoryStatus.phones = "AT_LEAST_ONE_PASSED"; // At least one passed
    }

    // Emails
    if (results.ctas.emails.found === 0) {
      categoryStatus.emails = "NOT_PRESENT";
    } else if (results.ctas.emails.tested === 0) {
      categoryStatus.emails = "NOT_TESTED";
    } else if (results.ctas.emails.passed === 0 && results.ctas.emails.failed > 0) {
      categoryStatus.emails = "ALL_FAILED";
    } else if (results.ctas.emails.passed > 0) {
      categoryStatus.emails = "AT_LEAST_ONE_PASSED";
    }

    // Forms
    if (formsFound === 0) {
      categoryStatus.forms = "NOT_PRESENT";
    } else if (formsTested === 0) {
      categoryStatus.forms = "NOT_TESTED";
    } else if (formsPassed === 0 && formsFailed > 0) {
      categoryStatus.forms = "ALL_FAILED";
    } else if (formsPassed > 0) {
      categoryStatus.forms = "AT_LEAST_ONE_PASSED";
    }

    logInfo("Category status:", categoryStatus);

    // Determine overall status
    const categoriesPresent = Object.entries(categoryStatus)
      .filter(([_, status]) => status !== "NOT_PRESENT")
      .map(([cat, _]) => cat);

    const categoriesAllFailed = categoriesPresent.filter(
      cat => categoryStatus[cat] === "ALL_FAILED"
    );

    const categoriesNotTested = categoriesPresent.filter(
      cat => categoryStatus[cat] === "NOT_TESTED"
    );

    const categoriesWithAtLeastOnePass = categoriesPresent.filter(
      cat => categoryStatus[cat] === "AT_LEAST_ONE_PASSED"
    );

    // PRIORITY 1: If ANY category present is completely NOT_TESTED → NOT_TESTED
    // This takes priority over partial passes in other categories
    if (categoriesNotTested.length > 0) {
      results.overall_status = "NOT_TESTED";
      results.why = "Critical CTAs could not be tested due to technical blockers";
      
      // List which categories couldn't be tested
      categoriesNotTested.forEach(cat => {
        if (cat === "phones") {
          const reasons = uniq(results.ctas.phones.items.map(i => i.reason).filter(Boolean));
          results.needs_improvement.push(`Phone CTAs not testable: ${reasons.join("; ")}`);
        } else if (cat === "emails") {
          const reasons = uniq(results.ctas.emails.items.map(i => i.reason).filter(Boolean));
          results.needs_improvement.push(`Email CTAs not testable: ${reasons.join("; ")}`);
        } else if (cat === "forms") {
          const reasons = uniq(allFormResults.filter(f => f.status === "NOT_TESTED").map(f => f.reason).filter(Boolean));
          results.needs_improvement.push(`Forms not testable: ${reasons.slice(0, 3).join("; ")}`);
        }
      });

      // Also mention categories that did pass (for context)
      categoriesWithAtLeastOnePass.forEach(cat => {
        if (cat === "phones") {
          results.needs_improvement.push(
            `Note: ${results.ctas.phones.passed} out of ${results.ctas.phones.tested} phone CTAs did pass`
          );
        } else if (cat === "emails") {
          results.needs_improvement.push(
            `Note: ${results.ctas.emails.passed} out of ${results.ctas.emails.tested} email CTAs did pass`
          );
        } else if (cat === "forms") {
          results.needs_improvement.push(
            `Note: ${formsPassed} out of ${formsTested} forms did pass`
          );
        }
      });
    }
    // PRIORITY 2: If ANY category present completely failed → FAIL
    else if (categoriesAllFailed.length > 0) {
      results.overall_status = "FAIL";
      results.why = `${categoriesAllFailed.map(cat => cat.charAt(0).toUpperCase() + cat.slice(1)).join(", ")} category completely failed - no CTAs tracking properly`;
      
      // Add specific failure details
      categoriesAllFailed.forEach(cat => {
        if (cat === "phones") {
          results.needs_improvement.push(
            `All ${results.ctas.phones.tested} phone CTAs failed to fire GA4 conversion events`
          );
        } else if (cat === "emails") {
          results.needs_improvement.push(
            `All ${results.ctas.emails.tested} email CTAs failed to fire GA4 conversion events`
          );
        } else if (cat === "forms") {
          results.needs_improvement.push(
            `All ${formsTested} forms failed to fire GA4 conversion events after successful submission`
          );
        }
      });
    }
    // PRIORITY 3: If ALL categories present have at least one pass → PASS
    else if (categoriesPresent.length > 0 && categoriesWithAtLeastOnePass.length === categoriesPresent.length) {
      results.overall_status = "PASS";
      results.why = "All CTA categories have at least one working conversion event";
      
      // Add needs improvement for partial failures
      if (results.ctas.phones.failed > 0) {
        const failedItems = results.ctas.phones.items.filter(i => i.status === "FAIL");
        results.needs_improvement.push(
          `${results.ctas.phones.failed} out of ${results.ctas.phones.tested} phone CTAs not tracking: ${failedItems.map(i => i.href).join(", ")}`
        );
      }
      if (results.ctas.emails.failed > 0) {
        const failedItems = results.ctas.emails.items.filter(i => i.status === "FAIL");
        results.needs_improvement.push(
          `${results.ctas.emails.failed} out of ${results.ctas.emails.tested} email CTAs not tracking: ${failedItems.map(i => i.href).join(", ")}`
        );
      }
      if (formsFailed > 0) {
        const failedForms = allFormResults.filter(f => f.status === "FAIL");
        results.needs_improvement.push(
          `${formsFailed} out of ${formsTested} forms not tracking properly (submitted but no conversion event)`
        );
      }
    }
    // Fallback
    else {
      results.overall_status = "NOT_TESTED";
      results.why = "No CTAs could be successfully tested";
    }

    results.evidence.network_beacons = beacons;

    logInfo("✅ Health check complete", {
      url: targetUrl,
      overall_status: results.overall_status,
      why: results.why,
      needs_improvement: results.needs_improvement,
      pages_visited: results.pages_visited.length,
      phones: `${results.ctas.phones.passed}/${results.ctas.phones.tested} passed`,
      emails: `${results.ctas.emails.passed}/${results.ctas.emails.tested} passed`,
      forms: `${formsPassed}/${formsTested} passed`,
    });

    return results;

  } catch (error) {
    logInfo("❌ Fatal error in health check", { url: targetUrl, error: error.message });
    results.ok = false;
    results.overall_status = "ERROR";
    results.why = `Fatal error: ${error.message}`;
    results.evidence.network_beacons = beacons;
    return results;
  } finally {
    const cleanupStart = Date.now();
    logDebug("Starting cleanup", { url: targetUrl });

    if (page) {
      try {
        page.removeAllListeners("request");
      } catch (e) {
        logDebug("Failed to remove request listeners", { error: e.message });
      }
    }

    if (page) {
      try {
        await page.close({ timeout: 5000 }).catch(() => null);
        logDebug("Page closed");
      } catch (e) {
        logDebug("Failed to close page", { error: e.message });
      }
    }

    if (context) {
      try {
        await context.close({ timeout: 5000 }).catch(() => null);
        logDebug("Context closed");
      } catch (e) {
        logDebug("Failed to close context", { error: e.message });
      }
    }

    if (browser) {
      try {
        await browser.close({ timeout: 10000 }).catch(() => null);
        logDebug("Browser closed");
      } catch (e) {
        logDebug("Failed to close browser gracefully, forcing...", { error: e.message });
        try {
          if (browser.process()) browser.process().kill("SIGKILL");
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
// Public API with timeout + concurrency
// ------------------------------
async function trackingHealthCheckSite(url) {
  await acquireCheckSlot();

  try {
    const result = await withTimeout(
      trackingHealthCheckSiteInternal(url),
      GLOBAL_TIMEOUT_MS,
      `Health check timed out after ${GLOBAL_TIMEOUT_MS}ms`
    );
    return result;
  } catch (error) {
    logInfo("❌ Health check failed or timed out", { url, error: error.message });

    return {
      ok: false,
      script_version: SCRIPT_VERSION,
      url: normaliseUrl(url),
      timestamp: nowIso(),

      overall_status: "ERROR",
      why: `Global timeout or error: ${error.message}`,
      needs_improvement: [],

      pages_visited: [],
      cookie_consent: { banner_found: false, accepted: false, details: null },
      tracking: {
        tags_found: { gtm: [], ga4: [], ignored_aw: [] },
        runtime: { gtm_loaded: false, ga_runtime_present: false },
        beacon_counts: { gtm: 0, ga4: 0 },
        has_tracking: false,
      },
      ctas: {
        phones: { found: 0, tested: 0, passed: 0, failed: 0, items: [] },
        emails: { found: 0, tested: 0, passed: 0, failed: 0, items: [] },
      },
      forms: { total_pages_with_forms: 0, pages: [] },
      evidence: { network_beacons: [] },
    };
  } finally {
    releaseCheckSlot();
  }
}

module.exports = {
  trackingHealthCheckSite,
};
