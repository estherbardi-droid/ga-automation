// /health-check-v15.js
// INTELLIGENT TRACKING HEALTH CHECK
// Features: Specific Reason Outputs, Bot Detection Flagging, GTM-GA4 Linking, Real Form Submission, Categorized Reporting
const SCRIPT_VERSION = "2026-03-05T12:00:00Z-V15-SPECIFIC-OUTPUTS";

const { chromium } = require("playwright");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

/** Logging */
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
function logInfo(msg, data = null) {
  if (LOG_LEVEL === "silent") return;
  const ts = new Date().toISOString();
  if (data) console.log(`[${ts}] ${msg}`, JSON.stringify(data, null, 2));
  else console.log(`[${ts}] ${msg}`);
}
function logDebug(msg, data = null) {
  if (LOG_LEVEL === "debug") logInfo(msg, data);
}

// ------------------------------
// Configuration
// ------------------------------
const MAX_PAGES_TO_VISIT = Number(process.env.HEALTH_MAX_PAGES || 3);
const MAX_PHONE_TESTS = Number(process.env.HEALTH_MAX_PHONE || 10);
const MAX_EMAIL_TESTS = Number(process.env.HEALTH_MAX_EMAIL || 10);
const NAV_TIMEOUT_MS = Number(process.env.HEALTH_NAV_TIMEOUT_MS || 25000);
const INIT_WAIT_MS = Number(process.env.HEALTH_INIT_WAIT_MS || 1500);
const HEADLESS = true;
const POST_ACTION_POLL_MS = Number(process.env.HEALTH_POST_ACTION_POLL_MS || 4000); 
const FORM_SUBMIT_WAIT_MS = Number(process.env.HEALTH_FORM_WAIT_MS || 8000);     
const GLOBAL_TIMEOUT_MS = Number(process.env.HEALTH_GLOBAL_TIMEOUT_MS || 200000); 
const MAX_CONCURRENT_CHECKS = Number(process.env.HEALTH_MAX_CONCURRENT || 10);

const TEST_VALUES = {
  firstName: "Add", lastName: "People", fullName: "Add People",
  email: process.env.HEALTH_TEST_EMAIL || "test@addpeople.com",
  phone: process.env.HEALTH_TEST_PHONE || "01632960123",
  message: process.env.HEALTH_TEST_MESSAGE || "This is a tracking health check. Please ignore.",
  company: "Test Company", postcode: "SW1A 1AA", city: "London",
  address: "1 Test Street", subject: "General Enquiry",
  date: "2026-12-31", number: "1"
};

const GENERIC_EVENTS = ["page_view", "user_engagement", "scroll", "session_start", "first_visit", "form_start"];
const CONTACT_PAGE_KEYWORDS = ["contact", "get-in-touch", "getintouch", "enquire", "enquiry", "inquire", "inquiry", "quote", "estimate", "book", "booking", "appointment", "consultation", "request"];
const COMMON_CONTACT_PATHS = ["/contact", "/contact-us", "/contact-us/", "/contactus", "/get-in-touch", "/get-in-touch/", "/enquiry", "/enquire", "/book", "/booking"];
const THIRD_PARTY_HINTS = ["hubspot", "hsforms", "jotform", "typeform", "google.com/forms", "forms.gle", "calendly", "marketo", "pardot", "salesforce", "formstack", "wufoo", "cognitoforms"];
const SOCIAL_DOMAINS = ["facebook.com", "twitter.com", "instagram.com", "linkedin.com", "tiktok.com", "pinterest.com", "youtube.com", "whatsapp.com", "snapchat.com", "t.co", "lnkd.in", "fb.com"];

// Concurrency control
let activeChecks = 0;
const checkQueue = [];

// GLOBAL BROWSER (Prevents Memory Leaks)
let globalBrowser = null;
let browserUses = 0;
const MAX_BROWSER_USES = 100;

async function getBrowser() {
  if (globalBrowser && browserUses >= MAX_BROWSER_USES) {
    logDebug("Recycling browser to prevent memory leaks...");
    await globalBrowser.close().catch(() => null);
    globalBrowser = null;
    browserUses = 0;
  }
  if (!globalBrowser) {
    globalBrowser = await chromium.launch({
      headless: HEADLESS,
      timeout: 60000,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage", "--disable-gpu", "--proxy-server='direct://'", "--proxy-bypass-list=*"
      ],
    });
  }
  browserUses++;
  return globalBrowser;
}

