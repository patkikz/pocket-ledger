import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresLedger } from '../src/ledger-pg.mjs';

function createMockPgPool(queryHandler) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql: sql.trim(), params });
      if (queryHandler) {
        return queryHandler(sql.trim(), params);
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    queries,
    async query(sql, params = []) {
      return client.query(sql, params);
    },
    async connect() {
      return client;
    },
    async end() {},
  };
}

test('createPostgresLedger.init creates all 7 tables with BIGINT minor units and healthCheck runs SELECT 1', async () => {
  const pool = createMockPgPool((sql) => {
    if (sql.startsWith('SELECT 1')) return { rows: [{ ok: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const ledger = createPostgresLedger('postgres://user:pass@localhost:5432/postgres', { pool });
  assert.equal(ledger.isAsync, true);

  await ledger.init();
  const ddl = pool.queries.map((q) => q.sql).join('\n');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS users/i);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS sessions/i);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS accounts/i);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS categories/i);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS recurring_rules/i);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS transactions/i);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS ledger_entries/i);
  assert.match(ddl, /cached_balance_minor BIGINT/i);

  const ok = await ledger.healthCheck();
  assert.equal(ok, true);
});

test('createPostgresLedger.recordTransaction uses ACID BEGIN/COMMIT and $1..$n placeholders', async () => {
  const pool = createMockPgPool((sql, params) => {
    if (sql.startsWith('SELECT * FROM accounts WHERE id = $1 AND user_id = $2')) {
      return {
        rows: [{
          id: params[0],
          user_id: params[1],
          name: 'Checking',
          type: 'CASH_CHECKING',
          include_in_safe_to_spend: true,
          cached_balance_minor: '100000',
          is_archived: false,
          created_at: '2026-11-27T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('SELECT * FROM categories WHERE id = $1 AND user_id = $2')) {
      return {
        rows: [{
          id: params[0],
          user_id: params[1],
          name: 'Groceries',
          kind: 'EXPENSE',
          monthly_cap_minor: '50000',
          icon: 'tag',
          color: '#10b981',
          usage_count: 1,
          created_at: '2026-11-27T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('COALESCE(SUM(signed_amount_minor), 0) AS total_minor')) {
      return { rows: [{ total_minor: '98500' }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT t.*,')) {
      return {
        rows: [{
          id: params[0],
          user_id: params[1],
          type: 'EXPENSE',
          amount_minor: '1500',
          account_id: 'acc-1',
          account_name: 'Checking',
          transfer_destination_account_id: null,
          transfer_destination_account_name: null,
          category_id: 'cat-1',
          category_name: 'Groceries',
          category_icon: 'tag',
          category_color: '#10b981',
          occurred_on: '2026-11-27',
          note: 'Milk',
          recurring_rule_id: null,
          created_at: '2026-11-27T00:00:00.000Z',
          updated_at: '2026-11-27T00:00:00.000Z',
          voided_at: null,
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const ledger = createPostgresLedger('postgres://user:pass@localhost:5432/postgres', { pool });
  const tx = await ledger.recordTransaction('user-1', {
    type: 'EXPENSE',
    amountMinor: 1500,
    accountId: 'acc-1',
    categoryId: 'cat-1',
    occurredOn: '2026-11-27',
    note: 'Milk',
  });

  assert.equal(tx.amountMinor, 1500);
  const sqlList = pool.queries.map((q) => q.sql);
  assert.ok(sqlList.includes('BEGIN'), 'Starts ACID transaction');
  assert.ok(sqlList.includes('COMMIT'), 'Commits ACID transaction');
  assert.ok(sqlList.some((s) => s.includes('INSERT INTO ledger_entries') && s.includes('$1')), 'Uses parameterized Postgres INSERT');
});
