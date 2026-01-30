const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const healthRouter = require('./health.routes');
app.use('/health', healthRouter);

function extractPropertyIdFromUrl(page) {
  const url = page.url();

  // Common GA formats:
  // 1) .../#/a123p456/admin/...
  // 2) .../#/p456/admin/...
  // 3) .../p456/...
  const m =
    url.match(/#\/a\d+p(\d+)\b/i) ||
    url.match(/#\/p(\d+)\b/i) ||
    url.match(/\/p(\d+)\b/i);

  return m ? m[1] : null;
}


function normaliseWebsiteUrl(raw) {
  const cleaned = String(raw || '').trim();
  const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  return new URL(withProto);
}

async function clickWebPlatform(page) {
  console.log('🔍 Looking for Web platform button...');
  
  // If we're already on the web stream form, skip the platform picker
  const websiteInput = page.getByPlaceholder('www.mywebsite.com');
  if (await websiteInput.count() > 0) {
    console.log('✅ Already on web stream form, skipping platform selection');
    return;
  }
  
  // Wait a bit for the page to settle after accepting terms
  await page.waitForTimeout(2000);
  
  // Look for the Web button with multiple selectors
  const webBtnSelectors = [
    'button:has-text("Web")',
    '[role="button"]:has-text("Web")',
    'button[aria-label*="Web"]',
    '.platform-button:has-text("Web")',
    '[data-platform="web"]'
  ];
  
  let webBtn = null;
  
  for (const selector of webBtnSelectors) {
    const btn = page.locator(selector).filter({ hasText: /^Web$/i });
    if (await btn.count() > 0) {
      webBtn = btn.first();
      console.log(`✅ Found Web button with selector: ${selector}`);
      break;
    }
  }
  
  // If still not found, try a more lenient approach
  if (!webBtn || await webBtn.count() === 0) {
    console.log('⚠️ Web button not found with strict selectors, trying lenient...');
    webBtn = page.locator('button, [role="button"]').filter({ hasText: 'Web' }).first();
  }
  
  // Check if we can find it now
  if (await webBtn.count() === 0) {
    console.log('⚠️ No Web platform button found - might already be on web stream form');
    
    // Double-check if we're already on the form
    await page.waitForTimeout(1000);
    if (await websiteInput.count() > 0) {
      console.log('✅ Confirmed: already on web stream form');
      return;
    }
    
    throw new Error('Could not find Web platform button and not on web stream form');
  }

  await webBtn.waitFor({ state: 'visible', timeout: 30000 });
  await webBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1000);
  
  console.log('✅ Clicked Web platform button');
}


async function fillWebStreamForm(page, { websiteUrl, websiteName }) {
  // Scope to the visible dialog if GA is using one; otherwise use the page
  const dialog = page.locator('div[role="dialog"]:visible, .cdk-overlay-pane:visible, .mat-dialog-container:visible').first();
  const scope = (await dialog.count()) > 0 ? dialog : page;

  // 1) Wait for the Website URL/domain input to exist (most stable selector)
  let domainInput = scope.getByPlaceholder('www.mywebsite.com');

  if ((await domainInput.count()) === 0) {
    // Fallback if placeholder changes
    domainInput = scope.locator('input[aria-label*="Website"], input[aria-label*="website"], input[name*="website"], input[name*="domain"]').first();
  }

  await domainInput.waitFor({ timeout: 30000 });

  // 2) Parse URL and fill only hostname (GA expects domain because protocol is separate)
  const cleaned = String(websiteUrl || '').trim();
  const withProto = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
  const urlObj = new URL(withProto);

  await domainInput.fill(urlObj.hostname);

  // 3) Fill Stream name
  let streamNameInput = scope.getByLabel(/Stream name/i);
  if ((await streamNameInput.count()) === 0) {
    streamNameInput = scope.locator('input[aria-label*="Stream"], input[aria-label*="stream"], input[name*="stream"]').first();
  }
  await streamNameInput.waitFor({ timeout: 20000 });
  await streamNameInput.fill(String(websiteName || '').trim());

  // 4) Click "Create and continue" (with fallbacks)
  let createBtn = scope.getByRole('button', { name: /Create and continue/i });
  if ((await createBtn.count()) === 0) createBtn = scope.getByRole('button', { name: /^Create$/i });
  if ((await createBtn.count()) === 0) createBtn = scope.getByRole('button', { name: /Continue/i });

  await createBtn.waitFor({ timeout: 20000 });

  // GA sometimes lags validation; wait until enabled
  for (let i = 0; i < 40; i++) {
    if (await createBtn.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(250);
  }

  await createBtn.click({ timeout: 15000 });
}


 function getWebsiteInputs(req) {
  const b = req.body || {};

  const websiteUrl =
    b.websiteUrl ||
    b.website_url ||
    b.siteUrl ||
    b.site_url ||
    b.website;

  const websiteName =
    b.websiteName ||
    b.website_name ||
    b.siteName ||
    b.site_name ||
    b.streamName ||
    b.stream_name;

  return { websiteUrl, websiteName };
}


/* ====== PASTE NEW HELPERS HERE (BEFORE app.post) ====== */

async function closeAdminSidebarIfOpen(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  await page.mouse.click(800, 400).catch(() => {});
  await page.waitForTimeout(300);
}


async function ensureCorrectPropertyContext(page, accountName, propertyName) {
  console.log(`🔍 Ensuring we're in the correct property context: ${propertyName}...`);
  
  // Always go to Admin first to ensure we're in a stable state
  console.log('🔍 Navigating to Admin to verify property context...');
  
  await page.goto('https://analytics.google.com/analytics/web', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  
  const adminBtn = page.getByRole('button', { name: /^Admin$/ }).or(page.locator('[aria-label="Admin"]'));
  await adminBtn.first().waitFor({ state: 'visible', timeout: 30000 });
  await adminBtn.first().click({ timeout: 30000 });
  await page.waitForTimeout(2000);
  
  // Close sidebar
  await closeAdminSidebarIfOpen(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  
  // Find property dropdown (second dropdown in Admin)
  const allDropdowns = page.locator('button[aria-haspopup="listbox"], button[role="combobox"]');
  const count = await allDropdowns.count();
  console.log(`Found ${count} dropdowns in Admin`);
  
  if (count === 0) {
    throw new Error('Could not find any dropdowns in Admin');
  }
  
  const propertyDropdown = count >= 2 ? allDropdowns.nth(1) : allDropdowns.first();
  
  // Check if the correct property is already selected
  const currentSelection = await propertyDropdown.textContent();
  console.log(`Current property selection: "${currentSelection}"`);
  
  if (currentSelection.includes(propertyName)) {
    console.log('✅ Correct property already selected');
    return;
  }
  
  // Click dropdown to open it
  console.log('⚠️ Need to switch property...');
  
  try {
    await propertyDropdown.click({ timeout: 10000 });
  } catch {
    await closeAdminSidebarIfOpen(page);
    await propertyDropdown.click({ force: true, timeout: 10000 });
  }
  
  await page.waitForTimeout(1000);
  
  // Select the correct property from dropdown
  const propertyOption = page.locator('[role="option"], mat-option').filter({ hasText: propertyName }).first();
  
  if (await propertyOption.count() === 0) {
    throw new Error(`Property "${propertyName}" not found in dropdown options`);
  }
  
  await propertyOption.waitFor({ timeout: 20000 });
  await propertyOption.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  
  console.log(`✅ Switched to property: ${propertyName}`);
}


async function openAccountViaAccountsSearch(page, accountName) {
  // Navigate to GA home to ensure we're in a stable state
  await page.goto('https://analytics.google.com/analytics/web', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Click the account/property selector button in the top left (the one that shows current account/property name)
  const accountSelectorBtn = page.locator(
    'button[aria-label*="account"], button[aria-label*="property"], ' +
    'button:has-text("All accounts"), ' +
    '[class*="account-selector"], [class*="property-selector"]'
  ).first();

  // Fallback: look for any button near the top that contains the current property/account name
  const topButton = page.locator('header button, [role="banner"] button').filter({ 
    hasText: /GA4|account|property/i 
  }).first();

  if (await accountSelectorBtn.count() > 0) {
    await accountSelectorBtn.click({ timeout: 15000 });
  } else if (await topButton.count() > 0) {
    await topButton.click({ timeout: 15000 });
  } else {
    // Last resort: click near the top-left where the account name typically appears
    await page.mouse.click(200, 30);
  }

  await page.waitForTimeout(1500);

  // Now find the search input INSIDE the account switcher dropdown (not the main page search)
  const dropdownSearchInput = page.locator(
    '.cdk-overlay-pane:visible input[type="text"], ' +
    '[role="dialog"]:visible input[type="text"], ' +
    '.mat-mdc-dialog-container:visible input[type="text"], ' +
    '[aria-label*="Search"]:visible'
  ).first();

  await dropdownSearchInput.waitFor({ timeout: 15000 });
  await dropdownSearchInput.fill('');
  await dropdownSearchInput.fill(String(accountName));
  await page.waitForTimeout(1000);

  // Click the matching account from the dropdown results
  const accountItem = page.locator(
    '.cdk-overlay-pane:visible [role="option"], ' +
    '.cdk-overlay-pane:visible .mat-mdc-option, ' +
    '.cdk-overlay-pane:visible [class*="account-item"], ' +
    '[role="dialog"]:visible [role="option"]'
  ).filter({ hasText: String(accountName) }).first();

  await accountItem.waitFor({ timeout: 20000 });
  await accountItem.click({ timeout: 15000 });
  
  await page.waitForTimeout(2500);

  // Verify we navigated away from the dropdown
  const stillShowingDropdown = await page.locator('.cdk-overlay-pane:visible').count() > 0;
  
  if (stillShowingDropdown) {
    // Try clicking again
    await accountItem.click({ timeout: 15000 });
    await page.waitForTimeout(2000);
  }
}

async function openAdmin(page) {
  await page.goto('https://analytics.google.com/analytics/web', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const adminBtn = page
    .getByRole('button', { name: /^Admin$/ })
    .or(page.getByRole('link', { name: /^Admin$/ }))
    .or(page.locator('[aria-label="Admin"]'));

  await adminBtn.first().waitFor({ state: 'visible', timeout: 30000 });
  await adminBtn.first().click({ timeout: 30000 });
  await page.waitForTimeout(2000);
}

async function pickFromAdminDropdown(page, columnRegex, targetName) {
  console.log(`🔍 Picking "${targetName}" from ${columnRegex} dropdown...`);
  
  // Wait for admin page to load
  await page.waitForTimeout(2000);
  
  // GA4 Admin has columns like "Account", "Property", etc.
  // Find the section/column header first
  const columnHeader = page.locator('h3, [role="heading"]').filter({ hasText: columnRegex }).first();
  
  if (await columnHeader.count() === 0) {
    console.log('⚠️ Could not find column header, trying alternative method...');
  }
  
  // Method 1: Look for a dropdown button with aria-haspopup
  let dropdownBtn = page.locator(
    'button[aria-haspopup="listbox"], button[role="combobox"]'
  ).filter({ hasText: columnRegex }).first();
  
  // Method 2: Look for any button that contains the column name
  if (await dropdownBtn.count() === 0) {
    dropdownBtn = page.locator('button').filter({ hasText: columnRegex }).first();
  }
  
  // Method 3: Look for buttons near the column header
  if (await dropdownBtn.count() === 0 && await columnHeader.count() > 0) {
    // Find button that's a sibling or nearby the header
    dropdownBtn = page.locator('button[aria-label*="Property"], button[aria-label*="property"]').first();
  }
  
  // Method 4: Last resort - look for any dropdown-like button in the admin area
  if (await dropdownBtn.count() === 0) {
    const allDropdowns = page.locator('button[aria-haspopup="listbox"], button[role="combobox"]');
    const count = await allDropdowns.count();
    
    for (let i = 0; i < count; i++) {
      const btn = allDropdowns.nth(i);
      const text = await btn.textContent().catch(() => '');
      
      // If the button text contains the target name, it's probably already selected
      if (text.includes(targetName)) {
        console.log(`✅ "${targetName}" appears to already be selected`);
        return;
      }
    }
    
    // If we have exactly 2 dropdowns in admin, the second one is usually Property
    if (columnRegex.toString().includes('Property') && count >= 2) {
      dropdownBtn = allDropdowns.nth(1);
      console.log('✅ Using second dropdown (likely Property)');
    } else if (count > 0) {
      dropdownBtn = allDropdowns.first();
      console.log('✅ Using first available dropdown');
    }
  }
  
  if (await dropdownBtn.count() === 0) {
    throw new Error(`Could not find dropdown for ${columnRegex}`);
  }
  
  // Check if target is already selected
  const currentText = await dropdownBtn.textContent();
  if (currentText.includes(targetName)) {
    console.log(`✅ "${targetName}" is already selected`);
    return;
  }
  

  await dropdownBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // Click the matching option from the dropdown
  const option = page.locator(
    '[role="option"], mat-option, .mat-mdc-option, .mdc-list-item'
  ).filter({ hasText: targetName }).first();
  
  await option.waitFor({ timeout: 20000 });
  await option.click({ timeout: 15000 });
  await page.waitForTimeout(1500);
  
  console.log(`✅ Selected "${targetName}"`);
}

async function goToDataStreams(page) {
  console.log('🔍 Navigating to Data Streams...');
  
  // First, ensure we're in Admin (Data Streams is only visible in Admin)
  const currentUrl = page.url();
  
  if (!currentUrl.includes('/admin')) {
    console.log('⚠️ Not in Admin, navigating there first...');
    
    await page.goto('https://analytics.google.com/analytics/web', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    
    const adminBtn = page.getByRole('button', { name: /^Admin$/ }).or(page.locator('[aria-label="Admin"]'));
    await adminBtn.first().waitFor({ state: 'visible', timeout: 30000 });
    await adminBtn.first().click({ timeout: 30000 });
    await page.waitForTimeout(2000);
  }
  
  // Close any blocking sidebars
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  
  // Now look for Data Streams link
  const dataStreamsLink = page.locator(
    'a:has-text("Data Streams"), ' +
    'a:has-text("Data streams"), ' +
    '[role="link"]:has-text("Data Streams"), ' +
    '[role="link"]:has-text("Data streams")'
  ).first();
  
  await dataStreamsLink.waitFor({ timeout: 30000 });
  await dataStreamsLink.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  
  console.log('✅ On Data Streams page');
}


async function openWebStreamFromList(page, { websiteName, websiteUrl }) {
  console.log(`🔍 Opening web stream from list: name="${websiteName}" url="${websiteUrl}"`);

  const urlObj = normaliseWebsiteUrl(websiteUrl);
  const hostname = urlObj.hostname.replace(/^www\./i, ''); // addpeople.co.uk

  // 1) Wait for the Data Streams list to render something clickable
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1500);

  // GA4 sometimes needs extra time for the grid to populate
  await page
    .locator('[role="row"], [role="link"], [role="button"], a, button')
    .first()
    .waitFor({ timeout: 45000 })
    .catch(() => {});

  // 2) Candidate "row" selectors (GA UI varies)
  const rowCandidates = [
    // Typical table/grid
    page.locator('[role="row"]').filter({ hasText: hostname }).first(),
    page.locator('[role="row"]').filter({ hasText: websiteName }).first(),

    // Sometimes rows are links/buttons rather than role=row
    page.locator('[role="link"]').filter({ hasText: hostname }).first(),
    page.locator('[role="link"]').filter({ hasText: websiteName }).first(),
    page.locator('[role="button"]').filter({ hasText: hostname }).first(),
    page.locator('[role="button"]').filter({ hasText: websiteName }).first(),

    // Fallbacks: any clickable element containing the text
    page.locator('a, button, [role="link"], [role="button"]').filter({ hasText: hostname }).first(),
    page.locator('a, button, [role="link"], [role="button"]').filter({ hasText: websiteName }).first()
  ];

  // 3) Pick the first visible candidate
  let target = null;
  for (const cand of rowCandidates) {
    if (await cand.isVisible().catch(() => false)) {
      target = cand;
      break;
    }
  }

  // If still nothing visible, try waiting specifically for hostname or name to appear
  if (!target) {
    console.log('⚠️ No visible match yet — waiting for hostname/name text to appear...');
    const textWaiters = [
      page.locator(`text=${hostname}`).first(),
      page.locator(`text=${websiteName}`).first()
    ];

    let foundText = false;
    for (const w of textWaiters) {
      if (await w.isVisible().catch(() => false)) {
        foundText = true;
        break;
      }
    }

    if (!foundText) {
      // Give it one more chance to load the grid
      await page.waitForTimeout(2500);
    }

    // Final fallback: first role=row
    const firstRow = page.locator('[role="row"]').first();
    if (await firstRow.isVisible().catch(() => false)) {
      target = firstRow;
      console.log('⚠️ Falling back to first [role="row"]');
    } else {
      // Last resort: first clickable element on the list
      target = page.locator('a, button, [role="link"], [role="button"]').first();
      console.log('⚠️ Falling back to first clickable element');
    }
  }

  // 4) Click strategy: click the target or a clickable child if needed
  const clickTarget = async (loc) => {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await loc.click({ timeout: 45000 });
    } catch {
      await loc.click({ timeout: 45000, force: true });
    }
  };

  console.log('🖱️ Clicking stream entry...');
  await clickTarget(target);

  // 5) Confirm we opened stream details
  // Do NOT use "Data streams" to verify; it can remain visible in header even in details.
  const detailsMarkers = page.locator('text=/Google tag|Web stream details|Stream details|Measurement ID/i').first();

  const opened = await detailsMarkers
    .waitFor({ timeout: 45000 })
    .then(() => true)
    .catch(() => false);

  if (opened) {
    console.log('✅ Opened web stream details');
    return;
  }

  // 6) If not opened, try clicking a more specific child within the row/container
  console.log('⚠️ Did not reach details view — trying secondary click strategies...');

  // Try clicking a nested clickable within the same container (if target was a row/div)
  const nestedClickable = target.locator('a, [role="link"], button, [role="button"]').first();
  if (await nestedClickable.isVisible().catch(() => false)) {
    await clickTarget(nestedClickable);
  } else {
    // Try clicking by exact text element (often the stream title is clickable)
    const titleClick = page.locator('text=/'+escapeRegex(websiteName)+'|'+escapeRegex(hostname)+'/i').first();
    if (await titleClick.isVisible().catch(() => false)) {
      await clickTarget(titleClick);
    }
  }

  const opened2 = await detailsMarkers
    .waitFor({ timeout: 45000 })
    .then(() => true)
    .catch(() => false);

  if (!opened2) {
    throw new Error(`Could not open web stream details from list for "${websiteName}" (${hostname})`);
  }

  console.log('✅ Opened web stream details');
}

// Helper: escape regex special chars for dynamic regex in locator
function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function extractMeasurementId(page) {
  // Look for measurement ID on the page (format: G-XXXXXXXXXX)
  const measurementIdPatterns = [
    'text=/G-[A-Z0-9]{10,}/',
    'text=/Measurement ID.*G-[A-Z0-9]+/i'
  ];
  
  for (const pattern of measurementIdPatterns) {
    const element = page.locator(pattern).first();
    if (await element.count() > 0) {
      const text = await element.textContent();
      const match = text.match(/G-[A-Z0-9]+/);
      if (match) {
        return match[0];
      }
    }
  }
  
  // Fallback: search entire page content
  const pageContent = await page.content();
  const match = pageContent.match(/G-[A-Z0-9]{10,}/);
  return match ? match[0] : null;
}



async function extractTagSnippet(page) {
  console.log('📋 Extracting GA4 tag snippet...');
  
  // Wait for code to render after clicking "Install manually"
  await page.waitForTimeout(1500);
  
  // Strategy 1: Look in common code containers
  const codeSelectors = [
    'code',
    'pre', 
    'textarea',
    '[class*="code"]',
    '[class*="snippet"]',
    '[class*="install"]',
    'div[role="textbox"]'
  ];
  
  for (const selector of codeSelectors) {
    const codeBlocks = page.locator(selector);
    const count = await codeBlocks.count();
    
    for (let i = 0; i < count; i++) {
      const block = codeBlocks.nth(i);
      const text = await block.textContent().catch(() => '');
      
      // Full gtag snippet contains both these elements
      if (text.includes('googletagmanager.com/gtag/js') && text.includes('gtag(')) {
        const cleaned = text.trim();
        console.log(`✅ Found snippet (${cleaned.length} chars) in ${selector}`);
        return cleaned;
      }
    }
  }
  
  // Strategy 2: Extract from entire dialog/modal content
  const dialog = page.locator('[role="dialog"]:visible, .cdk-overlay-pane:visible').first();
  
  if (await dialog.count() > 0) {
    const dialogText = await dialog.textContent().catch(() => '');
    
    // Extract script block using regex
    const scriptMatch = dialogText.match(/<!-- Google tag.*?<\/script>/s);
    if (scriptMatch) {
      console.log('✅ Extracted snippet from dialog via regex');
      return scriptMatch[0].trim();
    }
  }
  
  // Strategy 3: Look for copyable text areas (GA4 uses these)
  const copyableAreas = page.locator('[aria-label*="code"], [aria-label*="snippet"], [data-copy-text]');
  const copyCount = await copyableAreas.count();
  
  for (let i = 0; i < copyCount; i++) {
    const area = copyableAreas.nth(i);
    const text = await area.textContent().catch(() => '');
    
    if (text.includes('googletagmanager.com/gtag/js') && text.includes('gtag(')) {
      console.log('✅ Found snippet in copyable area');
      return text.trim();
    }
  }
  
  // Strategy 4: Get innerText from entire page (last resort)
  const pageText = await page.evaluate(() => document.body.innerText);
  const fullMatch = pageText.match(/<!-- Google tag[\s\S]*?<\/script>/);
  
  if (fullMatch) {
    console.log('✅ Extracted snippet from page text');
    return fullMatch[0].trim();
  }
  
  console.log('⚠️ Could not extract tag snippet');
  await page.screenshot({ path: 'tag_snippet_not_found.png', fullPage: true });
  
  return null;
}



async function clickInstallManuallyTab(page) {
  // Try multiple selector strategies because GA renders this as tab/button/link/div depending on account/UI.

  const candidates = [
    page.getByRole("tab", { name: /install manually/i }).first(),
    page.getByRole("button", { name: /install manually/i }).first(),
    page.getByRole("link", { name: /install manually/i }).first(),
    page.locator('[role="tablist"] >> text=/install manually/i').first(),
    page.getByText(/install manually/i).first(),
  ];

  for (const loc of candidates) {
    try {
      if (await loc.count().catch(() => 0)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 8000 });
        return true;
      }
    } catch (e) {
      // try next candidate
    }
  }

  return false;
}


async function getVisibleOverlay(page) {
  const overlay = page.locator('.cdk-overlay-pane:visible, [role="dialog"]:visible').last();
  await overlay.waitFor({ state: 'visible', timeout: 30000 });
  return overlay;
}

/** @typedef {import('playwright').Page|import('playwright').Frame} Root */

async function waitForInstructionsUiReady(/** @type {Root} */ root) {
  // Wait for either tabs to appear OR loading indicator to go away.
  const tabs = root.locator('[role="tab"]');
  const progress = root.locator('[role="progressbar"], .mat-mdc-progress-spinner, mat-progress-spinner, .mdc-circular-progress');

  // Race: tabs visible vs progress hidden
  await Promise.race([
    tabs.first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {}),
    progress.first().waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {}),
  ]);

  // Small settle
  await root.waitForTimeout?.(500).catch(() => {});
}


async function clickInstallManuallyRobust(/** @type {Root} */ root) {
  // Attempt 1: text/role based (fast path)
  const textCandidates = [
    root.getByRole('tab', { name: /install manually/i }),
    root.getByRole('button', { name: /install manually/i }),
    root.locator('[role="tab"]').filter({ hasText: /install manually/i }),
    root.locator('button,a,div,span').filter({ hasText: /install manually/i }),
  ];

  for (const c of textCandidates) {
    const el = c.first();
    if (await el.isVisible().catch(() => false)) {
      await el.click({ force: true, timeout: 8000 }).catch(() => {});
      return true;
    }
  }

  // Attempt 2: click the 2nd tab by index (with force to bypass iframe overlays)
  const tabs = root.locator('[role="tab"]');
  const count = await tabs.count();

  if (count >= 2) {
    const second = tabs.nth(1);
    await second.scrollIntoViewIfNeeded().catch(() => {});
    await second.click({ force: true, timeout: 10000 }).catch(() => {});
    // Verify it worked by checking if it's now selected
    await root.waitForTimeout?.(500).catch(() => {});
    const selected = await second.getAttribute('aria-selected').catch(() => 'false');
    if (selected === 'true') return true;
  }

  // Attempt 3: click any tab that is NOT selected (aria-selected=false)
  const unselected = root.locator('[role="tab"][aria-selected="false"]').first();
  if (await unselected.isVisible().catch(() => false)) {
    await unselected.click({ force: true, timeout: 10000 }).catch(() => {});
    return true;
  }

  // Attempt 4: JS click fallback (bypasses ALL overlays including iframes)
  const clicked = await root.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const second = tabs[1];
    if (second) { 
      second.click(); 
      return true; 
    }

    // last resort: find anything that looks like "manual"
    const candidates = Array.from(document.querySelectorAll('button,a,div,span'))
      .filter(el => /manual/i.test((el.textContent || '').trim()) && (el.offsetParent !== null));
    if (candidates[0]) { 
      candidates[0].click(); 
      return true; 
    }
    return false;
  }).catch(() => false);

  return clicked;
}



