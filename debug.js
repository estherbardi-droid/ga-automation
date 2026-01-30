const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

// Debug function to see all selectors on page
async function debugPageElements(page, label) {
  console.log(`\n========== DEBUG: ${label} ==========`);
  console.log(`🌐 Current URL: ${page.url()}`);
  
  const elements = await page.evaluate(() => {
    const results = {
      buttons: [],
      inputs: [],
      debugIds: []
    };
    
    // Get all visible buttons
    document.querySelectorAll('button').forEach((btn, i) => {
      if (btn.offsetParent !== null) {
        results.buttons.push({
          index: i,
          text: btn.textContent.trim().substring(0, 50),
          debugId: btn.getAttribute('debug-id'),
          disabled: btn.disabled
        });
      }
    });
    
    // Get all visible inputs
    document.querySelectorAll('input').forEach((inp, i) => {
      if (inp.offsetParent !== null) {
        results.inputs.push({
          index: i,
          type: inp.type,
          placeholder: inp.placeholder,
          ariaLabel: inp.getAttribute('aria-label'),
          value: inp.value.substring(0, 50)
        });
      }
    });
    
    // Get all elements with debug-id
    document.querySelectorAll('[debug-id]').forEach((el) => {
      if (el.offsetParent !== null) {
        results.debugIds.push({
          tag: el.tagName,
          debugId: el.getAttribute('debug-id'),
          text: el.textContent.trim().substring(0, 30)
        });
      }
    });
    
    return results;
  });
  
  console.log('\n📋 BUTTONS:');
  elements.buttons.forEach(btn => {
    console.log(`  [${btn.index}] "${btn.text}" | debug-id: ${btn.debugId} | disabled: ${btn.disabled}`);
  });
  
  console.log('\n📝 INPUTS:');
  elements.inputs.forEach(inp => {
    console.log(`  [${inp.index}] type: ${inp.type} | placeholder: "${inp.placeholder}" | aria-label: "${inp.ariaLabel}"`);
  });
  
  console.log('\n🏷️  DEBUG-IDs:');
  elements.debugIds.forEach(el => {
    console.log(`  ${el.tag} | debug-id: ${el.debugId} | "${el.text}"`);
  });
  
  console.log(`========== END DEBUG ==========\n`);
}

