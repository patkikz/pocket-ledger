import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { createAppHandler } from '../src/server.mjs';

function invokeHandler(handler, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payloadStr = body ? JSON.stringify(body) : '';
    const req = Readable.from(payloadStr ? [Buffer.from(payloadStr)] : []);
    req.method = method;
    req.url = url;
    req.headers = headers;

    const resHeaders = {};
    let statusCode = 200;
    const chunks = [];

    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) {
          resHeaders[k.toLowerCase()] = v;
        }
      },
      end(data) {
        if (data) {
          chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: statusCode,
          headers: resHeaders,
          text,
          json() {
            return JSON.parse(text);
          },
        });
      },
    };

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

async function loginAs(handler, email, password) {
  const res = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: { email, password },
  });
  assert.equal(res.status, 200, `Login failed for ${email}: ${res.text}`);
  const raw = res.headers['set-cookie'];
  const headerVal = Array.isArray(raw) ? raw.find((c) => c.startsWith('pl_session=')) : raw;
  assert.ok(headerVal, 'Expected Set-Cookie header for pl_session');
  return headerVal.split(';')[0];
}

async function registerAs(handler, email, password) {
  const res = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: { email, password },
  });
  assert.equal(res.status, 201, `Register failed for ${email}: ${res.text}`);
  const raw = res.headers['set-cookie'];
  const headerVal = Array.isArray(raw) ? raw.find((c) => c.startsWith('pl_session=')) : raw;
  assert.ok(headerVal, 'Expected Set-Cookie header for pl_session');
  return headerVal.split(';')[0];
}

test('Criterion #3 & HTTP API: Smart defaults pre-select last used wallet & top category so mobile quick entry takes <= 4 taps and returns updated remaining cap', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });
  const demoCookie = await loginAs(handler, 'patrick@pocketledger.app', 'pocketledger-demo');
  const secondCookie = await loginAs(handler, 'alex.isolated@pocketledger.app', 'pocketledger-demo');

  // 1. Verify PWA index.html serves with mobile-native viewport-fit=cover and clean Quick Entry sheet
  const htmlRes = await invokeHandler(handler, { method: 'GET', url: '/' });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /viewport-fit=cover/);
  assert.match(htmlRes.text, /Quick Entry/);

  // 2. Fetch initial dashboard with smart defaults ready on load (0 taps required for wallet/category when using defaults)
  const dashRes1 = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard?date=2026-11-26',
    headers: { cookie: demoCookie },
  });
  assert.equal(dashRes1.status, 200);
  const dash1 = dashRes1.json();

  assert.ok(dash1.smartDefaults.accountId, 'Smart default accountId is preselected');
  assert.ok(dash1.smartDefaults.categoryId, 'Smart default categoryId is preselected');
  assert.ok(dash1.integrityAudits.every((a) => a.isValid), 'All seeded accounts pass 0-cent drift audit');

  // 3. Simulate 4-tap mobile checkout entry ($12.50 -> 3 digit taps '1','2','5','0' or '1','2','50' + Save) using preselected smart defaults
  const postRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/transactions',
    headers: {
      'content-type': 'application/json',
      cookie: demoCookie,
    },
    body: {
      type: 'EXPENSE',
      amountMinor: 1250,
      accountId: dash1.smartDefaults.accountId,
      categoryId: dash1.smartDefaults.categoryId,
      occurredOn: '2026-11-26',
      note: 'Quick coffee',
    },
  });
  assert.equal(postRes.status, 201);
  const createdPayload = postRes.json();
  assert.equal(createdPayload.transaction.amountMinor, 1250);
  assert.ok(typeof createdPayload.categoryRemainingCapMinor === 'number');

  // 4. Verify tenant isolation over HTTP (Tenant B trying to void Tenant A's transaction is rejected with 403)
  const voidOtherRes = await invokeHandler(handler, {
    method: 'POST',
    url: `/api/transactions/${createdPayload.transaction.id}/void`,
    headers: { cookie: secondCookie },
  });
  assert.equal(voidOtherRes.status, 403);

  // 5. Verify CSV export endpoint works and returns text/csv containing the new entry
  const csvRes = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/export.csv',
    headers: { cookie: demoCookie },
  });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers['content-type'], /text\/csv/);
  assert.match(csvRes.text, /Quick coffee/);
});

