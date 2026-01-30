const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

// CHANGE THIS if your existing runners.js listens on a different port:
const EXISTING_RUNNER_PORT = 3000;

// Health runner port (we will create this next):
const HEALTH_RUNNER_PORT = 3001;

// 1) Requests starting with /health -> Health runner
app.use(
  "/health",
  createProxyMiddleware({
    target: `http://127.0.0.1:${HEALTH_RUNNER_PORT}`,
    changeOrigin: true,
    pathRewrite: { "^/health": "" },
    proxyTimeout: 120000,
    timeout: 120000,
  })
);

// 2) Everything else -> Existing runner
app.use(
  "/",
  createProxyMiddleware({
    target: `http://127.0.0.1:${EXISTING_RUNNER_PORT}`,
    changeOrigin: true,
    proxyTimeout: 120000,
    timeout: 120000,
  })
);

app.listen(8080, () => {
  console.log(`✅ Gateway listening on http://127.0.0.1:8080`);
  console.log(`➡️  /health/* -> ${HEALTH_RUNNER_PORT}`);
  console.log(`➡️  everything else -> ${EXISTING_RUNNER_PORT}`);
});