app.post('/run', async (req, res) => {
  const {
    action,
    google_email,
    google_password,
    sso_username,
    sso_password,
    account_name,
    property_name
  } = req.body;

  if (!['login_and_create_ga4', 'create_ga_account'].includes(action)) {
    return res.status(400).json({ error: 'Unknown action' });
  }

  let browser;

  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    /* ================= LOGIN ================= */
    await page.goto('https://analytics.google.com', { waitUntil: 'domcontentloaded' });

    for (let i = 0; i < 10; i++) {
      if (await page.locator('input[type="email"]:visible').count() > 0) {
        await page.fill('input[type="email"]:visible', google_email);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
        continue;
      }

      if (await page.locator('input[name="Passwd"]:visible').count() > 0) {
        await page.fill('input[name="Passwd"]:visible', google_password);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
        continue;
      }

      if (page.url().includes('onelogin.com')) {
        if (await page.locator('input[name="username"]:visible').count() > 0) {
          await page.fill('input[name="username"]:visible', sso_username);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(3000);
          continue;
        }

        if (await page.locator('input[name="password"]:visible').count() > 0) {
          await page.fill('input[name="password"]:visible', sso_password);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(5000);
          continue;
        }
      }

      if (page.url().startsWith('https://analytics.google.com')) break;
      await page.waitForTimeout(3000);
    }

    /* ================= ADMIN ================= */
    await page.goto('https://analytics.google.com/analytics/web', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(4000);

    const adminIcon = page.locator(
      '[aria-label="Admin"], a[href*="admin"], button[aria-label*="Admin"]'
    );
    await adminIcon.first().waitFor({ timeout: 60000 });
    await adminIcon.first().click();
    await page.waitForTimeout(4000);

    /* ======================================================
       ACTION 1 — CAPACITY CHECK (UNCHANGED)
    ====================================================== */
    if (action === 'login_and_create_ga4') {
      const createUrl =
        'https://analytics.google.com/analytics/web/#/admin/account/create';

      await page.goto(createUrl, { waitUntil: 'domcontentloaded' });

      const reportsIndicators = [
        'text=Reports snapshot',
        'text=Realtime',
        'text=Engagement',
        'text=Monetization'
      ];

      let stayedInAdmin = false;

      for (let i = 0; i < 15; i++) {
        let reportsVisible = false;

        for (const text of reportsIndicators) {
          if (await page.locator(text).count() > 0) {
            reportsVisible = true;
            break;
          }
        }

        if (!reportsVisible) {
          stayedInAdmin = true;
          break;
        }

        await page.waitForTimeout(300);
      }

      if (!stayedInAdmin) {
        await browser.close();
        return res.json({ status: 'failed', reason: 'account_no_space' });
      }

      try {
        const accountInput = page.locator(
          'input[aria-label*="Account"], input[placeholder*="Account"]'
        ).first();

        await accountInput.waitFor({ timeout: 5000 });
        await accountInput.fill('probe');

        const value = await accountInput.inputValue();
        if (value && value.length > 0) {
          await browser.close();
          return res.json({ status: 'success', reason: 'account_has_space' });
        }
      } catch {}

      await browser.close();
      return res.json({ status: 'failed', reason: 'account_no_space' });
    }

    /* ======================================================
       ACTION 2 — GA4 ACCOUNT CREATION
    ====================================================== */
    if (action === 'create_ga_account') {
      console.log('🚀 Creating GA4 account…');

      // Go directly to account creation (clean, no account context)
      await page.goto('https://analytics.google.com/analytics/web/#/admin/account/create', {
        waitUntil: 'domcontentloaded'
      });
      await page.waitForTimeout(4000);

      /* ===== ADMIN CREATE GUARD ===== */
      const reportsIndicators = [
        'text=Reports snapshot',
        'text=Realtime',
        'text=Engagement',
        'text=Monetization'
      ];

      let stayedInAdmin = false;

      for (let i = 0; i < 15; i++) {
        let reportsVisible = false;

        for (const text of reportsIndicators) {
          if (await page.locator(text).count() > 0) {
            reportsVisible = true;
            break;
          }
        }

        if (!reportsVisible) {
          stayedInAdmin = true;
          break;
        }

        await page.waitForTimeout(300);
      }

      if (!stayedInAdmin) {
        throw new Error('GA fell back to Reports before creation');
      }

      /* STEP 1 — ACCOUNT NAME */
      console.log('📍 Step 1: Account Name');
      await debugPageElements(page, 'Step 1 Start');
      
      const accountInput = page.locator(
        'input[aria-label*="Account"], input[placeholder*="Account"]'
      ).first();

      await accountInput.waitFor({ timeout: 6000 });
      await accountInput.fill(account_name);
      console.log(`✅ Filled account name: ${account_name}`);
      
      // Click Next for Step 1
      const step1Next = page.locator('[debug-id="account-next-step-button"]').first();
      await step1Next.click();
      console.log('✅ Clicked Step 1 Next');
      
      await page.waitForTimeout(3000);
      await debugPageElements(page, 'After Step 1 Click');

      /* STEP 2 — PROPERTY NAME */
      console.log('📍 Step 2: Property Name');
      
      // Wait for Property creation page
      await page.locator('text=Property creation').first().waitFor({ timeout: 10000 });
      console.log('✅ On Property creation page');
      
      await debugPageElements(page, 'Step 2 Start');
      
      // Find property input
      const propertyInput = page.locator('input[type="text"]:visible').first();
      await propertyInput.click();
      await page.waitForTimeout(500);
      
      // Fill property name
      await propertyInput.fill(property_name);
      console.log(`✅ Filled property name: ${property_name}`);
      
      // Wait for validation
      await page.waitForTimeout(2000);
      
      await debugPageElements(page, 'Step 2 After Filling');
      
      // Click Next for Step 2
      const propertyNext = page.locator('[debug-id="property-next-step-button"]').first();
      await propertyNext.click();
      console.log('✅ Clicked Step 2 Next');
      
      await page.waitForTimeout(3000);

      /* STEP 3 — BUSINESS INFO */
      await page.locator('text=Describe your business').waitFor({ timeout: 15000 });
      console.log('✅ On Step 3: Business Info');

      await page.locator('div[role="combobox"]').first().click();
      await page.locator('mat-option:has-text("Other business activity")').click();
      await page.locator('mat-radio-button:has-text("Small")').click();
      
      const businessNext = page.locator('[debug-id="account-next-step-button"]').first();
      await businessNext.click();

      /* STEP 4 — OBJECTIVES */
      await page.locator('text=Choose your business objectives').waitFor({ timeout: 10000 });
      console.log('✅ On Step 4: Objectives');

      const objectives = [
        'Generate leads',
        'Drive online sales',
        'Understand user behavior',
        'View user engagement'
      ];

      for (const obj of objectives) {
        const checkbox = page.locator(`mat-checkbox:has-text("${obj}")`);
        if (await checkbox.isVisible()) {
          await checkbox.click();
        }
      }

      const createBtn = page.locator('[debug-id="account-next-step-button"]').first();
      await createBtn.waitFor({ state: 'visible' });
      await createBtn.click();

      /* STEP 5 — TERMS */
      const termsCheckbox = page.locator('input[type="checkbox"]');

      if (await termsCheckbox.count() > 0) {
        await termsCheckbox.check();
        await page.click('button:has-text("I Accept")');
      }

      console.log('🎉 GA4 account successfully created');

      await browser.close();
      return res.json({
        status: 'success',
        message: 'GA4 account and property created'
      });
    }

  } catch (err) {
    console.error('❌ ERROR:', err);
    if (browser) await browser.close();

    return res.json({
      status: 'failed',
      reason: 'automation_error',
      error: err.message
    });
  }
});

app.listen(3000, () => {
  console.log('🚀 Runner listening on port 3000');
});








