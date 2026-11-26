# PocketLedger V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the PocketLedger V1 ACID SQLite ledger engine, automated test suite proving all 5 MVP success criteria, and the responsive mobile quick-entry + desktop reconciliation web application.

**Architecture:** Zero-dependency Node.js v24 backend using `node:sqlite` (`DatabaseSync` with explicit ACID transactions and foreign keys) and `node:http`, paired with an installable mobile-first PWA frontend built with Emil Kowalski's `emil-design-eng` and `mobile-native` guidelines (`100dvh`, `touch-action: manipulation`, `:active` `scale(0.97)` feedback, custom `--ease-out` curves, and capability-gated hover rules).

**Tech Stack:** Node.js v24 (`node:sqlite`, `node:test`, `node:assert/strict`, `node:http`), Vanilla HTML5/CSS3/ES2024 PWA.

**Spec:** `docs/superpowers/specs/2026-11-26-pocket-ledger-v1-design.md`

## Global Constraints

- Store all currency amounts as integer minor units (`INTEGER` cents/centavos). Reject non-integer or `<= 0` amounts on `EXPENSE`, `REFUND`, `INCOME`, and `TRANSFER`.
- Every table (`users`, `accounts`, `categories`, `transactions`, `ledger_entries`, `recurring_rules`) enforces `user_id` ownership.
- Every balance change writes to `ledger_entries` and updates `accounts.cached_balance_minor` inside an explicit `BEGIN IMMEDIATE ... COMMIT` transaction.
- Never hard-delete transactions; `voidTransaction(userId, transactionId)` soft-voids and recalculates `cached_balance_minor` from `SUM(signed_amount_minor)` of non-voided `ledger_entries`.
- `TRANSFER` transactions require `transfer_destination_account_id`, forbid `category_id`, and have `0` impact on income/expense reports.
- `REFUND` transactions require an `EXPENSE` category, credit the account balance (`+amount_minor`), and subtract from net category spending (`EXPENSE - REFUND`).

## Review Focus

- Cross-tenant foreign key injection: User A attempts to log a transaction or transfer referencing User B's `account_id`, `transfer_destination_account_id`, or `category_id` -> must throw an authorization/not-found error and roll back.
- Floating-point or negative amount injection: Passing `19.99`, `NaN`, `0`, or `-500` to `recordTransaction` -> must throw `TypeError`/`RangeError` before touching the database.
- Same-account transfer: Passing `account_id === transfer_destination_account_id` on a `TRANSFER` -> must reject with validation error.
- Refunds exceeding category spend in a new cycle: A `REFUND` of `5000` in a cycle with `0` expenses -> must result in `-5000` net category spend without corrupting total income or throwing unsigned underflow errors.
- Custom budget cycle start day boundary (`budget_cycle_start_day = 15`): Transactions on the 14th belong to the previous cycle; transactions on the 15th belong to the new cycle.

---

### Task 1: Core ACID Ledger Engine & Criterion #1 (100-Transaction Zero-Drift Audit)

**Files:**
- Create: `src/ledger.mjs`
- Test: `tests/ledger.test.mjs`

**Interfaces:**
- Produces:
  - `createLedgerDb(dbPath = ':memory:') -> LedgerService`
  - `ledger.createUser({ id, email, homeCurrencyCode, budgetCycleStartDay })`
  - `ledger.createAccount(userId, { name, type, initialBalanceMinor, includeInSafeToSpend })`
  - `ledger.createCategory(userId, { name, kind, monthlyCapMinor, icon, color })`
  - `ledger.recordTransaction(userId, { type, amountMinor, accountId, transferDestinationAccountId, categoryId, occurredOn, note, recurringRuleId })`
  - `ledger.voidTransaction(userId, transactionId)`
  - `ledger.reconcileAccountBalance(userId, accountId, actualBalanceMinor, occurredOn, note)`
  - `ledger.verifyAccountIntegrity(userId, accountId) -> { cachedBalanceMinor, ledgerSumMinor, isValid }`

