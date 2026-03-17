// /health-check-v27.js
// INTELLIGENT TRACKING HEALTH CHECK
// Version: V27-CONCURRENCY-FIX
//


const SCRIPT_VERSION = "2026-03-13T18:00:00Z-V27";

const { chromium } = require("playwright");

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
function logInfo(msg, data = null) {
  if (LOG_LEVEL === "silent") return;
  const ts = new Date().toISOString();
  if (data) console.log(`[${ts}] ${msg}`, JSON.stringify(data, null, 2));
  else console.log(`[${ts}] ${msg}`);
}
function logDebug(msg, data = null) {
  if (LOG_LEVEL !== "debug") return;
  const ts = new Date().toISOString();
  if (data) console.log(`[${ts}] [DEBUG] ${msg}`, JSON.stringify(data, null, 2));
  else console.log(`[${ts}] [DEBUG] ${msg}`);
}

// ─────────────────────────────────────────────
// Configuration — all overridable via env vars
// ─────────────────────────────────────────────
const MAX_PAGES_TO_VISIT   = Number(process.env.HEALTH_MAX_PAGES          || 3);
const MAX_PHONE_TESTS      = Number(process.env.HEALTH_MAX_PHONE_TESTS     || 50);
const MAX_EMAIL_TESTS      = Number(process.env.HEALTH_MAX_EMAIL_TESTS     || 50);

// FIX 3: single nav attempt, hard 15s cap
const NAV_TIMEOUT_MS       = Number(process.env.HEALTH_NAV_TIMEOUT        || 15000);

const HEADLESS             = true;

// Primary CTA click poll window
const POST_ACTION_POLL_MS  = Number(process.env.HEALTH_POLL_MS            || 3000);

// Duplicate-fire second click — shorter window, we only need to detect presence/absence
const SECOND_CLICK_POLL_MS = Number(process.env.HEALTH_SECOND_POLL_MS     || 1500);

// Settle between first and second click in duplicate-fire test
const DUPLICATE_TEST_SETTLE_MS = Number(process.env.HEALTH_SETTLE_MS      || 600);

const FORM_SUBMIT_WAIT_MS  = Number(process.env.HEALTH_FORM_WAIT_MS       || 5000);

// FIX 2: hard global cap per site; also used as acquireCheckSlot timeout
const GLOBAL_TIMEOUT_MS    = Number(process.env.HEALTH_GLOBAL_TIMEOUT     || 120000);
const SLOT_ACQUIRE_TIMEOUT = Number(process.env.HEALTH_SLOT_TIMEOUT       || 90000);

// FIX 1: raised to 20; safe because each worker is mostly I/O-bound
const MAX_CONCURRENT_CHECKS = Number(process.env.HEALTH_MAX_CONCURRENT    || 20);

// FIX 5: how long to actively poll for GTM after consent (ms)
const POST_CONSENT_MAX_WAIT_MS = Number(process.env.HEALTH_CONSENT_WAIT   || 4000);
const POST_CONSENT_POLL_MS     = 200; // check every 200ms

const TEST_VALUES = {
  firstName: "HealthCheck", lastName: "Test", fullName: "HealthCheck Test",
  email:   process.env.HEALTH_TEST_EMAIL   || "test-automation@example.com",
  phone:   process.env.HEALTH_TEST_PHONE   || "01632960123",
  message: process.env.HEALTH_TEST_MESSAGE || "This is a tracking health check. Please ignore.",
  company: "Test Company", postcode: "SW1A 1AA", city: "London",
  address: "1 Test Street", subject: "General Enquiry",
  date: "2026-12-31", number: "1"
};

const GENERIC_EVENTS = new Set([
  "page_view","user_engagement","scroll","session_start","first_visit",
  "form_start","gtm.js","gtm.dom","gtm.load","timing_complete","exception",
  "web_vitals","optimize.activate"
]);

const CONTACT_PAGE_KEYWORDS = ["contact","get-in-touch","enquire","enquiry","quote","book","request","reach-us","talk","call-us"];
const COMMON_CONTACT_PATHS  = ["/contact","/contact-us","/get-in-touch","/enquiry","/quote","/book","/reach-us"];
const THIRD_PARTY_HINTS     = ["hubspot","hsforms","jotform","typeform","google.com/forms","forms.gle","calendly","marketo","salesforce","formstack","cognitoforms","gravity","wufoo"];
const SOCIAL_DOMAINS        = ["facebook.com","twitter.com","instagram.com","linkedin.com","tiktok.com","pinterest.com","youtube.com","whatsapp.com","snapchat.com","t.co","lnkd.in","fb.com","x.com"];

// ─────────────────────────────────────────────
// FIX 1: Concurrency — async mutex for browser pool
// ─────────────────────────────────────────────
let activeChecks  = 0;
const checkQueue  = [];

let globalBrowser     = null;
let browserUses       = 0;
let browserLaunchLock = null; // Promise while a launch is in progress
const MAX_BROWSER_USES = 100;

async function getBrowser() {
  // If a launch is already in progress, wait for it rather than launching again
  if (browserLaunchLock) {
    await browserLaunchLock;
  }

  // Recycle browser after MAX_BROWSER_USES to prevent memory leaks
  if (globalBrowser && browserUses >= MAX_BROWSER_USES) {
    logDebug("♻️  Recycling browser after max uses");
    const old = globalBrowser;
    globalBrowser = null;
    browserUses   = 0;
    old.close().catch(() => null); // fire-and-forget — don't block on close
  }

  if (!globalBrowser) {
    // Set the lock so concurrent callers wait for this launch
    let resolveLock;
    browserLaunchLock = new Promise(r => { resolveLock = r; });

    try {
      globalBrowser = await chromium.launch({
        headless: HEADLESS,
        timeout: 30000,
        args: [
          "--no-sandbox","--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage","--disable-gpu",
          "--proxy-server='direct://'","--proxy-bypass-list=*"
        ],
      });
      logDebug("🚀 Browser launched");
    } finally {
      browserLaunchLock = null;
      resolveLock();
    }
  }

  browserUses++;
  return globalBrowser;
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function normaliseUrl(input) {
  const u = (input || "").trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}
function safeUrlObj(u)      { try { return new URL(u); } catch { return null; } }
function uniq(arr)          { return [...new Set((arr || []).filter(Boolean))]; }
function escapeAttrValue(v) { return String(v).replace(/\\/g,"\\\\").replace(/"/g,'\\"'); }
function nowIso()           { return new Date().toISOString(); }

async function safeEvaluate(page, func, ...args) {
  try { return await page.evaluate(func, ...args); } catch { return null; }
}

async function safeWait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// FIX 2: acquireCheckSlot with hard timeout so a stuck check never blocks the queue
async function acquireCheckSlot() {
  if (activeChecks < MAX_CONCURRENT_CHECKS) { activeChecks++; return; }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove from queue if still waiting
      const idx = checkQueue.indexOf(entry);
      if (idx !== -1) checkQueue.splice(idx, 1);
      reject(new Error(`acquireCheckSlot timed out after ${SLOT_ACQUIRE_TIMEOUT}ms — all ${MAX_CONCURRENT_CHECKS} workers busy`));
    }, SLOT_ACQUIRE_TIMEOUT);

    const entry = () => { clearTimeout(timer); activeChecks++; resolve(); };
    checkQueue.push(entry);
  });
}

function releaseCheckSlot() {
  activeChecks--;
  if (checkQueue.length > 0) {
    const next = checkQueue.shift();
    next(); // next() increments activeChecks internally
  }
}

async function withTimeout(promise, ms, msg) {
  let id;
  const t = new Promise((_, rej) => { id = setTimeout(() => rej(new Error(msg)), ms); });
  try   { const r = await Promise.race([promise, t]); clearTimeout(id); return r; }
  catch (e) { clearTimeout(id); throw e; }
}

