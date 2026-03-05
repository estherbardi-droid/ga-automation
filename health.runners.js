// /health-check-v18.js
// INTELLIGENT TRACKING HEALTH CHECK
// Features: Cloud-Ready Spoofing, Specific Output, Bot Flagging, Aggressive Social Blocking, Fail-Fast
const SCRIPT_VERSION = "2026-03-05T17:00:00Z-V18-CLOUD-READY";

const { chromium } = require("playwright");

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
const FORM_SUBMIT_WAIT_MS = Number(process.env.HEALTH_FORM_WAIT_MS || 5000); 
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
const SOCIAL_DOMAINS = ["facebook.com", "twitter.com", "instagram.com", "linkedin.com", "tiktok.com", "pinterest.com", "youtube.com", "whatsapp.com", "snapchat.com", "t.co", "lnkd.in", "fb.com", "x.com"];

// Concurrency control
let activeChecks = 0;
const checkQueue = [];

// GLOBAL BROWSER
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
// Concurrency
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
    "#onetrust-accept-btn-handler", "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", 
    ".cmplz-accept", "#wt-cli-accept-all-btn", ".wt-cli-accept-all-btn", "#cookie_action_close_header",
    "button:has-text('Accept')", "button:has-text('Accept All')", "button:has-text('I Accept')", 
    "button:has-text('Agree')", "button:has-text('OK')", "button:has-text('Allow all')",
    ".cookie-accept", ".accept-cookies"
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
// Tracking Detection
// ------------------------------
async function detectTrackingSetup(page, beacons) {
  let tagData = await safeEvaluate(page, () => {
    const tags = { gtm: [], ga4: [] };
    const extract = (str) => {
      if (typeof str !== 'string') return;
      tags.gtm.push(...(str.toUpperCase().match(/GTM-[A-Z0-9]+/g) || []));
      tags.ga4.push(...(str.toUpperCase().match(/G-[A-Z0-9]+/g) || []));
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
        const tid = urlObj.searchParams.get("tid");
        const gtmHash = urlObj.searchParams.get("gtm");
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
  tagData.ga4.forEach(tid => {
    if (!linkedGa4Tags.has(tid)) finalUnlinkedGa4.push(tid);
  });

  return { 
    tags_found: { gtm: finalGtm, ga4: finalLinkedGa4, unlinked_ga4: uniq(finalUnlinkedGa4) },
    has_gtm: finalGtm.length > 0,
    has_linked_ga4: finalLinkedGa4.length > 0,
    has_any_ga4: finalLinkedGa4.length > 0 || finalUnlinkedGa4.length > 0
  };
}

// ------------------------------
// Page & CTA Discovery
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
    
    // Quick click
    await loc.click({ timeout: 1500, noWaitAfter: true }).catch(() => safeEvaluate(page, el => el.click(), loc).catch(() => null));

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
      
      const submitText = (() => {
        const btn = f.querySelector("button[type='submit']") || f.querySelector("input[type='submit']") ||
          Array.from(f.querySelectorAll("button")).find((b) => /send|submit|enquir|quote|request|book|contact/i.test(textOf(b))) || null;
        return btn ? textOf(btn) : "";
      })();
      
      const hay = `${attr(f, "id")} ${attr(f, "class")} ${submitText} ${textOf(f)}`.toLowerCase();
      const isSearch = /search|login|subscribe/.test(hay) && !hasTextarea;
      
      let score = 0;
      if (isSearch) score -= 999;
      if (hasTextarea) score += 3;
      if (hasEmail) score += 2;
      if (/send|submit|enquir/i.test(submitText)) score += 2;

      out.push({ index: i, action, inputCount, hasEmail, hasTextarea, submitText, score });
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
        if (actionUrl.origin !== new URL(pageUrl).origin && THIRD_PARTY_HINTS.some(hint => actionUrl.href.toLowerCase().includes(hint))) {
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

async function detectFieldType(element, page) {
  try {
    const tag = await element.evaluate((el) => el.tagName.toLowerCase()).catch(()=>"");
    const type = (await element.getAttribute("type").catch(()=>"")) || "";
    const name = (await element.getAttribute("name").catch(()=>"")) || "";
    const combined = `${type} ${name}`.toLowerCase();

    if (tag === "select") return { type: "select", tag };
    if (type === "checkbox") return { type: "checkbox", tag };
    if (type === "radio") return { type: "radio", tag };
    if (type === "hidden") return { type: "hidden", tag };
    
    if (/email/.test(combined)) return { type: "email", tag };
    if (/phone|tel|mobile/.test(combined)) return { type: "phone", tag };
    if (/message|enquiry/.test(combined) || tag === "textarea") return { type: "message", tag };
    return { type: "text", tag };
  } catch { return { type: "unknown", tag: "unknown" }; }
}

async function fillFormFieldSmart(page, element, fieldInfo) {
  try {
    const { type, tag } = fieldInfo;
    if (type === "hidden") return { success: true };
    const isVisible = await element.isVisible({ timeout: 250 }).catch(() => false); // Fast check
    if (!isVisible) return { success: true }; 

    if (tag === "select") {
      await element.evaluate((sel) => {
        if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }).catch(()=>null);
      return { success: true };
    }
    if (type === "checkbox" || type === "radio") {
      await element.check({ timeout: 500, force: true }).catch(() => null);
      return { success: true };
    }
    const valueMap = { email: TEST_VALUES.email, phone: TEST_VALUES.phone, message: TEST_VALUES.message };
    const value = valueMap[type] || TEST_VALUES.fullName;
    await element.fill(value, { timeout: 500 }).catch(() => null);
    return { success: true };
  } catch (err) { return { success: false }; }
}

async function hasVisibleValidationErrors(page, formIndex) {
    return await safeEvaluate(page, (index) => {
        const form = document.querySelectorAll('form')[index];
        if (!form) return false;
        
        // HTML5 invalid pseudo-classes
        const invalidFields = form.querySelectorAll(':invalid');
        if (invalidFields.length > 0) return true;
        
        // Error Text Containers
        const errorSelectors = ['[role="alert"]', '.error', '.invalid-feedback', '.wpcf7-not-valid-tip', '.validation-error', '.hs-error-msgs', '.field-error'];
        for (const sel of errorSelectors) {
            const els = form.querySelectorAll(sel);
            for (const el of els) {
                if (el.offsetParent !== null && el.innerText.trim().length > 0) return true;
            }
        }
        return false;
    }, formIndex);
}

// ------------------------------
// STRICT TEST FORMS (Fail-Fast)
// ------------------------------
async function testFirstPartyForm(page, beacons, pageUrl, formMeta) {
  try {
    const form = page.locator("form").nth(formMeta.index);
    if (!(await form.count())) return { status: "NOT_TESTED", reason: "Form not found" };

    // 1. FAIL-FAST: Pre-Check for Bots
    const botDetected = await safeEvaluate(page, () => {
        return !!document.querySelector("iframe[src*='recaptcha'], iframe[src*='turnstile'], .g-recaptcha, .h-captcha");
    });
    if (botDetected) return { status: "FAIL", reason: "Bot Protection (CAPTCHA/Turnstile)" };

    let currentStep = 0;
    const maxSteps = 3;
    let submittedSuccessfully = false;
    let meaningfulEvents = [];
    let newGa4 = [];
    const beforeBeaconIdx = beacons.length;
    const beforeUrl = page.url();

    while (currentStep <= maxSteps && !submittedSuccessfully) {
      
      // 2. Fill Fields
      const fields = form.locator("input:visible, textarea:visible, select:visible");
      const fieldCount = await fields.count();
      for (let i = 0; i < fieldCount; i++) {
        const el = fields.nth(i);
        const info = await detectFieldType(el, page);
        await fillFormFieldSmart(page, el, info);
      }

      // 3. Find Button
      const btn = form.locator("button[type='submit'], input[type='submit'], button:has-text('Send'), button:has-text('Submit')").first();
      if (!(await btn.count()) || !(await btn.isVisible())) break;

      // 4. Click Submit
      try { await btn.click({ timeout: 1500, noWaitAfter: true }); } 
      catch { await form.evaluate(f => f.submit()); }

      // 5. FAIL-FAST: Validation Check
      await safeWait(page, 1000);
      const hasErrors = await hasVisibleValidationErrors(page, formMeta.index);
      if (hasErrors) {
          return { status: "NOT_TESTED", reason: "Validation/Constraints blocked submission" };
      }

      // 6. Wait for Success
      const submitStart = Date.now();
      while (Date.now() - submitStart < FORM_SUBMIT_WAIT_MS) {
        await safeWait(page, 500); 
        const afterUrl = page.url();
        const urlChanged = afterUrl !== beforeUrl;
        const successSignal = await safeEvaluate(page, () => /thank|sent|success|confirm/i.test(document.body.innerText));

        if (urlChanged || successSignal) submittedSuccessfully = true;

        newGa4 = beacons.slice(beforeBeaconIdx).filter(b => b.type === "GA4");
        meaningfulEvents = newGa4.filter(b => {
          const en = (b.event_name || "").toLowerCase();
          if (GENERIC_EVENTS.includes(en)) return false;
          if (en === "page_view") return submittedSuccessfully; 
          return true;
        });

        if (submittedSuccessfully && meaningfulEvents.length > 0) break;
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

    return { status: "NOT_TESTED", reason: "Form could not be fired (Submission not confirmed)", ga4_events: uniq(newGa4.map(b => b.event_name)) };

  } catch (e) { return { status: "NOT_TESTED", reason: `Form Error: ${e.message}` }; }
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
// MAIN EXECUTION
// ------------------------------
async function trackingHealthCheckSiteInternal(url) {
  const targetUrl = normaliseUrl(url);
  const results = { ok: true, script_version: SCRIPT_VERSION, url: targetUrl, timestamp: nowIso(), overall_status: null, why: null, category_scores: {}, needs_improvement: [], pages_visited: [], cookie_consent: {}, tracking: { tags_found: { gtm: [], ga4: [] }, has_tracking: false }, ctas: { phones: { found: 0, tested: 0, passed: 0, failed: 0, items: [] }, emails: { found: 0, tested: 0, passed: 0, failed: 0, items: [] } }, forms: { total_pages_with_forms: 0, pages: [] }, evidence: {} };
  
  const beacons = [];
  let context = null; let page = null;

  try {
    logInfo(`🔍[${SCRIPT_VERSION}] Starting tracking health check`, { url: targetUrl });
    const browser = await getBrowser();
    
    // CLOUD: Spoof User Agent & Locale
    context = await browser.newContext({ 
        viewport: { width: 1920, height: 1080 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        locale: "en-GB",
        timezoneId: "Europe/London"
    });
    
    page = await context.newPage();

    // ------------------------------------
    // AGGRESSIVE SOCIAL BLOCKING (DOM)
    // ------------------------------------
    await page.addInitScript((domains) => {
        document.addEventListener('click', (e) => {
            const anchor = e.target.closest('a');
            if (anchor && anchor.href) {
                if (domains.some(d => anchor.href.toLowerCase().includes(d))) {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log(`[HealthCheck] Blocked social click: ${anchor.href}`);
                }
            }
        }, true); 
    }, SOCIAL_DOMAINS);

    // ------------------------------------
    // AGGRESSIVE SOCIAL BLOCKING (POPUP)
    // ------------------------------------
    context.on('page', async (newPage) => {
        try {
            const u = await newPage.url();
            if (SOCIAL_DOMAINS.some(d => u.includes(d))) await newPage.close();
        } catch {}
    });

    // ------------------------------------
    // NETWORK BLOCKING
    // ------------------------------------
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      if (SOCIAL_DOMAINS.some(d => route.request().url().includes(d))) return route.abort();
      route.continue();
    });

    page.on("request", (req) => {
      const type = classifyGaBeacon(req.url());
      if (type !== "OTHER") beacons.push({ 
        url: req.url(), timestamp: nowIso(), type, 
        event_name: parseEventNameFromUrl(req.url()) || parseEventNameFromPostData(req.postData()),
        payload_dump: (req.url() + " " + (req.postData() || "")).toLowerCase()
      });
    });

    const load = await safeGoto(page, targetUrl);
    if (!load.ok) throw new Error(load.error);
    results.pages_visited.push(page.url());
    
    await simulateHumanBrowsing(page);
    results.cookie_consent = await handleCookieConsent(page);
    if (results.cookie_consent.accepted) await safeWait(page, 2500);

    // TAG CHECK
    let tracking = await detectTrackingSetup(page, beacons);
    results.tracking = tracking;
    
    if (!tracking.has_gtm) {
      results.overall_status = "FAIL";
      results.why = "BUILD_REQUIRED: No GTM container found";
      results.needs_improvement.push("Install Google Tag Manager container.");
      return results;
    }

    if (!tracking.has_any_ga4) {
      results.overall_status = "FAIL";
      results.why = "BUILD_REQUIRED: GTM found, but no GA4 tags found on page.";
      results.needs_improvement.push("Install GA4 tags via GTM.");
      return results;
    }

    // DISCOVERY & TEST
    const discovered = await discoverCandidatePages(page, targetUrl);
    const pagesToVisit = [targetUrl, ...discovered].slice(0, MAX_PAGES_TO_VISIT);
    
    for (let i = 0; i < pagesToVisit.length; i++) {
      if (i > 0) { await safeGoto(page, pagesToVisit[i]); await handleCookieConsent(page); }
      
      const ctas = await scanCTAsOnPage(page);
      
      // Phones
      for (const rawTel of (ctas.phones || [])) {
        const norm = normaliseTelHref(rawTel);
        if (!norm) continue;
        results.ctas.phones.found = uniq([...(results.ctas.phones.items.map(x=>x.href)), rawTel]).length;
        if (results.ctas.phones.passed === 0 && results.ctas.phones.tested < MAX_PHONE_TESTS) {
           const item = await testLinkCTA(page, beacons, rawTel, "phone");
           results.ctas.phones.tested++;
           results.ctas.phones.items.push({href: rawTel, ...item});
           if (item.status === "PASS") results.ctas.phones.passed++;
        }
      }

      // Emails
      for (const rawMail of (ctas.emails || [])) {
        results.ctas.emails.found = uniq([...(results.ctas.emails.items.map(x=>x.href)), rawMail]).length;
        if (results.ctas.emails.passed === 0 && results.ctas.emails.tested < MAX_EMAIL_TESTS) {
           const item = await testLinkCTA(page, beacons, rawMail, "email");
           results.ctas.emails.tested++;
           results.ctas.emails.items.push({href: rawMail, ...item});
           if (item.status === "PASS") results.ctas.emails.passed++;
        }
      }

      // Forms
      const formRes = await testAllFormsOnPage(page, beacons, page.url());
      if (formRes.total_lead_forms_found > 0) results.forms.total_pages_with_forms++;
      results.forms.pages.push(formRes);
      
      // Early Exit
      const formsDone = results.forms.pages.flatMap(p=>[...p.first_party_forms, ...p.third_party_forms]).some(f=>f.status==="PASS");
      if (formsDone && results.ctas.phones.passed > 0 && results.ctas.emails.passed > 0) break;
    }

    // ANALYSIS
    const allFormResults = results.forms.pages.flatMap(p => [...p.first_party_forms, ...p.third_party_forms]);
    const formsPassed = allFormResults.filter(f => f.status === "PASS").length;
    const formsFound = allFormResults.length;
    
    results.category_scores = {
      phones: `${results.ctas.phones.passed}/${results.ctas.phones.found}`,
      emails: `${results.ctas.emails.passed}/${results.ctas.emails.found}`,
      forms: `${formsPassed}/${formsFound}`
    };

    const issues = [];
    if (results.ctas.phones.found > 0 && results.ctas.phones.passed === 0) issues.push("Phone links detected but no conversion events fired.");
    if (results.ctas.emails.found > 0 && results.ctas.emails.passed === 0) issues.push("Email links detected but no conversion events fired.");
    if (formsFound > 0 && formsPassed === 0) {
      if (allFormResults.some(f => f.reason && f.reason.includes("Bot Protection"))) issues.push("Form testing blocked by Bot Protection (CAPTCHA/Turnstile).");
      else issues.push("Contact forms detected but no conversion events fired.");
    }

    results.needs_improvement = issues;
    
    if (issues.length > 0) {
      results.overall_status = "FAIL";
      results.why = "Tracking Verification Failed: Some conversion points are not firing.";
    } else {
      const totalFound = results.ctas.phones.found + results.ctas.emails.found + formsFound;
      if (totalFound === 0) {
         results.overall_status = "NOT_TESTED";
         results.why = "No actionable CTAs (phones, emails, forms) found on scanned pages.";
      } else {
         results.overall_status = "PASS";
         results.why = "All detected conversion categories are firing events.";
      }
    }

    logInfo("✅ Check Complete", { url: targetUrl, status: results.overall_status });
    return results;

  } catch (error) {
    return { ...results, ok: false, overall_status: "ERROR", why: `Fatal error: ${error.message}` };
  } finally {
    if (page) { try { page.removeAllListeners("request"); await page.close(); } catch {} }
    if (context) { try { await context.close(); } catch {} }
  }
}

async function trackingHealthCheckSite(url) {
  await acquireCheckSlot();
  try {
    return await withTimeout(trackingHealthCheckSiteInternal(url), GLOBAL_TIMEOUT_MS, `Timeout`);
  } finally {
    releaseCheckSlot();
  }
}

module.exports = { trackingHealthCheckSite };