// ------------------------------
// Utility Functions
// ------------------------------
function normaliseUrl(input) { let u = (input || "").trim(); return /^https?:\/\//i.test(u) ? u : `https://${u}`; }
function safeUrlObj(u) { try { return new URL(u); } catch { return null; } }
function uniq(arr) { return [...new Set((arr || []).filter(Boolean))]; }
function escapeAttrValue(v) { return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function nowIso() { return new Date().toISOString(); }

// ANTI-CRASH WRAPPER
async function safeEvaluate(page, func, ...args) {
  try {
    return await page.evaluate(func, ...args);
  } catch (e) {
    if (e.message.includes("Execution context was destroyed") || e.message.includes("Target closed")) {
      await safeWait(page, 2000); 
      try { return await page.evaluate(func, ...args); } catch (e2) { return null; }
    }
    return null; 
  }
}

function classifyGaBeacon(reqUrl) {
  const u = (reqUrl || "").toLowerCase();
  if (u.includes("/g/collect") || u.includes("/r/collect")) return "GA4";
  if (u.includes("gtag/js")) return "GTAG"; 
  if (u.includes("google-analytics.com")) return "GA";
  if (u.includes("googletagmanager.com") || u.includes("gtm.js")) return "GTM";
  return "OTHER";
}

function parseEventNameFromUrl(reqUrl) { try { return new URL(reqUrl).searchParams.get("en") || null; } catch { return null; } }
function parseEventNameFromPostData(postData) {
  if (!postData || typeof postData !== "string") return null;
  try { return new URLSearchParams(postData).get("en") || null; } catch { return null; }
}

async function safeWait(page, ms) { try { page ? await page.waitForTimeout(ms) : await new Promise((r) => setTimeout(r, ms)); } catch {} }

async function safeGoto(page, url) {
  if (SOCIAL_DOMAINS.some(domain => url.toLowerCase().includes(domain))) {
    return { ok: false, error: "Blocked social domain navigation" };
  }
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return { ok: true, mode: "domcontentloaded" };
  } catch (e1) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: 15000 });
      return { ok: true, mode: "commit" };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }
}

// ------------------------------
// Concurrency Management
// ------------------------------
async function acquireCheckSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) { activeChecks++; return; }
  return new Promise((r) => { checkQueue.push(r); });
}
function releaseCheckSlot() {
  activeChecks--;
  if (checkQueue.length > 0) { const next = checkQueue.shift(); activeChecks++; next(); }
}
async function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs));
  try { const result = await Promise.race([promise, timeoutPromise]); clearTimeout(timeoutId); return result; } 
  catch (error) { clearTimeout(timeoutId); throw error; }
}

async function simulateHumanBrowsing(page) {
  try {
    await safeEvaluate(page, () => {
      window.scrollBy(0, Math.max(800, document.body.scrollHeight / 2));
    });
    await safeWait(page, 400); 
    const viewport = page.viewportSize();
    if (viewport) await page.mouse.move(Math.random() * viewport.width, Math.random() * viewport.height, { steps: 5 });
    
    await safeEvaluate(page, () => window.scrollTo(0, 0));
    await safeWait(page, 200);
  } catch {}
}