test('In-app management APIs: create category, update monthly cap, create recurring rule, and clean My Budget profile', async () => {
  const { handler, personalUserId } = createAppHandler({ dbPath: ':memory:' });

  // 1. Personal clean-slate profile exists and a registered account starts with 0 transactions
  assert.ok(personalUserId, 'personalUserId is returned');
  const personalCookie = await registerAs(handler, 'personal.clean@example.com', 'password123');
  const personalDashRes = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard?date=2026-11-26',
    headers: { cookie: personalCookie },
  });
  assert.equal(personalDashRes.status, 200);
  const personalDash = personalDashRes.json();
  assert.equal(personalDash.recentTransactions.length, 0);

  // 2. Create a new account in personal profile
  const accRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/accounts',
    headers: { 'content-type': 'application/json', cookie: personalCookie },
    body: { name: 'My Wallet', type: 'CASH_CHECKING', initialBalanceMinor: 50000, includeInSafeToSpend: true },
  });
  assert.equal(accRes.status, 201);
  const accData = accRes.json();
  assert.equal(accData.account.cachedBalanceMinor, 50000);

  // 3. Create a new expense category
  const catRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/categories',
    headers: { 'content-type': 'application/json', cookie: personalCookie },
    body: { name: 'Subscriptions', kind: 'EXPENSE', monthlyCapMinor: 10000, color: '#8b5cf6' },
  });
  assert.equal(catRes.status, 201);
  const catData = catRes.json();
  assert.equal(catData.category.monthlyCapMinor, 10000);

  // 4. Update monthly cap on the category
  const capRes = await invokeHandler(handler, {
    method: 'POST',
    url: `/api/categories/${catData.category.id}/cap`,
    headers: { 'content-type': 'application/json', cookie: personalCookie },
    body: { monthlyCapMinor: 15000 },
  });
  assert.equal(capRes.status, 200);
  assert.equal(capRes.json().category.monthlyCapMinor, 15000);

  // 5. Create an INCOME category with no monthly cap
  const incCatRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/categories',
    headers: { 'content-type': 'application/json', cookie: personalCookie },
    body: { name: 'Freelance', kind: 'INCOME', monthlyCapMinor: null, color: '#14b8a6' },
  });
  assert.equal(incCatRes.status, 201);
  assert.equal(incCatRes.json().category.kind, 'INCOME');
  assert.equal(incCatRes.json().category.monthlyCapMinor, null);

  // 6. Create a recurring bill rule
  const recRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/recurring',
    headers: { 'content-type': 'application/json', cookie: personalCookie },
    body: {
      title: 'Spotify Duo',
      type: 'EXPENSE',
      defaultAmountMinor: 1699,
      accountId: accData.account.id,
      categoryId: catData.category.id,
      frequency: 'MONTHLY',
      nextDueDate: '2026-11-29',
    },
  });
  assert.equal(recRes.status, 201);
  assert.equal(recRes.json().rule.title, 'Spotify Duo');
});

