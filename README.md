[README.md](https://github.com/user-attachments/files/26136264/README.md)
# ga-automation

A Node.js automation server that handles GA4 account creation, GTM container setup, CMS code installation, and tracking health checks across client websites. Built with Playwright (browser automation) and Express (HTTP API).

---

## Repository Structure

```
ga-automation/
├── runners.js              ← Main GA4/GTM automation server
├── server.js               ← Health check server (port 3000)
├── gateway.js              ← Reverse proxy routing traffic between servers
├── health.runners.js       ← Playwright-based tracking health check engine
├── health.routes.js        ← Express router for health check endpoint
├── Dockerfile              ← Docker image config (runs runners.js on port 10000)
├── Dockerfile.txt          ← Backup/reference copy of Dockerfile
├── package.json            ← Project dependencies
├── package-lock.json       ← Locked dependency versions
├── .dockerignore           ← Files excluded from Docker build
├── .gitignore              ← Files excluded from Git
└── ngrok - Shortcut*.lnk  ← Windows shortcuts to launch ngrok tunnel
```

---

## File Descriptions

### `runners.js` — Main Automation Server
**Port: 3000**

The core automation server. Accepts POST requests to `/run` and executes browser automation actions using Playwright (headless Chromium) against Google Analytics, Google Tag Manager, and client CMS platforms.

**Supported actions (passed as `action` in the request body):**

| Action | What it does |
|---|---|
| `login_and_create_ga4` | Navigates to GA4 Admin and checks whether a new account can be created (capacity check) |
| `create_ga_account` | Runs the full 4-step GA4 account creation wizard (account name → property → business info → objectives → terms → web stream) |
| `fetch_gtag_and_property_id` | Navigates to the correct GA4 property, opens the web data stream, extracts the `gtag` snippet and `measurement_id`, then extracts the `property_id` from Property Details |
| `check_gtm_capacity` | Creates a GTM account form to test whether the account pool has space; returns GTM codes and numeric IDs if successful |
| `fetch_gtm_codes` | Opens an existing GTM container by ID, navigates to Admin → Install GTM, and returns the head/body code snippets |
| `configure_and_publish_gtm` | Navigates directly to a GTM workspace by numeric IDs and publishes it |
| `install_gtm_codes` | Logs into a client CMS (WordPress, Wix, or Squarespace) and installs the GTM head/body codes. Also detects the contact form plugin type and success selector for later tracking setup |
| `add_search_console_property` | Adds a URL-prefix Search Console property, extracts the HTML meta verification tag, injects it into WordPress via WPCode, and verifies ownership |
| `test_tracking_ctas` | Visits the client website and tests whether phone links, email links, and contact forms fire GA4 events when clicked/submitted |
| `submit_google_otp` | Handles Google 2FA — receives an OTP code for an in-progress login session |

**Key internal helpers inside `runners.js`:**
- `fillWebStreamForm` — fills the GA4 web stream creation form
- `openTagInstructionsAndExtract` — opens the "View tag instructions" modal and extracts the gtag snippet + measurement ID
- `extractGTMCodes` — finds GTM head/body code snippets (or constructs them from the container ID)
- `openContainerFromHomeList` — locates and opens a GTM container from the home list by container ID
- `acceptGTMTerms` — handles the GTM terms of service modal including checkbox logic
- `discoverSitePages` — crawls the client site to find pages with contact forms
- `detectSuccessSelector` — detects which form plugin is in use (CF7, WPForms, Gravity Forms, Elementor, etc.) and returns a CSS selector for the success message

---

### `server.js` — Health Check HTTP Server
**Port: 3000**

A lightweight Express server that mounts the health check routes and exposes a simple status endpoint.

- `GET /health` → returns `{ status: 'ok', timestamp: '...' }`
- `POST /health/run` → proxied to `health.routes.js`
- Sets permissive CORS headers so it can be called from n8n or external tools

> **Note:** `server.js` and `runners.js` both default to port 3000. In the deployed setup, `gateway.js` sits in front and routes `/health/*` traffic to `server.js` on port 3001, and everything else to `runners.js` on port 3000. Make sure to check port assignments if running locally.

---

### `gateway.js` — Reverse Proxy / Traffic Router
**Port: 8080**

An Express reverse proxy that sits in front of both servers and routes requests based on path:

- `POST /health/*` → forwarded to health runner on port **3001**
- Everything else (`/run`, etc.) → forwarded to main runner on port **3000**

This means externally (e.g. from ngrok or n8n) you only need to call one port (8080). The gateway handles routing internally.

**To change ports:** edit `EXISTING_RUNNER_PORT` (default `3000`) and `HEALTH_RUNNER_PORT` (default `3001`) at the top of the file.

---

### `health.runners.js` — Tracking Health Check Engine
**Version: V27-CONCURRENCY-FIX**

The main logic for the tracking health check system. Exports a single function `trackingHealthCheckSite(url)`.

Given a client website URL, it:

1. Launches a Playwright browser session
2. Navigates to the homepage and up to 2 additional contact/enquiry pages
3. Intercepts all network requests to capture GA4 beacons
4. Accepts cookie consent banners
5. Waits for GTM to initialise (active poll for `window.google_tag_manager`)
6. Checks for clickable phone links (`tel:`) and email links (`mailto:`) — clicks them and checks whether a non-generic GA4 event fires
7. Runs a duplicate-fire test: clicks each CTA a second time and checks if the tag fires again (indicates GTM is set to "Once per event" rather than "Once per page")
8. Scans for plain-text phone numbers and emails that aren't wrapped in links (these can't be tracked)
9. Fills and submits contact forms, checks whether a GA4 event fires post-submission
10. Grades the site: **T1** (all pass), **T2** (partial/issues), **T3** (untestable), or **FAIL** (GTM present but nothing fires)