// FIX 3: single-attempt safeGoto — fail fast on dead sites, no double-timeout
async function safeGoto(page, url) {
  if (SOCIAL_DOMAINS.some(d => url.toLowerCase().includes(d))) {
    return { ok: false, error: "Blocked social domain" };
  }
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function simulateHumanBrowsing(page) {
  try {
    await safeEvaluate(page, () => window.scrollBy(0, document.body.scrollHeight / 2));
    await safeWait(400);
    const vp = page.viewportSize();
    if (vp) await page.mouse.move(Math.random() * vp.width, Math.random() * vp.height, { steps: 5 });
    await safeEvaluate(page, () => window.scrollTo(0, 0));
  } catch {}
}

function classifyAndParseBeacon(reqUrl, postData) {
  const u = (reqUrl || "").toLowerCase();
  let type = "OTHER";
  if (u.includes("/g/collect") || u.includes("/r/collect")) type = "GA4";
  else if (u.includes("gtag/js"))                           type = "GTAG";
  else if (u.includes("google-analytics.com"))              type = "GA";
  else if (u.includes("googletagmanager.com") || u.includes("/gtm.js")) type = "GTM";
  if (type === "OTHER") return null;

  let event_name = null;
  try { event_name = new URL(reqUrl).searchParams.get("en"); } catch {}
  if (!event_name && postData) {
    try { event_name = new URLSearchParams(postData).get("en"); } catch {}
    if (!event_name) {
      try {
        const p = JSON.parse(postData);
        if (p?.events?.[0]?.name) event_name = p.events[0].name;
        else if (p?.en)           event_name = p.en;
      } catch {}
    }
  }

  const payload_dump = (reqUrl + " " + (postData || "")).toLowerCase();
  let tid = null;
  try { tid = new URL(reqUrl).searchParams.get("tid"); } catch {}
  if (!tid && postData) {
    try { tid = new URLSearchParams(postData).get("tid"); } catch {}
    try { if (!tid) tid = JSON.parse(postData)?.tid; } catch {}
  }
  let gtmHash = null;
  try { gtmHash = new URL(reqUrl).searchParams.get("gtm"); } catch {}

  return { url: reqUrl, timestamp: nowIso(), type, event_name, payload_dump, tid, gtmHash };
}

// ─────────────────────────────────────────────
// Cookie consent
// ─────────────────────────────────────────────
async function handleCookieConsent(page) {
  const out = { accepted: false };
  const candidates = [
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    ".cmplz-accept","#wt-cli-accept-all-btn",".wt-cli-accept-all-btn",
    "#cookie_action_close_header",".cookie-accept",".accept-cookies",
    "[aria-label='Accept cookies']","[id*='accept'][class*='cookie']",
    "[class*='accept'][class*='cookie']"
  ];
  const textLabels = ["Accept All","Accept all","Accept All Cookies","I Accept","Allow All","Allow all","Agree","OK","Got it","Continue"];

  try {
    const clicked = await safeEvaluate(page, (sels, labels) => {
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetHeight > 0) { el.click(); return true; }
        }
      }
      for (const btn of document.querySelectorAll("button,a[role='button'],[type='button'],[type='submit']")) {
        const t = (btn.textContent || "").trim();
        if (labels.some(l => t === l || t.startsWith(l)) && btn.offsetHeight > 0) {
          btn.click(); return true;
        }
      }
      return false;
    }, candidates, textLabels);

    if (clicked) {
      out.accepted = true;
      logDebug("🍪 Cookie consent accepted");
    }
  } catch {}
  return out;
}

// ─────────────────────────────────────────────
// FIX 5+6: Post-consent active GTM poll
// After accepting consent (or on any new page navigation), actively poll
// for window.google_tag_manager to appear rather than sleeping a fixed time.
// This handles CMP-blocked GTM containers that only load after consent.
// Returns true if GTM object found within the window, false if timed out.
// ─────────────────────────────────────────────
async function waitForGtmInit(page, beacons, maxWaitMs = POST_CONSENT_MAX_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    // Check 1: window.google_tag_manager global object
    const gtmReady = await safeEvaluate(page, () => !!window.google_tag_manager);
    if (gtmReady) { logDebug("✅ GTM object detected after consent"); return true; }

    // Check 2: a GTM network request has already appeared in beacons
    const gtmBeacon = beacons.some(b =>
      b.url.includes("googletagmanager.com") || b.url.includes("/gtm.js")
    );
    if (gtmBeacon) { logDebug("✅ GTM beacon detected after consent"); return true; }

    // Check 3: GTM ID in any script tag (covers type=text/plain→text/javascript swap)
    const gtmInSource = await safeEvaluate(page, () => {
      for (const s of document.querySelectorAll("script")) {
        const content = (s.src || "") + (s.innerHTML || "");
        if (/GTM-[A-Z0-9]{4,}/i.test(content)) return true;
      }
      return false;
    });
    if (gtmInSource) { logDebug("✅ GTM ID found in source after consent"); return true; }

    await safeWait(POST_CONSENT_POLL_MS);
  }
  logDebug("⏱ GTM init poll timed out — proceeding anyway");
  return false;
}

// ─────────────────────────────────────────────
// FIX 4: detectTrackingSetup — break early on GTM confirmed
// No longer waits for GA4 IDs in source (they come via beacons anyway).
// Reduces worst-case wait from 6.5s to 0.5s on sites with clear GTM.
// ─────────────────────────────────────────────
async function detectTrackingSetup(page, beacons) {
  let gtmIds = new Set();
  let ga4Ids = new Set();

  for (let attempt = 0; attempt < 4; attempt++) {
    const scan = await safeEvaluate(page, () => {
      const found = { gtm: [], ga4: [] };
      function extract(str) {
        if (typeof str !== "string" || !str) return;
        for (const m of str.toUpperCase().matchAll(/GTM-[A-Z0-9]{4,}/g)) found.gtm.push(m[0]);
        for (const m of str.toUpperCase().matchAll(/\bG-[A-Z0-9]{6,}\b/g)) found.ga4.push(m[0]);
      }
      for (const s of document.querySelectorAll("script")) { extract(s.src); extract(s.innerHTML); }
      for (const ns of document.querySelectorAll("noscript")) extract(ns.innerHTML);
      for (const m of document.querySelectorAll("meta")) {
        extract(m.getAttribute("content") || "");
        extract(m.getAttribute("name") || "");
      }
      if (Array.isArray(window.dataLayer)) {
        for (const push of window.dataLayer) { try { extract(JSON.stringify(push)); } catch {} }
      }
      if (window.google_tag_manager) {
        for (const k of Object.keys(window.google_tag_manager)) extract(k);
      }
      if (window.dataLayer) {
        for (const item of window.dataLayer) {
          try {
            const s = JSON.stringify(item);
            if (s.includes('"config"') || (item[0] === "config" && typeof item[1] === "string")) {
              extract(typeof item[1] === "string" ? item[1] : s);
            }
          } catch {}
        }
      }
      if (typeof window.gtag === "function" && window.gtag.q) {
        for (const call of (window.gtag.q || [])) { try { extract(JSON.stringify(call)); } catch {} }
      }
      return found;
    });

    if (scan) {
      scan.gtm.forEach(id => gtmIds.add(id));
      scan.ga4.forEach(id => ga4Ids.add(id));
    }

    // Always scan beacons captured so far
    for (const b of beacons) {
      const u = b.url.toUpperCase();
      for (const m of u.matchAll(/GTM-[A-Z0-9]{4,}/g)) gtmIds.add(m[0]);
      if (b.type === "GA4" && b.tid) ga4Ids.add(b.tid.toUpperCase());
      try {
        const params = new URL(b.url).searchParams;
        const id = params.get("id") || params.get("tid");
        if (id && /^G-[A-Z0-9]{6,}$/i.test(id)) ga4Ids.add(id.toUpperCase());
      } catch {}
    }

    // FIX 4: break as soon as GTM is confirmed — don't require GA4 IDs in source
    const gtmInNetwork = beacons.some(b =>
      b.url.includes("googletagmanager.com") || b.url.includes("/gtm.js")
    );
    const globalGtmObj = await safeEvaluate(page, () => !!window.google_tag_manager);

    if (gtmIds.size > 0 || gtmInNetwork || globalGtmObj) break;

    // Progressive back-off only if GTM not yet confirmed
    await safeWait([500, 1000, 2000, 3000][attempt] || 1000);
  }

  const linkedGa4   = new Set();
  const unlinkedGa4 = new Set();
  for (const b of beacons) {
    if (b.type === "GA4" && b.tid) {
      const tid = b.tid.toUpperCase();
      if (b.gtmHash) linkedGa4.add(tid);
      else           unlinkedGa4.add(tid);
    }
  }
  for (const id of ga4Ids) {
    if (!linkedGa4.has(id)) unlinkedGa4.add(id);
  }

  const gtmInNetwork   = beacons.some(b => b.url.includes("googletagmanager.com") || b.url.includes("/gtm.js"));
  const ga4InNetwork   = beacons.some(b => b.type === "GA4");
  const globalGtmObj   = await safeEvaluate(page, () => !!window.google_tag_manager);
  const ga4FiredViaGtm = beacons.some(b => b.type === "GA4" && !!b.gtmHash);

  const has_gtm     = gtmIds.size > 0 || globalGtmObj || gtmInNetwork || ga4FiredViaGtm;
  const has_any_ga4 = ga4Ids.size > 0 || ga4InNetwork;

  return {
    tags_found: {
      gtm:          Array.from(gtmIds),
      ga4:          Array.from(linkedGa4),
      unlinked_ga4: Array.from(unlinkedGa4)
    },
    has_gtm,
    has_linked_ga4: linkedGa4.size > 0,
    has_any_ga4,
    gtm_evidence: {
      tag_ids_found:     Array.from(gtmIds),
      gtm_in_network:    gtmInNetwork,
      global_object:     !!globalGtmObj,
      ga4_fired_via_gtm: ga4FiredViaGtm
    }
  };
}

