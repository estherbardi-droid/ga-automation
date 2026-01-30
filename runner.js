const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

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
        ACTION 1 — CAPACITY CHECK
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

      const createUrl =
        'https://analytics.google.com/analytics/web/#/admin/account/create';

      await page.goto(createUrl, { waitUntil: 'domcontentloaded' });

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
      const accountInput = page.locator(
        'input[aria-label*="Account"], input[placeholder*="Account"]'
      ).first();

      await accountInput.waitFor({ timeout: 6000 });
      await accountInput.fill(account_name);
      await page.click('button:has-text("Next")');

      /* STEP 2 — PROPERTY NAME */
      console.log('📍 Starting Step 2: Property details');
      await page.locator('text=Property details').first().waitFor({ timeout: 10000 });
      console.log('✅ Property details page loaded');

      // Find and focus the property input
      const propertyInput = page.locator('input[type="text"]:visible').first();
      await propertyInput.click();
      console.log('📝 Clicked property input field');
      
      // Clear any existing value
      await propertyInput.clear();
      
      // Type the property name slowly like a human to trigger validation
      console.log('⌨️ Typing property name slowly:', property_name);
      await propertyInput.pressSequentially(property_name, { delay: 100 });
      console.log('✅ Property name typed');
      
      // Wait for GA4 validation to process
      await page.waitForTimeout(1500);
      
      // Take screenshot to see button state
      await page.screenshot({ path: '/home/claude/debug_step2_after_typing.png' });
      console.log('📸 Screenshot taken after typing');
      
      // Now wait for the Next button to become enabled (turn blue)
      console.log('⏳ Waiting for Next button to become enabled...');
      const propertyNext = page.locator('[debug-id="account-next-step-button"]').first();
      
      // Wait for button to exist and be visible
      await propertyNext.waitFor({ state: 'visible', timeout: 10000 });
      
      // Wait for button to be enabled (no longer disabled)
      try {
        await propertyNext.waitFor({ state: 'attached', timeout: 5000 });
        await page.waitForFunction(
          () => {
            const btn = document.querySelector('[debug-id="account-next-step-button"]');
            return btn && !btn.disabled && !btn.hasAttribute('disabled');
          },
          { timeout: 10000 }
        );
        console.log('✅ Next button is now enabled');
      } catch (e) {
        console.log('⚠️ Could not verify button enabled state, trying anyway...');
      }
      
      await page.screenshot({ path: '/home/claude/debug_step2_before_click.png' });
      
      // Click Next
      console.log('🖱️ Clicking Next button...');
      await propertyNext.click();
      console.log('✅ Next button clicked');
      
      // Wait for navigation to Step 3
      await page.waitForTimeout(3000);
      await page.screenshot({ path: '/home/claude/debug_step2_after_click.png' });
      
      console.log('🌐 Current URL:', page.url());
      console.log('✅ Step 2 complete');

      /* STEP 3 — BUSINESS INFO */
      // First check if we actually made it to Step 3 or got redirected
      try {
        await page.locator('text=Describe your business').waitFor({ timeout: 15000 });
        console.log('✅ Reached Step 3: Business info');
      } catch (e) {
        // Check if we got kicked to Reports instead
        let kickedToReports = false;
        for (const text of reportsIndicators) {
          if (await page.locator(text).count() > 0) {
            kickedToReports = true;
            break;
          }
        }
        
        if (kickedToReports) {
          throw new Error('GA4 redirected to Reports after Step 2 - property may have been auto-created');
        }
        
        throw new Error('Failed to reach Step 3 (Business info) after clicking Next in Step 2');
      }

      await page.locator('div[role="combobox"]').first().click();
      await page.locator('mat-option:has-text("Other business activity")').click();
      await page.locator('mat-radio-button:has-text("Small")').click();
      
      const businessNext = page.locator('[debug-id="account-next-step-button"]').first();
      await businessNext.click();

      /* STEP 4 — OBJECTIVES */
      await page.locator('text=Choose your business objectives').waitFor({ timeout: 10000 });

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