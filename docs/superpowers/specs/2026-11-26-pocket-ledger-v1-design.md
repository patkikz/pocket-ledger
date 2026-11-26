# PocketLedger V1 Design Specification

**Date:** 2026-11-26
**Status:** Approved

## 1. Product Intent & Scope
PocketLedger V1 is an online-first, single-user-per-tenant Progressive Web App (PWA) for personal daily expense tracking and weekly desktop bank reconciliation.
- **Primary Mobile Flow:** Under-5-second point-of-sale entry in 3-4 taps via a default numeric keypad with smart defaults (`last_used_account_id`, top categories sorted by `usage_count`).
- **Desktop Flow:** Weekly account balance reconciliation, reactive category budget progress, 1-tap recurring bill reminders, and 100% ledger CSV export.
- **Budgeting Philosophy:** Reactive monthly category caps + Cash-Flow "Safe to Spend" indicator (`Total Liquid Safe-to-Spend Accounts - Unpaid Recurring Expenses due in current cycle`).
- **Cycle Cadence:** Monthly cycle with user-configurable start day (`1..28`), resetting category spend to zero each cycle without carrying over stale surpluses/deficits.

## 2. Supported Account Types
1. `CASH_CHECKING` — Liquid asset (`include_in_safe_to_spend = true` by default).
2. `SAVINGS` — Liquid asset (`include_in_safe_to_spend = false` by default, included in total net liquidity).
3. `CREDIT_CARD` — Liability account (spending moves balance negative; paying the card is a `TRANSFER` from checking to credit card).

## 3. Core Financial & Data Integrity Rules
1. **Integer Minor Units Only:** Every monetary value is stored as an integer in minor units (cents/centavos). Floating-point math is prohibited in ledger storage.
2. **ACID Double-Entry Ledger Invariant:**
   - Every transaction writes signed postings into `ledger_entries` and updates `accounts.cached_balance_minor` inside a single `BEGIN IMMEDIATE ... COMMIT` SQLite transaction.
   - `SUM(ledger_entries.signed_amount_minor WHERE voided_at IS NULL) == accounts.cached_balance_minor` at all times.
   - Opening balances and manual reconciliation diffs are stored as `ADJUSTMENT` transactions so no account balance ever exists outside the ledger history.
3. **Immutable Audit Trail (Soft Voiding):**
   - Historical transactions are never hard-deleted. Voiding a transaction sets `voided_at` on the transaction and its `ledger_entries`, and recalculates `cached_balance_minor` atomically from the remaining non-voided ledger entries.
4. **Transaction Types:**
   - `EXPENSE`: `-amount_minor` on source account; requires `category_id` (`kind = 'EXPENSE'`); increases net category spend.
   - `REFUND`: `+amount_minor` on target account; requires `category_id` (`kind = 'EXPENSE'`); reduces net category spend in the cycle of `occurred_on`.
   - `INCOME`: `+amount_minor` on target account; requires `category_id` (`kind = 'INCOME'`); increases period income.
   - `TRANSFER`: `-amount_minor` on `account_id`, `+amount_minor` on `transfer_destination_account_id`; `category_id` MUST be `NULL`; `$0.00` impact on income or expense reports.
   - `ADJUSTMENT`: `+/- signed_amount_minor` on `account_id`; `category_id` is `NULL`; excluded from routine category spending caps.
5. **1-Tap Recurring Reminders:**
   - Stored in `recurring_rules`. Never silently auto-deducted by background jobs.
   - Tapping "Post to Ledger" atomically creates the transaction on the due date and advances `next_due_date` by one period (`MONTHLY`, `WEEKLY`, or `YEARLY`).

## 4. Five MVP Success Criteria
1. **Zero-Drift Penny Accuracy & Double-Entry Integrity:** After 100 mixed transactions (incomes, decimal expenses, refunds, transfers, voided entries), `SUM(ledger_entries)` equals `accounts.cached_balance_minor` with `0` cent drift.
2. **Transfer & Credit Card Neutrality:** Checking-to-Savings transfers and Checking-to-Credit-Card bill payments update both account balances accurately while leaving total monthly Income, Total Spent, and category budgets unchanged (`0` net report impact).
3. **10-Second Mobile Entry Benchmark:** Mobile UI defaults directly to the numeric keypad with smart defaults (`last_used_account_id` + top-used category preselected), allowing a user to enter digits and tap Save in <= 4 interactions.
4. **Refund & Month-Boundary Reconciliation:** A refund reduces net category spending (`EXPENSE - REFUND`) in the cycle it is received without inflating monthly income, and custom cycle boundaries (`budget_cycle_start_day`) isolate historical cycle totals cleanly.
5. **Multi-Tenant Data Isolation & Recovery:** User A cannot read, mutate, transfer into, or void User B's accounts, categories, or transactions, and CSV export outputs 100% of a tenant's ledger rows reconciling identically to in-app balances.
