// /health.runners.js
// VERSION IDENTIFIER - Update this timestamp each time you push to GitHub
const SCRIPT_VERSION = "2026-02-05T16:40:00Z";

const { chromium } = require("playwright");

/**
 * Logging
 * - Default: info-level only (start/done/error)
 * - Set LOG_LEVEL=debug to get more details
 * - Set LOG_LEVEL=silent to suppress logs
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
const MAX_PAGES_TO_VISIT = Number(process.env.HEALTH_MAX_PAGES || 4); // home + 3
const MAX_PHONE_TESTS = Number(process.env.HEALTH_MAX_PHONE || 6);
const MAX_EMAIL_TESTS = Number(process.env.HEALTH_MAX_EMAIL || 6);
const NAV_TIMEOUT_MS = Number(process.env.HEALTH_NAV_TIMEOUT_MS || 45000);
const ACTION_WAIT_MS = Number(process.env.HEALTH_ACTION_WAIT_MS || 6500);
const INIT_WAIT_MS = Number(process.env.HEALTH_INIT_WAIT_MS || 3500);
const HEADLESS = (process.env.HEALTH_HEADLESS || "true").toLowerCase() !== "false";

// Test identity (safe / non-personal)
const TEST_VALUES = {
  firstName: "Test",
  lastName: "User",
  fullName: "Test User",
  email: process.env.HEALTH_TEST_EMAIL || "test+healthcheck@example.com",
  phone: process.env.HEALTH_TEST_PHONE || "07123456789",
  message:
    process.env.HEALTH_TEST_MESSAGE ||
    "Tracking health check test submission. Please ignore."
};

// Third-party providers to skip (forms)
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
  "cognitoforms"
];

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
  "request"
];

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
    await page.waitForTimeout(ms);
  } catch {
    // ignore
  }
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
// Cookie consent (best effort)
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
    } catch {
      // ignore
    }
  }

  // iframes (OneTrust/Cookiebot)
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
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  return out;
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

  const hasGtmTag = tagData.gtm.length > 0;
  const hasGa4Tag = tagData.ga4.length > 0;

  const hasAnyTracking =
    hasGtmTag ||
    hasGa4Tag ||
    tagData.gtmLoaded ||
    (tagData.gaRuntimePresent && beaconCounts.ga4 > 0);

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

  const links = await page.evaluate(() => {
    const out = [];
    const aTags = Array.from(document.querySelectorAll("a[href]"));
    for (const a of aTags) {
      const href = a.getAttribute("href") || "";
      const text = (a.textContent || "").trim().slice(0, 120);
      out.push({ href, text });
    }
    return out;
  });

  const abs = [];
  for (const l of links) {
    try {
      const u = new URL(l.href, baseUrl).toString();
      if (!origin) continue;
      if (!u.startsWith(origin)) continue;
      abs.push({ url: u, text: l.text });
    } catch {
      // ignore
    }
  }

  const scored = abs
    .map((x) => {
      const hay = `${x.url} ${x.text}`.toLowerCase();
      const score = CONTACT_PAGE_KEYWORDS.reduce((acc, k) => (hay.includes(k) ? acc + 1 : acc), 0);
      return { ...x, score };
    })
    .filter((x) => x.score > 0);

  const seen = new Set();
  const uniqueSorted = scored
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      if (seen.has(x.url)) return false;
      seen.add(x.url);
      return true;
    })
    .slice(0, Math.max(0, MAX_PAGES_TO_VISIT - 1));

  return uniqueSorted.map((x) => x.url);
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
  // Minimal escape for use inside CSS attribute selector quotes
  return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ------------------------------
// CTA test (click on the same page where first seen)
// PASS if a new GA4 beacon appears after click
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

    await loc.scrollIntoViewIfNeeded().catch(() => null);
    await safeWait(page, 300);
    await loc.hover().catch(() => null);
    await safeWait(page, 250);

    await loc.click({ force: true, timeout: 3000 }).catch((e) => {
      throw new Error(`click_failed: ${e.message}`);
    });

    await safeWait(page, ACTION_WAIT_MS);

    const after = beacons.length;
    const delta = after - before;
    const newGa4 = beacons.slice(before).filter((b) => b.type === "GA4");

    if (newGa4.length > 0) {
      return {
        status: "PASS",
        reason: null,
        beacons_delta: delta,
        ga4_events: uniq(newGa4.map((b) => b.event_name).filter(Boolean)),
        evidence_urls: newGa4.slice(0, 5).map((b) => b.url)
      };
    }

    return {
      status: "FAIL",
      reason: "no_ga4_beacon_after_click",
      beacons_delta: delta
    };
  } catch (e) {
    return { status: "NOT_TESTED", reason: e.message || "cta_test_error", beacons_delta: 0 };
  }
}

// ------------------------------
// Form detection (1 per page)
// ------------------------------
async function pickBestFirstPartyFormOnPage(page, pageUrl) {
  const iframeInfos = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll("iframe"));
    return iframes
      .map((f) => (f.getAttribute("src") || "").trim())
      .filter(Boolean);
  });

  const thirdPartyIframes = iframeInfos.filter((src) => containsAny(src.toLowerCase(), THIRD_PARTY_HINTS));

  const formCandidates = await page.evaluate(() => {
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
      const hasName =
        Array.from(inputs).some((x) => {
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
        if (!btn) return "";
        return textOf(btn);
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

      out.push({
        index: i,
        action,
        inputCount,
        hasEmail,
        hasTextarea,
        hasPhone,
        hasName,
        submitText,
        score
      });
    }

    out.sort((a, b) => (b.score - a.score) || (b.inputCount - a.inputCount));
    return out;
  });

  const best = formCandidates.find((f) => f.score >= 3) || null;

  let bestIsThirdPartyByAction = false;
  if (best && best.action) {
    try {
      const actionUrl = new URL(best.action, pageUrl);
      const pageOrigin = new URL(pageUrl).origin;
      const actionLower = actionUrl.href.toLowerCase();
      if (actionUrl.origin !== pageOrigin && containsAny(actionLower, THIRD_PARTY_HINTS)) {
        bestIsThirdPartyByAction = true;
      }
    } catch {
      // ignore
    }
  }

  return {
    third_party_iframes: thirdPartyIframes,
    best_form: best
      ? {
          ...best,
          third_party_by_action: bestIsThirdPartyByAction
        }
      : null
  };
}

// ------------------------------
// Form fill + submit (1 per page)
// ------------------------------
async function testBestFirstPartyForm(page, beacons, pageUrl, formMeta) {
  if (!formMeta || !formMeta.best_form) {
    return { status: "NOT_TESTED", reason: "no_first_party_form_found" };
  }
  if (formMeta.best_form.third_party_by_action) {
    return { status: "NOT_TESTED", reason: "third_party_form_action" };
  }

  const captchaFound = await page.evaluate(() => {
    const html = document.documentElement?.innerHTML?.toLowerCase() || "";
    const hasRecaptcha =
      !!document.querySelector("iframe[src*='recaptcha']") ||
      html.includes("g-recaptcha") ||
      html.includes("recaptcha");
    const hasHcaptcha =
      !!document.querySelector("iframe[src*='hcaptcha']") || html.includes("hcaptcha");
    return hasRecaptcha || hasHcaptcha;
  });
  if (captchaFound) return { status: "NOT_TESTED", reason: "captcha_present" };

  const formIndex = formMeta.best_form.index;
  const form = page.locator("form").nth(formIndex);

  try {
    if (!(await form.count())) return { status: "NOT_TESTED", reason: "form_locator_not_found" };
    await form.scrollIntoViewIfNeeded().catch(() => null);
    await safeWait(page, 400);

    const fields = form.locator("input, textarea, select");
    const fieldCount = await fields.count();
    if (fieldCount < 2) return { status: "NOT_TESTED", reason: "form_too_small" };

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
          continue;
        }

        if (type.toLowerCase() === "checkbox") {
          const shouldTick = /consent|agree|privacy|terms|gdpr|policy/.test(hay);
          if (shouldTick) {
            await el.check({ timeout: 1000 }).catch(() => null);
            await safeWait(page, 120);
          }
          continue;
        }

        if (tag === "textarea" || /message|enquir|inquir|comment/.test(hay)) {
          await el.fill(TEST_VALUES.message, { timeout: 1200 }).catch(() => null);
          await safeWait(page, 120);
          continue;
        }

        if (type.toLowerCase() === "email" || hay.includes("email")) {
          await el.fill(TEST_VALUES.email, { timeout: 1200 }).catch(() => null);
          await safeWait(page, 120);
          continue;
        }

        if (type.toLowerCase() === "tel" || hay.includes("phone") || hay.includes("tel")) {
          await el.fill(TEST_VALUES.phone, { timeout: 1200 }).catch(() => null);
          await safeWait(page, 120);
          continue;
        }

        if (/first/.test(hay) && /name/.test(hay)) {
          await el.fill(TEST_VALUES.firstName, { timeout: 1200 }).catch(() => null);
          await safeWait(page, 120);
          continue;
        }
        if (/last/.test(hay) && /name/.test(hay)) {
          await el.fill(TEST_VALUES.lastName, { timeout: 1200 }).catch(() => null);
          await safeWait(page, 120);
          continue;
        }
        if (/name/.test(hay)) {
          await el.fill(TEST_VALUES.fullName, { timeout: 1200 }).catch(() => null);
          await safeWait(page, 120);
          continue;
        }

        if (!type || type.toLowerCase() === "text") {
          await el.fill(TEST_VALUES.fullName, { timeout: 1200 }).catch(() => null);
          await safeWait(page, 120);
          continue;
        }
      } catch {
        // keep going
      }
    }

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
      } catch {
        // ignore
      }
    }
    if (!submit) return { status: "NOT_TESTED", reason: "no_submit_button_found" };

    const beforeBeaconIdx = beacons.length;
    const beforeUrl = page.url();

    await submit.scrollIntoViewIfNeeded().catch(() => null);

    let navigated = false;
    try {
      await Promise.race([
        page.waitForNavigation({ timeout: 9000 }).then(() => {
          navigated = true;
        }),
        submit.click({ timeout: 3000 }).then(() => null)
      ]);
    } catch {
      await submit.click({ force: true, timeout: 3000 }).catch(() => null);
    }

    await safeWait(page, ACTION_WAIT_MS);

    const afterUrl = page.url();
    const urlChanged = afterUrl !== beforeUrl;

    const successSignal = await page.evaluate(() => {
      const text = (document.body?.innerText || "").toLowerCase();
      return (
        text.includes("thank you") ||
        text.includes("thanks for") ||
        text.includes("message has been sent") ||
        text.includes("we will be in touch") ||
        text.includes("successfully sent")
      );
    });

    const submittedSuccessfully = urlChanged || navigated || successSignal;

    const newGa4 = beacons.slice(beforeBeaconIdx).filter((b) => b.type === "GA4");
    if (newGa4.length > 0) {
      return {
        status: "PASS",
        reason: null,
        submittedSuccessfully,
        submit_evidence: { urlChanged, successSignal, navigated, beforeUrl, afterUrl },
        ga4_events: uniq(newGa4.map((b) => b.event_name).filter(Boolean)),
        evidence_urls: newGa4.slice(0, 5).map((b) => b.url)
      };
    }

    if (submittedSuccessfully) {
      return {
        status: "FAIL",
        reason: "submitted_but_no_ga4_beacon",
        submittedSuccessfully,
        submit_evidence: { urlChanged, successSignal, navigated, beforeUrl, afterUrl }
      };
    }

    const validationText = await page
      .evaluate(() => {
        const els = Array.from(
          document.querySelectorAll(
            "[role='alert'], .error, .wpcf7-not-valid-tip, .wpcf7-response-output"
          )
        );
        const txt = els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 3);
        return txt.join(" | ");
      })
      .catch(() => "");

    return {
      status: "NOT_TESTED",
      reason: validationText ? `validation_blocked: ${validationText}` : "submit_not_confirmed"
    };
  } catch (e) {
    return { status: "NOT_TESTED", reason: e.message || "form_test_error" };
  }
}

// ------------------------------
// Main runner
// ------------------------------
async function trackingHealthCheckSite(url) {
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
      pages: [] // per page: { page_url, status, reason, meta... }
    },

    evidence: { network_beacons: [] },
    issues: [],
    site_status: "ERROR"
  };

  const beacons = [];

  const browser = await chromium.launch({
    headless: HEADLESS,
    timeout: 90000,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("request", (request) => {
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
  });

  try {
    logInfo(`🔍 [${SCRIPT_VERSION}] Starting tracking health check`, { url: targetUrl });

    // Phase 1: Load homepage
    const load = await safeGoto(page, targetUrl);
    if (!load.ok) throw new Error(load.error);
    results.pages_visited.push(page.url());

    await safeWait(page, INIT_WAIT_MS);

    // Phase 2: Cookies
    results.cookie_consent = await handleCookieConsent(page);
    await safeWait(page, 1200);

    // Phase 3: Tracking detect (gate)
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

    // Phase 4: Discover pages
    const discovered = await discoverCandidatePages(page, targetUrl);
    const pagesToVisit = [targetUrl, ...discovered].slice(0, MAX_PAGES_TO_VISIT);

    // CTA tracking (Option A):
    // - Collect and test CTAs on the FIRST page where they appear
    const allPhonesNorm = new Set();
    const allEmailsNorm = new Set();
    const testedPhonesNorm = new Set();
    const testedEmailsNorm = new Set();

    // Phase 5: Visit pages, scan CTAs, test new unique CTAs on that same page, test 1 form per page
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

      // Scan CTAs
      const ctas = await scanCTAsOnPage(page);

      // Phones: record + test first-seen unique (respect max tests)
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
            evidence_urls: item.evidence_urls || []
          });
        }
      }

      // Emails: record + test first-seen unique (respect max tests)
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
            evidence_urls: item.evidence_urls || []
          });
        }
      }

      // Forms: pick best first-party form and test it (1 per page)
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
        submittedSuccessfully: formTest.submittedSuccessfully ?? null,
        submit_evidence: formTest.submit_evidence ?? null,
        ga4_events: formTest.ga4_events ?? [],
        evidence_urls: formTest.evidence_urls ?? []
      });

      await safeWait(page, 400);
    }

    // Final CTA found counts (unique across site)
    results.ctas.phones.found = allPhonesNorm.size;
    results.ctas.emails.found = allEmailsNorm.size;

    // Phase 6: Summarise site status
    const anyCtaPass =
      results.ctas.phones.items.some((x) => x.status === "PASS") ||
      results.ctas.emails.items.some((x) => x.status === "PASS");

    const formPass = results.forms.pages.some((x) => x.status === "PASS");
    const formFail = results.forms.pages.some((x) => x.status === "FAIL");

    const ctaFail =
      results.ctas.phones.items.some((x) => x.status === "FAIL") ||
      results.ctas.emails.items.some((x) => x.status === "FAIL");

    const anyPass = anyCtaPass || formPass;

    if (anyPass && (formFail || ctaFail)) results.site_status = "PARTIAL";
    else if (anyPass) results.site_status = "HEALTHY";
    else if (formFail || ctaFail) results.site_status = "BROKEN";
    else results.site_status = "NOT_FULLY_TESTED";

    if (formFail) results.issues.push("At least one form submitted but no GA4 beacon fired");
    if (ctaFail) results.issues.push("At least one CTA click produced no GA4 beacon");

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
    try {
      await browser.close();
    } catch {
      // ignore
    }
  }
}

module.exports = {
  trackingHealthCheckSite
};
