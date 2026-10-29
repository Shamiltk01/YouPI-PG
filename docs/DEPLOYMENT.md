# YOUPI PG V2 — Deployment & Installation Guide

This document describes how to deploy and run the clean distributable **YOUPI PG V2** package.

## 1. Prerequisites

- **Operating System**: Linux (Ubuntu 22.04+ / Debian 12+), macOS, or Windows 10/11 / Windows Server.
- **Node.js**: Version `>= 24.22.1`, matching the root package engine requirement.
- **Package Manager**: `npm` (included with Node.js).
- **Network Ports**:
  - `6100`: Payment Core API
  - `7000`: Checkout Portal & `youpi.js` SDK host
  - `6001`: Merchant Admin Panel
  - `5000`: Demo Coin Wallet Store (Reference Implementation)
  - `6002`: SMS Observer
  - `6003`: Gmail Observer
  - `8090`: Control Center Supervisor

---

## 2. Installation Steps

### Step 1: Extract / Clone Package

Ensure you are in the package root directory:

```bash
cd "YOUPI PG PACKAGE"
```

### Step 2: Configure Environment

Copy the clean template to `.env`:

```bash
cp .env.example .env
```

Open `.env` in your editor and configure:

1. `ENCRYPTION_MASTER_KEY`: Generate a 64-character hex key (e.g. `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`).
2. `JWT_SECRET`: Random string at least 32 characters.
3. `ADMIN_API_TOKEN`: A private random token used to unlock the Merchant Admin dashboard. The dashboard does not use `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` for login.
4. `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL`: Your public domain or localhost URLs.
5. `DEFAULT_APP_NAME`, `DEFAULT_PRIMARY_COLOR`, `DEFAULT_SUPPORT_EMAIL`: (Optional) White-label branding defaults (see `docs/WHITE_LABEL.md`).

### Step 3: Install Dependencies

```bash
npm install
```

### Step 4: Initialize Fresh Database

Run the automated database setup to initialize schema and seed the default merchant and receiving account:

```bash
node --env-file=.env scripts/init-db.cjs
```

This initializes the local SQLite database and seeds defaults; it is not a reset command. For Layerbase, use the separate initialization steps below instead.

### Step 5: Start the System

#### Development / Demonstration Mode:

```bash
npm run dev
```

Starts all services with live reload and console aggregation under the Control Center at `http://localhost:8090`.

#### Production Mode:

```bash
npm run start
```

Starts services in background daemon mode.

---

## 3. Verifying Your Installation

1. **Checkout Portal & SDK**:
   Open `http://localhost:7000/youpi.js` — you should see the official JavaScript SDK.
2. **Demo Store**:
   Open `http://localhost:5000` — you should see the reference YOUPI Store with the interactive buy button and Developer Guide.
3. **Merchant Admin**:
   Open `http://localhost:6001` and enter your `ADMIN_API_TOKEN` when prompted.
   Configure your active UPI ID and payee name in the Receiving Accounts tab.
4. **Health Check**:
   `curl http://localhost:6100/health` returns `{"status":"UP"}`.

---

## 4. Production Domain & SSL (Cloudflare / NGINX)

For production deployment:

1. Terminate SSL at your reverse proxy (NGINX, Caddy, or Cloudflare Tunnel).
2. Point your public domain (e.g. `pay.yourdomain.com`) to port `7000` (Checkout Portal) or `6100` (Payment API).
   _The Checkout Portal automatically proxies all `/api/_` requests to the Payment API.\*
3. Update `BASE_PAYMENT_API_URL` and `BASE_CHECKOUT_URL` in `.env` to match your public HTTPS domain.
## 5. Vercel + Layerbase Setup

This section applies to the hosted admin panel, for example
`https://youpi-pg-lime.vercel.app/admin`. Dashboard availability alone does not
mean that the payment observers and background jobs are production-ready.

### Step 1: Configure the Project

