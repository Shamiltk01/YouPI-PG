import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { Database } from '@youpi/db';
import { getAdminToken } from '@youpi/common';
import { startAdminServer } from '../index.js';
import { AdminServer } from '../server.js';

describe('Merchant Admin Integration Tests', () => {
  let serverInstance;
  let baseUrl;
  let testDb;

  before(async () => {
    testDb = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6101, { db: testDb });
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
    testDb.close();
  });

  function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, { headers }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      }).on('error', reject);
    });
  }

  test('GET /health returns UP', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.status, 'UP');
    assert.equal(json.service, 'merchant-admin');
  });

  test('GET / renders dashboard with queue monitor, observers, counter desk & pairing modal', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));

    assert.ok(res.text.includes('Real-Time Receiving Account Slot Ownership'));
    assert.ok(res.text.includes('Active Slot (5-Minute Window)'));
    assert.ok(res.text.includes('Processing Slot (30s Verification Window)'));
    assert.ok(res.text.includes('Live Counter Payment Requests'));
    assert.ok(res.text.includes('Payment Observers (SMS & Gmail)'));
    assert.ok(res.text.includes('Android SMS Gateway'));
    assert.ok(res.text.includes('Gmail Direct API'));
    assert.ok(res.text.includes('data-youpi-key="${currentMerchantId}"><\\/script>`;'));
    assert.equal((res.text.match(/<\/script>/gi) || []).length, 3);
  });

  test('GET /api/admin/tickets requires the admin token', async () => {
    const anonymous = await get('/api/admin/tickets');
    assert.equal(anonymous.status, 401);

    const res = await get('/api/admin/tickets', { Authorization: `Bearer ${getAdminToken()}` });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.ok(Array.isArray(json));
  });

  test('Vercel renders valid scripts and routes fonts through merchant-admin', () => {
    const original = process.env.VERCEL;
    try {
      process.env.VERCEL = '1';
      const html = new AdminServer({ db: testDb }).renderHtml();
      assert.ok(html.includes("const IS_SERVERLESS = 'true' === 'true';"));
      assert.ok(html.includes('url("/admin/fonts/dm-sans.woff2")'));
      assert.ok(!html.includes('{{SERVERLESS_HOST}}'));
      for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gi)) {
        assert.doesNotThrow(() => new vm.Script(match[1]));
      }
    } finally {
      if (original === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = original;
    }
  });

  test('tickets await asynchronous hosted repository results', async () => {
    const admin = new AdminServer({ db: testDb });
    admin.merchantRepo.findAll = async () => [{ id: 'hosted-merchant' }];
    admin.ticketRepo.findTicketsByMerchant = async merchantId => [{ id: 'ticket-1', merchantId }];
    const server = admin.createServer();
    try {
      const body = await new Promise(resolve => {
        server.emit('request', {
          method: 'GET', url: '/api/admin/tickets',
          headers: { host: 'localhost', authorization: `Bearer ${getAdminToken()}` }
        }, { writeHead(status) { assert.equal(status, 200); }, end: resolve });
      });
      assert.deepEqual(JSON.parse(body), [{ id: 'ticket-1', merchantId: 'hosted-merchant' }]);
    } finally {
      server.close();
    }
  });

  test('refresh loads only the selected view and avoids serverless streams', async () => {
    const html = new AdminServer({ db: testDb }).renderHtml();
    const source = html.slice(html.indexOf('    async function refreshAdminView('), html.indexOf('    function closeAdminStreams('));
    const calls = [];
    const context = {
      document: { hidden: false, getElementById: () => null },
      window: { __youpiAdminAuth: { ensure: async () => {}, failures: () => 0 } },
      IS_SERVERLESS: true,
      activeSubTab: 'subViewOpsLive',
      currentSellingMode: 'ONLINE'
    };
    for (const name of [
      'pollGlobalCounterPending', 'fetchLiveData', 'fetchCodOrders', 'fetchCounterPayments',
      'fetchPaymentsLedger', 'fetchObserversStatus', 'fetchWhatsAppStatus', 'loadServices',
      'fetchFalseNarrativeStatus', 'fetchTunnelStatus', 'fetchBannedUsers', 'fetchSecurityEvents',
      'fetchSecurityHistory', 'connectAdminEventsSse', 'connectServicesLogsSse'
    ]) context[name] = async () => { calls.push(name); };
    vm.runInNewContext(source, context);
    await context.refreshAdminView();
    assert.deepEqual(calls, ['pollGlobalCounterPending', 'fetchLiveData']);
    calls.length = 0;
    context.activeSubTab = 'subViewOpsTransactions';
    await context.refreshAdminView();
    assert.deepEqual(calls, ['pollGlobalCounterPending', 'fetchPaymentsLedger']);
    calls.length = 0;
    context.activeSubTab = 'subViewDevSupervisor';
    await context.refreshAdminView();
    assert.deepEqual(calls, ['pollGlobalCounterPending']);
    calls.length = 0;
    context.document.hidden = true;
    await context.refreshAdminView();
    assert.deepEqual(calls, []);
  });

  test('refresh loop coalesces requests, waits for completion, pauses hidden tabs and cleans up', async () => {
    const html = new AdminServer({ db: testDb }).renderHtml();
    const source = html.slice(html.indexOf('    function startAdminPolling('), html.indexOf('    async function refreshAdminView('));
    const timers = new Map();
    const visibilityListeners = new Map();
    const pageListeners = new Map();
    let timerId = 0;
    const document = {
      hidden: false,
      addEventListener: (name, handler) => visibilityListeners.set(name, handler),
      removeEventListener: name => visibilityListeners.delete(name)
    };
    const context = vm.createContext({
      document,
      window: {
        addEventListener: (name, handler) => pageListeners.set(name, handler),
        removeEventListener: name => pageListeners.delete(name)
      },
      setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout: id => timers.delete(id)
    });
    vm.runInContext(source, context);
    let calls = 0;
    let complete;
    let fail;
    const loop = context.startAdminPolling(() => {
      calls++;
      return new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    });
    const runNext = () => {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      return timer.callback();
    };
    const first = runNext();
    loop.refresh();
    loop.refresh();
    assert.equal(calls, 1);
    assert.equal(timers.size, 0);
    complete();
    await first;
    assert.equal(timers.values().next().value.delay, 0);
    const second = runNext();
    complete();
    await second;
    assert.equal(calls, 2);
    assert.equal(timers.values().next().value.delay, 10000);
    const failed = runNext();
    fail(new Error('Network unavailable'));
    await failed;
    assert.equal(timers.values().next().value.delay, 20000);
    const recovered = runNext();
    complete();
    await recovered;
    assert.equal(timers.values().next().value.delay, 10000);
    document.hidden = true;
    visibilityListeners.get('visibilitychange')();
    assert.equal(timers.size, 0);
    loop.refresh();
    assert.equal(timers.size, 0);
    document.hidden = false;
    visibilityListeners.get('visibilitychange')();
    assert.equal(timers.size, 1);
    pageListeners.get('pagehide')();
    assert.equal(timers.size, 0);
    assert.equal(visibilityListeners.size, 0);
    loop.refresh();
    assert.equal(timers.size, 0);
  });

  test('auth recovery rejects stale failures and coalesces only identical GET requests', async () => {
    const html = new AdminServer({ db: testDb }).renderHtml();
    const source = html.slice(html.indexOf('    window.__youpiAdminAuth = (function () {'), html.indexOf('    const API_BASE ='));
    const storage = new Map([['youpi_admin_token', 'old-test-token']]);
    const responses = [];
    const inputs = [];
    let submit;
    let prompts = 0;
    let streamRestarts = 0;
    let nativeCalls = 0;
    const context = vm.createContext({
      Headers,
      AbortSignal,
      sessionStorage: {
        getItem: key => storage.get(key),
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key)
      },
      document: {
        body: { appendChild() { prompts++; } },
        createElement(tag) {
          const element = { style: {}, append() {}, appendChild() {}, focus() {}, remove() {}, addEventListener(name, handler) { if (name === 'submit') submit = handler; } };
          if (tag === 'input') inputs.push(element);
          return element;
        }
      },
      window: {
        fetch: (url, init) => {
          nativeCalls++;
          assert.ok(init.signal instanceof AbortSignal);
          return init.headers.get('Authorization') === 'Bearer new-test-token'
            ? Promise.resolve(new Response('{}', { status: 200 }))
            : new Promise(resolve => responses.push(resolve));
        }
      },
      connectAdminEventsSse: () => { streamRestarts++; },
      connectServicesLogsSse: () => { streamRestarts++; }
    });
    vm.runInContext(source, context);
    const first = context.window.fetch('/api/v1/admin/queue');
    const second = context.window.fetch('/api/v1/admin/payments');
    responses[0](new Response('{}', { status: 401 }));
    await new Promise(setImmediate);
    assert.equal(prompts, 1);
    inputs[0].value = 'new-test-token';
    submit({ preventDefault() {} });
    assert.equal((await first).status, 200);
    responses[1](new Response('{}', { status: 401 }));
    assert.equal((await second).status, 200);
    assert.equal(prompts, 1);
    assert.equal(storage.get('youpi_admin_token'), 'new-test-token');
    assert.equal(streamRestarts, 0);
    assert.equal(nativeCalls, 4);
    const [firstRead, secondRead] = await Promise.all([
      context.window.fetch('/api/v1/admin/queue'),
      context.window.fetch('/api/v1/admin/queue')
    ]);
    assert.equal(nativeCalls, 5);
    assert.deepEqual(await firstRead.json(), {});
    assert.deepEqual(await secondRead.json(), {});
    await Promise.all([
      context.window.fetch('/api/v1/admin/settings', { method: 'POST' }),
      context.window.fetch('/api/v1/admin/settings', { method: 'POST' })
    ]);
    assert.equal(nativeCalls, 7);
    await Promise.all([
      context.window.fetch('/api/v1/admin/settings', { headers: { 'X-Merchant-Id': 'one' } }),
      context.window.fetch('/api/v1/admin/settings', { headers: { 'X-Merchant-Id': 'two' } })
    ]);
    assert.equal(nativeCalls, 9);
  });

  test('Control Center supervisor proxy routes (/api/services* and /api/logs/stream) require the admin token', async () => {
    const anonServices = await get('/api/services');
    assert.equal(anonServices.status, 401);

    const wrongToken = await get('/api/services', { Authorization: 'Bearer wrong-token' });
    assert.equal(wrongToken.status, 401);

    const anonLogs = await get('/api/logs/stream');
    assert.equal(anonLogs.status, 401);

    const wrongQueryLogs = await get('/api/logs/stream?token=wrong-token');
    assert.equal(wrongQueryLogs.status, 401);
  });

  test('renderHtml injects dynamic DEFAULT_APP_NAME into title and brand header', () => {
    const origEnv = { ...process.env };
    process.env.DEFAULT_APP_NAME = 'ApexMerchant Suite';

    const adminServer = new AdminServer({ db: testDb });
    const html = adminServer.renderHtml();

    assert.ok(html.includes('<title>Merchant &amp; Supervisor Hub - ApexMerchant Suite</title>') || html.includes('<title>Merchant & Supervisor Hub - ApexMerchant Suite</title>'));
    assert.ok(html.includes('<span>🛡️ ApexMerchant Suite</span>'));
    assert.ok(html.includes('Security Engine v2 &bull; ApexMerchant Suite'));

    process.env = { ...origEnv };
  });
});