// ─────────────────────────────────────────────
// Page & CTA Discovery
// ─────────────────────────────────────────────
async function discoverCandidatePages(page, baseUrl) {
  const currentUrl = page.url();
  const origin = safeUrlObj(currentUrl)?.origin || safeUrlObj(baseUrl)?.origin || null;

  let links = await safeEvaluate(page, () =>
    Array.from(document.querySelectorAll("a[href]")).map(a => ({
      href: a.getAttribute("href") || "",
      text: (a.textContent || "").trim().slice(0, 120)
    }))
  );
  if (!links) links = [];

  const seen = new Set([currentUrl]);
  const scored = links
    .map(l => {
      try {
        const u = new URL(l.href, currentUrl);
        u.hash = "";
        const str = u.toString();
        if (SOCIAL_DOMAINS.some(d => u.hostname.includes(d))) return null;
        if (origin && !str.startsWith(origin)) return null;
        return { url: str, text: l.text };
      } catch { return null; }
    })
    .filter(Boolean)
    .map(x => ({
      ...x,
      score: CONTACT_PAGE_KEYWORDS.reduce((acc, k) =>
        (`${x.url} ${x.text}`.toLowerCase().includes(k) ? acc + 1 : acc), 0)
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const uniqueSorted = scored.filter(x => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
  const firstContact = uniqueSorted.find(x => /contact/.test(x.url.toLowerCase()));
  let discovered = [
    firstContact?.url,
    ...uniqueSorted.filter(x => x !== firstContact).map(x => x.url)
  ].filter(Boolean).slice(0, Math.max(0, MAX_PAGES_TO_VISIT - 1));

  if (discovered.length === 0 && origin) {
    for (const p of COMMON_CONTACT_PATHS) {
      const candidate = origin + p;
      if (!seen.has(candidate)) {
        discovered.push(candidate);
        if (discovered.length >= MAX_PAGES_TO_VISIT - 1) break;
      }
    }
  }
  return discovered;
}

// ─────────────────────────────────────────────
// Full CTA scan — clickable links + plain-text contacts
// ─────────────────────────────────────────────
async function scanCTAsOnPage(page) {
  const clickable = await safeEvaluate(page, () => ({
    phones: Array.from(document.querySelectorAll("a[href^='tel:' i]"))
              .map(a => ({ href: a.getAttribute("href"), text: (a.textContent || "").trim() }))
              .filter(x => x.href),
    emails: Array.from(document.querySelectorAll("a[href^='mailto:' i]"))
              .map(a => ({ href: a.getAttribute("href"), text: (a.textContent || "").trim() }))
              .filter(x => x.href)
  }));

  const plainText = await safeEvaluate(page, () => {
    const linkedPhones = new Set(
      Array.from(document.querySelectorAll("a[href^='tel:' i]"))
        .map(a => (a.getAttribute("href") || "").replace(/[^\d\+]/g, "")).filter(Boolean)
    );
    const linkedEmails = new Set(
      Array.from(document.querySelectorAll("a[href^='mailto:' i]"))
        .map(a => (a.getAttribute("href") || "").replace(/mailto:/i, "").trim().toLowerCase()).filter(Boolean)
    );

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName?.toLowerCase();
        if (["script","style","noscript","head"].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const phonePattern = /(\+?[\d][\d\s\-\(\)\.]{6,}[\d])/g;
    const emailPattern = /([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
    const foundPhones = [], foundEmails = [];

    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent || "";
      const parentAnchor = node.parentElement?.closest("a[href]");
      const isPhoneLink  = parentAnchor && (parentAnchor.getAttribute("href") || "").toLowerCase().startsWith("tel:");
      const isEmailLink  = parentAnchor && (parentAnchor.getAttribute("href") || "").toLowerCase().startsWith("mailto:");

      if (!isPhoneLink) {
        for (const m of text.matchAll(phonePattern)) {
          const digits = m[1].replace(/[^\d\+]/g, "");
          if (digits.replace(/\+/, "").length >= 9 && !linkedPhones.has(digits))
            foundPhones.push({ raw: m[1].trim(), digits });
        }
      }
      if (!isEmailLink) {
        for (const m of text.matchAll(emailPattern)) {
          const norm = m[1].trim().toLowerCase();
          if (!linkedEmails.has(norm)) foundEmails.push({ raw: m[1].trim(), norm });
        }
      }
    }

    const seenPh = new Set(), seenEm = new Set();
    return {
      phones: foundPhones.filter(p => { if (seenPh.has(p.digits)) return false; seenPh.add(p.digits); return true; }),
      emails: foundEmails.filter(e => { if (seenEm.has(e.norm))   return false; seenEm.add(e.norm);   return true; })
    };
  });

  return {
    phones:             (clickable?.phones || []),
    emails:             (clickable?.emails || []),
    nonClickablePhones: (plainText?.phones || []),
    nonClickableEmails: (plainText?.emails || [])
  };
}

function normaliseTelHref(href)    { return href ? href.replace(/\s+/g, "").toLowerCase() : null; }
function normaliseMailtoHref(href) { return href ? href.trim().toLowerCase() : null; }

// ─────────────────────────────────────────────
// Low-level: click one element, poll for GA4 event
// pollMs: how long to wait — use POST_ACTION_POLL_MS for primary clicks,
//         SECOND_CLICK_POLL_MS for duplicate-fire checks
// ─────────────────────────────────────────────
async function clickAndPollForEvent(page, beacons, selector, fromIdx, ctaSearchValue, type, pollMs = POST_ACTION_POLL_MS) {
  // Primary: Playwright click; fallback: JS click
  await page.locator(selector).first()
    .click({ timeout: 2000, noWaitAfter: true })
    .catch(async () => {
      await safeEvaluate(page, sel => {
        const el = document.querySelector(sel);
        if (el) el.click();
      }, selector);
    });

  const start = Date.now();
  while (Date.now() - start < pollMs) {
    const newGa4 = beacons.slice(fromIdx).filter(b => b.type === "GA4");

    // Tier 1: strong signal — payload match or event name pattern
    const tier1 = newGa4.filter(b => {
      const en = (b.event_name || "").toLowerCase();
      if (GENERIC_EVENTS.has(en)) return false;
      const hasPayload = ctaSearchValue && (b.payload_dump || "").includes(ctaSearchValue);
      const strongName = (type === "phone" && /phone|call|tel|click_call|call_click/.test(en)) ||
                         (type === "email" && /email|mail|click_email|email_click/.test(en));
      return hasPayload || strongName;
    });
    if (tier1.length) return {
      fired: true, match_tier: "exact",
      ga4_events: uniq(tier1.map(b => b.event_name)),
      evidence_urls: tier1.slice(0, 3).map(b => b.url),
      generic_events_seen: []
    };

    // Tier 2: any non-generic GA4 event
    const tier2 = newGa4.filter(b => {
      const en = (b.event_name || "").toLowerCase();
      return !GENERIC_EVENTS.has(en) && en !== "";
    });
    if (tier2.length) return {
      fired: true, match_tier: "inferred",
      ga4_events: uniq(tier2.map(b => b.event_name)),
      evidence_urls: tier2.slice(0, 3).map(b => b.url),
      generic_events_seen: []
    };

    await safeWait(100);
  }

  const allNewGa4 = beacons.slice(fromIdx).filter(b => b.type === "GA4");
  return {
    fired: false, ga4_events: [], evidence_urls: [],
    generic_events_seen: uniq(allNewGa4.map(b => b.event_name))
  };
}

// ─────────────────────────────────────────────
// testLinkCTA — primary click + duplicate-fire test
// ─────────────────────────────────────────────
async function testLinkCTA(page, beacons, rawHref, type, pageUrl) {
  const hrefEsc        = escapeAttrValue(rawHref);
  const selector       = `a[href="${hrefEsc}" i]`;
  const ctaSearchValue = type === "phone"
    ? rawHref.replace(/[^\d\+]/g, "")
    : rawHref.replace(/mailto:/i, "").toLowerCase().trim();

  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count())) {
      return { status: "NOT_TESTED", reason: "CTA element not found in DOM", page_url: pageUrl };
    }

    await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => null);
    await safeWait(300);

    // ── Step 1: Primary click ──
    const click1 = await clickAndPollForEvent(
      page, beacons, selector, beacons.length, ctaSearchValue, type, POST_ACTION_POLL_MS
    );

    if (!click1.fired) {
      return {
        status: "FAIL",
        reason: click1.generic_events_seen.length
          ? `GA4 fired but only generic events (${click1.generic_events_seen.join(", ")}) — no conversion event`
          : "No GA4 beacon fired after click",
        ga4_events: [],
        generic_events_seen: click1.generic_events_seen,
        page_url: pageUrl,
        duplicate_fire_test: null
      };
    }

    // ── Step 2: Duplicate-fire test — JS click same element after settle ──
    await safeWait(DUPLICATE_TEST_SETTLE_MS);
    const beforeClick2 = beacons.length;

    await safeEvaluate(page, sel => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, selector);

    const click2 = await clickAndPollForEvent(
      page, beacons, selector, beforeClick2, ctaSearchValue, type, SECOND_CLICK_POLL_MS
    );

    const duplicate_fire_test = click2.fired
      ? {
          result: "DUPLICATE_FIRED",
          summary: `A second GA4 event fired after clicking the same ${type === "phone" ? "tel:" : "mailto:"} link again on the same page. ` +
            `The GTM tag is set to "Once per event" or "Unlimited" — it will fire on every click and double-count conversions.`,
          events_on_second_click: click2.ga4_events,
          fix: `In GTM, open the GA4 Event tag for ${type === "phone" ? "click_call / click_phone" : "click_email"}, ` +
            `go to Advanced Settings → Tag firing options, change from "Once per event" to "Once per page". ` +
            `This ensures the event fires only once per page load no matter how many times the link is clicked.`
        }
      : {
          result: "CORRECTLY_SUPPRESSED",
          summary: `No second GA4 event fired after re-clicking on the same page — tag is correctly set to "Once per page".`
        };

    return {
      status: "PASS",
      match_tier: click1.match_tier,
      ...(click1.match_tier === "inferred" ? { match_note: "Non-generic GA4 event fired — CTA value may be in custom dimensions" } : {}),
      ga4_events: click1.ga4_events,
      evidence_urls: click1.evidence_urls,
      page_url: pageUrl,
      duplicate_fire_test
    };

  } catch (e) {
    return { status: "NOT_TESTED", reason: e.message, page_url: pageUrl, duplicate_fire_test: null };
  }
}

// ─────────────────────────────────────────────
// Per-page CTA orchestrator
//
// Strategy: test the FIRST clickable tel: link found anywhere across the
// site exactly once (double-click dup test is built into testLinkCTA).
// Once a primary phone test has been fired, never test another phone link
// again — same for email. This means found=1, tested=1, pass=0|1 which is
// the only accurate representation when one number appears on multiple pages.
//
// Non-clickable contact scanning always runs on every page so we catch
// plain-text numbers/emails wherever they appear across the whole site.
//
// phoneDone / emailDone are { value: boolean } objects passed by reference
// so the caller loop can see when testing is complete and skip on later pages.
// ─────────────────────────────────────────────
async function testCTAsOnPage(page, beacons, pageUrl,
                               uniquePhones, uniqueEmails,
                               phoneItems, emailItems,
                               phoneDone, emailDone) {
  const ctas = await scanCTAsOnPage(page);
  const currentUrl = page.url();

  // ── Phone: fire one primary test, then stop for the entire run ──
  if (!phoneDone.value) {
    for (const ctaObj of (ctas.phones || [])) {
      const rawTel = ctaObj.href;
      const norm   = normaliseTelHref(rawTel);
      if (!norm) continue;
      uniquePhones.add(norm);

      const result = await testLinkCTA(page, beacons, rawTel, "phone", currentUrl);
      result.href         = rawTel;
      result.display_text = ctaObj.text || null;
      phoneItems.push(result);
      phoneDone.value = true; // primary test done — no more phone tests this run
      break;
    }
  }

  // Always accumulate unique hrefs for the found count even when test is done
  for (const ctaObj of (ctas.phones || [])) {
    const norm = normaliseTelHref(ctaObj.href);
    if (norm) uniquePhones.add(norm);
  }

  // ── Email: same — one primary test then stop ──
  if (!emailDone.value) {
    for (const ctaObj of (ctas.emails || [])) {
      const rawMail = ctaObj.href;
      const norm    = normaliseMailtoHref(rawMail);
      if (!norm) continue;
      uniqueEmails.add(norm);

      const result = await testLinkCTA(page, beacons, rawMail, "email", currentUrl);
      result.href         = rawMail;
      result.display_text = ctaObj.text || null;
      emailItems.push(result);
      emailDone.value = true;
      break;
    }
  }

  for (const ctaObj of (ctas.emails || [])) {
    const norm = normaliseMailtoHref(ctaObj.href);
    if (norm) uniqueEmails.add(norm);
  }

  // ── Non-clickable contacts: always scan every page regardless ──
  return {
    nonClickablePhones: ctas.nonClickablePhones || [],
    nonClickableEmails: ctas.nonClickableEmails || []
  };
}

// ─────────────────────────────────────────────
// Form detection & testing (unchanged from V26)
// ─────────────────────────────────────────────
async function discoverAllFormsOnPage(page, pageUrl) {
  const mainForms = await scanFrameForForms(page);
  let frameForms  = [];
  try {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const ff = await scanFrameForForms(frame);
      if (ff?.length) { ff.forEach(f => { f.isFrame = true; }); frameForms.push(...ff); }
    }
  } catch {}
  const leadForms = [...mainForms, ...frameForms].filter(f => f.score >= 1);
  leadForms.sort((a, b) => b.score - a.score);
  const firstParty = [], thirdParty = [];
  for (const f of leadForms) {
    let isThirdParty = false;
    if (f.action) {
      try {
        const actionUrl = new URL(f.action, pageUrl);
        if (actionUrl.origin !== new URL(pageUrl).origin &&
            THIRD_PARTY_HINTS.some(h => actionUrl.href.toLowerCase().includes(h))) isThirdParty = true;
      } catch {}
    }
    (isThirdParty ? thirdParty : firstParty).push(f);
  }
  return { firstPartyForms: firstParty, thirdPartyForms: thirdParty, totalLeadForms: leadForms.length };
}

async function scanFrameForForms(frameOrPage) {
  return await safeEvaluate(frameOrPage, () => {
    const out = [];
    function textOf(el) { return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400); }
    function attr(el, name) { return (el?.getAttribute?.(name)) || ""; }
    function has(el, sel) { try { return !!el.querySelector(sel); } catch { return false; } }
    for (let i = 0; i < document.querySelectorAll("form").length; i++) {
      const f     = document.querySelectorAll("form")[i];
      const action = attr(f, "action");
      const inputs = f.querySelectorAll("input,textarea,select");
      const hasTextarea = has(f, "textarea");
      const hasEmail    = has(f, "input[type='email']") ||
        Array.from(inputs).some(x => /email/i.test(attr(x,"name")+attr(x,"placeholder")+attr(x,"id")));
      const hasPhone    = Array.from(inputs).some(x => /phone|tel|mobile/i.test(attr(x,"name")+attr(x,"placeholder")+attr(x,"id")+attr(x,"type")));
      const hasName     = Array.from(inputs).some(x => /^(name|full.?name|first.?name)/i.test(attr(x,"name")+attr(x,"placeholder")+attr(x,"id")));
      const submitBtn   = f.querySelector("button[type='submit'],input[type='submit']") ||
        Array.from(f.querySelectorAll("button")).find(b => /send|submit|enquir|quote|request|book|contact|get.?in.?touch/i.test(textOf(b)));
      const submitText  = submitBtn ? textOf(submitBtn) : "";
      const hay = `${attr(f,"id")} ${attr(f,"class")} ${attr(f,"name")} ${submitText} ${textOf(f)}`.toLowerCase();
      const isSearch = /search|login|sign.?in|subscribe|newsletter/.test(hay) && !hasTextarea && inputs.length < 3;
      let score = 0;
      if (isSearch) { score -= 999; } else {
        if (hasTextarea) score += 3;
        if (hasEmail)    score += 2;
        if (hasPhone)    score += 2;
        if (hasName && inputs.length >= 2) score += 1;
        if (/send|submit|enquir|contact|book/i.test(submitText)) score += 2;
        if (/contact|enquir|quote|touch/i.test(hay)) score += 1;
      }
      out.push({ index: i, action, hasEmail, hasPhone, hasTextarea, submitText, score });
    }
    return out;
  });
}