1. Import the repository into Vercel with the repository root as the project root.
2. Keep the root `vercel.json` multi-service configuration. Do not select only the merchant-admin directory as the project root.
3. Select a Node.js runtime satisfying `>= 24.22.1`. Check the deployment build/runtime logs if Vercel offers only a major-version selector.
4. Deploy the revision containing the admin polling and merchant-onboarding fixes.

The root `vercel.json` defines the approved multi-service deployment. Public
traffic is routed to `/` (checkout), `/api/*` (payment API), `/admin/*`
(merchant admin), `/help/*` (payment help), and `/store/*` (coin wallet store).
The control center, Gmail observer, and SMS observer remain internal services.

Service-to-service URLs are injected by Vercel bindings at runtime. The
application reads `PAYMENT_API_URL`, `CHECKOUT_PORTAL_URL`,
`CONTROL_CENTER_URL`, `GMAIL_OBSERVER_URL`, and `SMS_OBSERVER_URL`; these are
binding variables and must not be manually configured with deployment URLs.

### Step 2: Set Stable Environment Variables

In **Vercel > Project > Settings > Environment Variables**, set the following for
the intended environment. Shared services must receive matching values. Use a
different database and secrets for Preview and Production.

| Variable | Value / Purpose |
| :--- | :--- |
| `DATABASE_URL` | Layerbase hosted SQLite PostgreSQL-wire URL from Quick Connect, with verified TLS (`sslmode=verify-full`) |
| `DATABASE_POOL_MAX` | Start with `5`; account for the provider's connection limit across concurrent function instances |
| `ADMIN_API_TOKEN` | Private admin-unlock token |
| `ENCRYPTION_MASTER_KEY` | Stable 64-character hex key for encrypted records |
| `JWT_SECRET` | Stable random signing secret |
| `OBSERVER_API_TOKEN` | Shared private credential for trusted observer submissions |
| `ANDROID_ENROLLMENT_SECRET` | Private Android pairing secret; replace the template example |
| `INTERNAL_SERVICE_TOKEN` | Shared internal-service credential |
| `DEVICE_CREDENTIAL_KEY` | Stable device-credential signing key |
| `BLIND_INDEX_KEY` | Stable key used for secret indexes |
| `COIN_STORE_WEBHOOK_SECRET` | Stable default merchant/demo-store webhook secret used during initialization |
| `CHECKOUT_PUBLIC_URL` | Your public checkout origin, such as `https://youpi-pg-lime.vercel.app` |
| `CHECKOUT_FRAME_ANCESTORS` | Exact storefront origins allowed to embed the checkout, if the storefront uses another origin |

For a fresh deployment, run the following command yourself locally once for
each secret, using a distinct output for each variable:

```powershell
node -p "require('node:crypto').randomBytes(32).toString('hex')"
```

