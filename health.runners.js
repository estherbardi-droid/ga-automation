// health.runners.js
// Updated: accurate tag detection, reliable GA4 event extraction (GET+POST),
// robust cookie handling (incl. iframes), CTA testing with proper counters,
// HTTPS normalisation + redirect tracking, crawl contact pages, safer form testing.

const { chromium } = require('playwright');

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

async function scrollToFooter(page) {
  try {
    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const max = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
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
    await page.waitForTimeout(150);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return { ok: false, reason: 'Not visible' };

    // 1) trial click (checks actionability)
    await locator.click({ trial: true, timeout: 2000 }).catch(() => {});
    // 2) normal click
    await locator.click({ timeout: 3000 }).catch(async () => {
      // 3) fallback: dispatch click event via DOM
      await locator.evaluate(el => {
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(ev);
      }).catch(() => {});
    });

    await page.waitForTimeout(600);
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

  // Try all frames (consent often in iframe)
  const frames = page.frames();
  for (const frame of frames) {
    for (const sel of selectors) {
      try {
        const loc = frame.locator(sel).first();
        const count = await loc.count().catch(() => 0);
        if (!count) continue;

        const vis = await loc.isVisible().catch(() => false);
        if (!vis) continue;

        await loc.click({ timeout: 3000 }).catch(async () => {
          await loc.click({ force: true, timeout: 3000 }).catch(() => {});
        });

        clicked = true;
        // wait for tracking init
        await page.waitForTimeout(1200);
        // don't early-return; sometimes there are two layers
      } catch {}
    }
  }

  return clicked;
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
    // GA4 postData is often x-www-form-urlencoded
    const params = new URLSearchParams(postData);
    return {
      en: params.get('en') || null,
      tid: params.get('tid') || null
    };
  } catch {
    return { en: null, tid: null };
  }
}

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

function isRelevantEventName(eventName, patterns, ignoreExact = []) {
  if (!eventName) return false;
  const ev = safeLower(eventName);
  if (ignoreExact.includes(ev)) return false;
  return patterns.some(p => ev.includes(safeLower(p)));
}

const PHONE_EVENT_PATTERNS = [
  'click_call',
  'call_click',
  'phone_click',
  'click_phone',
  'click_tel',
  'tel_click',
  'phone',
  'call'
];

const EMAIL_EVENT_PATTERNS = [
  'click_email',
  'email_click',
  'mailto_click',
  'click_mail',
  'mail_click',
  'email',
  'mailto'
];

const FORM_EVENT_PATTERNS = [
  'form_submit',
  'submit_form',
  'form_submission',
  'contact_form',
  'generate_lead',
  'lead',
  'form_complete',
  'form_success',
  'contact',
  'enquiry',
  'quote',
  'submit'
];

const IGNORE_EXACT_EVENTS = ['page_view', 'scroll', 'user_engagement', 'session_start', 'first_visit'];

