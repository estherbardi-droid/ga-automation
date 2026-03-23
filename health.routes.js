const express = require('express');
const { trackingHealthCheckSite, runBatchHealthCheck, getBatchJob } = require('./health.runners');
const crypto = require('crypto');
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

// Batch health check endpoint
// Accepts either:
//   { clients: [{url, client_name, supabase_id, cid, order_number, ...}], callback_url? }
//   { urls: ["https://..."], callback_url? }  (legacy — plain URL strings)
router.post('/batch', async (req, res) => {
  const { clients, urls, callback_url } = req.body || {};

  // Support both `clients` (objects) and legacy `urls` (strings)
  const input = clients || urls;

  if (!input || !Array.isArray(input)) {
    return res.status(400).json({
      ok: false,
      error: 'Provide either a "clients" array of objects or a "urls" array of strings'
    });
  }

  if (input.length === 0) {
    return res.status(400).json({ ok: false, error: 'clients/urls array cannot be empty' });
  }

  if (input.length > 2000) {
    return res.status(400).json({ ok: false, error: 'Maximum 2000 clients per batch' });
  }

  // Each entry must be a string URL or an object with a url field
  const invalid = input.find(c => typeof c !== 'string' && (typeof c !== 'object' || !c.url));
  if (invalid) {
    return res.status(400).json({
      ok: false,
      error: 'Each entry must be a string URL or an object with a "url" field'
    });
  }

  try {
    const jobId = crypto.randomUUID();
    console.log(`Batch job ${jobId} started — ${input.length} clients`);

    // Fire-and-forget; results accumulate in the job store
    runBatchHealthCheck(jobId, input, callback_url).catch(err => {
      console.error(`Batch job ${jobId} fatal error:`, err);
    });

    return res.status(202).json({
      ok: true,
      job_id: jobId,
      queued: input.length,
      status_url: `/health/batch/${jobId}`,
      message: 'Batch job started'
    });

  } catch (error) {
    console.error('Batch health check error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// Get batch job status
router.get('/batch/:job_id', (req, res) => {
  const { job_id } = req.params;

  const job = getBatchJob(job_id);

  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Job not found'
    });
  }

  return res.json({
    ok: true,
    job_id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    results: job.results,
    startedAt: job.startedAt,
    completedAt: job.status === 'complete' ? new Date().toISOString() : null
  });
});

module.exports = router;
