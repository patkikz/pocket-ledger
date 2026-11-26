import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerDb } from '../src/ledger.mjs';

test('Criterion #1: Rejects floating-point, zero, negative, or NaN amounts', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'alice@example.com', homeCurrencyCode: 'USD', budgetCycleStartDay: 1 });
  const checking = ledger.createAccount(user.id, { name: 'Checking', type: 'CASH_CHECKING', initialBalanceMinor: 100000 });
  const groceries = ledger.createCategory(user.id, { name: 'Groceries', kind: 'EXPENSE', monthlyCapMinor: 50000 });

  for (const invalidAmount of [19.99, -500, 0, NaN, '1500', null]) {
    assert.throws(
      () => ledger.recordTransaction(user.id, {
        type: 'EXPENSE',
        amountMinor: invalidAmount,
        accountId: checking.id,
        categoryId: groceries.id,
        occurredOn: '2026-11-10',
      }),
      /integer minor units/i
    );
  }
});

test('Criterion #1: Opening balance is recorded as an ADJUSTMENT ledger entry so ledger sum matches cached balance from Day 1', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'alice@example.com', homeCurrencyCode: 'PHP', budgetCycleStartDay: 1 });
  const bpi = ledger.createAccount(user.id, { name: 'BPI Checking', type: 'CASH_CHECKING', initialBalanceMinor: 245012 });

  const integrity = ledger.verifyAccountIntegrity(user.id, bpi.id);
  assert.equal(integrity.cachedBalanceMinor, 245012);
  assert.equal(integrity.ledgerSumMinor, 245012);
  assert.equal(integrity.isValid, true);
});