async function trackingHealthCheckSite(inputUrl) {
  const browser = await chromium.launch({
    headless: true,
    timeout: 90000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  const startedAt = Date.now();
  const MAX_RUNTIME = 10 * 60 * 1000;

  // Beacon store
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

    if (looksLikeGTM(reqUrl)) {
      entry.type = 'GTM';
    }

    if (looksLikeGA4Collect(reqUrl)) {
      entry.type = 'GA4';
      // GET params
      const fromUrl = parseGA4FromUrl(reqUrl);
      entry.event_name = fromUrl.en;
      entry.measurement_id = fromUrl.tid;

      // POST body override if present (more reliable)
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
    overall_status: 'HEALTHY',
    tracking: {
      gtm_found: false,
      ga4_found: false,
      gtm_loaded: false,      // evidence-based
      ga4_collect_seen: false, // evidence-based
      gtm_ids: [],
      ga4_ids: [],
      evidence: {
        total_beacons: 0,
        saw_gtm_js: false,
        saw_ga4_collect: false,
        ga4_events_captured: []
      }
    },
    ctas: {
      phone: {
        total_found: 0,
        total_tested: 0,
        working: 0,
        broken: 0,
        working_details: [],
        broken_details: []
      },
      email: {
        total_found: 0,
        total_tested: 0,
        working: 0,
        broken: 0,
        working_details: [],
        broken_details: []
      },
      forms: {
        total_found: 0,
        total_tested: 0,
        working: 0,
        broken: 0,
        working_details: [],
        broken_details: []
      }
    },
    issues: [],
    summary: ''
  };

  function beaconsBetween(beforeCount, startMs, endMs) {
    return allBeacons.slice(beforeCount).filter(b => b.timestampMs >= startMs && b.timestampMs <= endMs);
  }

  async function gotoWithHttpsFallback(url) {
    const u0 = normaliseUrl(url);
    const uHttps = toHttpsFirst(u0);

    const attempts = [uHttps];
    if (u0 !== uHttps) attempts.push(u0);

    let lastErr = null;

    for (const u of attempts) {
      try {
        const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // Sometimes domcontentloaded still stalls on heavy sites; allow it
        await page.waitForTimeout(800);
        results.final_url = page.url();
        return resp;
      } catch (e) {
        lastErr = e;
        // fallback simpler load
        try {
          const resp2 = await page.goto(u, { waitUntil: 'commit', timeout: 30000 });
          await page.waitForTimeout(800);
          results.final_url = page.url();
          return resp2;
        } catch (e2) {
          lastErr = e2;
        }
      }
    }

    throw new Error(`Could not load page: ${lastErr ? lastErr.message : 'unknown error'}`);
  }

  async function detectTagsInDom() {
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

  async function collectTrackingEvidence() {
    const beacons = allBeacons; // all so far
    const sawGtm = beacons.some(b => b.type === 'GTM');
    const ga4 = beacons.filter(b => b.type === 'GA4');
    const sawGa4 = ga4.length > 0;

    const events = uniq(ga4.map(b => b.event_name).filter(Boolean));

    results.tracking.evidence.total_beacons = beacons.length;
    results.tracking.evidence.saw_gtm_js = sawGtm;
    results.tracking.evidence.saw_ga4_collect = sawGa4;
    results.tracking.evidence.ga4_events_captured = events;

    results.tracking.gtm_loaded = sawGtm;
    results.tracking.ga4_collect_seen = sawGa4;
  }

  async function crawlContactPages(baseUrl) {
    const candidates = ['/contact', '/contact-us', '/get-in-touch', '/enquiry', '/quote', '/book'];
    const visited = [];

    for (const path of candidates) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const next = new URL(path, baseUrl).toString();
      if (visited.includes(next)) continue;

      try {
        // Only crawl within same origin
        if (!isSameOrigin(baseUrl, next)) continue;
        await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1200);
        await clickConsentEverywhere(page).catch(() => {});
        await page.waitForTimeout(800);
        await scrollToFooter(page);
        visited.push(next);
      } catch {
        // ignore
      }
    }
  }

  // Gather CTAs from current page
  async function findCtas() {
    // ensure footer loaded
    await scrollToFooter(page);

    const phoneLocators = page.locator('a[href^="tel:"]');
    const emailLocators = page.locator('a[href^="mailto:"]');

    // forms: include visible forms, plus forms that become visible after scroll
    const formLocators = page.locator('form');

    const phoneCount = await phoneLocators.count().catch(() => 0);
    const emailCount = await emailLocators.count().catch(() => 0);

    // only count visible forms (some pages have hidden/templated forms)
    const formCount = await formLocators.count().catch(() => 0);
    let visibleForms = [];
    for (let i = 0; i < Math.min(formCount, 25); i++) {
      const f = formLocators.nth(i);
      const vis = await f.isVisible().catch(() => false);
      if (vis) visibleForms.push(f);
    }

    return {
      phoneLocators,
      emailLocators,
      visibleForms,
      phoneCount,
      emailCount,
      visibleFormCount: visibleForms.length
    };
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

      const before = allBeacons.length;
      const t0 = Date.now();

      // IMPORTANT: count as tested even if click fails
      results.ctas.phone.total_tested++;

      const clickRes = await robustClick(loc, page, 'phone');
      await page.waitForTimeout(1200);

      const t1 = Date.now();
      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, PHONE_EVENT_PATTERNS, IGNORE_EXACT_EVENTS));

      if (!clickRes.ok) {
        // click failed: still record events if any fired
        if (relevant.length > 0) {
          results.ctas.phone.working++;
          results.ctas.phone.working_details.push({
            link: href,
            text,
            relevant_events: relevant,
            events_fired: ga4Events,
            note: `click_failed_but_events_fired: ${clickRes.reason || 'unknown'}`
          });
        } else {
          results.ctas.phone.broken++;
          results.ctas.phone.broken_details.push({
            link: href,
            text,
            reason: `Click failed: ${clickRes.reason || 'unknown'}`,
            events_fired: ga4Events
          });
        }
        continue;
      }

      if (relevant.length > 0) {
        results.ctas.phone.working++;
        results.ctas.phone.working_details.push({
          link: href,
          text,
          relevant_events: relevant,
          events_fired: ga4Events
        });
      } else {
        results.ctas.phone.broken++;
        results.ctas.phone.broken_details.push({
          link: href,
          text,
          reason: ga4Events.length ? `No phone event. Events: ${ga4Events.join(', ')}` : 'No GA4 event fired',
          events_fired: ga4Events
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

      const before = allBeacons.length;
      const t0 = Date.now();

      results.ctas.email.total_tested++;

      const clickRes = await robustClick(loc, page, 'email');
      await page.waitForTimeout(1200);

      const t1 = Date.now();
      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, EMAIL_EVENT_PATTERNS, IGNORE_EXACT_EVENTS));

      if (!clickRes.ok) {
        if (relevant.length > 0) {
          results.ctas.email.working++;
          results.ctas.email.working_details.push({
            link: href,
            text,
            relevant_events: relevant,
            events_fired: ga4Events,
            note: `click_failed_but_events_fired: ${clickRes.reason || 'unknown'}`
          });
        } else {
          results.ctas.email.broken++;
          results.ctas.email.broken_details.push({
            link: href,
            text,
            reason: `Click failed: ${clickRes.reason || 'unknown'}`,
            events_fired: ga4Events
          });
        }
        continue;
      }

      if (relevant.length > 0) {
        results.ctas.email.working++;
        results.ctas.email.working_details.push({
          link: href,
          text,
          relevant_events: relevant,
          events_fired: ga4Events
        });
      } else {
        results.ctas.email.broken++;
        results.ctas.email.broken_details.push({
          link: href,
          text,
          reason: ga4Events.length ? `No email event. Events: ${ga4Events.join(', ')}` : 'No GA4 event fired',
          events_fired: ga4Events
        });
      }
    }
  }

  async function detectCaptchaOnPage() {
    try {
      const hasRecaptcha = await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0);
      const hasHcaptcha = await page.locator('iframe[src*="hcaptcha"]').count().catch(() => 0);
      const hasTurnstile = await page.locator('iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0);
      return hasRecaptcha > 0 || hasHcaptcha > 0 || hasTurnstile > 0;
    } catch {
      return false;
    }
  }

  async function tryFillForm(form) {
    // Fill a subset safely (no “real” emails/phones).
    // Return { filledFields, notes[] }
    const notes = [];
    let filled = 0;

    const hasCaptcha = await detectCaptchaOnPage();
    if (hasCaptcha) notes.push('captcha_detected');

    // Prefer visible fields only
    const fields = await form.locator('input:visible, textarea:visible, select:visible').all().catch(() => []);
    for (const field of fields.slice(0, 25)) {
      try {
        const tag = await field.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
        const type = safeLower(await field.getAttribute('type').catch(() => ''));
        const name = safeLower(await field.getAttribute('name').catch(() => ''));
        const placeholder = safeLower(await field.getAttribute('placeholder').catch(() => ''));

        // Skip password/file
        if (type === 'password' || type === 'file') continue;

        if (tag === 'select') {
          // Select first non-empty option
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

  async function testForms(visibleForms, max = 3) {
    results.ctas.forms.total_found += visibleForms.length;

    const limit = Math.min(visibleForms.length, max);
    for (let i = 0; i < limit; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const form = visibleForms[i];

      const before = allBeacons.length;
      const t0 = Date.now();

      // Count as tested even if we can’t submit
      results.ctas.forms.total_tested++;

      await form.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);

      const { filledFields, notes } = await tryFillForm(form);

      // Try to trigger tracking even if we don’t submit:
      // - focus a field
      // - click submit if available (but we accept that captcha may block)
      try {
        const firstInput = form.locator('input:visible, textarea:visible').first();
        const c = await firstInput.count().catch(() => 0);
        if (c) {
          await firstInput.focus().catch(() => {});
          await page.waitForTimeout(200);
        }
      } catch {}

      // Attempt submit click (best-effort)
      let submitClicked = false;
      let submitReason = null;

      try {
        const submit = form.locator(
          'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send"), button:has-text("Enquire"), button:has-text("Enquiry")'
        ).first();

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

      await page.waitForTimeout(1800);
      const t1 = Date.now();

      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, FORM_EVENT_PATTERNS, IGNORE_EXACT_EVENTS));

      if (relevant.length > 0) {
        results.ctas.forms.working++;
        results.ctas.forms.working_details.push({
          form_index: i + 1,
          relevant_events: relevant,
          events_fired: ga4Events,
          filled_fields: filledFields,
          submit_clicked: submitClicked,
          notes
        });
      } else {
        results.ctas.forms.broken++;
        results.ctas.forms.broken_details.push({
          form_index: i + 1,
          reason: ga4Events.length
            ? `No form event. Events: ${ga4Events.join(', ')}`
            : `No GA4 event fired${submitReason ? ` (${submitReason})` : ''}`,
          events_fired: ga4Events,
          filled_fields: filledFields,
          submit_clicked: submitClicked,
          notes
        });
      }
    }
  }

  try {
    // ------------------------------------------------------------
    // 1) Load (HTTPS first), accept consent, wait for tracking
    // ------------------------------------------------------------
    const target = normaliseUrl(inputUrl);
    results.url = target;

    await gotoWithHttpsFallback(target);
    await clickConsentEverywhere(page).catch(() => {});
    await page.waitForTimeout(2000);
    await scrollToFooter(page);

    // ------------------------------------------------------------
    // 2) Detect tags (DOM + network evidence)
    // ------------------------------------------------------------
    const tagData = await detectTagsInDom().catch(() => ({
      gtm: [],
      ga4: [],
      hasGtmObj: false,
      hasGtagFn: false
    }));

    // Let tracking settle a bit more
    await page.waitForTimeout(1500);
    await collectTrackingEvidence();

    // DOM IDs
    results.tracking.gtm_ids = uniq(tagData.gtm);
    results.tracking.ga4_ids = uniq(tagData.ga4);

    // Found logic: DOM IDs OR network evidence
    const sawGtm = results.tracking.evidence.saw_gtm_js;
    const sawGa4 = results.tracking.evidence.saw_ga4_collect;

    results.tracking.gtm_found = results.tracking.gtm_ids.length > 0 || sawGtm || tagData.hasGtmObj;
    results.tracking.ga4_found = results.tracking.ga4_ids.length > 0 || sawGa4 || tagData.hasGtagFn;

    // Loaded/firing logic: network evidence first
    results.tracking.gtm_loaded = sawGtm || tagData.hasGtmObj;
    results.tracking.ga4_collect_seen = sawGa4;

    if (!results.tracking.gtm_found && !results.tracking.ga4_found) {
      results.issues.push('❌ CRITICAL: No GTM or GA4 detected (DOM + network)');
    }

    // ------------------------------------------------------------
    // 3) Crawl contact-like pages for CTAs and test
    // ------------------------------------------------------------
    // We test on current page AND on common contact paths.
    const baseUrl = results.final_url || page.url();
    const origin = new URL(baseUrl).origin;

    // Test on homepage/current page first
    let ctas = await findCtas();
    await testPhoneLinks(ctas.phoneLocators);
    await testEmailLinks(ctas.emailLocators);
    await testForms(ctas.visibleForms);

    // Crawl contact pages (same origin) then test again (adds coverage)
    await crawlContactPages(origin);

    // Re-find & test on the last crawled page (plus new CTAs)
    ctas = await findCtas();
    await testPhoneLinks(ctas.phoneLocators);
    await testEmailLinks(ctas.emailLocators);
    await testForms(ctas.visibleForms);

    // ------------------------------------------------------------
    // 4) Final analysis + status
    // ------------------------------------------------------------
    const totalTested =
      results.ctas.phone.total_tested + results.ctas.email.total_tested + results.ctas.forms.total_tested;

    const totalWorking =
      results.ctas.phone.working + results.ctas.email.working + results.ctas.forms.working;

    const totalBroken =
      results.ctas.phone.broken + results.ctas.email.broken + results.ctas.forms.broken;

    // Tracking status
    const trackingOk = results.tracking.gtm_loaded || results.tracking.ga4_collect_seen;

    // Issues
    if (results.tracking.gtm_found && !results.tracking.gtm_loaded) {
      results.issues.push('⚠️ GTM found but no evidence it loaded (no gtm.js + no window object)');
    }
    if (results.tracking.ga4_found && !results.tracking.ga4_collect_seen) {
      results.issues.push('⚠️ GA4 found but no GA4 collect beacons were seen');
    }

    if (totalTested > 0) {
      results.summary = `${totalWorking}/${totalTested} CTA tests fired relevant GA4 events`;
    } else {
      results.summary = 'No CTAs tested (none found or page blocked)';
    }

    // Overall status rules:
    // FAILING: no tracking at all, or critical issues
    // WARNING: tracking exists but CTA failures exist
    // HEALTHY: tracking exists + no CTA failures (or no CTAs found)
    const criticalCount = results.issues.filter(x => x.includes('CRITICAL')).length;

    if (criticalCount > 0 || !trackingOk) {
      results.overall_status = 'FAILING';
    } else if (totalBroken > 0) {
      results.overall_status = 'WARNING';
    } else {
      results.overall_status = 'HEALTHY';
    }

    // Refresh evidence totals at end
    await collectTrackingEvidence();

  } catch (e) {
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

module.exports = {
  trackingHealthCheckSite
};