async function detectFieldType(el) {
  try {
    const tag  = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => "");
    const type = (await el.getAttribute("type").catch(() => "")) || "";
    const name = (await el.getAttribute("name").catch(() => "")) || "";
    const ph   = (await el.getAttribute("placeholder").catch(() => "")) || "";
    const id   = (await el.getAttribute("id").catch(() => "")) || "";
    const c    = `${type} ${name} ${ph} ${id}`.toLowerCase();
    if (tag === "select")                  return { type: "select" };
    if (type === "checkbox")               return { type: "checkbox" };
    if (type === "radio")                  return { type: "radio" };
    if (type === "hidden")                 return { type: "hidden" };
    if (/email/.test(c))                   return { type: "email" };
    if (/phone|tel|mobile/.test(c))        return { type: "phone" };
    if (/message|enquiry|comment|details|how.?can/.test(c) || tag === "textarea") return { type: "message" };
    if (/first.?name|forename/.test(c))    return { type: "firstName" };
    if (/last.?name|surname/.test(c))      return { type: "lastName" };
    if (/company|business|organisation/.test(c)) return { type: "company" };
    if (/postcode|post.?code|zip/.test(c)) return { type: "postcode" };
    if (/subject|topic/.test(c))           return { type: "subject" };
    return { type: "text" };
  } catch { return { type: "unknown" }; }
}

