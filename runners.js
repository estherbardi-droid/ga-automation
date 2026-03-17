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
  await page.waitForTimeout(800);
  console.log("📍 Current URL:", page.url());

  // Click the breadcrumb span directly — bubbles up to parent button
  const breadcrumb = page.locator('[debug-id="selected-entity-text"]').first();
  await breadcrumb.waitFor({ timeout: 10000 });
  await breadcrumb.click();
  await page.waitForTimeout(1500);

  // Type in the search box
  const searchInput = page.locator('xap-open-search input').first();
  await searchInput.waitFor({ timeout: 15000 });
  await searchInput.click();
  await searchInput.fill('');
  await searchInput.type(String(accountName), { delay: 25 });
  await page.waitForTimeout(1000);

  // Click the matching result
  const accountItem = page.locator('gmp-entity-item, [class*="gmp-entity"], [class*="entity-item"]')
    .filter({ hasText: String(accountName) }).first();
  await accountItem.waitFor({ timeout: 15000 });
  await accountItem.click();

  await page.waitForTimeout(2000);
  console.log("✅ Account selected:", accountName);
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

// DEBUG: Take screenshot of home page
const screenshotPath = require('path').resolve('gtm_home_before_click.png');
await page.screenshot({ path: screenshotPath, fullPage: true });
console.log('📸 Screenshot saved to:', screenshotPath);

let clicked = false;

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
  console.log('⚠️ Exact match not found, trying to find container by visible text...');
  
  // GTM displays "GTM-XXXXXXX" as TEXT on the page, but the href uses numeric IDs
  // So we need to: 1) Find the text "GTM-XXXXXXX", 2) Find the link in that same row
  
  // METHOD A: Find the container ID text, then navigate up to the row, then find the link
  const containerIdText = page.locator(`text="${containerId}"`).first();
  
  if (await containerIdText.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.log(`✅ Found container ID text: ${containerId}`);
    
    // The Container ID is just text, we need to click the Container Name link in the SAME ROW
    // Strategy: Find all container links, then pick the one that's vertically aligned with the ID
    
    const allLinks = await page.locator('a[href*="/container/"]').all();
    console.log(`📊 Found ${allLinks.length} container links on page`);
    
    const idBox = await containerIdText.boundingBox();
    
    if (idBox) {
      console.log(`📍 Container ID position: y=${idBox.y}`);
      
      for (const link of allLinks) {
        const linkBox = await link.boundingBox().catch(() => null);
        
        if (linkBox) {
          const verticalDistance = Math.abs(idBox.y - linkBox.y);
          
          // If they're in the same horizontal line (within 30px), they're in the same row
          if (verticalDistance < 30) {
            const href = await link.getAttribute('href').catch(() => '');
            const linkText = await link.textContent().catch(() => '');
            console.log(`📍 Found link in same row - distance: ${verticalDistance}px`);
            console.log(`   Link text: "${linkText.substring(0, 40)}"`);
            console.log(`   Link href: ${href}`);
            
            await link.click({ timeout: 10000 });
            clicked = true;
            console.log('✅ Clicked container name link');
            break;
          }
        }
      }
      
      if (!clicked) {
        console.log('⚠️ No link found in same row as Container ID');
      }
    }
  } else {
    console.log('⚠️ Container ID text not found, trying broader search...');
    
    // METHOD B: Search all rows for one containing the container ID
    const allRows = await page.locator('tr, div[class*="container-item"], div[class*="container-card"]').all();
    console.log(`📊 Checking ${allRows.length} rows for container ID...`);
    
    for (const row of allRows) {
      const rowText = await row.textContent().catch(() => '');
      
      if (rowText.includes(containerId)) {
        console.log(`✅ Found row containing: ${containerId}`);
        const link = row.locator('a').first();
        
        if (await link.isVisible().catch(() => false)) {
          const href = await link.getAttribute('href').catch(() => '');
          console.log(`📍 Clicking link with href: ${href}`);
          
          await link.click({ timeout: 10000 });
          clicked = true;
          console.log('✅ Clicked container link');
          break;
        }
      }
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

  // DEBUG: Log what happened after clicking
  await page.waitForTimeout(2000);
  console.log('📸 Taking screenshot after click...');
  const screenshotPath2 = require('path').resolve('gtm_after_click.png');
  await page.screenshot({ path: screenshotPath2, fullPage: true });
  console.log('📸 Screenshot saved to:', screenshotPath2);
  console.log('🔍 Current URL after click:', page.url());

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


const sessions = {};


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


if (!['login_and_create_ga4', 'create_ga_account', 'fetch_gtag_and_property_id', 'check_gtm_capacity', 'create_gtm_account', 'configure_and_publish_gtm', 'install_gtm_codes', 'add_search_console_property', 'fetch_gtm_codes', 'test_tracking_ctas', 'submit_google_otp'].includes(action)) {
  return res.status(400).json({ error: 'Unknown action' });
}


  let browser;

  try {
    browser = await chromium.launch({ headless: false });
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

 //code needed?
if (await page.locator('input[type="tel"]:visible').count() > 0) {
    const sessionId = `otp_${Date.now()}`;
    sessions[sessionId] = page;
    browser = null;
    return res.json({ status: 'need_code', stage: 'google_otp', sessionId });
  }

      if (page.url().startsWith('https://analytics.google.com')) break;
      await page.waitForTimeout(3000);
    }



 if (action === 'submit_google_otp') {
    const { sessionId, otp_code } = req.body;
    const otpPage = sessions[sessionId];
    if (!otpPage) return res.json({ status: 'error', message: 'Session not found or expired' });

    try {
      await otpPage.fill('input[type="tel"]', otp_code);
      await otpPage.click('button:has-text("Next")');
      await otpPage.waitForTimeout(3000);

      const needsAnother = await otpPage.$('input[type="tel"]');
      if (needsAnother) {
        return res.json({ status: 'need_code', stage: 'otp_retry', sessionId });
      }

      delete sessions[sessionId];
      return res.json({ status: 'success', sessionId });
    } catch (err) {
      return res.json({ status: 'error', message: err.message });
    }
  }



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

  // 2) Close the left column (your manual "nudge")
  await page.mouse.click(650, 320).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);

  // Ensure we're at top so Create is reachable
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

  // Limit message detection (so you don't get stuck on the limit page)
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

    // Your "nudge" to settle UI/focus
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



// Click Create (don't require exact accessible name; GA often changes it)
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


  // Extract numeric account and container IDs from URL
  const gtmUrl = page.url();
  console.log('📍 GTM URL after creation:', gtmUrl);
  const gtmUrlMatch = gtmUrl.match(/accounts\/(\d+)\/containers\/(\d+)/);
  if (gtmUrlMatch) {
    codes.numericAccountId = gtmUrlMatch[1];
    codes.numericContainerId = gtmUrlMatch[2];
    console.log('✅ Numeric Account ID:', codes.numericAccountId);
    console.log('✅ Numeric Container ID:', codes.numericContainerId);
  } else {
    console.log('⚠️ Could not extract numeric IDs from URL:', gtmUrl);
  }

  await browser.close();
  return res.json({ 
    status: 'success', 
    reason: 'gtm_has_space',
    codes: codes
  });

  
}

