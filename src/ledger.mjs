import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VALID_ACCOUNT_TYPES = new Set(['CASH_CHECKING', 'SAVINGS', 'CREDIT_CARD']);
const VALID_CATEGORY_KINDS = new Set(['EXPENSE', 'INCOME']);
const VALID_TX_TYPES = new Set(['EXPENSE', 'REFUND', 'INCOME', 'TRANSFER', 'ADJUSTMENT']);
const VALID_FREQUENCIES = new Set(['MONTHLY', 'WEEKLY', 'YEARLY']);
export const DEMO_EMAILS = new Set(['patrick@pocketledger.app', 'alex.isolated@pocketledger.app']);
export const VALID_AVATAR_COLORS = new Set(['#6366f1', '#10b981', '#f59e0b', '#f43f5e', '#38bdf8', '#a855f7']);
export const VALID_THEMES = new Set(['system', 'dark', 'light']);
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STARTER_CATEGORIES = [
  { name: 'Groceries', kind: 'EXPENSE', monthlyCapMinor: 50000, icon: 'shopping-bag', color: '#10b981' },
  { name: 'Dining & Coffee', kind: 'EXPENSE', monthlyCapMinor: 30000, icon: 'utensils', color: '#f59e0b' },
  { name: 'Transport', kind: 'EXPENSE', monthlyCapMinor: 20000, icon: 'car', color: '#3b82f6' },
  { name: 'Bills & Subs', kind: 'EXPENSE', monthlyCapMinor: 100000, icon: 'zap', color: '#8b5cf6' },
  { name: 'Income / Paycheck', kind: 'INCOME', monthlyCapMinor: null, icon: 'briefcase', color: '#14b8a6' },
];

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    const err = new TypeError('Password must be at least 8 characters long');
    err.code = 'INVALID_PASSWORD';
    err.statusCode = 400;
    throw err;
  }
  return hashSecret(password);
}

export function hashPin(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    const err = new RangeError('PIN must be exactly 4 digits');
    err.statusCode = 400;
    throw err;
  }
  return hashSecret(pin);
}

export function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string') {
    return false;
  }
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (expectedBuf.length !== 64) {
    return false;
  }
  const actualBuf = crypto.scryptSync(password, salt, 64);
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function hashSessionToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function assertPositiveIntegerMinor(val, label = 'amountMinor') {
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
    throw new TypeError(`${label} must be a positive safe integer in integer minor units (got ${val})`);
  }
}

function assertSignedIntegerMinor(val, label = 'amountMinor') {
  if (typeof val !== 'number' || !Number.isSafeInteger(val)) {
    throw new TypeError(`${label} must be a signed safe integer in integer minor units (got ${val})`);
  }
}

