cat > server.js << 'EOF'
const express = require('express');
const { trackingHealthCheckSite } = require('./health.runners.js');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Main endpoint
app.post('/health-check', async (req, res) => {
  try {
    const { url, client_id, client_name } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    console.log(`Checking: ${url}`);
    
    const result = await trackingHealthCheckSite(url);
    
    if (client_id) result.client_id = client_id;
    if (client_name) result.client_name = client_name;
    
    console.log(`Done: ${result.overall_status}`);
    
    res.json(result);
    
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      error: error.message,
      overall_status: 'ERROR'
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
EOF
