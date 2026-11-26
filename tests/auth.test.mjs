import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLedgerDb } from '../src/ledger.mjs';
import { seedDefaultTenants } from '../src/seed.mjs';

test('registerUser normalizes email, hashes password with scrypt, and seeds 5 starter categories with 0 accounts', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.registerUser({
    email: '  Alice@Example.COM  ',
    password: 'correct-horse-battery',
    homeCurrencyCode: 'cad',
    budgetCycleStartDay: 15,
  });

  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.homeCurrencyCode, 'CAD');
  assert.equal(user.budgetCycleStartDay, 15);
  assert.equal('passwordHash' in user, false);
  assert.equal('password_hash' in user, false);

  const rawRow = ledger.db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(user.id);
  assert.equal(rawRow.email, 'alice@example.com');
  assert.ok(rawRow.password_hash, 'password_hash is stored');
  assert.notEqual(rawRow.password_hash, 'correct-horse-battery');
  const [salt, hash] = rawRow.password_hash.split(':');
  assert.equal(salt.length, 32); // 16 bytes hex
  assert.equal(hash.length, 128); // 64 bytes hex

  assert.equal(ledger.listAccounts(user.id).length, 0);

  const dash = ledger.getCycleDashboard(user.id, '2026-11-26');
  const catNames = dash.categories.map((c) => c.name).sort();
  assert.deepEqual(catNames, [
    'Bills & Subs',
    'Dining & Coffee',
    'Groceries',
    'Income / Paycheck',
    'Transport',
  ]);
});

test('registerUser rejects duplicate email case-insensitively and rejects short or non-string passwords', () => {
  const ledger = createLedgerDb(':memory:');
  ledger.registerUser({ email: 'alice@example.com', password: 'password123' });

  assert.throws(
    () => ledger.registerUser({ email: 'Alice@Example.com', password: 'password456' }),
    (err) => err.code === 'DUPLICATE_EMAIL'
  );

  for (const badPassword of ['short', '1234567', '', null, undefined, 12345678]) {
    assert.throws(
      () => ledger.registerUser({ email: 'bob@example.com', password: badPassword }),
      /at least 8 characters/i
    );
  }
});

test('authenticateUser verifies valid credentials, rejects wrong password, and returns null for legacy NULL password_hash', () => {
  const ledger = createLedgerDb(':memory:');
  ledger.registerUser({ email: 'alice@example.com', password: 'my-secret-password' });

  const authed = ledger.authenticateUser({ email: '  ALICE@example.com ', password: 'my-secret-password' });
  assert.ok(authed);
  assert.equal(authed.email, 'alice@example.com');
  assert.equal('password_hash' in authed, false);

  assert.equal(ledger.authenticateUser({ email: 'alice@example.com', password: 'wrong-password' }), null);
  assert.equal(ledger.authenticateUser({ email: 'missing@example.com', password: 'my-secret-password' }), null);

  // Legacy user created without password_hash
  ledger.createUser({ email: 'legacy@example.com' });
  assert.equal(ledger.authenticateUser({ email: 'legacy@example.com', password: 'any-password' }), null);
});

test('Session store: createSession hashes token, getSessionByToken enforces expiry, renewSessionIfNeeded slides at <15 days, deleteSessionByToken revokes', () => {
  const ledger = createLedgerDb(':memory:');
  const user = ledger.registerUser({ email: 'sess@example.com', password: 'password123' });

  const { rawToken, session } = ledger.createSession(user.id);
  assert.ok(rawToken && typeof rawToken === 'string');
  assert.equal(session.userId, user.id);

  // Raw token must never be stored in SQLite; SHA-256 hex digest is stored instead
  const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const row = ledger.db.prepare('SELECT token_hash FROM sessions WHERE id = ?').get(session.id);
  assert.equal(row.token_hash, expectedHash);
  assert.notEqual(row.token_hash, rawToken);

  const fetched = ledger.getSessionByToken(rawToken);
  assert.deepEqual(fetched, session);

  // Fresh 30-day session has >= 15 days remaining -> should not renew
  const notRenewed = ledger.renewSessionIfNeeded(session.id);
  assert.equal(notRenewed.renewed, false);
  assert.equal(notRenewed.expiresAt, session.expiresAt);

  // Session with 10 days left (< 15 days) -> should renew to ~30 days from now
  const tenDaysFromNow = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  ledger.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(tenDaysFromNow, session.id);
  const renewed = ledger.renewSessionIfNeeded(session.id);
  assert.equal(renewed.renewed, true);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(tenDaysFromNow) + 15 * 24 * 60 * 60 * 1000);

  // Delete session revokes token
  assert.equal(ledger.deleteSessionByToken(rawToken), true);
  assert.equal(ledger.deleteSessionByToken(rawToken), false);
  assert.equal(ledger.getSessionByToken(rawToken), null);

  // Expired session returns null
  const { rawToken: expiredToken } = ledger.createSession(user.id, -1000);
  assert.equal(ledger.getSessionByToken(expiredToken), null);
});

test('Additive schema migration adds password_hash and sessions to legacy database and seedDefaultTenants backfills demo passwords unless disabled', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ledger-mig-'));
  const dbPath = path.join(tmpDir, 'legacy.sqlite');

  let ledger = null;
  try {
    // Create a legacy v1 database without password_hash or sessions
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        home_currency_code TEXT NOT NULL DEFAULT 'USD',
        budget_cycle_start_day INTEGER NOT NULL DEFAULT 1,
        last_used_account_id TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO users (id, email, home_currency_code, budget_cycle_start_day, created_at)
      VALUES ('user-demo-primary', 'patrick@pocketledger.app', 'USD', 1, '2026-11-01T00:00:00.000Z');
      INSERT INTO users (id, email, home_currency_code, budget_cycle_start_day, created_at)
      VALUES ('user-demo-secondary', 'alex.isolated@pocketledger.app', 'PHP', 15, '2026-11-01T00:00:00.000Z');
    `);
    legacyDb.close();

    // Open with createLedgerDb -> should migrate cleanly
    ledger = createLedgerDb(dbPath);
    const cols = ledger.db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    assert.ok(cols.includes('password_hash'));

    // Before seed backfill, legacy user cannot log in
    assert.equal(ledger.authenticateUser({ email: 'patrick@pocketledger.app', password: 'pocketledger-demo' }), null);

    // seedDefaultTenants with disableDemo: true does not backfill
    seedDefaultTenants(ledger, { disableDemo: true });
    assert.equal(ledger.authenticateUser({ email: 'patrick@pocketledger.app', password: 'pocketledger-demo' }), null);

    // seedDefaultTenants with default (disableDemo: false) backfills both demo accounts
    seedDefaultTenants(ledger, { disableDemo: false });
    const patrick = ledger.authenticateUser({ email: 'patrick@pocketledger.app', password: 'pocketledger-demo' });
    const alex = ledger.authenticateUser({ email: 'alex.isolated@pocketledger.app', password: 'pocketledger-demo' });
    assert.ok(patrick);
    assert.equal(patrick.id, 'user-demo-primary');
    assert.ok(alex);
    assert.equal(alex.id, 'user-demo-secondary');
  } finally {
    if (ledger) ledger.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('seedDefaultTenants skips demo seeding when disableDemo is true on a fresh database', () => {
  const ledger = createLedgerDb(':memory:');
  const res = seedDefaultTenants(ledger, { disableDemo: true });
  assert.equal(res.demoUserId, null);
  assert.equal(ledger.getUser('user-demo-primary'), null);
  assert.equal(ledger.getUser('user-demo-secondary'), null);
});
