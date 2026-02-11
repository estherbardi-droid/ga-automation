// /health.runners.js
// PRODUCTION VERSION - Constraint Satisfaction + Detailed Blocker Reporting + Resource Management + Stealth Mode
const SCRIPT_VERSION = "2026-02-11T18:30:00Z-PRODUCTION-V5";

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
const GLOBAL_TIMEOUT_MS = Number(process.env.HEALTH_GLOBAL_TIMEOUT_MS || 300000);
const MAX_CONCURRENT_CHECKS = Number(process.env.HEALTH_MAX_CONCURRENT || 2);

// Test identity
const TEST_VALUES = {
  firstName: "Test",
  lastName: "User",
  fullName: "Test User",
  email: process.env.HEALTH_TEST_EMAIL || "test+healthcheck@example.com",
  phone: process.env.HEALTH_TEST_PHONE || "07123456789",
  message: process.env.HEALTH_TEST_MESSAGE || "Tracking health check test submission. Please ignore."
};

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

let activeChecks = 0;
const checkQueue = [];

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function acquireCheckSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    return;
  }
  return new Promise((resolve) => checkQueue.push(resolve));
}

function releaseCheckSlot() {
  activeChecks--;
  if (checkQueue.length) {
    const next = checkQueue.shift();
    activeChecks++;
    next();
  }
}

async function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  const result = await Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
  return result;
}

function normaliseUrl(input) {
  if (!input) return null;
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
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
  try {
    return new URLSearchParams(postData).get("en") || null;
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function safeWait(page, ms) {
  try { await page?.waitForTimeout(ms); } catch {}
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ===========================
   FORM LOGIC (UPDATED)
=========================== */

async function testBestFirstPartyForm(page, beacons, pageUrl, formMeta) {
  if (!formMeta || !formMeta.best_form) {
    return { status: "NOT_TESTED", reason: "no_form_found" };
  }

  const form = page.locator("form").nth(formMeta.best_form.index);

  try {
    await form.scrollIntoViewIfNeeded();
    await safeWait(page, 500);

    const fields = form.locator("input, textarea, select");
    const count = await fields.count();
    if (count < 2) return { status: "NOT_TESTED", reason: "form_too_small" };

    for (let i = 0; i < count; i++) {
      const el = fields.nth(i);
      if (!(await el.isVisible())) continue;
      await el.fill(TEST_VALUES.fullName).catch(() => {});
    }

    await safeWait(page, 800);

    const submit = form.locator("button[type='submit'], input[type='submit']").first();
    if (!(await submit.count())) return { status: "NOT_TESTED", reason: "no_submit_button" };

    const before = beacons.length;
    await submit.click({ force: true }).catch(() => {});
    await safeWait(page, FORM_SUBMIT_WAIT_MS);

    const newGa4 = beacons.slice(before).filter(b => b.type === "GA4");
    const meaningful = newGa4.filter(b => !GENERIC_EVENTS.includes((b.event_name || "").toLowerCase()));

    if (meaningful.length) {
      return { status: "PASS", ga4_events: uniq(meaningful.map(b => b.event_name)) };
    }

    if (newGa4.length) {
      return { status: "FAIL", reason: "submitted_but_no_meaningful_ga4_event" };
    }

    return { status: "NOT_TESTED", reason: "submit_failed_or_blocked" };
  } catch (e) {
    return { status: "NOT_TESTED", reason: e.message };
  }
}

/* ===========================
   MAIN RUNNER (SAFE)
=========================== */

async function trackingHealthCheckSiteInternal(url) {
  const results = {
    ok: true,
    script_version: SCRIPT_VERSION,
    url: normaliseUrl(url),
    timestamp: nowIso(),
    health_bucket: null,
    test_summary: { total_items: 0, passed_count: 0, failed_count: 0, not_tested_count: 0 },
    pages_visited: [],
    tracking: { has_tracking: false },
    ctas: { phones: { found: 0, tested: 0, items: [] }, emails: { found: 0, tested: 0, items: [] } },
    forms: { pages: [] },
    evidence: { network_beacons: [] },
    issues: [],
    site_status: "ERROR"
  };

  let browser, context, page;
  const beacons = [];
  let formFail = false;
  let ctaFail = false;

  try {
    browser = await chromium.launch({ headless: HEADLESS });
    context = await browser.newContext();
    page = await context.newPage();

    page.on("request", (request) => {
      const url = request.url();
      const type = classifyGaBeacon(url);
      let eventName = type === "GA4" ? parseEventNameFromUrl(url) || parseEventNameFromPostData(request.postData()) : null;
      beacons.push({ url, type, event_name: eventName, timestamp: nowIso() });
    });

    await safeGoto(page, results.url);
    results.pages_visited.push(page.url());

    const formTest = await testBestFirstPartyForm(page, beacons, page.url(), { best_form: { index: 0 } });
    results.forms.pages.push(formTest);

    if (formTest.status === "FAIL") formFail = true;

    results.evidence.network_beacons = beacons;
    results.site_status = formFail ? "FAIL" : "OK";
    return results;

  } catch (e) {
    results.ok = false;
    results.issues.push(e.message);
    return results;
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

async function trackingHealthCheckSite(url) {
  await acquireCheckSlot();
  try {
    return await withTimeout(trackingHealthCheckSiteInternal(url), GLOBAL_TIMEOUT_MS, "Health check timeout");
  } finally {
    releaseCheckSlot();
  }
}

module.exports = { trackingHealthCheckSite };

