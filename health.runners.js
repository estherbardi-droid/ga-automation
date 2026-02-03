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
    overall_status: 'HEALTHY',
    tracking: {
      gtm_found: false,
      ga4_found: false,
      gtm_working: false,
      ga4_working: false,
      gtm_ids: [],
      ga4_ids: []
    },
    ctas: {
      phone: {
        total_found: 0,
        total_tested: 0,
        working: 0,
        broken: 0,
        broken_details: []
      },
      email: {
        total_found: 0,
        total_tested: 0,
        working: 0,
        broken: 0,
        broken_details: []
      },
      forms: {
        total_found: 0,
        total_tested: 0,
        working: 0,
        broken: 0,
        broken_details: []
      }
    },
    issues: [],
    summary: ''
  };
 
  // Track ALL network requests
  const allBeacons = [];
  page.on('request', request => {
    const reqUrl = request.url();
    
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
      
      if (reqUrl.includes('/g/collect') || reqUrl.includes('/r/collect') || reqUrl.includes('/j/collect')) {
        try {
          const urlObj = new URL(reqUrl);
          eventName = urlObj.searchParams.get('en');
          measurementId = urlObj.searchParams.get('tid');
          beaconType = 'GA4';
        } catch (e) {
          // Silent fail
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
  const MAX_RUNTIME = 10 * 60 * 1000; // 10 minutes max

  // Event name patterns for different CTA types
  const PHONE_EVENT_PATTERNS = [
    'click_call', 'call_click', 'phone_click', 'click_phone',
    'click_line', 'click_tel', 'tel_click', 'call', 'phone'
  ];
  
  const EMAIL_EVENT_PATTERNS = [
    'click_email', 'email_click', 'mailto_click', 'click_mail',
    'mail_click', 'email', 'mailto'
  ];
  
  const FORM_EVENT_PATTERNS = [
    'form_submit', 'submit_form', 'form_submission', 'contact_form',
    'generate_lead', 'lead_form', 'form_complete', 'form_success',
    'submit', 'contact', 'enquiry', 'quote_form'
  ];

  // Generic events to IGNORE (not CTA-specific)
  const IGNORE_EVENT_PATTERNS = [
    'page_view', 'scroll', 'user_engagement', 'session_start',
    'first_visit', 'gtm.', 'view_', 'click' // Just "click" alone is too generic
  ];

  // Helper: Check if event matches pattern
  function matchesEventPattern(eventName, patterns) {
    if (!eventName) return false;
    const lowerEvent = eventName.toLowerCase();
    return patterns.some(pattern => lowerEvent.includes(pattern.toLowerCase()));
  }

  // Helper: Check if event is relevant (not generic)
  function isRelevantEvent(eventName, relevantPatterns) {
    if (!eventName) return false;
    
    // Must match our relevant patterns
    if (!matchesEventPattern(eventName, relevantPatterns)) {
      return false;
    }
    
    // Must NOT be a generic event (except if it's a very specific match)
    // For example: "click_call" is fine even though it contains "click"
    for (const ignorePattern of IGNORE_EVENT_PATTERNS) {
      const lowerEvent = eventName.toLowerCase();
      const lowerIgnore = ignorePattern.toLowerCase();
      
      // If event is EXACTLY the ignore pattern, exclude it
      if (lowerEvent === lowerIgnore) {
        return false;
      }
      
      // If event is ONLY the ignore pattern (no other text), exclude it
      if (lowerEvent === lowerIgnore.replace('.', '')) {
        return false;
      }
    }
    
    return true;
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
      console.log(`   ⚠️  Timeout, trying simpler load...`);
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
        console.log('   ✅ Page loaded (basic)');
      } catch (retryError) {
        throw new Error(`Could not load page: ${retryError.message}`);
      }
    }

    console.log('   ⏳ Waiting for tracking (5s)...');
    await page.waitForTimeout(5000);

    // Detect tags
    const tagData = await page.evaluate(() => {
      const tags = { gtm: [], ga4: [], aw: [] };
     
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
     
      const noscripts = Array.from(document.querySelectorAll('noscript'));
      noscripts.forEach(ns => {
        const gtmMatches = ns.innerHTML.match(/GTM-[A-Z0-9]+/g);
        if (gtmMatches) tags.gtm.push(...gtmMatches);
      });
     
      const gtmLoaded = !!window.google_tag_manager;
      const ga4Loaded = !!(window.gtag || window.dataLayer?.some(e => 
        e.event === 'gtm.js' || e['gtm.uniqueEventId'] !== undefined
      ));
     
      return {
        gtm: [...new Set(tags.gtm)],
        ga4: [...new Set(tags.ga4)],
        gtmLoaded,
        ga4Loaded
      };
    });
   
    results.tracking.gtm_found = tagData.gtm.length > 0;
    results.tracking.ga4_found = tagData.ga4.length > 0;
    results.tracking.gtm_ids = tagData.gtm;
    results.tracking.ga4_ids = tagData.ga4;
    results.tracking.gtm_working = tagData.gtmLoaded;
    results.tracking.ga4_working = tagData.ga4Loaded;
   
    console.log(`\n📊 Tags:`);
    console.log(`   GTM: ${tagData.gtm.length > 0 ? '✅ ' + tagData.gtm.join(', ') : '❌ Not found'}`);
    console.log(`   GA4: ${tagData.ga4.length > 0 ? '✅ ' + tagData.ga4.join(', ') : '❌ Not found'}`);
   
    // Critical issue: No tracking tags
    if (!results.tracking.gtm_found && !results.tracking.ga4_found) {
      results.issues.push('❌ CRITICAL: No tracking tags found on site');
      results.overall_status = 'FAILING';
    }
   
    // ============================================================
    // PHASE 2: HANDLE COOKIE CONSENT
    // ============================================================
    console.log('\n🍪 PHASE 2: Cookie consent...');
   
    try {
      const consentSelectors = [
        'button:has-text("Accept")', 'button:has-text("Accept All")',
        'button:has-text("I Accept")', 'button:has-text("OK")',
        'button:has-text("Agree")', 'button:has-text("Allow")',
        '#onetrust-accept-btn-handler', '.cookie-accept'
      ];
     
      let consentButton = null;
      for (const selector of consentSelectors) {
        try {
          consentButton = await page.$(selector);
          if (consentButton && await consentButton.isVisible()) {
            console.log(`   ✅ Found consent button`);
            break;
          }
        } catch (e) {
          // Continue
        }
      }
     
      if (consentButton) {
        try {
          await consentButton.click({ timeout: 5000 });
          console.log('   👆 Accepted cookies');
          await page.waitForTimeout(2000);
        } catch (e) {
          await consentButton.click({ force: true });
          await page.waitForTimeout(2000);
        }
      } else {
        console.log('   ℹ️  No consent banner');
      }
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

    // --- TEST PHONE CLICKS ---
    console.log('\n📞 Phone links...');
    try {
      const phoneLinks = await page.$$('a[href^="tel:"]');
      results.ctas.phone.total_found = phoneLinks.length;
     
      if (phoneLinks.length > 0) {
        console.log(`   Found ${phoneLinks.length} phone link(s)`);
       
        for (let i = 0; i < Math.min(phoneLinks.length, 10); i++) {
          if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

          const link = phoneLinks[i];
          let href, phoneNumber, linkText;
          
          try {
            href = await link.getAttribute('href');
            phoneNumber = href?.replace('tel:', '').replace(/\s/g, '') || 'unknown';
            linkText = (await link.textContent().catch(() => 'unknown')).trim();
          } catch (e) {
            continue;
          }
         
          console.log(`   Testing ${i + 1}: ${linkText}`);
         
          const beforeBeaconCount = allBeacons.length;
          const testStartTime = Date.now();
         
          try {
            await link.scrollIntoViewIfNeeded();
            await page.waitForTimeout(1000);
            
            if (!await link.isVisible()) {
              console.log('      ⚠️  Not visible, skipping');
              continue;
            }
            
            await link.click({ force: true, timeout: 5000 });
            await page.waitForTimeout(4000);
            
          } catch (clickError) {
            console.log(`      ❌ Click failed`);
            results.ctas.phone.tested++;
            results.ctas.phone.broken++;
            results.ctas.phone.broken_details.push({
              link: href,
              text: linkText,
              reason: 'Could not click'
            });
            continue;
          }
         
          const testEndTime = Date.now();
          results.ctas.phone.tested++;
          
          const newBeacons = allBeacons.slice(beforeBeaconCount).filter(b => {
            return b.timestampMs >= testStartTime && b.timestampMs <= testEndTime;
          });
          
          const allGA4Events = newBeacons
            .filter(b => b.type === 'GA4' && b.event_name)
            .map(b => b.event_name);
          
          const phoneRelevantEvents = allGA4Events.filter(event => 
            isRelevantEvent(event, PHONE_EVENT_PATTERNS)
          );
         
          if (phoneRelevantEvents.length > 0) {
            results.ctas.phone.working++;
            console.log(`      ✅ Working: ${phoneRelevantEvents.join(', ')}`);
          } else {
            results.ctas.phone.broken++;
            results.ctas.phone.broken_details.push({
              link: href,
              text: linkText,
              reason: allGA4Events.length > 0 
                ? `Only generic events: ${allGA4Events.join(', ')}`
                : 'No GA4 event fired'
            });
            console.log(`      ❌ No tracking`);
          }
        }
      } else {
        console.log('   ℹ️  No phone links found');
      }
    } catch (e) {
      console.log(`   ⚠️  Error: ${e.message}`);
    }
   
    // --- TEST EMAIL CLICKS ---
    console.log('\n📧 Email links...');
    try {
      if (Date.now() - pageLoadStart > MAX_RUNTIME) {
        console.log('   ⚠️  Skipping (timeout)');
      } else {
        const emailLinks = await page.$$('a[href^="mailto:"]');
        results.ctas.email.total_found = emailLinks.length;
       
        if (emailLinks.length > 0) {
          console.log(`   Found ${emailLinks.length} email link(s)`);
         
          for (let i = 0; i < Math.min(emailLinks.length, 10); i++) {
            if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

            const link = emailLinks[i];
            let href, emailAddress, linkText;
            
            try {
              href = await link.getAttribute('href');
              emailAddress = href?.replace('mailto:', '').split('?')[0] || 'unknown';
              linkText = (await link.textContent().catch(() => 'unknown')).trim();
            } catch (e) {
              continue;
            }
           
            console.log(`   Testing ${i + 1}: ${linkText}`);
           
            const beforeBeaconCount = allBeacons.length;
            const testStartTime = Date.now();
           
            try {
              await link.scrollIntoViewIfNeeded();
              await page.waitForTimeout(1000);
              
              if (!await link.isVisible()) {
                console.log('      ⚠️  Not visible, skipping');
                continue;
              }
              
              await link.hover();
              await page.waitForTimeout(500);
              await link.click({ force: true, timeout: 5000 });
              await page.waitForTimeout(4000);
              
            } catch (clickError) {
              console.log(`      ❌ Click failed`);
              results.ctas.email.tested++;
              results.ctas.email.broken++;
              results.ctas.email.broken_details.push({
                link: href,
                text: linkText,
                reason: 'Could not click'
              });
              continue;
            }
           
            const testEndTime = Date.now();
            results.ctas.email.tested++;
            
            const newBeacons = allBeacons.slice(beforeBeaconCount).filter(b => {
              return b.timestampMs >= testStartTime && b.timestampMs <= testEndTime;
            });
            
            const allGA4Events = newBeacons
              .filter(b => b.type === 'GA4' && b.event_name)
              .map(b => b.event_name);
            
            const emailRelevantEvents = allGA4Events.filter(event => 
              isRelevantEvent(event, EMAIL_EVENT_PATTERNS)
            );
           
            if (emailRelevantEvents.length > 0) {
              results.ctas.email.working++;
              console.log(`      ✅ Working: ${emailRelevantEvents.join(', ')}`);
            } else {
              results.ctas.email.broken++;
              results.ctas.email.broken_details.push({
                link: href,
                text: linkText,
                reason: allGA4Events.length > 0 
                  ? `Only generic events: ${allGA4Events.join(', ')}`
                  : 'No GA4 event fired'
              });
              console.log(`      ❌ No tracking`);
            }
          }
        } else {
          console.log('   ℹ️  No email links found');
        }
      }
    } catch (e) {
      console.log(`   ⚠️  Error: ${e.message}`);
    }
   
    // --- TEST FORMS ---
    console.log('\n📝 Forms...');
    try {
      if (Date.now() - pageLoadStart > MAX_RUNTIME) {
        console.log('   ⚠️  Skipping (timeout)');
      } else {
        let allForms = [];
        const originalUrl = page.url();
        
        // Strategy 1: Visible forms
        let forms = await page.$$('form:visible');
        allForms.push(...forms);
        
        // Strategy 2: Scroll
        if (forms.length === 0) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(2000);
          forms = await page.$$('form:visible');
          allForms.push(...forms);
        }
        
        // Strategy 3: Click triggers
        if (allForms.length === 0) {
          const triggers = ['button:has-text("Contact")', 'button:has-text("Get Quote")'];
          for (const selector of triggers) {
            try {
              const trigger = await page.$(selector);
              if (trigger && await trigger.isVisible()) {
                await trigger.click({ timeout: 3000 });
                await page.waitForTimeout(2000);
                forms = await page.$$('form:visible');
                if (forms.length > 0) {
                  allForms.push(...forms);
                  break;
                }
              }
            } catch (e) {
              // Continue
            }
          }
        }
        
        // Strategy 4: Contact page
        if (allForms.length === 0 && Date.now() - pageLoadStart < MAX_RUNTIME) {
          const baseUrl = new URL(originalUrl).origin;
          for (const path of ['/contact', '/contact-us']) {
            try {
              const response = await page.goto(baseUrl + path, { 
                waitUntil: 'domcontentloaded', 
                timeout: 15000 
              });
              if (response && response.ok()) {
                await page.waitForTimeout(3000);
                forms = await page.$$('form:visible');
                if (forms.length > 0) {
                  allForms.push(...forms);
                  break;
                }
              }
            } catch (e) {
              // Continue
            }
          }
        }
        
        // Deduplicate
        const uniqueForms = [];
        const seenForms = new Set();
        for (const form of allForms) {
          try {
            const formId = await form.evaluate(el => 
              el.id || el.className || el.outerHTML.substring(0, 100)
            );
            if (!seenForms.has(formId)) {
              seenForms.add(formId);
              uniqueForms.push(form);
            }
          } catch (e) {
            // Form stale
          }
        }
        
        results.ctas.forms.total_found = uniqueForms.length;
        
        if (uniqueForms.length > 0) {
          console.log(`   Found ${uniqueForms.length} form(s)`);
          
          for (let i = 0; i < Math.min(uniqueForms.length, 3); i++) {
            if (Date.now() - pageLoadStart > MAX_RUNTIME) break;

            const form = uniqueForms[i];
            console.log(`   Testing form ${i + 1}...`);
            
            try {
              if (!await form.isVisible().catch(() => false)) {
                console.log('      ⚠️  Not visible, skipping');
                continue;
              }
              
              const beforeBeaconCount = allBeacons.length;
              const testStartTime = Date.now();
              
              await form.scrollIntoViewIfNeeded();
              await page.waitForTimeout(1000);
              
              const inputs = await form.$$('input:visible, textarea:visible, select:visible');
              let filledFields = 0;
              
              for (const input of inputs) {
                try {
                  const inputType = await input.getAttribute('type');
                  const inputName = await input.getAttribute('name');
                  const placeholder = await input.getAttribute('placeholder');
                  
                  if (inputType === 'email' || 
                      inputName?.toLowerCase().includes('email') || 
                      placeholder?.toLowerCase().includes('email')) {
                    await input.fill('test@example.com');
                    filledFields++;
                  } 
                  else if (inputType === 'tel' || 
                           inputName?.toLowerCase().includes('phone') || 
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
                    await input.fill('Test');
                    filledFields++;
                  } 
                  else if (inputType === 'textarea') {
                    await input.fill('Test message');
                    filledFields++;
                  } 
                  else if (inputType === 'checkbox') {
                    await input.check();
                    filledFields++;
                  }
                  
                  await page.waitForTimeout(300);
                } catch (e) {
                  // Skip field
                }
              }
              
              console.log(`      Filled ${filledFields} field(s)`);
              
              if (filledFields === 0) {
                console.log('      ⚠️  Could not fill fields');
                results.ctas.forms.tested++;
                results.ctas.forms.broken++;
                results.ctas.forms.broken_details.push({
                  form_index: i + 1,
                  reason: 'Could not fill any fields'
                });
                continue;
              }
              
              const submitBtn = await form.$('button[type="submit"], input[type="submit"], button:has-text("Submit")');
              
              if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
                try {
                  console.log('      👆 Submitting...');
                  await submitBtn.click({ timeout: 5000 });
                  await page.waitForTimeout(5000);
                } catch (e) {
                  console.log(`      ❌ Submit failed`);
                  results.ctas.forms.tested++;
                  results.ctas.forms.broken++;
                  results.ctas.forms.broken_details.push({
                    form_index: i + 1,
                    reason: 'Submit failed'
                  });
                  continue;
                }
                
                const testEndTime = Date.now();
                results.ctas.forms.tested++;
                
                const newBeacons = allBeacons.slice(beforeBeaconCount).filter(b => {
                  return b.timestampMs >= testStartTime && b.timestampMs <= testEndTime;
                });
                
                const allGA4Events = newBeacons
                  .filter(b => b.type === 'GA4' && b.event_name)
                  .map(b => b.event_name);
                
                const formRelevantEvents = allGA4Events.filter(event => 
                  isRelevantEvent(event, FORM_EVENT_PATTERNS)
                );
                
                if (formRelevantEvents.length > 0) {
                  results.ctas.forms.working++;
                  console.log(`      ✅ Working: ${formRelevantEvents.join(', ')}`);
                } else {
                  results.ctas.forms.broken++;
                  results.ctas.forms.broken_details.push({
                    form_index: i + 1,
                    reason: allGA4Events.length > 0 
                      ? `Only generic events: ${allGA4Events.join(', ')}`
                      : 'No GA4 event fired'
                  });
                  console.log(`      ❌ No tracking`);
                }
              } else {
                console.log('      ⚠️  No submit button');
              }
            } catch (e) {
              console.log(`      ⚠️  Error: ${e.message}`);
            }
          }
        } else {
          console.log('   ℹ️  No forms found');
        }
      }
    } catch (e) {
      console.log(`   ⚠️  Error: ${e.message}`);
    }

    // ============================================================
    // PHASE 4: ANALYZE & CREATE ISSUES
    // ============================================================
    console.log('\n📋 PHASE 4: Analysis...');
    
    // CTA issues
    const totalCTAs = results.ctas.phone.total_tested + 
                      results.ctas.email.total_tested + 
                      results.ctas.forms.total_tested;
    
    const workingCTAs = results.ctas.phone.working + 
                        results.ctas.email.working + 
                        results.ctas.forms.working;
    
    const brokenCTAs = results.ctas.phone.broken + 
                       results.ctas.email.broken + 
                       results.ctas.forms.broken;
    
    // Phone issues
    if (results.ctas.phone.broken > 0) {
      if (results.ctas.phone.broken === results.ctas.phone.total_tested) {
        results.issues.push(`❌ CRITICAL: All phone links not tracking (0/${results.ctas.phone.total_tested})`);
      } else {
        results.issues.push(`⚠️ ${results.ctas.phone.broken}/${results.ctas.phone.total_tested} phone links not tracking`);
      }
    }
    
    // Email issues
    if (results.ctas.email.broken > 0) {
      if (results.ctas.email.broken === results.ctas.email.total_tested) {
        results.issues.push(`❌ CRITICAL: All email links not tracking (0/${results.ctas.email.total_tested})`);
      } else {
        results.issues.push(`⚠️ ${results.ctas.email.broken}/${results.ctas.email.total_tested} email links not tracking`);
      }
    }
    
    // Form issues
    if (results.ctas.forms.broken > 0) {
      if (results.ctas.forms.broken === results.ctas.forms.total_tested) {
        results.issues.push(`❌ CRITICAL: All forms not tracking (0/${results.ctas.forms.total_tested})`);
      } else {
        results.issues.push(`⚠️ ${results.ctas.forms.broken}/${results.ctas.forms.total_tested} forms not tracking`);
      }
    }
    
    // Overall status
    const criticalIssues = results.issues.filter(i => i.includes('CRITICAL')).length;
    
    if (criticalIssues > 0 || !results.tracking.gtm_found && !results.tracking.ga4_found) {
      results.overall_status = 'FAILING';
    } else if (brokenCTAs > 0 || results.issues.length > 0) {
      results.overall_status = 'WARNING';
    } else {
      results.overall_status = 'HEALTHY';
    }
    
    // Summary
    if (totalCTAs > 0) {
      results.summary = `${workingCTAs}/${totalCTAs} CTAs tracking correctly`;
    } else {
      results.summary = 'No CTAs found to test';
    }
   
  } catch (error) {
    console.log(`\n❌ Fatal error: ${error.message}`);
    results.issues.push(`Fatal error: ${error.message}`);
    results.overall_status = 'ERROR';
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
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
  console.log(`   GTM: ${results.tracking.gtm_found ? '✅ Found' : '❌ Not found'}`);
  console.log(`   GA4: ${results.tracking.ga4_found ? '✅ Found' : '❌ Not found'}`);
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
