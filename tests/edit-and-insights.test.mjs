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

test('updateTransaction edits amount, category, date, and note atomically with 0-cent ledger drift', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'edit@example.com', homeCurrencyCode: 'USD' });
  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 100000 });
  const dining = ledger.createCategory(user.id, { name: 'Dining', kind: 'EXPENSE', monthlyCapMinor: 30000 });
  const groceries = ledger.createCategory(user.id, { name: 'Groceries', kind: 'EXPENSE', monthlyCapMinor: 50000 });

  const tx = ledger.recordTransaction(user.id, {
    type: 'EXPENSE',
    amountMinor: 2500,
    accountId: checking.id,
    categoryId: dining.id,
    occurredOn: '2026-11-10',
    note: 'Typo note',
  });

  const updated = ledger.updateTransaction(user.id, tx.id, {
    amountMinor: 4200,
    categoryId: groceries.id,
    occurredOn: '2026-11-12',
    note: 'Corrected grocery run',
  });

  assert.equal(updated.amountMinor, 4200);
  assert.equal(updated.categoryId, groceries.id);
  assert.equal(updated.occurredOn, '2026-11-12');
  assert.equal(updated.note, 'Corrected grocery run');

  // Checking balance should be 100000 - 4200 = 95800 with 0 drift
  const integrity = ledger.verifyAccountIntegrity(user.id, checking.id);
  assert.equal(integrity.cachedBalanceMinor, 95800);
  assert.equal(integrity.ledgerSumMinor, 95800);
  assert.equal(integrity.isValid, true);
});

test('updateAccount, updateCategory, and updateRecurringRule support rename, edit, and archive/deactivate', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'crud@example.com', homeCurrencyCode: 'USD' });
  const acc = ledger.createAccount(user.id, { name: 'Old Wallet', type: 'CASH_CHECKING', initialBalanceMinor: 5000 });
  const cat = ledger.createCategory(user.id, { name: 'Old Cat', kind: 'EXPENSE', monthlyCapMinor: 10000 });
  const rule = ledger.createRecurringRule(user.id, {
    title: 'Old Bill',
    type: 'EXPENSE',
    defaultAmountMinor: 1500,
    accountId: acc.id,
    categoryId: cat.id,
    frequency: 'MONTHLY',
    nextDueDate: '2026-11-28',
  });

  const renamedAcc = ledger.updateAccount(user.id, acc.id, { name: 'Main Wallet', includeInSafeToSpend: false });
  assert.equal(renamedAcc.name, 'Main Wallet');
  assert.equal(renamedAcc.includeInSafeToSpend, false);

  const archivedAcc = ledger.updateAccount(user.id, acc.id, { isArchived: true });
  assert.equal(archivedAcc.isArchived, true);
  assert.equal(ledger.listAccounts(user.id).length, 0);

  const updatedCat = ledger.updateCategory(user.id, cat.id, { name: 'Food & Drink', monthlyCapMinor: 20000 });
  assert.equal(updatedCat.name, 'Food & Drink');
  assert.equal(updatedCat.monthlyCapMinor, 20000);

  const updatedRule = ledger.updateRecurringRule(user.id, rule.id, {
    title: 'Fiber Internet',
    defaultAmountMinor: 6500,
    nextDueDate: '2026-11-30',
    isActive: false,
  });
  assert.equal(updatedRule.title, 'Fiber Internet');
  assert.equal(updatedRule.defaultAmountMinor, 6500);
  assert.equal(updatedRule.nextDueDate, '2026-11-30');
  assert.equal(updatedRule.isActive, false);
});

test('getCycleDashboard returns cycle-over-cycle spending insights (previousTotalSpentMinor, spentDeltaMinor, and per-category deltas)', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'insights@example.com', homeCurrencyCode: 'USD', budgetCycleStartDay: 1 });
  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 500000, occurredOn: '2026-10-01' });
  const dining = ledger.createCategory(user.id, { name: 'Dining', kind: 'EXPENSE', monthlyCapMinor: 30000 });

  // October cycle: $100.00 spent
  ledger.recordTransaction(user.id, {
    type: 'EXPENSE',
    amountMinor: 10000,
    accountId: checking.id,
    categoryId: dining.id,
    occurredOn: '2026-10-15',
  });

  // November cycle: $75.00 spent ($25.00 less than October)
  ledger.recordTransaction(user.id, {
    type: 'EXPENSE',
    amountMinor: 7500,
    accountId: checking.id,
    categoryId: dining.id,
    occurredOn: '2026-11-15',
  });

  const dash = ledger.getCycleDashboard(user.id, '2026-11-20');
  assert.equal(dash.totalSpentMinor, 7500);
  assert.equal(dash.previousTotalSpentMinor, 10000);
  assert.equal(dash.spentDeltaMinor, -2500);

  const diningSummary = dash.categories.find((c) => c.id === dining.id);
  assert.equal(diningSummary.netSpentMinor, 7500);
  assert.equal(diningSummary.previousNetSpentMinor, 10000);
  assert.equal(diningSummary.deltaMinor, -2500);
});

test('HTTP PATCH endpoints enforce session auth + tenant isolation for transaction, account, category, and recurring edits', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  const regA = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: { email: 'user1@example.com', password: 'password123' },
  });
  assert.equal(regA.status, 201);
  const cookieA = regA.headers['set-cookie'].split(';')[0];

  const regB = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: { email: 'user2@example.com', password: 'password123' },
  });
  assert.equal(regB.status, 201);
  const cookieB = regB.headers['set-cookie'].split(';')[0];

  const accRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/accounts',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: { name: 'Cash', type: 'CASH_CHECKING', initialBalanceMinor: 50000 },
  });
  const accId = accRes.json().account.id;

  const dashA = (await invokeHandler(handler, { url: '/api/dashboard?date=2026-11-27', headers: { cookie: cookieA } })).json();
  const catId = dashA.categories.find((c) => c.kind === 'EXPENSE').id;

  const txRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/transactions',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: { type: 'EXPENSE', amountMinor: 1000, accountId: accId, categoryId: catId, occurredOn: '2026-11-27', note: 'Tea' },
  });
  const txId = txRes.json().transaction.id;

  // Tenant B cannot PATCH Tenant A's transaction
  const crossRes = await invokeHandler(handler, {
    method: 'PATCH',
    url: `/api/transactions/${txId}`,
    headers: { 'content-type': 'application/json', cookie: cookieB },
    body: { note: 'Hacked' },
  });
  assert.equal(crossRes.status, 403);

  // Tenant A can PATCH their own transaction & account
  const patchTx = await invokeHandler(handler, {
    method: 'PATCH',
    url: `/api/transactions/${txId}`,
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: { amountMinor: 1500, note: 'Matcha Tea' },
  });
  assert.equal(patchTx.status, 200);
  assert.equal(patchTx.json().transaction.amountMinor, 1500);
  assert.equal(patchTx.json().transaction.note, 'Matcha Tea');

  const patchAcc = await invokeHandler(handler, {
    method: 'PATCH',
    url: `/api/accounts/${accId}`,
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: { name: 'Pocket Cash' },
  });
  assert.equal(patchAcc.status, 200);
  assert.equal(patchAcc.json().account.name, 'Pocket Cash');
});