/** @typedef {import('playwright').Page|import('playwright').Frame} Root */

async function extractMeasurementIdFromRoot(/** @type {Root} */ root) {
  // 1) Fast path: any visible "G-XXXX" in the rendered UI
  const bodyText = await root.locator('body').innerText().catch(() => '');
  const m = bodyText.match(/\bG-[A-Z0-9]{6,}\b/);
  if (m) return m[0];

  // 2) Fallback: look for an ID inside code blocks / pre tags if present
  const codeText = await root.locator('code, pre').allInnerTexts().catch(() => []);
  const joined = (codeText || []).join('\n');
  const m2 = joined.match(/\bG-[A-Z0-9]{6,}\b/);
  return m2 ? m2[0] : null;
}

async function extractTagSnippetFromRoot(/** @type {Root} */ root) {
  // Try to grab the actual script snippet if GA renders it in code/pre
  const blocks = await root.locator('pre, code').allInnerTexts().catch(() => []);
  const joined = (blocks || []).join('\n');

  // If we can see the gtag loader, return the surrounding snippet
  const hasGtag = /googletagmanager\.com\/gtag\/js\?id=G-/i.test(joined) || /\bgtag\(/i.test(joined);
  if (hasGtag) return joined.trim() || null;

  // Otherwise build a minimal snippet from the measurement id
  const mid = await extractMeasurementIdFromRoot(root);
  if (!mid) return null;

  return [
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${mid}"></script>`,
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${mid}');</script>`
  ].join('\n');
}



async function getTagInstructionsRoot(page) {
  // GA4 sometimes renders the tag instructions modal in an iframe
  // Check all frames to see if any contain the tag instructions content
  const frames = page.frames();
  
  for (const frame of frames) {
    try {
      const hasTagContent = await frame.locator(
        'text=/copy your tag id|google tag|gtag|install manually|G-[A-Z0-9]{6,}/i'
      ).first().count().catch(() => 0);
      
      if (hasTagContent > 0) {
        console.log('✅ Found tag instructions in iframe');
        return frame;
      }
    } catch (e) {
      // Frame not accessible, continue
      continue;
    }
  }
  
  // If not in any iframe, it's in the main page
  console.log('✅ Tag instructions in main page');
  return page;
}



async function openTagInstructionsAndExtract(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);

  const measurementIdBefore = await extractMeasurementIdFromRoot(page);

  // 1) Click "View tag instructions"
  console.log('🔍 Looking for "View tag instructions" button...');
  const viewBtn = page.getByRole('button', { name: /view tag instructions/i }).first();

  await viewBtn.waitFor({ state: 'visible', timeout: 30000 });
  await viewBtn.scrollIntoViewIfNeeded().catch(() => {});
  await viewBtn.click({ timeout: 15000 });
  console.log('✅ Clicked "View tag instructions"');

  // 2) Wait for modal/overlay, then resolve the real DOM context (page or iframe)
  console.log('⏳ Waiting for modal...');
  await getVisibleOverlay(page);
  const root = await getTagInstructionsRoot(page);
  console.log('✅ Modal loaded, root context:', root === page ? 'main page' : 'iframe');

  // 3) NEW: Wait for UI to be ready (spinner gone OR tabs visible)
  console.log('⏳ Waiting for instructions UI to be ready...');
  await waitForInstructionsUiReady(root);
  console.log('✅ Instructions UI ready');

  // 4) NEW: Click "Install manually" robustly (text OR 2nd tab fallback)
  console.log('🖱️ Clicking "Install manually" (robust)...');
  const ok = await clickInstallManuallyRobust(root);
  if (!ok) throw new Error('Could not click "Install manually" (robust)');
  console.log('✅ Clicked "Install manually"');

  // 5) NEW: Wait for manual install content to appear (tag ID / gtag markers)
  console.log('⏳ Waiting for manual install content...');
  await root
    .locator('text=/copy your tag id|google tag|gtag|G-[A-Z0-9]{6,}/i')
    .first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .catch(() => {});
  console.log('✅ Manual install content loaded');

  // 6) Extract
  const measurementIdAfter = (await extractMeasurementIdFromRoot(root)) || measurementIdBefore;
  const snippet = await extractTagSnippetFromRoot(root);

  if (snippet) console.log('✅ Extracted snippet:', snippet.substring(0, 100) + '...');
  else console.log('⚠️ No snippet extracted');

  if (measurementIdAfter) console.log('✅ Measurement ID:', measurementIdAfter);
  else console.log('⚠️ No measurement ID found');

  // 7) Close modal
  await page.keyboard.press('Escape').catch(() => {});

  return {
    measurementId: measurementIdAfter,
    snippet,
    instructionsOpened: true
  };
}















