// health.runners.js
// GOLD VERSION (UPDATED): stabilise waits + provider-aware form detection + looser form-like matching + broader modal probing
// ENHANCED WITH COMPREHENSIVE LOGGING FOR DEBUGGING

// VERSION IDENTIFIER - Update this timestamp each time you push to GitHub
const SCRIPT_VERSION = '2026-02-04T15:30:00Z'; // CHANGE THIS EACH TIME YOU UPDATE!

const { chromium } = require('playwright');

// Helper to log with timestamp
function logWithTime(message, data = null) {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

function normaliseUrl(input) {
  logWithTime(`🔧 Normalizing URL: ${input}`);
  if (!input) return null;
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  logWithTime(`✅ Normalized to: ${u}`);
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
    logWithTime('📜 Scrolling to footer...');
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
    logWithTime('✅ Scrolled to footer');
  } catch (e) {
    logWithTime('⚠️ Error scrolling to footer', { error: e.message });
  }
}

async function stabilise(page) {
  logWithTime('⏳ Stabilizing page (waiting for content to load)...');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2000);
  logWithTime('✅ Page stabilized');
}

async function robustClick(locator, page, labelForLogs = '') {
  logWithTime(`🖱️ Attempting click: ${labelForLogs}`);
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150);

    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      logWithTime(`❌ Click failed - not visible: ${labelForLogs}`);
      return { ok: false, reason: 'Not visible' };
    }

    await locator.click({ trial: true, timeout: 2000 }).catch(() => {});

    await locator.click({ timeout: 3000 }).catch(async () => {
      logWithTime(`⚠️ Normal click failed, trying JS dispatch: ${labelForLogs}`);
      await locator
        .evaluate(el => {
          const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          el.dispatchEvent(ev);
        })
        .catch(() => {});
    });

    await page.waitForTimeout(600);
    logWithTime(`✅ Click successful: ${labelForLogs}`);
    return { ok: true };
  } catch (e) {
    logWithTime(`❌ Click error: ${labelForLogs}`, { error: e.message });
    return { ok: false, reason: `${labelForLogs} ${e.message}`.trim() };
  }
}

async function clickConsentEverywhere(page) {
  logWithTime('🍪 Checking for cookie consent banners...');
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
    'button:has-text("Allow")',
    'button:has-text("Yes")',
    '.cookie-accept',
    '.accept-cookies',
    '[aria-label*="accept" i]',
    '[aria-label*="agree" i]',
    '[id*="accept" i]',
    '[class*="accept" i]',
    '[data-testid*="accept" i]',
    '[data-qa*="accept" i]'
  ];

  let clicked = false;

  const frames = page.frames();
  logWithTime(`🔍 Checking ${frames.length} frames for consent buttons...`);
  
  for (const frame of frames) {
    for (const sel of selectors) {
      try {
        const loc = frame.locator(sel).first();
        const count = await loc.count().catch(() => 0);
        if (!count) continue;

        const vis = await loc.isVisible().catch(() => false);
        if (!vis) continue;

        logWithTime(`✅ Found consent button: ${sel}`);
        await loc.click({ timeout: 3000 }).catch(async () => {
          await loc.click({ force: true, timeout: 3000 }).catch(() => {});
        });

        clicked = true;
        await page.waitForTimeout(1200);
      } catch {}
    }
  }

  if (clicked) {
    logWithTime('✅ Clicked consent banner');
  } else {
    logWithTime('ℹ️ No consent banner found');
  }
  return clicked;
}

function parseGA4FromUrl(url) {
  try {
    const u = new URL(url);
    return { en: u.searchParams.get('en') || null, tid: u.searchParams.get('tid') || null };
  } catch {
    return { en: null, tid: null };
  }
}

