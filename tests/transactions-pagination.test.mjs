import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLedgerDb } from '../src/ledger.mjs';
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
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
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

test('listTransactions paginates 45 transactions cleanly and filters by type and search query', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'page@example.com', homeCurrencyCode: 'USD' });
  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 500000 });
  const dining = ledger.createCategory(user.id, { name: 'Dining', kind: 'EXPENSE', monthlyCapMinor: 100000 });
  const salary = ledger.createCategory(user.id, { name: 'Salary', kind: 'INCOME' });

  for (let i = 1; i <= 40; i++) {
    ledger.recordTransaction(user.id, {
      type: 'EXPENSE',
      amountMinor: 1000 + i,
      accountId: checking.id,
      categoryId: dining.id,
      occurredOn: '2026-11-20',
      note: i % 5 === 0 ? `Special Coffee #${i}` : `Lunch #${i}`,
    });
  }
  for (let i = 1; i <= 4; i++) {
    ledger.recordTransaction(user.id, {
      type: 'INCOME',
      amountMinor: 50000,
      accountId: checking.id,
      categoryId: salary.id,
      occurredOn: '2026-11-21',
      note: `Paycheck #${i}`,
    });
  }
  // Note: Opening Balance ADJUSTMENT makes total 45 transactions
  const page1 = ledger.listTransactions(user.id, { limit: 20, offset: 0 });
  assert.equal(page1.items.length, 20);
  assert.equal(page1.totalCount, 45);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 20);

  const page3 = ledger.listTransactions(user.id, { limit: 20, offset: 40 });
  assert.equal(page3.items.length, 5);
  assert.equal(page3.hasMore, false);

  const coffeeSearch = ledger.listTransactions(user.id, { limit: 20, offset: 0, type: 'EXPENSE', search: 'special coffee' });
  assert.equal(coffeeSearch.totalCount, 8);
  assert.equal(coffeeSearch.items.length, 8);
  assert.equal(coffeeSearch.hasMore, false);
});

test('GET /api/transactions enforces session auth, tenant isolation, and pagination params', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  // Unauthenticated request returns 401
  const unauth = await invokeHandler(handler, { method: 'GET', url: '/api/transactions?limit=10&offset=0' });
  assert.equal(unauth.status, 401);

  const loginRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: { email: 'patrick@pocketledger.app', password: 'pocketledger-demo' },
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers['set-cookie'].split(';')[0];

  const listRes = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/transactions?limit=3&offset=0&type=ALL',
    headers: { cookie },
  });
  assert.equal(listRes.status, 200);
  const data = listRes.json();
  assert.equal(data.items.length, 3);
  assert.ok(data.totalCount > 3);
  assert.equal(data.hasMore, true);
  assert.equal(data.nextOffset, 3);
});