async function handleCookieConsent(page) {
  const out = { banner_found: false, accepted: false, details: null };
  const candidates = [
    "#onetrust-accept-btn-handler", // OneTrust
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", // Cookiebot
    ".cmplz-accept", // Complianz
    "#wt-cli-accept-all-btn", ".wt-cli-accept-all-btn", // CookieYes
    "#cookie_action_close_header", // Cookie Law Info
    "button:has-text('Accept')", "button:has-text('Accept All')", "button:has-text('Accept all')",
    "button:has-text('I Accept')", "button:has-text('Agree')", "button:has-text('OK')", "button:has-text('Allow all')",
    "button:has-text('Allow All')", "a:has-text('Accept')", ".cookie-accept", ".accept-cookies",
    "[id*='accept'][role='button']", "[class*='accept'][role='button']", "[aria-label*='accept' i]"
  ];

  try {
    const clicked = await safeEvaluate(page, (selectors) => {
      for (const sel of selectors) {
        let els = document.querySelectorAll(sel.includes(':has-text') ? 'button, a' : sel);
        for (let el of els) {
          if (sel.includes(':has-text') && !el.textContent.match(new RegExp(sel.match(/'([^']+)'/)[1], 'i'))) continue;
          if (el.offsetHeight > 0 && el.offsetWidth > 0) { el.click(); return { found: true, selector: sel }; }
        }
      }
      return false;
    }, candidates);

    if (clicked) {
      out.banner_found = true; out.accepted = true; out.details = { selector: clicked.selector };
      await safeWait(page, 400);
    }
  } catch {}
  return out;
}

// ------------------------------
// Tracking Detection (GTM Linking Check)
// ------------------------------
async function detectTrackingSetup(page, beacons) {
  let tagData = await safeEvaluate(page, () => {
    const tags = { gtm: [], ga4: [] };
    const extract = (str) => {
      if (typeof str !== 'string') return;
      const upper = str.toUpperCase();
      tags.gtm.push(...(upper.match(/GTM-[A-Z0-9]+/g) || []));
      tags.ga4.push(...(upper.match(/G-[A-Z0-9]+/g) || []));
    };
    for (const s of document.querySelectorAll("script")) { extract(s.innerHTML); extract(s.src); }
    if (Array.isArray(window.dataLayer)) { window.dataLayer.forEach(push => { try { extract(JSON.stringify(push)); } catch(e){} }); }
    if (window.google_tag_manager) { Object.keys(window.google_tag_manager).forEach(key => extract(key)); }
    return { gtm: Array.from(new Set(tags.gtm)), ga4: Array.from(new Set(tags.ga4)) };
  });

  if (!tagData) tagData = { gtm: [], ga4: [] };

  const gtmContainers = new Set(tagData.gtm);
  const linkedGa4Tags = new Set();
  const unlinkedGa4Tags = new Set();

  beacons.forEach(b => {
    const urlUpper = b.url.toUpperCase();
    const gtmMatches = urlUpper.match(/GTM-[A-Z0-9]+/g);
    if (gtmMatches) gtmMatches.forEach(id => gtmContainers.add(id));

    if (b.type === "GA4") {
      try {
        const urlObj = new URL(b.url);
        const tid = urlObj.searchParams.get("tid"); // G-XXXXXX
        const gtmHash = urlObj.searchParams.get("gtm"); // Hash ID confirming linkage
        if (tid) {
          if (gtmHash) linkedGa4Tags.add(tid);
          else unlinkedGa4Tags.add(tid);
        }
      } catch {}
    }
  });

  const finalGtm = Array.from(gtmContainers);
  const finalLinkedGa4 = Array.from(linkedGa4Tags);
  const finalUnlinkedGa4 = Array.from(unlinkedGa4Tags);
  
  // Merge DOM found GA4s into unlinked if not in linked
  tagData.ga4.forEach(tid => {
    if (!linkedGa4Tags.has(tid)) finalUnlinkedGa4.push(tid);
  });

  return { 
    tags_found: {
      gtm: finalGtm,
      ga4: finalLinkedGa4, // We ONLY return linked ones as valid
      unlinked_ga4: uniq(finalUnlinkedGa4)
    },
    has_gtm: finalGtm.length > 0,
    has_linked_ga4: finalLinkedGa4.length > 0,
    has_any_ga4: finalLinkedGa4.length > 0 || finalUnlinkedGa4.length > 0
  };
}

// ------------------------------
// Page Discovery & CTAs
// ------------------------------
async function discoverCandidatePages(page, baseUrl) {
  const currentUrl = page.url(); 
  const origin = safeUrlObj(currentUrl)?.origin || safeUrlObj(baseUrl)?.origin || null;

  let links = await safeEvaluate(page, () => Array.from(document.querySelectorAll("a[href]")).map((a) => ({ href: a.getAttribute("href") || "", text: (a.textContent || "").trim().slice(0, 120) })));
  if (!links) links = [];

  const scored = links
    .map((l) => { 
      try { 
        const u = new URL(l.href, currentUrl);
        u.hash = ''; 
        if (SOCIAL_DOMAINS.some(d => u.hostname.includes(d))) return null;
        if (origin && !u.toString().startsWith(origin)) return null;
        return { url: u.toString(), text: l.text }; 
      } catch { return null; } 
    })
    .filter(Boolean)
    .map(x => ({ ...x, score: CONTACT_PAGE_KEYWORDS.reduce((acc, k) => (`${x.url} ${x.text}`.toLowerCase().includes(k) ? acc + 1 : acc), 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const seen = new Set();
  const uniqueSorted = scored.filter(x => { if (seen.has(x.url)) return false; seen.add(x.url); return true; });

  const firstContact = uniqueSorted.find(x => /contact/.test(x.url.toLowerCase()));
  let discovered = [firstContact?.url, ...uniqueSorted.filter(x => x !== firstContact).map(x => x.url)].filter(Boolean).slice(0, Math.max(0, MAX_PAGES_TO_VISIT - 1));

  if (discovered.length === 0 && origin) {
    for (const p of COMMON_CONTACT_PATHS) {
      if (!seen.has(origin + p)) { discovered.push(origin + p); if (discovered.length >= MAX_PAGES_TO_VISIT - 1) break; }
    }
  }
  return discovered;
}

async function scanCTAsOnPage(page) {
  let ctas = await safeEvaluate(page, () => ({
    phones: Array.from(document.querySelectorAll("a[href^='tel:' i]")).map(a => a.getAttribute("href")).filter(Boolean),
    emails: Array.from(document.querySelectorAll("a[href^='mailto:' i]")).map(a => a.getAttribute("href")).filter(Boolean)
  }));
  return ctas || { phones: [], emails: [] };
}

function normaliseTelHref(href) { return href ? href.replace(/\s+/g, "").toLowerCase() : null; }
function normaliseMailtoHref(href) { return href ? href.trim().toLowerCase() : null; }

async function testLinkCTA(page, beacons, rawHref, type) {
  const before = beacons.length;
  const hrefEsc = escapeAttrValue(rawHref);
  const selector = `a[href="${hrefEsc}" i]`;
  const ctaSearchValue = type === "phone" ? rawHref.replace(/[^\w\+]/g, "").toLowerCase() : rawHref.replace(/mailto:/i, "").toLowerCase();

  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count())) return { status: "NOT_TESTED", reason: "CTA not found", beacons_delta: 0 };

    await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => null);
    await safeWait(page, 200);

    try { await loc.click({ timeout: 2000, noWaitAfter: true }); } 
    catch { await loc.click({ force: true, timeout: 2000, noWaitAfter: true }).catch(() => safeEvaluate(page, el => el.click(), loc).catch(() => null)); }

    const start = Date.now();
    while (Date.now() - start < POST_ACTION_POLL_MS) {
      const newGa4 = beacons.slice(before).filter((b) => b.type === "GA4");
      const meaningfulEvents = newGa4.filter(b => {
        const en = (b.event_name || "").toLowerCase();
        if (GENERIC_EVENTS.includes(en)) return false;
        const payload = (b.payload_dump || "");
        const hasValue = payload.includes(ctaSearchValue);
        const isConversionName = /call|phone|email|mailto|contact|lead|submit|click/i.test(en);
        return hasValue || isConversionName;
      });

      if (meaningfulEvents.length) {
        return { status: "PASS", beacons_delta: beacons.length - before, ga4_events: uniq(meaningfulEvents.map(b => b.event_name)), evidence_urls: meaningfulEvents.slice(0, 5).map(b => b.url) };
      }
      await safeWait(page, 250); 
    }
    const allNewGa4 = beacons.slice(before).filter((b) => b.type === "GA4");
    return { status: "FAIL", reason: allNewGa4.length ? "Only generic events fired" : "No GA4 beacon fired", beacons_delta: beacons.length - before, generic_events_seen: uniq(allNewGa4.map(b => b.event_name)) };
  } catch (e) {
    return { status: "NOT_TESTED", reason: e.message, beacons_delta: 0 };
  }
}

// ------------------------------
// FORM DETECTION
// ------------------------------
async function discoverAllFormsOnPage(page, pageUrl) {
  let formCandidates = await safeEvaluate(page, (pageUrl) => {
    const forms = Array.from(document.querySelectorAll("form"));
    const out = [];
    function textOf(el) { return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400); }
    function attr(el, name) { return (el && el.getAttribute && el.getAttribute(name)) || ""; }
    function has(el, selector) { try { return !!el.querySelector(selector); } catch { return false; } }

    for (let i = 0; i < forms.length; i++) {
      const f = forms[i];
      const action = attr(f, "action");
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
        const btn = f.querySelector("button[type='submit']") || f.querySelector("input[type='submit']") ||
          Array.from(f.querySelectorAll("button")).find((b) => /send|submit|enquir|quote|request|book|contact/i.test(textOf(b))) || null;
        return btn ? textOf(btn) : "";
      })();

      const aroundText = textOf(f.closest("section") || f.closest("div") || f.parentElement);
      const hay = `${attr(f, "id")} ${attr(f, "class")} ${submitText} ${aroundText}`.toLowerCase();

      const hasSearchInput = has(f, "input[type='search']") || Array.from(inputs).some(x => /search|keyword/i.test(attr(x, "name")));
      const searchLikeSubmit = /search|find|filter/i.test(submitText);
      const isSearchLike = hasSearchInput || searchLikeSubmit || (/search/.test(hay) && inputCount <= 3 && !hasEmail);
      
      let score = 0;
      if (isSearchLike) score -= 999;
      if (/newsletter|subscribe/.test(hay) && !hasTextarea) score -= 999;
      if (/login|sign in/.test(hay)) score -= 999;

      if (hasTextarea) score += 3;
      if (hasEmail && hasName) score += 3;
      if (hasEmail) score += 2;
      if (hasName) score += 1;
      if (hasPhone) score += 1;
      if (/send|submit|enquir|request|contact/i.test(submitText)) score += 2;

      out.push({ index: i, action, inputCount, hasEmail, hasTextarea, hasPhone, hasName, submitText, score });
    }
    return out;
  }, pageUrl);
  
  if (!formCandidates) formCandidates = [];

  const leadForms = formCandidates.filter(f => f.score >= 3);
  leadForms.sort((a, b) => b.score - a.score || b.inputCount - a.inputCount);

  const firstPartyForms = [];
  const thirdPartyForms = [];
  for (const f of leadForms) {
    let isThirdParty = false;
    if (f.action) {
      try {
        const actionUrl = new URL(f.action, pageUrl);
        const actionLower = actionUrl.href.toLowerCase();
        if (actionUrl.origin !== new URL(pageUrl).origin && THIRD_PARTY_HINTS.some(hint => actionLower.includes(hint))) {
          isThirdParty = true;
        }
      } catch {}
    }
    if (isThirdParty) thirdPartyForms.push(f);
    else firstPartyForms.push(f);
  }

  let iframeInfos = await safeEvaluate(page, () => Array.from(document.querySelectorAll("iframe")).map(f => f.getAttribute("src") || ""));
  if (!iframeInfos) iframeInfos = [];
  const thirdPartyIframes = iframeInfos.filter(src => src && THIRD_PARTY_HINTS.some(hint => src.toLowerCase().includes(hint)));

  return { firstPartyForms, thirdPartyForms, thirdPartyIframes, totalLeadForms: leadForms.length, totalFormsScanned: formCandidates.length };
}

