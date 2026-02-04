// /health.runners.js
// VERSION: 2026-02-04T18:55:00Z
// MAJOR FIXES (CLIENT-AGNOSTIC):
// - CDP-level network capture (reliable for sendBeacon/keepalive)
// - Parse GA4 events from BOTH URL query + POST body (fixes missing en=)
// - Timestamp-based polling (events since actionStartMs)
// - Tiered outcomes: PASS (matched), WARN (GA4 activity but unmatched), FAIL (no GA4 activity)
// - Better form handling: submit disabled detection + consent checkbox ticking
// - Better evidence: page + form signature in results

const { chromium } = require('playwright');

const SCRIPT_VERSION = '2026-02-04T18:55:00Z';

// -------------------- Logging --------------------
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  if (data) console.log(`[${timestamp}] ${message}`, JSON.stringify(data, null, 2));
  else console.log(`[${timestamp}] ${message}`);
}

// -------------------- URL normalisation --------------------
function normaliseUrl(input) {
  if (!input) return null;
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  // Prefer https (more consistent + fewer mixed-content/cookie issues)
  u = u.replace(/^http:\/\//i, 'https://');
  return u;
}

// -------------------- CTA normalisation --------------------
function normalizePhone(href) {
  if (!href) return null;
  const raw = href.replace(/^tel:/i, '');
  return raw.replace(/[^\d+]/g, '') || raw.trim();
}

function normalizeEmail(href) {
  if (!href) return null;
  const raw = href.replace(/^mailto:/i, '');
  return raw.split('?')[0].trim().toLowerCase();
}

function isSameOrigin(urlA, urlB) {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

// -------------------- GA4 capture helpers --------------------
function isGaOrGtmUrl(u) {
  return (
    u.includes('/g/collect') ||
    u.includes('/r/collect') ||
    u.includes('google-analytics.com') ||
    u.includes('analytics.google.com') ||
    u.includes('googletagmanager.com') ||
    u.includes('gtm.js') ||
    u.includes('gtag/js')
  );
}

function classifyBeacon(url) {
  if (url.includes('googletagmanager.com') || url.includes('gtm.js')) return 'GTM';
  if (url.includes('/g/collect') || url.includes('/r/collect')) return 'GA4';
  if (url.includes('google-analytics.com') || url.includes('analytics.google.com')) return 'GA4';
  return 'Other';
}

function mergeParamsFromUrlAndBody(url, postData) {
  const merged = new URLSearchParams();

  // URL query params
  try {
    const u = new URL(url);
    if (u.search) {
      const qs = new URLSearchParams(u.search);
      for (const [k, v] of qs.entries()) merged.append(k, v);
    }
  } catch {}

  // POST body params (GA4 often sends en= here)
  if (postData && typeof postData === 'string') {
    try {
      const body = new URLSearchParams(postData);
      for (const [k, v] of body.entries()) merged.append(k, v);
    } catch {}
  }

  return merged;
}

function extractGaFields(params) {
  // GA4 event name is usually `en`
  const eventName = params.get('en') || null;

  // Measurement ID often sits in `tid` (e.g. G-XXXX)
  const measurementId = params.get('tid') || null;

  // client id can be useful for debugging
  const cid = params.get('cid') || null;

  return { event_name: eventName, measurement_id: measurementId, cid };
}

// -------------------- Event classification --------------------
const GENERIC_EVENTS = ['page_view', 'scroll', 'user_engagement', 'session_start', 'first_visit'];

const PHONE_ACTION_EVENTS = [
  'click_call', 'call_click', 'phone_click', 'click_phone',
  'click_tel', 'tel_click', 'phone', 'call', 'link_click',
  'tel_link', 'phone_link', 'call_button', 'phone_button'
];

const EMAIL_ACTION_EVENTS = [
  'click_email', 'email_click', 'mailto_click', 'click_mail',
  'mail_click', 'email', 'mailto', 'link_click', 'email_link',
  'mail_link', 'email_button'
];

const FORM_COMPLETION_EVENTS = [
  'form_submit', 'submit_form', 'form_submission', 'contact_form',
  'generate_lead', 'lead', 'form_complete', 'form_success',
  'contact', 'enquiry', 'quote', 'submit', 'form_sent',
  'message_sent', 'inquiry_sent'
];

function isActionEvent(eventName, actionEvents) {
  if (!eventName) return false;
  const evt = eventName.toLowerCase();
  if (GENERIC_EVENTS.includes(evt)) return false;
  return actionEvents.some(pattern => evt.includes(pattern.toLowerCase()));
}

function isFormCompletionEvent(eventName) {
  if (!eventName) return false;
  const evt = eventName.toLowerCase();
  if (GENERIC_EVENTS.includes(evt)) return false;
  if (evt === 'form_start') return false;
  return FORM_COMPLETION_EVENTS.some(pattern => evt.includes(pattern.toLowerCase()));
}

function isNonGenericEvent(eventName) {
  if (!eventName) return false;
  const evt = eventName.toLowerCase();
  return !GENERIC_EVENTS.includes(evt);
}

// -------------------- Visibility helper for ElementHandle --------------------
async function isHandleVisible(handle) {
  try {
    return await handle.evaluate((el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  } catch {
    return false;
  }
}

// -------------------- Main --------------------
async function trackingHealthCheckSite(inputUrl) {
  log('🚀 STARTING TRACKING HEALTH CHECK');
  log('📌 SCRIPT VERSION: ' + SCRIPT_VERSION);

  const url = normaliseUrl(inputUrl);
  log(`🔍 Target URL: ${url}`);

  const browser = await chromium.launch({
    headless: true,
    timeout: 90000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  const startTime = Date.now();
  const MAX_RUNTIME = 5 * 60 * 1000;

  const results = {
    ok: true,
    url,
    final_url: null,
    timestamp: new Date().toISOString(),
    tags_found: { gtm: [], ga4: [], ignored_aw: [] },
    tags_firing: { gtm_loaded: false, ga4_loaded: false, gtm_hits: 0, ga4_hits: 0 },
    cookie_consent: { banner_found: false, accepted: false, error: null },
    cta_tests: {
      phone_clicks: { found: 0, tested: 0, events_fired: [], failed: [] },
      email_clicks: { found: 0, tested: 0, events_fired: [], failed: [] },
      forms: { found: 0, tested: 0, events_fired: [], failed: [] }
    },
    issues: [],
    critical_errors: [],
    evidence: { network_beacons: [] }
  };

  // Network beacons (CDP: reliable across clients)
  const networkBeacons = [];

  // Attach CDP capture BEFORE any navigation
  let cdp = null;
  try {
    cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');

    cdp.on('Network.requestWillBeSent', (evt) => {
      try {
        const req = evt.request;
        const reqUrl = req.url || '';
        if (!isGaOrGtmUrl(reqUrl)) return;

        const params = mergeParamsFromUrlAndBody(reqUrl, req.postData);
        const { event_name, measurement_id, cid } = extractGaFields(params);

        networkBeacons.push({
          url: reqUrl,
          method: req.method,
          timestamp: new Date().toISOString(),
          timestampMs: Date.now(),
          type: classifyBeacon(reqUrl),
          event_name,
          measurement_id,
          cid,
          has_post_data: !!req.postData
        });
      } catch {}
    });
  } catch (e) {
    // If CDP fails, you still run (but you lose the main reliability fix)
    log(`⚠️ CDP network capture failed: ${e.message}`);
  }

  // Track which CTAs succeeded to avoid duplicates
  const successfulCTAs = { phones: new Set(), emails: new Set(), forms: new Set() };

  try {
    // -------------------- PHASE 1: Load & detect tags --------------------
    log('\n📍 PHASE 1: Loading page and detecting tags...');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      results.final_url = page.url();
      log(`✅ Page loaded: ${results.final_url}`);
    } catch (gotoError) {
      log(`⚠️ Initial load timeout, trying simpler load...`);
      await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
      results.final_url = page.url();
      log(`✅ Page committed: ${results.final_url}`);
    }

    // Give tags time to initialise (do NOT rely on this for events; CDP capture is the real fix)
    await page.waitForTimeout(4000);

    const tagData = await page.evaluate(() => {
      const tags = { gtm: [], ga4: [], aw: [] };
      const scripts = Array.from(document.querySelectorAll('script'));

      scripts.forEach(script => {
        const content = (script.innerHTML || '') + (script.src || '');
        const gtmMatches = content.match(/GTM-[A-Z0-9]+/g);
        if (gtmMatches) tags.gtm.push(...gtmMatches);
        const ga4Matches = content.match(/G-[A-Z0-9]+/g);
        if (ga4Matches) tags.ga4.push(...ga4Matches);
        const awMatches = content.match(/AW-[A-Z0-9]+/g);
        if (awMatches) tags.aw.push(...awMatches);
      });

      return {
        gtm: [...new Set(tags.gtm)],
        ga4: [...new Set(tags.ga4)],
        aw: [...new Set(tags.aw)],
        gtmLoaded: !!window.google_tag_manager,
        ga4Loaded: !!window.gtag || !!window.dataLayer
      };
    });

    results.tags_found.gtm = tagData.gtm;
    results.tags_found.ga4 = tagData.ga4;
    results.tags_found.ignored_aw = tagData.aw;
    results.tags_firing.gtm_loaded = tagData.gtmLoaded;
    results.tags_firing.ga4_loaded = tagData.ga4Loaded;

    log(`📊 Tags detected:`, {
      gtm: tagData.gtm,
      ga4: tagData.ga4,
      gtm_loaded: tagData.gtmLoaded,
      ga4_loaded: tagData.ga4Loaded
    });

    if (tagData.gtm.length === 0) {
      results.critical_errors.push('❌ CRITICAL: No GTM tags found - automatic fail');
      results.ok = false;
    }
    if (tagData.ga4.length === 0) {
      results.critical_errors.push('❌ CRITICAL: No GA4 tags found - automatic fail');
      results.ok = false;
    }

    // Count hits from captured beacons (includes POST & keepalive)
    results.tags_firing.gtm_hits = networkBeacons.filter(b => b.type === 'GTM').length;
    results.tags_firing.ga4_hits = networkBeacons.filter(b => b.type === 'GA4').length;

    // -------------------- PHASE 2: Cookie consent --------------------
    log('\n🍪 PHASE 2: Checking for cookie consent...');

    try {
      const consentSelectors = [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept all")',
        'button:has-text("Accept All")',
        'button:has-text("Accept")',
        'button:has-text("Allow all")',
        'button:has-text("I Accept")',
        'button:has-text("Agree")',
        'button:has-text("OK")',
        '.cookie-accept',
        '.accept-cookies',
        '[aria-label*="accept" i]',
        '[id*="accept" i]'
      ];

      let clicked = false;
      for (const selector of consentSelectors) {
        try {
          const btn = page.locator(selector).first();
          const count = await btn.count().catch(() => 0);
          if (count > 0) {
            const isVis = await btn.isVisible().catch(() => false);
            if (isVis) {
              results.cookie_consent.banner_found = true;
              log(`✅ Found consent button: ${selector}`);
              await btn.click({ timeout: 3000 }).catch(() => {});
              clicked = true;
              // give a moment for tags to resume
              await page.waitForTimeout(2000);
              break;
            }
          }
        } catch {}
      }

      results.cookie_consent.accepted = clicked;
      if (!clicked) log('ℹ️ No consent banner found / no clickable accept button');
    } catch (e) {
      results.cookie_consent.error = e.message;
      log(`⚠️ Consent error: ${e.message}`);
    }

    // -------------------- Polling primitive (timestamp-based) --------------------
    async function pollForEventSince(actionStartMs, matcherFn, maxWaitMs = 8000, label = 'event') {
      const startPoll = Date.now();
      const interval = 250;

      log(`   ⏳ Polling for ${label} (up to ${(maxWaitMs / 1000).toFixed(1)}s)...`);

      while (Date.now() - startPoll < maxWaitMs) {
        const beacons = networkBeacons.filter(b => b.timestampMs >= actionStartMs && b.type === 'GA4');
        const events = beacons.map(b => b.event_name).filter(Boolean);

        if (matcherFn(events, beacons)) {
          const elapsed = ((Date.now() - startPoll) / 1000).toFixed(1);
          log(`   ✅ Match after ${elapsed}s`);
          return { success: true, events, beacons };
        }

        await page.waitForTimeout(interval);
      }

      const beacons = networkBeacons.filter(b => b.timestampMs >= actionStartMs && b.type === 'GA4');
      const events = beacons.map(b => b.event_name).filter(Boolean);

      log(`   ⏱️ Timeout`);
      return { success: false, events, beacons };
    }

    function outcomeFromDetection({ matched, beacons, events }) {
      // PASS: matched specific expected signal
      if (matched) return 'pass';

      // WARN: GA4 activity observed after action, but naming/pattern didn't match
      // (prevents false negatives across clients)
      const hasAnyGa4 = (beacons?.length || 0) > 0;
      const hasNonGeneric = (events || []).some(isNonGenericEvent);
      if (hasAnyGa4 || hasNonGeneric) return 'warn';

      // FAIL: no GA4 activity
      return 'fail';
    }

    // -------------------- PHASE 3: CTA testing --------------------
    log('\n🎯 PHASE 3: Testing CTAs across pages...');

    async function testCTAsOnPage(pageLabel) {
      if (Date.now() - startTime > MAX_RUNTIME) {
        log('⏰ Max runtime reached, stopping');
        return;
      }

      log(`\n📄 Testing page: ${pageLabel} (${page.url()})`);

      // ---------- PHONE ----------
      log('\n📞 Testing phone links...');
      try {
        const phoneLinks = await page.$$('a[href^="tel:"]');
        results.cta_tests.phone_clicks.found += phoneLinks.length;

        if (phoneLinks.length === 0) {
          log('   ℹ️ No phone links found');
        } else {
          log(`   Found ${phoneLinks.length} phone link(s)`);

          const phoneGroups = new Map();
          for (const link of phoneLinks) {
            const href = await link.getAttribute('href').catch(() => null);
            if (!href) continue;
            const key = normalizePhone(href) || href;
            if (!phoneGroups.has(key)) phoneGroups.set(key, []);
            phoneGroups.get(key).push({ link, href });
          }

          for (const [phoneKey, instances] of phoneGroups) {
            if (successfulCTAs.phones.has(phoneKey)) {
              log(`   ✅ Already found working instance of ${phoneKey}, skipping`);
              continue;
            }

            log(`   Testing phone number: ${phoneKey} (${instances.length} instances)`);
            let foundWorking = false;

            for (const { link, href } of instances) {
              if (foundWorking) break;

              const isVis = await isHandleVisible(link);
              if (!isVis) continue;

              log(`      Testing: ${href}`);
              results.cta_tests.phone_clicks.tested++;

              const actionStartMs = Date.now();

              // Try click (non-force), then fallback to force
              try {
                await link.scrollIntoViewIfNeeded().catch(() => {});
                await page.waitForTimeout(150);
                await link.click({ timeout: 2500 }).catch(async () => {
                  await link.click({ timeout: 2500, force: true }).catch(() => {});
                });
              } catch {}

              const detection = await pollForEventSince(
                actionStartMs,
                (events) => events.some(e => isActionEvent(e, PHONE_ACTION_EVENTS)),
                8000,
                'phone GA4 event'
              );

              const matched = detection.events.some(e => isActionEvent(e, PHONE_ACTION_EVENTS));
              const status = outcomeFromDetection({ matched, beacons: detection.beacons, events: detection.events });

              if (status === 'pass') {
                const actionEvents = detection.events.filter(e => isActionEvent(e, PHONE_ACTION_EVENTS));
                log(`      ✅ PASS - Events: ${actionEvents.join(', ')}`);
                results.cta_tests.phone_clicks.events_fired.push({
                  status: 'pass',
                  page: page.url(),
                  link: href,
                  phone_number: phoneKey,
                  reason: 'Matched phone action event',
                  events: detection.events,
                  action_events: actionEvents,
                  ga4_hits_after_action: detection.beacons.length
                });
                foundWorking = true;
                successfulCTAs.phones.add(phoneKey);
              } else if (status === 'warn') {
                log(`      ⚠️ WARN - GA4 activity after click but no matched phone event (saw: ${detection.events.join(', ') || 'no named events'})`);
                results.cta_tests.phone_clicks.events_fired.push({
                  status: 'warn',
                  page: page.url(),
                  link: href,
                  phone_number: phoneKey,
                  reason: 'GA4 activity observed after click but event name did not match patterns',
                  events: detection.events,
                  ga4_hits_after_action: detection.beacons.length
                });
                // still mark group as "working enough" so you don’t spam duplicates
                foundWorking = true;
                successfulCTAs.phones.add(phoneKey);
              } else {
                log(`      ❌ FAIL - No GA4 activity after click`);
              }
            }

            if (!foundWorking) {
              for (const { href } of instances) {
                results.cta_tests.phone_clicks.failed.push({
                  page: page.url(),
                  link: href,
                  phone_number: phoneKey,
                  reason: 'No GA4 activity detected after clicking any instance'
                });
              }
            }
          }
        }
      } catch (e) {
        log(`   ⚠️ Phone test error: ${e.message}`);
      }

      // ---------- EMAIL ----------
      log('\n📧 Testing email links...');
      try {
        const emailLinks = await page.$$('a[href^="mailto:"]');
        results.cta_tests.email_clicks.found += emailLinks.length;

        if (emailLinks.length === 0) {
          log('   ℹ️ No email links found');
        } else {
          log(`   Found ${emailLinks.length} email link(s)`);

          const emailGroups = new Map();
          for (const link of emailLinks) {
            const href = await link.getAttribute('href').catch(() => null);
            if (!href) continue;
            const key = normalizeEmail(href) || href;
            if (!emailGroups.has(key)) emailGroups.set(key, []);
            emailGroups.get(key).push({ link, href });
          }

          for (const [emailKey, instances] of emailGroups) {
            if (successfulCTAs.emails.has(emailKey)) {
              log(`   ✅ Already found working instance of ${emailKey}, skipping`);
              continue;
            }

            log(`   Testing email: ${emailKey} (${instances.length} instances)`);
            let foundWorking = false;

            for (const { link, href } of instances) {
              if (foundWorking) break;

              const isVis = await isHandleVisible(link);
              if (!isVis) continue;

              log(`      Testing: ${href}`);
              results.cta_tests.email_clicks.tested++;

              const actionStartMs = Date.now();

              try {
                await link.scrollIntoViewIfNeeded().catch(() => {});
                await page.waitForTimeout(150);
                await link.hover().catch(() => {});
                await page.waitForTimeout(100);
                await link.click({ timeout: 2500 }).catch(async () => {
                  await link.click({ timeout: 2500, force: true }).catch(() => {});
                });
              } catch {}

              const detection = await pollForEventSince(
                actionStartMs,
                (events) => events.some(e => isActionEvent(e, EMAIL_ACTION_EVENTS)),
                8000,
                'email GA4 event'
              );

              const matched = detection.events.some(e => isActionEvent(e, EMAIL_ACTION_EVENTS));
              const status = outcomeFromDetection({ matched, beacons: detection.beacons, events: detection.events });

              if (status === 'pass') {
                const actionEvents = detection.events.filter(e => isActionEvent(e, EMAIL_ACTION_EVENTS));
                log(`      ✅ PASS - Events: ${actionEvents.join(', ')}`);
                results.cta_tests.email_clicks.events_fired.push({
                  status: 'pass',
                  page: page.url(),
                  link: href,
                  email: emailKey,
                  reason: 'Matched email action event',
                  events: detection.events,
                  action_events: actionEvents,
                  ga4_hits_after_action: detection.beacons.length
                });
                foundWorking = true;
                successfulCTAs.emails.add(emailKey);
              } else if (status === 'warn') {
                log(`      ⚠️ WARN - GA4 activity after click but no matched email event (saw: ${detection.events.join(', ') || 'no named events'})`);
                results.cta_tests.email_clicks.events_fired.push({
                  status: 'warn',
                  page: page.url(),
                  link: href,
                  email: emailKey,
                  reason: 'GA4 activity observed after click but event name did not match patterns',
                  events: detection.events,
                  ga4_hits_after_action: detection.beacons.length
                });
                foundWorking = true;
                successfulCTAs.emails.add(emailKey);
              } else {
                log(`      ❌ FAIL - No GA4 activity after click`);
              }
            }

            if (!foundWorking) {
              for (const { href } of instances) {
                results.cta_tests.email_clicks.failed.push({
                  page: page.url(),
                  link: href,
                  email: emailKey,
                  reason: 'No GA4 activity detected after clicking any instance'
                });
              }
            }
          }
        }
      } catch (e) {
        log(`   ⚠️ Email test error: ${e.message}`);
      }

      // ---------- FORMS ----------
      log('\n📝 Testing forms...');

      // Collect forms from main page + same-origin frames (client-agnostic improvement)
      const formTargets = [];
      try {
        // main page
        const mainForms = await page.$$('form');
        for (let i = 0; i < mainForms.length; i++) {
          formTargets.push({ scope: 'main', page_url: page.url(), form: mainForms[i], form_index: i + 1 });
        }

        // frames
        const frames = page.frames();
        for (const fr of frames) {
          const frUrl = fr.url();
          if (!frUrl || frUrl === 'about:blank') continue;
          if (!isSameOrigin(frUrl, page.url())) continue;

          const frForms = await fr.$$('form').catch(() => []);
          for (let i = 0; i < frForms.length; i++) {
            formTargets.push({ scope: 'frame', page_url: frUrl, form: frForms[i], form_index: i + 1 });
          }
        }
      } catch {}

      results.cta_tests.forms.found += formTargets.length;

      if (formTargets.length === 0) {
        log('   ℹ️ No forms found');
      } else {
        log(`   Found ${formTargets.length} form(s) (main + same-origin frames)`);

        for (const target of formTargets) {
          if (Date.now() - startTime > MAX_RUNTIME) break;

          const { scope, page_url, form, form_index } = target;

          // signature for debugging
          const formSig = await form.evaluate(f =>
            `${f.getAttribute('id') || ''}|${f.getAttribute('name') || ''}|${f.getAttribute('action') || ''}`
          ).catch(() => '');

          // Skip invisible forms
          const formVis = await isHandleVisible(form);
          if (!formVis) continue;

          // Skip external action domains
          const actionAttr = await form.getAttribute('action').catch(() => null);
          if (actionAttr && /^https?:\/\//i.test(actionAttr)) {
            if (!isSameOrigin(actionAttr, page.url())) {
              log(`   ⏭️ Skipping external-action form (${actionAttr})`);
              continue;
            }
          }

          // Visible fields
          const visibleInputs = await form.$$('input:visible:not([type="hidden"]):not([disabled]), textarea:visible:not([disabled]), select:visible:not([disabled])').catch(() => []);
          if (visibleInputs.length === 0) {
            log(`   ⏭️ Skipping form (no visible fields) [${scope}] idx=${form_index}`);
            continue;
          }

          log(`   Testing form [${scope}] idx=${form_index} fields=${visibleInputs.length} sig="${formSig}"`);
          results.cta_tests.forms.tested++;

          // Fill (best-effort)
          let filledCount = 0;

          // Tick consent-style checkboxes (common blocker)
          try {
            const checkboxes = await form.$$('input[type="checkbox"]:visible:not([disabled])').catch(() => []);
            for (const cb of checkboxes.slice(0, 8)) {
              const name = (await cb.getAttribute('name').catch(() => '')) || '';
              const id = (await cb.getAttribute('id').catch(() => '')) || '';
              const required = await cb.getAttribute('required').catch(() => null);

              const hint = `${name} ${id}`.toLowerCase();
              const looksLikeConsent =
                !!required ||
                hint.includes('consent') ||
                hint.includes('policy') ||
                hint.includes('privacy') ||
                hint.includes('terms') ||
                hint.includes('agree');

              if (looksLikeConsent) {
                await cb.check().catch(() => {});
              }
            }
          } catch {}

          for (const input of visibleInputs.slice(0, 12)) {
            try {
              const tag = await input.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
              const inputType = ((await input.getAttribute('type').catch(() => '')) || '').toLowerCase();
              const inputName = ((await input.getAttribute('name').catch(() => '')) || '').toLowerCase();
              const inputId = ((await input.getAttribute('id').catch(() => '')) || '').toLowerCase();

              if (inputType === 'password' || inputType === 'file') continue;

              if (inputType === 'checkbox') {
                await input.check().catch(() => {});
                filledCount++;
              } else if (tag === 'select') {
                // Try selecting first non-empty option
                await input.selectOption({ index: 1 }).catch(() => {});
                filledCount++;
              } else if (inputType === 'email' || inputName.includes('email') || inputId.includes('email')) {
                await input.fill('test@example.com').catch(() => {});
                filledCount++;
              } else if (inputType === 'tel' || inputName.includes('phone') || inputId.includes('phone')) {
                await input.fill('07123456789').catch(() => {});
                filledCount++;
              } else if (tag === 'textarea' || inputName.includes('message') || inputId.includes('message')) {
                await input.fill('Test message. Please ignore.').catch(() => {});
                filledCount++;
              } else {
                await input.fill('Test User').catch(() => {});
                filledCount++;
              }

              await page.waitForTimeout(80);
            } catch {}
          }

          log(`      Filled ${filledCount} field(s)`);

          // Find submit button
          const submitBtn =
            (await form.$('button[type="submit"]:visible, input[type="submit"]:visible').catch(() => null)) ||
            (await form.$('button:visible:has-text("Send")').catch(() => null)) ||
            (await form.$('button:visible:has-text("Submit")').catch(() => null)) ||
            (await form.$('button:visible:has-text("Enquire")').catch(() => null)) ||
            null;

          if (!submitBtn) {
            log('      ⚠️ No submit button found');
            results.cta_tests.forms.failed.push({
              status: 'fail',
              page: page.url(),
              scope,
              form_index,
              form_sig: formSig,
              reason: 'No submit button found'
            });
            continue;
          }

          // Check disabled (common reason for false negatives)
          const isDisabled = await submitBtn.evaluate((el) => {
            const aria = (el.getAttribute('aria-disabled') || '').toLowerCase();
            return !!el.disabled || aria === 'true';
          }).catch(() => false);

          if (isDisabled) {
            log('      ❌ FAIL - Submit disabled (validation/requirements)');
            results.cta_tests.forms.failed.push({
              status: 'fail',
              page: page.url(),
              scope,
              form_index,
              form_sig: formSig,
              reason: 'Submit disabled (validation/requirements)'
            });
            continue;
          }

          log('      👆 Clicking submit...');

          const actionStartMs = Date.now();

          try {
            await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(120);

            // Click without waiting for navigation
            await Promise.race([
              submitBtn.click({ timeout: 2500 }).catch(async () => {
                await submitBtn.click({ timeout: 2500, force: true }).catch(() => {});
              }),
              page.waitForTimeout(3500)
            ]);
          } catch {}

          // Wait for form completion events OR at least GA4 activity
          const detection = await pollForEventSince(
            actionStartMs,
            (events) => events.some(e => isFormCompletionEvent(e)),
            12000,
            'form GA4 event'
          );

          const matched = detection.events.some(e => isFormCompletionEvent(e));
          const status = outcomeFromDetection({ matched, beacons: detection.beacons, events: detection.events });

          if (status === 'pass') {
            const completionEvents = detection.events.filter(e => isFormCompletionEvent(e));
            log(`      ✅ PASS - Completion events: ${completionEvents.join(', ')}`);
            results.cta_tests.forms.events_fired.push({
              status: 'pass',
              page: page.url(),
              scope,
              form_index,
              form_sig: formSig,
              reason: 'Matched form completion event',
              events: detection.events,
              completion_events: completionEvents,
              ga4_hits_after_action: detection.beacons.length
            });
          } else if (status === 'warn') {
            log(`      ⚠️ WARN - GA4 activity after submit but no matched completion event (saw: ${detection.events.join(', ') || 'no named events'})`);
            results.cta_tests.forms.events_fired.push({
              status: 'warn',
              page: page.url(),
              scope,
              form_index,
              form_sig: formSig,
              reason: 'GA4 activity observed after submit but completion event name did not match patterns',
              events: detection.events,
              ga4_hits_after_action: detection.beacons.length
            });
          } else {
            log(`      ❌ FAIL - No GA4 activity after submit`);
            results.cta_tests.forms.failed.push({
              status: 'fail',
              page: page.url(),
              scope,
              form_index,
              form_sig: formSig,
              reason: 'No GA4 activity detected after submit'
            });
          }
        }
      }
    }

    // Homepage
    await testCTAsOnPage('Homepage');

    // Contact pages
    const contactPaths = ['/contact', '/contact-us', '/get-in-touch', '/enquiry', '/quote', '/book', '/booking'];
    const baseOrigin = new URL(results.final_url).origin;

    for (const path of contactPaths) {
      if (Date.now() - startTime > MAX_RUNTIME) break;

      const contactUrl = baseOrigin + path;
      try {
        log(`\n🌐 Navigating to: ${path}`);
        await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1500);
        await testCTAsOnPage(`Contact: ${path}`);
      } catch (navError) {
        log(`   ⚠️ Could not load ${path}: ${navError.message}`);
      }
    }

    // -------------------- PHASE 4: Analyse --------------------
    log('\n📋 PHASE 4: Analyzing results...');

    // Tag loading warnings
    if (results.tags_found.gtm.length > 0 && !results.tags_firing.gtm_loaded) {
      results.issues.push('⚠️ GTM tags found but not loading');
    }
    if (results.tags_found.ga4.length > 0 && !results.tags_firing.ga4_loaded) {
      results.issues.push('⚠️ GA4 tags found but not loading');
    }

    // Only treat as hard fails when there is NO GA4 activity after action (status=fail entries)
    const phoneFails = results.cta_tests.phone_clicks.failed.length;
    const emailFails = results.cta_tests.email_clicks.failed.length;
    const formFails = results.cta_tests.forms.failed.length;

    if (phoneFails > 0) results.issues.push(`❌ ${phoneFails} phone click(s) had no GA4 activity after click`);
    if (emailFails > 0) results.issues.push(`❌ ${emailFails} email click(s) had no GA4 activity after click`);
    if (formFails > 0) results.issues.push(`❌ ${formFails} form(s) had no GA4 activity after submit`);

    // Attach evidence
    results.evidence.network_beacons = networkBeacons;

    // Update beacon counts at end (captures all pages)
    results.tags_firing.gtm_hits = networkBeacons.filter(b => b.type === 'GTM').length;
    results.tags_firing.ga4_hits = networkBeacons.filter(b => b.type === 'GA4').length;

  } catch (error) {
    log(`\n❌ Fatal error: ${error.message}`);
    results.critical_errors.push(`Fatal error: ${error.message}`);
    results.ok = false;
  } finally {
    await browser.close().catch(() => {});
  }

  const runtime = ((Date.now() - startTime) / 1000).toFixed(1);

  const phonePass = results.cta_tests.phone_clicks.events_fired.filter(x => x.status === 'pass').length;
  const phoneWarn = results.cta_tests.phone_clicks.events_fired.filter(x => x.status === 'warn').length;

  const emailPass = results.cta_tests.email_clicks.events_fired.filter(x => x.status === 'pass').length;
  const emailWarn = results.cta_tests.email_clicks.events_fired.filter(x => x.status === 'warn').length;

  const formPass = results.cta_tests.forms.events_fired.filter(x => x.status === 'pass').length;
  const formWarn = results.cta_tests.forms.events_fired.filter(x => x.status === 'warn').length;

  log(`\n${'='.repeat(60)}`);
  log(`✅ Health check complete`);
  log(`   Runtime: ${runtime}s`);
  log(`   Critical errors: ${results.critical_errors.length}`);
  log(`   Issues: ${results.issues.length}`);
  log(`   Phone: PASS ${phonePass}, WARN ${phoneWarn}, FAIL ${results.cta_tests.phone_clicks.failed.length}`);
  log(`   Email: PASS ${emailPass}, WARN ${emailWarn}, FAIL ${results.cta_tests.email_clicks.failed.length}`);
  log(`   Forms: PASS ${formPass}, WARN ${formWarn}, FAIL ${results.cta_tests.forms.failed.length}`);
  log(`   GA4 hits total: ${results.tags_firing.ga4_hits}`);
  log('='.repeat(60));

  return results;
}

module.exports = { trackingHealthCheckSite };

