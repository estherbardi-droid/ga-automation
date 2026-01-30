// health-checker-improved.js
const { chromium } = require('playwright');

// Configuration constants for reliable testing
const CONFIG = {
  BROWSER_TIMEOUT: 90000,
  PAGE_LOAD_TIMEOUT: 60000,
  INITIAL_WAIT: 8000,        // Increased: Wait for tracking to fully initialize
  POST_CONSENT_WAIT: 3000,   // Wait after accepting cookies
  PRE_CLICK_WAIT: 1000,      // Wait before clicking elements
  POST_CLICK_WAIT: 4000,     // Increased: Wait for events to fire and beacons to send
  POST_HOVER_WAIT: 800,      // Wait after hovering
  FORM_FIELD_WAIT: 500,      // Wait between form field fills
  POST_SUBMIT_WAIT: 5000,    // Increased: Forms can take longer to process
  BEACON_BATCH_WAIT: 2000,   // Extra wait for batched GA4 beacons
  MAX_RETRIES: 3,            // Retry failed operations
  SCROLL_WAIT: 800           // Wait after scrolling
};

async function trackingHealthCheckSite(url) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Starting health check for: ${url}`);
  console.log('='.repeat(60));
  
  const browser = await chromium.launch({ 
    headless: true,
    timeout: CONFIG.BROWSER_TIMEOUT,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',  // Prevent crashes in limited memory
      '--disable-blink-features=AutomationControlled'  // Better stealth
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true  // Handle SSL cert issues
  });
  
  const page = await context.newPage();
  
  // Comprehensive results object
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
    warnings: [],
    critical_errors: [],
    evidence: {
      dataLayer_events: [],
      network_beacons: []
    }
  };
  
  // Track network requests with enhanced detail
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
        } catch (e) {
          // URL parsing failed, skip extraction
        }
      }
      
      networkBeacons.push({
        url: reqUrl,
        timestamp: new Date().toISOString(),
        type: reqUrl.includes('gtm.js') ? 'GTM' : reqUrl.includes('/g/collect') ? 'GA4' : 'Other',
        event_name: eventName,
        measurement_id: measurementId
      });
    }
  });

  // Also track failed requests
  page.on('requestfailed', request => {
    const reqUrl = request.url();
    if (reqUrl.includes('google-analytics.com') || reqUrl.includes('googletagmanager.com')) {
      results.warnings.push(`Failed request: ${reqUrl}`);
      console.log(`   ⚠️  Network request failed: ${reqUrl}`);
    }
  });

  try {
    // ============================================================
    // PHASE 1: LOAD PAGE & DETECT TAGS
    // ============================================================
    console.log('\n📍 PHASE 1: Loading page and detecting tags...');

    // Multi-strategy page load with retries
    let pageLoaded = false;
    let loadStrategy = '';
    
    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      try {
        console.log(`   Attempt ${attempt}/${CONFIG.MAX_RETRIES}...`);
        
        // Try network idle first (most reliable)
        if (attempt === 1) {
          await page.goto(url, { waitUntil: 'networkidle', timeout: CONFIG.PAGE_LOAD_TIMEOUT });
          loadStrategy = 'networkidle';
        }
        // Then try domcontentloaded
        else if (attempt === 2) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          loadStrategy = 'domcontentloaded';
        }
        // Last resort: commit
        else {
          await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
          loadStrategy = 'commit';
        }
        
        pageLoaded = true;
        console.log(`   ✅ Page loaded successfully (${loadStrategy})`);
        break;
      } catch (gotoError) {
        console.log(`   ⚠️  Load attempt ${attempt} failed: ${gotoError.message}`);
        if (attempt === CONFIG.MAX_RETRIES) {
          throw new Error(`Failed to load page after ${CONFIG.MAX_RETRIES} attempts: ${gotoError.message}`);
        }
      }
    }

    if (!pageLoaded) {
      throw new Error('Page failed to load');
    }

    // Extended wait for tracking initialization
    console.log(`   ⏳ Waiting ${CONFIG.INITIAL_WAIT}ms for tracking to initialize...`);
    await page.waitForTimeout(CONFIG.INITIAL_WAIT);

    // Scan for all tags on page with enhanced detection
    const tagData = await page.evaluate(() => {
      const tags = {
        gtm: [],
        ga4: [],
        aw: []
      };
      
      // Method 1: Check scripts
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
      
      // Method 2: Check window.dataLayer for config
      if (window.dataLayer) {
        window.dataLayer.forEach(item => {
          if (item['gtm.uniqueEventId']) {
            // GTM present
          }
          if (item[0] === 'config' && typeof item[1] === 'string') {
            if (item[1].startsWith('G-')) tags.ga4.push(item[1]);
            if (item[1].startsWith('GTM-')) tags.gtm.push(item[1]);
          }
        });
      }
      
      // Method 3: Check global objects
      const gtmLoaded = !!(window.google_tag_manager && Object.keys(window.google_tag_manager).length > 0);
      const ga4Loaded = !!(window.gtag || (window.dataLayer && window.dataLayer.length > 0));
      const dataLayerExists = !!window.dataLayer;
      
      return {
        gtm: [...new Set(tags.gtm)],
        ga4: [...new Set(tags.ga4)],
        aw: [...new Set(tags.aw)],
        gtmLoaded,
        ga4Loaded,
        dataLayerExists
      };
    });
    
    results.tags_found.gtm = tagData.gtm;
    results.tags_found.ga4 = tagData.ga4;
    results.tags_found.ignored_aw = tagData.aw;
    results.tags_firing.gtm_loaded = tagData.gtmLoaded;
    results.tags_firing.ga4_loaded = tagData.ga4Loaded;
    
    console.log(`\n📊 Tags detected:`);
    console.log(`   GTM Tags: ${tagData.gtm.length > 0 ? tagData.gtm.join(', ') : 'None'}`);
    console.log(`   GA4 Tags: ${tagData.ga4.length > 0 ? tagData.ga4.join(', ') : 'None'}`);
    console.log(`   AW Tags (ignored): ${tagData.aw.length}`);
    console.log(`   GTM Loaded: ${tagData.gtmLoaded ? '✅' : '❌'}`);
    console.log(`   GA4 Loaded: ${tagData.ga4Loaded ? '✅' : '❌'}`);
    console.log(`   DataLayer Exists: ${tagData.dataLayerExists ? '✅' : '❌'}`);
    
    // Wait for initial beacons to settle
    await page.waitForTimeout(CONFIG.BEACON_BATCH_WAIT);
    
    // ============================================================
    // PHASE 2: HANDLE COOKIE CONSENT
    // ============================================================
    console.log('\n🍪 PHASE 2: Checking for cookie consent banner...');
    
    try {
      // Expanded consent selectors with common patterns
      const consentSelectors = [
        // OneTrust
        '#onetrust-accept-btn-handler',
        '#accept-recommended-btn-handler',
        // Cookiebot
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        'a[id*="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll"]',
        // Generic patterns
        'button:has-text("Accept all")',
        'button:has-text("Accept All")',
        'button:has-text("Accept")',
        'button:has-text("I Accept")',
        'button:has-text("I agree")',
        'button:has-text("Agree")',
        'button:has-text("OK")',
        'button:has-text("Allow all")',
        'button:has-text("Allow All")',
        'a:has-text("Accept")',
        'a:has-text("Accept all")',
        // ID/Class patterns
        '[id*="accept"][role="button"]',
        '[class*="accept"][role="button"]',
        '[id*="cookie"][id*="accept"]',
        '[class*="cookie"][class*="accept"]',
        '.cookie-accept',
        '.accept-cookies',
        '#cookie-accept',
        'button.accept',
        // GDPR specific
        '[data-testid*="accept"]',
        '[aria-label*="Accept"]',
        '[aria-label*="accept"]'
      ];
      
      let consentButton = null;
      let foundSelector = '';
      
      for (const selector of consentSelectors) {
        try {
          const elements = await page.$$(selector);
          for (const element of elements) {
            const isVisible = await element.isVisible().catch(() => false);
            if (isVisible) {
              consentButton = element;
              foundSelector = selector;
              break;
            }
          }
          if (consentButton) break;
        } catch (e) {
          // Selector failed, try next
          continue;
        }
      }
      
      if (consentButton) {
        results.cookie_consent.banner_found = true;
        console.log(`   ✅ Found consent button: ${foundSelector}`);
        console.log('   👆 Clicking accept button...');
        
        try {
          await consentButton.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
          await consentButton.click({ timeout: 5000 });
          await page.waitForTimeout(CONFIG.POST_CONSENT_WAIT);
          results.cookie_consent.accepted = true;
          console.log('   ✅ Cookie consent accepted');
        } catch (clickError) {
          results.cookie_consent.error = `Failed to click: ${clickError.message}`;
          results.warnings.push(`Cookie consent found but click failed: ${clickError.message}`);
          console.log(`   ⚠️  Failed to click consent: ${clickError.message}`);
        }
      } else {
        console.log('   ℹ️  No cookie consent banner found (or already accepted)');
      }
    } catch (e) {
      results.cookie_consent.error = e.message;
      results.warnings.push(`Cookie consent handling error: ${e.message}`);
      console.log(`   ⚠️  Cookie consent error: ${e.message}`);
    }
    
    // Wait again after consent for tracking to reinitialize
    await page.waitForTimeout(CONFIG.BEACON_BATCH_WAIT);
    
    // ============================================================
    // PHASE 3: TEST CTAs (with dataLayer monitoring)
    // ============================================================
    console.log('\n🎯 PHASE 3: Testing CTAs and monitoring events...');
    
    // Enhanced dataLayer capture
    async function getDataLayerEvents() {
      return await page.evaluate(() => {
        if (window.dataLayer) {
          return window.dataLayer.map((item, index) => ({
            index,
            event: item.event || 'unknown',
            data: JSON.parse(JSON.stringify(item))  // Deep clone
          }));
        }
        return [];
      }).catch(err => {
        console.log(`   ⚠️  DataLayer read error: ${err.message}`);
        return [];
      });
    }
    
    // Helper function to perform click with retries
    async function reliableClick(element, elementDescription) {
      for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
        try {
          await element.scrollIntoViewIfNeeded({ timeout: 5000 });
          await page.waitForTimeout(CONFIG.SCROLL_WAIT);
          
          // Check if still visible
          const isVisible = await element.isVisible();
          if (!isVisible) {
            throw new Error('Element not visible after scroll');
          }
          
          // Hover first
          await element.hover({ timeout: 3000 });
          await page.waitForTimeout(CONFIG.POST_HOVER_WAIT);
          
          // Click
          await element.click({ timeout: 3000 });
          console.log(`      ✅ Successfully clicked ${elementDescription}`);
          return true;
        } catch (clickErr) {
          console.log(`      ⚠️  Click attempt ${attempt} failed: ${clickErr.message}`);
          if (attempt === CONFIG.MAX_RETRIES) {
            return false;
          }
          await page.waitForTimeout(1000);
        }
      }
      return false;
    }
    
    // --- TEST PHONE CLICKS ---
    console.log('\n📞 Testing phone clicks...');
    try {
      const phoneLinks = await page.$$('a[href^="tel:"]');
      results.cta_tests.phone_clicks.found = phoneLinks.length;
      
      if (phoneLinks.length > 0) {
        console.log(`   Found ${phoneLinks.length} phone link(s)`);
        
        for (let i = 0; i < Math.min(phoneLinks.length, 3); i++) {
          try {
            const link = phoneLinks[i];
            const href = await link.getAttribute('href').catch(() => 'unknown');
            const linkText = await link.textContent().catch(() => '');
            
            console.log(`   Testing phone link ${i + 1}: ${href} ("${linkText.trim()}")`);
            
            const beforeDataLayer = await getDataLayerEvents();
            const beforeBeacons = networkBeacons.length;
            
            await page.waitForTimeout(CONFIG.PRE_CLICK_WAIT);
            
            const clickSuccess = await reliableClick(link, 'phone link');
            
            if (!clickSuccess) {
              results.cta_tests.phone_clicks.failed.push({
                link: href,
                reason: 'Click failed after retries'
              });
              console.log(`      ❌ Failed to click phone link`);
              continue;
            }
            
            // Extended wait for events to fire
            await page.waitForTimeout(CONFIG.POST_CLICK_WAIT);
            
            // Extra wait for batched beacons
            await page.waitForTimeout(CONFIG.BEACON_BATCH_WAIT);
            
            const afterDataLayer = await getDataLayerEvents();
            const afterBeacons = networkBeacons.length;
            
            const newEvents = afterDataLayer.slice(beforeDataLayer.length);
            const newBeacons = afterBeacons - beforeBeacons;
            
            results.cta_tests.phone_clicks.tested++;
            
            if (newEvents.length > 0 || newBeacons > 0) {
              const dataLayerEvents = newEvents.map(e => e.event).filter(e => e !== 'unknown');
              const ga4BeaconEvents = networkBeacons.slice(beforeBeacons)
                .filter(b => b.event_name)
                .map(b => b.event_name);
              
              results.cta_tests.phone_clicks.events_fired.push({
                link: href,
                link_text: linkText.trim(),
                dataLayer_events: dataLayerEvents,
                ga4_events: ga4BeaconEvents,
                beacons: newBeacons,
                full_events: newEvents
              });
              
              if (ga4BeaconEvents.length > 0) {
                console.log(`      ✅ GA4 Events: ${ga4BeaconEvents.join(', ')}`);
              } else if (dataLayerEvents.length > 0) {
                console.log(`      ⚠️  DataLayer events: ${dataLayerEvents.join(', ')} (no GA4 beacon detected)`);
                results.warnings.push(`Phone click ${href} pushed to dataLayer but no GA4 beacon seen`);
              } else {
                console.log(`      ⚠️  Network activity detected but no clear events`);
              }
            } else {
              results.cta_tests.phone_clicks.failed.push({
                link: href,
                reason: 'No tracking events detected'
              });
              console.log(`      ❌ No tracking fired`);
            }
          } catch (linkErr) {
            console.log(`      ❌ Error testing phone link ${i + 1}: ${linkErr.message}`);
            results.warnings.push(`Phone link test ${i + 1} error: ${linkErr.message}`);
          }
        }
      } else {
        console.log('   ℹ️  No phone links found');
      }
    } catch (e) {
      const errorMsg = `Phone test critical error: ${e.message}`;
      console.log(`   ❌ ${errorMsg}`);
      results.critical_errors.push(errorMsg);
    }

    // --- TEST EMAIL CLICKS ---
    console.log('\n📧 Testing email clicks...');
    try {
      const emailLinks = await page.$$('a[href^="mailto:"]');
      results.cta_tests.email_clicks.found = emailLinks.length;
      
      if (emailLinks.length > 0) {
        console.log(`   Found ${emailLinks.length} email link(s)`);
        
        for (let i = 0; i < Math.min(emailLinks.length, 3); i++) {
          try {
            const link = emailLinks[i];
            const href = await link.getAttribute('href').catch(() => 'unknown');
            const linkText = await link.textContent().catch(() => '');
            
            console.log(`   Testing email link ${i + 1}: ${href} ("${linkText.trim()}")`);
            
            const beforeDataLayer = await getDataLayerEvents();
            const beforeBeacons = networkBeacons.length;
            
            await page.waitForTimeout(CONFIG.PRE_CLICK_WAIT);
            
            const clickSuccess = await reliableClick(link, 'email link');
            
            if (!clickSuccess) {
              results.cta_tests.email_clicks.failed.push({
                link: href,
                reason: 'Click failed after retries'
              });
              console.log(`      ❌ Failed to click email link`);
              continue;
            }
            
            await page.waitForTimeout(CONFIG.POST_CLICK_WAIT);
            await page.waitForTimeout(CONFIG.BEACON_BATCH_WAIT);
            
            const afterDataLayer = await getDataLayerEvents();
            const afterBeacons = networkBeacons.length;
            
            const newEvents = afterDataLayer.slice(beforeDataLayer.length);
            const newBeacons = afterBeacons - beforeBeacons;
            
            results.cta_tests.email_clicks.tested++;
            
            if (newEvents.length > 0 || newBeacons > 0) {
              const dataLayerEvents = newEvents.map(e => e.event).filter(e => e !== 'unknown');
              const ga4BeaconEvents = networkBeacons.slice(beforeBeacons)
                .filter(b => b.event_name)
                .map(b => b.event_name);
              
              results.cta_tests.email_clicks.events_fired.push({
                link: href,
                link_text: linkText.trim(),
                dataLayer_events: dataLayerEvents,
                ga4_events: ga4BeaconEvents,
                beacons: newBeacons,
                full_events: newEvents
              });
              
              if (ga4BeaconEvents.length > 0) {
                console.log(`      ✅ GA4 Events: ${ga4BeaconEvents.join(', ')}`);
              } else if (dataLayerEvents.length > 0) {
                console.log(`      ⚠️  DataLayer events: ${dataLayerEvents.join(', ')} (no GA4 beacon detected)`);
                results.warnings.push(`Email click ${href} pushed to dataLayer but no GA4 beacon seen`);
              } else {
                console.log(`      ⚠️  Network activity detected but no clear events`);
              }
            } else {
              results.cta_tests.email_clicks.failed.push({
                link: href,
                reason: 'No tracking events detected'
              });
              console.log(`      ❌ No tracking fired`);
            }
          } catch (linkErr) {
            console.log(`      ❌ Error testing email link ${i + 1}: ${linkErr.message}`);
            results.warnings.push(`Email link test ${i + 1} error: ${linkErr.message}`);
          }
        }
      } else {
        console.log('   ℹ️  No email links found');
      }
    } catch (e) {
      const errorMsg = `Email test critical error: ${e.message}`;
      console.log(`   ❌ ${errorMsg}`);
      results.critical_errors.push(errorMsg);
    }

    // --- TEST FORMS ---
    console.log('\n📝 Testing forms...');
    try {
      const forms = await page.$$('form');
      results.cta_tests.forms.found = forms.length;
      
      if (forms.length > 0) {
        console.log(`   Found ${forms.length} form(s)`);
        
        for (let i = 0; i < Math.min(forms.length, 2); i++) {
          try {
            const form = forms[i];
            console.log(`   Testing form ${i + 1}...`);
            
            // Scroll form into view
            await form.scrollIntoViewIfNeeded({ timeout: 5000 });
            await page.waitForTimeout(CONFIG.SCROLL_WAIT);
            
            const beforeDataLayer = await getDataLayerEvents();
            const beforeBeacons = networkBeacons.length;
            
            // Find and fill inputs with improved detection
            const inputs = await form.$$('input, textarea, select');
            console.log(`      Form has ${inputs.length} field(s)`);
            
            let filledFields = 0;
            for (const input of inputs) {
              try {
                const inputType = await input.getAttribute('type').catch(() => 'text');
                const inputName = await input.getAttribute('name').catch(() => '');
                const inputId = await input.getAttribute('id').catch(() => '');
                const inputRequired = await input.getAttribute('required').catch(() => null);
                const isVisible = await input.isVisible().catch(() => false);
                
                if (!isVisible) continue;  // Skip hidden fields
                
                // Scroll to field
                await input.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
                await page.waitForTimeout(CONFIG.FORM_FIELD_WAIT);
                
                // Determine what to fill
                const fieldIdentifier = `${inputType}|${inputName}|${inputId}`.toLowerCase();
                
                if (inputType === 'email' || fieldIdentifier.includes('email')) {
                  await input.fill('test@example.com', { timeout: 3000 });
                  filledFields++;
                } else if (inputType === 'tel' || fieldIdentifier.includes('phone') || fieldIdentifier.includes('tel')) {
                  await input.fill('1234567890', { timeout: 3000 });
                  filledFields++;
                } else if (inputType === 'text' || inputType === 'textarea' || !inputType) {
                  if (fieldIdentifier.includes('name')) {
                    await input.fill('Test User', { timeout: 3000 });
                  } else if (fieldIdentifier.includes('message') || fieldIdentifier.includes('comment')) {
                    await input.fill('This is a test message', { timeout: 3000 });
                  } else {
                    await input.fill('Test Input', { timeout: 3000 });
                  }
                  filledFields++;
                } else if (inputType === 'checkbox' && !inputRequired) {
                  // Only check non-required checkboxes (avoid T&Cs)
                  await input.check({ timeout: 3000 });
                  filledFields++;
                } else if (inputType === 'radio') {
                  await input.check({ timeout: 3000 });
                  filledFields++;
                }
                
                await page.waitForTimeout(CONFIG.FORM_FIELD_WAIT);
              } catch (fillError) {
                // Skip fields that can't be filled
                console.log(`      ⚠️  Could not fill field: ${fillError.message}`);
              }
            }
            
            console.log(`      ✅ Filled ${filledFields} field(s)`);
            
            // Find submit button with multiple strategies
            let submitBtn = null;
            const submitSelectors = [
              'button[type="submit"]',
              'input[type="submit"]',
              'button:has-text("Submit")',
              'button:has-text("Send")',
              'button:has-text("Send message")',
              'button:has-text("Get in touch")',
              'button:has-text("Contact us")',
              'input[value*="Submit"]',
              'input[value*="Send"]'
            ];
            
            for (const selector of submitSelectors) {
              try {
                const btn = await form.$(selector);
                if (btn) {
                  const isVisible = await btn.isVisible().catch(() => false);
                  if (isVisible) {
                    submitBtn = btn;
                    break;
                  }
                }
              } catch (e) {
                continue;
              }
            }
            
            if (submitBtn) {
              console.log('      👆 Clicking submit button...');
              
              const submitSuccess = await reliableClick(submitBtn, 'submit button');
              
              if (!submitSuccess) {
                results.cta_tests.forms.failed.push({
                  form_index: i + 1,
                  reason: 'Submit button click failed'
                });
                console.log(`      ❌ Failed to click submit button`);
                continue;
              }
              
              await page.waitForTimeout(CONFIG.POST_SUBMIT_WAIT);
              await page.waitForTimeout(CONFIG.BEACON_BATCH_WAIT);
              
              const afterDataLayer = await getDataLayerEvents();
              const afterBeacons = networkBeacons.length;
              
              const newEvents = afterDataLayer.slice(beforeDataLayer.length);
              const newBeacons = afterBeacons - beforeBeacons;
              
              results.cta_tests.forms.tested++;
              
              if (newEvents.length > 0 || newBeacons > 0) {
                const dataLayerEvents = newEvents.map(e => e.event).filter(e => e !== 'unknown');
                const ga4BeaconEvents = networkBeacons.slice(beforeBeacons)
                  .filter(b => b.event_name)
                  .map(b => b.event_name);
                
                results.cta_tests.forms.events_fired.push({
                  form_index: i + 1,
                  fields_filled: filledFields,
                  dataLayer_events: dataLayerEvents,
                  ga4_events: ga4BeaconEvents,
                  beacons: newBeacons,
                  full_events: newEvents
                });
                
                if (ga4BeaconEvents.length > 0) {
                  console.log(`      ✅ GA4 Events: ${ga4BeaconEvents.join(', ')}`);
                } else if (dataLayerEvents.length > 0) {
                  console.log(`      ⚠️  DataLayer events: ${dataLayerEvents.join(', ')} (no GA4 beacon detected)`);
                  results.warnings.push(`Form ${i + 1} submission pushed to dataLayer but no GA4 beacon seen`);
                } else {
                  console.log(`      ⚠️  Network activity detected but no clear events`);
                }
              } else {
                results.cta_tests.forms.failed.push({
                  form_index: i + 1,
                  reason: 'No tracking events detected',
                  fields_filled: filledFields
                });
                console.log(`      ❌ No tracking fired`);
              }
            } else {
              console.log('      ⚠️  No submit button found');
              results.warnings.push(`Form ${i + 1}: No submit button found`);
            }
          } catch (formErr) {
            console.log(`      ❌ Error testing form ${i + 1}: ${formErr.message}`);
            results.warnings.push(`Form test ${i + 1} error: ${formErr.message}`);
          }
        }
      } else {
        console.log('   ℹ️  No forms found');
      }
    } catch (e) {
      const errorMsg = `Form test critical error: ${e.message}`;
      console.log(`   ❌ ${errorMsg}`);
      results.critical_errors.push(errorMsg);
    }

    // Count final hits
    results.tags_firing.gtm_hits = networkBeacons.filter(b => b.type === 'GTM').length;
    results.tags_firing.ga4_hits = networkBeacons.filter(b => b.type === 'GA4').length;

    // ============================================================
    // PHASE 4: COLLECT ISSUES
    // ============================================================
    console.log('\n📋 PHASE 4: Analyzing results...');
    
    // Tag detection issues
    if (results.tags_found.gtm.length === 0 && results.tags_found.ga4.length === 0) {
      results.issues.push('❌ CRITICAL: No GTM or GA4 tags found on page');
    } else {
      if (results.tags_found.gtm.length === 0) {
        results.issues.push('No GTM tags found');
      }
      if (results.tags_found.ga4.length === 0) {
        results.issues.push('No GA4 tags found');
      }
    }
    
    // Tag loading issues
    if (results.tags_found.gtm.length > 0 && !results.tags_firing.gtm_loaded) {
      results.issues.push('❌ GTM tags found in code but GTM object not loaded');
    }
    if (results.tags_found.ga4.length > 0 && !results.tags_firing.ga4_loaded) {
      results.issues.push('❌ GA4 tags found in code but GA4/dataLayer not initialized');
    }
    
    // Beacon firing issues
    if (results.tags_firing.gtm_loaded && results.tags_firing.gtm_hits === 0) {
      results.issues.push('⚠️  GTM loaded but no GTM network requests detected');
    }
    if (results.tags_firing.ga4_loaded && results.tags_firing.ga4_hits === 0) {
      results.issues.push('⚠️  GA4 loaded but no GA4 network requests detected');
    }
    
    // CTA tracking issues
    if (results.cta_tests.phone_clicks.found > 0) {
      const failedCount = results.cta_tests.phone_clicks.failed.length;
      const testedCount = results.cta_tests.phone_clicks.tested;
      if (failedCount > 0) {
        results.issues.push(`❌ ${failedCount}/${testedCount} phone click(s) not tracking properly`);
      }
    }
    
    if (results.cta_tests.email_clicks.found > 0) {
      const failedCount = results.cta_tests.email_clicks.failed.length;
      const testedCount = results.cta_tests.email_clicks.tested;
      if (failedCount > 0) {
        results.issues.push(`❌ ${failedCount}/${testedCount} email click(s) not tracking properly`);
      }
    }
    
    if (results.cta_tests.forms.found > 0) {
      const failedCount = results.cta_tests.forms.failed.length;
      const testedCount = results.cta_tests.forms.tested;
      if (failedCount > 0) {
        results.issues.push(`❌ ${failedCount}/${testedCount} form(s) not tracking properly`);
      }
    }
    
    // Cookie consent issues
    if (results.cookie_consent.banner_found && !results.cookie_consent.accepted) {
      results.issues.push('⚠️  Cookie consent banner found but could not accept it');
    }
    
    results.evidence.network_beacons = networkBeacons;
    
  } catch (error) {
    const criticalError = `FATAL ERROR: ${error.message}`;
    console.log(`\n❌ ${criticalError}`);
    results.critical_errors.push(criticalError);
    results.issues.push(criticalError);
  } finally {
    await browser.close();
  }
  
  // ============================================================
  // FINAL SUMMARY
  // ============================================================
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Health check complete for: ${url}`);
  console.log('='.repeat(60));
  console.log(`\n📊 SUMMARY:`);
  console.log(`   Critical Errors: ${results.critical_errors.length}`);
  console.log(`   Issues: ${results.issues.length}`);
  console.log(`   Warnings: ${results.warnings.length}`);
  console.log(`\n🏷️  TAGS:`);
  console.log(`   GTM tags: ${results.tags_found.gtm.length} (loaded: ${results.tags_firing.gtm_loaded ? 'Yes' : 'No'})`);
  console.log(`   GA4 tags: ${results.tags_found.ga4.length} (loaded: ${results.tags_firing.ga4_loaded ? 'Yes' : 'No'})`);
  console.log(`   GTM hits: ${results.tags_firing.gtm_hits}`);
  console.log(`   GA4 hits: ${results.tags_firing.ga4_hits}`);
  console.log(`\n🎯 CTA TESTS:`);
  console.log(`   Phone: ${results.cta_tests.phone_clicks.tested}/${results.cta_tests.phone_clicks.found} tested (${results.cta_tests.phone_clicks.failed.length} failed)`);
  console.log(`   Email: ${results.cta_tests.email_clicks.tested}/${results.cta_tests.email_clicks.found} tested (${results.cta_tests.email_clicks.failed.length} failed)`);
  console.log(`   Forms: ${results.cta_tests.forms.tested}/${results.cta_tests.forms.found} tested (${results.cta_tests.forms.failed.length} failed)`);
  
  if (results.issues.length > 0) {
    console.log(`\n⚠️  ISSUES DETECTED:`);
    results.issues.forEach((issue, idx) => {
      console.log(`   ${idx + 1}. ${issue}`);
    });
  }
  
  if (results.warnings.length > 0) {
    console.log(`\n⚠️  WARNINGS:`);
    results.warnings.forEach((warning, idx) => {
      console.log(`   ${idx + 1}. ${warning}`);
    });
  }
  
  console.log('='.repeat(60) + '\n');
  
  return results;
}

module.exports = {
  trackingHealthCheckSite
};