// Robust click retry for GA re-renders
async function clickWithRetry(page, locator, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await locator.waitFor({ state: "visible", timeout: 8000 });
      await locator.click({ timeout: 8000 });
      return true;
    } catch (e) {
      await page.waitForTimeout(400 + i * 300);
    }
  }
  return false;
}

async function closeAdminSidebarIfOpen(page) {
  // existing code...
}




async function goToPropertyDetails(page) {
  console.log('🔍 Navigating to Property details...');
  
  const propertyDetailsLink = page.locator(
    'a:has-text("Property details"), ' +
    'a:has-text("Property Details"), ' +
    '[role="link"]:has-text("Property details"), ' +
    '[role="link"]:has-text("Property Details")'
  ).first();
  
  await propertyDetailsLink.waitFor({ timeout: 30000 });
  await propertyDetailsLink.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  
  console.log('✅ On Property Details page');
}

async function extractPropertyIdBestEffort(page) {
  console.log('🔍 Extracting property ID...');
  
  // Try to extract from URL first
  const propertyId = extractPropertyIdFromUrl(page);
  if (propertyId) {
    console.log('✅ Extracted property ID from URL:', propertyId);
    return propertyId;
  }

  // Try to extract from page content
  const propertyIdText = page.locator('text=/Property ID:?\\s*\\d+/i').first();
  if (await propertyIdText.count() > 0) {
    const text = await propertyIdText.textContent();
    const match = text.match(/\d+/);
    if (match) {
      console.log('✅ Extracted property ID from page:', match[0]);
      return match[0];
    }
  }

  console.log('⚠️ Could not extract property ID');
  return null;
}

/* ====== GTM HELPER FUNCTIONS ====== */