if (action === 'configure_and_publish_gtm') {
  console.log('🚀 Publishing GTM container (AP Tracking Setup workspace)...');

  const { gtm_container_id, numeric_account_id, numeric_container_id, workspace_id } = req.body;

  if (!gtm_container_id) throw new Error('Missing gtm_container_id');
  if (!numeric_account_id || !numeric_container_id || !workspace_id) throw new Error('Missing numeric IDs');

  console.log('🌐 Navigating to Google Tag Manager...');
  await page.goto('https://tagmanager.google.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  for (let i = 0; i < 10; i++) {
    if (await page.locator('input[type="email"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[type="email"]:visible', google_email);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(4000);
      continue;
    }
    if (await page.locator('input[name="Passwd"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[name="Passwd"]:visible', google_password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
      continue;
    }
    if (await page.locator('input[name="username"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[name="username"]:visible', sso_username || google_email);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      continue;
    }
    if (await page.locator('input[name="password"]:visible').count().catch(() => 0) > 0) {
      await page.fill('input[name="password"]:visible', sso_password || google_password);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(5000);
      continue;
    }
    if (page.url().includes('tagmanager.google.com')) break;
    await page.waitForTimeout(1000);
  }














  // Navigate directly to workspace
  const workspaceUrl = `https://tagmanager.google.com/#/container/accounts/${numeric_account_id}/containers/${numeric_container_id}/workspaces/${workspace_id}`;
  console.log('🧭 Navigating directly to workspace:', workspaceUrl);
  await page.goto(workspaceUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  console.log('✅ On workspace page:', page.url());

  // Submit
  console.log('📤 Clicking Submit...');
  await page.mouse.move(0, 0).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(500);

  const submitBtn = page.locator('button:has-text("Submit"), [aria-label*="Submit"]').first();
  await submitBtn.waitFor({ state: 'visible', timeout: 30000 });
  await submitBtn.click({ force: true, timeout: 15000 });
  console.log('✅ Clicked Submit');
  await page.waitForTimeout(3000);

  const continueBtn = page.locator('button:has-text("Continue"), button:has-text("Skip")').first();
  if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await continueBtn.click({ timeout: 10000 });
    await page.waitForTimeout(2000);
  }

  const publishBtn = page.locator('button:has-text("Publish"), [aria-label*="Publish"]').first();
  await publishBtn.waitFor({ state: 'visible', timeout: 30000 });
  await publishBtn.click({ timeout: 15000 });
  console.log('✅ Clicked Publish');
  await page.waitForTimeout(5000);

  await browser.close();
  return res.json({
    status: 'success',
    message: 'GTM workspace published',
    gtm_container_id,
    workspace: 'AP Tracking Setup',
    published: true,
    published_at: new Date().toISOString()
  });
}



if (action === 'install_gtm_codes') {
  console.log('🌐 Installing GTM codes on client website...');

  const {
    website_url,
    cms_type, // "wordpress", "wix", or "squarespace"
    wp_admin_url,
    cms_username,
    cms_password,
    gtm_head_code,
    gtm_body_code,
    gtag
  } = req.body;

  if (!website_url || !cms_type) {
    throw new Error('Missing website_url or cms_type');
  }

  if (!gtm_head_code || !gtm_body_code) {
    throw new Error('Missing GTM codes (gtm_head_code or gtm_body_code)');
  }

  const cms = cms_type.toLowerCase();

 
 // ==================== WORDPRESS ====================
  if (action === 'install_gtm_codes') {
  console.log('🌐 Installing GTM codes on client website...');

  const {
    website_url,
    cms_type,
    wp_admin_url,
    cms_username,
    cms_password,
    gtm_head_code,
    gtm_body_code,
    gtag
  } = req.body;

  if (!website_url || !cms_type) {
    throw new Error('Missing website_url or cms_type');
  }

  if (!gtm_head_code || !gtm_body_code) {
    throw new Error('Missing GTM codes (gtm_head_code or gtm_body_code)');
  }

  const cms = cms_type.toLowerCase();

  // ==================== WORDPRESS ====================
  
if (cms === 'wordpress') {
    console.log('📝 WordPress site detected');

    if (!wp_admin_url || !cms_username || !cms_password) {
      throw new Error('Missing WordPress credentials');
    }

    const baseUrl = wp_admin_url.replace(/\/(wp-admin|wp-login\.php).*$/, '').replace(/\/$/, '');

    async function wpAdminGoto(url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      console.log('📍 Landed on:', page.url());

      const currentUrl = page.url();
      if (currentUrl.includes('wp-login') || currentUrl.includes('reauth=1') || currentUrl.includes('onelogin')) {
        console.log('🔄 Session expired, re-logging in...');
        await page.goto(`${baseUrl}/wp-login.php`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
        await page.locator('#user_login, input[name="log"]').first().fill(cms_username);
        await page.locator('#user_pass, input[name="pwd"]').first().fill(cms_password);
        await page.locator('#wp-submit, input[type="submit"]').first().click();
        await page.waitForURL('**/wp-admin/**', { timeout: 30000 });
        await page.waitForTimeout(1000);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        console.log('✅ Re-logged in, now at:', page.url());
      }
    }

    // ── Login ──────────────────────────────────────────────────────────────
    console.log(`🔐 Logging into WordPress: ${wp_admin_url}`);
    await page.goto(wp_admin_url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.locator('#user_login, input[name="log"]').first().fill(cms_username);
    await page.locator('#user_pass, input[name="pwd"]').first().fill(cms_password);
    await page.locator('#wp-submit, input[type="submit"]').first().click();
    await page.waitForURL('**/wp-admin/**', { timeout: 30000 });
    await page.waitForTimeout(1000);
    console.log('✅ Logged into WordPress');

    // ── WPCode check ───────────────────────────────────────────────────────
    console.log('🔌 Checking for WPCode plugin...');
    await wpAdminGoto(`${baseUrl}/wp-admin/plugins.php`);

    const wpCodeRow = page.locator('tr[data-slug="insert-headers-and-footers"]').first();
    const pluginExists = await wpCodeRow.count() > 0;

    if (!pluginExists) {
      console.log('⚠️ WPCode not found, installing...');
      await wpAdminGoto(`${baseUrl}/wp-admin/plugin-install.php`);

      const searchInput = page.locator('#search-plugins, input[name="s"]').first();
      await searchInput.waitFor({ timeout: 30000 });
      await searchInput.fill('WPCode');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);

      const installBtn = page.locator('a:has-text("Install Now")').first();
      await installBtn.waitFor({ timeout: 30000 });
      await installBtn.click();
      await page.waitForTimeout(5000);
      console.log('✅ Plugin installed');

      const activateBtn = page.locator('a:has-text("Activate")').first();
      await activateBtn.waitFor({ timeout: 30000 });
      await activateBtn.click();
      await page.waitForTimeout(3000);
      console.log('✅ Plugin activated');

    } else {
      const deactivateLink = wpCodeRow.locator('a:has-text("Deactivate")').first();
      const activateLink   = wpCodeRow.locator('a:has-text("Activate")').first();

      const isActive   = await deactivateLink.isVisible().catch(() => false);
      const isInactive = await activateLink.isVisible().catch(() => false);

      if (isActive) {
        console.log('✅ WPCode already active, leaving it alone');
      } else if (isInactive) {
        console.log('⚠️ WPCode inactive, activating...');
        await activateLink.click();
        await page.waitForTimeout(3000);
        console.log('✅ WPCode activated');
      } else {
        console.log('⚠️ Could not determine WPCode state, proceeding anyway...');
      }
    }

    // ── Insert GTM codes ───────────────────────────────────────────────────
    console.log('⚙️ Opening WPCode Header & Footer...');
    await wpAdminGoto(`${baseUrl}/wp-admin/admin.php?page=wpcode-headers-footers`);

    console.log('📝 Inserting GTM codes (appending if existing content found)...');
    await page.evaluate((codes) => {
      const editors = document.querySelectorAll('.CodeMirror');

      if (editors[0] && editors[0].CodeMirror) {
        const headEditor   = editors[0].CodeMirror;
        const existingHead = headEditor.getValue().trim();
        const newHead      = (codes.gtag ? codes.gtag + '\n' : '') + codes.head;
        headEditor.setValue(existingHead ? existingHead + '\n\n' + newHead : newHead);
      }

      if (editors[1] && editors[1].CodeMirror) {
        const bodyEditor   = editors[1].CodeMirror;
        const existingBody = bodyEditor.getValue().trim();
        bodyEditor.setValue(existingBody ? existingBody + '\n\n' + codes.body : codes.body);
      }
    }, { head: gtm_head_code, body: gtm_body_code, gtag: gtag || '' });

    console.log('✅ Head code inserted');
    console.log('✅ Body code inserted');

    const saveBtn = page.locator('button:has-text("Save Changes"), input[type="submit"]').first();
    await saveBtn.click();
    await page.waitForTimeout(2000);
    console.log('✅ GTM codes saved');

    // ── Form detection ─────────────────────────────────────────────────────
    // ── Form detection ─────────────────────────────────────────────────────
    console.log('🔍 Detecting contact form provider...');

    const siteBaseUrl = website_url.replace(/\/$/, '');

    async function safeGotoForm(url, label = 'page') {
      try {
        console.log(`🔎 Checking ${label}: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        return true;
      } catch (err) {
        console.log(`⚠️ Could not load ${url}: ${err.message}`);
        return false;
      }
    }

    function dedupeUrls(urls) {
      return [...new Set(urls.filter(Boolean))];
    }

    const pagesToCheck = dedupeUrls([
      siteBaseUrl,
      siteBaseUrl + '/contact',
      siteBaseUrl + '/contact-us',
      siteBaseUrl + '/contact-me',
      siteBaseUrl + '/contactus',
      siteBaseUrl + '/get-in-touch',
      siteBaseUrl + '/getintouch',
      siteBaseUrl + '/enquiry',
      siteBaseUrl + '/enquiries',
      siteBaseUrl + '/enquire',
      siteBaseUrl + '/make-an-enquiry',
      siteBaseUrl + '/quote',
      siteBaseUrl + '/free-quote',
      siteBaseUrl + '/get-a-quote',
      siteBaseUrl + '/request-a-quote',
      siteBaseUrl + '/request-quote',
      siteBaseUrl + '/book',
      siteBaseUrl + '/book-now',
      siteBaseUrl + '/booking',
      siteBaseUrl + '/bookings',
      siteBaseUrl + '/support',
      siteBaseUrl + '/help',
      siteBaseUrl + '/reach-us',
      siteBaseUrl + '/reach-out',
      siteBaseUrl + '/talk-to-us',
      siteBaseUrl + '/speak-to-us',
      siteBaseUrl + '/hire-us',
      siteBaseUrl + '/work-with-us',
      siteBaseUrl + '/sales',
      siteBaseUrl + '/demo',
      siteBaseUrl + '/request-demo',
      siteBaseUrl + '/free-consultation',
      siteBaseUrl + '/consultation',
    ]);

    console.log('📄 Pages to check:', pagesToCheck.join(', '));

    let detected_form_type = 'unknown';
    let detected_form_id = null;
    let detected_form_class = null;
    let detected_form_selector = null;
    let detected_form_action = null;
    let detected_form_source_url = null;

    async function detectBestFormOnPage(pageOrFrame) {
      return await pageOrFrame.evaluate(() => {
        const normaliseClass = (value) => {
          if (!value || typeof value !== 'string') return null;
          const cleaned = value.trim().replace(/\s+/g, ' ');
          return cleaned || null;
        };

        const getPluginType = (form) => {
          const wrapper = form.closest(
            '.wpcf7, .gform_wrapper, .wpforms-container, .elementor-widget, .et_pb_contact, .fluentform, .forminator, .nf-form-cont, .frm_forms, .hs-form, .metform-form-main-wrapper, .gutena-forms-block, .wp-block-gutena-forms'
          );
          const formClass = `${form.className || ''} ${wrapper?.className || ''}`.toLowerCase();
          const formId = (form.id || '').toLowerCase();
          const action = (form.getAttribute('action') || '').toLowerCase();

          if (form.matches('form.wp-block-gutena-forms') || formClass.includes('gutena') || action.includes('gutena')) return 'gutenaforms';
          if (form.matches('.wpcf7-form, form.wpcf7') || formClass.includes('wpcf7')) return 'cf7';
          if (form.matches('form[id^="gform_"]') || formId.startsWith('gform_') || formClass.includes('gform_wrapper') || formClass.includes('gravity')) return 'gform';
          if (form.matches('form.elementor-form, .elementor-form') || formClass.includes('elementor-form')) return 'elementor';
          if (form.matches('form[id^="wpforms-form-"], .wpforms-form') || formId.startsWith('wpforms-form-') || formClass.includes('wpforms')) return 'wpforms';
          if (formClass.includes('et_pb_contact_form') || formClass.includes('et_pb_contact')) return 'divi';
          if (formClass.includes('hs-form') || action.includes('hubspot')) return 'hubspot';
          if (formClass.includes('wsf-form')) return 'wsform';
          if (formClass.includes('sqs-block-form')) return 'squarespace';
          if (formClass.includes('metform')) return 'metform';
          if (formClass.includes('ninja-forms') || formClass.includes('nf-form')) return 'ninjaforms';
          if (formClass.includes('formidable') || formClass.includes('frm_form')) return 'formidable';
          if (formClass.includes('caldera')) return 'caldera';
          if (formClass.includes('fluentform') || formClass.includes('ff-el-form')) return 'fluentforms';
          if (formClass.includes('10web') || formClass.includes('wd-form')) return '10webforms';
          return 'generic';
        };

        const buildSelector = (form) => {
          if (form.id) return `#${form.id}`;
          const classes = (form.className || '').split(/\s+/).map(c => c.trim()).filter(Boolean);
          const priorityPatterns = ['wpcf7-form', 'elementor-form', 'wpforms-form', 'gform', 'gutena', 'forminator', 'fluentform', 'nf-form', 'ninja', 'frm_form', 'formidable', 'metform', 'wsf-form', 'hs-form', 'et_pb_contact'];
          const matched = classes.find(cls => priorityPatterns.some(pattern => cls.toLowerCase().includes(pattern)));
          if (matched) return `.${matched}`;
          if (classes.length) return `.${classes[0]}`;
          return 'form';
        };

        const scoreForm = (form) => {
          let score = 0;
          const id = (form.id || '').toLowerCase();
          const cls = (form.className || '').toLowerCase();
          const action = (form.getAttribute('action') || '').toLowerCase();
          const text = (form.innerText || '').toLowerCase();

          // Exclude admin/search forms
          if (id.includes('adminbarsearch') || id.includes('search') ||
              cls.includes('search-form') || action.includes('wp-login')) return -999;

          const hasEmail = !!form.querySelector('input[type="email"], input[name*="email" i]');
          const hasName = !!form.querySelector('input[name*="name" i], input[placeholder*="name" i], input[id*="name" i]');
          const hasTextarea = !!form.querySelector('textarea');
          const hasPhone = !!form.querySelector('input[type="tel"], input[name*="phone" i]');
          const hasSubmit = !!form.querySelector('button[type="submit"], input[type="submit"], button');
          const fieldCount = form.querySelectorAll('input, textarea, select').length;

          if (hasEmail) score += 3;
          if (hasName) score += 2;
          if (hasTextarea) score += 3;
          if (hasPhone) score += 1;
          if (hasSubmit) score += 3;
          if (fieldCount >= 3) score += 2;
          if (/contact|enquir|quote|support|get in touch|message|book|request/.test(text)) score += 3;
          if (/contact|enquir|quote|support|lead|submit/.test(action)) score += 2;
          if (/contact|enquir|quote|support|form|lead/.test(cls)) score += 2;
          if (/contact|enquir|quote|support|form/.test(id)) score += 2;
          if (form.offsetParent === null) score -= 3;

          return score;
        };

        const forms = Array.from(document.querySelectorAll('form'));
        if (!forms.length) return null;

        const candidates = forms.map(form => ({
          type: getPluginType(form),
          score: scoreForm(form),
          form_id: form.id || null,
          form_class: normaliseClass(form.className),
          form_action: form.getAttribute('action') || null,
          selector: buildSelector(form)
        })).filter(c => c.score > 0);

        candidates.sort((a, b) => {
          const aNamed = a.type !== 'generic' ? 1 : 0;
          const bNamed = b.type !== 'generic' ? 1 : 0;
          if (bNamed !== aNamed) return bNamed - aNamed;
          return b.score - a.score;
        });

        const best = candidates[0];
        if (!best) return null;
        if (best.score < 3 && best.type === 'generic') return null;
        return best;
      });
    }

    for (const pageUrl of pagesToCheck) {
      const loaded = await safeGotoForm(pageUrl);
      if (!loaded) continue;

      let formMeta = await detectBestFormOnPage(page);

      if (formMeta) {
        detected_form_type = formMeta.type;
        detected_form_id = formMeta.form_id;
        detected_form_class = formMeta.form_class;
        detected_form_selector = formMeta.selector;
        detected_form_action = formMeta.form_action;
        detected_form_source_url = pageUrl;
        console.log(`✅ Form detected on ${pageUrl}: ${formMeta.type} | selector: ${formMeta.selector} | id: ${formMeta.form_id}`);
        break;
      }

      for (const frame of page.frames()) {
        try {
          if (frame === page.mainFrame()) continue;
          const frameMeta = await detectBestFormOnPage(frame);
          if (!frameMeta) continue;
          detected_form_type = frameMeta.type;
          detected_form_id = frameMeta.form_id;
          detected_form_class = frameMeta.form_class;
          detected_form_selector = frameMeta.selector;
          detected_form_action = frameMeta.form_action;
          detected_form_source_url = pageUrl;
          console.log(`✅ Frame-based form detected on ${pageUrl}: ${frameMeta.type} | selector: ${frameMeta.selector}`);
          break;
        } catch (err) {
          console.log(`⚠️ Frame inspection failed on ${pageUrl}: ${err.message}`);
        }
      }

      if (detected_form_type !== 'unknown') break;
      console.log(`⚠️ No form detected on ${pageUrl}`);
    }

    console.log(`📋 Final detected form type: ${detected_form_type}`);
    console.log(`📋 Final selector: ${detected_form_selector}`);
    console.log(`📋 Final source url: ${detected_form_source_url}`);
    console.log('✅ GTM codes installed on WordPress site');

    return res.json({
      success: true,
      message: 'GTM codes installed successfully',
      detected_form_type,
      detected_form_id,
      detected_form_class,
      detected_form_selector,
      detected_form_action,
      detected_form_source_url
    });
  }
}






  // ==================== WIX ====================
 else if (cms === 'wix') {
    console.log('📝 Wix site detected');

    if (!cms_username || !cms_password) {
      throw new Error('Missing Wix credentials');
    }

    // Login to Wix
    console.log('🔐 Logging into Wix...');
    await page.goto('https://users.wix.com/signin', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.waitFor({ timeout: 30000 });
    await emailInput.fill(cms_username);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.waitFor({ timeout: 30000 });
    await passwordInput.fill(cms_password);
    await page.keyboard.press('Enter');
    console.log('✅ Logged into Wix');
    await page.waitForTimeout(5000);
    

// ── Navigate to Sites dashboard ──────────────────────────────────────
  console.log('🔍 Navigating to Sites dashboard...');
  await page.goto(
    'https://manage.wix.com/studio/sites?referralInfo=sidebar&viewId=all-items-view',
    { waitUntil: 'domcontentloaded' }
  );
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(8000);

  // ── Extract domain ───────────────────────────────────────────────────
  function getDomain(input) {
    try {
      const u = new URL(input.startsWith('http') ? input : `https://${input}`);
      return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return String(input).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    }
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const targetDomain = getDomain(website_url);
  console.log(`🔍 Searching for domain: ${targetDomain}`);

  // ── Search for site ──────────────────────────────────────────────────
  const searchInput = page.locator('input[placeholder*="Search"], input[aria-label*="Search"]').first();
  await searchInput.waitFor({ timeout: 20000 });
  await searchInput.click().catch(() => {});
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await searchInput.fill(targetDomain);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  // ── Find domain text on page ─────────────────────────────────────────
  let matchText = page.locator(`text=/\\b${escapeRegExp(targetDomain)}\\b/i`).first();

  if (!(await matchText.count())) {
    const key = targetDomain.split('.')[0];
    console.log(`⚠️ Falling back to key: ${key}`);
    await searchInput.click().catch(() => {});
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await searchInput.fill(key);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
    matchText = page.locator(`text=/\\b${escapeRegExp(key)}\\b/i`).first();
  }


await matchText.waitFor({ timeout: 20000 });
console.log('✅ Found site on dashboard');

// Find all text matches and pick the one in the card (not the search bar)
const allMatches = await page.locator(`text=/${escapeRegExp(targetDomain.split('.')[0])}/i`).all();
console.log(`🔍 Found ${allMatches.length} matches`);

let cardBox = null;
for (const el of allMatches) {
  const box = await el.boundingBox();
  console.log(`  📍 y=${box?.y}`);
  if (box && box.y > 200) {
    cardBox = box;
    break;
  }
}

if (!cardBox) throw new Error('❌ Could not find card on page');
console.log(`✅ Card found at x=${cardBox.x}, y=${cardBox.y}`);

// Click the dots button - it's to the right of the domain text
await page.mouse.click(cardBox.x + 170, cardBox.y);
await page.waitForTimeout(1500);
await page.screenshot({ path: 'C:\\Users\\esther.bardi\\ga-automation\\hover-debug3.png' });


const menuOption = page.locator('text="Edit Site"')
  .or(page.locator('text="Manage Site"'))
  .or(page.locator('text="Dashboard"'))
  .first();

await menuOption.waitFor({ timeout: 8000 });
await menuOption.click();
await page.waitForTimeout(4000);




const allPages = page.context().pages();
const activePage = allPages[allPages.length - 1];
console.log('📍 Now on:', activePage.url());

await activePage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
await activePage.waitForTimeout(2000);

const currentUrl = activePage.url();
console.log('📍 Now on:', currentUrl);

// Extract metaSiteId from editor URL
const metaSiteIdMatch = currentUrl.match(/metaSiteId=([a-f0-9-]{36})/i) 
  || currentUrl.match(/\/([a-f0-9-]{36})/i);

if (!metaSiteIdMatch) throw new Error('❌ Could not extract site ID from: ' + currentUrl);

const metaSiteId = metaSiteIdMatch[1];
console.log('✅ Got site ID:', metaSiteId);


const settingsUrl = `https://manage.wix.com/dashboard/${metaSiteId}/settings`;
console.log('⚙️ Going to Settings:', settingsUrl);
await activePage.goto(settingsUrl, { waitUntil: 'domcontentloaded' });
await activePage.waitForTimeout(4000);
console.log('📍 Now on:', activePage.url());

// Scroll and find Marketing Integrations in the right panel
console.log('🔍 Looking for Marketing Integrations...');
const marketingLink = activePage.locator('text="Marketing Integrations"').first();

for (let i = 0; i < 10; i++) {
  const visible = await marketingLink.isVisible().catch(() => false);
  if (visible) break;
  await activePage.evaluate(() => window.scrollBy(0, 300));
  await activePage.waitForTimeout(500);
}

await marketingLink.waitFor({ timeout: 10000 });
await marketingLink.click();
console.log('✅ Clicked Marketing Integrations');
await activePage.waitForTimeout(3000);
console.log('📍 Now on:', activePage.url());


// Extract GTM ID from script
const gtmIdMatch = gtm_head_code.match(/GTM-[A-Z0-9]+/);
if (!gtmIdMatch) throw new Error('❌ Could not extract GTM ID from gtm_head_code');
const gtmId = gtmIdMatch[0];
console.log('✅ Extracted GTM ID:', gtmId);

// Find the GTM card and click its Connect button
console.log('🔌 Clicking Connect under Google Tag Manager...');
const gtmSection = activePage.locator('text="Google Tag Manager"').locator('xpath=ancestor::div[3]');
const connectBtn = gtmSection.locator('button:has-text("Connect")').first();
await connectBtn.waitFor({ timeout: 10000 });
await connectBtn.click();
await activePage.waitForTimeout(3000);

// Now click "Add Google Tag Manager" button on the next page
console.log('➕ Clicking Add Google Tag Manager...');
const addGtmBtn = activePage.locator('button:has-text("Add Google Tag Manager")').first();
await addGtmBtn.waitFor({ timeout: 10000 });
await addGtmBtn.click();
await activePage.waitForTimeout(3000);
await activePage.screenshot({ path: 'C:\\Users\\esther.bardi\\ga-automation\\gtm-input.png' });

// Enter GTM ID
console.log('📝 Entering GTM ID:', gtmId);
const gtmInput = activePage.locator('input').first();
await gtmInput.waitFor({ timeout: 10000 });
await gtmInput.fill(gtmId);
await activePage.waitForTimeout(1000);

// Save
const gtmSaveBtn = activePage.locator('button:has-text("Save")')
  .or(activePage.locator('button:has-text("Apply")'))
  .or(activePage.locator('button:has-text("Add")'))
  .first();
await gtmSaveBtn.waitFor({ timeout: 10000 });
await gtmSaveBtn.click();
await activePage.waitForTimeout(3000);
console.log('✅ GTM connected on Wix site');


    console.log('✅ GTM codes installed on Wix site');
  }

  // ==================== SQUARESPACE ====================
  else if (cms === 'squarespace') {
    console.log('📝 Squarespace site detected');

    if (!cms_username || !cms_password) {
      throw new Error('Missing Squarespace credentials');
    }

    // Login to Squarespace
    console.log('🔐 Logging into Squarespace...');
    await page.goto('https://login.squarespace.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    await emailInput.waitFor({ timeout: 30000 });
    await emailInput.fill(cms_username);

    const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
    await passwordInput.fill(cms_password);

    const loginBtn = page.locator('button[type="submit"], input[type="submit"]').first();
    await loginBtn.click();
    console.log('✅ Logged into Squarespace');
    await page.waitForTimeout(5000);

    // Navigate to website
    console.log('🔍 Opening website dashboard...');
    const siteLink = page.locator(`a:has-text("${website_url}"), [href*="${website_url.replace('https://', '').replace('http://', '')}"]`).first();
    
    if (await siteLink.isVisible({ timeout: 10000 }).catch(() => false)) {
      await siteLink.click();
      await page.waitForTimeout(3000);
    }

    // Go to Settings > Advanced > Code Injection
    console.log('⚙️ Opening Code Injection settings...');
    
    const settingsBtn = page.locator('a:has-text("Settings"), button:has-text("Settings")').first();
    await settingsBtn.waitFor({ timeout: 30000 });
    await settingsBtn.click();
    await page.waitForTimeout(2000);

    const advancedLink = page.locator('a:has-text("Advanced"), button:has-text("Advanced")').first();
    await advancedLink.click();
    await page.waitForTimeout(2000);

    const codeInjectionLink = page.locator('a:has-text("Code Injection"), button:has-text("Code Injection")').first();
    await codeInjectionLink.waitFor({ timeout: 30000 });
    await codeInjectionLink.click();
    await page.waitForTimeout(2000);

    // Insert GTM codes
    console.log('📝 Inserting GTM codes...');

    // Header code
    const headerTextarea = page.locator('textarea[name*="header"], textarea[placeholder*="header"], .CodeMirror').first();
    await headerTextarea.waitFor({ timeout: 30000 });
    
    // For CodeMirror editor (Squarespace uses this)
    if (await page.locator('.CodeMirror').count() > 0) {
      await page.evaluate((code) => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        cm.setValue(code);
      }, gtm_head_code);
    } else {
      await headerTextarea.fill(gtm_head_code);
    }
    console.log('✅ Head code inserted');

    // Footer/Body code
    const footerTextarea = page.locator('textarea[name*="footer"], textarea[placeholder*="footer"]').first();
    await footerTextarea.fill(gtm_body_code);
    console.log('✅ Body code inserted');

    // Save
    const saveBtn = page.locator('button:has-text("Save"), input[value="Save"]').first();
    await saveBtn.click();
    await page.waitForTimeout(3000);

    console.log('✅ GTM codes installed on Squarespace site');
  }

  else {
    throw new Error(`Unknown CMS type: ${cms_type}`);
  }

  await browser.close();
  return res.json({
    status: 'success',
    message: `GTM codes installed on ${cms_type} site`,
    website_url,
    cms_type,
    installed_at: new Date().toISOString()
  });
}




if (action === 'add_search_console_property') {
  console.log('🔍 Adding Search Console property...');

  const { website_url, wp_admin_url, cms_username, cms_password } = req.body;

  if (!website_url) throw new Error('Missing website_url');
  if (!wp_admin_url || !cms_username || !cms_password) throw new Error('Missing WordPress credentials');

  const baseUrl = wp_admin_url.replace(/\/(wp-admin|wp-login\.php).*$/, '').replace(/\/$/, '');

 // ── STEP 1: Go to Search Console and add URL prefix property ──────────
console.log('📍 Opening Search Console...');
await page.goto('https://search.google.com/search-console/welcome', { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(2500);

// Wait for the welcome screen
await page.locator('text=Welcome to Google Search Console').first().waitFor({ timeout: 20000 });

// Find the "URL prefix" section/card
const urlPrefixHeading = page.locator('text=URL prefix').first();
await urlPrefixHeading.waitFor({ state: 'visible', timeout: 20000 });

// Climb to a container and find a usable input inside it
const urlPrefixCard = urlPrefixHeading.locator('xpath=ancestor::*[self::div or self::section][1]');
let urlInput = urlPrefixCard.locator('input:not([disabled]):not([aria-hidden="true"])').last();

// Fallback: search globally for visible, enabled inputs and choose the one that looks like the property field
if (!(await urlInput.isVisible().catch(() => false))) {
  const inputs = page.locator('input:not([disabled]):not([aria-hidden="true"])');
  const count = await inputs.count();

  let found = null;
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const visible = await input.isVisible().catch(() => false);
    if (!visible) continue;

    const val = await input.inputValue().catch(() => '');
    const type = await input.getAttribute('type').catch(() => '');
    const placeholder = await input.getAttribute('placeholder').catch(() => '');

    // ignore search bars / hidden-ish utility inputs
    if (type === 'hidden') continue;
    if ((val || '').includes('Inspect any URL')) continue;

    found = input;
  }

  if (!found) throw new Error('Could not find a usable Search Console URL prefix input');
  urlInput = found;
}

await urlInput.waitFor({ state: 'visible', timeout: 10000 });
await urlInput.click({ force: true });
await urlInput.fill(website_url);
console.log('✅ Filled site URL:', website_url);

// Prefer Enter rather than ambiguous Continue buttons
await urlInput.press('Enter');
await page.waitForTimeout(5000);

 
 

// ── STEP 2: Wait for verification result / handle auto-verify / fallback to HTML tag ─────
console.log('🔍 Waiting for Search Console verification state...');
await page.waitForTimeout(5000);

const verificationStateText = await page.evaluate(() => document.body.innerText || '');
console.log('📄 Verification screen text:', verificationStateText.substring(0, 2000));

// Case 1: auto-verified or already verified
if (
  verificationStateText.includes('Ownership auto verified') ||
  verificationStateText.includes('Ownership verified') ||
  verificationStateText.includes('Property verified') ||
  verificationStateText.includes('You are a verified owner') ||
  verificationStateText.includes('Google Analytics, Google Tag Manager')
) {
  console.log('✅ Search Console property verified automatically');

  const goToPropertyBtn = page.locator('button:has-text("GO TO PROPERTY"), button:has-text("Go to property")').first();
  if (await goToPropertyBtn.isVisible().catch(() => false)) {
    await goToPropertyBtn.click().catch(() => {});
  } else {
    const doneBtn = page.locator('button:has-text("DONE"), button:has-text("Done")').first();
    if (await doneBtn.isVisible().catch(() => false)) {
      await doneBtn.click().catch(() => {});
    }
  }

  await browser.close();

  return res.json({
    status: 'success',
    message: 'Search Console property added and auto-verified',
    website_url,
    verified: true,
    method: 'auto_verified'
  });
}

// Case 2: not auto-verified, use HTML tag
console.log('🔍 Property not auto-verified — looking for HTML tag method...');
await page.waitForTimeout(3000);

// Open "Other verification methods" first if present
const otherMethods = page.locator('text=Other verification methods').first();
if (await otherMethods.isVisible().catch(() => false)) {
  await otherMethods.click({ force: true }).catch(() => {});
  await page.waitForTimeout(2000);
}

// Open HTML tag section if present
const htmlTagSection = page.locator('text=HTML tag').first();
if (await htmlTagSection.isVisible().catch(() => false)) {
  await htmlTagSection.click({ force: true }).catch(() => {});
  await page.waitForTimeout(2000);
}

// Extract the HTML meta verification tag
console.log('🔍 Extracting HTML meta verification tag...');
const metaTagText = await page.evaluate(() => {
  const selectors = [
    'code',
    'input[readonly]',
    'textarea[readonly]',
    '[role="textbox"]'
  ];

  for (const selector of selectors) {
    const els = document.querySelectorAll(selector);
    for (const el of els) {
      const text = el.value || el.textContent || '';
      if (text.includes('google-site-verification')) {
        return text.trim();
      }
    }
  }

  const bodyText = document.body.innerText || '';
  const match = bodyText.match(/<meta name="google-site-verification"[^>]+>/i);
  return match ? match[0] : null;
});

if (!metaTagText) {
  const debugSnippet = await page.evaluate(() => (document.body.innerText || '').substring(0, 2000));
  console.log('❌ Could not extract meta tag. Page text snippet:', debugSnippet);
  throw new Error('Could not extract meta verification tag from Search Console');
}

console.log('✅ Got meta tag:', metaTagText);

const contentMatch = metaTagText.match(/content="([^"]+)"/);
if (!contentMatch) throw new Error('Could not parse content value from meta tag');

const verificationCode = contentMatch[1];
const metaTag = `<meta name="google-site-verification" content="${verificationCode}" />`;

  // ── STEP 3: Log into WordPress ─────────────────────────────────────────
  console.log('🔐 Logging into WordPress...');
  const wpPage = await browser.newPage();
  await wpPage.goto(wp_admin_url, { waitUntil: 'domcontentloaded' });
  await wpPage.waitForTimeout(2000);

  // Re-login helper for session expiry
  async function wpGoto(url) {
    await wpPage.goto(url, { waitUntil: 'domcontentloaded' });
    await wpPage.waitForTimeout(2000);
    const currentUrl = wpPage.url();
    if (currentUrl.includes('wp-login') || currentUrl.includes('reauth=1')) {
      console.log('🔄 WP session expired, re-logging in...');
      await wpPage.goto(`${baseUrl}/wp-login.php`, { waitUntil: 'domcontentloaded' });
      await wpPage.locator('#user_login, input[name="log"]').first().fill(cms_username);
      await wpPage.locator('#user_pass, input[name="pwd"]').first().fill(cms_password);
      await wpPage.locator('#wp-submit, input[type="submit"]').first().click();
      await wpPage.waitForURL('**/wp-admin/**', { timeout: 30000 });
      await wpPage.waitForTimeout(1000);
      await wpPage.goto(url, { waitUntil: 'domcontentloaded' });
      await wpPage.waitForTimeout(2000);
    }
  }

  await wpPage.locator('#user_login, input[name="log"]').first().waitFor({ timeout: 30000 });
  await wpPage.locator('#user_login, input[name="log"]').first().fill(cms_username);
  await wpPage.locator('#user_pass, input[name="pwd"]').first().fill(cms_password);
  await wpPage.locator('#wp-submit, input[type="submit"]').first().click();
  await wpPage.waitForURL('**/wp-admin/**', { timeout: 30000 });
  await wpPage.waitForTimeout(1000);
  console.log('✅ Logged into WordPress');

  // ── STEP 4: Install/activate WPCode (same pattern as install_gtm_codes) ─
  console.log('🔌 Checking for WPCode plugin...');
  await wpGoto(`${baseUrl}/wp-admin/plugins.php`);

  const wpCodeRow = wpPage.locator('tr[data-slug="insert-headers-and-footers"]').first();
  const pluginExists = await wpCodeRow.count() > 0;

  if (!pluginExists) {
    console.log('⚠️ WPCode not found, installing...');
    await wpGoto(`${baseUrl}/wp-admin/plugin-install.php`);

    const searchInput = wpPage.locator('#search-plugins, input[name="s"]').first();
    await searchInput.waitFor({ timeout: 30000 });
    await searchInput.fill('WPCode');
    await wpPage.keyboard.press('Enter');
    await wpPage.waitForTimeout(3000);

    const installBtn = wpPage.locator('a:has-text("Install Now")').first();
    await installBtn.waitFor({ timeout: 30000 });
    await installBtn.click();
    console.log('✅ Plugin installed');
    await wpPage.waitForTimeout(5000);

    const activateBtn = wpPage.locator('a:has-text("Activate")').first();
    await activateBtn.waitFor({ timeout: 30000 });
    await activateBtn.click();
    console.log('✅ Plugin activated');
    await wpPage.waitForTimeout(3000);

  } else {
    console.log('✅ WPCode found');
    const activateLink = wpCodeRow.locator('a:has-text("Activate")').first();
    const isInactive = await activateLink.isVisible().catch(() => false);

    if (isInactive) {
      console.log('⚠️ Activating WPCode...');
      await activateLink.click();
      await wpPage.waitForTimeout(3000);
      console.log('✅ Plugin activated');
    } else {
      console.log('✅ WPCode already active');
    }
  }

  // ── STEP 5: Inject meta tag into <head> via WPCode ─────────────────────
  console.log('⚙️ Opening WPCode Header & Footer...');
  await wpGoto(`${baseUrl}/wp-admin/admin.php?page=wpcode-headers-footers`);

  // Read existing head content so we don't wipe GTM codes
  const existingHead = await wpPage.evaluate(() => {
    const editors = document.querySelectorAll('.CodeMirror');
    return editors[0] && editors[0].CodeMirror ? editors[0].CodeMirror.getValue() : '';
  });

  if (existingHead.includes('google-site-verification')) {
    console.log('ℹ️ Verification tag already in head, skipping injection');
  } else {
    const newHeadContent = existingHead ? existingHead + '\n' + metaTag : metaTag;

    await wpPage.evaluate((headCode) => {
      const editors = document.querySelectorAll('.CodeMirror');
      if (editors[0] && editors[0].CodeMirror) {
        editors[0].CodeMirror.setValue(headCode);
      }
    }, newHeadContent);

    console.log('✅ Meta tag injected into head');

    const saveBtn = wpPage.locator('button:has-text("Save Changes"), input[type="submit"]').first();
    await saveBtn.click();
    console.log('✅ WPCode settings saved');
    await wpPage.waitForTimeout(2000);
  }

  await wpPage.close();

  // ── STEP 6: Go back to Search Console and verify ───────────────────────
  console.log('🔍 Clicking Verify in Search Console...');
  await page.bringToFront();
  await page.waitForTimeout(3000);

  const verifyBtn = page.locator('button:has-text("VERIFY"), button:has-text("Verify")').first();
  await verifyBtn.waitFor({ timeout: 15000 });
  await verifyBtn.click();
  await page.waitForTimeout(6000);

  const verified = await page.evaluate(() => {
    const body = document.body.innerText;
    return body.includes('Ownership verified') || body.includes('verified');
  });

  await browser.close();

  if (verified) {
    return res.json({
      status: 'success',
      message: 'Search Console property added and verified',
      website_url,
      verified: true
    });
  } else {
    const pageSnippet = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
    return res.json({
      status: 'partial',
      message: 'Meta tag injected but verification result unclear — check Search Console manually',
      website_url,
      verified: false,
      page_state: pageSnippet
    });
  }
}




if (action === 'fetch_gtm_codes') {
  console.log('🔍 Fetching GTM codes for container:', req.body.gtm_container_id);

  const { gtm_container_id } = req.body;
  if (!gtm_container_id) throw new Error('Missing gtm_container_id');

  // Navigate to GTM
  await page.goto('https://tagmanager.google.com', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Find and click the container, then select most active workspace
  console.log('🔍 Looking for container:', gtm_container_id);
  await openContainerFromHomeList(page, gtm_container_id);

  // Extract numeric account and container IDs from URL
  const gtmUrl = page.url();
  console.log('📍 GTM URL after workspace entry:', gtmUrl);
  let numericAccountId = null;
  let numericContainerId = null;
  const gtmUrlMatch = gtmUrl.match(/accounts\/(\d+)\/containers\/(\d+)/);
  if (gtmUrlMatch) {
    numericAccountId = gtmUrlMatch[1];
    numericContainerId = gtmUrlMatch[2];
    console.log('✅ Numeric Account ID:', numericAccountId);
    console.log('✅ Numeric Container ID:', numericContainerId);
  } else {
    console.log('⚠️ Could not extract numeric IDs from URL:', gtmUrl);
  }

  // Now we're in the workspace — go to Admin tab
  console.log('⚙️ Clicking Admin tab...');
  const adminTab = page.locator('a:has-text("Admin"), [role="link"]:has-text("Admin")').first();
  await adminTab.waitFor({ state: 'visible', timeout: 30000 });
  await adminTab.click();
  await page.waitForTimeout(2000);

  // Click Install Google Tag Manager
  console.log('🔍 Clicking Install Google Tag Manager...');
  const installLink = page.locator(
    'a:has-text("Install Google Tag Manager"), ' +
    '[role="link"]:has-text("Install Google Tag Manager")'
  ).first();
  await installLink.waitFor({ state: 'visible', timeout: 30000 });
  await installLink.click();
  await page.waitForTimeout(2000);

  // Extract codes
  console.log('📋 Extracting GTM codes...');
  const { containerId, gtmHeadCode, gtmBodyCode } = await extractGTMCodes(page);

  await browser.close();
  return res.json({
    status: 'success',
    gtm_container_id: containerId,
    gtm_head_code: gtmHeadCode,
    gtm_body_code: gtmBodyCode,
    numeric_account_id: numericAccountId,
    numeric_container_id: numericContainerId
  });
}

if (action === 'fetch_gtm_codes') {
  console.log('🔍 Fetching GTM codes for container:', req.body.gtm_container_id);

  const { gtm_container_id } = req.body;
  if (!gtm_container_id) throw new Error('Missing gtm_container_id');

  // Navigate to GTM
  await page.goto('https://tagmanager.google.com', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Find and click the container, then select most active workspace
  console.log('🔍 Looking for container:', gtm_container_id);
  await openContainerFromHomeList(page, gtm_container_id);

  // Extract numeric account and container IDs from URL
  const gtmUrl = page.url();
  console.log('📍 GTM URL after workspace entry:', gtmUrl);
  let numericAccountId = null;
  let numericContainerId = null;
  const gtmUrlMatch = gtmUrl.match(/accounts\/(\d+)\/containers\/(\d+)/);
  if (gtmUrlMatch) {
    numericAccountId = gtmUrlMatch[1];
    numericContainerId = gtmUrlMatch[2];
    console.log('✅ Numeric Account ID:', numericAccountId);
    console.log('✅ Numeric Container ID:', numericContainerId);
  } else {
    console.log('⚠️ Could not extract numeric IDs from URL:', gtmUrl);
  }

  // Now we're in the workspace — go to Admin tab
  console.log('⚙️ Clicking Admin tab...');
  const adminTab = page.locator('a:has-text("Admin"), [role="link"]:has-text("Admin")').first();
  await adminTab.waitFor({ state: 'visible', timeout: 30000 });
  await adminTab.click();
  await page.waitForTimeout(2000);

  // Click Install Google Tag Manager
  console.log('🔍 Clicking Install Google Tag Manager...');
  const installLink = page.locator(
    'a:has-text("Install Google Tag Manager"), ' +
    '[role="link"]:has-text("Install Google Tag Manager")'
  ).first();
  await installLink.waitFor({ state: 'visible', timeout: 30000 });
  await installLink.click();
  await page.waitForTimeout(2000);

  // Extract codes
  console.log('📋 Extracting GTM codes...');
  const { containerId, gtmHeadCode, gtmBodyCode } = await extractGTMCodes(page);

  await browser.close();
  return res.json({
    status: 'success',
    gtm_container_id: containerId,
    gtm_head_code: gtmHeadCode,
    gtm_body_code: gtmBodyCode,
    numeric_account_id: numericAccountId,
    numeric_container_id: numericContainerId
  });
}


async function openContainerFromHomeList(page, gtmContainerId) {
  console.log('⏳ Waiting for container list to load...');
  await page.waitForTimeout(3000);

  console.log('🔍 Searching for container:', gtmContainerId);

  const scrollable = await page.$('.gtm-container-list, [class*="container-list"], .accounts-list, md-list, .md-list, main, .content-area');

  let found = false;
  for (let i = 0; i < 30; i++) {
    const match = page.getByText(gtmContainerId, { exact: true }).first();
    const visible = await match.isVisible().catch(() => false);

    if (visible) {
      console.log('✅ Found container:', gtmContainerId);
      const row = page.locator(`tr:has-text("${gtmContainerId}"), [role="row"]:has-text("${gtmContainerId}")`).first();
      const link = row.locator('a, td').first();
      await link.click();
      found = true;
      break;
    }

    if (scrollable) {
      await scrollable.evaluate(el => el.scrollBy(0, 300));
    } else {
      await page.evaluate(() => window.scrollBy(0, 300));
    }
    await page.waitForTimeout(400);
  }

  if (!found) throw new Error(`Container ${gtmContainerId} not found`);

  // Wait for URL to change to workspaces page
  console.log('⏳ Waiting for workspaces page...');
  await page.waitForURL('**/workspaces/**', { timeout: 15000 });
  await page.waitForTimeout(1000);

  // Check if workspace modal appeared
  const hasModal = await page.locator('.column-name:has-text("AP Tracking Setup")').isVisible().catch(() => false);

  if (hasModal) {
    console.log('📋 Workspace modal detected, clicking AP Tracking Setup...');
    await page.locator('.column-name:has-text("AP Tracking Setup")').first().click();
    await page.waitForTimeout(2000);
  } else {
    console.log('✅ Already in workspace, no modal needed');
  }

  await page.waitForSelector('a:has-text("Tags")', { timeout: 30000 });
  console.log('✅ Inside workspace for:', gtmContainerId);
}








if (action === 'test_tracking_ctas') {
  const { website_url } = req.body;
  if (!website_url) throw new Error('Missing website_url');

  const targetUrl = website_url.startsWith('http') ? website_url : `https://${website_url}`;
  const results = { phones: [], emails: [], forms: [] };

  const TEST_VALUES = {
    fullName: 'HealthCheck Test', email: 'test-automation@example.com',
    phone: '01632960123', message: 'This is a tracking health check. Please ignore.'
  };

  const GENERIC_EVENTS = ['page_view', 'user_engagement', 'scroll', 'session_start', 'first_visit'];
  const beacons = [];

  // Intercept GA4 beacons
  await page.on('request', req => {
    const u = req.url();
    if (u.includes('/g/collect') || u.includes('google-analytics') || u.includes('googletagmanager')) {
      let en = null;
      try { en = new URL(u).searchParams.get('en'); } catch {}
      if (!en) { try { en = new URLSearchParams(req.postData() || '').get('en'); } catch {} }
      beacons.push({ url: u, event_name: en });
    }
  });

  // Mock form POST submissions so we don't spam clients
  await page.route('**/*', (route) => {
    const r = route.request();
    if (r.method() === 'POST' && !r.url().includes('google')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    route.continue();
  });

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Check all pages
  const pagesToCheck = [
    targetUrl,
    targetUrl.replace(/\/$/, '') + '/contact',
    targetUrl.replace(/\/$/, '') + '/contact-us',
  ];

  for (const pageUrl of pagesToCheck) {
    console.log(`🔎 Checking: ${pageUrl}`);
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);

      // ── Phone CTAs ──
      const phones = await page.$$eval('a[href^="tel:" i]', els => els.map(a => a.getAttribute('href')));
      for (const tel of phones) {
        if (results.phones.find(p => p.href === tel)) continue;
        console.log(`📞 Testing phone: ${tel}`);
        const before = beacons.length;
        const el = page.locator(`a[href="${tel}" i]`).first();
        await el.click({ noWaitAfter: true }).catch(() => {});
        await page.waitForTimeout(3000);
        const fired = beacons.slice(before).filter(b => !GENERIC_EVENTS.includes(b.event_name));
        results.phones.push({
          href: tel,
          status: fired.length ? 'PASS' : 'FAIL',
          events: fired.map(b => b.event_name)
        });
      }

      // ── Email CTAs ──
      const emails = await page.$$eval('a[href^="mailto:" i]', els => els.map(a => a.getAttribute('href')));
      for (const mail of emails) {
        if (results.emails.find(e => e.href === mail)) continue;
        console.log(`📧 Testing email: ${mail}`);
        const before = beacons.length;
        const el = page.locator(`a[href="${mail}" i]`).first();
        await el.click({ noWaitAfter: true }).catch(() => {});
        await page.waitForTimeout(3000);
        const fired = beacons.slice(before).filter(b => !GENERIC_EVENTS.includes(b.event_name));
        results.emails.push({
          href: mail,
          status: fired.length ? 'PASS' : 'FAIL',
          events: fired.map(b => b.event_name)
        });
      }

      // ── Forms ──
      const formCount = await page.$$eval('form', forms => forms.length);
      for (let i = 0; i < formCount; i++) {
        const form = page.locator('form').nth(i);

        // Score form to check it's a lead form
        const isLeadForm = await form.evaluate(f => {
          const hay = (f.id + ' ' + f.className + ' ' + f.innerText).toLowerCase();
          if (/search|login|subscribe/.test(hay) && f.querySelectorAll('input').length < 3) return false;
          return !!f.querySelector('input[type="email"], textarea, input[name*="email" i]');
        }).catch(() => false);

        if (!isLeadForm) continue;

        console.log(`📝 Testing form ${i} on ${pageUrl}`);
        const before = beacons.length;

        // Fill fields
        const fields = form.locator('input:visible, textarea:visible, select:visible');
        const fieldCount = await fields.count();
        for (let j = 0; j < fieldCount; j++) {
          const field = fields.nth(j);
          const type = await field.getAttribute('type').catch(() => '');
          const name = (await field.getAttribute('name').catch(() => '')) || '';
          const tag = await field.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

          if (type === 'hidden') continue;
          if (tag === 'select') {
            await field.evaluate(sel => { if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', { bubbles: true })); } }).catch(() => {});
          } else if (type === 'checkbox' || type === 'radio') {
            await field.check({ force: true }).catch(() => {});
          } else if (/email/.test(type + name)) {
            await field.fill(TEST_VALUES.email).catch(() => {});
          } else if (/phone|tel/.test(type + name)) {
            await field.fill(TEST_VALUES.phone).catch(() => {});
          } else if (tag === 'textarea') {
            await field.fill(TEST_VALUES.message).catch(() => {});
          } else {
            await field.fill(TEST_VALUES.fullName).catch(() => {});
          }
        }

        // Submit
        const btn = form.locator('button[type="submit"], input[type="submit"], button').first();
        await btn.click({ noWaitAfter: true }).catch(() => form.evaluate(f => f.submit()).catch(() => {}));
        await page.waitForTimeout(4000);

        const fired = beacons.slice(before).filter(b => !GENERIC_EVENTS.includes(b.event_name));
        const successText = await page.evaluate(() => /thank|success|sent|confirm/i.test(document.body.innerText)).catch(() => false);

        results.forms.push({
          page: pageUrl,
          form_index: i,
          status: fired.length ? 'PASS' : 'FAIL',
          events: fired.map(b => b.event_name),
          form_submitted: successText
        });

        if (fired.length) break; // Found a working form, move on
      }
    } catch (err) {
      console.log(`⚠️ Could not check ${pageUrl}: ${err.message}`);
    }
  }

  console.log('📋 CTA Test Results:', JSON.stringify(results, null, 2));

  await browser.close();
  return res.json({
    status: 'success',
    website_url: targetUrl,
    phones: results.phones,
    emails: results.emails,
    forms: results.forms,
    summary: {
      phones_found: results.phones.length,
      phones_passed: results.phones.filter(p => p.status === 'PASS').length,
      emails_found: results.emails.length,
      emails_passed: results.emails.filter(e => e.status === 'PASS').length,
      forms_found: results.forms.length,
      forms_passed: results.forms.filter(f => f.status === 'PASS').length,
    }
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