// ------------------------------
// FAST FIELD FILLING
// ------------------------------
async function detectFieldType(element, page) {
  try {
    const tag = await element.evaluate((el) => el.tagName.toLowerCase()).catch(()=>"");
    const type = (await element.getAttribute("type").catch(()=>"")) || "";
    const name = (await element.getAttribute("name").catch(()=>"")) || "";
    const id = (await element.getAttribute("id").catch(()=>"")) || "";
    const combined = `${type} ${name} ${id}`.toLowerCase();

    if (tag === "select") return { type: "select", tag };
    if (type === "checkbox") return { type: "checkbox", tag };
    if (type === "radio") return { type: "radio", tag };
    if (type === "hidden") return { type: "hidden", tag };
    
    if (type === "date") return { type: "date", tag };
    if (type === "number") return { type: "number", tag };

    if (/email/.test(combined)) return { type: "email", tag };
    if (/phone|tel|mobile/.test(combined)) return { type: "phone", tag };
    if (/first.*name|fname/.test(combined)) return { type: "first_name", tag };
    if (/last.*name|lname/.test(combined)) return { type: "last_name", tag };
    if (/^name$|full.*name/.test(combined)) return { type: "full_name", tag };
    if (/message|enquiry/.test(combined) || tag === "textarea") return { type: "message", tag };
    
    return { type: "text", tag };
  } catch { return { type: "unknown", tag: "unknown" }; }
}

