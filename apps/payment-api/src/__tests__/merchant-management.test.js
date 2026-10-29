import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Database } from '@youpi/db';
import { startServer as startPaymentApi } from '../index.js';
import { authFetch } from '../../../../scripts/test-support.js';
import { createVercelHandler } from '../../vercel-entrypoint.js';

describe('Merchant Management & Multi-Tenant Onboarding Test Suite', () => {
  let apiInstance;
  let testDb;
  let baseUrl;
  const port = 6219;

  before(async () => {
    testDb = new Database({ inMemory: true });
    apiInstance = await startPaymentApi(port, testDb);
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    if (apiInstance) {
      await apiInstance.close();
    }
    if (testDb) {
      testDb.close();
    }
  });

  it('1. GET /api/v1/admin/merchants returns default seeded merchant', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.merchants), 'merchants array must be present');
    assert.ok(body.merchants.length >= 1, 'At least 1 default merchant must exist');
    const defaultM = body.merchants.find(m => m.id === '00000000-0000-0000-0000-000000000001');
    assert.ok(defaultM, 'Default merchant 00000000-0000-0000-0000-000000000001 must exist');
  });

  it('Vercel entrypoint reports startup failures safely and retries initialization on a later request', async context => {
    const errors = [];
    context.mock.method(console, 'error', (...args) => errors.push(args));
    let attempts = 0;
    const handler = createVercelHandler(async () => {
      attempts++;
      if (attempts === 1) throw new Error('private startup details');
      return { rawServer: { emit: (event, req, res) => { res.end('ready'); return true; } } };
    });
    const invoke = async () => {
      const response = {};
      await handler({}, {
        writeHead: (status, headers) => { response.status = status; response.headers = headers; },
        end: body => { response.body = body; }
      });
      return response;
    };
    const failed = await invoke();
    assert.equal(failed.status, 503);
    assert.match(failed.headers['Content-Type'], /application\/json/);
    assert.equal(JSON.parse(failed.body).code, 'PAYMENT_API_STARTUP_FAILED');
    assert.ok(!failed.body.includes('private startup details'));
    assert.equal(errors.length, 1);
    assert.equal((await invoke()).body, 'ready');
    assert.equal((await invoke()).body, 'ready');
    assert.equal(attempts, 2);
  });

  it('Vercel entrypoint shares initialization across concurrent requests', async () => {
    let attempts = 0;
    let ready;
    const handler = createVercelHandler(() => {
      attempts++;
      return new Promise(resolve => { ready = resolve; });
    });
    const responses = [];
    const first = handler({}, { end: body => responses.push(body) });
    const second = handler({}, { end: body => responses.push(body) });
    await new Promise(setImmediate);
    assert.equal(attempts, 1);
    ready({ rawServer: { emit: (event, req, res) => { res.end('ready'); return true; } } });
    await Promise.all([first, second]);
    assert.deepEqual(responses, ['ready', 'ready']);
  });

  it('2. POST /api/v1/admin/merchants rejects request with missing businessName', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'test-store' })
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /businessName is required/);
  });

  let createdMerchant;
  it('3. POST /api/v1/admin/merchants creates new merchant with auto-generated API key & secret', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Nova Supermart',
        slug: 'nova-supermart',
        contactEmail: 'contact@nova.example',
        contactPhone: '9876543210',
        vpa: 'novastore@okhdfcbank'
      })
    });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    assert.ok(body.merchant, 'merchant object must be returned');
    assert.ok(body.merchant.id, 'merchant ID must be generated');
    assert.strictEqual(body.merchant.businessName, 'Nova Supermart');
    assert.strictEqual(body.merchant.slug, 'nova-supermart');
    assert.ok(body.merchant.apiKey.startsWith('yp_live_'), 'API key must have yp_live_ prefix');
    assert.ok(body.merchant.webhookSecret, 'webhookSecret must be generated');
    createdMerchant = body.merchant;
  });

  it('4. POST /api/v1/admin/merchants rejects duplicate slug', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Nova Another Store',
        slug: 'nova-supermart'
      })
    });
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /already exists/);
  });

  it('5. POST /api/v1/admin/merchants/:id/rotate-key rotates merchant API key', async () => {
    const res = await authFetch(`${baseUrl}/api/v1/admin/merchants/${createdMerchant.id}/rotate-key`, {
      method: 'POST'
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.apiKey.startsWith('yp_live_'));
    assert.notStrictEqual(body.apiKey, createdMerchant.apiKey, 'New API key must differ from old key');
    createdMerchant.apiKey = body.apiKey;
  });

  it('6. POST /api/v1/payments verifies authentication with the new merchant ID and rotated API key', async () => {
    // Attempt with invalid key -> 401
    const failRes = await fetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': createdMerchant.id,
        'X-Merchant-Key': 'invalid_secret_key'
      },
      body: JSON.stringify({
        orderId: 'ORDER-NOVA-101',
        amount: '299.00',
        currency: 'INR'
      })
    });
    assert.strictEqual(failRes.status, 401);

    const offlineRes = await fetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': createdMerchant.id,
        'X-Merchant-Key': createdMerchant.apiKey
      },
      body: JSON.stringify({ orderId: 'ORDER-NOVA-OFFLINE', amount: '299.00', currency: 'INR' })
    });
    assert.equal(offlineRes.status, 503);
    assert.equal((await offlineRes.json()).code, 'OBSERVERS_UNHEALTHY');
    testDb.execute(`
      INSERT INTO android_devices (id, merchant_id, device_name, device_model, signing_key_hash, is_active, last_heartbeat_at, created_at)
      VALUES (?, ?, 'Test observer', 'Test model', 'test-hash', 1, datetime('now'), datetime('now'))
    `, ['merchant-management-observer', createdMerchant.id]);

    // Attempt with valid rotated key -> 201 Created
    const successRes = await fetch(`${baseUrl}/api/v1/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Merchant-Id': createdMerchant.id,
        'X-Merchant-Key': createdMerchant.apiKey
      },
      body: JSON.stringify({
        orderId: 'ORDER-NOVA-101',
        amount: '299.00',
        currency: 'INR'
      })
    });
    assert.strictEqual(successRes.status, 201);
    const successBody = await successRes.json();
    assert.ok(successBody.paymentId);
    assert.strictEqual(successBody.orderId, 'ORDER-NOVA-101');
  });

  it('admin form creates once, selects the new merchant, loads settings and handles validation errors', async () => {
    const html = fs.readFileSync(new URL('../../../merchant-admin/src/views/admin.html', import.meta.url), 'utf8');
    const start = html.indexOf('    let creatingMerchant = false;');
    const source = html.slice(start, html.indexOf('    async function rotateMerchantApiKey()', start));
    const elements = {
      modalMerchantName: { value: 'Panel Integration Store' },
      modalMerchantSlug: { value: 'panel-integration-store' },
      modalMerchantVpa: { value: '' },
      modalMerchantEmail: { value: 'owner@example.test' },
      modalMerchantPhone: { value: '' },
      modalMerchantWebhook: { value: '' },
      createMerchantButton: { disabled: false, textContent: 'Create Merchant' }
    };
    const toasts = [];
    let posts = 0;
    let modalOpen = true;
    let refreshedMerchants = [];
    let selectedMerchantId;
    let loadedSettings;
    let credentials;
    const context = {
      API_BASE: baseUrl,
      currentMerchantId: '00000000-0000-0000-0000-000000000001',
      document: { getElementById: id => elements[id] },
      fetch: (url, init) => {
        if (init?.method === 'POST') posts++;
        return authFetch(url, init);
      },
      showAdminToast: (message, success) => toasts.push({ message, success }),
      closeNewMerchantModal: () => { modalOpen = false; },
      fetchMerchantsList: async () => {
        const response = await authFetch(`${baseUrl}/api/v1/admin/merchants`);
        assert.equal(response.status, 200);
        refreshedMerchants = (await response.json()).merchants;
      },
      renderMerchantSelector: () => { selectedMerchantId = context.currentMerchantId; },
      fetchGatewaySettings: async () => {
        const response = await authFetch(`${baseUrl}/api/v1/admin/merchant-settings?merchantId=${encodeURIComponent(context.currentMerchantId)}`);
        assert.equal(response.status, 200);
        loadedSettings = await response.json();
      },
      renderMerchantCredentials: merchant => { credentials = merchant; }
    };
    vm.runInNewContext(source, context);
    const pending = context.submitNewMerchant();
    assert.equal(elements.createMerchantButton.disabled, true);
    await Promise.all([pending, context.submitNewMerchant()]);
    assert.equal(posts, 1);
    assert.equal(modalOpen, false);
    assert.ok(credentials?.id);
    assert.equal(selectedMerchantId, credentials.id);
    assert.equal(loadedSettings.merchantId, credentials.id);
    assert.equal(loadedSettings.businessName, 'Panel Integration Store');
    assert.ok(refreshedMerchants.some(merchant => merchant.id === credentials.id));
    assert.equal(elements.createMerchantButton.disabled, false);
    assert.equal(elements.createMerchantButton.textContent, 'Create Merchant');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].success, true);

    modalOpen = true;
    await context.submitNewMerchant();
    assert.equal(posts, 2);
    assert.equal(modalOpen, true);
    assert.equal(toasts.at(-1).success, false);
    assert.match(toasts.at(-1).message, /already exists/);
    assert.equal(elements.createMerchantButton.disabled, false);

    elements.modalMerchantName.value = '   ';
    await context.submitNewMerchant();
    assert.equal(posts, 2);
    assert.match(toasts.at(-1).message, /Name is required/);
    assert.equal(modalOpen, true);

    elements.modalMerchantName.value = 'Retry Test Store';
    for (const [status, contentType, body, expectedMessage] of [
      [500, 'text/html', '<html>FUNCTION_INVOCATION_FAILED private server details</html>', /HTTP 500.*non-JSON/],
      [502, 'application/json', '{not-valid-json', /HTTP 502.*invalid JSON/],
      [201, 'application/json', '{}', /missing the merchant ID/]
    ]) {
      let failedRequests = 0;
      const before = toasts.length;
      context.fetch = async () => {
        failedRequests++;
        return new Response(body, { status, headers: { 'Content-Type': contentType } });
      };
      await context.submitNewMerchant();
      assert.equal(failedRequests, 1);
      assert.equal(toasts.length, before + 1);
      assert.equal(toasts.at(-1).success, false);
      assert.match(toasts.at(-1).message, expectedMessage);
      assert.ok(!toasts.at(-1).message.includes('private server details'));
      assert.ok(!toasts.at(-1).message.includes('Unexpected token'));
      assert.equal(modalOpen, true);
      assert.equal(elements.createMerchantButton.disabled, false);
      assert.equal(elements.createMerchantButton.textContent, 'Create Merchant');
      assert.equal(elements.modalMerchantName.value, 'Retry Test Store');
    }
  });
});
