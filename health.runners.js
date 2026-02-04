// health.runners.js
// VERSION IDENTIFIER - Update this timestamp each time you push to GitHub
const SCRIPT_VERSION = "2026-02-04T28:10:00Z";

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

// ---------------------------
// URL helpers
// ---------------------------
function normaliseUrl(input) {
  if (!input) return null;
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function safeOrigin(urlStr) {
  try {
    return new URL(urlStr).origin;
  } catch {
    return null;
  }
}

function cssAttrValue(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------
// Config
// ---------------------------
const MAX_PAGES_TO_SCAN = 3; // home + up to 2 extra
const MAX_TEST_LINKS_PER_TYPE = 3;
const MAX_TEST_FORMS_TOTAL = 6;

// event polling after CTA action
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_LINK_MS = 4500;
const POLL_TIMEOUT_FORM_MS = 7000;

// small waits (keep runtime sane)
const POST_NAV_SETTLE_MS = 900;
const AFTER_COOKIE_MS = 600;

// ---------------------------
// Event aliasing (case-insensitive)
// ---------------------------
const EVENT_ALIASES = {
  phone: [
    "click_call",
    "clickcall",
    "click-to-call",
    "click_to_call",
    "phone_click",
    "call_click",
    "tap_to_call",
    "call",
    "link_click",
    "outbound_click",
    "cta_click",
  ],
  email: [
    "click_email",
    "clickemail",
    "click-to-email",
    "click_to_email",
    "email_click",
    "mailto_click",
    "email",
    "link_click",
    "outbound_click",
    "cta_click",
  ],
  form: [
    "contact_form",
    "contactform",
    "contact_form_submit",
    "contact_submit",
    "form_submit",
    "formsubmit",
    "form_submission",
    "form_submitted",
    "submit_form",
    "submit",
    "enquiry",
    "enquiry_submit",
    "quote_request",
    "lead",
    "generate_lead",
    "lead_submit",
    "lead_form_submit",
    "book_now",
    "booking",
    "appointment_booked",
    "request_callback",
    "conversion",
    "purchase",
    "complete",
    "success",
  ],
};

const NOISE_EVENTS = new Set([
  "page_view",
  "user_engagement",
  "scroll",
  "session_start",
  "first_visit",
  "form_start", // treat as noise (too easy to trigger just by filling)
]);

function normaliseEventName(name) {
  return (name || "").toString().trim().toLowerCase();
}

function eventMatchesType(eventName, type) {
  const e = normaliseEventName(eventName);
  if (!e) return false;

  const aliases = EVENT_ALIASES[type] || [];
  if (aliases.includes(e)) return true;

  // extra leniency for common variants
  if (type === "form") {
    if (e.startsWith("form_")) return true;
    if (e.includes("form") && (e.includes("submit") || e.includes("success") || e.includes("complete"))) return true;
    if (e.includes("lead") && (e.includes("submit") || e.includes("success") || e.includes("complete"))) return true;
    if (e.includes("contact") && (e.includes("submit") || e.includes("success") || e.includes("complete"))) return true;
  }

  if (type === "phone") {
    if (e.includes("call") && (e.includes("click") || e.includes("tap"))) return true;
  }

  if (type === "email") {
    if ((e.includes("email") || e.includes("mailto")) && (e.includes("click") || e.includes("tap"))) return true;
  }

  return false;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

// ---------------------------
// Network capture (GA4/GTM)
// ---------------------------
function isGtmRequest(url) {
  return /googletagmanager\.com\/gtm\.js/i.test(url) || /gtm\.js\?id=GTM-/i.test(url);
}

function isGa4Collect(url) {
  return /google-analytics\.com\/g\/collect/i.test(url) || /google-analytics\.com\/collect/i.test(url);
}

function extractEventNamesFromRequest(req) {
  const urlStr = req.url();
  const out = [];

  // GET query param en=
  try {
    const u = new URL(urlStr);
    const en = u.searchParams.get("en");
    if (en) out.push(decodeURIComponent(en));
  } catch {
    // ignore
  }

  // POST body: can be querystring (en=) or JSON (events[])
  let post = "";
  try {
    post = req.postData() || "";
  } catch {
    post = "";
  }

  if (post) {
    // try querystring
    try {
      const params = new URLSearchParams(post);
      const en2 = params.get("en");
      if (en2) out.push(decodeURIComponent(en2));
    } catch {
      // ignore
    }

    // try JSON
    if (post.trim().startsWith("{") || post.trim().startsWith("[")) {
      try {
        const json = JSON.parse(post);
        if (json && Array.isArray(json.events)) {
          for (const ev of json.events) if (ev && ev.name) out.push(ev.name);
        }
      } catch {
        // ignore
      }
    }

    // fallback regex for en=
    if (!out.length) {
      const m = post.match(/(?:^|&)en=([^&\n\r]+)/i);
      if (m && m[1]) out.push(decodeURIComponent(m[1]));
    }
  }

  return out.filter(Boolean);
}

// ---------------------------
// Polling helper (wait for new events)
// ---------------------------
async function pollForNewEvents(eventsCaptured, beforeIdx, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if (eventsCaptured.length > beforeIdx) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

function sliceNewEvents(eventsCaptured, beforeIdx) {
  return eventsCaptured.slice(beforeIdx).map(normaliseEventName);
}

function newNonNoiseEvents(newEvents) {
  const nn = newEvents.filter((e) => e && !NOISE_EVENTS.has(e));
  return uniq(nn);
}

// ---------------------------
// Cookie banner best-effort (main + iframes)
// ---------------------------
async function clickCookieBannersEverywhere(page) {
  const texts = ["accept", "agree", "ok", "okay", "got it", "allow all", "accept all", "i accept", "continue"];

  async function tryInContext(ctx) {
    for (const t of texts) {
      const locator = ctx.locator("button, [role='button'], a").filter({
        hasText: new RegExp(`^\\s*${t}\\s*$`, "i"),
      });
      const count = await locator.count().catch(() => 0);
      if (count > 0) {
        for (let i = 0; i < Math.min(count, 3); i++) {
          try {
            await locator.nth(i).click({ timeout: 800, force: true });
            return true;
          } catch {
            // keep going
          }
        }
      }
    }
    return false;
  }

  try {
    if (await tryInContext(page)) return true;
  } catch {}

  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    try {
      if (await tryInContext(f)) return true;
    } catch {}
  }
  return false;
}

// ---------------------------
// DOM detection of IDs
// ---------------------------
async function detectIdsFromDom(page) {
  const html = await page.content().catch(() => "");
  const gtmIds = uniq((html.match(/\bGTM-[A-Z0-9]+\b/g) || []).map((x) => x.trim()));
  const ga4Ids = uniq((html.match(/\bG-[A-Z0-9]+\b/g) || []).map((x) => x.trim()));
  return { gtmIds, ga4Ids };
}

// ---------------------------
// Page discovery (home + up to 2 contact-ish pages)
// ---------------------------
function isContactishPath(pathname) {
  const p = (pathname || "").toLowerCase();
  return (
    p.includes("contact") ||
    p.includes("enquir") ||
    p.includes("quote") ||
    p.includes("book") ||
    p.includes("appointment") ||
    p.includes("get-in-touch") ||
    p.includes("callback")
  );
}

async function findCandidatePages(page, origin, maxExtra = 2) {
  const links = await page
    .evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter(Boolean))
    .catch(() => []);

  const out = [];
  for (const href of links) {
    try {
      const u = new URL(href, origin);
      if (u.origin !== origin) continue;
      if (!isContactishPath(u.pathname)) continue;
      const clean = u.toString().split("#")[0];
      out.push(clean);
    } catch {}
  }
  return uniq(out).slice(0, maxExtra);
}

// ---------------------------
// Contexts (main + frames)
// ---------------------------
function getContexts(page) {
  const contexts = [{ ctx: page, label: "main", getUrl: () => page.url() }];
  const frames = page.frames();
  let idx = 0;
  for (const f of frames) {
    if (f === page.mainFrame()) continue;
    contexts.push({ ctx: f, label: `frame_${idx++}`, getUrl: () => f.url() });
  }
  return contexts;
}

// ---------------------------
// CTA discovery (phone/email + robust forms)
// ---------------------------
const FORM_ROOT_SELECTORS = [
  "form",
  "[role='form']",
  // common WP plugins / builders
  ".elementor form",
  ".elementor-form",
  "form.wpcf7-form",
  ".wpcf7 form",
  "form.wpforms-form",
  ".wpforms-container form",
  ".gform_wrapper form",
  ".nf-form-cont",
  ".forminator-ui",
  ".formidable_forms_form",
  ".hs-form", // HubSpot (often in iframe)
];

async function collectHrefs(ctx, selector) {
  try {
    const hrefs = await ctx
      .locator(selector)
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")).filter(Boolean));
    return uniq(hrefs);
  } catch {
    return [];
  }
}

async function countFieldsInRoot(rootLocator) {
  // total non-hidden controls
  const total = await rootLocator
    .locator("input:not([type='hidden']), textarea, select")
    .count()
    .catch(() => 0);

  // "visible enough" heuristic (in-page compute)
  const visible = await rootLocator
    .locator("input:not([type='hidden']), textarea, select")
    .evaluateAll((nodes) => {
      const isVisibleEnough = (n) => {
        if (!n) return false;
        const style = window.getComputedStyle(n);
        if (!style) return false;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const r = n.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0;
      };
      return nodes.filter(isVisibleEnough).length;
    })
    .catch(() => 0);

  return { total, visible };
}

async function openLikelyFormModals(page) {
  // Only click non-navigating triggers (buttons, or anchors with #/javascript/empty)
  const trigger = page
    .locator("button, [role='button'], a")
    .filter({ hasText: /contact|enquir|enquiry|book|quote|callback|get in touch|request/i });

  const count = await trigger.count().catch(() => 0);
  if (!count) return false;

  let opened = false;
  for (let i = 0; i < Math.min(count, 2); i++) {
    try {
      const el = trigger.nth(i);
      const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => "");
      if (tag === "a") {
        const href = (await el.getAttribute("href").catch(() => "")) || "";
        const h = href.trim().toLowerCase();
        const safe =
          !h ||
          h.startsWith("#") ||
          h.startsWith("javascript:") ||
          h.startsWith("tel:") ||
          h.startsWith("mailto:");
        if (!safe) continue;
      }
      await el.click({ timeout: 1200, force: true });
      opened = true;
      await page.waitForTimeout(500);
    } catch {}
  }
  return opened;
}

async function findFormCandidates(page) {
  const contexts = getContexts(page);
  const candidates = [];

  for (const c of contexts) {
    for (const sel of FORM_ROOT_SELECTORS) {
      const roots = c.ctx.locator(sel);
      const n = await roots.count().catch(() => 0);
      if (!n) continue;

      // cap per selector/context to avoid explosion
      const cap = Math.min(n, 10);
      for (let i = 0; i < cap; i++) {
        const root = roots.nth(i);

        // bring into view (best-effort)
        try {
          if (typeof root.scrollIntoViewIfNeeded === "function") {
            await root.scrollIntoViewIfNeeded().catch(() => {});
          } else {
            await root.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
          }
        } catch {}

        const { total, visible } = await countFieldsInRoot(root);
        if (total <= 0) continue;

        // build a lightweight signature for dedupe + reporting
        const meta = await root
          .evaluate((el) => {
            const tag = (el.tagName || "").toLowerCase();
            const id = el.id || "";
            const name = el.getAttribute("name") || "";
            const action = el.getAttribute("action") || "";
            const cls = (el.getAttribute("class") || "")
              .split(/\s+/)
              .slice(0, 4)
              .join(".");
            return { tag, id, name, action, cls };
          })
          .catch(() => ({ tag: "unknown", id: "", name: "", action: "", cls: "" }));

        const url = c.getUrl() || "";
        const sig = `${c.label}|${url}|${meta.tag}|${meta.id}|${meta.name}|${meta.action}|${meta.cls}|idx=${i}|sel=${sel}`;

        candidates.push({
          signature: sig,
          root,
          context_label: c.label,
          context_url: url,
          total_fields: total,
          visible_fields: visible,
        });
      }
    }
  }

  // dedupe by signature
  const bySig = new Map();
  for (const cand of candidates) {
    if (!bySig.has(cand.signature)) bySig.set(cand.signature, cand);
    else {
      // keep the one with more visible fields
      const prev = bySig.get(cand.signature);
      if ((cand.visible_fields || 0) > (prev.visible_fields || 0)) bySig.set(cand.signature, cand);
    }
  }

  // prioritise candidates with more visible fields (likely the real contact form)
  const deduped = Array.from(bySig.values()).sort((a, b) => (b.visible_fields || 0) - (a.visible_fields || 0));

  // keep a sane cap per page
  return deduped.slice(0, 12);
}

// ---------------------------
// CTA testing helpers
// ---------------------------
async function clickLocatorAndCollectEvents({ page, locator, type, eventsCaptured, timeoutMs }) {
  const before = eventsCaptured.length;

  let clicked = false;
  try {
    await locator.click({ timeout: 2500, force: true });
    clicked = true;
  } catch {
    // still poll; some sites fire on mousedown etc
  }

  await pollForNewEvents(eventsCaptured, before, timeoutMs);
  const newEvents = sliceNewEvents(eventsCaptured, before);

  const matched = newEvents.filter((ev) => eventMatchesType(ev, type));
  const nonNoise = newNonNoiseEvents(newEvents);

  // success rule:
  // - links: matched OR any new non-noise event
  // - forms: handled separately (requires submit click attempt)
  const ok = matched.length > 0 || nonNoise.length > 0;

  return { clicked, newEvents: uniq(newEvents), matched: uniq(matched), nonNoise, ok };
}

// ---------------------------
// Form fill/submit
// ---------------------------
function looksLikeEmailField(nameOrId) {
  const s = (nameOrId || "").toLowerCase();
  return s.includes("email");
}
function looksLikePhoneField(nameOrId) {
  const s = (nameOrId || "").toLowerCase();
  return s.includes("phone") || s.includes("tel") || s.includes("mobile");
}
function looksLikeNameField(nameOrId) {
  const s = (nameOrId || "").toLowerCase();
  return s.includes("name") || s.includes("fullname") || s.includes("first") || s.includes("last");
}
function looksLikeMessageField(nameOrId) {
  const s = (nameOrId || "").toLowerCase();
  return s.includes("message") || s.includes("enquiry") || s.includes("comment");
}

async function tryTickConsentCheckboxes(root) {
  // tick likely required consent/privacy checkboxes (best-effort)
  const boxes = root.locator("input[type='checkbox']");
  const n = await boxes.count().catch(() => 0);
  if (!n) return;

  for (let i = 0; i < Math.min(n, 4); i++) {
    const box = boxes.nth(i);
    try {
      const labelText = await box
        .evaluate((el) => {
          const id = el.id;
          const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          const near = el.closest("label");
          return (lbl?.innerText || near?.innerText || "").trim();
        })
        .catch(() => "");
      if (/privacy|gdpr|consent|terms|marketing/i.test(labelText || "")) {
        await box.check({ timeout: 1200, force: true }).catch(() => {});
      }
    } catch {}
  }
}

async function tryFillFormRoot(root) {
  // Fill controls best-effort (no real PII)
  const fields = root.locator("input:not([type='hidden']), textarea, select");
  const count = await fields.count().catch(() => 0);

  // keep it sane
  const cap = Math.min(count, 12);

  for (let i = 0; i < cap; i++) {
    const el = fields.nth(i);
    try {
      // skip disabled/readonly
      const disabled = await el.isDisabled().catch(() => false);
      if (disabled) continue;

      const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => "");
      const type = ((await el.getAttribute("type").catch(() => "")) || "").toLowerCase();
      const name = (await el.getAttribute("name").catch(() => "")) || "";
      const id = (await el.getAttribute("id").catch(() => "")) || "";
      const key = `${name} ${id}`.trim().toLowerCase();

      // skip non-textual / captcha-ish
      if (["submit", "button", "file", "image"].includes(type)) continue;
      if (type === "checkbox" || type === "radio") continue;

      // best-effort scroll
      try {
        if (typeof el.scrollIntoViewIfNeeded === "function") await el.scrollIntoViewIfNeeded().catch(() => {});
      } catch {}

      if (tag === "select") {
        await el.selectOption({ index: 1 }).catch(() => {});
        continue;
      }

      if (tag === "textarea" || looksLikeMessageField(key)) {
        await el.fill("Test enquiry").catch(() => {});
        continue;
      }

      if (looksLikeEmailField(key) || type === "email") {
        await el.fill("test@example.com").catch(() => {});
        continue;
      }

      if (looksLikePhoneField(key) || type === "tel") {
        await el.fill("07123456789").catch(() => {});
        continue;
      }

      if (looksLikeNameField(key)) {
        await el.fill("Test User").catch(() => {});
        continue;
      }

      // generic
      if (tag === "input") {
        await el.fill("Test").catch(() => {});
      }
    } catch {
      // ignore per-field failures
    }
  }

  await tryTickConsentCheckboxes(root).catch(() => {});
}