async function fillFormFieldSmart(page, element, fieldInfo) {
  try {
    const { type, tag } = fieldInfo;
    if (type === "hidden") return { success: true };

    const isVisible = await element.isVisible({ timeout: 300 }).catch(() => false);
    if (!isVisible) return { success: true }; 

    if (tag === "select") {
      await element.evaluate((sel) => {
        const validOptions = Array.from(sel.querySelectorAll("option")).filter(opt => opt.value && opt.value !== "0" && !opt.textContent.toLowerCase().includes("select"));
        if (validOptions.length > 0) { sel.value = validOptions[0].value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }).catch(()=>null);
      return { success: true };
    }

    if (type === "checkbox" || type === "radio") {
      await element.check({ timeout: 1000, force: true }).catch(() => null);
      return { success: true };
    }

    const valueMap = {
      email: TEST_VALUES.email, phone: TEST_VALUES.phone, first_name: TEST_VALUES.firstName,
      last_name: TEST_VALUES.lastName, full_name: TEST_VALUES.fullName, message: TEST_VALUES.message,
      date: TEST_VALUES.date, number: TEST_VALUES.number
    };
    const value = valueMap[type] || TEST_VALUES.fullName;

    await element.fill(value, { timeout: 1000 }).catch(async () => {
      await element.click({ force: true, timeout: 500 }).catch(() => null);
      await safeEvaluate(page, (el, val) => {
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, element, value).catch(() => null);
    });
    return { success: true };
  } catch (err) { return { success: false, reason: err.message }; }
}

// ------------------------------
// CONSTRAINT SATISFACTION
// ------------------------------
async function detectSubmissionBlockers(page, form, submitButton) {
  const blockers = { submitDisabled: false, requiredFieldsEmpty: [], requiredCheckboxesUnchecked: [], requiredRadiosUnselected: [], validationErrors: [] };

  try { blockers.submitDisabled = await submitButton.isDisabled().catch(() => false); } catch {}

  try {
    const requiredFields = await form.locator("input[required], textarea[required], select[required]").all();
    for (const field of requiredFields) {
      const isVisible = await field.isVisible().catch(() => false);
      if (!isVisible) continue; 

      const value = await field.inputValue().catch(() => "");
      const tag = await field.evaluate(el => el.tagName.toLowerCase()).catch(()=>"");

      if (!value && tag !== "select") {
        const name = await field.getAttribute("name").catch(() => "");
        blockers.requiredFieldsEmpty.push({ name: name || "unknown" });
      } else if (tag === "select") {
        const selectedValue = await field.evaluate(sel => sel.value).catch(()=>"");
        if (!selectedValue || selectedValue === "" || selectedValue === "0") {
          blockers.requiredFieldsEmpty.push({ name: await field.getAttribute("name").catch(()=>"") || "unknown" });
        }
      }
    }
  } catch {}

  try {
    const requiredCheckboxes = await form.locator('input[type="checkbox"][required]').all();
    for (const checkbox of requiredCheckboxes) {
      if (await checkbox.isVisible().catch(()=>false) && !(await checkbox.isChecked().catch(()=>false))) {
        blockers.requiredCheckboxesUnchecked.push({ name: await checkbox.getAttribute("name").catch(()=>"") });
      }
    }
  } catch {}

  try {
    const errorSelectors = ['[role="alert"]', ".error", ".invalid-feedback", ".field-error", ".validation-error", ".wpcf7-not-valid-tip"];
    for (const selector of errorSelectors) {
      for (const error of await page.locator(selector).all()) {
        if (await error.isVisible().catch(()=>false)) {
          const text = await error.textContent().catch(()=>"");
          if (text && text.trim()) blockers.validationErrors.push(text.trim());
        }
      }
    }
  } catch {}
  return blockers;
}

async function fixSubmissionBlockers(page, form, blockers) {
  let fixed = false;
  for (const checkbox of blockers.requiredCheckboxesUnchecked) {
    try {
      const el = form.locator(`input[type="checkbox"][name="${checkbox.name}"]`).first();
      if (await el.count()) { await el.check({ timeout: 1500, force: true }).catch(() => null); fixed = true; }
    } catch {}
  }
  for (const field of blockers.requiredFieldsEmpty) {
    try {
      const el = form.locator(`[name="${field.name}"]`).first();
      if (await el.count()) { await fillFormFieldSmart(page, el, await detectFieldType(el, page)); fixed = true; }
    } catch {}
  }
  return fixed;
}

// ------------------------------
// STRICT TEST FORMS (Multi-Stage Support)
// ------------------------------
async function testFirstPartyForm(page, beacons, pageUrl, formMeta) {
  try {
    const form = page.locator("form").nth(formMeta.index);
    if (!(await form.count())) return { status: "NOT_TESTED", reason: "Form could not be fired (Element not found)" };

    let currentStep = 0;
    const maxSteps = 3;
    let submittedSuccessfully = false;
    let meaningfulEvents = [];
    let newGa4 = [];
    let captchaDetected = false;
    const beforeBeaconIdx = beacons.length;
    const beforeUrl = page.url();

    // Loop to handle up to 3 stages of a multi-stage form
    while (currentStep <= maxSteps && !submittedSuccessfully) {
      
      const fields = form.locator("input:visible, textarea:visible, select:visible");
      const fieldCount = await fields.count();

      for (let i = 0; i < fieldCount; i++) {
        const el = fields.nth(i);
        const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => "");
        const type = await el.getAttribute("type").catch(() => "");
        
        const isCheckable = type === "checkbox" || type === "radio";
        
        if (isCheckable) {
           if (!(await el.isChecked().catch(() => false))) {
               await fillFormFieldSmart(page, el, { type, tag });
           }
        } else {
           const val = await el.inputValue().catch(()=>"");
           if (!val || val === "0") {
              await fillFormFieldSmart(page, el, await detectFieldType(el, page));
           }
        }
      }

      const submitCandidates = ["button[type='submit']", "input[type='submit']", "button:has-text('Send')", "button:has-text('Submit')", "button:has-text('Enquire')", "button:has-text('Get Quote')"];
      const nextCandidates = ["button:has-text('Next')", "button:has-text('Continue')", "button:has-text('Step 2')", "button:has-text('Step 3')", ".next-step"];
      
      let btn = null;
      let isNextBtn = false;

      for (const sel of submitCandidates) {
        const loc = form.locator(sel).first();
        if (await loc.count() && await loc.isVisible({ timeout: 200 }).catch(()=>false)) { btn = loc; break; }
      }

      if (!btn) {
        for (const sel of nextCandidates) {
          const loc = form.locator(sel).first();
          if (await loc.count() && await loc.isVisible({ timeout: 200 }).catch(()=>false)) { btn = loc; isNextBtn = true; break; }
        }
      }

      if (!btn) {
        const anyBtn = form.locator("button:visible").last(); 
        if (await anyBtn.count()) btn = anyBtn;
      }

      if (!btn) return { status: "NOT_TESTED", reason: "Form could not be fired (Button not found)" };

      let fixAttempts = 0;
      let isStepSubmittable = false;
      let finalBlockers = null;

      while (fixAttempts < 2) {
        const blockers = await detectSubmissionBlockers(page, form, btn);
        finalBlockers = blockers;
        if (!blockers.submitDisabled && blockers.requiredFieldsEmpty.length === 0 && blockers.requiredCheckboxesUnchecked.length === 0) {
          isStepSubmittable = true; break;
        }
        if (!(await fixSubmissionBlockers(page, form, blockers))) break;
        await safeWait(page, 150);
        fixAttempts++;
      }

      if (!isStepSubmittable && !isNextBtn) {
        return { 
          status: "NOT_TESTED", 
          reason: "Form could not be fired (Validation/Constraints blocked submission)", 
          blockers: finalBlockers 
        };
      }

      captchaDetected = await safeEvaluate(page, () => {
        const captchas = document.querySelectorAll("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], .g-recaptcha, .h-captcha, .cf-turnstile, [name='g-recaptcha-response'], [name='h-captcha-response'], [name='cf-turnstile-response']");
        return captchas.length > 0;
      });

      if (captchaDetected) {
        return { status: "FAIL", reason: "Bot Protection (CAPTCHA/Turnstile)" }; // Specific string matched in final report
      }

      await btn.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => null);
      try { await btn.click({ timeout: 2000, noWaitAfter: true }); } 
      catch { await btn.click({ force: true, timeout: 2000, noWaitAfter: true }).catch(() => safeEvaluate(page, el => el.click(), btn).catch(()=>null)); }

      if (isNextBtn && currentStep < maxSteps) {
        await safeWait(page, 1000); 
        currentStep++;
        continue;
      }

      const submitStart = Date.now();
      while (Date.now() - submitStart < FORM_SUBMIT_WAIT_MS) {
        await safeWait(page, 250); 
        const afterUrl = page.url();
        const urlChanged = afterUrl !== beforeUrl;

        const successSignal = await safeEvaluate(page, () => {
          const txt = document.body.innerText.toLowerCase();
          return /thank you|thanks for|message sent|successfully sent|submission successful/i.test(txt);
        });

        if (urlChanged || successSignal) {
          submittedSuccessfully = true;
        }

        newGa4 = beacons.slice(beforeBeaconIdx).filter(b => b.type === "GA4");
        meaningfulEvents = newGa4.filter(b => {
          const en = (b.event_name || "").toLowerCase();
          if (GENERIC_EVENTS.includes(en)) return false;
          if (en === "page_view") return urlChanged && /thank|success|confirm/i.test(afterUrl);
          return true;
        });

        if (submittedSuccessfully && meaningfulEvents.length > 0) {
          break; 
        }
      }
      break; 
    }

    if (submittedSuccessfully && meaningfulEvents.length > 0) {
      return { status: "PASS", submittedSuccessfully, ga4_events: uniq(meaningfulEvents.map(b => b.event_name)), evidence_urls: meaningfulEvents.slice(0, 5).map(b => b.url) };
    }

    if (!submittedSuccessfully && meaningfulEvents.length > 0) {
      return { status: "FAIL", reason: "Conversion event fired prematurely (form did not successfully submit)", submittedSuccessfully, ga4_events: uniq(meaningfulEvents.map(b => b.event_name)) };
    }

    if (submittedSuccessfully && meaningfulEvents.length === 0) {
      return { status: "FAIL", reason: "Form submitted but no GTM event detected", submittedSuccessfully, ga4_events: uniq(newGa4.map(b => b.event_name)) };
    }

    const validationText = await safeEvaluate(page, () => {
      const els = Array.from(document.querySelectorAll("[role='alert'], .error, .wpcf7-not-valid-tip, .validation-error"));
      return els.map(e => (e.textContent || "").trim()).filter(Boolean).slice(0, 3).join(" | ");
    });

    return { status: "NOT_TESTED", reason: validationText ? "Form could not be fired (Validation blocked)" : "Form could not be fired (Submission not confirmed)", ga4_events: uniq(newGa4.map(b => b.event_name)) };

  } catch (e) { return { status: "NOT_TESTED", reason: `Form could not be fired (Error: ${e.message})` }; }
}