test('Criterion #1: 100 mixed transactions + soft-voiding + reconciliation maintain 0-cent drift between ledger_entries and cached_balance_minor', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.createUser({ email: 'audit@example.com', homeCurrencyCode: 'USD', budgetCycleStartDay: 1 });

  const checking = ledger.createAccount(user.id, { name: 'Chase Checking', type: 'CASH_CHECKING', initialBalanceMinor: 500000 }); // $5,000.00
  const savings = ledger.createAccount(user.id, { name: 'Ally Savings', type: 'SAVINGS', initialBalanceMinor: 1000000 }); // $10,000.00
  const amex = ledger.createAccount(user.id, { name: 'Amex Gold', type: 'CREDIT_CARD', initialBalanceMinor: -32000 }); // -$320.00

  const salaryCat = ledger.createCategory(user.id, { name: 'Salary', kind: 'INCOME' });
  const diningCat = ledger.createCategory(user.id, { name: 'Dining Out', kind: 'EXPENSE', monthlyCapMinor: 60000 });
  const groceryCat = ledger.createCategory(user.id, { name: 'Groceries', kind: 'EXPENSE', monthlyCapMinor: 80000 });

  let expectedChecking = 500000;
  let expectedSavings = 1000000;
  let expectedAmex = -32000;
  const recordedTxIds = [];

  // Execute 100 mixed transactions across odd cent amounts (e.g. 1999, 333, 4789)
  for (let i = 1; i <= 100; i++) {
    const day = String(((i - 1) % 28) + 1).padStart(2, '0');
    const dateStr = `2026-11-${day}`;

    if (i % 10 === 0) {
      // Income into checking
      const amt = 123456 + i;
      const tx = ledger.recordTransaction(user.id, {
        type: 'INCOME',
        amountMinor: amt,
        accountId: checking.id,
        categoryId: salaryCat.id,
        occurredOn: dateStr,
        note: `Payroll #${i}`,
      });
      expectedChecking += amt;
      recordedTxIds.push({ id: tx.id, kind: 'INCOME_CHECKING', amt });
    } else if (i % 7 === 0) {
      // Transfer from Checking to Savings
      const amt = 15000 + i * 3;
      const tx = ledger.recordTransaction(user.id, {
        type: 'TRANSFER',
        amountMinor: amt,
        accountId: checking.id,
        transferDestinationAccountId: savings.id,
        occurredOn: dateStr,
        note: `Transfer to savings #${i}`,
      });
      expectedChecking -= amt;
      expectedSavings += amt;
      recordedTxIds.push({ id: tx.id, kind: 'TRANSFER_CHK_SAV', amt });
    } else if (i % 5 === 0) {
      // Transfer from Checking to pay Amex Credit Card
      const amt = 12000 + i;
      const tx = ledger.recordTransaction(user.id, {
        type: 'TRANSFER',
        amountMinor: amt,
        accountId: checking.id,
        transferDestinationAccountId: amex.id,
        occurredOn: dateStr,
        note: `Amex payment #${i}`,
      });
      expectedChecking -= amt;
      expectedAmex += amt;
      recordedTxIds.push({ id: tx.id, kind: 'TRANSFER_CHK_AMEX', amt });
    } else if (i % 4 === 0) {
      // Refund onto Amex
      const amt = 1999 + i;
      const tx = ledger.recordTransaction(user.id, {
        type: 'REFUND',
        amountMinor: amt,
        accountId: amex.id,
        categoryId: diningCat.id,
        occurredOn: dateStr,
        note: `Refund #${i}`,
      });
      expectedAmex += amt;
      recordedTxIds.push({ id: tx.id, kind: 'REFUND_AMEX', amt });
    } else if (i % 2 === 0) {
      // Expense on Amex
      const amt = 2499 + i * 7;
      const tx = ledger.recordTransaction(user.id, {
        type: 'EXPENSE',
        amountMinor: amt,
        accountId: amex.id,
        categoryId: diningCat.id,
        occurredOn: dateStr,
        note: `Dining #${i}`,
      });
      expectedAmex -= amt;
      recordedTxIds.push({ id: tx.id, kind: 'EXPENSE_AMEX', amt });
    } else {
      // Expense on Checking
      const amt = 3749 + i * 11;
      const tx = ledger.recordTransaction(user.id, {
        type: 'EXPENSE',
        amountMinor: amt,
        accountId: checking.id,
        categoryId: groceryCat.id,
        occurredOn: dateStr,
        note: `Grocery #${i}`,
      });
      expectedChecking -= amt;
      recordedTxIds.push({ id: tx.id, kind: 'EXPENSE_CHECKING', amt });
    }
  }

  // Soft-void two transactions (one expense on checking, one transfer) and verify audit trail stays intact
  const firstCheckingExpense = recordedTxIds.find((t) => t.kind === 'EXPENSE_CHECKING');
  ledger.voidTransaction(user.id, firstCheckingExpense.id);
  expectedChecking += firstCheckingExpense.amt;

  const firstTransfer = recordedTxIds.find((t) => t.kind === 'TRANSFER_CHK_SAV');
  ledger.voidTransaction(user.id, firstTransfer.id);
  expectedChecking += firstTransfer.amt;
  expectedSavings -= firstTransfer.amt;

  // Verify exact penny match and zero drift across all three accounts
  const chkIntegrity = ledger.verifyAccountIntegrity(user.id, checking.id);
  const savIntegrity = ledger.verifyAccountIntegrity(user.id, savings.id);
  const amexIntegrity = ledger.verifyAccountIntegrity(user.id, amex.id);

  assert.equal(chkIntegrity.cachedBalanceMinor, expectedChecking);
  assert.equal(chkIntegrity.ledgerSumMinor, expectedChecking);
  assert.equal(chkIntegrity.isValid, true);

  assert.equal(savIntegrity.cachedBalanceMinor, expectedSavings);
  assert.equal(savIntegrity.ledgerSumMinor, expectedSavings);
  assert.equal(savIntegrity.isValid, true);

  assert.equal(amexIntegrity.cachedBalanceMinor, expectedAmex);
  assert.equal(amexIntegrity.ledgerSumMinor, expectedAmex);
  assert.equal(amexIntegrity.isValid, true);
});