function parseGA4FromPostData(postData) {
  try {
    const params = new URLSearchParams(postData);
    return { en: params.get('en') || null, tid: params.get('tid') || null };
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
  'submit',
  'form_start',
  'begin_checkout'
];

const IGNORE_EXACT_EVENTS = ['page_view', 'scroll', 'user_engagement', 'session_start', 'first_visit'];

async function trackingHealthCheckSite(inputUrl) {
  logWithTime('🚀 STARTING TRACKING HEALTH CHECK');
  logWithTime('📌 SCRIPT VERSION: ' + SCRIPT_VERSION);
  logWithTime('📋 Input URL', { url: inputUrl });
  
  logWithTime('🌐 Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    timeout: 90000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  logWithTime('✅ Browser launched');

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  logWithTime('✅ New page created');

  const startedAt = Date.now();
  const MAX_RUNTIME = 10 * 60 * 1000;

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
      logWithTime('📊 GTM request detected', { url: reqUrl });
    }

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
      
      logWithTime('📊 GA4 event captured', { 
        event: entry.event_name, 
        measurement_id: entry.measurement_id 
      });
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
      gtm_loaded: false,
      ga4_collect_seen: false,
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
      phone: { total_found: 0, total_tested: 0, working: 0, broken: 0, working_details: [], broken_details: [] },
      email: { total_found: 0, total_tested: 0, working: 0, broken: 0, working_details: [], broken_details: [] },
      forms: { total_found: 0, total_tested: 0, working: 0, broken: 0, working_details: [], broken_details: [] }
    },
    issues: [],
    summary: '',
    debug: {
      pages_tested: [],
      consent_clicked: false,
      modal_probe_clicked: 0,
      embedded_forms: []
    }
  };

  function beaconsBetween(beforeCount, startMs, endMs) {
    return allBeacons.slice(beforeCount).filter(b => b.timestampMs >= startMs && b.timestampMs <= endMs);
  }

  async function gotoWithHttpsFallback(url) {
    logWithTime('🌐 Navigating to page', { url });
    const u0 = normaliseUrl(url);
    const uHttps = toHttpsFirst(u0);

    const attempts = [uHttps];
    if (u0 !== uHttps) attempts.push(u0);

    let lastErr = null;

    for (const u of attempts) {
      try {
        logWithTime(`⏳ Trying: ${u}`);
        const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
        results.final_url = page.url();
        logWithTime('✅ Page loaded successfully', { final_url: results.final_url });
        await stabilise(page);
        return resp;
      } catch (e) {
        lastErr = e;
        logWithTime(`⚠️ First attempt failed: ${e.message}`);
        try {
          logWithTime('🔄 Trying with commit wait state...');
          const resp2 = await page.goto(u, { waitUntil: 'commit', timeout: 30000 });
          results.final_url = page.url();
          logWithTime('✅ Page loaded with commit', { final_url: results.final_url });
          await stabilise(page);
          return resp2;
        } catch (e2) {
          lastErr = e2;
          logWithTime(`❌ Second attempt failed: ${e2.message}`);
        }
      }
    }

    throw new Error(`Could not load page: ${lastErr ? lastErr.message : 'unknown error'}`);
  }

  async function detectTagsInDom() {
    logWithTime('🔍 Detecting tracking tags in DOM...');
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
    logWithTime('📊 Collecting tracking evidence...');
    const beacons = allBeacons;
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
    
    logWithTime('📊 Tracking evidence collected', {
      total_beacons: beacons.length,
      gtm: sawGtm,
      ga4: sawGa4,
      events: events
    });
  }

  async function detectCaptchaOnPage() {
    try {
      const hasRecaptcha = await page.locator('iframe[src*="recaptcha"]').count().catch(() => 0);
      const hasHcaptcha = await page.locator('iframe[src*="hcaptcha"]').count().catch(() => 0);
      const hasTurnstile = await page.locator('iframe[src*="challenges.cloudflare.com"]').count().catch(() => 0);
      const detected = hasRecaptcha > 0 || hasHcaptcha > 0 || hasTurnstile > 0;
      if (detected) {
        logWithTime('🔒 CAPTCHA detected on page');
      }
      return detected;
    } catch {
      return false;
    }
  }

  async function tryFillForm(container) {
    logWithTime('📝 Attempting to fill form fields...');
    const notes = [];
    let filled = 0;

    const hasCaptcha = await detectCaptchaOnPage();
    if (hasCaptcha) notes.push('captcha_detected');

    const fields = await container.locator('input:visible, textarea:visible, select:visible').all().catch(() => []);
    logWithTime(`📝 Found ${fields.length} fillable fields`);
    
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

    logWithTime(`✅ Filled ${filled} form fields`, { notes });
    return { filledFields: filled, notes };
  }

  async function findVisibleFormsEverywhere(page, { maxVisible = 10 } = {}) {
    const found = [];
    const embeddedIframes = [];
    const debug = {
      form_tags_found: 0,
      form_tags_visible: 0,
      form_like_containers: 0,
      builder_forms: 0,
      iframe_forms: 0,
      skipped_no_fields: 0,
      skipped_invisible: 0
    };

    logWithTime(`🔍 Scanning ${page.url()} for forms...`);

    const PROVIDER_IFRAME_SEL = `
      iframe[src*="typeform" i],
      iframe[src*="jotform" i],
      iframe[src*="hubspot" i],
      iframe[src*="hsforms" i],
      iframe[src*="wufoo" i],
      iframe[src*="formstack" i],
      iframe[src*="google.com/forms" i],
      iframe[src*="forms.gle" i],
      iframe[src*="cognito" i],
      iframe[src*="123formbuilder" i],
      iframe[title*="form" i],
      iframe[name*="form" i]
    `.trim();

    async function pushIfTestable(frame, loc, kind) {
      if (found.length >= maxVisible) return;

      const exists = await loc.count().catch(() => 0);
      if (!exists) return;

      const visible = await loc.isVisible().catch(() => false);

      const allFields = await loc.locator('input:not([type="hidden"]), textarea, select').count().catch(() => 0);
      if (allFields === 0) {
        debug.skipped_no_fields++;
        return;
      }

      const visibleFields = await loc
        .locator('input:visible:not([type="hidden"]), textarea:visible, select:visible')
        .count()
        .catch(() => 0);

      if (!visible) {
        debug.skipped_invisible++;
      }

      logWithTime(`📋 Found ${kind} form`, { visible, fields: visibleFields, total_fields: allFields });

      found.push({
        kind,
        frameUrl: frame.url(),
        locator: loc,
        visible,
        totalFields: allFields,
        visibleFields
      });
    }

    for (const frame of page.frames()) {
      if (found.length >= maxVisible) break;

      const formTags = await frame.locator('form').all().catch(() => []);
      debug.form_tags_found += formTags.length;

      for (const formLoc of formTags) {
        if (found.length >= maxVisible) break;
        const vis = await formLoc.isVisible().catch(() => false);
        if (vis) debug.form_tags_visible++;
        await pushIfTestable(frame, formLoc, 'form');
      }

      const builders = [
        { kind: 'cf7', sel: '.wpcf7-form, .wpcf7' },
        { kind: 'elementor', sel: '.elementor-form, form.elementor-form' },
        { kind: 'wpforms', sel: '.wpforms-form, form.wpforms-form' },
        { kind: 'gravity', sel: '.gform_wrapper, .gform_wrapper form' },
        { kind: 'fluent', sel: '.fluentform, form.frm-fluent-form' },
        { kind: 'ninja', sel: '.nf-form-cont, .nf-form-wrap' },
        { kind: 'formidable', sel: '.frm_forms, .frm_form_fields' },
        { kind: 'forminator', sel: '.forminator-custom-form' }
      ];

      for (const b of builders) {
        if (found.length >= maxVisible) break;
        const locs = await frame.locator(b.sel).all().catch(() => []);
        for (const loc of locs) {
          if (found.length >= maxVisible) break;
          await pushIfTestable(frame, loc, b.kind);
          debug.builder_forms++;
        }
      }

      const roleForms = await frame.locator('[role="form"]').all().catch(() => []);
      for (const loc of roleForms) {
        if (found.length >= maxVisible) break;
        await pushIfTestable(frame, loc, 'role_form');
      }

      const formLike = await frame
        .locator('section, div, article, main')
        .filter({ has: frame.locator('input:not([type="hidden"]), textarea, select') })
        .all()
        .catch(() => []);

      for (const loc of formLike.slice(0, 5)) {
        if (found.length >= maxVisible) break;

        const hasButton = await loc
          .locator('button, [type="submit"], [role="button"], a[class*="button" i], a[class*="btn" i]')
          .count()
          .catch(() => 0);

        if (hasButton > 0) {
          await pushIfTestable(frame, loc, 'form_like');
          debug.form_like_containers++;
        }
      }
    }

    try {
      const iframeLocs = await page.locator(PROVIDER_IFRAME_SEL).all().catch(() => []);
      for (const fr of iframeLocs.slice(0, 10)) {
        const vis = await fr.isVisible().catch(() => false);
        if (!vis) continue;
        const src = await fr.getAttribute('src').catch(() => null);
        const title = await fr.getAttribute('title').catch(() => null);
        embeddedIframes.push({ src, title });
        debug.iframe_forms++;
      }
    } catch {}

    logWithTime('📊 Form detection summary', debug);
    logWithTime(`✅ Found ${found.length} testable forms, ${embeddedIframes.length} iframe forms`);

    return { found, embeddedIframes, debug };
  }

  async function probeForContactModal(page, maxClicks = 3) {
    logWithTime('🔍 Probing for contact modals...');
    const candidates = page.locator(
      [
        'a:has-text("Contact")',
        'a:has-text("Get in touch")',
        'a:has-text("Enquire")',
        'a:has-text("Enquiry")',
        'a:has-text("Quote")',
        'a:has-text("Get quote")',
        'a:has-text("Request")',
        'a:has-text("Callback")',
        'a:has-text("Message")',
        'a:has-text("Book")',
        'a[href*="#contact" i]',
        'button:has-text("Contact")',
        'button:has-text("Enquire")',
        'button:has-text("Quote")',
        'button:has-text("Request")',
        'button:has-text("Callback")',
        'button:has-text("Message")',
        'button:has-text("Book")',
        '[aria-label*="contact" i]',
        '[aria-label*="enquir" i]',
        '[aria-label*="quote" i]',
        '[aria-label*="book" i]',
        '[aria-controls*="modal" i]',
        '[data-open*="modal" i]',
        '[data-modal*="open" i]'
      ].join(', ')
    );

    const count = await candidates.count().catch(() => 0);
    const limit = Math.min(count, maxClicks);
    logWithTime(`📋 Found ${count} modal candidates, will try ${limit}`);

    let clicked = 0;
    for (let i = 0; i < limit; i++) {
      const loc = candidates.nth(i);
      const res = await robustClick(loc, page, 'modal_probe');
      if (res.ok) {
        clicked++;
        await page.waitForTimeout(600);
        await clickConsentEverywhere(page).catch(() => {});
        await stabilise(page);
      }
    }
    logWithTime(`✅ Clicked ${clicked} modal buttons`);
    return clicked;
  }

  async function findCtas() {
    logWithTime('🔍 Finding CTAs (phone, email, forms)...');
    await scrollToFooter(page);

    const phoneLocators = page.locator('a[href^="tel:"]');
    const emailLocators = page.locator('a[href^="mailto:"]');

    let { found: visibleForms, embeddedIframes, debug } = await findVisibleFormsEverywhere(page, { maxVisible: 10 });

    if (visibleForms.length === 0) {
      logWithTime('⚠️ No forms found, trying modal probe...');
      const clicked = await probeForContactModal(page, 3).catch(() => 0);
      results.debug.modal_probe_clicked += clicked;

      ({ found: visibleForms, embeddedIframes, debug } = await findVisibleFormsEverywhere(page, { maxVisible: 10 }));
    }

    if (embeddedIframes.length) {
      logWithTime('📋 Found embedded iframe forms', { count: embeddedIframes.length });
      results.debug.embedded_forms.push({
        page: page.url(),
        iframes: embeddedIframes
      });
    }

    const phoneCount = await phoneLocators.count().catch(() => 0);
    const emailCount = await emailLocators.count().catch(() => 0);
    
    logWithTime('✅ CTA scan complete', {
      phone_links: phoneCount,
      email_links: emailCount,
      forms: visibleForms.length,
      embedded_forms: embeddedIframes.length
    });

    return {
      phoneLocators,
      emailLocators,
      visibleForms,
      visibleFormCount: visibleForms.length,
      embeddedIframes
    };
  }

  async function testPhoneLinks(phoneLocators, max = 10) {
    const count = await phoneLocators.count().catch(() => 0);
    results.ctas.phone.total_found += count;
    logWithTime(`📞 Testing phone links (${count} found, max ${max})...`);

    const limit = Math.min(count, max);
    for (let i = 0; i < limit; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const loc = phoneLocators.nth(i);
      const href = await loc.getAttribute('href').catch(() => null);
      const text = (await loc.textContent().catch(() => ''))?.trim() || '';

      logWithTime(`📞 Testing phone link ${i + 1}/${limit}`, { href, text });

      const before = allBeacons.length;
      const t0 = Date.now();

      results.ctas.phone.total_tested++;

      const clickRes = await robustClick(loc, page, 'phone');
      await page.waitForTimeout(1200);

      const t1 = Date.now();
      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, PHONE_EVENT_PATTERNS, IGNORE_EXACT_EVENTS));

      logWithTime(`📊 Phone link result`, { 
        clicked: clickRes.ok, 
        events: ga4Events, 
        relevant: relevant 
      });

      if (!clickRes.ok) {
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
        results.ctas.phone.working_details.push({ link: href, text, relevant_events: relevant, events_fired: ga4Events });
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
    
    logWithTime(`✅ Phone links tested: ${results.ctas.phone.working} working, ${results.ctas.phone.broken} broken`);
  }

  async function testEmailLinks(emailLocators, max = 10) {
    const count = await emailLocators.count().catch(() => 0);
    results.ctas.email.total_found += count;
    logWithTime(`📧 Testing email links (${count} found, max ${max})...`);

    const limit = Math.min(count, max);
    for (let i = 0; i < limit; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const loc = emailLocators.nth(i);
      const href = await loc.getAttribute('href').catch(() => null);
      const text = (await loc.textContent().catch(() => ''))?.trim() || '';

      logWithTime(`📧 Testing email link ${i + 1}/${limit}`, { href, text });

      const before = allBeacons.length;
      const t0 = Date.now();

      results.ctas.email.total_tested++;

      const clickRes = await robustClick(loc, page, 'email');
      await page.waitForTimeout(1200);

      const t1 = Date.now();
      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, EMAIL_EVENT_PATTERNS, IGNORE_EXACT_EVENTS));

      logWithTime(`📊 Email link result`, { 
        clicked: clickRes.ok, 
        events: ga4Events, 
        relevant: relevant 
      });

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
        results.ctas.email.working_details.push({ link: href, text, relevant_events: relevant, events_fired: ga4Events });
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
    
    logWithTime(`✅ Email links tested: ${results.ctas.email.working} working, ${results.ctas.email.broken} broken`);
  }

  async function testForms(visibleForms, max = 3) {
    results.ctas.forms.total_found += visibleForms.length;
    logWithTime(`📝 Testing forms (${visibleForms.length} found, max ${max})...`);

    const limit = Math.min(visibleForms.length, max);
    for (let i = 0; i < limit; i++) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const item = visibleForms[i];
      const container = item.locator;

      logWithTime(
        `📝 Testing form ${i + 1}/${limit}`,
        { kind: item.kind, visible: item.visible, fields: `${item.visibleFields}/${item.totalFields}` }
      );

      if (!item.visible) {
        logWithTime('⚠️ Form not visible, attempting to reveal...');
        await container.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);

        const nowVisible = await container.isVisible().catch(() => false);
        if (!nowVisible) {
          logWithTime('❌ Form still not visible after scroll, skipping');
          results.ctas.forms.broken++;
          results.ctas.forms.broken_details.push({
            form_index: i + 1,
            kind: item.kind,
            frame_url: item.frameUrl,
            reason: 'Form not visible/accessible',
            events_fired: [],
            filled_fields: 0,
            submit_clicked: false,
            notes: []
          });
          continue;
        }
      }

      const before = allBeacons.length;
      const t0 = Date.now();

      results.ctas.forms.total_tested++;

      await container.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);

      const { filledFields, notes } = await tryFillForm(container);

      try {
        const firstInput = container.locator('input:visible, textarea:visible').first();
        const c = await firstInput.count().catch(() => 0);
        if (c) {
          await firstInput.focus().catch(() => {});
          await firstInput.click().catch(() => {});
          await page.waitForTimeout(400);
        }
      } catch {}

      let submitClicked = false;
      let submitReason = null;

      const submitSelectors = [
        'button[type="submit"]:visible',
        'input[type="submit"]:visible',
        'button:has-text("Submit"):visible',
        'button:has-text("Send"):visible',
        'button:has-text("Enquire"):visible',
        'button:has-text("Enquiry"):visible',
        'button:has-text("Get Quote"):visible',
        'button:has-text("Request"):visible',
        'button:has-text("Request Callback"):visible',
        'button:has-text("Get Started"):visible',
        'button:has-text("Continue"):visible',
        'button:has-text("Next"):visible',
        'button:has-text("Book"):visible',
        '[aria-label*="submit" i]:visible',
        '[aria-label*="send" i]:visible',
        '[aria-label*="enquir" i]:visible'
      ];

      for (const sel of submitSelectors) {
        if (submitClicked) break;

        try {
          const submit = container.locator(sel).first();
          const has = await submit.count().catch(() => 0);

          if (has) {
            const res = await robustClick(submit, page, 'form_submit');
            if (res.ok) {
              submitClicked = true;
              logWithTime(`✅ Submit clicked via: ${sel}`);
              break;
            } else {
              submitReason = res.reason;
            }
          }
        } catch (e) {
          submitReason = `${sel}: ${e.message}`;
        }
      }

      if (!submitClicked) {
        logWithTime(`⚠️ Submit not clicked: ${submitReason || 'no button found'}`);
      }

      await page.waitForTimeout(2000);
      const t1 = Date.now();

      const newBeacons = beaconsBetween(before, t0, t1);
      const ga4Events = uniq(newBeacons.filter(b => b.type === 'GA4').map(b => b.event_name).filter(Boolean));
      const relevant = ga4Events.filter(ev => isRelevantEventName(ev, FORM_EVENT_PATTERNS, IGNORE_EXACT_EVENTS));

      logWithTime(`📊 Form result`, { 
        events: ga4Events, 
        relevant: relevant,
        filled_fields: filledFields,
        submit_clicked: submitClicked
      });

      if (relevant.length > 0) {
        results.ctas.forms.working++;
        results.ctas.forms.working_details.push({
          form_index: i + 1,
          kind: item.kind,
          frame_url: item.frameUrl,
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
          kind: item.kind,
          frame_url: item.frameUrl,
          reason: ga4Events.length
            ? `No form event fired. Saw: ${ga4Events.join(', ')}`
            : `No GA4 events captured${submitReason ? ` (${submitReason})` : ''}`,
          events_fired: ga4Events,
          filled_fields: filledFields,
          submit_clicked: submitClicked,
          notes
        });
      }
    }
    
    logWithTime(`✅ Forms tested: ${results.ctas.forms.working} working, ${results.ctas.forms.broken} broken`);
  }

  async function testThisPage(tag) {
    logWithTime(`🧪 Testing page: ${tag}`);
    results.debug.pages_tested.push({ tag, url: page.url() });

    await clickConsentEverywhere(page).catch(() => {});
    await stabilise(page);
    await scrollToFooter(page);

    const ctas = await findCtas();
    await testPhoneLinks(ctas.phoneLocators);
    await testEmailLinks(ctas.emailLocators);
    await testForms(ctas.visibleForms);
    
    logWithTime(`✅ Page testing complete: ${tag}`);
  }

  async function crawlAndTestContactPages(baseUrl) {
    logWithTime('🔍 Crawling contact-related pages...');
    const candidates = ['/contact', '/contact-us', '/get-in-touch', '/enquiry', '/quote', '/book', '/booking'];
    const visited = new Set();

    for (const path of candidates) {
      if (Date.now() - startedAt > MAX_RUNTIME) break;

      const next = new URL(path, baseUrl).toString();
      if (visited.has(next)) continue;

      try {
        if (!isSameOrigin(baseUrl, next)) continue;

        logWithTime(`🌐 Navigating to: ${path}`);
        await page.goto(next, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await stabilise(page);

        await testThisPage(`crawl:${path}`);
        visited.add(next);
      } catch (e) {
        logWithTime(`⚠️ Failed to test ${path}`, { error: e.message });
      }
    }
    
    logWithTime(`✅ Crawl complete, visited ${visited.size} pages`);
  }

  try {
    const target = normaliseUrl(inputUrl);
    results.url = target;

    logWithTime(`\n${'='.repeat(60)}`);
    logWithTime(`🚀 Starting health check for: ${target}`);
    logWithTime('='.repeat(60));

    await gotoWithHttpsFallback(target);

    const consent = await clickConsentEverywhere(page).catch(() => false);
    results.debug.consent_clicked = !!consent;

    await stabilise(page);
    await scrollToFooter(page);

    const tagData = await detectTagsInDom().catch(() => ({ gtm: [], ga4: [], hasGtmObj: false, hasGtagFn: false }));

    await collectTrackingEvidence();

    results.tracking.gtm_ids = uniq(tagData.gtm);
    results.tracking.ga4_ids = uniq(tagData.ga4);

    logWithTime(`📊 GTM IDs: ${results.tracking.gtm_ids.join(', ') || 'none'}`);
    logWithTime(`📊 GA4 IDs: ${results.tracking.ga4_ids.join(', ') || 'none'}`);

    const sawGtm = results.tracking.evidence.saw_gtm_js;
    const sawGa4 = results.tracking.evidence.saw_ga4_collect;

    results.tracking.gtm_found = results.tracking.gtm_ids.length > 0 || sawGtm || tagData.hasGtmObj;
    results.tracking.ga4_found = results.tracking.ga4_ids.length > 0 || sawGa4 || tagData.hasGtagFn;

    results.tracking.gtm_loaded = sawGtm || tagData.hasGtmObj;
    results.tracking.ga4_collect_seen = sawGa4;

    if (!results.tracking.gtm_found && !results.tracking.ga4_found) {
      results.issues.push('❌ CRITICAL: No GTM or GA4 detected (DOM + network)');
    }

    logWithTime('\n--- Testing Home Page ---');
    await testThisPage('home');

    logWithTime('\n--- Crawling Contact Pages ---');
    const baseUrl = results.final_url || page.url();
    const origin = new URL(baseUrl).origin;
    await crawlAndTestContactPages(origin);

    const totalTested = results.ctas.phone.total_tested + results.ctas.email.total_tested + results.ctas.forms.total_tested;
    const totalWorking = results.ctas.phone.working + results.ctas.email.working + results.ctas.forms.working;
    const totalBroken = results.ctas.phone.broken + results.ctas.email.broken + results.ctas.forms.broken;

    const trackingOk = results.tracking.gtm_loaded || results.tracking.ga4_collect_seen;

    if (results.tracking.gtm_found && !results.tracking.gtm_loaded) {
      results.issues.push('⚠️ GTM found but no evidence it loaded (no gtm.js + no window object)');
    }
    if (results.tracking.ga4_found && !results.tracking.ga4_collect_seen) {
      results.issues.push('⚠️ GA4 found but no GA4 collect beacons were seen');
    }

    const embeddedCount = results.debug.embedded_forms.reduce((acc, x) => acc + (x.iframes?.length || 0), 0);
    if (results.ctas.forms.total_found === 0 && embeddedCount > 0) {
      results.issues.push(`⚠️ Form embed detected in iframe (${embeddedCount}) but no testable fields were accessible`);
    }

    if (totalTested > 0) {
      results.summary = `${totalWorking}/${totalTested} CTA tests fired relevant GA4 events`;
    } else {
      results.summary = 'No CTAs tested (none found or page blocked)';
    }

    const criticalCount = results.issues.filter(x => x.includes('CRITICAL')).length;

    if (criticalCount > 0 || !trackingOk) {
      results.overall_status = 'FAILING';
    } else if (totalBroken > 0) {
      results.overall_status = 'WARNING';
    } else {
      results.overall_status = 'HEALTHY';
    }

    await collectTrackingEvidence();

    logWithTime(`\n${'='.repeat(60)}`);
    logWithTime(`✅ Final Status: ${results.overall_status}`);
    logWithTime(`📊 Summary: ${results.summary}`);
    logWithTime(`📋 Issues: ${results.issues.length}`);
    logWithTime('='.repeat(60));
    
    logWithTime('🎯 HEALTH CHECK COMPLETE');
  } catch (e) {
    results.overall_status = 'ERROR';
    results.issues.push(`Fatal error: ${e.message}`);
    logWithTime('❌ FATAL ERROR', { error: e.message, stack: e.stack });
    try {
      await collectTrackingEvidence();
    } catch {}
  } finally {
    logWithTime('🔒 Closing browser...');
    await browser.close().catch(() => {});
    logWithTime('✅ Browser closed');
  }

  return results;
}

module.exports = { trackingHealthCheckSite };
