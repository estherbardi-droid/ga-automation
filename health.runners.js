// health.runners.js
const { chromium } = require('playwright');

async function trackingHealthCheckSite(url) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Starting health check for: ${url}`);
  console.log('='.repeat(60));

  const browser = await chromium.launch({
    headless: true,
    timeout: 90000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  const results = {
    url,
    timestamp: new Date().toISOString(),
    overall_status: 'HEALTHY',
    tracking: {
      gtm_found: false,
      ga4_found: false,
      gtm_working: false, // "working" = loaded OR fired a network request
      ga4_working: false,
      gtm_ids: [],
      ga4_ids: [],
      evidence: {
        saw_gtm_js: false,
        saw_ga4_collect: false,
        initial_ga4_events: []
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

  // Track ALL network requests related to tracking
  const allBeacons = [];
  page.on('request', request => {
    const reqUrl = request.url();

    const isTracking =
      reqUrl.includes('google-analytics.com') ||
      reqUrl.includes('googletagmanager.com') ||
      reqUrl.includes('analytics.google.com') ||
      reqUrl.includes('/g/collect') ||
      reqUrl.includes('/r/collect') ||
      reqUrl.includes('/j/collect') ||
      reqUrl.includes('gtm.js') ||
      reqUrl.includes('gtag');

    if (!isTracking) return;

    let eventName = null;
    let measurementId = null;
    let beaconType = 'Other';

    if (reqUrl.includes('/g/collect') || reqUrl.includes('/r/collect') || reqUrl.includes('/j/collect')) {
      try {
        const urlObj = new URL(reqUrl);
        eventName = urlObj.searchParams.get('en');
        measurementId = urlObj.searchParams.get('tid');
        beaconType = 'GA4';
      } catch (e) {
        // Silent
      }
    } else if (reqUrl.includes('gtm.js')) {
      beaconType = 'GTM';
    }

    allBeacons.push({
      url: reqUrl,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      type: beaconType,
      event_name: eventName,
      measurement_id: measurementId
    });
  });

  const pageLoadStart = Date.now();
  const MAX_RUNTIME = 10 * 60 * 1000; // 10 minutes

  // Event patterns
  const PHONE_EVENT_PATTERNS = [
    'click_call',
    'call_click',
    'phone_click',
    'click_phone',
    'click_line',
    'click_tel',
    'tel_click',
    'call',
    'phone'
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
    'lead_form',
    'form_complete',
    'form_success',
    'submit',
    'contact',
    'enquiry',
    'quote_form'
  ];

  // Generic events to ignore (only exact match)
  const IGNORE_EVENT_PATTERNS = ['page_view', 'scroll', 'user_engagement', 'session_start', 'first_visit'];

  function matchesEventPattern(eventName, patterns) {
    if (!eventName) return false;
    const lowerEvent = eventName.toLowerCase();
    return patterns.some(pattern => lowerEvent.includes(pattern.toLowerCase()));
  }

  function isRelevantEvent(eventName, relevantPatterns) {
    if (!eventName) return false;

    // Must match relevant patterns
    if (!matchesEventPattern(eventName, relevantPatterns)) return false;

    // Exclude exact generic events
    const lowerEvent = eventName.toLowerCase();
    if (IGNORE_EVENT_PATTERNS.includes(lowerEvent)) return false;

    return true;
  }

  function sliceBeaconsSince(beforeCount, startMs, endMs) {
    return allBeacons.slice(beforeCount).filter(b => b.timestampMs >= startMs && b.timestampMs <= endMs);
  }

  async function tryClickConsent(pageInstance) {
    const consentSelectors = [
      'button:has-text("Accept")',
      'button:has-text("Accept All")',
      'button:has-text("Allow all")',
      'button:has-text("I Accept")',
      'button:has-text("OK")',
      'button:has-text("Agree")',
      'button:has-text("Allow")',
      'button:has-text("Continue")',
      '#onetrust-accept-btn-handler',
      '.cookie-accept',
      '[aria-label*="accept"]',
      '[id*="accept"]'
    ];

    const frames = pageInstance.frames();
    for (const frame of frames) {
      for (const selector of consentSelectors) {
        try {
          const btn = await frame.$(selector);
          if (!btn) continue;
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) continue;

          console.log('   ✅ Found consent button');
          await btn.click({ timeout: 5000 }).catch(async () => {
            await btn.click({ force: true });
          });
          console.log('   👆 Accepted cookies');
          await pageInstance.waitForTimeout(2000);
          return true;
        } catch (e) {
          // Continue
        }
      }
    }
    return false;
  }

  try {
    // ============================================================
    // PHASE 1: LOAD PAGE & DETECT TAGS
    // ============================================================
    console.log('\n📍 PHASE 1: Loading page and detecting tags...');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      console.log('   ✅ Page loaded');
    } catch (gotoError) {
      console.log('   ⚠️  Timeout, trying simpler load...');
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
        console.log('   ✅ Page loaded (basic)');
      } catch (retryError) {
        throw new Error(`Could not load page: ${retryError.message}`);
      }
    }

    console.log('   ⏳ Waiting for tracking (5s)...');
    await page.waitForTimeout(5000);

    const tagData = await page.evaluate(() => {
      const tags = { gtm: [], ga4: [], aw: [] };

      const scripts = Array.from(document.querySelectorAll('script'));
      scripts.forEach(script => {
        const content = (script.innerHTML || '') + (script.src || '');
        const gtmMatches = content.match(/GTM-[A-Z0-9]+/g);
        if (gtmMatches) tags.gtm.push(...gtmMatches);

        const ga4Matches = content.match(/G-[A-Z0-9]+/g);
        if (ga4Matches) tags.ga4.push(...ga4Matches);

        const awMatches = content.match(/AW-[0-9]+/g);
        if (awMatches) tags.aw.push(...awMatches);
      });

      const noscripts = Array.from(document.querySelectorAll('noscript'));
      noscripts.forEach(ns => {
        const gtmMatches = (ns.innerHTML || '').match(/GTM-[A-Z0-9]+/g);
        if (gtmMatches) tags.gtm.push(...gtmMatches);
      });

      const gtmLoaded = !!window.google_tag_manager;
      const ga4Loaded = !!window.gtag; // keep this GA4-specific

      return {
        gtm: [...new Set(tags.gtm)],
        ga4: [...new Set(tags.ga4)],
        gtmLoaded,
        ga4Loaded
      };
    });

    // Network evidence for "working"
    const initialBeacons = allBeacons.filter(b => b.timestampMs >= pageLoadStart);
    const sawGtmJs = initialBeacons.some(b => b.type === 'GTM');
    const initialGa4Events = initialBeacons
      .filter(b => b.type === 'GA4' && b.event_name)
      .map(b => b.event_name);

    const sawGa4Collect = initialGa4Events.length > 0;

    results.tracking.evidence.saw_gtm_js = sawGtmJs;
    results.tracking.evidence.saw_ga4_collect = sawGa4Collect;
    results.tracking.evidence.initial_ga4_events = [...new Set(initialGa4Events)];

    // Found = via DOM regex OR via actual GA4 beacon presence
    results.tracking.gtm_found = tagData.gtm.length > 0 || sawGtmJs;
    results.tracking.ga4_found = tagData.ga4.length > 0 || sawGa4Collect;

    results.tracking.gtm_ids = tagData.gtm;
    results.tracking.ga4_ids = tagData.ga4;

    // Working = loaded flag OR network evidence
    results.tracking.gtm_working = results.tracking.gtm_found && (tagData.gtmLoaded || sawGtmJs);
    results.tracking.ga4_working = results.tracking.ga4_found && (tagData.ga4Loaded || sawGa4Collect);

    console.log('\n📊 Tags:');
    console.log(`   GTM: ${results.tracking.gtm_found ? '✅ ' + (tagData.gtm.join(', ') || '(detected via network)') : '❌ Not found'}`);
    console.log(`   GA4: ${results.tracking.ga4_found ? '✅ ' + (tagData.ga4.join(', ') || '(detected via network)') : '❌ Not found'}`);
    if (results.tracking.evidence.initial_ga4_events.length) {
      console.log(`   GA4 events seen on load: ${results.tracking.evidence.initial_ga4_events.join(', ')}`);
    }

    // Critical issue: no tracking tags
    if (!results.tracking.gtm_found && !results.tracking.ga4_found) {
      results.issues.push('❌ CRITICAL: No tracking tags found on site');
      results.overall_status = 'FAILING';
    }

    // ============================================================
    // PHASE 2: COOKIE CONSENT
    // ============================================================
    console.log('\n🍪 PHASE 2: Cookie consent...');

    try {
      const clicked = await tryClickConsent(page);
      if (!clicked) console.log('   ℹ️  No consent banner (or not detected)');
      console.log('   ⏳ Waiting for tracking after consent (2s)...');
      await page.waitForTimeout(2000);
    } catch (e) {
      console.log(`   ⚠️  Consent error: ${e.message}`);
    }

    // ============================================================
    // PHASE 3: TEST CTAs
    // ============================================================
    console.log('\n🎯 PHASE 3: Testing CTAs...');

    if (Date.now() - pageLoadStart > MAX_RUNTIME) {
      throw new Error('Max runtime exceeded');
    }

    // --- PHONE LINKS ---
    console.log('\n📞 Phone links...');
    try {
      const phoneLinks = await page.$$('a[href^="tel:"]');
      results.ctas.phone.total_found = phoneLinks.length;

      if (phoneLinks.length === 0) {
        console.log('   ℹ️  No phone links found');
      } else {
        console.log(`   Found ${phoneLinks.length} phone link(s)`);

        for (let i = 0; i < Math.min(phoneLinks.length, 10); i++) {
          if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

          const link = phoneLinks[i];
          let href = null;
          let linkText = 'unknown';

          try {
            href = await link.getAttribute('href');
            linkText = ((await link.textContent().catch(() => '')) || '').trim() || 'unknown';
          } catch (e) {
            continue;
          }

          console.log(`   Testing ${i + 1}: ${linkText}`);

          const beforeBeaconCount = allBeacons.length;
          const testStartTime = Date.now();

          try {
            await link.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(500);

            const visible = await link.isVisible().catch(() => false);
            if (!visible) {
              console.log('      ⚠️  Not visible, skipping');
              continue;
            }

            await link.click({ force: true, timeout: 5000 });
            await page.waitForTimeout(3000);
          } catch (clickError) {
            console.log('      ❌ Click failed');
            results.ctas.phone.total_tested++;
            results.ctas.phone.broken++;
            results.ctas.phone.broken_details.push({
              link: href,
              text: linkText,
              reason: 'Could not click',
              events_fired: []
            });
            continue;
          }

          const testEndTime = Date.now();
          results.ctas.phone.total_tested++;

          const newBeacons = sliceBeaconsSince(beforeBeaconCount, testStartTime, testEndTime);
          const allGA4Events = newBeacons
            .filter(b => b.type === 'GA4' && b.event_name)
            .map(b => b.event_name);

          const relevantEvents = allGA4Events.filter(ev => isRelevantEvent(ev, PHONE_EVENT_PATTERNS));

          if (relevantEvents.length > 0) {
            results.ctas.phone.working++;
            results.ctas.phone.working_details.push({
              link: href,
              text: linkText,
              events_fired: [...new Set(allGA4Events)],
              relevant_events: [...new Set(relevantEvents)]
            });
            console.log(`      ✅ Working: ${[...new Set(relevantEvents)].join(', ')}`);
          } else {
            results.ctas.phone.broken++;
            results.ctas.phone.broken_details.push({
              link: href,
              text: linkText,
              reason:
                allGA4Events.length > 0
                  ? `Only non-phone events: ${[...new Set(allGA4Events)].join(', ')}`
                  : 'No GA4 event fired',
              events_fired: [...new Set(allGA4Events)]
            });
            console.log('      ❌ No relevant GA4 event');
          }
        }
      }
    } catch (e) {
      console.log(`   ⚠️  Error: ${e.message}`);
    }

    // --- EMAIL LINKS ---
    console.log('\n📧 Email links...');
    try {
      if (Date.now() - pageLoadStart > MAX_RUNTIME) {
        console.log('   ⚠️  Skipping (timeout)');
      } else {
        const emailLinks = await page.$$('a[href^="mailto:"]');
        results.ctas.email.total_found = emailLinks.length;

        if (emailLinks.length === 0) {
          console.log('   ℹ️  No email links found');
        } else {
          console.log(`   Found ${emailLinks.length} email link(s)`);

          for (let i = 0; i < Math.min(emailLinks.length, 10); i++) {
            if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

            const link = emailLinks[i];
            let href = null;
            let linkText = 'unknown';

            try {
              href = await link.getAttribute('href');
              linkText = ((await link.textContent().catch(() => '')) || '').trim() || 'unknown';
            } catch (e) {
              continue;
            }

            console.log(`   Testing ${i + 1}: ${linkText}`);

            const beforeBeaconCount = allBeacons.length;
            const testStartTime = Date.now();

            try {
              await link.scrollIntoViewIfNeeded().catch(() => {});
              await page.waitForTimeout(500);

              const visible = await link.isVisible().catch(() => false);
              if (!visible) {
                console.log('      ⚠️  Not visible, skipping');
                continue;
              }

              await link.hover().catch(() => {});
              await page.waitForTimeout(200);
              await link.click({ force: true, timeout: 5000 });
              await page.waitForTimeout(3000);
            } catch (clickError) {
              console.log('      ❌ Click failed');
              results.ctas.email.total_tested++;
              results.ctas.email.broken++;
              results.ctas.email.broken_details.push({
                link: href,
                text: linkText,
                reason: 'Could not click',
                events_fired: []
              });
              continue;
            }

            const testEndTime = Date.now();
            results.ctas.email.total_tested++;

            const newBeacons = sliceBeaconsSince(beforeBeaconCount, testStartTime, testEndTime);
            const allGA4Events = newBeacons
              .filter(b => b.type === 'GA4' && b.event_name)
              .map(b => b.event_name);

            const relevantEvents = allGA4Events.filter(ev => isRelevantEvent(ev, EMAIL_EVENT_PATTERNS));

            if (relevantEvents.length > 0) {
              results.ctas.email.working++;
              results.ctas.email.working_details.push({
                link: href,
                text: linkText,
                events_fired: [...new Set(allGA4Events)],
                relevant_events: [...new Set(relevantEvents)]
              });
              console.log(`      ✅ Working: ${[...new Set(relevantEvents)].join(', ')}`);
            } else {
              results.ctas.email.broken++;
              results.ctas.email.broken_details.push({
                link: href,
                text: linkText,
                reason:
                  allGA4Events.length > 0
                    ? `Only non-email events: ${[...new Set(allGA4Events)].join(', ')}`
                    : 'No GA4 event fired',
                events_fired: [...new Set(allGA4Events)]
              });
              console.log('      ❌ No relevant GA4 event');
            }
          }
        }
      }
    } catch (e) {
      console.log(`   ⚠️  Error: ${e.message}`);
    }

    // --- FORMS ---
    console.log('\n📝 Forms...');
    try {
      if (Date.now() - pageLoadStart > MAX_RUNTIME) {
        console.log('   ⚠️  Skipping (timeout)');
      } else {
        let allForms = [];
        const originalUrl = page.url();

        // Strategy 1: visible forms
        let forms = await page.$$('form:visible');
        allForms.push(...forms);

        // Strategy 2: scroll
        if (forms.length === 0) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
          await page.waitForTimeout(1500);
          forms = await page.$$('form:visible');
          allForms.push(...forms);
        }

        // Strategy 3: click likely triggers
        if (allForms.length === 0) {
          const triggers = [
            'button:has-text("Contact")',
            'a:has-text("Contact")',
            'button:has-text("Get Quote")',
            'a:has-text("Get Quote")',
            'button:has-text("Enquiry")',
            'a:has-text("Enquiry")'
          ];

          for (const selector of triggers) {
            try {
              const trigger = await page.$(selector);
              if (trigger && (await trigger.isVisible().catch(() => false))) {
                await trigger.click({ timeout: 3000 }).catch(() => trigger.click({ force: true }));
                await page.waitForTimeout(1500);
                forms = await page.$$('form:visible');
                if (forms.length > 0) {
                  allForms.push(...forms);
                  break;
                }
              }
            } catch (e) {
              // continue
            }
          }
        }

        // Strategy 4: contact pages
        if (allForms.length === 0 && Date.now() - pageLoadStart < MAX_RUNTIME) {
          const baseUrl = new URL(originalUrl).origin;
          for (const path of ['/contact', '/contact-us', '/get-in-touch']) {
            try {
              const response = await page.goto(baseUrl + path, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
              });
              if (response && response.ok()) {
                await page.waitForTimeout(2000);
                forms = await page.$$('form:visible');
                if (forms.length > 0) {
                  allForms.push(...forms);
                  break;
                }
              }
            } catch (e) {
              // continue
            }
          }
        }

        // Deduplicate forms (best-effort)
        const uniqueForms = [];
        const seen = new Set();
        for (const form of allForms) {
          try {
            const key = await form.evaluate(el => el.id || el.getAttribute('name') || el.className || el.outerHTML.slice(0, 120));
            if (!seen.has(key)) {
              seen.add(key);
              uniqueForms.push(form);
            }
          } catch (e) {
            // stale
          }
        }

        results.ctas.forms.total_found = uniqueForms.length;

        if (uniqueForms.length === 0) {
          console.log('   ℹ️  No forms found');
        } else {
          console.log(`   Found ${uniqueForms.length} form(s)`);

          for (let i = 0; i < Math.min(uniqueForms.length, 3); i++) {
            if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

            const form = uniqueForms[i];
            console.log(`   Testing form ${i + 1}...`);

            const visible = await form.isVisible().catch(() => false);
            if (!visible) {
              console.log('      ⚠️  Not visible, skipping');
              continue;
            }

            const beforeBeaconCount = allBeacons.length;
            const testStartTime = Date.now();

            try {
              await form.scrollIntoViewIfNeeded().catch(() => {});
              await page.waitForTimeout(500);

              const inputs = await form.$$('input:visible, textarea:visible, select:visible');
              let filledFields = 0;

              for (const input of inputs) {
                try {
                  const tag = await input.evaluate(el => el.tagName.toLowerCase());
                  const inputType = (await input.getAttribute('type')) || '';
                  const inputName = (await input.getAttribute('name')) || '';
                  const placeholder = (await input.getAttribute('placeholder')) || '';

                  const nameL = inputName.toLowerCase();
                  const phL = placeholder.toLowerCase();
                  const typeL = inputType.toLowerCase();

                  if (tag === 'select') {
                    // Best-effort: pick first non-empty option
                    await input.selectOption({ index: 1 }).catch(() => {});
                    filledFields++;
                  } else if (tag === 'textarea') {
                    await input.fill('Test message').catch(() => {});
                    filledFields++;
                  } else if (typeL === 'checkbox') {
                    await input.check().catch(() => {});
                    filledFields++;
                  } else if (typeL === 'email' || nameL.includes('email') || phL.includes('email')) {
                    await input.fill('test@example.com').catch(() => {});
                    filledFields++;
                  } else if (typeL === 'tel' || nameL.includes('phone') || phL.includes('phone') || nameL.includes('tel')) {
                    await input.fill('5551234567').catch(() => {});
                    filledFields++;
                  } else if (nameL.includes('name') || phL.includes('name')) {
                    await input.fill('Test User').catch(() => {});
                    filledFields++;
                  } else if (typeL === 'text' || typeL === '' || typeL === 'search') {
                    await input.fill('Test').catch(() => {});
                    filledFields++;
                  }

                  await page.waitForTimeout(150);
                } catch (e) {
                  // skip
                }
              }

              console.log(`      Filled ${filledFields} field(s)`);

              if (filledFields === 0) {
                results.ctas.forms.total_tested++;
                results.ctas.forms.broken++;
                results.ctas.forms.broken_details.push({
                  form_index: i + 1,
                  reason: 'Could not fill any fields',
                  events_fired: []
                });
                console.log('      ❌ Could not fill fields');
                continue;
              }

              const submitBtn = await form.$(
                'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send"), button:has-text("Enquire")'
              );

              if (!submitBtn || !(await submitBtn.isVisible().catch(() => false))) {
                results.ctas.forms.total_tested++;
                results.ctas.forms.broken++;
                results.ctas.forms.broken_details.push({
                  form_index: i + 1,
                  reason: 'No visible submit button',
                  events_fired: []
                });
                console.log('      ❌ No submit button');
                continue;
              }

              console.log('      👆 Submitting...');
              await submitBtn.click({ timeout: 5000 }).catch(async () => {
                await submitBtn.click({ force: true });
              });

              await page.waitForTimeout(5000);

              const testEndTime = Date.now();
              results.ctas.forms.total_tested++;

              const newBeacons = sliceBeaconsSince(beforeBeaconCount, testStartTime, testEndTime);
              const allGA4Events = newBeacons
                .filter(b => b.type === 'GA4' && b.event_name)
                .map(b => b.event_name);

              const relevantEvents = allGA4Events.filter(ev => isRelevantEvent(ev, FORM_EVENT_PATTERNS));

              if (relevantEvents.length > 0) {
                results.ctas.forms.working++;
                results.ctas.forms.working_details.push({
                  form_index: i + 1,
                  events_fired: [...new Set(allGA4Events)],
                  relevant_events: [...new Set(relevantEvents)]
                });
                console.log(`      ✅ Working: ${[...new Set(relevantEvents)].join(', ')}`);
              } else {
                results.ctas.forms.broken++;
                results.ctas.forms.broken_details.push({
                  form_index: i + 1,
                  reason:
                    allGA4Events.length > 0
                      ? `Only non-form events: ${[...new Set(allGA4Events)].join(', ')}`
                      : 'No GA4 event fired',
                  events_fired: [...new Set(allGA4Events)]
                });
                console.log('      ❌ No relevant GA4 event');
              }
            } catch (e) {
              results.ctas.forms.total_tested++;
              results.ctas.forms.broken++;
              results.ctas.forms.broken_details.push({
                form_index: i + 1,
                reason: `Error during form test: ${e.message}`,
                events_fired: []
              });
              console.log(`      ⚠️  Error: ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`   ⚠️  Error: ${e.message}`);
    }

    // ============================================================
    // PHASE 4: ANALYZE & CREATE ISSUES
    // ============================================================
    console.log('\n📋 PHASE 4: Analysis...');

    const totalCTAs =
      results.ctas.phone.total_tested + results.ctas.email.total_tested + results.ctas.forms.total_tested;

    const workingCTAs = results.ctas.phone.working + results.ctas.email.working + results.ctas.forms.working;

    const brokenCTAs = results.ctas.phone.broken + results.ctas.email.broken + results.ctas.forms.broken;

    // Phone issues
    if (results.ctas.phone.broken > 0) {
      if (results.ctas.phone.broken === results.ctas.phone.total_tested && results.ctas.phone.total_tested > 0) {
        results.issues.push(`❌ CRITICAL: All phone links not tracking (0/${results.ctas.phone.total_tested})`);
      } else if (results.ctas.phone.total_tested > 0) {
        results.issues.push(`⚠️ ${results.ctas.phone.broken}/${results.ctas.phone.total_tested} phone links not tracking`);
      }
    }

    // Email issues
    if (results.ctas.email.broken > 0) {
      if (results.ctas.email.broken === results.ctas.email.total_tested && results.ctas.email.total_tested > 0) {
        results.issues.push(`❌ CRITICAL: All email links not tracking (0/${results.ctas.email.total_tested})`);
      } else if (results.ctas.email.total_tested > 0) {
        results.issues.push(`⚠️ ${results.ctas.email.broken}/${results.ctas.email.total_tested} email links not tracking`);
      }
    }

    // Form issues
    if (results.ctas.forms.broken > 0) {
      if (results.ctas.forms.broken === results.ctas.forms.total_tested && results.ctas.forms.total_tested > 0) {
        results.issues.push(`❌ CRITICAL: All forms not tracking (0/${results.ctas.forms.total_tested})`);
      } else if (results.ctas.forms.total_tested > 0) {
        results.issues.push(`⚠️ ${results.ctas.forms.broken}/${results.ctas.forms.total_tested} forms not tracking`);
      }
    }

    // Tracking issues (found vs working)
    if (results.tracking.gtm_found && !results.tracking.gtm_working) {
      results.issues.push('⚠️ GTM found but no strong evidence it loaded/fired (no gtm.js + no window.google_tag_manager)');
    }
    if (results.tracking.ga4_found && !results.tracking.ga4_working) {
      results.issues.push('⚠️ GA4 found but no strong evidence it fired (no GA4 collect beacons + no window.gtag)');
    }

    const criticalIssues = results.issues.filter(i => i.includes('CRITICAL')).length;

    if (criticalIssues > 0 || (!results.tracking.gtm_found && !results.tracking.ga4_found)) {
      results.overall_status = 'FAILING';
    } else if (brokenCTAs > 0 || results.issues.length > 0) {
      results.overall_status = 'WARNING';
    } else {
      results.overall_status = 'HEALTHY';
    }

    results.summary = totalCTAs > 0 ? `${workingCTAs}/${totalCTAs} CTAs tracking correctly` : 'No CTAs found to test';
  } catch (error) {
    console.log(`\n❌ Fatal error: ${error.message}`);
    results.issues.push(`Fatal error: ${error.message}`);
    results.overall_status = 'ERROR';
  } finally {
    await browser.close().catch(() => {});
  }

  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Health check complete: ${url}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n📊 SUMMARY:`);
  console.log(`   Status: ${results.overall_status}`);
  console.log(`   ${results.summary}`);
  console.log(`\n🏷️  TRACKING:`);
  console.log(`   GTM: ${results.tracking.gtm_found ? '✅ Found' : '❌ Not found'} | Working: ${results.tracking.gtm_working ? '✅' : '❌'}`);
  console.log(`   GA4: ${results.tracking.ga4_found ? '✅ Found' : '❌ Not found'} | Working: ${results.tracking.ga4_working ? '✅' : '❌'}`);
  console.log(`\n🎯 CTAS:`);
  console.log(`   📞 Phone: ${results.ctas.phone.working}/${results.ctas.phone.total_tested} working`);
  console.log(`   📧 Email: ${results.ctas.email.working}/${results.ctas.email.total_tested} working`);
  console.log(`   📝 Forms: ${results.ctas.forms.working}/${results.ctas.forms.total_tested} working`);

  if (results.issues.length > 0) {
    console.log(`\n⚠️  ISSUES:`);
    results.issues.forEach((issue, index) => {
      console.log(`   ${index + 1}. ${issue}`);
    });
  } else {
    console.log(`\n✅ No issues - all tracking working!`);
  }

  console.log('='.repeat(60) + '\n');

  return results;
}

module.exports = {
  trackingHealthCheckSite
};