async function fillFormFieldSmart(el, fieldInfo) {
  try {
    const { type } = fieldInfo;
    if (type === "hidden") return;
    if (!await el.isVisible({ timeout: 300 }).catch(() => false)) return;
    if (type === "select") {
      await el.evaluate(sel => {
        if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event("change", { bubbles: true })); }
      }).catch(() => null);
      return;
    }
    if (type === "checkbox" || type === "radio") {
      await el.check({ timeout: 500, force: true }).catch(() => null);
      return;
    }
    const valueMap = {
      email: TEST_VALUES.email, phone: TEST_VALUES.phone, message: TEST_VALUES.message,
      firstName: TEST_VALUES.firstName, lastName: TEST_VALUES.lastName,
      company: TEST_VALUES.company, postcode: TEST_VALUES.postcode, subject: TEST_VALUES.subject
    };
    await el.fill(valueMap[type] || TEST_VALUES.fullName, { timeout: 500 }).catch(() => null);
  } catch {}
}

async function hasVisibleValidationErrors(page, formIndex) {
  return await safeEvaluate(page, idx => {
    const form = document.querySelectorAll("form")[idx];
    if (!form) return false;
    if ([...form.querySelectorAll(":invalid")].some(el => el.offsetParent !== null)) return true;
    return ['[role="alert"]','.error','.invalid-feedback','.wpcf7-not-valid-tip',
      '.validation-error','.hs-error-msgs','.field-error','.form-error',
      '[data-error]','.help-block','.alert-danger']
      .some(sel => [...form.querySelectorAll(sel)].some(el => el.offsetParent !== null && el.innerText.trim().length > 0));
  }, formIndex);
}

async function testFirstPartyForm(page, beacons, pageUrl, formMeta) {
  try {
    if (formMeta.isFrame) return { status: "NOT_TESTED", reason: "Form is inside a cross-origin iframe" };
    const formLocator = page.locator("form").nth(formMeta.index);
    if (!(await formLocator.count())) return { status: "NOT_TESTED", reason: "Form not found in DOM" };
    const botDetected = await safeEvaluate(page, () =>
      !!document.querySelector("iframe[src*='recaptcha'],iframe[src*='turnstile'],.g-recaptcha,.h-captcha,[data-sitekey]")
    );
    if (botDetected) return { status: "FAIL", reason: "Bot Protection (CAPTCHA/Turnstile)" };

    const beforeBeaconIdx = beacons.length;
    const beforeUrl = page.url();
    const fields = formLocator.locator("input:visible,textarea:visible,select:visible");
    const fieldCount = await fields.count();
    for (let i = 0; i < fieldCount; i++) {
      await fillFormFieldSmart(fields.nth(i), await detectFieldType(fields.nth(i)));
    }
    await safeWait(300);

    const btnLocator = formLocator.locator(
      "button[type='submit'],input[type='submit'],button:has-text('Send'),button:has-text('Submit'),button:has-text('Enquire'),button:has-text('Book'),button:has-text('Request')"
    ).first();
    if (!((await btnLocator.count()) > 0 && await btnLocator.isVisible().catch(() => false))) {
      return { status: "NOT_TESTED", reason: "No visible submit button found" };
    }

    let submitted = await btnLocator.click({ timeout: 2000, noWaitAfter: true }).then(() => true).catch(() => false);
    if (!submitted) {
      submitted = await safeEvaluate(page, idx => {
        const f   = document.querySelectorAll("form")[idx];
        const btn = f?.querySelector("button[type='submit'],input[type='submit']");
        if (btn) { btn.click(); return true; }
        return false;
      }, formMeta.index).then(r => !!r);
    }
    if (!submitted) {
      await safeEvaluate(page, idx => {
        const f = document.querySelectorAll("form")[idx];
        if (f) { try { f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); f.submit(); } catch {} }
      }, formMeta.index);
    }

    await safeWait(800);
    if (await hasVisibleValidationErrors(page, formMeta.index))
      return { status: "NOT_TESTED", reason: "Form validation blocked submission" };

    let newGa4 = [], meaningfulEvents = [];
    const submitStart = Date.now();
    while (Date.now() - submitStart < FORM_SUBMIT_WAIT_MS) {
      await safeWait(400);
      const afterUrl  = page.url();
      const urlChanged = afterUrl !== beforeUrl;
      newGa4 = beacons.slice(beforeBeaconIdx).filter(b => b.type === "GA4");
      meaningfulEvents = newGa4.filter(b => {
        const en = (b.event_name || "").toLowerCase();
        if (GENERIC_EVENTS.has(en)) return false;
        if (en === "page_view" && urlChanged && /thank|success|confirm|sent/i.test(afterUrl)) return true;
        return true;
      });
      if (meaningfulEvents.length > 0) break;
    }
    if (meaningfulEvents.length > 0) {
      return { status: "PASS", ga4_events: uniq(meaningfulEvents.map(b => b.event_name)), evidence_urls: meaningfulEvents.slice(0,3).map(b => b.url) };
    }

    const successVisible = await safeEvaluate(page, () =>
      /thank|thanks|sent|success|confirm|received|we.ll be in touch|we will be in touch|message received/i.test(document.body.innerText)
    );
    if (successVisible || /thank|success|confirm|sent/i.test(page.url())) {
      return { status: "FAIL", reason: "Form submitted (success detected) but no GA4 event fired", ga4_events_seen: uniq(newGa4.map(b => b.event_name)) };
    }
    return { status: "NOT_TESTED", reason: "Submission unconfirmed — no success message, URL change, or GA4 event", ga4_events_seen: uniq(newGa4.map(b => b.event_name)) };
  } catch (e) {
    return { status: "NOT_TESTED", reason: `Unexpected error: ${e.message}` };
  }
}

