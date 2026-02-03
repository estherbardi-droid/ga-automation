// health.runners.js (GOLD)
// Goals:
// - Deterministic "is tracking up/down" using NETWORK truth (GA4 collect + GTM gtm.js)
// - Reliable GA4 event extraction (GET + POST body)
// - Cookie consent clicking across iframes
// - CTA testing that triggers GTM listeners without OS-handlers (tel/mailto prevented)
// - Form detection across FRAMES + common form wrappers (not just <form>)
// - Test EVERY crawled contact-like page (not just the last one)
// - Dedupe CTAs across pages so totals are real
// - Clear OK / WARN / FAIL classification (FAIL = GA4 collect not seen)

const { chromium } = require('playwright');

// ------------------------------
// Utils
// ------------------------------
function normaliseUrl(input) {
  if (!input) return null;
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function toHttpsFirst(u) {
  if (!u) return u;
  return u.replace(/^http:\/\//i, 'https://');
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function safeLower(s) {
  return (s || '').toString().toLowerCase();
}

function isSameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function ctaKey(href, text) {
  return `${(href || '').trim()}|${(text || '').trim()}`;
}

// ------------------------------
// Tracking matching
// ------------------------------
function looksLikeGA4Collect(reqUrl) {
  const u = reqUrl || '';
  return (
    u.includes('google-analytics.com') &&
    (u.includes('/g/collect') || u.includes('/collect') || u.includes('/r/collect') || u.includes('/j/collect'))
  );
}

function looksLikeGTM(reqUrl) {
  const u = reqUrl || '';
  return u.includes('googletagmanager.com') && u.includes('gtm.js');
}

function isTrackingRelated(reqUrl) {
  const u = reqUrl || '';
  return (
    u.includes('google-analytics.com') ||
    u.includes('googletagmanager.com') ||
    u.includes('analytics.google.com') ||
    u.includes('/g/collect') ||
    u.includes('/collect') ||
    u.includes('/r/collect') ||
    u.includes('/j/collect') ||
    u.includes('gtm.js') ||
    u.includes('gtag')
  );
}

function parseGA4FromUrl(url) {
  try {
    const u = new URL(url);
    return {
      en: u.searchParams.get('en') || null,
      tid: u.searchParams.get('tid') || null
    };
  } catch {
    return { en: null, tid: null };
  }
}

function parseGA4FromPostData(postData) {
  try {
    // Often x-www-form-urlencoded
    const params = new URLSearchParams(postData);
    return {
      en: params.get('en') || null,
      tid: params.get('tid') || null
    };
  } catch {
    return { en: null, tid: null };
  }
}

// ------------------------------
// Event patterns (tightened to reduce false positives)
// ------------------------------
const IGNORE_EXACT_EVENTS = ['page_view', 'scroll', 'user_engagement', 'session_start', 'first_visit'];

const PHONE_EVENT_PATTERNS = ['click_call', 'call_click', 'phone_click', 'click_phone', 'click_tel', 'tel_click', 'tap_to_call'];
const EMAIL_EVENT_PATTERNS = ['click_email', 'email_click', 'mailto_click', 'click_mail', 'mail_click'];

const FORM_START_PATTERNS = ['form_start', 'start_form', 'form_begin', 'begin_form'];
const FORM_SUBMIT_PATTERNS = [
  'form_submit',
  'submit_form',
  'form_submission',
  'generate_lead',
  'lead',
  'form_complete',
  'form_success',
  'contact_submit',
  'contact_form_submit',
  'submit_lead_form'
];

function isRelevantEventName(eventName, patterns) {
  if (!eventName) return false;
  const ev = safeLower(eventName);
  if (IGNORE_EXACT_EVENTS.includes(ev)) return false;
  return patterns.some(p => ev.includes(safeLower(p)));
}

// ------------------------------
// Page interaction helpers
// ------------------------------
async function scrollToFooter(page) {
  try {
    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const max = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const step = Math.max(450, Math.floor(window.innerHeight * 0.85));
      for (let y = 0; y < max; y += step) {
        window.scrollTo(0, y);
        await sleep(120);
      }
      window.scrollTo(0, max);
    });
  } catch {}
}

async function robustClick(locator, page, labelForLogs = '') {
  // Goal: trigger site click handlers (GTM listeners), not OS handlers.
  // Return: { ok: boolean, reason?: string }
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(120);

    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return { ok: false, reason: 'Not visible' };

    // Trial click validates actionability without actual click
    await locator.click({ trial: true, timeout: 2000 }).catch(() => {});

    // Normal click
    await locator.click({ timeout: 3000 }).catch(async () => {
      // Fallback: dispatch click event
      await locator.evaluate(el => {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(ev);
      }).catch(() => {});
    });

    await page.waitForTimeout(500);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `${labelForLogs} ${e.message}`.trim() };
  }
}

