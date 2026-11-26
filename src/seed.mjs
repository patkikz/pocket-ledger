import { hashPassword } from './ledger.mjs';

const DEMO_EMAILS = ['patrick@pocketledger.app', 'alex.isolated@pocketledger.app'];

function ensureDemoPasswords(ledger) {
  for (const email of DEMO_EMAILS) {
    const row = ledger.db
      .prepare('SELECT id, password_hash FROM users WHERE LOWER(email) = ?')
      .get(email);
    if (row && !row.password_hash) {
      ledger.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hashPassword('pocketledger-demo'), row.id);
    }
  }
}

export function seedDefaultTenants(ledger, { disableDemo = process.env.DISABLE_DEMO === '1' } = {}) {
  if (disableDemo) {
    return {
      demoUserId: null,
      secondUserId: null,
      personalUserId: null,
    };
  }

  const existing = ledger.getUser('user-demo-primary');
  if (existing) {
    if (!ledger.getUser('user-personal')) {
      seedPersonalProfile(ledger);
    }
    ensureDemoPasswords(ledger);
    return {
      demoUserId: existing.id,
      secondUserId: 'user-demo-secondary',
      personalUserId: 'user-personal',
    };
  }

  // Tenant A: Primary user
  const userA = ledger.createUser({
    id: 'user-demo-primary',
    email: 'patrick@pocketledger.app',
    homeCurrencyCode: 'USD',
    budgetCycleStartDay: 1,
  });

  const checking = ledger.createAccount(userA.id, {
    id: 'acc-checking-primary',
    name: 'Chase Checking',
    type: 'CASH_CHECKING',
    initialBalanceMinor: 345000, // $3,450.00
    includeInSafeToSpend: true,
    occurredOn: '2026-11-01',
  });

  const ewallet = ledger.createAccount(userA.id, {
    id: 'acc-ewallet-primary',
    name: 'Daily E-Wallet',
    type: 'CASH_CHECKING',
    initialBalanceMinor: 28550, // $285.50
    includeInSafeToSpend: true,
    occurredOn: '2026-11-01',
  });

  const savings = ledger.createAccount(userA.id, {
    id: 'acc-savings-primary',
    name: 'Emergency Vault',
    type: 'SAVINGS',
    initialBalanceMinor: 1200000, // $12,000.00
    includeInSafeToSpend: false,
    occurredOn: '2026-11-01',
  });

  const creditCard = ledger.createAccount(userA.id, {
    id: 'acc-amex-primary',
    name: 'Amex Gold Card',
    type: 'CREDIT_CARD',
    initialBalanceMinor: -42000, // -$420.00 starting statement balance
    includeInSafeToSpend: false,
    occurredOn: '2026-11-01',
  });

  const dining = ledger.createCategory(userA.id, {
    id: 'cat-dining',
    name: 'Dining & Coffee',
    kind: 'EXPENSE',
    monthlyCapMinor: 45000, // $450.00
    icon: 'utensils',
    color: '#f59e0b',
  });

  const groceries = ledger.createCategory(userA.id, {
    id: 'cat-groceries',
    name: 'Groceries',
    kind: 'EXPENSE',
    monthlyCapMinor: 65000, // $650.00
    icon: 'shopping-bag',
    color: '#10b981',
  });

  const transport = ledger.createCategory(userA.id, {
    id: 'cat-transport',
    name: 'Transit & Fuel',
    kind: 'EXPENSE',
    monthlyCapMinor: 25000, // $250.00
    icon: 'car',
    color: '#3b82f6',
  });

  const utilities = ledger.createCategory(userA.id, {
    id: 'cat-utilities',
    name: 'Bills & Subs',
    kind: 'EXPENSE',
    monthlyCapMinor: 160000, // $1,600.00
    icon: 'zap',
    color: '#8b5cf6',
  });

  const shopping = ledger.createCategory(userA.id, {
    id: 'cat-shopping',
    name: 'Shopping',
    kind: 'EXPENSE',
    monthlyCapMinor: 35000, // $350.00
    icon: 'sparkles',
    color: '#ec4899',
  });

  const salary = ledger.createCategory(userA.id, {
    id: 'cat-salary',
    name: 'Salary & Paycheck',
    kind: 'INCOME',
    icon: 'briefcase',
    color: '#14b8a6',
  });

  // Sample realistic November 2026 ledger transactions
  ledger.recordTransaction(userA.id, {
    type: 'INCOME',
    amountMinor: 280000, // +$2,800.00 paycheck
    accountId: checking.id,
    categoryId: salary.id,
    occurredOn: '2026-11-15',
    note: 'Mid-month payroll deposit',
  });

  ledger.recordTransaction(userA.id, {
    type: 'EXPENSE',
    amountMinor: 14280, // -$142.80
    accountId: creditCard.id,
    categoryId: groceries.id,
    occurredOn: '2026-11-18',
    note: 'Trader Joes weekly haul',
  });

  ledger.recordTransaction(userA.id, {
    type: 'EXPENSE',
    amountMinor: 1850, // -$18.50
    accountId: ewallet.id,
    categoryId: dining.id,
    occurredOn: '2026-11-21',
    note: 'Pour-over coffee & pastry',
  });

  ledger.recordTransaction(userA.id, {
    type: 'EXPENSE',
    amountMinor: 8900, // -$89.00
    accountId: creditCard.id,
    categoryId: shopping.id,
    occurredOn: '2026-11-22',
    note: 'Running shoes order',
  });

  ledger.recordTransaction(userA.id, {
    type: 'REFUND',
    amountMinor: 2500, // +$25.00 refund on shoes promo
    accountId: creditCard.id,
    categoryId: shopping.id,
    occurredOn: '2026-11-24',
    note: 'Price match partial refund',
  });

  ledger.recordTransaction(userA.id, {
    type: 'TRANSFER',
    amountMinor: 42000, // $420.00 payment from Checking to Amex
    accountId: checking.id,
    transferDestinationAccountId: creditCard.id,
    occurredOn: '2026-11-25',
    note: 'Pay prior Amex statement balance',
  });

  ledger.recordTransaction(userA.id, {
    type: 'EXPENSE',
    amountMinor: 1475, // -$14.75
    accountId: ewallet.id,
    categoryId: dining.id,
    occurredOn: '2026-11-26',
    note: 'Lunch combo',
  });

  // 1-Tap Recurring Reminders
  ledger.createRecurringRule(userA.id, {
    id: 'rule-rent',
    title: 'Apartment Rent',
    type: 'EXPENSE',
    defaultAmountMinor: 135000, // $1,350.00
    accountId: checking.id,
    categoryId: utilities.id,
    frequency: 'MONTHLY',
    nextDueDate: '2026-11-28',
  });

  ledger.createRecurringRule(userA.id, {
    id: 'rule-fiber',
    title: 'Fiber Internet',
    type: 'EXPENSE',
    defaultAmountMinor: 6500, // $65.00
    accountId: creditCard.id,
    categoryId: utilities.id,
    frequency: 'MONTHLY',
    nextDueDate: '2026-11-29',
  });

  // Tenant B: Second isolated tenant to demonstrate multi-tenant isolation in UI & tests
  const userB = ledger.createUser({
    id: 'user-demo-secondary',
    email: 'alex.isolated@pocketledger.app',
    homeCurrencyCode: 'PHP',
    budgetCycleStartDay: 15,
  });

  const bpiChecking = ledger.createAccount(userB.id, {
    id: 'acc-bpi-secondary',
    name: 'BPI Payroll Checking',
    type: 'CASH_CHECKING',
    initialBalanceMinor: 6850000, // ₱68,500.00
    includeInSafeToSpend: true,
    occurredOn: '2026-11-15',
  });

  const gcash = ledger.createAccount(userB.id, {
    id: 'acc-gcash-secondary',
    name: 'GCash Wallet',
    type: 'CASH_CHECKING',
    initialBalanceMinor: 420000, // ₱4,200.00
    includeInSafeToSpend: true,
    occurredOn: '2026-11-15',
  });

  const foodB = ledger.createCategory(userB.id, {
    id: 'cat-food-secondary',
    name: 'Food & Grab',
    kind: 'EXPENSE',
    monthlyCapMinor: 1500000, // ₱15,000.00
    icon: 'utensils',
    color: '#10b981',
  });

  ledger.recordTransaction(userB.id, {
    type: 'EXPENSE',
    amountMinor: 38500, // ₱385.00
    accountId: gcash.id,
    categoryId: foodB.id,
    occurredOn: '2026-11-26',
    note: 'GrabFood dinner',
  });

  seedPersonalProfile(ledger);
  ensureDemoPasswords(ledger);

  return {
    demoUserId: userA.id,
    secondUserId: userB.id,
    personalUserId: 'user-personal',
    bpiChecking,
  };
}