- [ ] **Step 1: Write failing tests in `tests/ledger.test.mjs` for integer validation, ACID double-entry invariant, soft-voiding, and 100-transaction zero-drift simulation**
- [ ] **Step 2: Run `node --test tests/ledger.test.mjs` to verify RED failure**
- [ ] **Step 3: Implement `src/ledger.mjs` with SQLite schema and ACID transaction methods**
- [ ] **Step 4: Run `node --test tests/ledger.test.mjs` to verify GREEN pass**

### Task 2: Transfers, Credit Card Neutrality, Refunds & Cycle Math (Criteria #2 & #4)

**Files:**
- Modify: `src/ledger.mjs`
- Test: `tests/budget-and-edge-cases.test.mjs`

**Interfaces:**
- Consumes: `createLedgerDb` from `src/ledger.mjs`
- Produces:
  - `ledger.getBudgetCycleWindow(referenceDateStr, budgetCycleStartDay) -> { cycleStart, cycleEnd }`
  - `ledger.getCycleDashboard(userId, referenceDateStr) -> { cycleStart, cycleEnd, totalIncomeMinor, totalSpentMinor, safeToSpendMinor, netLiquidityMinor, creditCardDebtMinor, accounts, categories, recentTransactions, dueRecurringRules }`

- [ ] **Step 1: Write failing tests in `tests/budget-and-edge-cases.test.mjs` covering transfer neutrality, credit card debt paydown, refund net category reduction, and custom cycle boundaries**
- [ ] **Step 2: Run `node --test tests/budget-and-edge-cases.test.mjs` to verify RED failure**
- [ ] **Step 3: Implement cycle window calculation and `getCycleDashboard` in `src/ledger.mjs`**
- [ ] **Step 4: Run `node --test tests/budget-and-edge-cases.test.mjs` to verify GREEN pass**

### Task 3: Multi-Tenant Isolation, 1-Tap Recurring Reminders & CSV Export (Criterion #5)

**Files:**
- Modify: `src/ledger.mjs`
- Test: `tests/security-and-export.test.mjs`

**Interfaces:**
- Consumes: `createLedgerDb` from `src/ledger.mjs`
- Produces:
  - `ledger.createRecurringRule(userId, { title, type, defaultAmountMinor, accountId, categoryId, frequency, nextDueDate })`
  - `ledger.postRecurringRule(userId, ruleId, overrides)`
  - `ledger.exportLedgerCsv(userId) -> string`

- [ ] **Step 1: Write failing tests in `tests/security-and-export.test.mjs` covering cross-tenant attacks, 1-tap recurring rule posting, and 100% CSV reconciliation**
- [ ] **Step 2: Run `node --test tests/security-and-export.test.mjs` to verify RED failure**
- [ ] **Step 3: Implement tenant boundary guards, recurring rule posting, and CSV export in `src/ledger.mjs`**
- [ ] **Step 4: Run `node --test tests/*.test.mjs` to verify all unit/integration tests pass**

### Task 4: HTTP API + Sub-5-Second Mobile Quick-Entry & Desktop Reconciliation UI (Criterion #3)

**Files:**
- Create: `src/seed.mjs`
- Create: `src/server.mjs`
- Create: `public/manifest.json`
- Create: `public/styles.css`
- Create: `public/index.html`
- Create: `public/app.js`
- Test: `tests/api-and-ui.test.mjs`

- [ ] **Step 1: Write failing API & smart-default tests in `tests/api-and-ui.test.mjs`**
- [ ] **Step 2: Run `node --test tests/api-and-ui.test.mjs` to verify RED failure**
- [ ] **Step 3: Implement `src/seed.mjs`, `src/server.mjs`, and the responsive PWA frontend (`public/index.html`, `public/styles.css`, `public/app.js`, `public/manifest.json`)**
- [ ] **Step 4: Run `node --test tests/*.test.mjs` and verify all tests + live server responses pass**