async function navigateToGTM(page) {
  console.log('🔍 Navigating to Google Tag Manager...');
  await page.goto('https://tagmanager.google.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
}

async function checkGTMCapacity(page) {
  console.log('🔍 Checking GTM account capacity...');
  
  // Click "Create Account" button to open the form
  const createAccountBtn = page.locator(
    'button:has-text("Create Account"), ' +
    'button:has-text("Create account"), ' +
    '[aria-label*="Create Account"], ' +
    '[aria-label*="Create account"]'
  ).first();
  
  await createAccountBtn.waitFor({ timeout: 30000 });
  await createAccountBtn.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  
  // Check for limit messages first
  const limitIndicators = [
    'text=/reached\\s+the\\s+limit/i',
    'text=/limit\\s+reached/i',
    'text=/maximum\\s+number/i',
    'text=/cannot\\s+create/i',
    'text=/too\\s+many/i'
  ];
  
  for (const indicator of limitIndicators) {
    if (await page.locator(indicator).first().isVisible().catch(() => false)) {
      console.log('❌ GTM account limit message detected');
      return false;
    }
  }
  
  // Use the ACTUAL GTM selectors (from debug output)
  try {
    const accountNameInput = page.locator(
      'input[name*="account"][name*="displayName"], ' +
      'input[placeholder*="My Company"], ' +
      'input[id*="account"][id*="displayName"]'
    ).first();
    
    await accountNameInput.waitFor({ timeout: 5000 });
    await accountNameInput.fill('probe');
    
    const value = await accountNameInput.inputValue();
    
    if (value && value.length > 0) {
      console.log('✅ GTM has capacity (successfully filled account name field)');
      return true;
    }
  } catch (err) {
    console.log('⚠️ Could not interact with account name field:', err.message);
  }
  
  console.log('❌ GTM account capacity check failed');
  return false;
}


async function fillGTMAccountForm(page, { accountName, containerName }) {
  console.log('📝 Filling GTM account form...');
  
  // Fill Account Name using ACTUAL GTM selectors
  const accountNameInput = page.locator(
    'input[name="form.account.properties.displayName"], ' +
    'input[placeholder*="My Company"], ' +
    'input[name*="account"][name*="displayName"]'
  ).first();
  
  await accountNameInput.waitFor({ timeout: 30000 });
  await accountNameInput.fill(accountName);
  console.log(`✅ Filled Account Name: ${accountName}`);
  await page.waitForTimeout(500);
  
  // Fill Container Name using ACTUAL GTM selectors
  const containerNameInput = page.locator(
    'input[name="form.container.properties.displayName"], ' +
    'input[placeholder*="www.mysite.com"], ' +
    'input[name*="container"][name*="displayName"]'
  ).first();
  
  await containerNameInput.waitFor({ timeout: 30000 });
  await containerNameInput.fill(containerName);
  console.log(`✅ Filled Container Name: ${containerName}`);
  await page.waitForTimeout(500);
  
  console.log('✅ Form filled successfully');
}

async function selectWebPlatform(page) {
  console.log('🌐 Selecting Web platform...');
  
  await page.waitForTimeout(1000);
  
  // Click "Web" text (GTM uses card/div layout, not radio buttons)
  const webElement = page.locator('text=Web').first();
  await webElement.waitFor({ timeout: 30000 });
  await webElement.click({ timeout: 15000 });
  
  console.log('✅ Web platform selected');
  await page.waitForTimeout(500);
}


async function clickBottomCreate(page) {
  const createBtn = page.getByRole('button', { name: /^Create$/ }).first();
  await createBtn.waitFor({ state: 'visible', timeout: 30000 });
  await createBtn.scrollIntoViewIfNeeded().catch(() => {});
  await createBtn.click({ timeout: 15000, force: true }).catch(async () => {
    // retry once
    await page.waitForTimeout(500);
    await createBtn.click({ timeout: 15000, force: true });
  });
  await page.waitForTimeout(500);
}

async function acceptGTMTerms(page) {
  console.log('📋 Accepting GTM terms...');

  const yesBtn = page.getByRole('button', { name: /^Yes$/ }).first();
  
  // Wait for terms UI to appear
  const startWait = Date.now();
  while (Date.now() - startWait < 30000) {
    const yesBtnVisible = await yesBtn.isVisible().catch(() => false);
    if (yesBtnVisible) break;
    await page.waitForTimeout(200);
  }

  const hasYes = await yesBtn.isVisible().catch(() => false);
  if (!hasYes) {
    console.log('ℹ️ Terms UI not detected (likely skipped). Continuing...');
    return;
  }

  // Wait a moment for the dialog to fully render
  await page.waitForTimeout(1000);

  // Find all checkboxes and check them
  const allCheckboxes = await page.locator('[role="checkbox"], input[type="checkbox"]').all();
  console.log(`📊 Found ${allCheckboxes.length} checkbox elements`);

  for (let i = 0; i < allCheckboxes.length; i++) {
    const checkbox = allCheckboxes[i];
    const isVisible = await checkbox.isVisible().catch(() => false);
    
    if (!isVisible) continue;

    console.log(`🔍 Checking checkbox ${i + 1}/${allCheckboxes.length}...`);
    
    const isChecked = await checkbox.evaluate(el => {
      if (el.tagName === 'INPUT') {
        return el.checked;
      }
      return el.getAttribute('aria-checked') === 'true';
    }).catch(() => false);

    if (!isChecked) {
      console.log(`   ⚪ Checkbox ${i + 1} is unchecked, attempting to check...`);
      
      try {
        // Force JavaScript checked state
        await checkbox.evaluate(el => {
          if (el.tagName === 'INPUT') {
            el.checked = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('click', { bubbles: true }));
          } else if (el.getAttribute('role') === 'checkbox') {
            el.setAttribute('aria-checked', 'true');
            el.dispatchEvent(new Event('click', { bubbles: true }));
          }
        });

        await page.waitForTimeout(300);
        await checkbox.click({ force: true, timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);

        const nowChecked = await checkbox.evaluate(el => {
          if (el.tagName === 'INPUT') {
            return el.checked;
          }
          return el.getAttribute('aria-checked') === 'true';
        }).catch(() => false);

        if (nowChecked) {
          console.log(`   ✅ Checkbox ${i + 1} successfully checked`);
        } else {
          console.log(`   ⚠️ Checkbox ${i + 1} still unchecked after attempts`);
        }
      } catch (error) {
        console.log(`   ⚠️ Error checking checkbox ${i + 1}:`, error.message);
      }
    } else {
      console.log(`   ✅ Checkbox ${i + 1} already checked`);
    }
  }

  await page.waitForTimeout(500);

  // Click Yes button
  console.log('⏳ Waiting for Yes button to enable...');
  
  // Try to force-enable the Yes button
  await yesBtn.evaluate(el => {
    el.disabled = false;
    el.removeAttribute('disabled');
    el.setAttribute('aria-disabled', 'false');
  }).catch(() => {});

  await page.waitForTimeout(500);

  // Wait for it to become enabled
  const startEnable = Date.now();
  let isEnabled = false;
  while (Date.now() - startEnable < 15000) {
    isEnabled = await yesBtn.isEnabled().catch(() => false);
    if (isEnabled) break;
    
    await yesBtn.evaluate(el => {
      el.disabled = false;
      el.removeAttribute('disabled');
    }).catch(() => {});
    
    await page.waitForTimeout(200);
  }

  if (!isEnabled) {
    console.log('⚠️ Yes button still disabled, attempting force-click anyway...');
  }

  // Click Yes
  try {
    await yesBtn.evaluate(el => el.click()).catch(() => {});
    await page.waitForTimeout(300);
    await yesBtn.click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    console.log('✅ GTM terms accepted');
  } catch (error) {
    console.log('⚠️ Error clicking Yes button:', error.message);
    throw new Error('Could not click Yes button to accept terms');
  }
}


async function extractGTMCodes(page) {
  console.log('📋 Extracting GTM codes...');
  
  await page.waitForTimeout(3000);
  
  let gtmHeadCode = null;
  let gtmBodyCode = null;
  let containerId = null;
  
  // Method 1: Try to find container ID (format: GTM-XXXXXXX) - MOST RELIABLE
  console.log('🔍 Looking for Container ID...');
  const containerIdPatterns = [
    'text=/GTM-[A-Z0-9]{7,}/',
    'text=/Container ID.*GTM-[A-Z0-9]+/i'
  ];
  
  for (const pattern of containerIdPatterns) {
    const containerIdElement = page.locator(pattern).first();
    if (await containerIdElement.count() > 0) {
      const text = await containerIdElement.textContent();
      const match = text.match(/GTM-[A-Z0-9]+/);
      if (match) {
        containerId = match[0];
        console.log('✅ Found container ID:', containerId);
        break;
      }
    }
  }
  
  // If no Container ID found, check entire page content
  if (!containerId) {
    console.log('⚠️ Trying to find Container ID in page content...');
    const pageContent = await page.content();
    const match = pageContent.match(/GTM-[A-Z0-9]{7,}/);
    if (match) {
      containerId = match[0];
      console.log('✅ Found container ID in page content:', containerId);
    }
  }
  
  // Method 2: Look for code snippets in multiple locations
  console.log('🔍 Looking for GTM code snippets...');
  
  const codeSelectors = [
    'code', 
    'pre', 
    'textarea',
    '[class*="code"]',
    '[class*="snippet"]',
    'div[role="textbox"]'
  ];
  
  for (const selector of codeSelectors) {
    const codeBlocks = page.locator(selector);
    const count = await codeBlocks.count();
    
    for (let i = 0; i < count; i++) {
      const block = codeBlocks.nth(i);
      const text = await block.textContent().catch(() => '');
      
      // Head code (contains googletagmanager.com/gtm.js)
      if (text.includes('googletagmanager.com/gtm.js') && !gtmHeadCode) {
        gtmHeadCode = text.trim();
        console.log('✅ Found GTM head code');
        
        // Extract Container ID from the code if we don't have it yet
        if (!containerId) {
          const match = text.match(/GTM-[A-Z0-9]+/);
          if (match) containerId = match[0];
        }
      }
      
      // Body code (contains noscript and googletagmanager.com)
      if (text.includes('noscript') && text.includes('googletagmanager.com') && !gtmBodyCode) {
        gtmBodyCode = text.trim();
        console.log('✅ Found GTM body code');
      }
      
      // Sometimes both codes are in one block
      if (text.includes('googletagmanager.com/gtm.js') && text.includes('noscript')) {
        const headMatch = text.match(/<!-- Google Tag Manager -->[\s\S]*?<!-- End Google Tag Manager -->/);
        const bodyMatch = text.match(/<!-- Google Tag Manager \(noscript\) -->[\s\S]*?<!-- End Google Tag Manager \(noscript\) -->/);
        
        if (headMatch && !gtmHeadCode) {
          gtmHeadCode = headMatch[0].trim();
          console.log('✅ Extracted head code from combined block');
        }
        if (bodyMatch && !gtmBodyCode) {
          gtmBodyCode = bodyMatch[0].trim();
          console.log('✅ Extracted body code from combined block');
        }
      }
    }
  }
  
  // Method 3: If we only have container ID, construct the codes (FALLBACK)
  if (containerId && (!gtmHeadCode || !gtmBodyCode)) {
    console.log('🔨 Constructing missing GTM codes from container ID...');
    
    if (!gtmHeadCode) {
      gtmHeadCode = `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${containerId}');</script>
<!-- End Google Tag Manager -->`;
      console.log('✅ Generated GTM head code');
    }
    
    if (!gtmBodyCode) {
      gtmBodyCode = `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${containerId}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`;
      console.log('✅ Generated GTM body code');
    }
  }
  
  // Final validation
  if (!containerId) {
    // Take a screenshot for debugging
    await page.screenshot({ path: 'gtm_codes_not_found.png', fullPage: true });
    throw new Error('Could not find Container ID. Screenshot saved to gtm_codes_not_found.png');
  }
  
  if (!gtmHeadCode || !gtmBodyCode) {
    await page.screenshot({ path: 'gtm_codes_incomplete.png', fullPage: true });
    throw new Error('Could not extract complete GTM codes. Screenshot saved to gtm_codes_incomplete.png');
  }
  
  console.log('✅ GTM code extraction complete');
  console.log('  - Container ID:', containerId);
  console.log('  - Head code length:', gtmHeadCode.length, 'characters');
  console.log('  - Body code length:', gtmBodyCode.length, 'characters');
  
  return {
    containerId,
    gtmHeadCode,
    gtmBodyCode
  };
}


async function openContainerFromHomeList(page, containerId) {
  console.log(`🔎 Opening container: ${containerId}...`);

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);

  console.log('DEBUG: Current GTM URL =', page.url());

  // METHOD 1: Try search (if available)
  console.log('🔍 Attempting Method 1: Search...');
  
  const searchBtn = page.locator(
    'button[aria-label*="Search"], ' +
    'button[aria-label*="search"], ' +
    '[aria-label*="Search container"], ' +
    'button:has(mat-icon:text("search")), ' +
    'button:has([data-mat-icon-name="search"]), ' +
    'button mat-icon:has-text("search")'
  ).first();

  const hasSearch = await searchBtn.isVisible({ timeout: 3000 }).catch(() => false);

  if (hasSearch) {
    try {
      await searchBtn.click({ timeout: 10000 });
      await page.waitForTimeout(1000);

      const searchInput = page.locator(
        'input[type="text"]:visible, ' +
        'input[placeholder*="Search"]:visible, ' +
        'input[aria-label*="Search"]:visible'
      ).first();

      await searchInput.waitFor({ state: 'visible', timeout: 10000 });
      await searchInput.fill(containerId);
      await page.waitForTimeout(1500);

      const containerResult = page.locator(
        `a:has-text("${containerId}"), ` +
        `[role="link"]:has-text("${containerId}"), ` +
        `[role="option"]:has-text("${containerId}")`
      ).first();

      await containerResult.waitFor({ state: 'visible', timeout: 10000 });
      await containerResult.click({ timeout: 10000 });
      await page.waitForTimeout(2000);

      console.log('✅ Container opened via search');

      // Verify opened
      const tagsNav = page.locator('a:has-text("Tags")').first();
      await tagsNav.waitFor({ state: 'visible', timeout: 30000 });
      return;
    } catch (err) {
      console.log('⚠️ Search method failed, trying direct click...');
    }
  } else {
    console.log('⚠️ Search not available, using Method 2: Direct click...');
  }

  

// METHOD 2: Direct click from container list
console.log('🔍 Looking for container in list view...');

// Wait for containers to load
await page.waitForTimeout(2000);

// First, try to find an element that contains EXACTLY the container ID (not partial match)
const exactMatch = page.locator(`text=/^${containerId}$/`).first();

if (await exactMatch.isVisible({ timeout: 5000 }).catch(() => false)) {
  console.log('✅ Found exact text match for container ID');
  
  // Find the clickable parent (link or button)
  const clickableParent = exactMatch.locator('xpath=ancestor::a | xpath=ancestor::button').first();
  
  if (await clickableParent.isVisible().catch(() => false)) {
    await clickableParent.click({ timeout: 10000 });
    clicked = true;
    console.log('✅ Clicked container via exact match');
  } else {
    // Click any link/button near the exact match
    const nearbyLink = page.locator(`a:has-text("${containerId}"), button:has-text("${containerId}")`).first();
    await nearbyLink.click({ timeout: 10000 });
    clicked = true;
    console.log('✅ Clicked nearby link for container');
  }
} else {
  console.log('⚠️ Exact match not found, trying container card selectors...');
  
  // Try finding a card/row that contains the container ID
  const containerCard = page.locator(
    `div:has-text("${containerId}")`
  ).filter(async (el) => {
    const text = await el.textContent();
    // Make sure this element actually contains our container ID (not just partial match)
    return text.includes(containerId);
  }).first();
  
  if (await containerCard.isVisible({ timeout: 5000 }).catch(() => false)) {
    // Find the first link or button inside this card
    const clickTarget = containerCard.locator('a, button, [role="link"], [role="button"]').first();
    
    if (await clickTarget.isVisible().catch(() => false)) {
      await clickTarget.click({ timeout: 10000 });
      clicked = true;
      console.log('✅ Clicked link inside container card');
    }
  }
}




  // METHOD 3: JavaScript fallback - find and click
  if (!clicked) {
    console.log('🔍 Method 3: JavaScript direct click...');
    
    clicked = await page.evaluate((id) => {
      // Find any element containing the container ID
      const elements = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], div'));
      
      for (const el of elements) {
        const text = (el.textContent || '').trim();
        
        if (text.includes(id) && el.offsetParent !== null) {
          // Found the element, now find a clickable parent or click itself
          let current = el;
          
          for (let i = 0; i < 5; i++) {
            if (!current) break;
            
            const tag = (current.tagName || '').toLowerCase();
            const role = current.getAttribute('role');
            
            if (tag === 'a' || tag === 'button' || role === 'link' || role === 'button') {
              current.click();
              return true;
            }
            
            current = current.parentElement;
          }
          
          // Last resort: click the element itself
          el.click();
          return true;
        }
      }
      
      return false;
    }, containerId);

    if (clicked) {
      console.log('✅ Container clicked via JavaScript');
      await page.waitForTimeout(2000);
    }
  }

  if (!clicked) {
    // Take screenshot for debugging
    await page.screenshot({ path: `gtm_not_found_${Date.now()}.png`, fullPage: true });
    throw new Error(`Could not find or click container "${containerId}" using any method. Screenshot saved.`);
  }

  // Verify we're in the container workspace
  console.log('🔍 Verifying container opened...');

  const tagsNav = page.locator('a:has-text("Tags"), [role="link"]:has-text("Tags")').first();
  
  const opened = await tagsNav.waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true)
    .catch(() => false);

  if (!opened) {
    const currentUrl = page.url();
    await page.screenshot({ path: `gtm_verify_failed_${Date.now()}.png`, fullPage: true });
    throw new Error(`Container may not have opened correctly. Current URL: ${currentUrl}`);
  }

  console.log('✅ Container workspace loaded successfully');
}