async function clickConsentEverywhere(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Allow all")',
    'button:has-text("I Accept")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    'button:has-text("Continue")',
    '.cookie-accept',
    '[aria-label*="accept" i]',
    '[id*="accept" i]',
    '[class*="accept" i]'
  ];

  let clicked = false;

  // Consent often lives in iframes
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      try {
        const loc = frame.locator(sel).first();
        const has = await loc.count().catch(() => 0);
        if (!has) continue;

        const vis = await loc.isVisible().catch(() => false);
        if (!vis) continue;

        await loc.click({ timeout: 2500 }).catch(async () => {
          await loc.click({ force: true, timeout: 2500 }).catch(() => {});
        });

        clicked = true;
        await page.waitForTimeout(900);
      } catch {}
    }
  }

  return clicked;
}

async function detectTagsInDom(page) {
  return page.evaluate(() => {
    const tags = { gtm: [], ga4: [] };

    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      const content = (s.innerHTML || '') + (s.src || '');
      const gtm = content.match(/GTM-[A-Z0-9]+/g);
      if (gtm) tags.gtm.push(...gtm);

      const ga4 = content.match(/G-[A-Z0-9]+/g);
      if (ga4) tags.ga4.push(...ga4);
    }

    const noscripts = Array.from(document.querySelectorAll('noscript'));
    for (const ns of noscripts) {
      const gtm = (ns.innerHTML || '').match(/GTM-[A-Z0-9]+/g);
      if (gtm) tags.gtm.push(...gtm);
    }

    return {
      gtm: Array.from(new Set(tags.gtm)),
      ga4: Array.from(new Set(tags.ga4)),
      hasGtmObj: !!window.google_tag_manager,
      hasGtagFn: !!window.gtag
    };
  });
}

