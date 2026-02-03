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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
 
  const results = {
    url,
    timestamp: new Date().toISOString(),
    tags_found: {
      gtm: [],
      ga4: [],
      ignored_aw: []
    },
    tags_firing: {
      gtm_loaded: false,
      ga4_loaded: false,
      ga4_initialized: false,
      gtm_hits: 0,
      ga4_hits: 0,
      ga4_measurement_ids: []
    },
    cookie_consent: {
      banner_found: false,
      accepted: false,
      ga4_fired_after_consent: false
    },
    cta_tests: {
      phone_clicks: { found: 0, tested: 0, working: 0, events_fired: [], failed: [] },
      email_clicks: { found: 0, tested: 0, working: 0, events_fired: [], failed: [] },
      forms: { found: 0, tested: 0, working: 0, events_fired: [], failed: [] }
    },
    issues: [],
    evidence: {
      all_beacons: [],
      dataLayer_snapshot: [],
      page_load_time_ms: 0
    }
  };
 
  // Track ALL network requests (for evidence and analysis)
  const allBeacons = [];
  page.on('request', request => {
    const reqUrl = request.url();
    
    // Capture Google Analytics & Tag Manager requests
    if (
      reqUrl.includes('google-analytics.com') ||
      reqUrl.includes('googletagmanager.com') ||
      reqUrl.includes('analytics.google.com') ||
      reqUrl.includes('/g/collect') ||
      reqUrl.includes('/r/collect') ||
      reqUrl.includes('/j/collect') ||
      reqUrl.includes('gtm.js') ||
      reqUrl.includes('gtag')
    ) {
      let eventName = null;
      let measurementId = null;
      let beaconType = 'Other';
      
      // Parse GA4 beacons
      if (reqUrl.includes('/g/collect') || reqUrl.includes('/r/collect') || reqUrl.includes('/j/collect')) {
        try {
          const urlObj = new URL(reqUrl);
          eventName = urlObj.searchParams.get('en'); // Event name
          measurementId = urlObj.searchParams.get('tid'); // Measurement ID (G-XXXXXXX)
          beaconType = 'GA4';
        } catch (e) {
          console.log(`   ⚠️  Could not parse beacon URL: ${e.message}`);
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
    }
  });

  const pageLoadStart = Date.now();
  const MAX_RUNTIME = 8 * 60 * 1000; // 8 minutes max per site

  try {
    // ============================================================
    // PHASE 1: LOAD PAGE & DETECT TAGS
    // ============================================================
    console.log('\n📍 PHASE 1: Loading page and detecting tags...');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      console.log('   ✅ Page loaded (DOM ready)');
    } catch (gotoError) {
      console.log(`   ⚠️  Initial load timeout, trying simpler load...`);
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
        console.log('   ✅ Page committed (basic load)');
      } catch (retryError) {
        throw new Error(`Could not load page: ${retryError.message}`);
      }
    }

    results.evidence.page_load_time_ms = Date.now() - pageLoadStart;

    // Wait for tracking to initialize
    console.log('   ⏳ Waiting for tracking to initialize (5s)...');
    await page.waitForTimeout(5000);

    // Scan for all tags on page
    const tagData = await page.evaluate(() => {
      const tags = {
        gtm: [],
        ga4: [],
        aw: []
      };
     
      // Check scripts
      const scripts = Array.from(document.querySelectorAll('script'));
      scripts.forEach(script => {
        const content = script.innerHTML + (script.src || '');
       
        const gtmMatches = content.match(/GTM-[A-Z0-9]+/g);
        if (gtmMatches) tags.gtm.push(...gtmMatches);
       
        const ga4Matches = content.match(/G-[A-Z0-9]+/g);
        if (ga4Matches) tags.ga4.push(...ga4Matches);
       
        const awMatches = content.match(/AW-[0-9]+/g);
        if (awMatches) tags.aw.push(...awMatches);
      });
     
      // Check noscript fallbacks
      const noscripts = Array.from(document.querySelectorAll('noscript'));
      noscripts.forEach(ns => {
        const gtmMatches = ns.innerHTML.match(/GTM-[A-Z0-9]+/g);
        if (gtmMatches) tags.gtm.push(...gtmMatches);
      });
     
      // Check if GTM loaded
      const gtmLoaded = !!window.google_tag_manager;
      
      // Check if GA4 loaded (multiple methods)
      const ga4Loaded = !!(
        window.gtag || 
        window.dataLayer?.some(e => 
          e.event === 'gtm.js' || 
          e['gtm.uniqueEventId'] !== undefined
        )
      );

      // Check if GA4 was configured (config command sent)
      const ga4Configs = [];
      if (window.dataLayer) {
        window.dataLayer.forEach(item => {
          // GTM pushes config as array: ['config', 'G-XXXXXXX', {...}]
          if (Array.isArray(item) && item[0] === 'config' && item[1]?.startsWith('G-')) {
            ga4Configs.push(item[1]);
          }
          // Direct gtag pushes config as object: {event: 'gtag.config', ...}
          if (item.event === 'gtag.config' && item['gtag.id']?.startsWith('G-')) {
            ga4Configs.push(item['gtag.id']);
          }
        });
      }
     
      return {
        gtm: [...new Set(tags.gtm)],
        ga4: [...new Set(tags.ga4)],
        aw: [...new Set(tags.aw)],
        gtmLoaded,
        ga4Loaded,
        ga4Configs: [...new Set(ga4Configs)]
      };
    });
   
    results.tags_found.gtm = tagData.gtm;
    results.tags_found.ga4 = tagData.ga4;
    results.tags_found.ignored_aw = tagData.aw;
    results.tags_firing.gtm_loaded = tagData.gtmLoaded;
    results.tags_firing.ga4_loaded = tagData.ga4Loaded;
    results.tags_firing.ga4_initialized = tagData.ga4Configs.length > 0;
    results.tags_firing.ga4_measurement_ids = tagData.ga4Configs;
   
    console.log(`\n📊 Tags detected:`);
    console.log(`   GTM Tags: ${tagData.gtm.length > 0 ? tagData.gtm.join(', ') : '❌ None'}`);
    console.log(`   GA4 Tags: ${tagData.ga4.length > 0 ? tagData.ga4.join(', ') : '❌ None'}`);
    console.log(`   AW Tags (ignored): ${tagData.aw.length}`);
    console.log(`   GTM Loaded: ${tagData.gtmLoaded ? '✅' : '❌'}`);
    console.log(`   GA4 Loaded: ${tagData.ga4Loaded ? '✅' : '❌'}`);
    console.log(`   GA4 Configured: ${tagData.ga4Configs.length > 0 ? '✅ ' + tagData.ga4Configs.join(', ') : '❌'}`);
   
    // Count beacon hits from page load
    results.tags_firing.gtm_hits = allBeacons.filter(b => b.type === 'GTM').length;
    results.tags_firing.ga4_hits = allBeacons.filter(b => b.type === 'GA4').length;
    
    console.log(`   GTM Beacons: ${results.tags_firing.gtm_hits}`);
    console.log(`   GA4 Beacons: ${results.tags_firing.ga4_hits}`);
   
    // ============================================================
    // PHASE 2: HANDLE COOKIE CONSENT
    // ============================================================
    console.log('\n🍪 PHASE 2: Checking for cookie consent banner...');
   
    try {
      const consentSelectors = [
        'button:has-text("Accept")',
        'button:has-text("Accept All")',
        'button:has-text("Accept all")',
        'button:has-text("I Accept")',
        'button:has-text("OK")',
        'button:has-text("Agree")',
        'button:has-text("Allow all")',
        'button:has-text("Allow All")',
        'a:has-text("Accept")',
        '[id*="accept"][role="button"]',
        '[class*="accept"][role="button"]',
        '[id*="cookie"] button:has-text("Accept")',
        '#onetrust-accept-btn-handler',
        '.cookie-accept',
        '.accept-cookies',
        '[aria-label*="Accept"]'
      ];
     
      let consentButton = null;
      let foundSelector = null;
      
      for (const selector of consentSelectors) {
        try {
          consentButton = await page.$(selector);
          if (consentButton) {
            const isVisible = await consentButton.isVisible();
            if (isVisible) {
              foundSelector = selector;
              console.log(`   ✅ Found consent button: ${selector}`);
              break;
            }
          }
        } catch (e) {
          // Selector might not be valid, continue to next
        }
      }
     
      if (consentButton) {
        results.cookie_consent.banner_found = true;
        console.log('   👆 Clicking accept button...');
        
        const beforeConsentBeacons = allBeacons.length;
        
        try {
          await consentButton.click({ timeout: 5000 });
          results.cookie_consent.accepted = true;
        } catch (clickError) {
          console.log(`   ⚠️  Click failed, trying force click...`);
          await consentButton.click({ force: true });
          results.cookie_consent.accepted = true;
        }
        
        // Wait for GA4 beacon after consent (or timeout after 5s)
        try {
          await page.waitForRequest(
            request => {
              const url = request.url();
              return url.includes('/g/collect') || url.includes('/r/collect') || url.includes('/j/collect');
            },
            { timeout: 5000 }
          );
          console.log('   ✅ GA4 beacon fired after consent');
          results.cookie_consent.ga4_fired_after_consent = true;
        } catch (e) {
          console.log('   ⚠️  No GA4 beacon detected within 5s of consent');
          // Still wait a bit in case tracking is slow
          await page.waitForTimeout(2000);
        }
        
        const afterConsentBeacons = allBeacons.length;
        const newBeacons = afterConsentBeacons - beforeConsentBeacons;
        console.log(`   📊 ${newBeacons} new beacon(s) after consent`);
        
      } else {
        console.log('   ℹ️  No cookie consent banner found (or already accepted)');
      }
    } catch (e) {
      console.log(`   ⚠️  Cookie consent error: ${e.message}`);
    }
   
    // ============================================================
    // PHASE 3: TEST CTAs
    // ============================================================
    console.log('\n🎯 PHASE 3: Testing CTAs and monitoring GA4 events...');
   
    // Helper function to get dataLayer snapshot
    async function getDataLayerSnapshot() {
      return await page.evaluate(() => {
        if (window.dataLayer) {
          return window.dataLayer.map((item, index) => ({
            index,
            event: item.event || (Array.isArray(item) ? item[0] : 'unknown'),
            data: item
          }));
        }
        return [];
      });
    }
   
    // Early exit check
    if (Date.now() - pageLoadStart > MAX_RUNTIME) {
      console.log('⚠️  Max runtime exceeded, skipping CTA tests');
      throw new Error('Max runtime exceeded');
    }

    // --- TEST PHONE CLICKS ---
    console.log('\n📞 Testing phone clicks...');
    try {
      const phoneLinks = await page.$$('a[href^="tel:"]');
      results.cta_tests.phone_clicks.found = phoneLinks.length;
     
      if (phoneLinks.length > 0) {
        console.log(`   Found ${phoneLinks.length} phone link(s)`);
       
        for (let i = 0; i < Math.min(phoneLinks.length, 3); i++) {
          if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

          const link = phoneLinks[i];
          const href = await link.getAttribute('href');
          const phoneNumber = href?.replace('tel:', '') || 'unknown';
         
          console.log(`   Testing phone link ${i + 1}: ${href}`);
         
          const beforeBeaconCount = allBeacons.length;
          const testStartTime = Date.now();
         
          try {
            await link.scrollIntoViewIfNeeded();
            await page.waitForTimeout(500);
            await link.click({ force: true, timeout: 5000 });
            console.log('      👆 Clicked phone link');
            await page.waitForTimeout(3000);
          } catch (clickError) {
            console.log(`      ⚠️  Click error: ${clickError.message}`);
            results.cta_tests.phone_clicks.failed.push({
              link: href,
              reason: `Click failed: ${clickError.message}`
            });
            continue;
          }
         
          const testEndTime = Date.now();
          
          const newBeacons = allBeacons.slice(beforeBeaconCount).filter(b => {
            return b.timestampMs >= testStartTime && b.timestampMs <= testEndTime;
          });
          
          const ga4Events = newBeacons
            .filter(b => b.type === 'GA4' && b.event_name)
            .map(b => b.event_name);
          
          results.cta_tests.phone_clicks.tested++;
         
          if (ga4Events.length > 0) {
            results.cta_tests.phone_clicks.working++;
            results.cta_tests.phone_clicks.events_fired.push({
              link: href,
              phone_number: phoneNumber,
              ga4_events: ga4Events,
              beacon_count: newBeacons.filter(b => b.type === 'GA4').length,
              timestamp: new Date().toISOString()
            });
            console.log(`      ✅ GA4 Events Fired: ${ga4Events.join(', ')}`);
          } else {
            const ga4BeaconsNoEvent = newBeacons.filter(b => b.type === 'GA4' && !b.event_name);
            
            if (ga4BeaconsNoEvent.length > 0) {
              results.cta_tests.phone_clicks.failed.push({
                link: href,
                phone_number: phoneNumber,
                reason: 'GA4 beacon sent but no event name detected',
                beacon_count: ga4BeaconsNoEvent.length
              });
              console.log(`      ⚠️  GA4 beacon sent but no event name`);
            } else {
              results.cta_tests.phone_clicks.failed.push({
                link: href,
                phone_number: phoneNumber,
                reason: 'No GA4 beacon sent'
              });
              console.log(`      ❌ No GA4 beacon sent`);
            }
          }
        }
      } else {
        console.log('   ℹ️  No phone links found');
      }
    } catch (e) {
      console.log(`   ⚠️  Phone test error: ${e.message}`);
    }
   
    // --- TEST EMAIL CLICKS ---
    console.log('\n📧 Testing email clicks...');
    try {
      if (Date.now() - pageLoadStart > MAX_RUNTIME) {
        console.log('   ⚠️  Max runtime exceeded, skipping email tests');
      } else {
        const emailLinks = await page.$$('a[href^="mailto:"]');
        results.cta_tests.email_clicks.found = emailLinks.length;
       
        if (emailLinks.length > 0) {
          console.log(`   Found ${emailLinks.length} email link(s)`);
         
          for (let i = 0; i < Math.min(emailLinks.length, 3); i++) {
            if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

            const link = emailLinks[i];
            const href = await link.getAttribute('href');
            const emailAddress = href?.replace('mailto:', '').split('?')[0] || 'unknown';
           
            console.log(`   Testing email link ${i + 1}: ${href}`);
           
            const beforeBeaconCount = allBeacons.length;
            const testStartTime = Date.now();
           
            try {
              await link.scrollIntoViewIfNeeded();
              await page.waitForTimeout(1000);
              await link.hover();
              await page.waitForTimeout(500);
              await link.click({ force: true, timeout: 5000 });
              console.log('      👆 Clicked email link');
              await page.waitForTimeout(3000);
            } catch (clickError) {
              console.log(`      ⚠️  Click error: ${clickError.message}`);
              results.cta_tests.email_clicks.failed.push({
                link: href,
                reason: `Click failed: ${clickError.message}`
              });
              continue;
            }
           
            const testEndTime = Date.now();
            
            const newBeacons = allBeacons.slice(beforeBeaconCount).filter(b => {
              return b.timestampMs >= testStartTime && b.timestampMs <= testEndTime;
            });
            
            const ga4Events = newBeacons
              .filter(b => b.type === 'GA4' && b.event_name)
              .map(b => b.event_name);
           
            results.cta_tests.email_clicks.tested++;
           
            if (ga4Events.length > 0) {
              results.cta_tests.email_clicks.working++;
              results.cta_tests.email_clicks.events_fired.push({
                link: href,
                email_address: emailAddress,
                ga4_events: ga4Events,
                beacon_count: newBeacons.filter(b => b.type === 'GA4').length,
                timestamp: new Date().toISOString()
              });
              console.log(`      ✅ GA4 Events Fired: ${ga4Events.join(', ')}`);
            } else {
              const ga4BeaconsNoEvent = newBeacons.filter(b => b.type === 'GA4' && !b.event_name);
              
              if (ga4BeaconsNoEvent.length > 0) {
                results.cta_tests.email_clicks.failed.push({
                  link: href,
                  email_address: emailAddress,
                  reason: 'GA4 beacon sent but no event name detected',
                  beacon_count: ga4BeaconsNoEvent.length
                });
                console.log(`      ⚠️  GA4 beacon sent but no event name`);
              } else {
                results.cta_tests.email_clicks.failed.push({
                  link: href,
                  email_address: emailAddress,
                  reason: 'No GA4 beacon sent'
                });
                console.log(`      ❌ No GA4 beacon sent`);
              }
            }
          }
        } else {
          console.log('   ℹ️  No email links found');
        }
      }
    } catch (e) {
      console.log(`   ⚠️  Email test error: ${e.message}`);
    }
   
    // --- TEST FORMS (COMPREHENSIVE) ---
    console.log('\n📝 Testing forms...');
    try {
      if (Date.now() - pageLoadStart > MAX_RUNTIME) {
        console.log('   ⚠️  Max runtime exceeded, skipping form tests');
      } else {
        let allForms = [];
        const originalUrl = page.url();
        
        // ============================================================
        // STRATEGY 1: Look for immediately visible forms
        // ============================================================
        console.log('   🔍 Strategy 1: Checking for visible forms on current page...');
        let forms = await page.$$('form:visible');
        console.log(`      Found ${forms.length} immediately visible form(s)`);
        allForms.push(...forms);
        
        // ============================================================
        // STRATEGY 2: Scroll down to trigger lazy-loaded content
        // ============================================================
        if (forms.length === 0) {
          console.log('   🔍 Strategy 2: Scrolling to reveal lazy-loaded forms...');
          await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
          });
          await page.waitForTimeout(2000);
          
          forms = await page.$$('form:visible');
          console.log(`      Found ${forms.length} form(s) after scrolling`);
          allForms.push(...forms);
        }
        
        // ============================================================
        // STRATEGY 3: Click common trigger buttons/links
        // ============================================================
        if (allForms.length === 0) {
          console.log('   🔍 Strategy 3: Looking for form trigger buttons...');
          
          const triggerSelectors = [
            'button:has-text("Contact")',
            'button:has-text("Get in Touch")',
            'button:has-text("Get In Touch")',
            'button:has-text("Request")',
            'button:has-text("Quote")',
            'button:has-text("Enquire")',
            'button:has-text("Enquiry")',
            'a:has-text("Contact Us")',
            'a:has-text("Get Quote")',
            '[class*="contact-btn"]',
            '[id*="contact-btn"]',
            '[class*="cta"]',
            '[aria-label*="contact"]',
            '[aria-label*="Contact"]'
          ];
          
          for (const selector of triggerSelectors) {
            try {
              const trigger = await page.$(selector);
              if (trigger) {
                const isVisible = await trigger.isVisible();
                if (isVisible) {
                  console.log(`      Found trigger: ${selector}`);
                  await trigger.click({ timeout: 3000 });
                  await page.waitForTimeout(2000);
                  
                  forms = await page.$$('form:visible');
                  if (forms.length > 0) {
                    console.log(`      ✅ ${forms.length} form(s) appeared after clicking`);
                    allForms.push(...forms);
                    break;
                  }
                }
              }
            } catch (e) {
              // Selector didn't work, try next one
            }
          }
        }
        
        // ============================================================
        // STRATEGY 4: Check common contact page URLs
        // ============================================================
        if (allForms.length === 0 && Date.now() - pageLoadStart < MAX_RUNTIME) {
          console.log('   🔍 Strategy 4: Checking common contact pages...');
          
          const baseUrl = new URL(originalUrl).origin;
          const contactPaths = ['/contact', '/contact-us', '/get-in-touch', '/enquiry', '/quote'];
          
          for (const path of contactPaths) {
            if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

            try {
              console.log(`      Trying ${baseUrl}${path}...`);
              const response = await page.goto(baseUrl + path, { 
                waitUntil: 'domcontentloaded', 
                timeout: 15000 
              });
              
              if (response && response.ok()) {
                await page.waitForTimeout(3000);
                forms = await page.$$('form:visible');
                
                if (forms.length > 0) {
                  console.log(`      ✅ Found ${forms.length} form(s) on ${path}`);
                  allForms.push(...forms);
                  break;
                }
              }
            } catch (e) {
              console.log(`      ℹ️  ${path} not found or failed to load`);
            }
          }
          
          // Navigate back if needed
          if (page.url() !== originalUrl && allForms.length === 0) {
            try {
              await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              await page.waitForTimeout(2000);
            } catch (e) {
              console.log('      ⚠️  Could not navigate back to original page');
            }
          }
        }
        
        // ============================================================
        // STRATEGY 5: Look for iframe-embedded forms
        // ============================================================
        if (allForms.length === 0) {
          console.log('   🔍 Strategy 5: Checking for forms in iframes...');
          
          const frames = page.frames();
          for (const frame of frames) {
            try {
              const iframeForms = await frame.$$('form');
              if (iframeForms.length > 0) {
                console.log(`      ✅ Found ${iframeForms.length} form(s) in iframe`);
                allForms.push(...iframeForms);
              }
            } catch (e) {
              // Can't access iframe (cross-origin), skip
            }
          }
        }
        
        // ============================================================
        // STRATEGY 6: Look for non-standard form implementations
        // ============================================================
        if (allForms.length === 0) {
          console.log('   🔍 Strategy 6: Checking for custom form implementations...');
          
          const customFormSelectors = [
            'div[class*="contact-form"]',
            'div[id*="contact-form"]',
            'div[class*="enquiry-form"]',
            'div[class*="quote-form"]',
            '[role="form"]'
          ];
          
          for (const selector of customFormSelectors) {
            try {
              const customForm = await page.$(selector);
              if (customForm) {
                const inputs = await customForm.$$('input, textarea');
                if (inputs.length > 0) {
                  console.log(`      ✅ Found custom form: ${selector} with ${inputs.length} fields`);
                  allForms.push(customForm);
                  break;
                }
              }
            } catch (e) {
              // Selector didn't work
            }
          }
        }
        
        // ============================================================
        // DEDUPLICATE FORMS
        // ============================================================
        const uniqueForms = [];
        const seenForms = new Set();
        
        for (const form of allForms) {
          try {
            const formId = await form.evaluate(el => {
              return el.id || el.className || el.outerHTML.substring(0, 100);
            });
            
            if (!seenForms.has(formId)) {
              seenForms.add(formId);
              uniqueForms.push(form);
            }
          } catch (e) {
            // Form might be stale, skip
          }
        }
        
        results.cta_tests.forms.found = uniqueForms.length;
        
        // ============================================================
        // TEST THE FORMS WE FOUND
        // ============================================================
        if (uniqueForms.length > 0) {
          console.log(`\n   📊 Total unique forms found: ${uniqueForms.length}`);
          console.log('   🧪 Starting form tests...\n');
          
          for (let i = 0; i < Math.min(uniqueForms.length, 2); i++) {
            if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

            const form = uniqueForms[i];
            console.log(`   Testing form ${i + 1}...`);
            
            try {
              const isVisible = await form.isVisible().catch(() => false);
              if (!isVisible) {
                console.log('      ⚠️  Form not visible, skipping');
                continue;
              }
              
              const beforeBeaconCount = allBeacons.length;
              const testStartTime = Date.now();
              
              await form.scrollIntoViewIfNeeded();
              await page.waitForTimeout(1000);
              
              const inputs = await form.$$('input:visible, textarea:visible, select:visible');
              console.log(`      Form has ${inputs.length} visible field(s)`);
              
              let filledFields = 0;
              for (const input of inputs) {
                try {
                  const inputType = await input.getAttribute('type');
                  const inputName = await input.getAttribute('name');
                  const placeholder = await input.getAttribute('placeholder');
                  const isRequired = await input.getAttribute('required');
                  
                  if (inputType === 'email' || 
                      inputName?.toLowerCase().includes('email') || 
                      placeholder?.toLowerCase().includes('email')) {
                    await input.fill('test@example.com');
                    filledFields++;
                  } 
                  else if (inputType === 'tel' || 
                           inputName?.toLowerCase().includes('phone') || 
                           inputName?.toLowerCase().includes('tel') ||
                           placeholder?.toLowerCase().includes('phone')) {
                    await input.fill('5551234567');
                    filledFields++;
                  }
                  else if (inputName?.toLowerCase().includes('name') || 
                           placeholder?.toLowerCase().includes('name')) {
                    await input.fill('Test User');
                    filledFields++;
                  }
                  else if (inputType === 'text' || !inputType) {
                    await input.fill('Test Input');
                    filledFields++;
                  } 
                  else if (inputType === 'textarea') {
                    await input.fill('This is a test message from automated health check.');
                    filledFields++;
                  } 
                  else if (inputType === 'checkbox' && isRequired) {
                    await input.check();
                    filledFields++;
                  } 
                  else if (inputType === 'radio') {
                    await input.check();
                    filledFields++;
                  }
                  
                  await page.waitForTimeout(300);
                  
                } catch (fillError) {
                  // Skip fields that can't be filled
                }
              }
              
              console.log(`      ✅ Filled ${filledFields} field(s)`);
              
              if (filledFields === 0) {
                console.log('      ⚠️  Could not fill any fields, skipping submit');
                continue;
              }
              
              const validationError = await page.$('.error:visible, .invalid-feedback:visible, [aria-invalid="true"]:visible').catch(() => null);
              if (validationError) {
                console.log('      ⚠️  Validation errors detected, skipping submit');
                continue;
              }
              
              const submitSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Submit")',
                'button:has-text("Send")',
                'button:has-text("Contact")',
                'button:has-text("Request")',
                'button:has-text("Get Quote")',
                'button:has-text("Enquire")',
                '[type="submit"]'
              ];
              
              let submitBtn = null;
              for (const selector of submitSelectors) {
                submitBtn = await form.$(selector);
                if (submitBtn) {
                  const isVisible = await submitBtn.isVisible().catch(() => false);
                  if (isVisible) break;
                }
              }
              
              if (submitBtn) {
                try {
                  console.log('      👆 Clicking submit...');
                  await submitBtn.click({ timeout: 5000 });
                  await page.waitForTimeout(4000);
                } catch (submitError) {
                  console.log(`      ⚠️  Submit error: ${submitError.message}`);
                  results.cta_tests.forms.failed.push({
                    form_index: i + 1,
                    reason: `Submit failed: ${submitError.message}`
                  });
                  continue;
                }
                
                const testEndTime = Date.now();
                
                const newBeacons = allBeacons.slice(beforeBeaconCount).filter(b => {
                  return b.timestampMs >= testStartTime && b.timestampMs <= testEndTime;
                });
                
                const ga4Events = newBeacons
                  .filter(b => b.type === 'GA4' && b.event_name)
                  .map(b => b.event_name);
                
                results.cta_tests.forms.tested++;
                
                if (ga4Events.length > 0) {
                  results.cta_tests.forms.working++;
                  results.cta_tests.forms.events_fired.push({
                    form_index: i + 1,
                    fields_filled: filledFields,
                    ga4_events: ga4Events,
                    beacon_count: newBeacons.filter(b => b.type === 'GA4').length,
                    timestamp: new Date().toISOString()
                  });
                  console.log(`      ✅ GA4 Events Fired: ${ga4Events.join(', ')}`);
                } else {
                  const ga4BeaconsNoEvent = newBeacons.filter(b => b.type === 'GA4' && !b.event_name);
                  
                  if (ga4BeaconsNoEvent.length > 0) {
                    results.cta_tests.forms.failed.push({
                      form_index: i + 1,
                      reason: 'GA4 beacon sent but no event name detected',
                      beacon_count: ga4BeaconsNoEvent.length
                    });
                    console.log(`      ⚠️  GA4 beacon sent but no event name`);
                  } else {
                    results.cta_tests.forms.failed.push({
                      form_index: i + 1,
                      reason: 'No GA4 beacon sent'
                    });
                    console.log(`      ❌ No GA4 beacon sent`);
                  }
                }
              } else {
                console.log('      ⚠️  No submit button found');
              }
              
            } catch (formTestError) {
              console.log(`      ⚠️  Form test error: ${formTestError.message}`);
            }
          }
        } else {
          console.log('   ℹ️  No forms found after all strategies');
        }
      }
    } catch (e) {
      console.log(`   ⚠️  Form detection error: ${e.message}`);
    }

    // ============================================================
    // PHASE 4: COLLECT ISSUES & EVIDENCE
    // ============================================================
    console.log('\n📋 PHASE 4: Analyzing results and collecting evidence...');
   
    results.evidence.dataLayer_snapshot = await getDataLayerSnapshot();
    results.evidence.all_beacons = allBeacons;
    
    // Check if GTM is actually working (look at dataLayer events)
    const gtmIsWorking = results.evidence.dataLayer_snapshot.some(e => 
      e.event === 'gtm.js' || e.event === 'gtm.dom' || e.event === 'gtm.load'
    );
    
    // Check if GA4 beacons exist
    const ga4BeaconsExist = allBeacons.some(b => b.type === 'GA4' && b.event_name);
    
    // Check if CTAs are working
    const ctasWorking = 
      results.cta_tests.phone_clicks.working > 0 ||
      results.cta_tests.email_clicks.working > 0 ||
      results.cta_tests.forms.working > 0;
    
    // Tag-related issues
    if (results.tags_found.gtm.length === 0 && results.tags_found.ga4.length === 0) {
      results.issues.push('❌ CRITICAL: No tracking tags found (no GTM or GA4)');
    }
    if (results.tags_found.gtm.length > 0 && !gtmIsWorking) {
      results.issues.push('⚠️  GTM tags detected but GTM events not firing');
    }
    if (results.tags_found.ga4.length > 0 && !results.tags_firing.ga4_loaded) {
      results.issues.push('⚠️  GA4 tags detected but GA4 not loaded');
    }
    if (results.tags_found.ga4.length > 0 && results.tags_firing.ga4_loaded && !results.tags_firing.ga4_initialized) {
      results.issues.push('⚠️  GA4 loaded but not configured (no measurement ID config sent)');
    }
    if (results.tags_firing.ga4_hits === 0 && results.tags_firing.ga4_initialized) {
      results.issues.push('⚠️  GA4 configured but no beacons sent during page load');
    }
    
    // Cookie consent issues
    if (results.cookie_consent.banner_found && results.cookie_consent.accepted && !results.cookie_consent.ga4_fired_after_consent) {
      results.issues.push('⚠️  Cookie consent accepted but GA4 did not fire afterward');
    }
    
    // CTA tracking issues
    const phoneFailures = results.cta_tests.phone_clicks.failed.length;
    const emailFailures = results.cta_tests.email_clicks.failed.length;
    const formFailures = results.cta_tests.forms.failed.length;
    
    if (results.cta_tests.phone_clicks.found > 0) {
      if (phoneFailures === results.cta_tests.phone_clicks.found) {
        results.issues.push(`❌ CRITICAL: All phone clicks not tracking (0/${results.cta_tests.phone_clicks.found})`);
      } else if (phoneFailures > 0) {
        results.issues.push(`⚠️  Some phone clicks not tracking (${results.cta_tests.phone_clicks.working}/${results.cta_tests.phone_clicks.found} working)`);
      }
    }
    
    if (results.cta_tests.email_clicks.found > 0) {
      if (emailFailures === results.cta_tests.email_clicks.found) {
        results.issues.push(`❌ CRITICAL: All email clicks not tracking (0/${results.cta_tests.email_clicks.found})`);
      } else if (emailFailures > 0) {
        results.issues.push(`⚠️  Some email clicks not tracking (${results.cta_tests.email_clicks.working}/${results.cta_tests.email_clicks.found} working)`);
      }
    }
    
    if (results.cta_tests.forms.found > 0) {
      if (formFailures === results.cta_tests.forms.found) {
        results.issues.push(`❌ CRITICAL: All forms not tracking (0/${results.cta_tests.forms.found})`);
      } else if (formFailures > 0) {
        results.issues.push(`⚠️  Some forms not tracking (${results.cta_tests.forms.working}/${results.cta_tests.forms.found} working)`);
      }
    }
    
    // Overall health status (CORRECTED LOGIC)
    const criticalIssues = results.issues.filter(i => i.includes('CRITICAL')).length;
    const warnings = results.issues.filter(i => i.includes('⚠️')).length;
    
    if (ctasWorking && ga4BeaconsExist) {
      results.overall_status = 'HEALTHY';
    } else if (ga4BeaconsExist && !ctasWorking) {
      results.overall_status = 'WARNING';
    } else if (criticalIssues > 0) {
      results.overall_status = 'FAILING';
    } else if (warnings > 0) {
      results.overall_status = 'WARNING';
    } else {
      results.overall_status = 'HEALTHY';
    }
   
  } catch (error) {
    console.log(`\n❌ Fatal error: ${error.message}`);
    console.log(error.stack);
    results.issues.push(`Fatal error: ${error.message}`);
    results.overall_status = 'ERROR';
  } finally {
    if (browser) {
      await browser.close().catch(e => console.log('Browser close error:', e.message));
    }
  }
 
  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Health check complete for: ${url}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n📊 SUMMARY:`);
  console.log(`   Overall Status: ${results.overall_status}`);
  console.log(`   Page Load Time: ${results.evidence.page_load_time_ms}ms`);
  console.log(`   Total Issues: ${results.issues.length}`);
  console.log(`\n🏷️  TAGS:`);
  console.log(`   GTM: ${results.tags_found.gtm.length} found, ${results.tags_firing.gtm_loaded ? 'loaded' : 'not loaded'}`);
  console.log(`   GA4: ${results.tags_found.ga4.length} found, ${results.tags_firing.ga4_loaded ? 'loaded' : 'not loaded'}, ${results.tags_firing.ga4_initialized ? 'configured' : 'not configured'}`);
  console.log(`   Total Beacons: ${results.evidence.all_beacons.length} (${results.tags_firing.ga4_hits} GA4, ${results.tags_firing.gtm_hits} GTM)`);
  console.log(`\n🎯 CTA TESTS:`);
  console.log(`   📞 Phone: ${results.cta_tests.phone_clicks.working}/${results.cta_tests.phone_clicks.found} working`);
  console.log(`   📧 Email: ${results.cta_tests.email_clicks.working}/${results.cta_tests.email_clicks.found} working`);
  console.log(`   📝 Forms: ${results.cta_tests.forms.working}/${results.cta_tests.forms.found} working`);
  
  if (results.issues.length > 0) {
    console.log(`\n⚠️  ISSUES FOUND:`);
    results.issues.forEach((issue, index) => {
      console.log(`   ${index + 1}. ${issue}`);
    });
  } else {
    console.log(`\n✅ No issues found - tracking looks healthy!`);
  }
  
  console.log('='.repeat(60) + '\n');
 
  return results;
}

module.exports = {
  trackingHealthCheckSite
};
