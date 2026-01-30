const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

app.post('/run', async (req, res) => {
  const { action, client_name, site_url } = req.body;

  console.log('Action requested:', action);
  console.log('Client:', client_name);
  console.log('Site:', site_url);

  if (action === 'open_ga') {
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();

    await page.goto('https://analytics.google.com');
    await page.waitForTimeout(5000);

    await browser.close();

    return res.json({ status: 'ok', action: 'open_ga' });
  }

  if (action === 'create_ga4') {
    // NOT IMPLEMENTED YET
    return res.json({
      status: 'pending',
      message: 'GA4 creation logic not implemented yet'
    });
  }

  return res.status(400).json({ error: 'Unknown action' });
});

app.listen(3000, () => {
  console.log('Runner listening on port 3000');
});