async function detectCaptchaAnywhere(page) {
  try {
    for (const frame of page.frames()) {
      const r = await frame
        .evaluate(() => {
          const hasRecaptcha = !!document.querySelector('iframe[src*="recaptcha"], div.g-recaptcha');
          const hasHcaptcha = !!document.querySelector('iframe[src*="hcaptcha"], div.h-captcha');
          const hasTurnstile = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], div.cf-turnstile');
          return hasRecaptcha || hasHcaptcha || hasTurnstile;
        })
        .catch(() => false);
      if (r) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ------------------------------
// Forms (across frames + common wrappers)
// ------------------------------
const FORM_CONTAINER_SELECTORS = [
  'form',
  '[role="form"]',
  '.wpcf7',
  '.wpforms-container',
  '.gform_wrapper',
  '.elementor-form',
  '.hs-form',
  '[data-form-id]'
];

async function findFormCandidatesAcrossFrames(page, maxPerFrame = 10) {
  const candidates = [];

  for (const frame of page.frames()) {
    for (const sel of FORM_CONTAINER_SELECTORS) {
      const loc = frame.locator(sel);
      const count = await loc.count().catch(() => 0);
      if (!count) continue;

      for (let i = 0; i < Math.min(count, maxPerFrame); i++) {
        const container = loc.nth(i);

        const vis = await container.isVisible().catch(() => false);
        if (!vis) continue;

        // Must have at least 2 visible fields
        const fieldsCount = await container.locator('input:visible, textarea:visible, select:visible').count().catch(() => 0);
        if (fieldsCount < 2) continue;

        // Must have a submit-like button
        const submitCount = await container
          .locator(
            'button[type="submit"], input[type="submit"], button:has-text("Send"), button:has-text("Submit"), button:has-text("Enquire"), button:has-text("Enquiry"), button:has-text("Contact"), button:has-text("Book"), button:has-text("Request")'
          )
          .count()
          .catch(() => 0);

        if (!submitCount) continue;

        candidates.push({ frameUrl: frame.url(), selector: sel, index: i, container });
      }
    }
  }

  // Deduplicate by frameUrl+selector+index (stable enough)
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = `${c.frameUrl}|${c.selector}|${c.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  return unique;
}

async function tryFillContainer(container, page) {
  const notes = [];
  let filled = 0;

  const hasCaptcha = await detectCaptchaAnywhere(page);
  if (hasCaptcha) notes.push('captcha_detected');

  const fields = await container.locator('input:visible, textarea:visible, select:visible').all().catch(() => []);
  for (const field of fields.slice(0, 25)) {
    try {
      const tag = await field.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
      const type = safeLower(await field.getAttribute('type').catch(() => ''));
      const name = safeLower(await field.getAttribute('name').catch(() => ''));
      const placeholder = safeLower(await field.getAttribute('placeholder').catch(() => ''));

      if (type === 'password' || type === 'file') continue;

      if (tag === 'select') {
        await field.selectOption({ index: 1 }).catch(() => {});
        filled++;
        continue;
      }

      if (tag === 'textarea') {
        await field.fill('Test message').catch(() => {});
        filled++;
        continue;
      }

      if (type === 'checkbox') {
        await field.check().catch(() => {});
        filled++;
        continue;
      }

      const looksEmail = type === 'email' || name.includes('email') || placeholder.includes('email');
      const looksPhone = type === 'tel' || name.includes('phone') || name.includes('tel') || placeholder.includes('phone');
      const looksName = name.includes('name') || placeholder.includes('name');

      if (looksEmail) {
        await field.fill('test@example.com').catch(() => {});
        filled++;
      } else if (looksPhone) {
        await field.fill('5551234567').catch(() => {});
        filled++;
      } else if (looksName) {
        await field.fill('Test User').catch(() => {});
        filled++;
      } else if (type === 'text' || type === 'search' || type === '' || type === 'url') {
        await field.fill('Test').catch(() => {});
        filled++;
      }
    } catch {}
  }

  return { filledFields: filled, notes };
}

// ------------------------------
// Main runner
// ------------------------------
async function trackingHealthCheckSite(inputUrl) {
  const startedAt = Date.now();
  const MAX_RUNTIME = 10 * 60 * 1000;

  const browser = await chromium.launch({
    headless: true,
    timeout: 90000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });

  // Prevent tel/mailto default navigation so clicks still trigger GTM listeners
  await context.addInitScript(() => {
    // dataLayer capture (supporting evidence)
    window.__ap_dl_events = [];
    window.dataLayer = window.dataLayer || [];
    const dl = window.dataLayer;

    // wrap push early
    const origPush = dl.push.bind(dl);
    dl.push = (...args) => {
      try {
        for (const a of args) {
          if (a && typeof a === 'object' && a.event) {
            window.__ap_dl_events.push({ ts: Date.now(), event: a.event, data: a });
          }
        }
      } catch {}
      return origPush(...args);
    };

    // prevent OS handlers for schemes
    document.addEventListener(
      'click',
      e => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (href.startsWith('tel:') || href.startsWith('mailto:')) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  });

  const page = await context.newPage();

  // Close popups if any (keeps runs stable)
  page.on('popup', p => p.close().catch(() => {}));
  context.on('page', p => {
    if (p !== page) p.close().catch(() => {});
  });

  // Beacon store (NETWORK truth)
  const allBeacons = [];
  page.on('request', request => {
    const reqUrl = request.url();
    if (!isTrackingRelated(reqUrl)) return;

    const ts = Date.now();
    const entry = {
      url: reqUrl,
      timestamp: new Date(ts).toISOString(),
      timestampMs: ts,
      type: 'Other',
      event_name: null,
      measurement_id: null,
      method: request.method()
    };

    if (looksLikeGTM(reqUrl)) entry.type = 'GTM';

    if (looksLikeGA4Collect(reqUrl)) {
      entry.type = 'GA4';
      const fromUrl = parseGA4FromUrl(reqUrl);
      entry.event_name = fromUrl.en;
      entry.measurement_id = fromUrl.tid;

      const post = request.postData();
      if (post) {
        const fromPost = parseGA4FromPostData(post);
        entry.event_name = fromPost.en || entry.event_name;
        entry.measurement_id = fromPost.tid || entry.measurement_id;
      }
    }

    allBeacons.push(entry);
  });

  const results = {
    url: normaliseUrl(inputUrl),
    final_url: null,
    timestamp: new Date().toISOString(),

    // outputs you already use in DB
    codes_on_site: false,
    firing_ok: false,
    gtm_loaded: false,
    ga4_collect_seen: false,
    detected_gtm_ids: [],
    detected_ga4_ids: [],

    // detailed
    tracking: {
      gtm_found: false,
      ga4_found: false,
      gtm_loaded: false,
      ga4_collect_seen: false,
      gtm_ids: [],
      ga4_ids: [],
      evidence: {
        total_beacons: 0,
        saw_gtm_js: false,
        saw_ga4_collect: false,
        ga4_events_captured: [],
        datalayer_events_captured: []
      }
    },

    ctas: {
      phone: { total_found: 0, total_tested: 0, working: 0, broken: 0, working_details: [], broken_details: [] },
      email: { total_found: 0, total_tested: 0, working: 0, broken: 0, working_details: [], broken_details: [] },
      forms: {
        total_found: 0,
        total_tested: 0,
        working: 0, // submit tracked
        partial: 0, // only start tracked
        broken: 0,
        working_details: [],
        partial_details: [],
        broken_details: []
      }
    },

    issues: [],
    cta_summary: null,

    // final classification
    health_status: 'ok', // ok | warn | fail | error
    overall_status: 'HEALTHY', // HEALTHY | WARNING | FAILING | ERROR
    summary: ''
  };

  // Dedupe across pages
  const tested = { phone: new Set(), email: new Set(), forms: new Set() };

  function beaconsBetween(beforeCount, startMs, endMs) {
    return allBeacons.slice(beforeCount).filter(b => b.timestampMs >= startMs && b.timestampMs <= endMs);
  }

  async function getDataLayerBetween(startMs, endMs) {
    try {
      const arr = await page.evaluate(() => Array.isArray(window.__ap_dl_events) ? window.__ap_dl_events : []);
      return (arr || []).filter(x => x && x.ts >= startMs && x.ts <= endMs).map(x => x.event).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function collectTrackingEvidence() {
    const beacons = allBeacons;
    const sawGtm = beacons.some(b => b.type === 'GTM');
    const ga4 = beacons.filter(b => b.type === 'GA4');
    const sawGa4 = ga4.length > 0;

    const events = uniq(ga4.map(b => b.event_name).filter(Boolean));
    const dlEvents = await page.evaluate(() => Array.isArray(window.__ap_dl_events) ? window.__ap_dl_events.map(x => x.event).filter(Boolean) : []).catch(() => []);
    const dlUniq = uniq(dlEvents);

    results.tracking.evidence.total_beacons = beacons.length;
    results.tracking.evidence.saw_gtm_js = sawGtm;
    results.tracking.evidence.saw_ga4_collect = sawGa4;
    results.tracking.evidence.ga4_events_captured = events;
    results.tracking.evidence.datalayer_events_captured = dlUniq;

    results.tracking.gtm_loaded = sawGtm;
    results.tracking.ga4_collect_seen = sawGa4;

    // mirror top-level DB-friendly fields
    results.gtm_loaded = results.tracking.gtm_loaded;
    results.ga4_collect_seen = results.tracking.ga4_collect_seen;
    results.firing_ok = results.tracking.ga4_collect_seen;
  }

  async function gotoWithHttpsFallback(url) {
    const u0 = normaliseUrl(url);
    const uHttps = toHttpsFirst(u0);

    const attempts = [uHttps];
    if (u0 !== uHttps) attempts.push(u0);

    let lastErr = null;

    for (const u of attempts) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(700);
        results.final_url = page.url();
        return;
      } catch (e) {
        lastErr = e;
        try {
          await page.goto(u, { waitUntil: 'commit', timeout: 30000 });
          await page.waitForTimeout(700);
          results.final_url = page.url();
          return;
        } catch (e2) {
          lastErr = e2;
        }
      }
    }

    throw new Error(`Could not load page: ${lastErr ? lastErr.message : 'unknown error'}`);
  }

  async function findCtasOnCurrentPage() {
    await scrollToFooter(page);

    const phoneLocators = page.locator('a[href^="tel:"]');
    const emailLocators = page.locator('a[href^="mailto:"]');

    const phoneCount = await phoneLocators.count().catch(() => 0);
    const emailCount = await emailLocators.count().catch(() => 0);

    // Forms across frames + wrappers
    const formCandidates = await findFormCandidatesAcrossFrames(page);

    return { phoneLocators, emailLocators, phoneCount, emailCount, formCandidates };
  }

  async function testPhoneLinks(phoneLocators, max = 10) {
    const count = await phoneLocators.count().catch(() => 0);
    results.ctas.phone.total_found += count;

    const limit = Math.min(count, max);
    for (let i = 0; i < limit; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const loc = phoneLocators.nth(i);
      const href = await loc.getAttribute('href').catch(() => null);
      const text = (await loc.textContent().catch(() => ''))?.trim() || '';

      const key = ctaKey(href, text);
      if (tested.phone.has(key)) continue;
      tested.phone.add(key);

      const before = allBeacons.length;
      const t0 = Date.now();
      results.ctas.phone.total_tested++;

      const clickRes = await robustClick(loc, page, 'phone');
      await page.waitForTimeout(1100);

      const t1 = Date.now();
      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const dlEvents = uniq(await getDataLayerBetween(t0, t1));

      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, PHONE_EVENT_PATTERNS));

      if (relevant.length > 0) {
        results.ctas.phone.working++;
        results.ctas.phone.working_details.push({ link: href, text, relevant_events: relevant, events_fired: ga4Events, datalayer_events: dlEvents, click_ok: clickRes.ok });
      } else {
        results.ctas.phone.broken++;
        results.ctas.phone.broken_details.push({
          link: href,
          text,
          reason: clickRes.ok
            ? (ga4Events.length ? `No phone event. Events: ${ga4Events.join(', ')}` : 'No GA4 event fired')
            : `Click failed: ${clickRes.reason || 'unknown'}`,
          events_fired: ga4Events,
          datalayer_events: dlEvents
        });
      }
    }
  }

  async function testEmailLinks(emailLocators, max = 10) {
    const count = await emailLocators.count().catch(() => 0);
    results.ctas.email.total_found += count;

    const limit = Math.min(count, max);
    for (let i = 0; i < limit; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const loc = emailLocators.nth(i);
      const href = await loc.getAttribute('href').catch(() => null);
      const text = (await loc.textContent().catch(() => ''))?.trim() || '';

      const key = ctaKey(href, text);
      if (tested.email.has(key)) continue;
      tested.email.add(key);

      const before = allBeacons.length;
      const t0 = Date.now();
      results.ctas.email.total_tested++;

      const clickRes = await robustClick(loc, page, 'email');
      await page.waitForTimeout(1100);

      const t1 = Date.now();
      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const dlEvents = uniq(await getDataLayerBetween(t0, t1));

      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, EMAIL_EVENT_PATTERNS));

      if (relevant.length > 0) {
        results.ctas.email.working++;
        results.ctas.email.working_details.push({ link: href, text, relevant_events: relevant, events_fired: ga4Events, datalayer_events: dlEvents, click_ok: clickRes.ok });
      } else {
        results.ctas.email.broken++;
        results.ctas.email.broken_details.push({
          link: href,
          text,
          reason: clickRes.ok
            ? (ga4Events.length ? `No email event. Events: ${ga4Events.join(', ')}` : 'No GA4 event fired')
            : `Click failed: ${clickRes.reason || 'unknown'}`,
          events_fired: ga4Events,
          datalayer_events: dlEvents
        });
      }
    }
  }

  async function testForms(formCandidates, max = 3) {
    results.ctas.forms.total_found += formCandidates.length;

    const limit = Math.min(formCandidates.length, max);
    for (let i = 0; i < limit; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const c = formCandidates[i];
      const container = c.container;

      // Dedupe forms by frame+selector+index
      const key = `${c.frameUrl}|${c.selector}|${c.index}`;
      if (tested.forms.has(key)) continue;
      tested.forms.add(key);

      const before = allBeacons.length;
      const t0 = Date.now();
      results.ctas.forms.total_tested++;

      await container.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(250);

      const { filledFields, notes } = await tryFillContainer(container, page);

      // Focus a field to trigger "start" events if configured
      try {
        const firstInput = container.locator('input:visible, textarea:visible').first();
        const has = await firstInput.count().catch(() => 0);
        if (has) {
          await firstInput.focus().catch(() => {});
          await page.waitForTimeout(200);
        }
      } catch {}

      // Attempt submit
      let submitClicked = false;
      let submitReason = null;

      try {
        const submit = container
          .locator(
            'button[type="submit"], input[type="submit"], button:has-text("Send"), button:has-text("Submit"), button:has-text("Enquire"), button:has-text("Enquiry"), button:has-text("Contact"), button:has-text("Book"), button:has-text("Request")'
          )
          .first();

        const has = await submit.count().catch(() => 0);
        if (has) {
          const vis = await submit.isVisible().catch(() => false);
          if (vis) {
            const res = await robustClick(submit, page, 'form_submit');
            submitClicked = res.ok;
            if (!res.ok) submitReason = res.reason || 'submit_click_failed';
          } else {
            submitReason = 'submit_not_visible';
          }
        } else {
          submitReason = 'no_submit_button_found';
        }
      } catch (e) {
        submitReason = `submit_error: ${e.message}`;
      }

      await page.waitForTimeout(1700);
      const t1 = Date.now();

      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const dlEvents = uniq(await getDataLayerBetween(t0, t1));

      const submitEvents = ga4Events.filter(ev => isRelevantEventName(ev, FORM_SUBMIT_PATTERNS));
      const startEvents = ga4Events.filter(ev => isRelevantEventName(ev, FORM_START_PATTERNS));

      // Classification:
      // - working: submit tracked
      // - partial: start tracked but no submit
      // - broken: neither
      if (submitEvents.length > 0) {
        results.ctas.forms.working++;
        results.ctas.forms.working_details.push({
          form_index: i + 1,
          frame_url: c.frameUrl,
          container_type: c.selector,
          filled_fields: filledFields,
          submit_clicked: submitClicked,
          submit_events: submitEvents,
          start_events: startEvents,
          events_fired: ga4Events,
          datalayer_events: dlEvents,
          notes
        });
      } else if (startEvents.length > 0) {
        results.ctas.forms.partial++;
        results.ctas.forms.partial_details.push({
          form_index: i + 1,
          frame_url: c.frameUrl,
          container_type: c.selector,
          filled_fields: filledFields,
          submit_clicked: submitClicked,
          reason: 'Only form_start-like events; no submit/lead event',
          start_events: startEvents,
          events_fired: ga4Events,
          datalayer_events: dlEvents,
          submit_reason: submitReason,
          notes
        });
      } else {
        results.ctas.forms.broken++;
        results.ctas.forms.broken_details.push({
          form_index: i + 1,
          frame_url: c.frameUrl,
          container_type: c.selector,
          filled_fields: filledFields,
          submit_clicked: submitClicked,
          reason: ga4Events.length ? `No form events. Events: ${ga4Events.join(', ')}` : `No GA4 event fired${submitReason ? ` (${submitReason})` : ''}`,
          events_fired: ga4Events,
          datalayer_events: dlEvents,
          notes
        });
      }
    }
  }

  async function visitAndTest(url) {
    if (Date.now() - startedAt > MAX_RUNTIME) return;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(650);

    await clickConsentEverywhere(page).catch(() => {});
    await page.waitForTimeout(900);
    await scrollToFooter(page);

    const ctas = await findCtasOnCurrentPage();
    await testPhoneLinks(ctas.phoneLocators, 10);
    await testEmailLinks(ctas.emailLocators, 10);
    await testForms(ctas.formCandidates, 3);
  }

  function classify() {
    // Deterministic rules:
    // FAIL = GA4 collect not seen (tracking down / blocked / not firing)
    // WARN = GA4 is seen but any CTA broken or forms partial
    // OK = GA4 seen and no CTA issues

    const trackingFail = !results.tracking.ga4_collect_seen;
    const anyCtaBroken = (results.ctas.phone.broken + results.ctas.email.broken + results.ctas.forms.broken) > 0;
    const anyFormPartial = results.ctas.forms.partial > 0;

    if (trackingFail) {
      results.health_status = 'fail';
      results.overall_status = 'FAILING';
      return;
    }

    if (anyCtaBroken || anyFormPartial) {
      results.health_status = 'warn';
      results.overall_status = 'WARNING';
      return;
    }

    results.health_status = 'ok';
    results.overall_status = 'HEALTHY';
  }

  try {
    const target = normaliseUrl(inputUrl);
    results.url = target;

    // Initial load with HTTPS-first
    await gotoWithHttpsFallback(target);

    // Initial consent + settle
    await clickConsentEverywhere(page).catch(() => {});
    await page.waitForTimeout(1800);
    await scrollToFooter(page);

    // Tag detection (DOM + network evidence)
    const tagData = await detectTagsInDom(page).catch(() => ({
      gtm: [],
      ga4: [],
      hasGtmObj: false,
      hasGtagFn: false
    }));

    // Run tests on homepage/current page
    await visitAndTest(page.url());

    // Crawl contact-like pages AND TEST EACH ONE
    const baseUrl = results.final_url || page.url();
    const origin = new URL(baseUrl).origin;

    const paths = ['/contact', '/contact-us', '/get-in-touch', '/enquiry', '/quote', '/book'];
    const pagesToTest = [];
    for (const p of paths) {
      const u = new URL(p, origin).toString();
      if (!isSameOrigin(origin, u)) continue;
      pagesToTest.push(u);
    }

    for (const u of pagesToTest) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;
      await visitAndTest(u);
    }

    // Collect final network evidence after interactions
    await collectTrackingEvidence();

    // Found logic: DOM IDs OR objects OR network evidence
    results.tracking.gtm_ids = uniq(tagData.gtm);
    results.tracking.ga4_ids = uniq(tagData.ga4);

    results.tracking.gtm_found = results.tracking.gtm_ids.length > 0 || results.tracking.evidence.saw_gtm_js || tagData.hasGtmObj;
    results.tracking.ga4_found = results.tracking.ga4_ids.length > 0 || results.tracking.evidence.saw_ga4_collect || tagData.hasGtagFn;

    // Mirror DB-friendly top fields
    results.detected_gtm_ids = results.tracking.gtm_ids;
    results.detected_ga4_ids = results.tracking.ga4_ids;
    results.codes_on_site = results.tracking.gtm_found || results.tracking.ga4_found;

    // Issues (diagnostic)
    if (!results.tracking.gtm_found && !results.tracking.ga4_found) {
      results.issues.push('CRITICAL: No GTM or GA4 detected (DOM + network)');
    }
    if (results.tracking.ga4_found && !results.tracking.ga4_collect_seen) {
      results.issues.push('CRITICAL: GA4 detected but no GA4 collect beacons were seen');
    }
    if (results.tracking.gtm_found && !results.tracking.gtm_loaded) {
      results.issues.push('WARN: GTM detected but no gtm.js request was seen');
    }

    // Summary + CTA summary
    const totalTested = results.ctas.phone.total_tested + results.ctas.email.total_tested + results.ctas.forms.total_tested;
    const totalWorking = results.ctas.phone.working + results.ctas.email.working + results.ctas.forms.working;
    const totalBroken = results.ctas.phone.broken + results.ctas.email.broken + results.ctas.forms.broken;
    const totalPartial = results.ctas.forms.partial;

    results.cta_summary = {
      phone: { tested: results.ctas.phone.total_tested, passed: results.ctas.phone.working, failed: results.ctas.phone.broken },
      email: { tested: results.ctas.email.total_tested, passed: results.ctas.email.working, failed: results.ctas.email.broken },
      forms: { tested: results.ctas.forms.total_tested, passed: results.ctas.forms.working, partial: results.ctas.forms.partial, failed: results.ctas.forms.broken }
    };

    results.summary =
      totalTested > 0
        ? `${totalWorking}/${totalTested} CTA tests fired expected GA4 events` + (totalPartial ? ` (${totalPartial} form(s) start-only)` : '') + (totalBroken ? ` (${totalBroken} failing)` : '')
        : 'No CTAs tested (none found or page blocked)';

    // Final classification
    classify();

  } catch (e) {
    results.health_status = 'error';
    results.overall_status = 'ERROR';
    results.issues.push(`Fatal error: ${e.message}`);
    try {
      await collectTrackingEvidence();
    } catch {}
  } finally {
    await browser.close().catch(() => {});
  }

  return results;
}

module.exports = { trackingHealthCheckSite };
