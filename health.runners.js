// health.runners.js
const { chromium } = require('playwright');

async function trackingHealthCheckSite(url) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 Starting health check for: ${url}`);
  console.log('='.repeat(60));
  
  const browser = await chromium.launch({ 
  headless: false,  // Set to true for production
  timeout: 90000,
  args: ['--no-sandbox', '--disable-setuid-sandbox']  // Helps with stability
});

  const context = await browser.newContext();
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
      gtm_hits: 0,
      ga4_hits: 0
    },
    cookie_consent: {
      banner_found: false,
      accepted: false
    },
    cta_tests: {
      phone_clicks: { found: 0, tested: 0, events_fired: [], failed: [] },
      email_clicks: { found: 0, tested: 0, events_fired: [], failed: [] },
      forms: { found: 0, tested: 0, events_fired: [], failed: [] }
    },
    issues: [],
    evidence: {
      dataLayer_events: [],
      network_beacons: []
    }
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
    // Extract event name from GA4 collect requests
    let eventName = null;
    if (reqUrl.includes('/g/collect') || reqUrl.includes('/r/collect')) {
      const urlObj = new URL(reqUrl);
      eventName = urlObj.searchParams.get('en'); // 'en' parameter = event name
    }
    
    networkBeacons.push({
      url: reqUrl,
      timestamp: new Date().toISOString(),
      type: reqUrl.includes('gtm.js') ? 'GTM' : reqUrl.includes('/g/collect') ? 'GA4' : 'Other',
      event_name: eventName  // GA4 event name from the beacon
    });
  }
});


  try {
    // ============================================================
    // PHASE 1: LOAD PAGE & DETECT TAGS
    // ============================================================
    console.log('\n📍 PHASE 1: Loading page and detecting tags...');

// Try loading with different strategies
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('   Page loaded (DOM ready)');
} catch (gotoError) {
  console.log(`   ⚠️  Initial load timeout, trying simpler load...`);
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    console.log('   Page committed (basic load)');
  } catch (retryError) {
    throw new Error(`Could not load page: ${retryError.message}`);
  }
}

await page.waitForTimeout(5000);  // Give tracking more time to initialize
console.log('   Waiting for tracking to initialize...');

    // Scan for all tags on page
    const tagData = await page.evaluate(() => {
      const tags = {
        gtm: [],
        ga4: [],
        aw: []
      };
      
      // Find GTM tags
      const scripts = Array.from(document.querySelectorAll('script'));
      scripts.forEach(script => {
        const content = script.innerHTML + (script.src || '');
        
        // GTM tags
        const gtmMatches = content.match(/GTM-[A-Z0-9]+/g);
        if (gtmMatches) tags.gtm.push(...gtmMatches);
        
        // GA4 tags
        const ga4Matches = content.match(/G-[A-Z0-9]+/g);
        if (ga4Matches) tags.ga4.push(...ga4Matches);
        
        // AW tags (to ignore)
        const awMatches = content.match(/AW-[A-Z0-9]+/g);
        if (awMatches) tags.aw.push(...awMatches);
      });
      
      // Check if GTM/GA4 actually loaded
      const gtmLoaded = !!window.google_tag_manager;
      const ga4Loaded = !!window.gtag || !!window.dataLayer;
      
      return {
        gtm: [...new Set(tags.gtm)],
        ga4: [...new Set(tags.ga4)],
        aw: [...new Set(tags.aw)],
        gtmLoaded,
        ga4Loaded
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
    
    // Count hits
    results.tags_firing.gtm_hits = networkBeacons.filter(b => b.type === 'GTM').length;
    results.tags_firing.ga4_hits = networkBeacons.filter(b => b.type === 'GA4').length;
    
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
        'a:has-text("Accept")',
        '[id*="accept"][role="button"]',
        '[class*="accept"][role="button"]',
        '[id*="cookie"] button:has-text("Accept")',
        '#onetrust-accept-btn-handler',
        '.cookie-accept',
        '.accept-cookies'
      ];
      
      let consentButton = null;
      for (const selector of consentSelectors) {
        consentButton = await page.$(selector);
        if (consentButton) {
          const isVisible = await consentButton.isVisible();
          if (isVisible) {
            console.log(`   Found consent button: ${selector}`);
            break;
          }
        }
      }
      
      if (consentButton) {
        results.cookie_consent.banner_found = true;
        console.log('   👆 Clicking accept button...');
        await consentButton.click();
        await page.waitForTimeout(2000);
        results.cookie_consent.accepted = true;
        console.log('   ✅ Cookie consent accepted');
      } else {
        console.log('   ℹ️  No cookie consent banner found (or already accepted)');
      }
    } catch (e) {
      console.log(`   ⚠️  Cookie consent error: ${e.message}`);
    }
    
    // ============================================================
    // PHASE 3: TEST CTAs (with dataLayer monitoring)
    // ============================================================
    console.log('\n🎯 PHASE 3: Testing CTAs and monitoring events...');
    
    // Function to capture dataLayer snapshot
    async function getDataLayerEvents() {
      return await page.evaluate(() => {
        if (window.dataLayer) {
          return window.dataLayer.map((item, index) => ({
            index,
            event: item.event || 'unknown',
            data: item
          }));
        }
        return [];
      });
    }
    
    // --- TEST PHONE CLICKS ---
    console.log('\n📞 Testing phone clicks...');
    try {
      const phoneLinks = await page.$$('a[href^="tel:"]');
      results.cta_tests.phone_clicks.found = phoneLinks.length;
      
      if (phoneLinks.length > 0) {
        console.log(`   Found ${phoneLinks.length} phone link(s)`);
        
        for (let i = 0; i < Math.min(phoneLinks.length, 3); i++) {
          const link = phoneLinks[i];
          const href = await link.getAttribute('href');
          
          console.log(`   Testing phone link ${i + 1}: ${href}`);
          
          const beforeDataLayer = await getDataLayerEvents();
          const beforeBeacons = networkBeacons.length;
          
          await link.scrollIntoViewIfNeeded();
          await link.click({ force: true });
          await page.waitForTimeout(2000);
          
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
    dataLayer_events: dataLayerEvents,
    ga4_events: ga4BeaconEvents,
    beacons: newBeacons
  });
  
  if (ga4BeaconEvents.length > 0) {
    console.log(`      ✅ GA4 Events: ${ga4BeaconEvents.join(', ')}`);
  } else {
    console.log(`      ⚠️  DataLayer events: ${dataLayerEvents.join(', ')} (no GA4 event fired)`);
  }
} else {
            results.cta_tests.phone_clicks.failed.push(href);
            console.log(`      ❌ No tracking fired`);
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
  const emailLinks = await page.$$('a[href^="mailto:"]');
  results.cta_tests.email_clicks.found = emailLinks.length;
  
  if (emailLinks.length > 0) {
    console.log(`   Found ${emailLinks.length} email link(s)`);
    
    for (let i = 0; i < Math.min(emailLinks.length, 3); i++) {
      const link = emailLinks[i];
      const href = await link.getAttribute('href');
      
      console.log(`   Testing email link ${i + 1}: ${href}`);
      
      const beforeDataLayer = await getDataLayerEvents();
      const beforeBeacons = networkBeacons.length;
      
      await link.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);  // ← ADD THIS: Wait after scrolling
      
      // Hover first to trigger any hover-based listeners
      await link.hover();
      await page.waitForTimeout(500);  // ← ADD THIS: Wait after hover
      
      await link.click({ force: true });
      await page.waitForTimeout(3000);  // ← INCREASE THIS: Was 2000, now 3000
      
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
          dataLayer_events: dataLayerEvents,
          ga4_events: ga4BeaconEvents,
          beacons: newBeacons
        });
        
        if (ga4BeaconEvents.length > 0) {
          console.log(`      ✅ GA4 Events: ${ga4BeaconEvents.join(', ')}`);
        } else {
          console.log(`      ⚠️  DataLayer events: ${dataLayerEvents.join(', ')} (no GA4 event fired)`);
        }
      } else {
        results.cta_tests.email_clicks.failed.push(href);
        console.log(`      ❌ No tracking fired`);
      }
    }
  } else {
    console.log('   ℹ️  No email links found');
  }
} catch (e) {
  console.log(`   ⚠️  Email test error: ${e.message}`);
}


   -
    // --- TEST FORMS ---
console.log('\n📝 Testing forms...');
try {
  const forms = await page.$$('form');
  results.cta_tests.forms.found = forms.length;
  
  if (forms.length > 0) {
    console.log(`   Found ${forms.length} form(s)`);
    
    for (let i = 0; i < Math.min(forms.length, 2); i++) {
      const form = forms[i];
      console.log(`   Testing form ${i + 1}...`);
      
      const beforeDataLayer = await getDataLayerEvents();
      const beforeBeacons = networkBeacons.length;
      
      // Find and fill inputs
      const inputs = await form.$$('input, textarea, select');
      console.log(`      Form has ${inputs.length} field(s)`);
      
      for (const input of inputs) {
        try {
          const inputType = await input.getAttribute('type');
          const inputName = await input.getAttribute('name');
          
          if (inputType === 'email' || inputName?.includes('email')) {
            await input.fill('test@example.com');
          } else if (inputType === 'tel' || inputName?.includes('phone')) {
            await input.fill('1234567890');
          } else if (inputType === 'text' || inputType === 'textarea' || !inputType) {
            await input.fill('Test User');
          } else if (inputType === 'checkbox') {
            await input.check();
          }
          await page.waitForTimeout(300);
        } catch (fillError) {
          // Skip fields that can't be filled
        }
      }
      
      // Find and click submit
      const submitBtn = await form.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send")');
      
      if (submitBtn) {
        console.log('      👆 Clicking submit...');
        await submitBtn.click();
        await page.waitForTimeout(4000);
        
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
            dataLayer_events: dataLayerEvents,
            ga4_events: ga4BeaconEvents,
            beacons: newBeacons
          });
          
          if (ga4BeaconEvents.length > 0) {
            console.log(`      ✅ GA4 Events: ${ga4BeaconEvents.join(', ')}`);
          } else {
            console.log(`      ⚠️  DataLayer events: ${dataLayerEvents.join(', ')} (no GA4 event fired)`);
          }
        } else {
          results.cta_tests.forms.failed.push(`Form ${i + 1}`);
          console.log(`      ❌ No tracking fired`);
        }
      } else {
        console.log('      ⚠️  No submit button found');
      }
    }
  } else {
    console.log('   ℹ️  No forms found');
  }
} catch (e) {
  console.log(`   ⚠️  Form test error: ${e.message}`);
}



    // ============================================================
    // PHASE 4: COLLECT ISSUES
    // ============================================================
    console.log('\n📋 PHASE 4: Analyzing results...');
    
    if (results.tags_found.gtm.length === 0) {
      results.issues.push('No GTM tags found');
    }
    if (results.tags_found.ga4.length === 0) {
      results.issues.push('No GA4 tags found');
    }
    if (results.tags_found.gtm.length > 0 && !results.tags_firing.gtm_loaded) {
      results.issues.push('GTM tags found but not loading');
    }
    if (results.tags_found.ga4.length > 0 && !results.tags_firing.ga4_loaded) {
      results.issues.push('GA4 tags found but not loading');
    }
    if (results.cta_tests.phone_clicks.found > 0 && results.cta_tests.phone_clicks.failed.length > 0) {
      results.issues.push(`${results.cta_tests.phone_clicks.failed.length} phone click(s) not tracking`);
    }
    if (results.cta_tests.email_clicks.found > 0 && results.cta_tests.email_clicks.failed.length > 0) {
      results.issues.push(`${results.cta_tests.email_clicks.failed.length} email click(s) not tracking`);
    }
    if (results.cta_tests.forms.found > 0 && results.cta_tests.forms.failed.length > 0) {
      results.issues.push(`${results.cta_tests.forms.failed.length} form(s) not tracking`);
    }
    
    results.evidence.network_beacons = networkBeacons;
    
  } catch (error) {
    console.log(`\n❌ Fatal error: ${error.message}`);
    results.issues.push(`Error: ${error.message}`);
  } finally {
    await browser.close();
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ Health check complete for: ${url}`);
  console.log(`   Total issues: ${results.issues.length}`);
  console.log(`   GTM tags: ${results.tags_found.gtm.length}`);
  console.log(`   GA4 tags: ${results.tags_found.ga4.length}`);
  console.log(`   Phone clicks tested: ${results.cta_tests.phone_clicks.tested}/${results.cta_tests.phone_clicks.found}`);
  console.log(`   Email clicks tested: ${results.cta_tests.email_clicks.tested}/${results.cta_tests.email_clicks.found}`);
  console.log(`   Forms tested: ${results.cta_tests.forms.tested}/${results.cta_tests.forms.found}`);
  console.log('='.repeat(60) + '\n');
  
  return results;
}

module.exports = {
  trackingHealthCheckSite
};