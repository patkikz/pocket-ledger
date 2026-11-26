import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerDb } from '../src/ledger.mjs';

test('Criterion #2: Transfers between Checking, Savings, and Credit Card update balances with $0.00 impact on Income, Total Spent, or Category Budgets', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'transfer@example.com', homeCurrencyCode: 'USD', budgetCycleStartDay: 1 });

  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 300000, occurredOn: '2026-11-01' }); // $3,000
  const savings = ledger.createAccount(user.id, { name: 'Savings', type: 'SAVINGS', initialBalanceMinor: 500000, occurredOn: '2026-11-01' }); // $5,000
  const creditCard = ledger.createAccount(user.id, { name: 'Visa Card', type: 'CREDIT_CARD', initialBalanceMinor: -50000, occurredOn: '2026-11-01' }); // -$500 debt

  const dining = ledger.createCategory(user.id, { name: 'Dining', kind: 'EXPENSE', monthlyCapMinor: 40000 }); // $400 cap

  // 1. Spend $40.00 on Credit Card
  ledger.recordTransaction(user.id, {
    type: 'EXPENSE',
    amountMinor: 4000,
    accountId: creditCard.id,
    categoryId: dining.id,
    occurredOn: '2026-11-05',
    note: 'Dinner',
  });

  // 2. Transfer $1,000.00 from Checking to Savings
  ledger.recordTransaction(user.id, {
    type: 'TRANSFER',
    amountMinor: 100000,
    accountId: checking.id,
    transferDestinationAccountId: savings.id,
    occurredOn: '2026-11-06',
    note: 'Monthly savings move',
  });

  // 3. Pay $500.00 Credit Card bill from Checking
  ledger.recordTransaction(user.id, {
    type: 'TRANSFER',
    amountMinor: 50000,
    accountId: checking.id,
    transferDestinationAccountId: creditCard.id,
    occurredOn: '2026-11-07',
    note: 'Credit card payment',
  });

  const dashboard = ledger.getCycleDashboard(user.id, '2026-11-15');

  // Account balances updated accurately
  assert.equal(ledger.getAccount(user.id, checking.id).cachedBalanceMinor, 150000); // $3,000 - $1,000 - $500 = $1,500
  assert.equal(ledger.getAccount(user.id, savings.id).cachedBalanceMinor, 600000); // $5,000 + $1,000 = $6,000
  assert.equal(ledger.getAccount(user.id, creditCard.id).cachedBalanceMinor, -4000); // -$500 - $40 + $500 = -$40

  // Transfers have 0 impact on income or spending
  assert.equal(dashboard.totalIncomeMinor, 0);
  assert.equal(dashboard.totalSpentMinor, 4000);

  const diningSummary = dashboard.categories.find((c) => c.id === dining.id);
  assert.equal(diningSummary.netSpentMinor, 4000);
  assert.equal(diningSummary.remainingCapMinor, 36000);
});

test('Criterion #4: Refunds reduce net category spending without inflating income, and custom budgetCycleStartDay isolates month boundaries', () => {
  const ledger = createLedgerDb(':memory:');
  // User gets paid on the 15th -> custom budget cycle start day = 15
  const user = ledger.createUser({ email: 'refund@example.com', homeCurrencyCode: 'USD', budgetCycleStartDay: 15 });
  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 200000, occurredOn: '2026-10-15' });
  const clothing = ledger.createCategory(user.id, { name: 'Clothing', kind: 'EXPENSE', monthlyCapMinor: 30000 }); // $300 cap

  // Cycle A: 2026-10-15 to 2026-11-14
  // Spend $200.00 on 2026-10-20 and $50.00 on 2026-11-14 (last day of Cycle A)
  ledger.recordTransaction(user.id, {
    type: 'EXPENSE',
    amountMinor: 20000,
    accountId: checking.id,
    categoryId: clothing.id,
    occurredOn: '2026-10-20',
    note: 'Winter Jacket',
  });
  ledger.recordTransaction(user.id, {
    type: 'EXPENSE',
    amountMinor: 5000,
    accountId: checking.id,
    categoryId: clothing.id,
    occurredOn: '2026-11-14',
    note: 'Shoes',
  });

  // Refund $50.00 on 2026-11-14 (still inside Cycle A)
  ledger.recordTransaction(user.id, {
    type: 'REFUND',
    amountMinor: 5000,
    accountId: checking.id,
    categoryId: clothing.id,
    occurredOn: '2026-11-14',
    note: 'Returned Shoes',
  });

  const cycleADashboard = ledger.getCycleDashboard(user.id, '2026-11-14');
  assert.equal(cycleADashboard.cycleStart, '2026-10-15');
  assert.equal(cycleADashboard.cycleEnd, '2026-11-14');
  assert.equal(cycleADashboard.totalIncomeMinor, 0); // Refund never inflates income
  assert.equal(cycleADashboard.totalSpentMinor, 20000); // $250 - $50 = $200 net spent

  // Roll over to Cycle B: 2026-11-15 to 2026-12-14
  const cycleBDashboardBefore = ledger.getCycleDashboard(user.id, '2026-11-15');
  assert.equal(cycleBDashboardBefore.cycleStart, '2026-11-15');
  assert.equal(cycleBDashboardBefore.cycleEnd, '2026-12-14');
  assert.equal(cycleBDashboardBefore.totalSpentMinor, 0); // Reset to 0 for new cycle

  // Now record a $100 refund in Cycle B (2026-11-18) for the jacket bought in Cycle A
  ledger.recordTransaction(user.id, {
    type: 'REFUND',
    amountMinor: 10000,
    accountId: checking.id,
    categoryId: clothing.id,
    occurredOn: '2026-11-18',
    note: 'Partial Jacket Refund',
  });

  // Historical Cycle A must remain immutable ($200.00 spent)
  const cycleAAfter = ledger.getCycleDashboard(user.id, '2026-11-10');
  assert.equal(cycleAAfter.totalSpentMinor, 20000);

  // Cycle B reflects -$100.00 net spend without inflating income
  const cycleBAfter = ledger.getCycleDashboard(user.id, '2026-11-18');
  assert.equal(cycleBAfter.totalIncomeMinor, 0);
  assert.equal(cycleBAfter.totalSpentMinor, -10000);
});
