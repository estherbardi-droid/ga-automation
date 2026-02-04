// health.runners.js
// VERSION: 2026-02-04T17:30:00Z
// MAJOR UPDATE: Polling for events + test-until-success logic
// - Polls for GA4 events (checks every 500ms up to 5 seconds)
// - Tests all duplicate CTAs until one succeeds
// - Skips forms with 0 visible fields
// - Handles navigation without hanging
// - Better event matching

const { chromium } = require('playwright');

const SCRIPT_VERSION = '2026-02-04T17:30:00Z';

// Helper to log with timestamp
function log(message, data = null) {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
}

// Normalize phone/email for grouping (not strict deduplication anymore)
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

// Check if same origin
function isSameOrigin(urlA, urlB) {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

// Event classification
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

async function trackingHealthCheckSite(url) {
  log('🚀 STARTING TRACKING HEALTH CHECK');
  log('📌 SCRIPT VERSION: ' + SCRIPT_VERSION);
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
  const MAX_RUNTIME = 5 * 60 * 1000; // 5 minutes max

  const results = {
    ok: true,
    url,
    final_url: null,
    timestamp: new Date().toISOString(),
    tags_found: {
      gtm: [],
      ga4: [],
      ignored_aw: []
    },
    tags_firing: {
      gtm_loaded: false,
      ga4_loaded: false,
      gtm_hits: 0,
      ga4_hits: 0
    },
    cookie_consent: {
      banner_found: false,
      accepted: false,
      error: null
    },
    cta_tests: {
      phone_clicks: { found: 0, tested: 0, events_fired: [], failed: [] },
      email_clicks: { found: 0, tested: 0, events_fired: [], failed: [] },
      forms: { found: 0, tested: 0, events_fired: [], failed: [] }
    },
    issues: [],
    critical_errors: [],
    evidence: {
      dataLayer_events: [],
      network_beacons: []
    },
    expected: null
  };

  // Track network requests
  const networkBeacons = [];
  page.on('request', request => {
    const reqUrl = request.url();
    if (
      reqUrl.includes('google-analytics.com') ||
      reqUrl.includes('googletagmanager.com') ||
      reqUrl.includes('analytics.google.com') ||
      reqUrl.includes('/g/collect') ||
      reqUrl.includes('/r/collect') ||
      reqUrl.includes('gtm.js') ||
      reqUrl.includes('gtag')
    ) {
      let eventName = null;
      let measurementId = null;

      if (reqUrl.includes('/g/collect') || reqUrl.includes('/r/collect')) {
        try {
          const urlObj = new URL(reqUrl);
          eventName = urlObj.searchParams.get('en');
          measurementId = urlObj.searchParams.get('tid');
        } catch {}
      }

      networkBeacons.push({
        url: reqUrl,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        type: reqUrl.includes('gtm.js') ? 'GTM' : reqUrl.includes('/g/collect') ? 'GA4' : 'Other',
        event_name: eventName,
        measurement_id: measurementId
      });
    }
  });

  // Track which CTAs succeeded (to avoid testing more duplicates)
  const successfulCTAs = {
    phones: new Set(),
    emails: new Set(),
    forms: new Set()
  };

  // Track which CTAs we've tested (for reporting)
  const attemptedCTAs = {
    phones: new Set(),
    emails: new Set(),
    forms: new Set()
  };

  try {
    // ============================================================
    // PHASE 1: LOAD PAGE & DETECT TAGS
    // ============================================================
    log('\n📍 PHASE 1: Loading page and detecting tags...');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      results.final_url = page.url();
      log(`✅ Page loaded: ${results.final_url}`);
    } catch (gotoError) {
      log(`⚠️ Initial load timeout, trying simpler load...`);
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
        results.final_url = page.url();
        log(`✅ Page committed: ${results.final_url}`);
      } catch (retryError) {
        throw new Error(`Could not load page: ${retryError.message}`);
      }
    }

    // Give GA4 time to fully initialize
    await page.waitForTimeout(5000);
    log('⏳ Waited 5s for GA4 initialization');

    // Scan for tags
    const tagData = await page.evaluate(() => {
      const tags = { gtm: [], ga4: [], aw: [] };
      const scripts = Array.from(document.querySelectorAll('script'));
      
      scripts.forEach(script => {
        const content = script.innerHTML + (script.src || '');
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

    // CRITICAL: No tags = automatic fail
    if (tagData.gtm.length === 0) {
      results.critical_errors.push('❌ CRITICAL: No GTM tags found - automatic fail');
      results.ok = false;
    }
    if (tagData.ga4.length === 0) {
      results.critical_errors.push('❌ CRITICAL: No GA4 tags found - automatic fail');
      results.ok = false;
    }

    results.tags_firing.gtm_hits = networkBeacons.filter(b => b.type === 'GTM').length;
    results.tags_firing.ga4_hits = networkBeacons.filter(b => b.type === 'GA4').length;

    // ============================================================
    // PHASE 2: HANDLE COOKIE CONSENT
    // ============================================================
    log('\n🍪 PHASE 2: Checking for cookie consent...');

    try {
      const consentSelectors = [
        '#onetrust-accept-btn-handler',
        'button:has-text("Accept")',
        'button:has-text("Accept all")',
        'button:has-text("Accept All")',
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
              await page.waitForTimeout(3000); // Wait for tags to reinitialize
              log('✅ Consent accepted, waited 3s for tags to reload');
              break;
            }
          }
        } catch {}
      }

      results.cookie_consent.accepted = clicked;
      if (!clicked) {
        log('ℹ️ No consent banner found');
      }
    } catch (e) {
      results.cookie_consent.error = e.message;
      log(`⚠️ Consent error: ${e.message}`);
    }

    // ============================================================
    // PHASE 3: TEST CTAs ON MULTIPLE PAGES
    // ============================================================
    log('\n🎯 PHASE 3: Testing CTAs across pages...');

    // Helper: Poll for events with specific criteria
    async function pollForEvent(beforeBeaconCount, checkFn, maxWaitMs = 5000, label = 'event') {
      const startPoll = Date.now();
      const pollInterval = 500; // Check every 500ms
      
      log(`   ⏳ Polling for ${label} (up to ${maxWaitMs/1000}s)...`);

      while (Date.now() - startPoll < maxWaitMs) {
        const newBeacons = networkBeacons.slice(beforeBeaconCount);
        const ga4Events = newBeacons
          .filter(b => b.event_name)
          .map(b => b.event_name);

        if (checkFn(ga4Events)) {
          const elapsed = ((Date.now() - startPoll) / 1000).toFixed(1);
          log(`   ✅ Event found after ${elapsed}s`);
          return { success: true, events: ga4Events };
        }

        await page.waitForTimeout(pollInterval);
      }

      const finalBeacons = networkBeacons.slice(beforeBeaconCount);
      const finalEvents = finalBeacons
        .filter(b => b.event_name)
        .map(b => b.event_name);

      log(`   ⏱️ Timeout - no matching event found`);
      return { success: false, events: finalEvents };
    }

    async function testCTAsOnPage(pageLabel) {
      if (Date.now() - startTime > MAX_RUNTIME) {
        log('⏰ Max runtime reached, stopping');
        return;
      }

      log(`\n📄 Testing page: ${pageLabel} (${page.url()})`);

      const currentOrigin = new URL(page.url()).origin;

      // --- TEST PHONE CLICKS ---
      log('\n📞 Testing phone links...');
      try {
        const phoneLinks = await page.$$('a[href^="tel:"]');
        const foundCount = phoneLinks.length;
        results.cta_tests.phone_clicks.found += foundCount;

        if (foundCount > 0) {
          log(`   Found ${foundCount} phone link(s)`);

          // Group by normalized number
          const phoneGroups = new Map();
          for (let i = 0; i < phoneLinks.length; i++) {
            const link = phoneLinks[i];
            const href = await link.getAttribute('href').catch(() => null);
            if (!href) continue;

            const phoneKey = normalizePhone(href);
            if (!phoneGroups.has(phoneKey)) {
              phoneGroups.set(phoneKey, []);
            }
            phoneGroups.get(phoneKey).push({ link, href, index: i });
          }

          // Test each group until we find success
          for (const [phoneKey, instances] of phoneGroups) {
            // Skip if already succeeded
            if (successfulCTAs.phones.has(phoneKey)) {
              log(`   ✅ Already found working instance of ${phoneKey}, skipping`);
              continue;
            }

            log(`   Testing phone number: ${phoneKey} (${instances.length} instances)`);

            let foundWorking = false;
            for (const { link, href } of instances) {
              if (foundWorking) {
                log(`      ↩️ Skipping duplicate (already found working): ${href}`);
                continue;
              }

              attemptedCTAs.phones.add(href);
              log(`      Testing: ${href}`);

              const beforeBeacons = networkBeacons.length;
              
              try {
                await link.scrollIntoViewIfNeeded().catch(() => {});
                await page.waitForTimeout(300);
                await link.click({ force: true, timeout: 3000 }).catch(() => {});
              } catch (clickError) {
                log(`         ⚠️ Click failed: ${clickError.message}`);
                continue;
              }

              // Poll for phone action events
              const result = await pollForEvent(
                beforeBeacons,
                (events) => events.some(e => isActionEvent(e, PHONE_ACTION_EVENTS)),
                5000,
                'phone action event'
              );

              results.cta_tests.phone_clicks.tested++;

              if (result.success) {
                const actionEvents = result.events.filter(e => isActionEvent(e, PHONE_ACTION_EVENTS));
                log(`      ✅ SUCCESS - Events: ${actionEvents.join(', ')}`);
                results.cta_tests.phone_clicks.events_fired.push({
                  link: href,
                  phone_number: phoneKey,
                  reason: 'Action event fired',
                  events: result.events,
                  action_events: actionEvents
                });
                foundWorking = true;
                successfulCTAs.phones.add(phoneKey);
              } else {
                log(`      ❌ No action events (saw: ${result.events.join(', ') || 'none'})`);
                // Don't add to failed yet - might find working duplicate
              }
            }

            // If none worked, mark all as failed
            if (!foundWorking) {
              for (const { href } of instances) {
                results.cta_tests.phone_clicks.failed.push({
                  link: href,
                  phone_number: phoneKey,
                  reason: 'No action events fired on any instance'
                });
              }
            }
          }
        } else {
          log('   ℹ️ No phone links found');
        }
      } catch (e) {
        log(`   ⚠️ Phone test error: ${e.message}`);
      }

      // --- TEST EMAIL CLICKS ---
      log('\n📧 Testing email links...');
      try {
        const emailLinks = await page.$$('a[href^="mailto:"]');
        const foundCount = emailLinks.length;
        results.cta_tests.email_clicks.found += foundCount;

        if (foundCount > 0) {
          log(`   Found ${foundCount} email link(s)`);

          // Group by normalized email
          const emailGroups = new Map();
          for (let i = 0; i < emailLinks.length; i++) {
            const link = emailLinks[i];
            const href = await link.getAttribute('href').catch(() => null);
            if (!href) continue;

            const emailKey = normalizeEmail(href);
            if (!emailGroups.has(emailKey)) {
              emailGroups.set(emailKey, []);
            }
            emailGroups.get(emailKey).push({ link, href, index: i });
          }

          // Test each group until we find success
          for (const [emailKey, instances] of emailGroups) {
            // Skip if already succeeded
            if (successfulCTAs.emails.has(emailKey)) {
              log(`   ✅ Already found working instance of ${emailKey}, skipping`);
              continue;
            }

            log(`   Testing email: ${emailKey} (${instances.length} instances)`);

            let foundWorking = false;
            for (const { link, href } of instances) {
              if (foundWorking) {
                log(`      ↩️ Skipping duplicate (already found working): ${href}`);
                continue;
              }

              attemptedCTAs.emails.add(href);
              log(`      Testing: ${href}`);

              const beforeBeacons = networkBeacons.length;
              
              try {
                await link.scrollIntoViewIfNeeded().catch(() => {});
                await page.waitForTimeout(300);
                await link.hover().catch(() => {});
                await page.waitForTimeout(200);
                await link.click({ force: true, timeout: 3000 }).catch(() => {});
              } catch (clickError) {
                log(`         ⚠️ Click failed: ${clickError.message}`);
                continue;
              }

              // Poll for email action events
              const result = await pollForEvent(
                beforeBeacons,
                (events) => events.some(e => isActionEvent(e, EMAIL_ACTION_EVENTS)),
                5000,
                'email action event'
              );

              results.cta_tests.email_clicks.tested++;

              if (result.success) {
                const actionEvents = result.events.filter(e => isActionEvent(e, EMAIL_ACTION_EVENTS));
                log(`      ✅ SUCCESS - Events: ${actionEvents.join(', ')}`);
                results.cta_tests.email_clicks.events_fired.push({
                  link: href,
                  email: emailKey,
                  reason: 'Action event fired',
                  events: result.events,
                  action_events: actionEvents
                });
                foundWorking = true;
                successfulCTAs.emails.add(emailKey);
              } else {
                log(`      ❌ No action events (saw: ${result.events.join(', ') || 'none'})`);
              }
            }

            // If none worked, mark all as failed
            if (!foundWorking) {
              for (const { href } of instances) {
                results.cta_tests.email_clicks.failed.push({
                  link: href,
                  email: emailKey,
                  reason: 'No action events fired on any instance'
                });
              }
            }
          }
        } else {
          log('   ℹ️ No email links found');
        }
      } catch (e) {
        log(`   ⚠️ Email test error: ${e.message}`);
      }

      // --- TEST FORMS ---
      log('\n📝 Testing forms...');
      try {
        const forms = await page.$$('form');
        const foundCount = forms.length;
        results.cta_tests.forms.found += foundCount;

        if (foundCount > 0) {
          log(`   Found ${foundCount} form(s)`);

          for (let i = 0; i < forms.length; i++) {
            const form = forms[i];

            // Check if form is on external domain
            const formUrl = page.url();
            if (!isSameOrigin(currentOrigin, formUrl)) {
              log(`   ⏭️ Skipping external form (different domain)`);
              continue;
            }

            // Check visible fields FIRST
            const visibleInputs = await form.$$('input:visible:not([type="hidden"]), textarea:visible, select:visible').catch(() => []);
            
            if (visibleInputs.length === 0) {
              log(`   ⏭️ Skipping form ${i + 1} (no visible fields)`);
              continue;
            }

            log(`   Testing form ${i + 1} (${visibleInputs.length} visible fields)...`);

            const beforeBeacons = networkBeacons.length;

            // Fill form
            let filledCount = 0;
            for (const input of visibleInputs.slice(0, 10)) {
              try {
                const inputType = await input.getAttribute('type').catch(() => '');
                const inputName = await input.getAttribute('name').catch(() => '');

                if (inputType === 'password' || inputType === 'file') continue;

                if (inputType === 'checkbox') {
                  await input.check().catch(() => {});
                  filledCount++;
                } else if (inputType === 'email' || inputName?.includes('email')) {
                  await input.fill('test@example.com').catch(() => {});
                  filledCount++;
                } else if (inputType === 'tel' || inputName?.includes('phone')) {
                  await input.fill('1234567890').catch(() => {});
                  filledCount++;
                } else if (inputType === 'text' || inputType === 'textarea' || !inputType) {
                  await input.fill('Test User').catch(() => {});
                  filledCount++;
                }
                await page.waitForTimeout(150);
              } catch {}
            }

            log(`      Filled ${filledCount} field(s)`);

            // Find and click submit
            const submitBtn = await form.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send")').catch(() => null);

            if (submitBtn) {
              log('      👆 Clicking submit...');
              
              try {
                // Click without waiting for navigation
                await Promise.race([
                  submitBtn.click({ timeout: 3000 }),
                  page.waitForTimeout(3500)
                ]).catch(() => {});
              } catch (clickError) {
                log(`         ⚠️ Submit click issue: ${clickError.message}`);
              }

              // Poll for form completion events
              const result = await pollForEvent(
                beforeBeacons,
                (events) => events.some(e => isFormCompletionEvent(e)),
                6000, // Forms can be slower
                'form completion event'
              );

              results.cta_tests.forms.tested++;

              if (result.success) {
                const completionEvents = result.events.filter(e => isFormCompletionEvent(e));
                log(`      ✅ SUCCESS - Completion events: ${completionEvents.join(', ')}`);
                results.cta_tests.forms.events_fired.push({
                  form_index: i + 1,
                  reason: 'Form completion event fired',
                  events: result.events,
                  completion_events: completionEvents
                });
              } else {
                const hasFormStart = result.events.some(e => e.toLowerCase() === 'form_start');
                const reason = hasFormStart
                  ? 'Only form_start (no completion event)'
                  : result.events.length > 0
                  ? `No completion events (saw: ${result.events.join(', ')})`
                  : 'No tracking fired';

                log(`      ❌ FAILED - ${reason}`);
                results.cta_tests.forms.failed.push({
                  form_index: i + 1,
                  reason
                });
              }
            } else {
              log('      ⚠️ No submit button found');
            }
          }
        } else {
          log('   ℹ️ No forms found');
        }
      } catch (e) {
        log(`   ⚠️ Form test error: ${e.message}`);
      }
    }

    // Test homepage
    await testCTAsOnPage('Homepage');

    // Test contact pages
    const contactPaths = [
      '/contact',
      '/contact-us',
      '/get-in-touch',
      '/enquiry',
      '/quote',
      '/book',
      '/booking'
    ];

    const baseOrigin = new URL(results.final_url).origin;

    for (const path of contactPaths) {
      if (Date.now() - startTime > MAX_RUNTIME) break;

      const contactUrl = baseOrigin + path;
      
      try {
        log(`\n🌐 Navigating to: ${path}`);
        await page.goto(contactUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        await testCTAsOnPage(`Contact: ${path}`);
      } catch (navError) {
        log(`   ⚠️ Could not load ${path}: ${navError.message}`);
      }
    }

    // ============================================================
    // PHASE 4: ANALYZE RESULTS
    // ============================================================
    log('\n📋 PHASE 4: Analyzing results...');

    if (results.tags_found.gtm.length > 0 && !results.tags_firing.gtm_loaded) {
      results.issues.push('⚠️ GTM tags found but not loading');
    }
    if (results.tags_found.ga4.length > 0 && !results.tags_firing.ga4_loaded) {
      results.issues.push('⚠️ GA4 tags found but not loading');
    }

    const phoneFailed = results.cta_tests.phone_clicks.failed.length;
    const phoneTotal = results.cta_tests.phone_clicks.tested;
    if (phoneFailed > 0) {
      results.issues.push(`❌ ${phoneFailed}/${phoneTotal} phone click(s) not tracking properly`);
    }

    const emailFailed = results.cta_tests.email_clicks.failed.length;
    const emailTotal = results.cta_tests.email_clicks.tested;
    if (emailFailed > 0) {
      results.issues.push(`❌ ${emailFailed}/${emailTotal} email click(s) not tracking properly`);
    }

    const formFailed = results.cta_tests.forms.failed.length;
    const formTotal = results.cta_tests.forms.tested;
    if (formFailed > 0) {
      results.issues.push(`❌ ${formFailed}/${formTotal} form(s) not tracking properly`);
    }

    results.evidence.network_beacons = networkBeacons;

  } catch (error) {
    log(`\n❌ Fatal error: ${error.message}`);
    results.critical_errors.push(`Fatal error: ${error.message}`);
    results.ok = false;
  } finally {
    await browser.close().catch(() => {});
  }

  const runtime = ((Date.now() - startTime) / 1000).toFixed(1);

  log(`\n${'='.repeat(60)}`);
  log(`✅ Health check complete`);
  log(`   Runtime: ${runtime}s`);
  log(`   Critical errors: ${results.critical_errors.length}`);
  log(`   Issues: ${results.issues.length}`);
  log(`   Phone: ${results.cta_tests.phone_clicks.events_fired.length} working / ${results.cta_tests.phone_clicks.tested} tested`);
  log(`   Email: ${results.cta_tests.email_clicks.events_fired.length} working / ${results.cta_tests.email_clicks.tested} tested`);
  log(`   Forms: ${results.cta_tests.forms.events_fired.length} working / ${results.cta_tests.forms.tested} tested`);
  log('='.repeat(60));

  return results;
}

module.exports = {
  trackingHealthCheckSite
};