**Concurrency:** handles up to 20 simultaneous checks. Uses an async queue with slot acquisition/release and a 120-second global timeout per site.

**Environment variables (all optional):**

| Variable | Default | Description |
|---|---|---|
| `HEALTH_MAX_PAGES` | `3` | Max pages to visit per site |
| `HEALTH_NAV_TIMEOUT` | `15000` | Page navigation timeout (ms) |
| `HEALTH_GLOBAL_TIMEOUT` | `120000` | Hard cap per site (ms) |
| `HEALTH_MAX_CONCURRENT` | `20` | Max parallel checks |
| `LOG_LEVEL` | `info` | Set to `debug` for verbose output, `silent` to suppress |

---

### `health.routes.js` — Health Check API Route
Mounts on `/health/run` inside `server.js`.

Accepts `POST /health/run` with body:
```json
{
  "action": "tracking_health_check_site",
  "url": "https://example.com",
  "expected": { ... }
}
```

Calls `trackingHealthCheckSite(url)` from `health.runners.js` and returns the full result JSON. Returns a 400 if `action` is not `tracking_health_check_site` or if `url` is missing.

---

### `Dockerfile` — Docker Build Config
Builds a production Docker image for the automation server:

- Base image: `mcr.microsoft.com/playwright:v1.50.0-jammy` (includes Chromium + all browser dependencies)
- Working directory: `/app`
- Installs npm dependencies
- Sets `NODE_ENV=production`
- Exposes port **10000**
- Starts with `node runners.js`

> `Dockerfile.txt` is an identical backup copy — safe to ignore.

---

### `package.json` — Dependencies

| Package | Type | Purpose |
|---|---|---|
| `express` ^5.2.1 | dependency | HTTP server framework |
| `http-proxy-middleware` ^3.0.5 | dependency | Reverse proxy used in `gateway.js` |
| `playwright` ^1.57.0 | devDependency | Browser automation (Chromium) |

---

### `.gitignore` / `.dockerignore`
Both exclude `node_modules`, `.env`, `*.log`. `.gitignore` also excludes `.DS_Store`; `.dockerignore` also excludes `.git`.

---

### `ngrok - Shortcut*.lnk`
Windows shortcut files for launching ngrok to expose the local server over a public URL. Used during development to allow n8n (or other tools) to reach the automation server running on a local machine or VPS. Not required in production/Docker deployments.

---

## How the System Fits Together

```
n8n / external caller
        │
        ▼
  gateway.js :8080
   ┌──────────────────────────┐
   │  /health/* → :3001       │  ← server.js + health.routes.js + health.runners.js
   │  everything else → :3000 │  ← runners.js
   └──────────────────────────┘
```

In practice, n8n sends HTTP POST requests to the ngrok URL (which tunnels to port 8080). The gateway routes the request to the correct server. Results come back as JSON.

---

## Running Locally

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Start the main runner
node runners.js

# In a separate terminal — start the health check server
node server.js

# In a separate terminal — start the gateway (optional, needed if using both servers)
node gateway.js
```

Or with Docker:
```bash
docker build -t ga-automation .
docker run -p 10000:10000 ga-automation
```

---

## Environment Variables

Create a `.env` file (never commit this):

```env
# Optional — override health check defaults
LOG_LEVEL=info
HEALTH_MAX_PAGES=3
HEALTH_MAX_CONCURRENT=20
HEALTH_GLOBAL_TIMEOUT=120000
HEALTH_NAV_TIMEOUT=15000

# Optional — test contact values used by health check
HEALTH_TEST_EMAIL=test-automation@example.com
HEALTH_TEST_PHONE=01632960123
```

Credentials (Google email/password, CMS logins) are passed per-request in the POST body to `runners.js`, not stored as env vars.