function seedPersonalProfile(ledger) {
  const personal = ledger.createUser({
    id: 'user-personal',
    email: 'me@pocketledger.app',
    homeCurrencyCode: 'USD',
    budgetCycleStartDay: 1,
  });

  ledger.createCategory(personal.id, {
    id: 'cat-personal-groceries',
    name: 'Groceries',
    kind: 'EXPENSE',
    monthlyCapMinor: 50000,
    icon: 'shopping-bag',
    color: '#10b981',
  });
  ledger.createCategory(personal.id, {
    id: 'cat-personal-dining',
    name: 'Dining & Coffee',
    kind: 'EXPENSE',
    monthlyCapMinor: 30000,
    icon: 'utensils',
    color: '#f59e0b',
  });
  ledger.createCategory(personal.id, {
    id: 'cat-personal-transport',
    name: 'Transport',
    kind: 'EXPENSE',
    monthlyCapMinor: 20000,
    icon: 'car',
    color: '#3b82f6',
  });
  ledger.createCategory(personal.id, {
    id: 'cat-personal-bills',
    name: 'Bills & Subs',
    kind: 'EXPENSE',
    monthlyCapMinor: 100000,
    icon: 'zap',
    color: '#8b5cf6',
  });
  ledger.createCategory(personal.id, {
    id: 'cat-personal-salary',
    name: 'Income / Paycheck',
    kind: 'INCOME',
    icon: 'briefcase',
    color: '#14b8a6',
  });

  return personal;
}
