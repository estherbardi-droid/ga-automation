// health.routes.js
const express = require('express');
const { trackingHealthCheckSite } = require('./health.runners');

const router = express.Router();

router.post('/run', async (req, res) => {
  const { action, url, expected } = req.body || {};

  if (action !== 'tracking_health_check_site') {
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }

  if (!url) {
    return res.status(400).json({ ok: false, error: 'URL is required' });
  }

  try {
    console.log(`Received health check request for: ${url}`);
    
    // Call the health runner function
    const results = await trackingHealthCheckSite(url);
    
    // Return results
    return res.json({
      ok: true,
      ...results,
      expected: expected ?? null
    });
    
  } catch (error) {
    console.error('Health check error:', error);
    return res.status(500).json({ 
      ok: false, 
      error: error.message,
      url 
    });
  }
});

module.exports = router;