async function submitFormRootAndCollectEvents({ page, root, eventsCaptured }) {
  const before = eventsCaptured.length;

  // captcha presence check (common)
  const captchaCount = await root
    .locator("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], [data-sitekey], .g-recaptcha, .h-captcha")
    .count()
    .catch(() => 0);

  // try fill (even if captcha exists)
  await tryFillFormRoot(root).catch(() => {});

  // try submit click
  let clickedSubmit = false;

  // Prefer explicit submit buttons inside root
  const submitBtn = root.locator("button[type='submit'], input[type='submit']").first();
  if ((await submitBtn.count().catch(() => 0)) > 0) {
    try {
      await submitBtn.click({ timeout: 3000, force: true });
      clickedSubmit = true;
    } catch {}
  }

  // Fallback: any button that looks like submit
  if (!clickedSubmit) {
    const fallbackBtn = root
      .locator("button, [role='button'], input[type='button'], a")
      .filter({ hasText: /submit|send|enquir|enquiry|contact|book|get quote|request|next|continue/i })
      .first();

    if ((await fallbackBtn.count().catch(() => 0)) > 0) {
      try {
        await fallbackBtn.click({ timeout: 3000, force: true });
        clickedSubmit = true;
      } catch {}
    }
  }

  await pollForNewEvents(eventsCaptured, before, POLL_TIMEOUT_FORM_MS);
  const newEvents = sliceNewEvents(eventsCaptured, before);

  const matched = newEvents.filter((ev) => eventMatchesType(ev, "form"));
  const nonNoise = newNonNoiseEvents(newEvents);

  // Form success rule (your intent):
  // - requires we attempted to click submit-like control
  // - then needs either matched alias OR any non-noise event
  const ok = Boolean(clickedSubmit) && (matched.length > 0 || nonNoise.length > 0);

  return {
    clicked_submit: clickedSubmit,
    captcha_present: captchaCount > 0,
    new_events: uniq(newEvents),
    matched: uniq(matched),
    non_noise: nonNoise,
    ok,
  };
}