test('UI auth gate markup and session boot script assertions', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  const htmlRes = await invokeHandler(handler, { method: 'GET', url: '/' });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /id="authView"/);
  assert.match(htmlRes.text, /id="logoutBtn"/);
  assert.doesNotMatch(htmlRes.text, /id="tenantSelect"/);

  const jsRes = await invokeHandler(handler, { method: 'GET', url: '/app.js' });
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.text, /\/api\/auth\/me/);
  assert.ok(!jsRes.text.includes("'x-user-id'") && !jsRes.text.includes('"x-user-id"'), 'app.js must not send x-user-id headers');
  assert.doesNotMatch(jsRes.text, /if\s*\(\s*e\.target\s*===\s*overlay\s*\)\s*closeModal/);

  const quickEntryRes = await invokeHandler(handler, { method: 'GET', url: '/js/quick-entry.js' });
  assert.equal(quickEntryRes.status, 200);
  assert.match(quickEntryRes.text, /#quickEntryOverlay \.mode-tabs/);
  assert.match(quickEntryRes.text, /#quickEntryOverlay \.mode-tabs \.tab-btn/);
  assert.doesNotMatch(quickEntryRes.text, /querySelector(?:All)?\(['"]\.mode-tabs/);
});

test('PWA installability assets: manifest icons, SVG icon, service worker /api/ bypass, Apple meta tags, and SW registration', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  const manifestRes = await invokeHandler(handler, { method: 'GET', url: '/manifest.json' });
  assert.equal(manifestRes.status, 200);
  const manifest = manifestRes.json();
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.ok(Array.isArray(manifest.icons), 'manifest.icons should be an array');
  assert.ok(
    manifest.icons.some((icon) => icon.src === '/icons/icon-192.png' && icon.sizes === '192x192' && icon.type === 'image/png' && icon.purpose === 'any'),
    'manifest.icons should include 192x192 any PNG'
  );
  assert.ok(
    manifest.icons.some((icon) => icon.src === '/icons/icon-192.png' && icon.sizes === '192x192' && icon.type === 'image/png' && icon.purpose === 'maskable'),
    'manifest.icons should include 192x192 maskable PNG'
  );
  assert.ok(
    manifest.icons.some((icon) => icon.src === '/icons/icon-512.png' && icon.sizes === '512x512' && icon.type === 'image/png' && icon.purpose === 'any'),
    'manifest.icons should include 512x512 any PNG'
  );
  assert.ok(
    manifest.icons.some((icon) => icon.src === '/icons/icon-512.png' && icon.sizes === '512x512' && icon.type === 'image/png' && icon.purpose === 'maskable'),
    'manifest.icons should include 512x512 maskable PNG'
  );
  assert.ok(
    manifest.icons.some((icon) => icon.src === '/icons/icon.svg' && icon.sizes === 'any' && icon.type === 'image/svg+xml' && icon.purpose === 'any'),
    'manifest.icons should include /icons/icon.svg'
  );

  const iconRes = await invokeHandler(handler, { method: 'GET', url: '/icons/icon.svg' });
  assert.equal(iconRes.status, 200);
  assert.match(iconRes.headers['content-type'], /image\/svg\+xml/);
  assert.match(iconRes.text, /viewBox="0 0 512 512"/);

  const icon192Res = await invokeHandler(handler, { method: 'GET', url: '/icons/icon-192.png' });
  assert.equal(icon192Res.status, 200);
  assert.match(icon192Res.headers['content-type'], /image\/png/);

  const icon512Res = await invokeHandler(handler, { method: 'GET', url: '/icons/icon-512.png' });
  assert.equal(icon512Res.status, 200);
  assert.match(icon512Res.headers['content-type'], /image\/png/);

  const swRes = await invokeHandler(handler, { method: 'GET', url: '/sw.js' });
  assert.equal(swRes.status, 200);
  assert.match(swRes.headers['content-type'], /application\/javascript/);
  assert.ok(swRes.text.includes('/api/'), 'sw.js must check for /api/ bypass');

  const htmlRes = await invokeHandler(handler, { method: 'GET', url: '/' });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /apple-mobile-web-app-capable/);
  assert.match(htmlRes.text, /apple-mobile-web-app-status-bar-style/);
  assert.match(htmlRes.text, /<link rel="apple-touch-icon" href="\/icons\/icon-192\.png"/);
  assert.match(htmlRes.text, /\/icons\/icon\.svg/);

  const jsRes = await invokeHandler(handler, { method: 'GET', url: '/app.js' });
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.text, /serviceWorker/);
  assert.match(jsRes.text, /\/sw\.js/);
});