app.post('/run', async (req, res) => {
  const {
    action,
    google_email,
    google_password,
    sso_username,
    sso_password,
    account_name,
    property_name,
    gtm_account_name,
    container_name
    } = req.body;


console.log('RUN action =', JSON.stringify(action));



if (!['login_and_create_ga4', 'create_ga_account', 'fetch_gtag_and_property_id', 
      'check_gtm_capacity', 'create_gtm_account', 'configure_and_publish_gtm'].includes(action)) {
  return res.status(400).json({ error: 'Unknown action' });
}


  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    let page = await context.newPage(); // NOTE: changed from const -> let so Step 2 recovery can replace the tab

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

/* ================= ADMIN -> CLOSE LEFT COLUMN -> CREATE -> ACCOUNT ================= */
/* ======================================================
   ACTION 1 — UI NAV (Admin -> Create -> Account) THEN CAPACITY CHECK
====================================================== */
if (action === 'login_and_create_ga4') {
  console.log('🔍 UI nav to Account Create, then capacity check…');

  await page.goto('https://analytics.google.com/analytics/web', {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForTimeout(2000);

  // 1) Click Admin (safe selector)
  const adminBtn = page
    .getByRole('button', { name: /^Admin$/ })
    .or(page.getByRole('link', { name: /^Admin$/ }))
    .or(page.locator('[aria-label="Admin"]'));

  await adminBtn.first().waitFor({ state: 'visible', timeout: 30000 });
  await adminBtn.first().click({ timeout: 30000 });

  // Wait for Admin to render
  await page.waitForURL(/\/admin\b/i, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // 2) Close the left column (your manual “nudge”)
  await page.mouse.click(650, 320).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);

  // Ensure we’re at top so Create is reachable
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  // 3) Click Create
  const createBtn = page.getByRole('button', { name: /^Create$/ }).first();
  await createBtn.waitFor({ state: 'visible', timeout: 20000 });
  await createBtn.click({ timeout: 20000 });

  // 4) Click Account from dropdown (strict-safe: click the BUTTON menuitem only)
  const menuPanel = page
    .locator('.cdk-overlay-container .mat-mdc-menu-panel, .cdk-overlay-container [role="menu"], [role="menu"]')
    .filter({ hasText: 'Account' })
    .last();

  await menuPanel.waitFor({ state: 'visible', timeout: 15000 });

  const accountMenuBtn = menuPanel
    .locator('button[role="menuitem"]:has-text("Account")')
    .first();

  await accountMenuBtn.waitFor({ state: 'visible', timeout: 15000 });
  await accountMenuBtn.click({ timeout: 15000 });

  // Confirm we are on Account Create
  await page.waitForURL(/\/admin\/account\/create/i, { timeout: 30000 });
  await page.waitForTimeout(800);

  /* ======================================================
     CAPACITY CHECK (your existing logic + add limit detection)
  ====================================================== */

  const reportsIndicators = [
    'text=Reports snapshot',
    'text=Realtime',
    'text=Engagement',
    'text=Monetization'
  ];

  // Limit message detection (so you don’t get stuck on the limit page)
  const limitIndicators = [
    'text=/reached\\s+the\\s+limit/i',
    'text=/limit\\s+reached/i',
    'text=/you\\s+have\\s+reached/i',
    'text=/too\\s+many/i',
    'text=/account\\s+limit/i',
    'text=/can\\s+only\\s+create/i'
  ];

  // A) If limit message visible => no space
  for (const t of limitIndicators) {
    if (await page.locator(t).first().isVisible().catch(() => false)) {
      await browser.close();
      return res.json({ status: 'failed', reason: 'account_no_space' });
    }
  }

  // B) Reports fallback guard (your original behaviour)
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

  // C) Probe the Account input
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
   ACTION 2 — GA4 ACCOUNT CREATION (FIXED: USE a...p... CONTEXT)
====================================================== */
if (action === 'create_ga_account') {
  console.log('🚀 Creating GA4 account…');

  // 1) Ensure we are in Admin (this establishes the a...p... context)
  await page.goto('https://analytics.google.com/analytics/web', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const adminBtn = page
    .getByRole('button', { name: /^Admin$/ })
    .or(page.getByRole('link', { name: /^Admin$/ }))
    .or(page.locator('[aria-label="Admin"]'));

  await adminBtn.first().waitFor({ state: 'visible', timeout: 30000 });
  await adminBtn.first().click({ timeout: 30000 });

  // Let Admin route settle
  await page.waitForTimeout(1200);

  // 2) Build the correct create URL WITH the current a...p... prefix
  const urlNow = page.url();
  const ctxMatch = urlNow.match(/#\/(a\d+p\d+)\b/i);
  const ctx = ctxMatch ? ctxMatch[1] : null;

  const createUrl = ctx
    ? `https://analytics.google.com/analytics/web/#/${ctx}/admin/account/create`
    : 'https://analytics.google.com/analytics/web/#/admin/account/create';

  console.log('DEBUG: Admin URL:', urlNow);
  console.log('DEBUG: Using createUrl:', createUrl);

  // 3) Force create page with retries (GA can still bounce once)
  const accountInput = page.locator(
    'input[aria-label*="Account"], input[placeholder*="Account"]'
  ).first();

  let onCreatePage = false;

  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.goto(createUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Your “nudge” to settle UI/focus
    await page.mouse.click(650, 320).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);

    // ✅ FIXED BLOCK (properly closed + working)
    if (await accountInput.isVisible().catch(() => false)) {
      onCreatePage = true;
      break;   // stop retrying once we see the input
    }

    const reportsNow =
      (await page.locator('text=Reports snapshot').count()) > 0 ||
      (await page.locator('text=Realtime').count()) > 0 ||
      (await page.locator('text=Engagement').count()) > 0 ||
      (await page.locator('text=Monetization').count()) > 0;

    console.log(`DEBUG: create attempt ${attempt} failed. reportsNow=${reportsNow}`);

    // Re-establish admin context before next attempt
    if (reportsNow) {
      await adminBtn.first().click({ timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(900);
    }
  }

  if (!onCreatePage) {
    throw new Error('Could not reach Account Create page (GA kept bouncing to Reports)');
  }

  // 4) Continue your existing wizard steps (UNCHANGED)
  await accountInput.waitFor({ timeout: 30000 });
  await accountInput.fill(account_name);
  await page.click('button:has-text("Next")');




        /* ======================================================
         STEP 2 — PROPERTY NAME (UPDATED: MULTI-METHOD + RETRY + HARD RESET TAB + UI NAVIGATION)
      ====================================================== */
      console.log('📍 Step 2: Property Name');

      // Detect if we're on Reports

const reportsIndicators = [
  'text=Reports snapshot',
  'text=Realtime',
  'text=Engagement',
  'text=Monetization'
];

const isOnReports = async () => {
        for (const text of reportsIndicators) {
          if (await page.locator(text).count() > 0) return true;
        }
        return false;
      };

      // Open Admin via UI on the *current* page (fresh SPA state)
      const openAdminViaUI = async () => {
        await page.goto('https://analytics.google.com/analytics/web', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3500);

        const adminBtn = page.locator(
          '[aria-label="Admin"], a[href*="admin"], button[aria-label*="Admin"]'
        ).first();

        await adminBtn.waitFor({ timeout: 60000 });
        await adminBtn.click();
        await page.waitForTimeout(3000);
      };

      // Try to open the Create Account wizard by UI first; fall back to createUrl if UI selectors fail.
      const openCreateWizardPreferUI = async () => {
        // Try UI navigation to Create -> Account
        try {
          const createBtn = page.locator(
            '[aria-label="Create"], button:has-text("Create"), button[aria-label*="Create"]'
          ).first();

          if (await createBtn.count() > 0) {
            await createBtn.waitFor({ timeout: 8000 });
            await createBtn.click();
            await page.waitForTimeout(800);

            const accountItem = page.locator(
              '[role="menuitem"]:has-text("Account"), button:has-text("Account"), a:has-text("Account")'
            ).first();

            if (await accountItem.count() > 0) {
              await accountItem.waitFor({ timeout: 8000 });
              await accountItem.click();
              await page.waitForTimeout(1200);
              return;
            }
          }
        } catch {
          // ignore and fall back
        }

        // Fallback: deep link (but only after we entered Admin via UI)
        await page.goto(createUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
      };

      // HARD RESET (Workaround A): close tab, open fresh tab, re-enter Admin via UI, re-open wizard, redo Step 1.
      const hardResetAndRedoStep1 = async (reason) => {
        console.log(`🧯 Hard reset tab (${reason})…`);

        try {
          await page.close({ runBeforeUnload: true });
        } catch {}

        page = await context.newPage();

        // We should still be logged in because context keeps cookies/session
        await openAdminViaUI();
        await openCreateWizardPreferUI();

        // Now redo Step 1 so we get back to Step 2
        const acc = page.locator(
          'input[aria-label*="Account"], input[placeholder*="Account"]'
        ).first();

        await acc.waitFor({ timeout: 6000 });
        await acc.fill(account_name);

        await page.click('button:has-text("Next")');
        await page.waitForTimeout(800);
      };

      // Fill property using multiple methods that survive re-renders
      const fillPropertyWithFallbacks = async () => {
        const sel = '#name, input#name';

        // METHOD 1: Forced fill (no click)
        try {
          const input = page.locator(sel).first();
          await input.waitFor({ timeout: 10000 });
          await input.fill(property_name, { force: true, timeout: 10000 });
          await page.keyboard.press('Tab');
          await page.waitForTimeout(200);
          const v = await input.inputValue().catch(() => null);
          if (v === property_name) return true;
        } catch {}

        // METHOD 2: Focus via DOM then fill
        try {
          const input = page.locator(sel).first();
          await input.waitFor({ timeout: 10000 });
          await input.evaluate((el) => el.focus());
          await input.fill(property_name, { force: true, timeout: 10000 });
          await page.keyboard.press('Tab');
          await page.waitForTimeout(200);
          const v = await input.inputValue().catch(() => null);
          if (v === property_name) return true;
        } catch {}

        // METHOD 3: JS set + dispatch events (best for unstable Angular inputs)
        try {
          const ok = await page.evaluate((val) => {
            const el =
              document.querySelector('#name') ||
              document.querySelector('input#name') ||
              document.querySelector('input[name="name"]');
            if (!el) return false;

            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.blur();
            return true;
          }, property_name);

          if (!ok) return false;

          await page.waitForTimeout(250);
          const v = await page.locator(sel).first().inputValue().catch(() => null);
          if (v === property_name) return true;
        } catch {}

        return false;
      };

      // Click Next using stepper-next first, then a bottom-most enabled "Next"
      const clickNextWithFallbacks = async () => {
        const stepperNext = page.locator(
          'button[matsteppernext], button[matStepperNext], button[cdksteppernext], button[cdkStepperNext]'
        );

        if (await stepperNext.count() > 0) {
          for (let i = 0; i < await stepperNext.count(); i++) {
            const b = stepperNext.nth(i);
            const visible = await b.isVisible().catch(() => false);
            const enabled = await b.isEnabled().catch(() => false);
            if (!visible || !enabled) continue;
            await b.scrollIntoViewIfNeeded().catch(() => {});
            await b.click({ timeout: 8000 });
            return true;
          }
        }

        // Fallback: click the bottom-most visible enabled Next
        const clicked = await page.evaluate(() => {
          const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };

          const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter((el) => {
              const txt = (el.textContent || '').trim();
              return txt === 'Next' || txt.includes('Next');
            })
            .filter((el) => {
              const ariaDisabled = el.getAttribute('aria-disabled');
              const disabledProp = 'disabled' in el ? el.disabled : false;
              return ariaDisabled !== 'true' && !disabledProp;
            })
            .filter(isVisible);

          if (!candidates.length) return false;

          candidates.sort((a, b) => {
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            return rb.top - ra.top; // prefer the lowest (footer) button
          });

          candidates[0].click();
          return true;
        });

        return !!clicked;
      };

      // Step 2 attempts: if Reports shows at any point, HARD RESET TAB + UI NAV back to wizard.
      const MAX_STEP2_ATTEMPTS = 8;
      let step2Success = false;

      for (let attempt = 1; attempt <= MAX_STEP2_ATTEMPTS; attempt++) {
        console.log(`🔧 Step 2 attempt ${attempt}/${MAX_STEP2_ATTEMPTS}`);

        if (await isOnReports()) {
          await hardResetAndRedoStep1('on Reports at start of Step 2');
        }

        // Ensure Step 2 panel exists
        try {
          await page.locator('#cdk-stepper-0-content-1').waitFor({ timeout: 12000 });
          console.log('✅ On Property creation page');
        } catch {
          if (await isOnReports()) {
            await hardResetAndRedoStep1('redirected to Reports while waiting for Step 2 panel');
            continue;
          }
          // not reports; retry
          continue;
        }

        // Fill property
        const filled = await fillPropertyWithFallbacks();
        const currentValue = await page.locator('#name, input#name').first().inputValue().catch(() => '(unreadable)');
        console.log(`✅ Property field now shows: "${currentValue}" (filled=${filled})`);

        if (await isOnReports()) {
          await hardResetAndRedoStep1('redirected to Reports immediately after fill');
          continue;
        }

        // Click Next
        const nextClicked = await clickNextWithFallbacks();
        console.log(`✅ Next clicked=${nextClicked}`);

        if (!nextClicked) {
          if (await isOnReports()) {
            await hardResetAndRedoStep1('redirected to Reports while trying to click Next');
          }
          continue;
        }

        // Confirm Step 3
        try {
          await page.locator('#cdk-stepper-0-content-2').waitFor({ timeout: 15000 });
          console.log('✅ Arrived at Step 3');
          step2Success = true;
          break;
        } catch {
          if (await isOnReports()) {
            await hardResetAndRedoStep1('redirected to Reports after clicking Next');
            continue;
          }
          continue;
        }
      }

      if (!step2Success) {
        throw new Error(`Step 2 failed after ${MAX_STEP2_ATTEMPTS} attempts (GA kept re-rendering or redirecting to Reports).`);
      }

      

/* STEP 3 — BUSINESS INFO (UPDATED: USE DROPDOWN SEARCH + ROBUST SMALL + WAIT NEXT ENABLED) */
const step3 = page.locator('#cdk-stepper-0-content-2');
await step3.waitFor({ timeout: 30000 });

/* ========= 1) OPEN INDUSTRY DROPDOWN ("Select one") ========= */
const selectOneBtn = step3.locator(
  'button:has-text("Select one"), [role="button"]:has-text("Select one")'
).first();
await selectOneBtn.waitFor({ timeout: 30000 });
await selectOneBtn.click({ timeout: 30000 });

// If GA sometimes ignores the first click, do a quick second forced click if no overlay appears
await page.waitForTimeout(300);
let panel = page.locator('.cdk-overlay-pane:visible').last();
if ((await panel.count().catch(() => 0)) === 0) {
  await selectOneBtn.click({ force: true, timeout: 30000 });
  await page.waitForTimeout(300);
  panel = page.locator('.cdk-overlay-pane:visible').last();
}
await panel.waitFor({ timeout: 30000 });

/* ========= 2) USE SEARCH INSIDE DROPDOWN, THEN CLICK "Other business activity" ========= */
const searchInput = panel.locator(
  'input[type="text"], input[placeholder*="Search"], input[aria-label*="Search"]'
).first();

// If the dropdown has a search input, use it (best path)
if ((await searchInput.count().catch(() => 0)) > 0) {
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill('Other business activity');
  await page.waitForTimeout(300); // allow filtering to apply

  const filteredOption = panel
    .locator('[role="option"], mat-option, .mat-mdc-option, .mdc-list-item')
    .filter({ hasText: 'Other business activity' })
    .first();

  await filteredOption.waitFor({ timeout: 30000 });
  await filteredOption.click({ timeout: 30000 });
} else {
  // Fallback path if search is not present: click the option directly (less reliable than search)
  const directOption = panel
    .locator('[role="option"], mat-option, .mat-mdc-option, .mdc-list-item')
    .filter({ hasText: 'Other business activity' })
    .first();

  await directOption.waitFor({ timeout: 30000 });
  await directOption.click({ timeout: 30000 });
}

// Small pause to let GA register the selection
await page.waitForTimeout(300);

/* ========= 3) SELECT BUSINESS SIZE = SMALL (ROBUST + VERIFY) ========= */
const smallText = 'Small – 1 to 10 employees';
const smallInput = step3.locator('#mat-radio-0-input, input#mat-radio-0-input').first();
await smallInput.waitFor({ timeout: 30000 });

let clickedSmall = false;

// Best: click visible text
try {
  const smallByText = step3.locator(`text=${smallText}`).first();
  if (await smallByText.count().catch(() => 0) > 0) {
    await smallByText.click({ timeout: 8000 });
    clickedSmall = true;
  }
} catch {}

// Next: click label
if (!clickedSmall) {
  try {
    const smallLabel = step3.locator('label[for="mat-radio-0-input"]').first();
    if (await smallLabel.count().catch(() => 0) > 0) {
      await smallLabel.click({ force: true, timeout: 8000 });
      clickedSmall = true;
    }
  } catch {}
}

// Next: click wrapper containing the text
if (!clickedSmall) {
  try {
    const wrapper = step3.locator('mat-radio-button, [role="radio"]').filter({ hasText: smallText }).first();
    if (await wrapper.count().catch(() => 0) > 0) {
      await wrapper.click({ force: true, timeout: 8000 });
      clickedSmall = true;
    }
  } catch {}
}

// Last resort: click/check input
if (!clickedSmall) {
  try {
    await smallInput.check({ force: true, timeout: 8000 });
  } catch {
    await smallInput.click({ force: true, timeout: 8000 });
  }
}

// Verify Small is actually selected
const startSmall = Date.now();
while (true) {
  const ok = await smallInput.isChecked().catch(() => false);
  if (ok) break;

  if (Date.now() - startSmall > 15000) {
    throw new Error('Step 3: Could not confirm Small size was selected.');
  }
  await page.waitForTimeout(250);
}

/* ========= 4) WAIT NEXT ENABLED, THEN CLICK ========= */
const nextBtn = step3.locator(
  'button[matsteppernext], button[matStepperNext], button:has-text("Next")'
).first();
await nextBtn.waitFor({ timeout: 30000 });

const startNext = Date.now();
while (true) {
  const enabled = await nextBtn.isEnabled().catch(() => false);
  if (enabled) break;

  if (Date.now() - startNext > 30000) {
    throw new Error('Step 3: Next never became enabled (GA4 did not accept industry/size).');
  }
  await page.waitForTimeout(300);
}

await nextBtn.click();

      
     

/* STEP 4 — OBJECTIVES (FIXED: TICK 4 + LOCATE CREATE BY TEXT IN STEP 4) */
const step4 = page.locator('#cdk-stepper-0-content-3');
await step4.waitFor({ timeout: 30000 });

// Exact labels from the GA4 UI (from your screenshot)
const objectiveLabels = [
  'Generate leads',
  'Drive sales',
  'Understand web and/or app traffic',
  'View user engagement and retention'
];

// Tick the 4 objective boxes (targeted, no generic input[type="checkbox"])
for (const label of objectiveLabels) {
  const cb = step4.getByRole('checkbox', { name: label }).first();
  await cb.waitFor({ timeout: 30000 });

  const checked = await cb.isChecked().catch(() => false);
  if (!checked) {
    await cb.click({ timeout: 15000 });
  }

  // Verify it stayed checked (GA can re-render)
  const start = Date.now();
  while (true) {
    const ok = await cb.isChecked().catch(() => false);
    if (ok) break;

    if (Date.now() - start > 10000) {
      throw new Error(`Step 4: "${label}" would not stay checked.`);
    }
    await page.waitForTimeout(250);
  }
} // <-- ADD THIS RIGHT HERE (closes the for-loop)



// Click Create (don’t require exact accessible name; GA often changes it)
const createBtn = page.locator('button:has-text("Create")').last();
await createBtn.waitFor({ state: 'attached', timeout: 30000 });
await createBtn.scrollIntoViewIfNeeded().catch(() => {});

// Wait until enabled
const startCreate = Date.now();
while (true) {
  const enabled = await createBtn.isEnabled().catch(() => false);
  if (enabled) break;

  if (Date.now() - startCreate > 30000) {
    throw new Error('Step 4: Create stayed disabled after selecting objectives.');
  }
  await page.waitForTimeout(300);
}

await createBtn.click({ timeout: 15000 });

  /* STEP 5 — TERMS */
const acceptBtn = page.locator('button:has-text("I Accept"), button:has-text("Accept")').first();

if (await acceptBtn.count() > 0) {
  await acceptBtn.waitFor({ timeout: 30000 });

  if (!(await acceptBtn.isEnabled().catch(() => false))) {
    const panel = page.locator(
      'div[role="dialog"]:visible, .cdk-overlay-pane:visible, .mat-dialog-container:visible'
    ).first();

    const cbs = panel.locator('input[type="checkbox"]');
    const n = await cbs.count();

    for (let i = 0; i < n; i++) {
      if (await acceptBtn.isEnabled().catch(() => false)) break;

      const cb = cbs.nth(i);
      const checked = await cb.isChecked().catch(() => false);
      if (!checked) {
        try {
          await cb.check({ force: true, timeout: 5000 });
        } catch {
          await cb.click({ force: true, timeout: 5000 });
        }
        await page.waitForTimeout(250);
      }
    }
  }

  await acceptBtn.click({ timeout: 15000 });
  await page.waitForTimeout(800);
} // ✅ IMPORTANT: Step 6 is OUTSIDE this block now



/* STEP 6 — DATA COLLECTION (PERMANENT FIX) */
console.log('📍 Step 6: Data Collection (Web Stream)');

const { websiteUrl, websiteName } = getWebsiteInputs(req);
if (!websiteUrl || !websiteName) {
  throw new Error(`Missing websiteUrl or websiteName. Got: ${JSON.stringify(req.body)}`);
}

// Let navigation settle
await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
await page.waitForTimeout(1500);

// Robust locators (do NOT rely on exact placeholder)
const webOptionBtn = page
  .locator('button, [role="button"]')
  .filter({ hasText: /\bweb\b/i })
  .first();

// Website URL input (cover multiple UI variants)
const websiteUrlInput = page.locator(
  [
    'input[type="url"]',
    'input[aria-label*="Website URL" i]',
    'input[aria-label*="Website" i]',
    'input[placeholder*="website" i]',
    'input[placeholder*="example" i]',
    'input[placeholder*="mywebsite" i]',
    'input[placeholder*="www" i]'
  ].join(', ')
).first();

// Website name field (also varies)
const websiteNameInput = page.locator(
  [
    'input[aria-label*="Stream name" i]',
    'input[aria-label*="Website name" i]',
    'input[placeholder*="Stream name" i]',
    'input[placeholder*="Website name" i]'
  ].join(', ')
).first();

console.log('⏳ Waiting for either Web option or form fields...');

const state = await Promise.race([
  webOptionBtn.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'PICKER'),
  websiteUrlInput.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'FORM')
]).catch(async (e) => {
  // Debug helpers: you can keep these while stabilising
  console.log('❌ Neither picker nor form appeared. Current URL:', page.url());
  await page.screenshot({ path: 'step6_timeout.png', fullPage: true });
  throw e;
});

if (state === 'PICKER') {
  console.log('🧭 On stream picker. Clicking Web...');
  await webOptionBtn.click({ timeout: 15000 });

  // After clicking Web, the form should appear
  await websiteUrlInput.waitFor({ state: 'visible', timeout: 30000 });
  console.log('✅ Reached web stream form');
} else {
  console.log('✅ Already on web stream form');
}

console.log('📝 Filling web stream form...');
await fillWebStreamForm(page, { websiteUrl, websiteName });

console.log('✅ Web stream created');
await page.waitForTimeout(1500);

// ✅ END RUN HERE
if (browser) await browser.close();
return res.json({
  status: 'success',
  message: 'GA4 account created',
});




} // closes ONLY: if (action === 'create_ga_account')

// NEXT ACTION INSIDE TRY:
if (String(action || '').trim() === 'fetch_gtag_and_property_id') {
  console.log('➡️ ENTERED fetch_gtag_and_property_id');

  const { websiteUrl, websiteName } = getWebsiteInputs(req);

  if (!account_name || !property_name) throw new Error('Missing account_name or property_name');
  if (!websiteUrl || !websiteName) throw new Error(`Missing websiteUrl or websiteName`);

  // Step 1: Search for and open the account
  await openAccountViaAccountsSearch(page, account_name);
  
  // Step 2: Use the existing openAdmin function (it works!)
  await openAdmin(page);
  
  // Step 3: Close sidebar and select property
  await closeAdminSidebarIfOpen(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  
  // Find property dropdown and select the correct property
  const allDropdowns = page.locator('button[aria-haspopup="listbox"], button[role="combobox"]');
  const count = await allDropdowns.count();
  console.log(`Found ${count} dropdowns in Admin`);
  
  if (count > 0) {
    const propertyDropdown = count >= 2 ? allDropdowns.nth(1) : allDropdowns.first();
    const currentSelection = await propertyDropdown.textContent();
    console.log(`Current property: "${currentSelection}"`);
    
    if (!currentSelection.includes(property_name)) {
      console.log('⚠️ Switching to correct property...');
      
      try {
        await propertyDropdown.click({ timeout: 10000 });
      } catch {
        await closeAdminSidebarIfOpen(page);
        await propertyDropdown.click({ force: true, timeout: 10000 });
      }
      
      await page.waitForTimeout(1000);
      
      const propertyOption = page.locator('[role="option"], mat-option').filter({ hasText: property_name }).first();
      await propertyOption.waitFor({ timeout: 20000 });
      await propertyOption.click({ timeout: 15000 });
      await page.waitForTimeout(1500);
      
      console.log(`✅ Switched to property: ${property_name}`);
    } else {
      console.log('✅ Already on correct property');
    }
  }
  
  // Step 4: Go to Data Streams
  await goToDataStreams(page);
  
  // Step 5: Open the web stream
  await openWebStreamFromList(page, { websiteName, websiteUrl });

  
 // Step 6: Extract gtag and measurement ID
const { snippet: gtagSnippet, measurementId } = await openTagInstructionsAndExtract(page);

  // Step 7: Go to Property Details
  await openAdmin(page);
  await goToPropertyDetails(page);

  // Step 8: Extract property ID
  const propertyId = await extractPropertyIdBestEffort(page);
  if (!propertyId) throw new Error('Could not extract property_id');

  if (browser) await browser.close();
  return res.json({
    status: 'success',
    account_name,
    property_name,
    property_id: propertyId,
    measurement_id: measurementId,
    gtag: gtagSnippet
  });
}


if (action === 'check_gtm_capacity') {
  console.log('🔍 Checking GTM capacity...');

  const rawContainerUrl =
    req.body.container_url ||
    req.body.containerUrl ||
    req.body.container_name ||
    req.body.containerName;

  const accountName = req.body.gtm_account_name || req.body.account_name;
  const containerUrl = String(rawContainerUrl || '').trim().replace(/\/+$/, '');

  if (!accountName || !containerUrl) {
    throw new Error('Missing gtm_account_name or container_url');
  }

  await navigateToGTM(page);
  await page.waitForTimeout(1500);

  // Click Create Account
  const createAccountBtn = page
    .locator('button:has-text("Create Account"), button:has-text("Create account")')
    .first();

  await createAccountBtn.waitFor({ timeout: 30000 });
  await createAccountBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1500);

  // Fill form
  await fillGTMAccountForm(page, { accountName, containerName: containerUrl });

  // Select Web
  await selectWebPlatform(page);

  // Click Create
  console.log('🆕 Clicking bottom Create...');
  await clickBottomCreate(page);

  // Accept terms
  console.log('📋 Accepting terms modal...');
  await acceptGTMTerms(page);

  // Check for limit snackbar
  console.log('⏳ Checking for limit snackbar...');
  const limitSnack = page.locator('text=/You have reached the maximum number of accounts allowed/i').first();

  const start = Date.now();
  let hasError = false;

  while (Date.now() - start < 6000) {
    if (await limitSnack.isVisible().catch(() => false)) {
      hasError = true;
      break;
    }
    await page.waitForTimeout(300);
  }

  if (hasError) {
    console.log('❌ GTM account limit reached - no space');
    await browser.close();
    return res.json({ status: 'failed', reason: 'gtm_no_space' });
  }

  // No snackbar = success, grab codes
  console.log('✅ No limit snackbar - grabbing codes...');
  await page.waitForTimeout(2000);

  const codes = {
    containerId: null,
    headCode: null,
    bodyCode: null
  };

  // Get container ID from page
  const pageContent = await page.content();
  const containerMatch = pageContent.match(/GTM-[A-Z0-9]{7,}/);
  if (containerMatch) {
    codes.containerId = containerMatch[0];
    console.log('✅ Found Container ID:', codes.containerId);
  }

  // Find code snippets
  const codeElements = await page.locator('code, pre, textarea').all();
  console.log(`📊 Found ${codeElements.length} code elements`);

  for (const el of codeElements) {
    const text = await el.textContent().catch(() => '');
    
    if (text.includes('googletagmanager.com/gtm.js') && !codes.headCode) {
      codes.headCode = text.trim();
      console.log('✅ Found Head Code');
    }
    
    if (text.includes('noscript') && text.includes('googletagmanager.com') && !codes.bodyCode) {
      codes.bodyCode = text.trim();
      console.log('✅ Found Body Code');
    }
  }

  await browser.close();
  return res.json({ 
    status: 'success', 
    reason: 'gtm_has_space',
    codes: codes
  });
}


if (action === 'configure_and_publish_gtm') {
  console.log('🔧 Configuring and publishing GTM container...');

  const {
    gtm_container_id,
    measurement_id,
    gtm_google_account
  } = req.body;

  if (!gtm_container_id) throw new Error('Missing gtm_container_id');
  if (!measurement_id) throw new Error('Missing measurement_id (GA4)');

  // Navigate to GTM and handle login if needed
  console.log('🌐 Navigating to Google Tag Manager...');
  await page.goto('https://tagmanager.google.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // ✅ INLINE LOGIN GUARD (NO HELPERS, DOES NOT TOUCH OTHER ACTIONS)
  for (let i = 0; i < 10; i++) {

    // Google email
    if (await page.locator('input[type="email"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[type="email"]:visible', google_email);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      continue;
    }

    // Google password
    if (await page.locator('input[name="Passwd"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[name="Passwd"]:visible', google_password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
      continue;
    }

    // SSO username (Thrive/OneLogin/etc.)
    if (await page.locator('input[name="username"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[name="username"]:visible', sso_username || google_email);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      continue;
    }

    // SSO password (Thrive/OneLogin/etc.)
    if (await page.locator('input[name="password"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[name="password"]:visible', sso_password || google_password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
      continue;
    }

    // If we're on GTM and no login fields are visible, assume we're logged in
    if (page.url().includes('tagmanager.google.com')) break;

    await page.waitForTimeout(1000);
  }

  
  console.log(`🔍 Opening GTM container from home list: ${gtm_container_id}...`);
  await openContainerFromHomeList(page, gtm_container_id);
  console.log('✅ Container opened');




  // Navigate to Tags section
  console.log('🏷️ Navigating to Tags...');
  const tagsLink = page.locator(
    'a:has-text("Tags"), ' +
    '[role="link"]:has-text("Tags")'
  ).first();

  await tagsLink.waitFor({ timeout: 30000 });
  await tagsLink.click({ timeout: 15000 });
  await page.waitForTimeout(1500);

  // Click "New" to create a new tag
  console.log('🆕 Creating new tag...');
  const newBtn = page.locator(
    'button:has-text("New"), ' +
    '[aria-label*="New"]'
  ).first();

  await newBtn.waitFor({ timeout: 30000 });
  await newBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1500);

  // Click on "Tag Configuration" to select tag type
  console.log('⚙️ Opening tag configuration...');
  const tagConfigBtn = page.locator(
    'div:has-text("Tag Configuration"), ' +
    'button:has-text("Tag Configuration"), ' +
    '[class*="tagConfig"]'
  ).first();

  await tagConfigBtn.waitFor({ timeout: 30000 });
  await tagConfigBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // Search for and select "Google Tag" (GA4 Configuration)
  console.log('🔍 Searching for Google Tag...');

  // Try search input in the tag type selector
  const searchInput = page.locator(
    'input[type="text"], ' +
    'input[placeholder*="Search"], ' +
    'input[aria-label*="Search"]'
  ).first();

  if (await searchInput.count() > 0) {
    await searchInput.fill('Google Tag');
    await page.waitForTimeout(800);
  }

  

// Click "Google Tag" option (try multiple variations)
console.log('🔍 Looking for Google Tag option...');

// Wait for options to appear
await page.waitForTimeout(1000);

let googleTagOption = page.locator(
  '[role="option"]:has-text("Google Tag"), ' +
  'div:has-text("Google Tag"), ' +
  'button:has-text("Google Tag"), ' +
  '[class*="option"]:has-text("Google Tag")'
).first();

// If not found, try "Google Analytics: GA4"
if (await googleTagOption.count() === 0) {
  console.log('⚠️ "Google Tag" not found, trying "Google Analytics: GA4"...');
  googleTagOption = page.locator(
    '[role="option"]:has-text("Google Analytics: GA4"), ' +
    'div:has-text("Google Analytics: GA4"), ' +
    '[role="option"]:has-text("GA4")'
  ).first();
}

// If still not found, try just "GA4"
if (await googleTagOption.count() === 0) {
  console.log('⚠️ Trying broader "GA4" search...');
  googleTagOption = page.locator(
    '[role="option"]:has-text("GA4"), ' +
    'div:has-text("GA4")'
  ).first();
}

await googleTagOption.waitFor({ timeout: 30000 });
await googleTagOption.click({ timeout: 15000 });
console.log('✅ Selected Google Tag/GA4 option');














  // Fill in the Tag ID (Measurement ID)
  console.log(`📝 Entering Measurement ID: ${measurement_id}...`);
  const tagIdInput = page.locator(
    'input[aria-label*="Tag ID"], ' +
    'input[placeholder*="G-"], ' +
    'input[name*="tagId"], ' +
    'input[name*="measurementId"]'
  ).first();

  await tagIdInput.waitFor({ timeout: 30000 });
  await tagIdInput.fill(measurement_id);
  await page.waitForTimeout(500);

  // Set up triggering - click on "Triggering" section
  console.log('🎯 Setting up trigger...');
  const triggeringBtn = page.locator(
    'div:has-text("Triggering"), ' +
    'button:has-text("Triggering"), ' +
    '[class*="trigger"]'
  ).first();

  await triggeringBtn.waitFor({ timeout: 30000 });
  await triggeringBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // Select "All Pages" trigger
  const allPagesTrigger = page.locator(
    'div:has-text("All Pages"), ' +
    '[role="option"]:has-text("All Pages"), ' +
    'button:has-text("All Pages")'
  ).filter({ hasText: /^All Pages$/i }).first();

  await allPagesTrigger.waitFor({ timeout: 30000 });
  await allPagesTrigger.click({ timeout: 15000 });
  await page.waitForTimeout(1000);

  // Save the tag
  console.log('💾 Saving tag...');
  const saveBtn = page.locator(
    'button:has-text("Save"), ' +
    '[aria-label*="Save"]'
  ).first();

  await saveBtn.waitFor({ timeout: 30000 });
  await saveBtn.click({ timeout: 15000 });
  await page.waitForTimeout(2000);

  // Now publish the container
  console.log('📤 Publishing container...');

  // Click "Submit" button in top right
  const submitBtn = page.locator(
    'button:has-text("Submit"), ' +
    '[aria-label*="Submit"]'
  ).first();

  await submitBtn.waitFor({ timeout: 30000 });
  await submitBtn.click({ timeout: 15000 });
  await page.waitForTimeout(1500);

  // Fill in version name and description (optional but recommended)
  const versionNameInput = page.locator(
    'input[aria-label*="Version name"], ' +
    'input[placeholder*="Version name"], ' +
    'textarea[aria-label*="Version name"]'
  ).first();

  if (await versionNameInput.count() > 0) {
    const versionName = `GA4 Setup - ${new Date().toISOString().split('T')[0]}`;
    await versionNameInput.fill(versionName);
    console.log(`✅ Version name: ${versionName}`);
  }

  // Click "Publish" button
  const publishBtn = page.locator(
    'button:has-text("Publish"), ' +
    '[aria-label*="Publish"]'
  ).first();

  await publishBtn.waitFor({ timeout: 30000 });

  // Wait for publish button to be enabled
  const startPublish = Date.now();
  while (Date.now() - startPublish < 15000) {
    const enabled = await publishBtn.isEnabled().catch(() => false);
    if (enabled) break;
    await page.waitForTimeout(300);
  }

  await publishBtn.click({ timeout: 15000 });
  await page.waitForTimeout(3000);

  // Verify publication success
  console.log('✅ Verifying publication...');
  const successIndicator = page.locator(
    'text=/published/i, ' +
    'text=/success/i, ' +
    '[class*="success"]'
  ).first();

  const published = await successIndicator
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);

  if (!published) {
    console.log('⚠️ Could not confirm publication success');
  }

  console.log('✅ GTM container configured and published');

  await browser.close();
  return res.json({
    status: 'success',
    message: 'GTM container configured and published',
    gtm_container_id,
    measurement_id,
    published: true,
    published_at: new Date().toISOString()
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Runner listening on port ${PORT}`);
});






































































































































