export function createLedgerDb(dbPath = ':memory:') {
  if (dbPath && dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      avatar_color TEXT NOT NULL DEFAULT '#6366f1',
      theme TEXT NOT NULL DEFAULT 'system',
      default_account_id TEXT,
      home_currency_code TEXT NOT NULL DEFAULT 'USD',
      budget_cycle_start_day INTEGER NOT NULL DEFAULT 1 CHECK (budget_cycle_start_day BETWEEN 1 AND 28),
      last_used_account_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('CASH_CHECKING', 'SAVINGS', 'CREDIT_CARD')),
      include_in_safe_to_spend INTEGER NOT NULL DEFAULT 1,
      cached_balance_minor INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('EXPENSE', 'INCOME')),
      monthly_cap_minor INTEGER,
      icon TEXT NOT NULL DEFAULT 'tag',
      color TEXT NOT NULL DEFAULT '#6366f1',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('EXPENSE', 'INCOME', 'TRANSFER')),
      default_amount_minor INTEGER NOT NULL CHECK (default_amount_minor > 0),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      transfer_destination_account_id TEXT REFERENCES accounts(id),
      category_id TEXT REFERENCES categories(id),
      frequency TEXT NOT NULL CHECK (frequency IN ('MONTHLY', 'WEEKLY', 'YEARLY')),
      next_due_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK (type IN ('EXPENSE', 'REFUND', 'INCOME', 'TRANSFER', 'ADJUSTMENT')),
      amount_minor INTEGER NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      transfer_destination_account_id TEXT REFERENCES accounts(id),
      category_id TEXT REFERENCES categories(id),
      occurred_on TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      recurring_rule_id TEXT REFERENCES recurring_rules(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      voided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      transaction_id TEXT NOT NULL REFERENCES transactions(id),
      account_id TEXT NOT NULL REFERENCES accounts(id),
      signed_amount_minor INTEGER NOT NULL,
      occurred_on TEXT NOT NULL,
      created_at TEXT NOT NULL,
      voided_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, occurred_on);
    CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(user_id, account_id, voided_at);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);

  const userColumns = db.prepare(`PRAGMA table_info(users)`).all();
  if (!userColumns.some((col) => col.name === 'password_hash')) {
    db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  }
  if (!userColumns.some((col) => col.name === 'display_name')) {
    db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
  }
  if (!userColumns.some((col) => col.name === 'avatar_color')) {
    db.exec(`ALTER TABLE users ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#6366f1'`);
  }
  if (!userColumns.some((col) => col.name === 'theme')) {
    db.exec(`ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'`);
  }
  if (!userColumns.some((col) => col.name === 'default_account_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN default_account_id TEXT`);
  }
  if (!userColumns.some((col) => col.name === 'pin_hash')) {
    db.exec(`ALTER TABLE users ADD COLUMN pin_hash TEXT`);
  }

  let txDepth = 0;
  function runInTransaction(fn) {
    const spName = `sp_${txDepth}`;
    if (txDepth === 0) {
      db.exec('BEGIN IMMEDIATE');
    } else {
      db.exec(`SAVEPOINT ${spName}`);
    }
    txDepth += 1;
    try {
      const result = fn();
      txDepth -= 1;
      if (txDepth === 0) {
        db.exec('COMMIT');
      } else {
        db.exec(`RELEASE SAVEPOINT ${spName}`);
      }
      return result;
    } catch (err) {
      txDepth -= 1;
      try {
        if (txDepth === 0) {
          db.exec('ROLLBACK');
        } else {
          db.exec(`ROLLBACK TO SAVEPOINT ${spName}; RELEASE SAVEPOINT ${spName}`);
        }
      } catch {
        // ignore rollback error if already rolled back
      }
      throw err;
    }
  }

  function recalculateAccountBalance(userId, accountId) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(signed_amount_minor), 0) AS total_minor
      FROM ledger_entries
      WHERE user_id = ? AND account_id = ? AND voided_at IS NULL
    `).get(userId, accountId);

    const totalMinor = Number(row?.total_minor ?? 0);
    db.prepare(`
      UPDATE accounts
      SET cached_balance_minor = ?
      WHERE id = ? AND user_id = ?
    `).run(totalMinor, accountId, userId);

    return totalMinor;
  }

  function requireOwnedAccount(userId, accountId, label = 'Account') {
    const acc = db.prepare(`SELECT * FROM accounts WHERE id = ? AND user_id = ?`).get(accountId, userId);
    if (!acc) {
      throw new Error(`${label} not found or access denied for tenant ${userId}`);
    }
    return acc;
  }

  function requireOwnedCategory(userId, categoryId) {
    const cat = db.prepare(`SELECT * FROM categories WHERE id = ? AND user_id = ?`).get(categoryId, userId);
    if (!cat) {
      throw new Error(`Category not found or access denied for tenant ${userId}`);
    }
    return cat;
  }

  function createUser({ id = crypto.randomUUID(), email, homeCurrencyCode = 'USD', budgetCycleStartDay = 1 }) {
    if (!email || typeof email !== 'string') {
      throw new TypeError('Valid user email is required');
    }
    if (!Number.isInteger(budgetCycleStartDay) || budgetCycleStartDay < 1 || budgetCycleStartDay > 28) {
      throw new RangeError('budgetCycleStartDay must be an integer between 1 and 28');
    }
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, email, home_currency_code, budget_cycle_start_day, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, email.trim(), homeCurrencyCode.toUpperCase(), budgetCycleStartDay, now);

    return getUser(id);
  }

  function registerUser({ email, password, homeCurrencyCode = 'USD', budgetCycleStartDay = 1 } = {}) {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      const err = new TypeError('Valid user email is required');
      err.code = 'INVALID_EMAIL';
      err.statusCode = 400;
      throw err;
    }
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = hashPassword(password);

    if (typeof homeCurrencyCode !== 'string' || !homeCurrencyCode.trim()) {
      throw new TypeError('Valid homeCurrencyCode is required');
    }
    const cycleDay = Number(budgetCycleStartDay);
    if (!Number.isInteger(cycleDay) || cycleDay < 1 || cycleDay > 28) {
      throw new RangeError('budgetCycleStartDay must be an integer between 1 and 28');
    }

    return runInTransaction(() => {
      const existing = db.prepare(`SELECT id FROM users WHERE LOWER(email) = ?`).get(normalizedEmail);
      if (existing) {
        const err = new Error('An account with this email already exists');
        err.code = 'DUPLICATE_EMAIL';
        err.statusCode = 409;
        throw err;
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO users (id, email, password_hash, home_currency_code, budget_cycle_start_day, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, normalizedEmail, passwordHash, homeCurrencyCode.trim().toUpperCase(), cycleDay, now);

      for (const cat of STARTER_CATEGORIES) {
        createCategory(id, cat);
      }

      return getUser(id);
    });
  }

  function authenticateUser({ email, password } = {}) {
    if (typeof email !== 'string' || typeof password !== 'string') {
      return null;
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      return null;
    }
    const row = db.prepare(`SELECT id, password_hash FROM users WHERE LOWER(email) = ?`).get(normalizedEmail);
    if (!row || !row.password_hash) {
      return null;
    }
    if (!verifyPassword(password, row.password_hash)) {
      return null;
    }
    return getUser(row.id);
  }

  function createSession(userId, ttlMs = DEFAULT_SESSION_TTL_MS) {
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
      throw new TypeError('ttlMs must be a finite number');
    }
    const user = getUser(userId);
    if (!user) {
      throw new Error('User not found');
    }
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(rawToken);
    const id = crypto.randomUUID();
    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();

    db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, tokenHash, expiresAt, createdAt);

    return {
      rawToken,
      session: { id, userId, expiresAt, createdAt },
    };
  }

  function getSessionByToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      return null;
    }
    const tokenHash = hashSessionToken(rawToken);
    const row = db.prepare(`
      SELECT id, user_id, expires_at, created_at
      FROM sessions
      WHERE token_hash = ?
    `).get(tokenHash);
    if (!row) {
      return null;
    }
    const expiresMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(row.id);
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  function renewSessionIfNeeded(sessionId, ttlMs = DEFAULT_SESSION_TTL_MS) {
    if (!sessionId || typeof sessionId !== 'string') {
      return null;
    }
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive finite number');
    }
    const row = db.prepare(`SELECT id, expires_at FROM sessions WHERE id = ?`).get(sessionId);
    if (!row) {
      return null;
    }
    const nowMs = Date.now();
    const expiresMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(row.id);
      return null;
    }
    if (expiresMs - nowMs < ttlMs / 2) {
      const nextExpiresAt = new Date(nowMs + ttlMs).toISOString();
      db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(nextExpiresAt, row.id);
      return { renewed: true, expiresAt: nextExpiresAt };
    }
    return { renewed: false, expiresAt: row.expires_at };
  }

  function deleteSessionByToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      return false;
    }
    const tokenHash = hashSessionToken(rawToken);
    const result = db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return Number(result.changes) > 0;
  }

  function getUser(userId) {
    const u = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
    if (!u) return null;
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name ?? null,
      avatarColor: u.avatar_color || '#6366f1',
      theme: u.theme || 'system',
      defaultAccountId: u.default_account_id ?? null,
      homeCurrencyCode: u.home_currency_code,
      budgetCycleStartDay: Number(u.budget_cycle_start_day),
      lastUsedAccountId: u.last_used_account_id,
      hasPin: Boolean(u.pin_hash),
      createdAt: u.created_at,
    };
  }

  function updateUserProfile(userId, {
    displayName,
    avatarColor,
    theme,
    defaultAccountId,
    homeCurrencyCode,
    budgetCycleStartDay,
  } = {}) {
    const user = getUser(userId);
    if (!user) throw new Error('User not found');

    let nextDisplayName = user.displayName;
    if (displayName !== undefined) {
      if (displayName === null) {
        nextDisplayName = null;
      } else {
        if (typeof displayName !== 'string') {
          throw new TypeError('displayName must be a string');
        }
        const trimmed = displayName.trim();
        if (trimmed.length > 60) {
          throw new RangeError('displayName must be 60 characters or fewer');
        }
        nextDisplayName = trimmed.length > 0 ? trimmed : null;
      }
    }

    let nextAvatarColor = user.avatarColor;
    if (avatarColor !== undefined) {
      if (typeof avatarColor !== 'string' || !VALID_AVATAR_COLORS.has(avatarColor.toLowerCase())) {
        throw new RangeError('Invalid avatarColor');
      }
      nextAvatarColor = avatarColor.toLowerCase();
    }

    let nextTheme = user.theme;
    if (theme !== undefined) {
      if (typeof theme !== 'string' || !VALID_THEMES.has(theme)) {
        throw new RangeError('theme must be system, dark, or light');
      }
      nextTheme = theme;
    }

    let nextDefaultAccountId = user.defaultAccountId;
    if (defaultAccountId !== undefined) {
      if (defaultAccountId === null || defaultAccountId === '') {
        nextDefaultAccountId = null;
      } else {
        const acc = requireOwnedAccount(userId, defaultAccountId, 'Default account');
        if (acc.is_archived) {
          throw new RangeError('Default account cannot be archived');
        }
        nextDefaultAccountId = acc.id;
      }
    }

    const nextCurrency = homeCurrencyCode ? homeCurrencyCode.toUpperCase() : user.homeCurrencyCode;
    const nextStartDay = budgetCycleStartDay !== undefined ? Number(budgetCycleStartDay) : user.budgetCycleStartDay;
    if (!Number.isInteger(nextStartDay) || nextStartDay < 1 || nextStartDay > 28) {
      throw new RangeError('budgetCycleStartDay must be an integer between 1 and 28');
    }

    db.prepare(`
      UPDATE users
      SET display_name = ?, avatar_color = ?, theme = ?, default_account_id = ?,
          home_currency_code = ?, budget_cycle_start_day = ?
      WHERE id = ?
    `).run(
      nextDisplayName,
      nextAvatarColor,
      nextTheme,
      nextDefaultAccountId,
      nextCurrency,
      nextStartDay,
      userId
    );
    return getUser(userId);
  }

  function updateUserSettings(userId, { homeCurrencyCode, budgetCycleStartDay }) {
    return updateUserProfile(userId, { homeCurrencyCode, budgetCycleStartDay });
  }

  function changePassword(userId, { currentPassword, newPassword, currentSessionToken = null } = {}) {
    const row = db.prepare(`SELECT id, email, password_hash FROM users WHERE id = ?`).get(userId);
    if (!row) throw new Error('User not found');
    if (DEMO_EMAILS.has(String(row.email).toLowerCase())) {
      const err = new Error('Demo accounts cannot change password');
      err.statusCode = 403;
      throw err;
    }
    if (!row.password_hash || !verifyPassword(currentPassword, row.password_hash)) {
      const err = new Error('Current password is incorrect');
      err.statusCode = 400;
      throw err;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      throw new RangeError('New password must be at least 8 characters long');
    }
    const nextHash = hashPassword(newPassword);
    runInTransaction(() => {
      db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(nextHash, userId);
      if (currentSessionToken && typeof currentSessionToken === 'string') {
        const currentHash = hashSessionToken(currentSessionToken);
        db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`).run(userId, currentHash);
      } else {
        db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
      }
    });
    return true;
  }

  function setPin(userId, pin) {
    const row = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(userId);
    if (!row) throw new Error('User not found');
    if (DEMO_EMAILS.has(String(row.email).toLowerCase())) {
      const err = new Error('Demo accounts cannot set a PIN');
      err.statusCode = 403;
      throw err;
    }
    const nextHash = hashPin(pin);
    db.prepare(`UPDATE users SET pin_hash = ? WHERE id = ?`).run(nextHash, userId);
    return getUser(userId);
  }

  function removePin(userId) {
    const row = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(userId);
    if (!row) throw new Error('User not found');
    if (DEMO_EMAILS.has(String(row.email).toLowerCase())) {
      const err = new Error('Demo accounts cannot modify PIN settings');
      err.statusCode = 403;
      throw err;
    }
    db.prepare(`UPDATE users SET pin_hash = NULL WHERE id = ?`).run(userId);
    return getUser(userId);
  }

  function verifyPin(userId, pin) {
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return false;
    }
    const row = db.prepare(`SELECT pin_hash FROM users WHERE id = ?`).get(userId);
    if (!row || !row.pin_hash) {
      return false;
    }
    return verifyPassword(pin, row.pin_hash);
  }

  function createAccount(userId, {
    id = crypto.randomUUID(),
    name,
    type,
    initialBalanceMinor = 0,
    includeInSafeToSpend,
    occurredOn = new Date().toISOString().slice(0, 10),
  }) {
    if (!VALID_ACCOUNT_TYPES.has(type)) {
      throw new TypeError(`Invalid account type: ${type}`);
    }
    assertSignedIntegerMinor(initialBalanceMinor, 'initialBalanceMinor');

    const defaultSafeToSpend = includeInSafeToSpend !== undefined
      ? Boolean(includeInSafeToSpend)
      : type === 'CASH_CHECKING';

    return runInTransaction(() => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO accounts (id, user_id, name, type, include_in_safe_to_spend, cached_balance_minor, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(id, userId, name.trim(), type, defaultSafeToSpend ? 1 : 0, now);

      // Set last_used_account_id if user doesn't have one yet
      const user = getUser(userId);
      if (user && !user.lastUsedAccountId) {
        db.prepare(`UPDATE users SET last_used_account_id = ? WHERE id = ?`).run(id, userId);
      }

      if (initialBalanceMinor !== 0) {
        const txId = crypto.randomUUID();
        const entryId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO transactions (
            id, user_id, type, amount_minor, account_id, transfer_destination_account_id,
            category_id, occurred_on, note, created_at, updated_at
          ) VALUES (?, ?, 'ADJUSTMENT', ?, ?, NULL, NULL, ?, 'Opening Balance', ?, ?)
        `).run(txId, userId, initialBalanceMinor, id, occurredOn, now, now);

        db.prepare(`
          INSERT INTO ledger_entries (
            id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(entryId, userId, txId, id, initialBalanceMinor, occurredOn, now);

        recalculateAccountBalance(userId, id);
      }

      return getAccount(userId, id);
    });
  }

  function getAccount(userId, accountId) {
    const row = requireOwnedAccount(userId, accountId);
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      type: row.type,
      includeInSafeToSpend: Boolean(row.include_in_safe_to_spend),
      cachedBalanceMinor: Number(row.cached_balance_minor),
      isArchived: Boolean(row.is_archived),
      createdAt: row.created_at,
    };
  }

  function listAccounts(userId) {
    const rows = db.prepare(`
      SELECT * FROM accounts WHERE user_id = ? AND is_archived = 0 ORDER BY created_at ASC
    `).all(userId);
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      type: row.type,
      includeInSafeToSpend: Boolean(row.include_in_safe_to_spend),
      cachedBalanceMinor: Number(row.cached_balance_minor),
      isArchived: Boolean(row.is_archived),
      createdAt: row.created_at,
    }));
  }

  function updateAccount(userId, accountId, { name, includeInSafeToSpend, isArchived } = {}) {
    const acc = getAccount(userId, accountId);
    const nextName = name !== undefined ? String(name).trim() : acc.name;
    if (!nextName) {
      throw new TypeError('Account name cannot be empty');
    }
    const nextSafe = includeInSafeToSpend !== undefined ? Boolean(includeInSafeToSpend) : acc.includeInSafeToSpend;
    const nextArchived = isArchived !== undefined ? Boolean(isArchived) : acc.isArchived;

    db.prepare(`
      UPDATE accounts
      SET name = ?, include_in_safe_to_spend = ?, is_archived = ?
      WHERE id = ? AND user_id = ?
    `).run(nextName, nextSafe ? 1 : 0, nextArchived ? 1 : 0, accountId, userId);

    return getAccount(userId, accountId);
  }

  function createCategory(userId, {
    id = crypto.randomUUID(),
    name,
    kind,
    monthlyCapMinor = null,
    icon = 'tag',
    color = '#6366f1',
  }) {
    if (!VALID_CATEGORY_KINDS.has(kind)) {
      throw new TypeError(`Invalid category kind: ${kind}`);
    }
    if (monthlyCapMinor !== null && monthlyCapMinor !== undefined) {
      assertPositiveIntegerMinor(monthlyCapMinor, 'monthlyCapMinor');
    }
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO categories (id, user_id, name, kind, monthly_cap_minor, icon, color, usage_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, userId, name.trim(), kind, monthlyCapMinor ?? null, icon, color, now);

    return getCategory(userId, id);
  }

  function getCategory(userId, categoryId) {
    const row = requireOwnedCategory(userId, categoryId);
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      kind: row.kind,
      monthlyCapMinor: row.monthly_cap_minor !== null ? Number(row.monthly_cap_minor) : null,
      icon: row.icon,
      color: row.color,
      usageCount: Number(row.usage_count),
      createdAt: row.created_at,
    };
  }

  function updateCategoryCap(userId, categoryId, monthlyCapMinor) {
    requireOwnedCategory(userId, categoryId);
    if (monthlyCapMinor !== null) {
      assertPositiveIntegerMinor(monthlyCapMinor, 'monthlyCapMinor');
    }
    db.prepare(`
      UPDATE categories SET monthly_cap_minor = ? WHERE id = ? AND user_id = ?
    `).run(monthlyCapMinor, categoryId, userId);
    return getCategory(userId, categoryId);
  }

  function updateCategory(userId, categoryId, { name, monthlyCapMinor } = {}) {
    const cat = getCategory(userId, categoryId);
    const nextName = name !== undefined ? String(name).trim() : cat.name;
    if (!nextName) {
      throw new TypeError('Category name cannot be empty');
    }
    let nextCap = cat.monthlyCapMinor;
    if (monthlyCapMinor !== undefined) {
      if (monthlyCapMinor !== null) {
        assertPositiveIntegerMinor(monthlyCapMinor, 'monthlyCapMinor');
      }
      nextCap = cat.kind === 'INCOME' ? null : monthlyCapMinor;
    }
    db.prepare(`
      UPDATE categories SET name = ?, monthly_cap_minor = ? WHERE id = ? AND user_id = ?
    `).run(nextName, nextCap, categoryId, userId);
    return getCategory(userId, categoryId);
  }

  function recordTransaction(userId, {
    id = crypto.randomUUID(),
    type,
    amountMinor,
    accountId,
    transferDestinationAccountId = null,
    categoryId = null,
    occurredOn = new Date().toISOString().slice(0, 10),
    note = '',
    recurringRuleId = null,
  }) {
    if (!VALID_TX_TYPES.has(type)) {
      throw new TypeError(`Invalid transaction type: ${type}`);
    }

    if (type === 'ADJUSTMENT') {
      assertSignedIntegerMinor(amountMinor, 'amountMinor');
      if (amountMinor === 0) {
        throw new RangeError('Adjustment amountMinor cannot be 0 in integer minor units');
      }
    } else {
      assertPositiveIntegerMinor(amountMinor, 'amountMinor');
    }

    return runInTransaction(() => {
      requireOwnedAccount(userId, accountId, 'Source account');
      const now = new Date().toISOString();

      if (type === 'TRANSFER') {
        if (!transferDestinationAccountId) {
          throw new Error('TRANSFER requires transferDestinationAccountId');
        }
        if (transferDestinationAccountId === accountId) {
          throw new Error('TRANSFER source and destination accounts must be different');
        }
        if (categoryId !== null && categoryId !== undefined) {
          throw new Error('TRANSFER must not carry a categoryId');
        }
        requireOwnedAccount(userId, transferDestinationAccountId, 'Destination account');
      } else if (type === 'EXPENSE' || type === 'REFUND') {
        if (!categoryId) {
          throw new Error(`${type} requires a categoryId`);
        }
        const cat = requireOwnedCategory(userId, categoryId);
        if (cat.kind !== 'EXPENSE') {
          throw new Error(`${type} must use an EXPENSE category (got ${cat.kind})`);
        }
      } else if (type === 'INCOME') {
        if (!categoryId) {
          throw new Error('INCOME requires a categoryId');
        }
        const cat = requireOwnedCategory(userId, categoryId);
        if (cat.kind !== 'INCOME') {
          throw new Error(`INCOME must use an INCOME category (got ${cat.kind})`);
        }
      }

      db.prepare(`
        INSERT INTO transactions (
          id, user_id, type, amount_minor, account_id, transfer_destination_account_id,
          category_id, occurred_on, note, recurring_rule_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        userId,
        type,
        amountMinor,
        accountId,
        type === 'TRANSFER' ? transferDestinationAccountId : null,
        type === 'TRANSFER' || type === 'ADJUSTMENT' ? null : categoryId,
        occurredOn,
        note ?? '',
        recurringRuleId ?? null,
        now,
        now
      );

      // Write double-entry signed postings into ledger_entries
      if (type === 'EXPENSE') {
        db.prepare(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), userId, id, accountId, -amountMinor, occurredOn, now);
        recalculateAccountBalance(userId, accountId);
      } else if (type === 'REFUND' || type === 'INCOME') {
        db.prepare(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), userId, id, accountId, amountMinor, occurredOn, now);
        recalculateAccountBalance(userId, accountId);
      } else if (type === 'ADJUSTMENT') {
        db.prepare(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), userId, id, accountId, amountMinor, occurredOn, now);
        recalculateAccountBalance(userId, accountId);
      } else if (type === 'TRANSFER') {
        // Outflow from source account
        db.prepare(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), userId, id, accountId, -amountMinor, occurredOn, now);
        // Inflow to destination account
        db.prepare(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), userId, id, transferDestinationAccountId, amountMinor, occurredOn, now);

        recalculateAccountBalance(userId, accountId);
        recalculateAccountBalance(userId, transferDestinationAccountId);
      }

      // Smart defaults: update user's last_used_account_id & category usage_count
      db.prepare(`UPDATE users SET last_used_account_id = ? WHERE id = ?`).run(accountId, userId);
      if (categoryId) {
        db.prepare(`
          UPDATE categories SET usage_count = usage_count + 1 WHERE id = ? AND user_id = ?
        `).run(categoryId, userId);
      }

      return getTransaction(userId, id);
    });
  }

  function getTransaction(userId, transactionId) {
    const row = db.prepare(`
      SELECT t.*,
             a.name AS account_name,
             da.name AS transfer_destination_account_name,
             c.name AS category_name,
             c.icon AS category_icon,
             c.color AS category_color
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts da ON da.id = t.transfer_destination_account_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.id = ? AND t.user_id = ?
    `).get(transactionId, userId);

    if (!row) {
      throw new Error(`Transaction not found or access denied for tenant ${userId}`);
    }
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      amountMinor: Number(row.amount_minor),
      accountId: row.account_id,
      accountName: row.account_name,
      transferDestinationAccountId: row.transfer_destination_account_id,
      transferDestinationAccountName: row.transfer_destination_account_name,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      categoryColor: row.category_color,
      occurredOn: row.occurred_on,
      note: row.note,
      recurringRuleId: row.recurring_rule_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      voidedAt: row.voided_at,
    };
  }

  function voidTransaction(userId, transactionId) {
    return runInTransaction(() => {
      const tx = getTransaction(userId, transactionId);
      if (tx.voidedAt) {
        return tx;
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE transactions SET voided_at = ?, updated_at = ? WHERE id = ? AND user_id = ?
      `).run(now, now, transactionId, userId);

      db.prepare(`
        UPDATE ledger_entries SET voided_at = ? WHERE transaction_id = ? AND user_id = ?
      `).run(now, transactionId, userId);

      recalculateAccountBalance(userId, tx.accountId);
      if (tx.transferDestinationAccountId) {
        recalculateAccountBalance(userId, tx.transferDestinationAccountId);
      }

      return getTransaction(userId, transactionId);
    });
  }

  function updateTransaction(userId, transactionId, { amountMinor, categoryId, occurredOn, note } = {}) {
    return runInTransaction(() => {
      const tx = getTransaction(userId, transactionId);
      if (tx.voidedAt) {
        throw new Error('Cannot edit a voided transaction');
      }
      if (tx.type === 'ADJUSTMENT') {
        throw new Error('Cannot edit a balance adjustment transaction');
      }

      const nextAmount = amountMinor !== undefined ? amountMinor : tx.amountMinor;
      assertPositiveIntegerMinor(nextAmount, 'amountMinor');

      let nextCategoryId = tx.categoryId;
      if (categoryId !== undefined) {
        if (tx.type === 'TRANSFER') {
          if (categoryId !== null) {
            throw new Error('TRANSFER must not carry a categoryId');
          }
          nextCategoryId = null;
        } else {
          if (!categoryId) {
            throw new Error(`${tx.type} requires a categoryId`);
          }
          const cat = requireOwnedCategory(userId, categoryId);
          const expectedKind = tx.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
          if (cat.kind !== expectedKind) {
            throw new Error(`${tx.type} must use a ${expectedKind} category (got ${cat.kind})`);
          }
          nextCategoryId = categoryId;
        }
      }

      const nextOccurredOn = occurredOn !== undefined ? String(occurredOn) : tx.occurredOn;
      const nextNote = note !== undefined ? String(note) : tx.note;
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE transactions
        SET amount_minor = ?, category_id = ?, occurred_on = ?, note = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(nextAmount, nextCategoryId, nextOccurredOn, nextNote, now, transactionId, userId);

      if (tx.type === 'EXPENSE') {
        db.prepare(`
          UPDATE ledger_entries SET signed_amount_minor = ?, occurred_on = ?
          WHERE transaction_id = ? AND user_id = ? AND account_id = ? AND voided_at IS NULL
        `).run(-nextAmount, nextOccurredOn, transactionId, userId, tx.accountId);
        recalculateAccountBalance(userId, tx.accountId);
      } else if (tx.type === 'REFUND' || tx.type === 'INCOME') {
        db.prepare(`
          UPDATE ledger_entries SET signed_amount_minor = ?, occurred_on = ?
          WHERE transaction_id = ? AND user_id = ? AND account_id = ? AND voided_at IS NULL
        `).run(nextAmount, nextOccurredOn, transactionId, userId, tx.accountId);
        recalculateAccountBalance(userId, tx.accountId);
      } else if (tx.type === 'TRANSFER') {
        db.prepare(`
          UPDATE ledger_entries SET signed_amount_minor = ?, occurred_on = ?
          WHERE transaction_id = ? AND user_id = ? AND account_id = ? AND voided_at IS NULL
        `).run(-nextAmount, nextOccurredOn, transactionId, userId, tx.accountId);
        db.prepare(`
          UPDATE ledger_entries SET signed_amount_minor = ?, occurred_on = ?
          WHERE transaction_id = ? AND user_id = ? AND account_id = ? AND voided_at IS NULL
        `).run(nextAmount, nextOccurredOn, transactionId, userId, tx.transferDestinationAccountId);
        recalculateAccountBalance(userId, tx.accountId);
        recalculateAccountBalance(userId, tx.transferDestinationAccountId);
      }

      return getTransaction(userId, transactionId);
    });
  }

  function reconcileAccountBalance(userId, accountId, actualBalanceMinor, occurredOn = new Date().toISOString().slice(0, 10), note = 'Balance Reconciliation') {
    assertSignedIntegerMinor(actualBalanceMinor, 'actualBalanceMinor');
    return runInTransaction(() => {
      const acc = getAccount(userId, accountId);
      const deltaMinor = actualBalanceMinor - acc.cachedBalanceMinor;
      if (deltaMinor === 0) {
        return { adjusted: false, deltaMinor: 0, account: acc, transaction: null };
      }
      const tx = recordTransaction(userId, {
        type: 'ADJUSTMENT',
        amountMinor: deltaMinor,
        accountId,
        occurredOn,
        note,
      });
      return {
        adjusted: true,
        deltaMinor,
        account: getAccount(userId, accountId),
        transaction: tx,
      };
    });
  }

  function verifyAccountIntegrity(userId, accountId) {
    const acc = getAccount(userId, accountId);
    const row = db.prepare(`
      SELECT COALESCE(SUM(signed_amount_minor), 0) AS ledger_sum
      FROM ledger_entries
      WHERE user_id = ? AND account_id = ? AND voided_at IS NULL
    `).get(userId, accountId);

    const ledgerSumMinor = Number(row?.ledger_sum ?? 0);
    return {
      accountId: acc.id,
      cachedBalanceMinor: acc.cachedBalanceMinor,
      ledgerSumMinor,
      driftMinor: acc.cachedBalanceMinor - ledgerSumMinor,
      isValid: acc.cachedBalanceMinor === ledgerSumMinor,
    };
  }

  function formatYmd(year, monthIndex0, day) {
    const d = new Date(Date.UTC(year, monthIndex0, day));
    return d.toISOString().slice(0, 10);
  }

  function getBudgetCycleWindow(referenceDateStr, budgetCycleStartDay = 1) {
    const [y, m, d] = referenceDateStr.split('-').map(Number);
    const monthIdx = m - 1;
    let startYear = y;
    let startMonthIdx = monthIdx;

    if (d < budgetCycleStartDay) {
      startMonthIdx -= 1;
      if (startMonthIdx < 0) {
        startMonthIdx = 11;
        startYear -= 1;
      }
    }

    const cycleStart = formatYmd(startYear, startMonthIdx, budgetCycleStartDay);
    // Next cycle starts 1 month later on budgetCycleStartDay; cycleEnd is 1 day before next cycle start
    const nextCycleStartDate = new Date(Date.UTC(startYear, startMonthIdx + 1, budgetCycleStartDay));
    nextCycleStartDate.setUTCDate(nextCycleStartDate.getUTCDate() - 1);
    const cycleEnd = nextCycleStartDate.toISOString().slice(0, 10);

    return { cycleStart, cycleEnd };
  }

  function advanceDueDate(dateStr, frequency) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (frequency === 'WEEKLY') {
      dt.setUTCDate(dt.getUTCDate() + 7);
    } else if (frequency === 'YEARLY') {
      dt.setUTCFullYear(dt.getUTCFullYear() + 1);
    } else {
      dt.setUTCMonth(dt.getUTCMonth() + 1);
    }
    return dt.toISOString().slice(0, 10);
  }

  function createRecurringRule(userId, {
    id = crypto.randomUUID(),
    title,
    type = 'EXPENSE',
    defaultAmountMinor,
    accountId,
    transferDestinationAccountId = null,
    categoryId = null,
    frequency = 'MONTHLY',
    nextDueDate,
  }) {
    if (!VALID_FREQUENCIES.has(frequency)) {
      throw new TypeError(`Invalid frequency: ${frequency}`);
    }
    assertPositiveIntegerMinor(defaultAmountMinor, 'defaultAmountMinor');
    requireOwnedAccount(userId, accountId, 'Account');
    if (type === 'TRANSFER') {
      requireOwnedAccount(userId, transferDestinationAccountId, 'Destination account');
    } else if (categoryId) {
      requireOwnedCategory(userId, categoryId);
    }
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO recurring_rules (
        id, user_id, title, type, default_amount_minor, account_id,
        transfer_destination_account_id, category_id, frequency, next_due_date, is_active, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      id,
      userId,
      title.trim(),
      type,
      defaultAmountMinor,
      accountId,
      transferDestinationAccountId,
      categoryId,
      frequency,
      nextDueDate,
      now
    );

    return getRecurringRule(userId, id);
  }

  function getRecurringRule(userId, ruleId) {
    const row = db.prepare(`
      SELECT r.*, a.name AS account_name, c.name AS category_name
      FROM recurring_rules r
      JOIN accounts a ON a.id = r.account_id
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.id = ? AND r.user_id = ?
    `).get(ruleId, userId);

    if (!row) {
      throw new Error(`Recurring rule not found or access denied for tenant ${userId}`);
    }
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      type: row.type,
      defaultAmountMinor: Number(row.default_amount_minor),
      accountId: row.account_id,
      accountName: row.account_name,
      transferDestinationAccountId: row.transfer_destination_account_id,
      categoryId: row.category_id,
      categoryName: row.category_name,
      frequency: row.frequency,
      nextDueDate: row.next_due_date,
      isActive: Boolean(row.is_active),
    };
  }

  function postRecurringRule(userId, ruleId, overrides = {}) {
    return runInTransaction(() => {
      const rule = getRecurringRule(userId, ruleId);
      const amountMinor = overrides.amountMinor !== undefined ? overrides.amountMinor : rule.defaultAmountMinor;
      const occurredOn = overrides.occurredOn || rule.nextDueDate;
      const note = overrides.note !== undefined ? overrides.note : `${rule.title} (1-Tap Recurring)`;

      const tx = recordTransaction(userId, {
        type: rule.type,
        amountMinor,
        accountId: rule.accountId,
        transferDestinationAccountId: rule.transferDestinationAccountId,
        categoryId: rule.categoryId,
        occurredOn,
        note,
        recurringRuleId: rule.id,
      });

      const updatedNextDue = advanceDueDate(rule.nextDueDate, rule.frequency);
      db.prepare(`
        UPDATE recurring_rules SET next_due_date = ? WHERE id = ? AND user_id = ?
      `).run(updatedNextDue, rule.id, userId);

      return {
        transaction: tx,
        rule: getRecurringRule(userId, rule.id),
      };
    });
  }

  function skipRecurringRuleCycle(userId, ruleId) {
    const rule = getRecurringRule(userId, ruleId);
    const updatedNextDue = advanceDueDate(rule.nextDueDate, rule.frequency);
    db.prepare(`
      UPDATE recurring_rules SET next_due_date = ? WHERE id = ? AND user_id = ?
    `).run(updatedNextDue, rule.id, userId);
    return getRecurringRule(userId, rule.id);
  }

  function updateRecurringRule(userId, ruleId, {
    title,
    defaultAmountMinor,
    accountId,
    categoryId,
    nextDueDate,
    isActive,
  } = {}) {
    const rule = getRecurringRule(userId, ruleId);
    const nextTitle = title !== undefined ? String(title).trim() : rule.title;
    if (!nextTitle) {
      throw new TypeError('Recurring rule title cannot be empty');
    }
    const nextAmount = defaultAmountMinor !== undefined ? defaultAmountMinor : rule.defaultAmountMinor;
    assertPositiveIntegerMinor(nextAmount, 'defaultAmountMinor');

    const nextAccountId = accountId !== undefined ? accountId : rule.accountId;
    requireOwnedAccount(userId, nextAccountId, 'Account');

    const nextCategoryId = categoryId !== undefined ? categoryId : rule.categoryId;
    if (nextCategoryId) {
      requireOwnedCategory(userId, nextCategoryId);
    }

    const nextDue = nextDueDate !== undefined ? String(nextDueDate) : rule.nextDueDate;
    const nextActive = isActive !== undefined ? Boolean(isActive) : rule.isActive;

    db.prepare(`
      UPDATE recurring_rules
      SET title = ?, default_amount_minor = ?, account_id = ?, category_id = ?, next_due_date = ?, is_active = ?
      WHERE id = ? AND user_id = ?
    `).run(nextTitle, nextAmount, nextAccountId, nextCategoryId, nextDue, nextActive ? 1 : 0, ruleId, userId);

    return getRecurringRule(userId, ruleId);
  }

  function getCycleDashboard(userId, referenceDateStr = new Date().toISOString().slice(0, 10)) {
    const user = getUser(userId);
    if (!user) throw new Error('User not found');

    const { cycleStart, cycleEnd } = getBudgetCycleWindow(referenceDateStr, user.budgetCycleStartDay);
    const accounts = listAccounts(userId);

    let safeLiquidAssetsMinor = 0;
    let netLiquidityMinor = 0;
    let creditCardDebtMinor = 0;

    for (const acc of accounts) {
      netLiquidityMinor += acc.cachedBalanceMinor;
      if (acc.type === 'CREDIT_CARD') {
        if (acc.cachedBalanceMinor < 0) {
          creditCardDebtMinor += Math.abs(acc.cachedBalanceMinor);
        }
      } else if (acc.includeInSafeToSpend) {
        safeLiquidAssetsMinor += acc.cachedBalanceMinor;
      }
    }

    // Period income & net spending (strictly filtering type IN ('INCOME', 'EXPENSE', 'REFUND') and voided_at IS NULL)
    const periodRows = db.prepare(`
      SELECT type, category_id, COALESCE(SUM(amount_minor), 0) AS sum_minor
      FROM transactions
      WHERE user_id = ?
        AND voided_at IS NULL
        AND occurred_on >= ?
        AND occurred_on <= ?
        AND type IN ('INCOME', 'EXPENSE', 'REFUND')
      GROUP BY type, category_id
    `).all(userId, cycleStart, cycleEnd);

    let totalIncomeMinor = 0;
    let totalSpentMinor = 0;
    const categorySpendMap = new Map();

    for (const r of periodRows) {
      const amt = Number(r.sum_minor);
      if (r.type === 'INCOME') {
        totalIncomeMinor += amt;
      } else if (r.type === 'EXPENSE') {
        totalSpentMinor += amt;
        categorySpendMap.set(r.category_id, (categorySpendMap.get(r.category_id) || 0) + amt);
      } else if (r.type === 'REFUND') {
        totalSpentMinor -= amt;
        categorySpendMap.set(r.category_id, (categorySpendMap.get(r.category_id) || 0) - amt);
      }
    }

    // Previous cycle window & aggregates for cycle-over-cycle spending insights
    const [csY, csM, csD] = cycleStart.split('-').map(Number);
    const prevRefDt = new Date(Date.UTC(csY, csM - 1, csD - 1));
    const { cycleStart: prevCycleStart, cycleEnd: prevCycleEnd } = getBudgetCycleWindow(
      prevRefDt.toISOString().slice(0, 10),
      user.budgetCycleStartDay
    );

    const prevPeriodRows = db.prepare(`
      SELECT type, category_id, COALESCE(SUM(amount_minor), 0) AS sum_minor
      FROM transactions
      WHERE user_id = ?
        AND voided_at IS NULL
        AND occurred_on >= ?
        AND occurred_on <= ?
        AND type IN ('INCOME', 'EXPENSE', 'REFUND')
      GROUP BY type, category_id
    `).all(userId, prevCycleStart, prevCycleEnd);

    let previousTotalIncomeMinor = 0;
    let previousTotalSpentMinor = 0;
    const prevCategorySpendMap = new Map();

    for (const r of prevPeriodRows) {
      const amt = Number(r.sum_minor);
      if (r.type === 'INCOME') {
        previousTotalIncomeMinor += amt;
      } else if (r.type === 'EXPENSE') {
        previousTotalSpentMinor += amt;
        prevCategorySpendMap.set(r.category_id, (prevCategorySpendMap.get(r.category_id) || 0) + amt);
      } else if (r.type === 'REFUND') {
        previousTotalSpentMinor -= amt;
        prevCategorySpendMap.set(r.category_id, (prevCategorySpendMap.get(r.category_id) || 0) - amt);
      }
    }

    const rawCategories = db.prepare(`
      SELECT * FROM categories
      WHERE user_id = ?
      ORDER BY usage_count DESC, name ASC
    `).all(userId);

    let totalMonthlyCapMinor = 0;
    const categories = rawCategories.map((c) => {
      const monthlyCapMinor = c.monthly_cap_minor !== null ? Number(c.monthly_cap_minor) : null;
      const netSpentMinor = c.kind === 'EXPENSE' ? (categorySpendMap.get(c.id) || 0) : 0;
      const previousNetSpentMinor = c.kind === 'EXPENSE' ? (prevCategorySpendMap.get(c.id) || 0) : 0;
      if (c.kind === 'EXPENSE' && monthlyCapMinor !== null) {
        totalMonthlyCapMinor += monthlyCapMinor;
      }
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        icon: c.icon,
        color: c.color,
        usageCount: Number(c.usage_count),
        monthlyCapMinor,
        netSpentMinor,
        previousNetSpentMinor,
        deltaMinor: netSpentMinor - previousNetSpentMinor,
        remainingCapMinor: monthlyCapMinor !== null ? monthlyCapMinor - netSpentMinor : null,
        percentUsed: monthlyCapMinor && monthlyCapMinor > 0
          ? Math.round((netSpentMinor / monthlyCapMinor) * 100)
          : 0,
      };
    });

    // Upcoming recurring rules due on or before cycleEnd
    const recurringRows = db.prepare(`
      SELECT r.*, a.name AS account_name, c.name AS category_name
      FROM recurring_rules r
      JOIN accounts a ON a.id = r.account_id
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.user_id = ? AND r.is_active = 1
      ORDER BY r.next_due_date ASC
    `).all(userId);

    let unpaidRecurringMinor = 0;
    const dueRecurringRules = recurringRows.map((r) => {
      const amt = Number(r.default_amount_minor);
      const isDueInCycle = r.next_due_date <= cycleEnd;
      if (isDueInCycle && r.type === 'EXPENSE') {
        unpaidRecurringMinor += amt;
      }
      return {
        id: r.id,
        title: r.title,
        type: r.type,
        defaultAmountMinor: amt,
        accountId: r.account_id,
        accountName: r.account_name,
        categoryId: r.category_id,
        categoryName: r.category_name,
        frequency: r.frequency,
        nextDueDate: r.next_due_date,
        isDueInCycle,
      };
    });

    const safeToSpendMinor = safeLiquidAssetsMinor - unpaidRecurringMinor;

    // Recent transactions list
    const txRows = db.prepare(`
      SELECT t.*,
             a.name AS account_name,
             da.name AS transfer_destination_account_name,
             c.name AS category_name,
             c.icon AS category_icon,
             c.color AS category_color
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts da ON da.id = t.transfer_destination_account_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = ?
      ORDER BY t.occurred_on DESC, t.created_at DESC
      LIMIT 100
    `).all(userId);

    const recentTransactions = txRows.map((row) => ({
      id: row.id,
      type: row.type,
      amountMinor: Number(row.amount_minor),
      accountId: row.account_id,
      accountName: row.account_name,
      transferDestinationAccountId: row.transfer_destination_account_id,
      transferDestinationAccountName: row.transfer_destination_account_name,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      categoryColor: row.category_color,
      occurredOn: row.occurred_on,
      note: row.note,
      voidedAt: row.voided_at,
    }));

    // Smart defaults for the <5s mobile quick entry keypad
    const expenseCategories = categories.filter((c) => c.kind === 'EXPENSE');
    const smartDefaultAccountId = user.lastUsedAccountId || (accounts[0]?.id ?? null);
    const smartDefaultCategoryId = expenseCategories[0]?.id ?? null;

    return {
      user,
      cycleStart,
      cycleEnd,
      prevCycleStart,
      prevCycleEnd,
      totalIncomeMinor,
      totalSpentMinor,
      previousTotalIncomeMinor,
      previousTotalSpentMinor,
      spentDeltaMinor: totalSpentMinor - previousTotalSpentMinor,
      totalMonthlyCapMinor,
      safeLiquidAssetsMinor,
      unpaidRecurringMinor,
      safeToSpendMinor,
      netLiquidityMinor,
      creditCardDebtMinor,
      smartDefaults: {
        accountId: smartDefaultAccountId,
        categoryId: smartDefaultCategoryId,
      },
      accounts,
      categories,
      dueRecurringRules,
      recentTransactions,
    };
  }

  function listTransactions(userId, { limit = 30, offset = 0, type = 'ALL', search = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const whereClauses = ['t.user_id = ?'];
    const params = [userId];

    if (type === 'EXPENSE') {
      whereClauses.push(`t.type IN ('EXPENSE', 'REFUND')`);
    } else if (type === 'INCOME' || type === 'TRANSFER') {
      whereClauses.push(`t.type = ?`);
      params.push(type);
    }

    const trimmedSearch = String(search || '').trim();
    if (trimmedSearch) {
      const pattern = `%${trimmedSearch.toLowerCase()}%`;
      whereClauses.push(`(
        LOWER(COALESCE(t.note, '')) LIKE ?
        OR LOWER(COALESCE(c.name, '')) LIKE ?
        OR LOWER(COALESCE(a.name, '')) LIKE ?
        OR LOWER(COALESCE(da.name, '')) LIKE ?
      )`);
      params.push(pattern, pattern, pattern, pattern);
    }

    const whereSql = whereClauses.join(' AND ');

    const countRow = db.prepare(`
      SELECT COUNT(*) AS total
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts da ON da.id = t.transfer_destination_account_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${whereSql}
    `).get(...params);

    const totalCount = Number(countRow?.total ?? 0);

    const rows = db.prepare(`
      SELECT t.*,
             a.name AS account_name,
             da.name AS transfer_destination_account_name,
             c.name AS category_name,
             c.icon AS category_icon,
             c.color AS category_color
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts da ON da.id = t.transfer_destination_account_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${whereSql}
      ORDER BY t.occurred_on DESC, t.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, safeLimit, safeOffset);

    const items = rows.map((row) => ({
      id: row.id,
      type: row.type,
      amountMinor: Number(row.amount_minor),
      accountId: row.account_id,
      accountName: row.account_name,
      transferDestinationAccountId: row.transfer_destination_account_id,
      transferDestinationAccountName: row.transfer_destination_account_name,
      categoryId: row.category_id,
      categoryName: row.category_name,
      categoryIcon: row.category_icon,
      categoryColor: row.category_color,
      occurredOn: row.occurred_on,
      note: row.note,
      voidedAt: row.voided_at,
    }));

    const nextOffset = safeOffset + items.length;
    return {
      items,
      totalCount,
      hasMore: nextOffset < totalCount,
      nextOffset,
    };
  }

  function escapeCsvField(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function exportLedgerCsv(userId) {
    const rows = db.prepare(`
      SELECT le.id AS entry_id,
             le.transaction_id,
             le.occurred_on,
             t.type,
             a.name AS account_name,
             COALESCE(c.name, '') AS category_name,
             le.signed_amount_minor,
             t.note
      FROM ledger_entries le
      JOIN transactions t ON t.id = le.transaction_id
      JOIN accounts a ON a.id = le.account_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE le.user_id = ? AND le.voided_at IS NULL
      ORDER BY le.occurred_on ASC, le.created_at ASC
    `).all(userId);

    const header = 'entry_id,transaction_id,occurred_on,type,account_name,category_name,signed_amount_minor,formatted_amount,note';
    const lines = [header];

    for (const r of rows) {
      const signedMinor = Number(r.signed_amount_minor);
      const formatted = (signedMinor / 100).toFixed(2);
      lines.push([
        escapeCsvField(r.entry_id),
        escapeCsvField(r.transaction_id),
        escapeCsvField(r.occurred_on),
        escapeCsvField(r.type),
        escapeCsvField(r.account_name),
        escapeCsvField(r.category_name),
        String(signedMinor),
        formatted,
        escapeCsvField(r.note),
      ].join(','));
    }

    return lines.join('\n') + '\n';
  }

  return {
    db,
    createUser,
    registerUser,
    authenticateUser,
    createSession,
    getSessionByToken,
    renewSessionIfNeeded,
    deleteSessionByToken,
    getUser,
    updateUserProfile,
    updateUserSettings,
    changePassword,
    setPin,
    removePin,
    verifyPin,
    createAccount,
    getAccount,
    listAccounts,
    updateAccount,
    createCategory,
    getCategory,
    updateCategoryCap,
    updateCategory,
    recordTransaction,
    getTransaction,
    updateTransaction,
    voidTransaction,
    reconcileAccountBalance,
    verifyAccountIntegrity,
    getBudgetCycleWindow,
    createRecurringRule,
    getRecurringRule,
    postRecurringRule,
    skipRecurringRuleCycle,
    updateRecurringRule,
    getCycleDashboard,
    listTransactions,
    exportLedgerCsv,
  };
}
