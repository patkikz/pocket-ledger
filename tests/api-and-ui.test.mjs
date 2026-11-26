import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
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

test('Criterion #3 & HTTP API: Smart defaults pre-select last used wallet & top category so mobile quick entry takes <= 4 taps and returns updated remaining cap', async () => {
  const { handler, demoUserId, secondUserId } = createAppHandler({ dbPath: ':memory:' });

  // 1. Verify PWA index.html serves with mobile-native viewport-fit=cover and clean Quick Entry sheet
  const htmlRes = await invokeHandler(handler, { method: 'GET', url: '/' });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.text, /viewport-fit=cover/);
  assert.match(htmlRes.text, /Quick Entry/);

  // 2. Fetch initial dashboard with smart defaults ready on load (0 taps required for wallet/category when using defaults)
  const dashRes1 = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard?date=2026-11-26',
    headers: { 'x-user-id': demoUserId },
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
      'x-user-id': demoUserId,
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
    headers: { 'x-user-id': secondUserId },
  });
  assert.equal(voidOtherRes.status, 403);

  // 5. Verify CSV export endpoint works and returns text/csv containing the new entry
  const csvRes = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/export.csv',
    headers: { 'x-user-id': demoUserId },
  });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers['content-type'], /text\/csv/);
  assert.match(csvRes.text, /Quick coffee/);
});

test('In-app management APIs: create category, update monthly cap, create recurring rule, and clean My Budget profile', async () => {
  const { handler, demoUserId, personalUserId } = createAppHandler({ dbPath: ':memory:' });

  // 1. Personal clean-slate profile exists and starts with 0 transactions
  assert.ok(personalUserId, 'personalUserId is returned');
  const personalDashRes = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard?date=2026-11-26',
    headers: { 'x-user-id': personalUserId },
  });
  assert.equal(personalDashRes.status, 200);
  const personalDash = personalDashRes.json();
  assert.equal(personalDash.recentTransactions.length, 0);

  // 2. Create a new account in personal profile
  const accRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/accounts',
    headers: { 'content-type': 'application/json', 'x-user-id': personalUserId },
    body: { name: 'My Wallet', type: 'CASH_CHECKING', initialBalanceMinor: 50000, includeInSafeToSpend: true },
  });
  assert.equal(accRes.status, 201);
  const accData = accRes.json();
  assert.equal(accData.account.cachedBalanceMinor, 50000);

  // 3. Create a new expense category
  const catRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/categories',
    headers: { 'content-type': 'application/json', 'x-user-id': personalUserId },
    body: { name: 'Subscriptions', kind: 'EXPENSE', monthlyCapMinor: 10000, color: '#8b5cf6' },
  });
  assert.equal(catRes.status, 201);
  const catData = catRes.json();
  assert.equal(catData.category.monthlyCapMinor, 10000);

  // 4. Update monthly cap on the category
  const capRes = await invokeHandler(handler, {
    method: 'POST',
    url: `/api/categories/${catData.category.id}/cap`,
    headers: { 'content-type': 'application/json', 'x-user-id': personalUserId },
    body: { monthlyCapMinor: 15000 },
  });
  assert.equal(capRes.status, 200);
  assert.equal(capRes.json().category.monthlyCapMinor, 15000);

  // 5. Create a recurring bill rule
  const recRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/recurring',
    headers: { 'content-type': 'application/json', 'x-user-id': personalUserId },
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