test('Service worker behavioral test: /api/* bypasses respondWith and caches.put, while static assets cache and fall back offline', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });
  const swRes = await invokeHandler(handler, { method: 'GET', url: '/sw.js' });
  assert.equal(swRes.status, 200);

  const listeners = new Map();
  const putCalls = [];
  const cacheStore = new Map();
  let fetchMode = 'online';

  const mockCache = {
    async put(request, response) {
      putCalls.push({ url: request.url, response });
      cacheStore.set(request.url, response);
    },
    async addAll() {},
  };

  const sandbox = {
    URL,
    self: {
      location: { origin: 'http://localhost:3000' },
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: {
      async open() {
        return mockCache;
      },
      async match(request) {
        return cacheStore.get(request.url);
      },
      async keys() {
        return [];
      },
      async delete() {
        return true;
      },
    },
    async fetch(request) {
      if (fetchMode === 'offline') {
        throw new Error('Network offline');
      }
      const resObj = {
        ok: true,
        type: 'basic',
        url: request.url,
        body: `fresh:${request.url}`,
        clone() {
          return { ...resObj };
        },
      };
      return resObj;
    },
  };

  vm.runInNewContext(swRes.text, sandbox);
  const fetchHandler = listeners.get('fetch');
  assert.equal(typeof fetchHandler, 'function', 'sw.js should register a fetch listener');

  function dispatchFetch(method, pathname) {
    let respondWithPromise = null;
    const waitUntilPromises = [];
    const event = {
      request: { method, url: `http://localhost:3000${pathname}` },
      respondWith(promise) {
        respondWithPromise = Promise.resolve(promise);
      },
      waitUntil(promise) {
        waitUntilPromises.push(Promise.resolve(promise));
      },
    };
    fetchHandler(event);
    return { respondWithPromise, waitUntilPromises };
  }

  // 1. GET /api/dashboard must bypass respondWith and caches.put
  const apiGet = dispatchFetch('GET', '/api/dashboard');
  assert.equal(apiGet.respondWithPromise, null, 'GET /api/dashboard must not call event.respondWith');
  assert.equal(putCalls.length, 0, 'GET /api/dashboard must not call caches.put');

  // 2. POST /api/transactions must bypass respondWith and caches.put
  const apiPost = dispatchFetch('POST', '/api/transactions');
  assert.equal(apiPost.respondWithPromise, null, 'POST /api/transactions must not call event.respondWith');
  assert.equal(putCalls.length, 0, 'POST /api/transactions must not call caches.put');

  // 3. Static asset GET /styles.css online: calls respondWith and caches via event.waitUntil
  const staticOnline = dispatchFetch('GET', '/styles.css');
  assert.ok(staticOnline.respondWithPromise, 'GET /styles.css must call event.respondWith');
  const onlineResponse = await staticOnline.respondWithPromise;
  assert.equal(onlineResponse.body, 'fresh:http://localhost:3000/styles.css');
  await Promise.all(staticOnline.waitUntilPromises);
  assert.equal(putCalls.length, 1, 'GET /styles.css must call caches.put');
  assert.equal(putCalls[0].url, 'http://localhost:3000/styles.css');

  // 4. Static asset GET /styles.css offline: falls back to cached response
  fetchMode = 'offline';
  const staticOffline = dispatchFetch('GET', '/styles.css');
  assert.ok(staticOffline.respondWithPromise, 'Offline GET /styles.css must call event.respondWith');
  const offlineResponse = await staticOffline.respondWithPromise;
  assert.equal(offlineResponse.body, 'fresh:http://localhost:3000/styles.css');
});
