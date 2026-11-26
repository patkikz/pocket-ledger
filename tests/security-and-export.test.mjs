import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerDb } from '../src/ledger.mjs';

test('Criterion #5: Strict multi-tenant isolation prevents User A from viewing, spending from, transferring into, or voiding User B data', () => {
  const ledger = createLedgerDb(':memory:');
  const userA = ledger.createUser({ email: 'userA@example.com', homeCurrencyCode: 'USD' });
  const userB = ledger.createUser({ email: 'userB@example.com', homeCurrencyCode: 'USD' });

  const accA = ledger.createAccount(userA.id, { name: 'User A Checking', type: 'CASH_CHECKING', initialBalanceMinor: 100000 });
  const catA = ledger.createCategory(userA.id, { name: 'User A Food', kind: 'EXPENSE', monthlyCapMinor: 30000 });

  const accB = ledger.createAccount(userB.id, { name: 'User B Checking', type: 'CASH_CHECKING', initialBalanceMinor: 500000 });
  const catB = ledger.createCategory(userB.id, { name: 'User B Food', kind: 'EXPENSE', monthlyCapMinor: 50000 });
  const txB = ledger.recordTransaction(userB.id, {
    type: 'EXPENSE',
    amountMinor: 2500,
    accountId: accB.id,
    categoryId: catB.id,
    occurredOn: '2026-11-12',
    note: 'Private lunch',
  });

  // User A cannot read User B's account or transaction
  assert.throws(() => ledger.getAccount(userA.id, accB.id), /access denied|not found/i);
  assert.throws(() => ledger.getTransaction(userA.id, txB.id), /access denied|not found/i);

  // User A cannot record an expense on User B's account or using User B's category
  assert.throws(
    () => ledger.recordTransaction(userA.id, {
      type: 'EXPENSE',
      amountMinor: 1000,
      accountId: accB.id,
      categoryId: catA.id,
      occurredOn: '2026-11-12',
    }),
    /access denied|not found/i
  );
  assert.throws(
    () => ledger.recordTransaction(userA.id, {
      type: 'EXPENSE',
      amountMinor: 1000,
      accountId: accA.id,
      categoryId: catB.id,
      occurredOn: '2026-11-12',
    }),
    /access denied|not found/i
  );

  // User A cannot transfer money into/out of User B's account
  assert.throws(
    () => ledger.recordTransaction(userA.id, {
      type: 'TRANSFER',
      amountMinor: 5000,
      accountId: accA.id,
      transferDestinationAccountId: accB.id,
      occurredOn: '2026-11-12',
    }),
    /access denied|not found/i
  );

  // User A cannot void User B's transaction
  assert.throws(() => ledger.voidTransaction(userA.id, txB.id), /access denied|not found/i);

  // User B's balance remains untouched
  assert.equal(ledger.getAccount(userB.id, accB.id).cachedBalanceMinor, 497500);
});

test('1-Tap Recurring Reminders calculate Safe-to-Spend and advance nextDueDate on 1-tap post', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'bills@example.com', homeCurrencyCode: 'USD', budgetCycleStartDay: 1 });
  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 200000, occurredOn: '2026-11-01' }); // $2,000
  const savings = ledger.createAccount(user.id, { name: 'Emergency Savings', type: 'SAVINGS', initialBalanceMinor: 500000, occurredOn: '2026-11-01' }); // $5,000 (excluded from Safe to Spend)
  const billsCat = ledger.createCategory(user.id, { name: 'Rent & Bills', kind: 'EXPENSE', monthlyCapMinor: 150000 });

  // Create a recurring rent rule due on 2026-11-28 ($1,200.00)
  const rentRule = ledger.createRecurringRule(user.id, {
    title: 'Apartment Rent',
    type: 'EXPENSE',
    defaultAmountMinor: 120000,
    accountId: checking.id,
    categoryId: billsCat.id,
    frequency: 'MONTHLY',
    nextDueDate: '2026-11-28',
  });

  // Before posting: Checking is still $2,000, unpaid recurring bill in cycle is $1,200 -> Safe to Spend is $800
  const dashBefore = ledger.getCycleDashboard(user.id, '2026-11-20');
  assert.equal(dashBefore.unpaidRecurringMinor, 120000);
  assert.equal(dashBefore.safeToSpendMinor, 80000); // $2,000 checking - $1,200 upcoming rent (Savings excluded)

  // User taps 1-tap "Post to Ledger"
  const postResult = ledger.postRecurringRule(user.id, rentRule.id);
  assert.equal(postResult.transaction.amountMinor, 120000);
  assert.equal(postResult.rule.nextDueDate, '2026-12-28');

  // After posting: Checking is $800, unpaid recurring bills in Nov cycle is $0 -> Safe to Spend remains $800
  const dashAfter = ledger.getCycleDashboard(user.id, '2026-11-20');
  assert.equal(ledger.getAccount(user.id, checking.id).cachedBalanceMinor, 80000);
  assert.equal(dashAfter.unpaidRecurringMinor, 0);
  assert.equal(dashAfter.safeToSpendMinor, 80000);
  assert.equal(ledger.getAccount(user.id, savings.id).cachedBalanceMinor, 500000);
});

test('Criterion #5: CSV Export exports 100% of ledger rows and reconciles identically to in-app account balances', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'export@example.com', homeCurrencyCode: 'USD', budgetCycleStartDay: 1 });
  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 150000, occurredOn: '2026-11-01' });
  const food = ledger.createCategory(user.id, { name: 'Groceries', kind: 'EXPENSE', monthlyCapMinor: 50000 });

  ledger.recordTransaction(user.id, {
    type: 'EXPENSE',
    amountMinor: 4250,
    accountId: checking.id,
    categoryId: food.id,
    occurredOn: '2026-11-03',
    note: 'Trader Joes, fresh produce',
  });
  ledger.recordTransaction(user.id, {
    type: 'REFUND',
    amountMinor: 500,
    accountId: checking.id,
    categoryId: food.id,
    occurredOn: '2026-11-04',
    note: 'Damaged item refund',
  });

  const csv = ledger.exportLedgerCsv(user.id);
  const lines = csv.trim().split('\n');
  // Header + 3 postings (Opening Balance adjustment + Expense + Refund)
  assert.equal(lines.length, 4);
  assert.match(lines[0], /entry_id,transaction_id,occurred_on,type,account_name,category_name,signed_amount_minor,formatted_amount,note/);

  // Sum the signed_amount_minor column (index 6) from the CSV and verify it equals cachedBalanceMinor
  let csvSumMinor = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    csvSumMinor += Number(cols[6]);
  }
  assert.equal(csvSumMinor, ledger.getAccount(user.id, checking.id).cachedBalanceMinor);
  assert.equal(csvSumMinor, 146250);
});