// ---------------------------
// Status rules (your exact logic)
// ---------------------------
function statusForType(found, tested, failedCount) {
  if (!found || found === 0) return "na";
  return failedCount === 0 && tested > 0 ? "pass" : "fail";
}

function computeHealthStatus({ codes_on_site, gtm_loaded, ga4_collect_seen, ctaTypeStatuses }) {
  const baseOk = Boolean(codes_on_site && gtm_loaded && ga4_collect_seen);
  if (!baseOk) return "fail";

  for (const s of Object.values(ctaTypeStatuses)) {
    if (s === "na") continue;
    if (s !== "pass") return "fail";
  }
  return "pass";
}

// ---------------------------
// Main runner
// ---------------------------
async function runHealthCheck(input) {
  const website_url = typeof input === "string" ? input : input?.website_url || input?.url;
  const targetUrl = normaliseUrl(website_url);

  const result = {
    script_version: SCRIPT_VERSION,
    website_url: targetUrl,
    ran_at: new Date().toISOString(),

    codes_on_site: false,
    firing_ok: false,
    gtm_loaded: false,
    ga4_collect_seen: false,

    detected_gtm_ids: [],
    detected_ga4_ids: [],

    health_status: "fail",
    evidence: {},
    cta_summary: {},
  };

  if (!targetUrl) {
    result.evidence = { error: "No website_url provided" };
    return result;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });
  const page = await context.newPage();

  // capture
  const gtmRequests = [];
  const ga4CollectRequests = [];
  const ga4EventsCaptured = [];

  page.on("request", (req) => {
    const url = req.url();
    if (isGtmRequest(url)) gtmRequests.push(url);

    if (isGa4Collect(url)) {
      ga4CollectRequests.push(url);
      const names = extractEventNamesFromRequest(req);
      for (const n of names) ga4EventsCaptured.push(n);
    }
  });

  try {
    logInfo("🔎 Health run start", { website_url: targetUrl, version: SCRIPT_VERSION });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(POST_NAV_SETTLE_MS);

    await clickCookieBannersEverywhere(page).catch(() => {});
    await page.waitForTimeout(AFTER_COOKIE_MS);

    const origin = safeOrigin(page.url()) || safeOrigin(targetUrl);

    // discover extra pages (contact-ish)
    const extraPages = origin ? await findCandidatePages(page, origin, MAX_PAGES_TO_SCAN - 1) : [];
    const pagesToScan = uniq([page.url().split("#")[0], ...extraPages]).slice(0, MAX_PAGES_TO_SCAN);

    // CTA evidence
    const cta_details = {
      phone_clicks: { found: 0, tested: 0, passed: [], failed: [] },
      email_clicks: { found: 0, tested: 0, passed: [], failed: [] },
      forms: { found: 0, tested: 0, passed: [], failed: [] },
    };

    const phoneFound = new Set();
    const emailFound = new Set();
    const phoneTested = new Set();
    const emailTested = new Set();
    const formFound = new Set();

    let phoneBudget = MAX_TEST_LINKS_PER_TYPE;
    let emailBudget = MAX_TEST_LINKS_PER_TYPE;
    let formBudget = MAX_TEST_FORMS_TOTAL;

    for (let p = 0; p < pagesToScan.length; p++) {
      const url = pagesToScan[p];
      if (p > 0) {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
          await page.waitForTimeout(POST_NAV_SETTLE_MS);
          await clickCookieBannersEverywhere(page).catch(() => {});
          await page.waitForTimeout(AFTER_COOKIE_MS);
        } catch {
          continue;
        }
      }

      // Try open modal-triggered forms if we don't see form roots immediately
      // (best-effort, minimal clicks)
      const preCandidates = await findFormCandidates(page);
      if (preCandidates.length === 0) {
        await openLikelyFormModals(page).catch(() => {});
      }

      // contexts (main + frames)
      const contexts = getContexts(page);

      // phone/email discovery + per-page testing (ensures the locator exists where we click)
      for (const c of contexts) {
        const telHrefs = await collectHrefs(c.ctx, "a[href^='tel:']");
        const mailHrefs = await collectHrefs(c.ctx, "a[href^='mailto:']");

        for (const h of telHrefs) phoneFound.add(h);
        for (const h of mailHrefs) emailFound.add(h);

        // test phone links (budgeted)
        for (const href of telHrefs) {
          if (phoneBudget <= 0) break;
          if (phoneTested.has(href)) continue;

          phoneTested.add(href);
          phoneBudget -= 1;

          const loc = c.ctx.locator(`a[href="${cssAttrValue(href)}"]`).first();
          const res = await clickLocatorAndCollectEvents({
            page,
            locator: loc,
            type: "phone",
            eventsCaptured: ga4EventsCaptured,
            timeoutMs: POLL_TIMEOUT_LINK_MS,
          });

          cta_details.phone_clicks.tested += 1;
          if (res.ok) {
            cta_details.phone_clicks.passed.push({
              link: href,
              action_events: res.matched.length ? res.matched : res.nonNoise,
              events_seen: res.newEvents,
              reason: "Action event fired",
              context: c.label,
              page_url: c.getUrl(),
            });
          } else {
            cta_details.phone_clicks.failed.push({
              link: href,
              reason: `No matching/non-noise GA4 event (saw: ${res.newEvents.join(", ") || "none"})`,
              context: c.label,
              page_url: c.getUrl(),
            });
          }
        }

        // test email links (budgeted)
        for (const href of mailHrefs) {
          if (emailBudget <= 0) break;
          if (emailTested.has(href)) continue;

          emailTested.add(href);
          emailBudget -= 1;

          const loc = c.ctx.locator(`a[href="${cssAttrValue(href)}"]`).first();
          const res = await clickLocatorAndCollectEvents({
            page,
            locator: loc,
            type: "email",
            eventsCaptured: ga4EventsCaptured,
            timeoutMs: POLL_TIMEOUT_LINK_MS,
          });

          cta_details.email_clicks.tested += 1;
          if (res.ok) {
            cta_details.email_clicks.passed.push({
              link: href,
              action_events: res.matched.length ? res.matched : res.nonNoise,
              events_seen: res.newEvents,
              reason: "Action event fired",
              context: c.label,
              page_url: c.getUrl(),
            });
          } else {
            cta_details.email_clicks.failed.push({
              link: href,
              reason: `No matching/non-noise GA4 event (saw: ${res.newEvents.join(", ") || "none"})`,
              context: c.label,
              page_url: c.getUrl(),
            });
          }
        }
      }

      // forms discovery + testing (budgeted)
      if (formBudget > 0) {
        const formCandidates = await findFormCandidates(page);

        // count unique found forms by signature
        for (const cand of formCandidates) formFound.add(cand.signature);

        // test top candidates by visible_fields
        const toTest = formCandidates.slice(0, Math.min(formBudget, formCandidates.length));
        for (const cand of toTest) {
          if (formBudget <= 0) break;

          formBudget -= 1;
          cta_details.forms.tested += 1;

          // ensure root in view before submit
          try {
            if (typeof cand.root.scrollIntoViewIfNeeded === "function") {
              await cand.root.scrollIntoViewIfNeeded().catch(() => {});
            } else {
              await cand.root.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
            }
          } catch {}

          const submitRes = await submitFormRootAndCollectEvents({
            page,
            root: cand.root,
            eventsCaptured: ga4EventsCaptured,
          });

          if (submitRes.ok) {
            cta_details.forms.passed.push({
              signature: cand.signature,
              completion_events: submitRes.matched.length ? submitRes.matched : submitRes.non_noise,
              events_seen: submitRes.new_events,
              clicked_submit: submitRes.clicked_submit,
              captcha_present: submitRes.captcha_present,
              reason: "Form action event fired",
              context: cand.context_label,
              page_url: cand.context_url,
              fields: { total: cand.total_fields, visible: cand.visible_fields },
            });
          } else {
            const extra = submitRes.captcha_present ? " (captcha present)" : "";
            cta_details.forms.failed.push({
              signature: cand.signature,
              reason: `No matching/non-noise GA4 event after submit${extra} (saw: ${
                submitRes.new_events.join(", ") || "none"
              })`,
              clicked_submit: submitRes.clicked_submit,
              captcha_present: submitRes.captcha_present,
              context: cand.context_label,
              page_url: cand.context_url,
              fields: { total: cand.total_fields, visible: cand.visible_fields },
            });
          }
        }
      }
    }

    // set found counts (unique)
    cta_details.phone_clicks.found = phoneFound.size;
    cta_details.email_clicks.found = emailFound.size;
    cta_details.forms.found = formFound.size;

    // base tracking signals
    const { gtmIds, ga4Ids } = await detectIdsFromDom(page);
    const codes_on_site = gtmIds.length > 0 || ga4Ids.length > 0;
    const gtm_loaded = gtmRequests.length > 0 || gtmIds.length > 0;
    const ga4_collect_seen = ga4CollectRequests.length > 0;

    // per-type statuses with your rules
    const phoneStatus = statusForType(cta_details.phone_clicks.found, cta_details.phone_clicks.tested, cta_details.phone_clicks.failed.length);
    const emailStatus = statusForType(cta_details.email_clicks.found, cta_details.email_clicks.tested, cta_details.email_clicks.failed.length);
    const formStatus  = statusForType(cta_details.forms.found,      cta_details.forms.tested,      cta_details.forms.failed.length);

    const health_status = computeHealthStatus({
      codes_on_site,
      gtm_loaded,
      ga4_collect_seen,
      ctaTypeStatuses: { phone: phoneStatus, email: emailStatus, forms: formStatus },
    });

    // summary (what worked + what failed)
    const cta_summary = {
      phone: {
        found: cta_details.phone_clicks.found,
        tested: cta_details.phone_clicks.tested,
        passed: cta_details.phone_clicks.passed.length,
        failed: cta_details.phone_clicks.failed.length,
        status: phoneStatus,
        worked: cta_details.phone_clicks.passed.map((x) => x.link),
        failed_items: cta_details.phone_clicks.failed.map((x) => x.link),
      },
      email: {
        found: cta_details.email_clicks.found,
        tested: cta_details.email_clicks.tested,
        passed: cta_details.email_clicks.passed.length,
        failed: cta_details.email_clicks.failed.length,
        status: emailStatus,
        worked: cta_details.email_clicks.passed.map((x) => x.link),
        failed_items: cta_details.email_clicks.failed.map((x) => x.link),
      },
      forms: {
        found: cta_details.forms.found,
        tested: cta_details.forms.tested,
        passed: cta_details.forms.passed.length,
        failed: cta_details.forms.failed.length,
        status: formStatus,
        worked: cta_details.forms.passed.map((x) => x.signature),
        failed_items: cta_details.forms.failed.map((x) => x.signature),
      },
    };

    result.codes_on_site = codes_on_site;
    result.gtm_loaded = gtm_loaded;
    result.ga4_collect_seen = ga4_collect_seen;
    result.detected_gtm_ids = gtmIds;
    result.detected_ga4_ids = ga4Ids;

    result.health_status = health_status;
    result.firing_ok = health_status === "pass";
    result.cta_summary = cta_summary;

    result.evidence = {
      pages_scanned: pagesToScan,
      total_beacons: ga4CollectRequests.length,
      ga4_events_captured: uniq(ga4EventsCaptured.map(normaliseEventName)),
      cta_details,
      base_tracking: {
        codes_on_site,
        gtm_loaded,
        ga4_collect_seen,
        detected_gtm_ids: gtmIds,
        detected_ga4_ids: ga4Ids,
        gtm_requests_sample: gtmRequests.slice(0, 8),
        ga4_collect_sample: ga4CollectRequests.slice(0, 8),
      },
    };

    logInfo("✅ Health run done", {
      website_url: targetUrl,
      health_status: result.health_status,
      codes_on_site: result.codes_on_site,
      gtm_loaded: result.gtm_loaded,
      ga4_collect_seen: result.ga4_collect_seen,
      cta_statuses: { phone: phoneStatus, email: emailStatus, forms: formStatus },
    });

    return result;
  } catch (err) {
    result.health_status = "fail";
    result.firing_ok = false;
    result.evidence = {
      error: err?.message || String(err),
      stack: err?.stack || null,
      total_beacons: ga4CollectRequests.length,
      ga4_events_captured: uniq(ga4EventsCaptured.map(normaliseEventName)),
    };
    logInfo("❌ Health run error", result.evidence);
    return result;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = {
  trackingHealthCheckSite: runHealthCheck  // Map the export name to the actual function
};