async function testAllFormsOnPage(page, beacons, pageUrl) {
  const discovery = await discoverAllFormsOnPage(page, pageUrl);
  const result = { page_url: pageUrl, total_lead_forms_found: discovery.totalLeadForms, first_party_forms: [], third_party_forms: [] };
  for (const formMeta of discovery.firstPartyForms) {
    const res = await testFirstPartyForm(page, beacons, pageUrl, formMeta);
    result.first_party_forms.push(res);
    if (res.status === "PASS") break;
  }
  return result;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function trackingHealthCheckSiteInternal(url) {
  const targetUrl = normaliseUrl(url);
  const results = {
    ok: true, script_version: SCRIPT_VERSION, url: targetUrl, timestamp: nowIso(),
    grade: null, overall_status: null, why: null,
    category_scores: {}, failure_detail: [], needs_improvement: [],
    pages_visited: [], cookie_consent: {},
    tracking: { tags_found: { gtm: [], ga4: [] } },
    ctas: {
      phones: { found: 0, not_clickable: 0, tested: 0, passed: 0, failed: 0, items: [], not_clickable_items: [] },
      emails: { found: 0, not_clickable: 0, tested: 0, passed: 0, failed: 0, items: [], not_clickable_items: [] }
    },
    forms: { total_pages_with_forms: 0, pages: [] }
  };

  const beacons              = [];
  const interceptedForms     = [];
  const uniquePhones         = new Set();
  const uniqueEmails         = new Set();
  const uniqueNonClickPhones = new Set();
  const uniqueNonClickEmails = new Set();
  const visitedUrls          = new Set();
  const phoneItems           = [];
  const emailItems           = [];
  const phoneDone            = { value: false }; // flips true after first phone test fires
  const emailDone            = { value: false }; // flips true after first email test fires

  let context = null, page = null;

  try {
    logInfo(`🔍 [${SCRIPT_VERSION}] Starting check`, { url: targetUrl });
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-GB",
      timezoneId: "Europe/London"
    });
    page = await context.newPage();

    // Route interception
    await context.route("**/*", route => {
      const req    = route.request();
      const type   = req.resourceType();
      const reqUrl = req.url();
      const method = req.method();
      if (["image","media","font"].includes(type)) return route.abort();
      try { if (SOCIAL_DOMAINS.some(d => new URL(reqUrl).hostname.includes(d))) return route.abort(); } catch {}
      const lower      = reqUrl.toLowerCase();
      const isAnalytics = lower.includes("google-analytics") || lower.includes("googletagmanager") || lower.includes("/collect");
      if (method === "POST" && !isAnalytics) {
        interceptedForms.push({ url: reqUrl, data: req.postData() });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, message: "mocked" }) });
      }
      route.continue();
    });

    // Beacon capture
    page.on("request", req => {
      const b = classifyAndParseBeacon(req.url(), req.postData());
      if (b) { beacons.push(b); logDebug("📡 Beacon", { type: b.type, event: b.event_name }); }
    });
    page.on("response", async res => {
      try {
        const req = res.request();
        if (req.method() === "POST") {
          const b = classifyAndParseBeacon(req.url(), req.postData());
          if (b && !beacons.find(x => x.url === b.url && x.timestamp === b.timestamp)) beacons.push(b);
        }
      } catch {}
    });

    // ── Load homepage ──
    const gotoResult = await safeGoto(page, targetUrl);
    if (!gotoResult.ok) {
      logInfo(`⚠️ Homepage failed to load: ${gotoResult.error}`);
    }
    visitedUrls.add(page.url());
    results.pages_visited.push(page.url());

    await simulateHumanBrowsing(page);

    // FIX 5+6: Accept consent THEN actively poll for GTM to initialise
    results.cookie_consent = await handleCookieConsent(page);
    await waitForGtmInit(page, beacons, POST_CONSENT_MAX_WAIT_MS);

    // Detect tracking setup AFTER GTM has had time to initialise post-consent
    let tracking = await detectTrackingSetup(page, beacons);
    results.tracking = tracking;

    if (!tracking.has_gtm) {
      results.grade          = "FAIL";
      results.overall_status = "NO_TRACKING";
      results.why            = "No GTM container detected after cookie consent was accepted. No GTM tag IDs in source, no GTM network requests, no google_tag_manager global object.";
      results.failure_detail = [{
        category: "Google Tag Manager", grade_impact: "FAIL",
        summary: "No GTM container was found. GTM must be installed before any conversion tracking can work.",
        fix: "Install a Google Tag Manager container. Add the GTM <head> snippet and <body> noscript snippet to every page, then republish."
      }];
      results.needs_improvement = ["Install Google Tag Manager — no container detected."];
      logInfo(`╔══════════════════════════════════════════════╗`);
      logInfo(`  GRADE : ❌ FAIL — NO GTM/GA4 DETECTED`);
      logInfo(`╚══════════════════════════════════════════════╝`);
      return results;
    }

    // ── Discover and visit pages ──
    const discovered   = await discoverCandidatePages(page, targetUrl);
    const pagesToVisit = [targetUrl, ...discovered].slice(0, MAX_PAGES_TO_VISIT);

    for (let i = 0; i < pagesToVisit.length; i++) {
      const pageUrl = pagesToVisit[i];

      if (i > 0) {
        const navResult = await safeGoto(page, pageUrl);
        if (!navResult.ok) { logDebug(`⚠️ Skipping page (nav failed): ${pageUrl}`); continue; }
        const finalUrl = page.url();
        if (visitedUrls.has(finalUrl)) { logDebug(`Skipping duplicate: ${finalUrl}`); continue; }
        visitedUrls.add(finalUrl);
        results.pages_visited.push(finalUrl);

        // FIX 6: consent + GTM poll on every page navigation too
        await handleCookieConsent(page);
        await waitForGtmInit(page, beacons, POST_CONSENT_MAX_WAIT_MS / 2); // shorter on subsequent pages — consent already stored
      }

      const { nonClickablePhones, nonClickableEmails } = await testCTAsOnPage(
        page, beacons, page.url(),
        uniquePhones, uniqueEmails,
        phoneItems, emailItems,
        phoneDone, emailDone
      );

      // Non-clickable phones
      for (const ph of nonClickablePhones) {
        if (uniqueNonClickPhones.has(ph.digits)) continue;
        uniqueNonClickPhones.add(ph.digits);
        results.ctas.phones.not_clickable++;
        results.ctas.phones.not_clickable_items.push({
          raw: ph.raw, digits: ph.digits, status: "NOT_CLICKABLE", page_url: page.url(),
          reason: "Phone number found as plain text — no <a href=\"tel:\"> wrapping it. Cannot be tracked.",
          fix: `Wrap in a tel: link: <a href="tel:${ph.digits}">${ph.raw}</a>. Then add a GTM Click – Just Links trigger for href contains tel: with a GA4 Event tag.`
        });
      }

      // Non-clickable emails
      for (const em of nonClickableEmails) {
        if (uniqueNonClickEmails.has(em.norm)) continue;
        uniqueNonClickEmails.add(em.norm);
        results.ctas.emails.not_clickable++;
        results.ctas.emails.not_clickable_items.push({
          raw: em.raw, norm: em.norm, status: "NOT_CLICKABLE", page_url: page.url(),
          reason: "Email address found as plain text — no <a href=\"mailto:\"> wrapping it. Cannot be tracked.",
          fix: `Wrap in a mailto: link: <a href="mailto:${em.norm}">${em.raw}</a>. Then add a GTM Click – Just Links trigger for href contains mailto: with a GA4 Event tag.`
        });
      }

      // Forms
      const formRes = await testAllFormsOnPage(page, beacons, page.url());
      if (formRes.total_lead_forms_found > 0) results.forms.total_pages_with_forms++;
      results.forms.pages.push(formRes);
    }

    // ── Commit counts ──
    results.ctas.phones.items  = phoneItems;
    results.ctas.emails.items  = emailItems;
    results.ctas.phones.found  = uniquePhones.size;
    results.ctas.emails.found  = uniqueEmails.size;
    results.ctas.phones.tested = phoneItems.length;
    results.ctas.emails.tested = emailItems.length;
    results.ctas.phones.passed = phoneItems.filter(i => i.status === "PASS").length;
    results.ctas.emails.passed = emailItems.filter(i => i.status === "PASS").length;
    results.ctas.phones.failed = phoneItems.filter(i => i.status === "FAIL").length;
    results.ctas.emails.failed = emailItems.filter(i => i.status === "FAIL").length;

    const allFormResults = results.forms.pages.flatMap(p => [...p.first_party_forms, ...p.third_party_forms]);
    const formsPassed    = allFormResults.filter(f => f.status === "PASS").length;
    const formsFound     = allFormResults.length;

    const phoneDuplicateItems = phoneItems.filter(i => i.duplicate_fire_test?.result === "DUPLICATE_FIRED");
    const emailDuplicateItems = emailItems.filter(i => i.duplicate_fire_test?.result === "DUPLICATE_FIRED");

    results.category_scores = {
      forms:                 `${formsPassed}/${formsFound}`,
      calls:                 `${results.ctas.phones.passed}/${results.ctas.phones.found}`,
      emails:                `${results.ctas.emails.passed}/${results.ctas.emails.found}`,
      non_clickable_phones:  results.ctas.phones.not_clickable,
      non_clickable_emails:  results.ctas.emails.not_clickable,
      duplicate_fire_phones: phoneDuplicateItems.length,
      duplicate_fire_emails: emailDuplicateItems.length
    };

    // ── Failure detail ──
    // grade_impact values:
    //   "FAIL" — GTM present but zero conversions fired at all (total tracking failure)
    //   "T2"   — partial: some CTAs fire but not all pages, OR duplicate firing, OR non-clickable contacts
    //   "T3"   — could not test (CAPTCHA/bot protection blocked submission)
    const failureDetail = [];

    // ── Phone calls ──
    if (results.ctas.phones.found > 0) {
      const phoneFailed  = phoneItems.filter(i => i.status === "FAIL");
      const phoneNT      = phoneItems.filter(i => i.status === "NOT_TESTED");
      const phonePassed  = phoneItems.filter(i => i.status === "PASS");

      if (phonePassed.length === 0 && phoneNT.length === phoneItems.length) {
        // All untestable — CAPTCHA / element not found type situation → T3
        failureDetail.push({
          category: "Phone Calls", grade_impact: "T3",
          found: results.ctas.phones.found, tested: results.ctas.phones.tested, passed: 0,
          summary: `${results.ctas.phones.found} phone link(s) found but none could be tested automatically — manual verification required.`,
          items: phoneItems.map(i => ({
            href: i.href, display_text: i.display_text || null, page_url: i.page_url,
            status: i.status, reason: i.reason || null,
            fix: `Phone link could not be clicked (${i.reason || "unknown"}). Test manually in GTM Preview.`
          }))
        });
      } else if (phonePassed.length === 0 && phoneFailed.length > 0) {
        // Tags present, GTM present, clicks registered, but zero events fired → FAIL
        failureDetail.push({
          category: "Phone Calls", grade_impact: "FAIL",
          found: results.ctas.phones.found, tested: results.ctas.phones.tested, passed: 0,
          summary: `${results.ctas.phones.found} phone link(s) found and tested — none fired a GA4 conversion event.`,
          items: phoneItems.map(i => ({
            href: i.href, display_text: i.display_text || null, page_url: i.page_url,
            status: i.status, reason: i.reason || null, generic_events_seen: i.generic_events_seen || [],
            fix: i.status === "FAIL"
              ? (i.generic_events_seen?.length
                ? `GTM fired but only generic events (${i.generic_events_seen.join(", ")}) — add a GA4 Event tag with a Click — Just Links trigger for href contains tel:.`
                : "No GA4 beacon fired. Create a Click — Just Links trigger in GTM for href contains tel: and attach a GA4 Event tag (e.g. event name: click_phone).")
              : `Could not be clicked (${i.reason || "unknown"}). Test manually in GTM Preview.`
          }))
        });
      } else if (phonePassed.length > 0 && phoneFailed.length > 0) {
        // Some pages pass, some fail → T2 (partial coverage)
        failureDetail.push({
          category: "Phone Calls — Partial", grade_impact: "T2",
          found: results.ctas.phones.found, tested: results.ctas.phones.tested,
          passed: phonePassed.length, failed: phoneFailed.length,
          summary: `Phone tracking fires on some pages but not all — ${phonePassed.length} passed, ${phoneFailed.length} failed.`,
          items: phoneItems.map(i => ({
            href: i.href, display_text: i.display_text || null, page_url: i.page_url,
            status: i.status, reason: i.reason || null, generic_events_seen: i.generic_events_seen || [],
            fix: i.status === "FAIL"
              ? (i.generic_events_seen?.length
                ? `GTM fired but only generic events (${i.generic_events_seen.join(", ")}) on ${i.page_url} — check the GTM trigger scope.`
                : `No GA4 beacon fired on ${i.page_url}. Verify the Click — Just Links trigger is firing on all pages, not just certain page paths.`)
              : null
          })).filter(i => i.status === "FAIL")
        });
      }
    }

    // Phone duplicate firing → T2 (real misconfiguration, will skew conversion data)
    if (phoneDuplicateItems.length > 0) {
      failureDetail.push({
        category: "Phone Call — Duplicate Firing", grade_impact: "T2",
        summary: `${phoneDuplicateItems.length} phone CTA(s) fired GA4 more than once on the same page — tag is set to "Once per event" and will double-count conversions.`,
        items: phoneDuplicateItems.map(i => ({
          href: i.href, page_url: i.page_url,
          warning: i.duplicate_fire_test.summary,
          events_on_second_click: i.duplicate_fire_test.events_on_second_click,
          fix: i.duplicate_fire_test.fix
        }))
      });
    }

    // ── Email clicks ──
    if (results.ctas.emails.found > 0) {
      const emailFailed  = emailItems.filter(i => i.status === "FAIL");
      const emailNT      = emailItems.filter(i => i.status === "NOT_TESTED");
      const emailPassed  = emailItems.filter(i => i.status === "PASS");

      if (emailPassed.length === 0 && emailNT.length === emailItems.length) {
        failureDetail.push({
          category: "Email Clicks", grade_impact: "T3",
          found: results.ctas.emails.found, tested: results.ctas.emails.tested, passed: 0,
          summary: `${results.ctas.emails.found} email link(s) found but none could be tested automatically — manual verification required.`,
          items: emailItems.map(i => ({
            href: i.href, display_text: i.display_text || null, page_url: i.page_url,
            status: i.status, reason: i.reason || null,
            fix: `Email link could not be clicked (${i.reason || "unknown"}). Test manually in GTM Preview.`
          }))
        });
      } else if (emailPassed.length === 0 && emailFailed.length > 0) {
        failureDetail.push({
          category: "Email Clicks", grade_impact: "FAIL",
          found: results.ctas.emails.found, tested: results.ctas.emails.tested, passed: 0,
          summary: `${results.ctas.emails.found} email link(s) found and tested — none fired a GA4 conversion event.`,
          items: emailItems.map(i => ({
            href: i.href, display_text: i.display_text || null, page_url: i.page_url,
            status: i.status, reason: i.reason || null, generic_events_seen: i.generic_events_seen || [],
            fix: i.status === "FAIL"
              ? (i.generic_events_seen?.length
                ? `GTM fired but only generic events (${i.generic_events_seen.join(", ")}) — add a GA4 Event tag with a Click — Just Links trigger for href contains mailto:.`
                : "No GA4 beacon fired. Create a Click — Just Links trigger in GTM for href contains mailto: and attach a GA4 Event tag (e.g. event name: click_email).")
              : `Could not be clicked (${i.reason || "unknown"}). Test manually in GTM Preview.`
          }))
        });
      } else if (emailPassed.length > 0 && emailFailed.length > 0) {
        failureDetail.push({
          category: "Email Clicks — Partial", grade_impact: "T2",
          found: results.ctas.emails.found, tested: results.ctas.emails.tested,
          passed: emailPassed.length, failed: emailFailed.length,
          summary: `Email tracking fires on some pages but not all — ${emailPassed.length} passed, ${emailFailed.length} failed.`,
          items: emailItems.map(i => ({
            href: i.href, display_text: i.display_text || null, page_url: i.page_url,
            status: i.status, reason: i.reason || null, generic_events_seen: i.generic_events_seen || [],
            fix: i.status === "FAIL"
              ? (i.generic_events_seen?.length
                ? `GTM fired but only generic events (${i.generic_events_seen.join(", ")}) on ${i.page_url} — check the GTM trigger scope.`
                : `No GA4 beacon fired on ${i.page_url}. Verify the Click — Just Links trigger is firing on all pages.`)
              : null
          })).filter(i => i.status === "FAIL")
        });
      }
    }

    // Email duplicate firing → T2
    if (emailDuplicateItems.length > 0) {
      failureDetail.push({
        category: "Email Click — Duplicate Firing", grade_impact: "T2",
        summary: `${emailDuplicateItems.length} email CTA(s) fired GA4 more than once on the same page — tag is set to "Once per event" and will double-count conversions.`,
        items: emailDuplicateItems.map(i => ({
          href: i.href, page_url: i.page_url,
          warning: i.duplicate_fire_test.summary,
          events_on_second_click: i.duplicate_fire_test.events_on_second_click,
          fix: i.duplicate_fire_test.fix
        }))
      });
    }

    // Non-clickable contacts → T2 (real contacts that cannot be tracked at all)
    const hasNonClickable = results.ctas.phones.not_clickable > 0 || results.ctas.emails.not_clickable > 0;
    if (hasNonClickable) {
      failureDetail.push({
        category: "Non-Clickable Contacts", grade_impact: "T2",
        summary: `${results.ctas.phones.not_clickable} phone(s) and ${results.ctas.emails.not_clickable} email(s) found as plain text — not wrapped in a link, cannot be tracked.`,
        items: [...results.ctas.phones.not_clickable_items, ...results.ctas.emails.not_clickable_items]
          .map(i => ({ raw: i.raw, page_url: i.page_url, status: "NOT_CLICKABLE", reason: i.reason, fix: i.fix }))
      });
    }

    // ── Contact forms ──
    if (formsFound > 0 && formsPassed === 0) {
      const botBlocked  = allFormResults.some(f => f.reason?.includes("Bot Protection"));
      const allNT       = allFormResults.every(f => f.status === "NOT_TESTED");
      const anyActuallySubmitted = allFormResults.some(f => f.status === "FAIL");

      // T3 only when bot protection or genuinely untestable — we cannot say tracking is broken
      // FAIL when we actually submitted and got nothing back
      const formGrade = botBlocked || allNT ? "T3" : "FAIL";

      failureDetail.push({
        category: "Contact Forms", grade_impact: formGrade,
        found: formsFound, tested: allFormResults.filter(f => f.status !== "NOT_TESTED").length, passed: 0,
        summary: botBlocked
          ? `${formsFound} form(s) — CAPTCHA/bot protection blocked automated testing. Manual verification required.`
          : allNT
          ? `${formsFound} form(s) — could not be submitted automatically. Manual verification required.`
          : `${formsFound} form(s) submitted — none fired a GA4 conversion event.`,
        items: allFormResults.map((f, idx) => ({
          form_index: idx, page_url: f.page_url || null,
          status: f.status, reason: f.reason || null,
          ga4_events_seen: f.ga4_events_seen || f.ga4_events || [],
          fix: f.reason?.includes("Bot Protection")
            ? "CAPTCHA present — submit manually and verify GA4 event in GTM Preview."
            : f.status === "FAIL" && f.reason?.includes("success")
            ? "Form submitted (success detected) but no GA4 event fired. Add a GTM trigger for Form Submission or Thank You page URL, with a GA4 Event tag."
            : f.status === "FAIL"
            ? "Form submitted but no GA4 event captured. Check GTM trigger scope — confirm the GA4 Event tag is published and the trigger matches this form."
            : f.reason?.includes("Validation")
            ? "Validation blocked submission. Fill and submit manually, then verify in GTM Preview."
            : f.reason?.includes("No visible submit button")
            ? "No standard submit button found — may use custom JS. Submit manually and verify in GTM Preview."
            : `Could not test automatically (${f.reason || "unknown"}). Submit manually and verify in GTM Preview.`
        }))
      });
    }

    // ── Grading ──
    // FAIL  — GTM present but every CTA/form that was actually tested returned no GA4 event
    //         (or no CTAs found at all on a site that clearly has contact info)
    // T2    — GTM present, at least one CTA passes, but partial coverage / duplicate firing /
    //         non-clickable contacts mean tracking data is incomplete or inflated
    // T3    — GTM present, CTAs found, but CAPTCHA or untestable setup meant we couldn't
    //         confirm tracking — human must verify manually
    // T1    — GTM present, all testable CTAs passed on every page, no issues detected

    const totalFound    = results.ctas.phones.found + results.ctas.emails.found + formsFound;
    const hasFail       = failureDetail.some(f => f.grade_impact === "FAIL");
    const hasT2         = failureDetail.some(f => f.grade_impact === "T2");
    const hasT3         = failureDetail.some(f => f.grade_impact === "T3");
    const anyPassed     = results.ctas.phones.passed > 0 || results.ctas.emails.passed > 0 || formsPassed > 0;

    let grade, overall_status, why;

    if (totalFound === 0 && !hasNonClickable) {
      // No CTAs of any kind found — can't grade tracking
      grade = "T3"; overall_status = "NOT_TESTED";
      why = "No actionable CTAs (phone links, email links, or forms) were found on any visited page.";
    } else if (hasFail && !anyPassed) {
      // Tags exist but nothing at all converted — complete tracking failure
      grade = "FAIL"; overall_status = "NO_CONVERSIONS_TRACKED";
      why = `GTM is installed but no conversion events fired for any tested CTA or form. See failure_detail for fixes.`;
    } else if (hasT2 || (hasFail && anyPassed)) {
      // At least one thing works but there are real issues (partial, duplicate firing, non-clickable)
      grade = "T2"; overall_status = "TRACKING_ISSUES_FOUND";
      const t2cats = failureDetail.filter(f => f.grade_impact === "T2" || f.grade_impact === "FAIL").map(f => f.category);
      why = `Tracking is partially working but has issues: ${t2cats.join(", ")}. See failure_detail for fixes.`;
    } else if (hasT3 && !hasT2 && !hasFail) {
      // Only untestable items — could be fine, could be broken, needs human eyes
      grade = "T3"; overall_status = "NOT_TESTED";
      why = `CTAs found but could not be tested automatically (${failureDetail.map(f => f.category).join(", ")}). Manual verification required.`;
    } else {
      // Everything tested passed, no issues
      grade = "T1"; overall_status = "PASS";
      why = "All detected conversion CTAs and forms are firing GA4 events correctly on every tested page.";
    }

    results.grade = grade; results.overall_status = overall_status; results.why = why;
    results.failure_detail = failureDetail;
    results.needs_improvement = failureDetail.map(f => f.summary);

    // ── Console output ──
    const GRADE_LABEL = { T1: "✅ T1 — PASS", T2: "⚠️  T2 — ISSUES FOUND", T3: "🔍 T3 — NOT TESTED", FAIL: "❌ FAIL — NO CONVERSIONS TRACKED" };
    logInfo(`\n╔══════════════════════════════════════════════╗`);
    logInfo(`  TRACKING HEALTH CHECK RESULT`);
    logInfo(`  URL        : ${targetUrl}`);
    logInfo(`  GRADE      : ${GRADE_LABEL[grade]}`);
    logInfo(`  WHY        : ${why}`);
    logInfo(`  SCORES     : Forms ${results.category_scores.forms} | Calls ${results.category_scores.calls} | Emails ${results.category_scores.emails}`);
    logInfo(`  NON-CLICK  : Phones ${results.ctas.phones.not_clickable} | Emails ${results.ctas.emails.not_clickable}`);
    logInfo(`  DUPE FIRES : Phones ${phoneDuplicateItems.length} | Emails ${emailDuplicateItems.length}`);
    logInfo(`  GTM IDs    : ${tracking.tags_found.gtm.join(", ") || "none"}`);
    logInfo(`  GA4 IDs    : ${[...tracking.tags_found.ga4, ...tracking.tags_found.unlinked_ga4].join(", ") || "none"}`);
    logInfo(`  PAGES      : ${results.pages_visited.join(", ")}`);
    logInfo(`  CONSENT    : ${results.cookie_consent.accepted ? "accepted" : "none found"}`);

    if (failureDetail.length > 0) {
      logInfo(`\n  ── FAILURES ──`);
      failureDetail.forEach(f => {
        logInfo(`\n  [${f.grade_impact}] ${f.category.toUpperCase()} — ${f.summary}`);
        (f.items || []).forEach((item, idx) => {
          logInfo(`    ${idx + 1}. ${item.href || item.raw || "N/A"}  [${item.page_url || ""}]`);
          if (item.status)                         logInfo(`       Status : ${item.status}`);
          if (item.reason)                         logInfo(`       Reason : ${item.reason}`);
          if (item.warning)                        logInfo(`       ⚠️      : ${item.warning}`);
          if (item.events_on_second_click?.length) logInfo(`       2nd click events : ${item.events_on_second_click.join(", ")}`);
          logInfo(`       Fix    : ${item.fix}`);
        });
      });
    }

    const passingCTAs = [...phoneItems, ...emailItems].filter(i => i.status === "PASS");
    if (passingCTAs.length > 0) {
      logInfo(`\n  ── PASSING CTAs ──`);
      passingCTAs.forEach(i => {
        const dup = i.duplicate_fire_test?.result === "DUPLICATE_FIRED" ? "⚠️ DUPLICATE FIRE"
          : i.duplicate_fire_test?.result === "CORRECTLY_SUPPRESSED" ? "✅ once-per-page OK" : "—";
        logInfo(`    ✅ ${i.href}  [${i.page_url}]  dup-test: ${dup}`);
      });
    }

    if (results.ctas.phones.not_clickable_items.length > 0) {
      logInfo(`\n  ── NON-CLICKABLE PHONES ──`);
      results.ctas.phones.not_clickable_items.forEach(p => logInfo(`    📵 ${p.raw}  on ${p.page_url}`));
    }
    if (results.ctas.emails.not_clickable_items.length > 0) {
      logInfo(`\n  ── NON-CLICKABLE EMAILS ──`);
      results.ctas.emails.not_clickable_items.forEach(e => logInfo(`    📵 ${e.raw}  on ${e.page_url}`));
    }

    logInfo(`╚══════════════════════════════════════════════╝\n`);
    logInfo("✅ Check complete", { url: targetUrl, grade, status: overall_status });
    return results;

  } catch (error) {
    logInfo(`❌ Fatal error`, { url: targetUrl, error: error.message });
    return { ...results, ok: false, grade: "T2", overall_status: "ERROR", why: `Fatal error: ${error.message}` };
  } finally {
    // Always clean up page and context — even if withTimeout killed us
    if (page)    { try { page.removeAllListeners(); await page.close();    } catch {} }
    if (context) { try { await context.close();                            } catch {} }
  }
}

async function trackingHealthCheckSite(url) {
  await acquireCheckSlot();
  try {
    return await withTimeout(
      trackingHealthCheckSiteInternal(url),
      GLOBAL_TIMEOUT_MS,
      `Global timeout (${GLOBAL_TIMEOUT_MS}ms) exceeded for ${url}`
    );
  } catch (e) {
    logInfo(`⏱ Check aborted: ${e.message}`, { url });
    return { ok: false, url: normaliseUrl(url), grade: "T2", overall_status: "ERROR", why: e.message };
  } finally {
    releaseCheckSlot();
  }
}

module.exports = { trackingHealthCheckSite };

