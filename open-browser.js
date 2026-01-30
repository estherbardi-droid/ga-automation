const { chromium } = require('playwright');

(async () => {
  console.log('Playwright script started');

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://analytics.google.com');
  await page.waitForTimeout(5000);

  await browser.close();

  console.log('Playwright script finished');
})();