async function testAllFormsOnPage(page, beacons, pageUrl) {
  const formDiscovery = await discoverAllFormsOnPage(page, pageUrl);
  const results = { page_url: pageUrl, total_lead_forms_found: formDiscovery.totalLeadForms, first_party_forms: [], third_party_forms: [] };

  if (formDiscovery.firstPartyForms.length > 0) {
    for (const formMeta of formDiscovery.firstPartyForms) {
      const res = await testFirstPartyForm(page, beacons, pageUrl, formMeta);
      results.first_party_forms.push(res);
      if (res.status === "PASS") return results;
    }
  }
  return results;
}

// ------------------------------
// MAIN HEALTH CHECK LOGIC
// ------------------------------
async function trackingHealthCheckSiteInternal(url) {
  const targetUrl = normaliseUrl(url);
  const results = { ok: true, script_version: SCRIPT_VERSION, url: targetUrl, timestamp: nowIso(), overall_status: null, why: null, category_scores: {}, needs_improvement: [], pages_visited: [], cookie_consent: {}, tracking: { tags_found: { gtm: [], ga4: [] }, has_tracking: false }, ctas: { phones: { found: 0, tested: 0, passed: 0, failed: 0, items: [] }, emails: { found: 0, tested: 0, passed: 0, failed: 0, items: [] } }, forms: { total_pages_with_forms: 0, pages: [] }, evidence: {} };
  
  const beacons = [];
  let context = null; let page = null;

  try {
    logInfo(`🔍[${SCRIPT_VERSION}] Starting tracking health check`, { url: targetUrl });

    const browser = await getBrowser();
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }});
    page = await context.newPage();

    page.on("dialog", async dialog => {
      try { await dialog.accept(); } catch {}
    });

    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      const reqUrl = route.request().url();
      if (["image", "media", "font"].includes(type)) return route.abort();
      try {
        const host = new URL(reqUrl).hostname;
        if (SOCIAL_DOMAINS.some(domain => host.includes(domain))) return route.abort();
      } catch {}
      route.continue();
    });

    page.on("request", (req) => {
      const type = classifyGaBeacon(req.url());
      if (type !== "OTHER") beacons.push({ 
        url: req.url(), 
        timestamp: nowIso(), 
        type, 
        event_name: parseEventNameFromUrl(req.url()) || parseEventNameFromPostData(req.postData()),
        payload_dump: (req.url() + " " + (req.postData() || "")).toLowerCase()
      });
    });

    const load = await safeGoto(page, targetUrl);
    if (!load.ok) throw new Error(load.error);
    results.pages_visited.push(page.url());
    
    await simulateHumanBrowsing(page);
    results.cookie_consent = await handleCookieConsent(page);
    
    if (results.cookie_consent.accepted) {
      logInfo("Cookie consent banner accepted, waiting for tracking injection...", { url: targetUrl });
      await safeWait(page, 2500); 
    }

    // --- DETECT TRACKING ---
    let tracking = await detectTrackingSetup(page, beacons);
    results.tracking = tracking;
    
    const noGtm = !tracking.has_gtm;
    const noGa4AtAll = !tracking.has_any_ga4;

    if (noGtm) {
      results.overall_status = "FAIL";
      results.why = "BUILD_REQUIRED: No GTM container found";
      results.needs_improvement.push("Install Google Tag Manager container.");
      logInfo(`❌ Health check failed early - No GTM detected`, { url: targetUrl });
      return results;
    }

    if (noGa4AtAll) {
      results.overall_status = "FAIL";
      results.why = "BUILD_REQUIRED: GTM found, but no GA4 tags found on page.";
      results.needs_improvement.push("Install GA4 tags via GTM.");
      logInfo(`❌ Health check failed early - No GA4 detected`, { url: targetUrl });
      return results;
    }
    
    // --- PAGE DISCOVERY & CTA TESTING ---
    const discovered = await discoverCandidatePages(page, targetUrl);
    const pagesToVisit = [targetUrl, ...discovered]
      .filter(u => !SOCIAL_DOMAINS.some(d => u.includes(d)))
      .slice(0, MAX_PAGES_TO_VISIT);
    
    logInfo(`Will visit ${pagesToVisit.length} pages for CTA testing`, { url: targetUrl, pages: pagesToVisit });

    const allPhonesNorm = new Set();
    const allEmailsNorm = new Set();
    const testedPhonesNorm = new Set();
    const testedEmailsNorm = new Set();

    for (let i = 0; i < pagesToVisit.length; i++) {
      if (i > 0) {
        await safeGoto(page, pagesToVisit[i]);
        await simulateHumanBrowsing(page);
        await handleCookieConsent(page); 
      }
      const actualUrl = page.url();
      
      await safeEvaluate(page, () => {
        document.addEventListener('click', (e) => {
          const a = e.target.closest('a');
          if (a && (a.getAttribute('href') || '').toLowerCase().match(/^(tel|mailto):/)) {
            e.preventDefault();
          }
        });
      });

      const ctas = await scanCTAsOnPage(page);

      // Process Phones 
      for (const rawTel of (ctas.phones || [])) {
        const norm = normaliseTelHref(rawTel);
        if (!norm) continue;
        allPhonesNorm.add(norm);
        results.ctas.phones.found = allPhonesNorm.size; 

        if (results.ctas.phones.tested < MAX_PHONE_TESTS && !testedPhonesNorm.has(norm)) {
          testedPhonesNorm.add(norm);
          const item = await testLinkCTA(page, beacons, rawTel, "phone");
          results.ctas.phones.tested++;
          item.href = rawTel;
          results.ctas.phones.items.push(item);
          if (item.status === "PASS") results.ctas.phones.passed++; 
          else if (item.status === "FAIL") results.ctas.phones.failed++;
        }
      }

      // Process Emails
      for (const rawMail of (ctas.emails || [])) {
        const norm = normaliseMailtoHref(rawMail);
        if (!norm) continue;
        allEmailsNorm.add(norm);
        results.ctas.emails.found = allEmailsNorm.size;

        if (results.ctas.emails.tested < MAX_EMAIL_TESTS && !testedEmailsNorm.has(norm)) {
          testedEmailsNorm.add(norm);
          const item = await testLinkCTA(page, beacons, rawMail, "email");
          results.ctas.emails.tested++;
          item.href = rawMail;
          results.ctas.emails.items.push(item);
          if (item.status === "PASS") results.ctas.emails.passed++; 
          else if (item.status === "FAIL") results.ctas.emails.failed++;
        }
      }

      const formResults = await testAllFormsOnPage(page, beacons, actualUrl);
      if (formResults.total_lead_forms_found > 0) results.forms.total_pages_with_forms++;
      results.forms.pages.push(formResults);

      // Early exit if forms passed
      const hasPassingForm = [...formResults.first_party_forms, ...formResults.third_party_forms].some(f => f.status === "PASS");
      if (hasPassingForm) {
        logInfo(`Got definitive form pass on page ${i + 1}/${pagesToVisit.length} - stopping crawl`, { url: targetUrl });
        break;
      }
    }

    // ========================================
    // FINAL ANALYSIS & OUTPUT GENERATION
    // ========================================
    const allFormResults = results.forms.pages.flatMap(p => [...p.first_party_forms, ...p.third_party_forms]);
    const formsPassed = allFormResults.filter(f => f.status === "PASS").length;
    const formsFound = allFormResults.length;
    
    results.category_scores = {
      phones: `${results.ctas.phones.passed}/${results.ctas.phones.found}`,
      emails: `${results.ctas.emails.passed}/${results.ctas.emails.found}`,
      forms: `${formsPassed}/${formsFound}`
    };

    const issues = [];

    // 1. Phone Logic: If found, but NONE passed -> Issue. (One pass is enough for Success)
    if (results.ctas.phones.found > 0 && results.ctas.phones.passed === 0) {
      issues.push("Phone links detected but no conversion events fired.");
    }

    // 2. Email Logic: If found, but NONE passed -> Issue.
    if (results.ctas.emails.found > 0 && results.ctas.emails.passed === 0) {
      issues.push("Email links detected but no conversion events fired.");
    }

    // 3. Form Logic: If found, but NONE passed -> Issue.
    if (formsFound > 0 && formsPassed === 0) {
      // Check for specific Bot Protection failure
      const botBlocked = allFormResults.some(f => f.reason && f.reason.includes("Bot Protection"));
      if (botBlocked) {
        issues.push("Form testing blocked by Bot Protection (CAPTCHA/Turnstile).");
      } else {
        issues.push("Contact forms detected but no conversion events fired.");
      }
    }

    results.needs_improvement = issues;
    results.evidence.network_beacons = beacons;

    // 4. Overall Status Logic
    if (issues.length > 0) {
      results.overall_status = "FAIL";
      results.why = "Tracking Verification Failed: Some conversion points are not firing.";
    } else {
      // If nothing found at all, it's NOT_TESTED. If found and passed, it's PASS.
      const totalFound = results.ctas.phones.found + results.ctas.emails.found + formsFound;
      if (totalFound === 0) {
        results.overall_status = "NOT_TESTED";
        results.why = "No actionable CTAs (phones, emails, forms) found on scanned pages.";
      } else {
        results.overall_status = "PASS";
        results.why = "All detected conversion categories are firing events.";
      }
    }

    logInfo("✅ Health check complete", {
      url: targetUrl,
      overall_status: results.overall_status,
      why: results.why,
      category_scores: results.category_scores
    });

    return results;

  } catch (error) {
    logInfo("❌ Fatal error in health check", { url: targetUrl, error: error.message, stack: error.stack });
    return { ...results, ok: false, overall_status: "ERROR", why: `Fatal error: ${error.message}` };
  } finally {
    if (page) { try { page.removeAllListeners("request"); await page.close(); } catch {} }
    if (context) { try { await context.close(); } catch {} }
  }
}

// ------------------------------
// PUBLIC API
// ------------------------------
async function trackingHealthCheckSite(url) {
  await acquireCheckSlot();
  try {
    return await withTimeout(trackingHealthCheckSiteInternal(url), GLOBAL_TIMEOUT_MS, `Health check timed out after ${GLOBAL_TIMEOUT_MS}ms`);
  } catch (error) {
    return { ok: false, script_version: SCRIPT_VERSION, url: normaliseUrl(url), timestamp: nowIso(), overall_status: "ERROR", why: `Global timeout or error: ${error.message}` };
  } finally {
    releaseCheckSlot();
  }
}

module.exports = { trackingHealthCheckSite };