Do not paste generated secrets into chat or commit them. Do not copy all of the
local `.env.example` values into Vercel: it includes localhost URLs and example
credentials. Set real `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and
`GMAIL_REDIRECT_URI` only when configuring Gmail observation on its actual host.
See [Observers Setup](OBSERVERS_SETUP.md) for observer configuration.

For an existing database, preserve its original encryption and index keys.
Generating replacement keys is not a migration and can make encrypted data or
device credentials unreadable. Keep keys consistent between initialization,
Vercel services, and persistent workers. Rotate database credentials previously
exposed in source or chat. Environment changes require a new deployment.

### Step 3: Initialize Layerbase Safely

1. Install dependencies from the repository root with `npm install`.
2. Prepare a private, ignored `.env` with the same database URL and stable secrets used by the target Vercel deployment. Back up an existing database before schema work.
3. Run this from the repository root:

```powershell
node --env-file=.env --input-type=module -e "import { getDatabase, initializeLayerbaseDatabase } from '@youpi/db'; const db = getDatabase(); try { if (!db.isLayerbase) throw new Error('DATABASE_URL must select Layerbase'); await initializeLayerbaseDatabase(db); console.log('Layerbase schema initialized'); } finally { await db.close(); }"
```

The initializer creates missing schema objects and seeds defaults without
clearing existing merchant or transaction data. The payment API also invokes
this initializer during startup. The local `scripts/init-db.cjs` helper targets
file-based SQLite; do not use it to initialize Layerbase.

### Step 4: Verify the Deployment and Add a Merchant

1. Open `/api/v1/health`. A successful health response is a reachability check, not proof that observers or webhook delivery work.
2. Open `/admin` and enter the exact `ADMIN_API_TOKEN` configured for that deployment, not a merchant API key or database password.
3. Click **+ New**, enter a business name and a unique slug, then click **Create Merchant** once. Optional webhook URLs must pass the public outbound-URL safety checks.
4. Confirm the modal closes and the new merchant is selected in the header. Check **Store Settings** and confirm the business name belongs to that merchant.
5. Reload the page and verify the new merchant remains in the selector. Select it again to verify persisted settings. The current merchant selection itself is not guaranteed to survive reloads.
6. Configure an active receiving UPI account and payee name for that merchant under **Store Settings > Receiving Accounts**. Creating a merchant without a VPA does not make it ready for UPI payments.
7. Configure the merchant's public HTTPS webhook receiver. Keep its API key and webhook secret server-side. Verify webhook HMAC over the raw body; browser success events are not authoritative proof of payment.
8. Pair the merchant's Android observer through **Developer & Infrastructure Hub > Android SMS Hub**, then confirm its heartbeat is fresh. A new UPI session is rejected with `503 OBSERVERS_UNHEALTHY` until the required SMS observer is healthy.

The admin now refreshes the selected view on a non-overlapping 10-second cycle,
pauses while hidden, coalesces identical pending GETs, and backs off failures.
Opening a settings tab should not continuously poll every infrastructure service.
Administrative mutations still require the admin token.

### Step 5: Complete the Persistent Worker Setup Before Live Payments

Vercel Services is currently beta. Native deployment on a persistent Node.js
host remains the recommended full production topology for this gateway.
Hosted Layerbase solves database persistence; it does not make timer-based
workers durable on Vercel.

Run the supported native payment/observer services on a persistent host with
matching database and secrets, and verify observation ingestion, session expiry,
recovery, and webhook retries independently of browser activity. A browser tab
or occasional HTTP invocation is not a background worker. This guide does not
claim that a separately deployable, worker-only service has been provisioned.

Vercel's admin deliberately disables automatic long-lived admin/log streams and
local process-control features. Starting/stopping local processes, launching
`cloudflared`, and supervising port `5000` are not Vercel dashboard capabilities.
Gmail polling and WhatsApp pairing also need their appropriate persistent service
or external provider; a visible configuration form is not proof of connectivity.

Before accepting real payments, verify the full path with the intended merchant:
create session, pay, observe a genuine credit, verify the terminal state, receive
and authenticate the webhook, and confirm retries survive a worker restart.
For COD, a successful order event is not evidence that money was received.

### Troubleshooting

| Symptom | Check |
| :--- | :--- |
| Admin token repeatedly rejected (`401`) | Same `ADMIN_API_TOKEN` on the intended environment and all relevant services; redeploy after changes |
| New merchant rejected (`409`) | Slug already exists; choose a different slug |
| New merchant rejected (`400`) | Required business name or invalid/blocked webhook URL; inspect the response error |
| Merchant create succeeds (`201`) but UI appears unchanged | Deployed revision includes the settings-loader fix; inspect subsequent merchant-list and merchant-settings responses |
| New merchant has no payment account | Add and activate its receiving VPA; verify the selected merchant before saving |
| UPI payment returns `503 OBSERVERS_UNHEALTHY` | Pair/reconnect that merchant's SMS observer and confirm a fresh heartbeat; do not disable the safety gate |
| Database startup / TLS error | Correct Layerbase URL, verified TLS, runtime version, database permissions, and matching encryption keys |
| Supervisor says unavailable on Vercel | Expected; use the persistent host for process management |
| Google/WhatsApp remains disconnected | Real OAuth/provider configuration and persistent service availability, not just saved settings |

Use the browser Network panel and Vercel server logs to inspect failed request
paths, status codes, and non-secret error messages. Redact Authorization headers,
connection strings, tokens, webhook secrets, and customer data before sharing.
