import pg from 'pg';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DEMO_EMAILS, VALID_AVATAR_COLORS, VALID_THEMES, hashPin } from './ledger.mjs';

const { Pool } = pg;

const VALID_ACCOUNT_TYPES = new Set(['CASH_CHECKING', 'SAVINGS', 'CREDIT_CARD']);
const VALID_CATEGORY_KINDS = new Set(['EXPENSE', 'INCOME']);
const VALID_TX_TYPES = new Set(['EXPENSE', 'REFUND', 'INCOME', 'TRANSFER', 'ADJUSTMENT']);
const VALID_FREQUENCIES = new Set(['MONTHLY', 'WEEKLY', 'YEARLY']);
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STARTER_CATEGORIES = [
  { name: 'Groceries', kind: 'EXPENSE', monthlyCapMinor: 50000, icon: 'shopping-bag', color: '#10b981' },
  { name: 'Dining & Coffee', kind: 'EXPENSE', monthlyCapMinor: 30000, icon: 'utensils', color: '#f59e0b' },
  { name: 'Transport', kind: 'EXPENSE', monthlyCapMinor: 20000, icon: 'car', color: '#3b82f6' },
  { name: 'Bills & Subs', kind: 'EXPENSE', monthlyCapMinor: 100000, icon: 'zap', color: '#8b5cf6' },
  { name: 'Income / Paycheck', kind: 'INCOME', monthlyCapMinor: null, icon: 'briefcase', color: '#14b8a6' },
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
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

function escapeCsvField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function createPostgresLedger(connectionString, { pool: injectedPool } = {}) {
  const isLocal = !connectionString || connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  const pool = injectedPool || new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });

  const txStorage = new AsyncLocalStorage();

  async function query(sql, params = []) {
    const ctx = txStorage.getStore();
    if (ctx) {
      return ctx.client.query(sql, params);
    }
    return pool.query(sql, params);
  }

  async function queryOne(sql, params = []) {
    const res = await query(sql, params);
    return res.rows[0] || null;
  }

  async function queryAll(sql, params = []) {
    const res = await query(sql, params);
    return res.rows;
  }

  async function runInTransaction(fn) {
    const existing = txStorage.getStore();
    if (existing) {
      const spName = `sp_${existing.depth}`;
      existing.depth += 1;
      await existing.client.query(`SAVEPOINT ${spName}`);
      try {
        const result = await fn();
        existing.depth -= 1;
        await existing.client.query(`RELEASE SAVEPOINT ${spName}`);
        return result;
      } catch (err) {
        existing.depth -= 1;
        try {
          await existing.client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
          await existing.client.query(`RELEASE SAVEPOINT ${spName}`);
        } catch {
          // ignore rollback errors
        }
        throw err;
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run({ client, depth: 1 }, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function init() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT,
        avatar_color TEXT NOT NULL DEFAULT '#6366f1',
        theme TEXT NOT NULL DEFAULT 'system',
        default_account_id TEXT,
        home_currency_code TEXT NOT NULL DEFAULT 'USD',
        budget_cycle_start_day INTEGER NOT NULL DEFAULT 1 CHECK (budget_cycle_start_day BETWEEN 1 AND 28),
        last_used_account_id TEXT,
        password_hash TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('CASH_CHECKING', 'SAVINGS', 'CREDIT_CARD')),
        include_in_safe_to_spend BOOLEAN NOT NULL DEFAULT TRUE,
        cached_balance_minor BIGINT NOT NULL DEFAULT 0,
        is_archived BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('EXPENSE', 'INCOME')),
        monthly_cap_minor BIGINT,
        icon TEXT NOT NULL DEFAULT 'tag',
        color TEXT NOT NULL DEFAULT '#6366f1',
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS recurring_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('EXPENSE', 'INCOME', 'TRANSFER')),
        default_amount_minor BIGINT NOT NULL CHECK (default_amount_minor > 0),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        transfer_destination_account_id TEXT REFERENCES accounts(id),
        category_id TEXT REFERENCES categories(id),
        frequency TEXT NOT NULL CHECK (frequency IN ('MONTHLY', 'WEEKLY', 'YEARLY')),
        next_due_date TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        type TEXT NOT NULL CHECK (type IN ('EXPENSE', 'REFUND', 'INCOME', 'TRANSFER', 'ADJUSTMENT')),
        amount_minor BIGINT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        transfer_destination_account_id TEXT REFERENCES accounts(id),
        category_id TEXT REFERENCES categories(id),
        occurred_on TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        recurring_rule_id TEXT REFERENCES recurring_rules(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        voided_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        transaction_id TEXT NOT NULL REFERENCES transactions(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        signed_amount_minor BIGINT NOT NULL,
        occurred_on TEXT NOT NULL,
        created_at TEXT NOT NULL,
        voided_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, occurred_on)`,
      `CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(user_id, account_id, voided_at)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id)`,
      `CREATE TABLE IF NOT EXISTS email_verification_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_email_verification_codes_user ON email_verification_codes(user_id)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color TEXT NOT NULL DEFAULT '#6366f1'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'system'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS default_account_id TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT`,
    ];

    const hasEmailVerifiedCol = await queryOne(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email_verified_at'`
    );

    for (const sql of statements) {
      await query(sql);
    }

    if (!hasEmailVerifiedCol) {
      await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TEXT`);
      const unverifiedDemo = await queryOne(
        `SELECT id FROM users WHERE email_verified_at IS NULL AND LOWER(email) IN ('patrick@pocketledger.app', 'alex.isolated@pocketledger.app') LIMIT 1`
      );
      if (unverifiedDemo) {
        await query(
          `UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL AND LOWER(email) IN ('patrick@pocketledger.app', 'alex.isolated@pocketledger.app')`
        );
      }
    }
  }

  async function healthCheck() {
    const row = await queryOne('SELECT 1 AS ok');
    return Number(row?.ok) === 1;
  }

  async function recalculateAccountBalance(userId, accountId) {
    const row = await queryOne(`
      SELECT COALESCE(SUM(signed_amount_minor), 0) AS total_minor
      FROM ledger_entries
      WHERE user_id = $1 AND account_id = $2 AND voided_at IS NULL
    `, [userId, accountId]);

    const totalMinor = Number(row?.total_minor ?? 0);
    await query(`
      UPDATE accounts SET cached_balance_minor = $1 WHERE id = $2 AND user_id = $3
    `, [totalMinor, accountId, userId]);
    return totalMinor;
  }

  async function requireOwnedAccount(userId, accountId, label = 'Account') {
    const acc = await queryOne(`SELECT * FROM accounts WHERE id = $1 AND user_id = $2`, [accountId, userId]);
    if (!acc) throw new Error(`${label} not found or access denied for tenant ${userId}`);
    return acc;
  }

  async function requireOwnedCategory(userId, categoryId) {
    const cat = await queryOne(`SELECT * FROM categories WHERE id = $1 AND user_id = $2`, [categoryId, userId]);
    if (!cat) throw new Error(`Category not found or access denied for tenant ${userId}`);
    return cat;
  }

  async function getUser(userId) {
    const u = await queryOne(`SELECT * FROM users WHERE id = $1`, [userId]);
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
      emailVerified: Boolean(u.email_verified_at),
      createdAt: u.created_at,
    };
  }

  async function createUser({ id = crypto.randomUUID(), email, homeCurrencyCode = 'USD', budgetCycleStartDay = 1, password = null, emailVerified = true }) {
    if (!email || typeof email !== 'string') throw new TypeError('Valid user email is required');
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new TypeError('Valid user email is required');
    if (!Number.isInteger(budgetCycleStartDay) || budgetCycleStartDay < 1 || budgetCycleStartDay > 28) {
      throw new RangeError('budgetCycleStartDay must be an integer between 1 and 28');
    }
    const passwordHash = password !== null && password !== undefined ? hashPassword(password) : null;
    const now = new Date().toISOString();
    const verifiedAt = emailVerified ? now : null;
    await query(`
      INSERT INTO users (id, email, home_currency_code, budget_cycle_start_day, password_hash, email_verified_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, normalizedEmail, homeCurrencyCode.toUpperCase(), budgetCycleStartDay, passwordHash, verifiedAt, now]);

    return getUser(id);
  }

  async function registerUser({ email, password, homeCurrencyCode = 'USD', budgetCycleStartDay = 1, emailVerified = false }) {
    if (!email || typeof email !== 'string' || !email.trim() || !email.includes('@')) {
      const err = new TypeError('Valid user email is required');
      err.statusCode = 400;
      throw err;
    }
    if (typeof password !== 'string' || password.length < 8) {
      const err = new RangeError('Password must be at least 8 characters');
      err.statusCode = 400;
      throw err;
    }
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await queryOne(`SELECT id FROM users WHERE LOWER(email) = $1`, [normalizedEmail]);
    if (existing) {
      const err = new Error('An account with this email already exists');
      err.code = 'DUPLICATE_EMAIL';
      err.statusCode = 409;
      throw err;
    }

    return runInTransaction(async () => {
      const user = await createUser({
        email: normalizedEmail,
        password,
        homeCurrencyCode,
        budgetCycleStartDay,
        emailVerified,
      });
      for (const cat of STARTER_CATEGORIES) {
        await createCategory(user.id, cat);
      }
      return user;
    });
  }

  async function authenticateUser({ email, password }) {
    if (typeof email !== 'string' || typeof password !== 'string') return null;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) return null;
    const row = await queryOne(`SELECT * FROM users WHERE LOWER(email) = $1`, [normalizedEmail]);
    if (!row || !row.password_hash) return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    if (!row.email_verified_at) {
      const err = new Error('Please confirm your email address before signing in.');
      err.code = 'EMAIL_NOT_VERIFIED';
      err.statusCode = 403;
      throw err;
    }
    return getUser(row.id);
  }

  async function createSession(userId, ttlMs = DEFAULT_SESSION_TTL_MS) {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashSessionToken(rawToken);
    const id = crypto.randomUUID();
    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();

    await query(`
      INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, userId, tokenHash, expiresAt, createdAt]);

    return { id, userId, rawToken, expiresAt, createdAt };
  }

  async function getSessionByToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const tokenHash = hashSessionToken(rawToken);
    const row = await queryOne(`SELECT * FROM sessions WHERE token_hash = $1`, [tokenHash]);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      await query(`DELETE FROM sessions WHERE id = $1`, [row.id]);
      return null;
    }
    return {
      id: row.id,
      userId: row.user_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  async function renewSessionIfNeeded(sessionId, ttlMs = DEFAULT_SESSION_TTL_MS) {
    const row = await queryOne(`SELECT * FROM sessions WHERE id = $1`, [sessionId]);
    if (!row) return null;
    const remainingMs = Date.parse(row.expires_at) - Date.now();
    if (remainingMs >= ttlMs / 2) {
      return { renewed: false, expiresAt: row.expires_at };
    }
    const newExpiresAt = new Date(Date.now() + ttlMs).toISOString();
    await query(`UPDATE sessions SET expires_at = $1 WHERE id = $2`, [newExpiresAt, sessionId]);
    return { renewed: true, expiresAt: newExpiresAt };
  }

  async function deleteSessionByToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return false;
    const tokenHash = hashSessionToken(rawToken);
    const res = await query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
    return (res.rowCount || 0) > 0;
  }

  async function updateUserProfile(userId, {
    displayName,
    avatarColor,
    theme,
    defaultAccountId,
    homeCurrencyCode,
    budgetCycleStartDay,
  } = {}) {
    const user = await getUser(userId);
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
        const acc = await requireOwnedAccount(userId, defaultAccountId, 'Default account');
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

    await query(`
      UPDATE users
      SET display_name = $1, avatar_color = $2, theme = $3, default_account_id = $4,
          home_currency_code = $5, budget_cycle_start_day = $6
      WHERE id = $7
    `, [
      nextDisplayName,
      nextAvatarColor,
      nextTheme,
      nextDefaultAccountId,
      nextCurrency,
      nextStartDay,
      userId,
    ]);
    return getUser(userId);
  }

  async function updateUserSettings(userId, { homeCurrencyCode, budgetCycleStartDay }) {
    return updateUserProfile(userId, { homeCurrencyCode, budgetCycleStartDay });
  }

  async function changePassword(userId, { currentPassword, newPassword, currentSessionToken = null } = {}) {
    const row = await queryOne(`SELECT id, email, password_hash FROM users WHERE id = $1`, [userId]);
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
    await runInTransaction(async () => {
      await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [nextHash, userId]);
      if (currentSessionToken && typeof currentSessionToken === 'string') {
        const currentHash = hashSessionToken(currentSessionToken);
        await query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash != $2`, [userId, currentHash]);
      } else {
        await query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
      }
    });
    return true;
  }

  function hashResetToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
  }

  async function createPasswordResetToken(email, { ttlMinutes = 30 } = {}) {
    if (typeof email !== 'string' || !email.trim()) return null;
    const normalizedEmail = email.trim().toLowerCase();
    if (DEMO_EMAILS.has(normalizedEmail)) return null;

    const row = await queryOne(
      `SELECT id, email, password_hash FROM users WHERE LOWER(email) = $1`,
      [normalizedEmail]
    );
    if (!row || !row.password_hash) return null;

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMinutes * 60 * 1000).toISOString();

    await runInTransaction(async () => {
      await query(`DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, [row.id]);
      await query(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), row.id, tokenHash, expiresAt, createdAt]
      );
    });

    return { rawToken, email: row.email, expiresAt };
  }

  function hashVerificationCode(userId, code) {
    return crypto.createHash('sha256').update(`${userId}:${String(code).trim()}`).digest('hex');
  }

  async function createEmailVerificationCode(email, { ttlMinutes = 15 } = {}) {
    if (typeof email !== 'string' || !email.trim()) return null;
    const normalizedEmail = email.trim().toLowerCase();
    if (DEMO_EMAILS.has(normalizedEmail)) return null;

    const row = await queryOne(
      `SELECT id, email, email_verified_at FROM users WHERE LOWER(email) = $1`,
      [normalizedEmail]
    );
    if (!row || row.email_verified_at) return null;

    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hashVerificationCode(row.id, code);
    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMinutes * 60 * 1000).toISOString();

    await runInTransaction(async () => {
      await query(`DELETE FROM email_verification_codes WHERE user_id = $1 AND used_at IS NULL`, [row.id]);
      await query(
        `INSERT INTO email_verification_codes (id, user_id, code_hash, attempts, expires_at, created_at)
         VALUES ($1, $2, $3, 0, $4, $5)`,
        [crypto.randomUUID(), row.id, codeHash, expiresAt, createdAt]
      );
    });

    return { code, email: row.email, expiresAt };
  }

  async function verifyEmailCode({ email, code } = {}) {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const cleanCode = typeof code === 'string' ? code.trim() : '';
    if (!normalizedEmail || !/^\d{6}$/.test(cleanCode)) {
      const err = new Error('Please enter a valid 6-digit verification code.');
      err.statusCode = 400;
      throw err;
    }

    const userRow = await queryOne(
      `SELECT id, email, email_verified_at FROM users WHERE LOWER(email) = $1`,
      [normalizedEmail]
    );
    if (!userRow) {
      const err = new Error('Verification code is invalid or expired.');
      err.statusCode = 400;
      throw err;
    }
    if (userRow.email_verified_at) {
      return getUser(userRow.id);
    }

    const codeRow = await queryOne(
      `SELECT id, code_hash, attempts, expires_at
       FROM email_verification_codes
       WHERE user_id = $1 AND used_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [userRow.id]
    );

    const nowIso = new Date().toISOString();
    if (!codeRow || codeRow.expires_at <= nowIso) {
      const err = new Error('Verification code is invalid or expired.');
      err.statusCode = 400;
      throw err;
    }
    if (Number(codeRow.attempts) >= 5) {
      const err = new Error('Too many incorrect codes. Please request a new verification code.');
      err.statusCode = 400;
      throw err;
    }

    const expectedHash = hashVerificationCode(userRow.id, cleanCode);
    if (expectedHash !== codeRow.code_hash) {
      const nextAttempts = Number(codeRow.attempts) + 1;
      await query(`UPDATE email_verification_codes SET attempts = $1 WHERE id = $2`, [nextAttempts, codeRow.id]);
      const err = new Error(
        nextAttempts >= 5
          ? 'Too many incorrect codes. Please request a new verification code.'
          : 'Verification code is invalid.'
      );
      err.statusCode = 400;
      throw err;
    }

    await runInTransaction(async () => {
      await query(`UPDATE email_verification_codes SET used_at = $1 WHERE id = $2`, [nowIso, codeRow.id]);
      await query(`UPDATE users SET email_verified_at = $1 WHERE id = $2 AND email_verified_at IS NULL`, [nowIso, userRow.id]);
    });

    return getUser(userRow.id);
  }

  async function consumePasswordResetToken({ token, newPassword } = {}) {
    if (typeof token !== 'string' || !token.trim()) {
      const err = new Error('Reset link is invalid or expired');
      err.statusCode = 400;
      throw err;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      const err = new RangeError('New password must be at least 8 characters long');
      err.statusCode = 400;
      throw err;
    }

    const tokenHash = hashResetToken(token.trim());
    const nowIso = new Date().toISOString();
    const resetRow = await queryOne(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token_hash = $1`,
      [tokenHash]
    );

    if (!resetRow || resetRow.used_at || resetRow.expires_at <= nowIso) {
      const err = new Error('Reset link is invalid or expired');
      err.statusCode = 400;
      throw err;
    }
    if (DEMO_EMAILS.has(String(resetRow.email).toLowerCase())) {
      const err = new Error('Demo accounts cannot reset password');
      err.statusCode = 403;
      throw err;
    }

    const nextHash = hashPassword(newPassword);
    await runInTransaction(async () => {
      const updated = await queryOne(
        `UPDATE password_reset_tokens
         SET used_at = $1
         WHERE id = $2 AND used_at IS NULL AND expires_at > $3
         RETURNING id`,
        [nowIso, resetRow.id, nowIso]
      );
      if (!updated) {
        const err = new Error('Reset link is invalid or expired');
        err.statusCode = 400;
        throw err;
      }
      await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [nextHash, resetRow.user_id]);
      await query(`DELETE FROM sessions WHERE user_id = $1`, [resetRow.user_id]);
    });

    return true;
  }

  async function setPin(userId, pin) {
    const row = await queryOne(`SELECT id, email FROM users WHERE id = $1`, [userId]);
    if (!row) throw new Error('User not found');
    if (DEMO_EMAILS.has(String(row.email).toLowerCase())) {
      const err = new Error('Demo accounts cannot set a PIN');
      err.statusCode = 403;
      throw err;
    }
    const nextHash = hashPin(pin);
    await query(`UPDATE users SET pin_hash = $1 WHERE id = $2`, [nextHash, userId]);
    return getUser(userId);
  }

  async function removePin(userId) {
    const row = await queryOne(`SELECT id, email FROM users WHERE id = $1`, [userId]);
    if (!row) throw new Error('User not found');
    if (DEMO_EMAILS.has(String(row.email).toLowerCase())) {
      const err = new Error('Demo accounts cannot modify PIN settings');
      err.statusCode = 403;
      throw err;
    }
    await query(`UPDATE users SET pin_hash = NULL WHERE id = $1`, [userId]);
    return getUser(userId);
  }

  async function verifyPin(userId, pin) {
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return false;
    }
    const row = await queryOne(`SELECT pin_hash FROM users WHERE id = $1`, [userId]);
    if (!row || !row.pin_hash) {
      return false;
    }
    return verifyPassword(pin, row.pin_hash);
  }

  async function getAccount(userId, accountId) {
    const row = await requireOwnedAccount(userId, accountId);
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

  async function createAccount(userId, {
    id = crypto.randomUUID(),
    name,
    type,
    initialBalanceMinor = 0,
    includeInSafeToSpend,
    occurredOn = new Date().toISOString().slice(0, 10),
  }) {
    if (!VALID_ACCOUNT_TYPES.has(type)) throw new TypeError(`Invalid account type: ${type}`);
    assertSignedIntegerMinor(initialBalanceMinor, 'initialBalanceMinor');

    const defaultSafeToSpend = includeInSafeToSpend !== undefined
      ? Boolean(includeInSafeToSpend)
      : type === 'CASH_CHECKING';

    return runInTransaction(async () => {
      const now = new Date().toISOString();
      await query(`
        INSERT INTO accounts (id, user_id, name, type, include_in_safe_to_spend, cached_balance_minor, created_at)
        VALUES ($1, $2, $3, $4, $5, 0, $6)
      `, [id, userId, name.trim(), type, defaultSafeToSpend, now]);

      const user = await getUser(userId);
      if (user && !user.lastUsedAccountId) {
        await query(`UPDATE users SET last_used_account_id = $1 WHERE id = $2`, [id, userId]);
      }

      if (initialBalanceMinor !== 0) {
        const txId = crypto.randomUUID();
        const entryId = crypto.randomUUID();
        await query(`
          INSERT INTO transactions (
            id, user_id, type, amount_minor, account_id, transfer_destination_account_id,
            category_id, occurred_on, note, created_at, updated_at
          ) VALUES ($1, $2, 'ADJUSTMENT', $3, $4, NULL, NULL, $5, 'Opening Balance', $6, $7)
        `, [txId, userId, initialBalanceMinor, id, occurredOn, now, now]);

        await query(`
          INSERT INTO ledger_entries (
            id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [entryId, userId, txId, id, initialBalanceMinor, occurredOn, now]);

        await recalculateAccountBalance(userId, id);
      }

      return getAccount(userId, id);
    });
  }

  async function listAccounts(userId) {
    const rows = await queryAll(`
      SELECT * FROM accounts WHERE user_id = $1 AND is_archived = FALSE ORDER BY created_at ASC
    `, [userId]);
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

  async function updateAccount(userId, accountId, { name, includeInSafeToSpend, isArchived } = {}) {
    const acc = await getAccount(userId, accountId);
    const nextName = name !== undefined ? String(name).trim() : acc.name;
    if (!nextName) throw new TypeError('Account name cannot be empty');
    const nextSafe = includeInSafeToSpend !== undefined ? Boolean(includeInSafeToSpend) : acc.includeInSafeToSpend;
    const nextArchived = isArchived !== undefined ? Boolean(isArchived) : acc.isArchived;

    await query(`
      UPDATE accounts
      SET name = $1, include_in_safe_to_spend = $2, is_archived = $3
      WHERE id = $4 AND user_id = $5
    `, [nextName, nextSafe, nextArchived, accountId, userId]);

    return getAccount(userId, accountId);
  }

  async function getCategory(userId, categoryId) {
    const row = await requireOwnedCategory(userId, categoryId);
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

  async function createCategory(userId, {
    id = crypto.randomUUID(),
    name,
    kind,
    monthlyCapMinor = null,
    icon = 'tag',
    color = '#6366f1',
  }) {
    if (!VALID_CATEGORY_KINDS.has(kind)) throw new TypeError(`Invalid category kind: ${kind}`);
    if (monthlyCapMinor !== null && monthlyCapMinor !== undefined) {
      assertPositiveIntegerMinor(monthlyCapMinor, 'monthlyCapMinor');
    }
    const now = new Date().toISOString();
    await query(`
      INSERT INTO categories (id, user_id, name, kind, monthly_cap_minor, icon, color, usage_count, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)
    `, [id, userId, name.trim(), kind, monthlyCapMinor ?? null, icon, color, now]);

    return getCategory(userId, id);
  }

  async function updateCategoryCap(userId, categoryId, monthlyCapMinor) {
    await requireOwnedCategory(userId, categoryId);
    if (monthlyCapMinor !== null) assertPositiveIntegerMinor(monthlyCapMinor, 'monthlyCapMinor');
    await query(`
      UPDATE categories SET monthly_cap_minor = $1 WHERE id = $2 AND user_id = $3
    `, [monthlyCapMinor, categoryId, userId]);
    return getCategory(userId, categoryId);
  }

  async function updateCategory(userId, categoryId, { name, monthlyCapMinor } = {}) {
    const cat = await getCategory(userId, categoryId);
    const nextName = name !== undefined ? String(name).trim() : cat.name;
    if (!nextName) throw new TypeError('Category name cannot be empty');
    let nextCap = cat.monthlyCapMinor;
    if (monthlyCapMinor !== undefined) {
      if (monthlyCapMinor !== null) assertPositiveIntegerMinor(monthlyCapMinor, 'monthlyCapMinor');
      nextCap = cat.kind === 'INCOME' ? null : monthlyCapMinor;
    }
    await query(`
      UPDATE categories SET name = $1, monthly_cap_minor = $2 WHERE id = $3 AND user_id = $4
    `, [nextName, nextCap, categoryId, userId]);
    return getCategory(userId, categoryId);
  }

  async function getTransaction(userId, transactionId) {
    const row = await queryOne(`
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
      WHERE t.id = $1 AND t.user_id = $2
    `, [transactionId, userId]);

    if (!row) throw new Error(`Transaction not found or access denied for tenant ${userId}`);
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

  async function recordTransaction(userId, {
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
    if (!VALID_TX_TYPES.has(type)) throw new TypeError(`Invalid transaction type: ${type}`);

    if (type === 'ADJUSTMENT') {
      assertSignedIntegerMinor(amountMinor, 'amountMinor');
      if (amountMinor === 0) throw new RangeError('Adjustment amountMinor cannot be 0 in integer minor units');
    } else {
      assertPositiveIntegerMinor(amountMinor, 'amountMinor');
    }

    return runInTransaction(async () => {
      await requireOwnedAccount(userId, accountId, 'Source account');
      const now = new Date().toISOString();

      if (type === 'TRANSFER') {
        if (!transferDestinationAccountId) throw new Error('TRANSFER requires transferDestinationAccountId');
        if (transferDestinationAccountId === accountId) throw new Error('TRANSFER source and destination accounts must be different');
        if (categoryId !== null && categoryId !== undefined) throw new Error('TRANSFER must not carry a categoryId');
        await requireOwnedAccount(userId, transferDestinationAccountId, 'Destination account');
      } else if (type === 'EXPENSE' || type === 'REFUND') {
        if (!categoryId) throw new Error(`${type} requires a categoryId`);
        const cat = await requireOwnedCategory(userId, categoryId);
        if (cat.kind !== 'EXPENSE') throw new Error(`${type} must use an EXPENSE category (got ${cat.kind})`);
      } else if (type === 'INCOME') {
        if (!categoryId) throw new Error('INCOME requires a categoryId');
        const cat = await requireOwnedCategory(userId, categoryId);
        if (cat.kind !== 'INCOME') throw new Error(`INCOME must use an INCOME category (got ${cat.kind})`);
      }

      await query(`
        INSERT INTO transactions (
          id, user_id, type, amount_minor, account_id, transfer_destination_account_id,
          category_id, occurred_on, note, recurring_rule_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
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
        now,
      ]);

      if (type === 'EXPENSE') {
        await query(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [crypto.randomUUID(), userId, id, accountId, -amountMinor, occurredOn, now]);
        await recalculateAccountBalance(userId, accountId);
      } else if (type === 'REFUND' || type === 'INCOME' || type === 'ADJUSTMENT') {
        await query(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [crypto.randomUUID(), userId, id, accountId, amountMinor, occurredOn, now]);
        await recalculateAccountBalance(userId, accountId);
      } else if (type === 'TRANSFER') {
        await query(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [crypto.randomUUID(), userId, id, accountId, -amountMinor, occurredOn, now]);
        await query(`
          INSERT INTO ledger_entries (id, user_id, transaction_id, account_id, signed_amount_minor, occurred_on, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [crypto.randomUUID(), userId, id, transferDestinationAccountId, amountMinor, occurredOn, now]);
        await recalculateAccountBalance(userId, accountId);
        await recalculateAccountBalance(userId, transferDestinationAccountId);
      }

      await query(`UPDATE users SET last_used_account_id = $1 WHERE id = $2`, [accountId, userId]);
      if (categoryId) {
        await query(`
          UPDATE categories SET usage_count = usage_count + 1 WHERE id = $1 AND user_id = $2
        `, [categoryId, userId]);
      }

      return getTransaction(userId, id);
    });
  }

  async function voidTransaction(userId, transactionId) {
    return runInTransaction(async () => {
      const tx = await getTransaction(userId, transactionId);
      if (tx.voidedAt) return tx;
      const now = new Date().toISOString();
      await query(`
        UPDATE transactions SET voided_at = $1, updated_at = $2 WHERE id = $3 AND user_id = $4
      `, [now, now, transactionId, userId]);
      await query(`
        UPDATE ledger_entries SET voided_at = $1 WHERE transaction_id = $2 AND user_id = $3
      `, [now, transactionId, userId]);

      await recalculateAccountBalance(userId, tx.accountId);
      if (tx.transferDestinationAccountId) {
        await recalculateAccountBalance(userId, tx.transferDestinationAccountId);
      }
      return getTransaction(userId, transactionId);
    });
  }

  async function updateTransaction(userId, transactionId, { amountMinor, categoryId, occurredOn, note } = {}) {
    return runInTransaction(async () => {
      const tx = await getTransaction(userId, transactionId);
      if (tx.voidedAt) throw new Error('Cannot edit a voided transaction');
      if (tx.type === 'ADJUSTMENT') throw new Error('Cannot edit a balance adjustment transaction');

      const nextAmount = amountMinor !== undefined ? amountMinor : tx.amountMinor;
      assertPositiveIntegerMinor(nextAmount, 'amountMinor');

      let nextCategoryId = tx.categoryId;
      if (categoryId !== undefined) {
        if (tx.type === 'TRANSFER') {
          if (categoryId !== null) throw new Error('TRANSFER must not carry a categoryId');
          nextCategoryId = null;
        } else {
          if (!categoryId) throw new Error(`${tx.type} requires a categoryId`);
          const cat = await requireOwnedCategory(userId, categoryId);
          const expectedKind = tx.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
          if (cat.kind !== expectedKind) throw new Error(`${tx.type} must use a ${expectedKind} category (got ${cat.kind})`);
          nextCategoryId = categoryId;
        }
      }

      const nextOccurredOn = occurredOn !== undefined ? String(occurredOn) : tx.occurredOn;
      const nextNote = note !== undefined ? String(note) : tx.note;
      const now = new Date().toISOString();

      await query(`
        UPDATE transactions
        SET amount_minor = $1, category_id = $2, occurred_on = $3, note = $4, updated_at = $5
        WHERE id = $6 AND user_id = $7
      `, [nextAmount, nextCategoryId, nextOccurredOn, nextNote, now, transactionId, userId]);

      if (tx.type === 'EXPENSE') {
        await query(`
          UPDATE ledger_entries SET signed_amount_minor = $1, occurred_on = $2
          WHERE transaction_id = $3 AND user_id = $4 AND account_id = $5 AND voided_at IS NULL
        `, [-nextAmount, nextOccurredOn, transactionId, userId, tx.accountId]);
        await recalculateAccountBalance(userId, tx.accountId);
      } else if (tx.type === 'REFUND' || tx.type === 'INCOME') {
        await query(`
          UPDATE ledger_entries SET signed_amount_minor = $1, occurred_on = $2
          WHERE transaction_id = $3 AND user_id = $4 AND account_id = $5 AND voided_at IS NULL
        `, [nextAmount, nextOccurredOn, transactionId, userId, tx.accountId]);
        await recalculateAccountBalance(userId, tx.accountId);
      } else if (tx.type === 'TRANSFER') {
        await query(`
          UPDATE ledger_entries SET signed_amount_minor = $1, occurred_on = $2
          WHERE transaction_id = $3 AND user_id = $4 AND account_id = $5 AND voided_at IS NULL
        `, [-nextAmount, nextOccurredOn, transactionId, userId, tx.accountId]);
        await query(`
          UPDATE ledger_entries SET signed_amount_minor = $1, occurred_on = $2
          WHERE transaction_id = $3 AND user_id = $4 AND account_id = $5 AND voided_at IS NULL
        `, [nextAmount, nextOccurredOn, transactionId, userId, tx.transferDestinationAccountId]);
        await recalculateAccountBalance(userId, tx.accountId);
        await recalculateAccountBalance(userId, tx.transferDestinationAccountId);
      }

      return getTransaction(userId, transactionId);
    });
  }

  async function reconcileAccountBalance(userId, accountId, actualBalanceMinor, occurredOn = new Date().toISOString().slice(0, 10), note = 'Balance Reconciliation') {
    assertSignedIntegerMinor(actualBalanceMinor, 'actualBalanceMinor');
    return runInTransaction(async () => {
      const acc = await getAccount(userId, accountId);
      const deltaMinor = actualBalanceMinor - acc.cachedBalanceMinor;
      if (deltaMinor === 0) {
        return { adjusted: false, deltaMinor: 0, account: acc, transaction: null };
      }
      const tx = await recordTransaction(userId, {
        type: 'ADJUSTMENT',
        amountMinor: deltaMinor,
        accountId,
        occurredOn,
        note,
      });
      return {
        adjusted: true,
        deltaMinor,
        account: await getAccount(userId, accountId),
        transaction: tx,
      };
    });
  }

  async function verifyAccountIntegrity(userId, accountId) {
    const acc = await getAccount(userId, accountId);
    const row = await queryOne(`
      SELECT COALESCE(SUM(signed_amount_minor), 0) AS ledger_sum
      FROM ledger_entries
      WHERE user_id = $1 AND account_id = $2 AND voided_at IS NULL
    `, [userId, accountId]);

    const ledgerSumMinor = Number(row?.ledger_sum ?? 0);
    return {
      accountId: acc.id,
      cachedBalanceMinor: acc.cachedBalanceMinor,
      ledgerSumMinor,
      driftMinor: acc.cachedBalanceMinor - ledgerSumMinor,
      isValid: acc.cachedBalanceMinor === ledgerSumMinor,
    };
  }

  async function getRecurringRule(userId, ruleId) {
    const row = await queryOne(`
      SELECT r.*, a.name AS account_name, c.name AS category_name
      FROM recurring_rules r
      JOIN accounts a ON a.id = r.account_id
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.id = $1 AND r.user_id = $2
    `, [ruleId, userId]);
    if (!row) throw new Error(`Recurring rule not found or access denied for tenant ${userId}`);
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

  async function createRecurringRule(userId, {
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
    if (!VALID_FREQUENCIES.has(frequency)) throw new TypeError(`Invalid frequency: ${frequency}`);
    assertPositiveIntegerMinor(defaultAmountMinor, 'defaultAmountMinor');
    await requireOwnedAccount(userId, accountId, 'Account');
    if (type === 'TRANSFER') {
      await requireOwnedAccount(userId, transferDestinationAccountId, 'Destination account');
    } else if (categoryId) {
      await requireOwnedCategory(userId, categoryId);
    }
    const now = new Date().toISOString();
    await query(`
      INSERT INTO recurring_rules (
        id, user_id, title, type, default_amount_minor, account_id,
        transfer_destination_account_id, category_id, frequency, next_due_date, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11)
    `, [
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
      now,
    ]);

    return getRecurringRule(userId, id);
  }

  async function postRecurringRule(userId, ruleId, overrides = {}) {
    return runInTransaction(async () => {
      const rule = await getRecurringRule(userId, ruleId);
      const amountMinor = overrides.amountMinor !== undefined ? overrides.amountMinor : rule.defaultAmountMinor;
      const occurredOn = overrides.occurredOn || rule.nextDueDate;
      const note = overrides.note !== undefined ? overrides.note : `${rule.title} (1-Tap Recurring)`;

      const tx = await recordTransaction(userId, {
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
      await query(`
        UPDATE recurring_rules SET next_due_date = $1 WHERE id = $2 AND user_id = $3
      `, [updatedNextDue, rule.id, userId]);

      return {
        transaction: tx,
        rule: await getRecurringRule(userId, rule.id),
      };
    });
  }

  async function skipRecurringRuleCycle(userId, ruleId) {
    const rule = await getRecurringRule(userId, ruleId);
    const updatedNextDue = advanceDueDate(rule.nextDueDate, rule.frequency);
    await query(`
      UPDATE recurring_rules SET next_due_date = $1 WHERE id = $2 AND user_id = $3
    `, [updatedNextDue, rule.id, userId]);
    return getRecurringRule(userId, rule.id);
  }

  async function updateRecurringRule(userId, ruleId, {
    title,
    defaultAmountMinor,
    accountId,
    categoryId,
    nextDueDate,
    isActive,
  } = {}) {
    const rule = await getRecurringRule(userId, ruleId);
    const nextTitle = title !== undefined ? String(title).trim() : rule.title;
    if (!nextTitle) throw new TypeError('Recurring rule title cannot be empty');
    const nextAmount = defaultAmountMinor !== undefined ? defaultAmountMinor : rule.defaultAmountMinor;
    assertPositiveIntegerMinor(nextAmount, 'defaultAmountMinor');

    const nextAccountId = accountId !== undefined ? accountId : rule.accountId;
    await requireOwnedAccount(userId, nextAccountId, 'Account');

    const nextCategoryId = categoryId !== undefined ? categoryId : rule.categoryId;
    if (nextCategoryId) await requireOwnedCategory(userId, nextCategoryId);

    const nextDue = nextDueDate !== undefined ? String(nextDueDate) : rule.nextDueDate;
    const nextActive = isActive !== undefined ? Boolean(isActive) : rule.isActive;

    await query(`
      UPDATE recurring_rules
      SET title = $1, default_amount_minor = $2, account_id = $3, category_id = $4, next_due_date = $5, is_active = $6
      WHERE id = $7 AND user_id = $8
    `, [nextTitle, nextAmount, nextAccountId, nextCategoryId, nextDue, nextActive, ruleId, userId]);

    return getRecurringRule(userId, ruleId);
  }

  async function getCycleDashboard(userId, referenceDateStr = new Date().toISOString().slice(0, 10)) {
    const user = await getUser(userId);
    if (!user) throw new Error('User not found');

    const { cycleStart, cycleEnd } = getBudgetCycleWindow(referenceDateStr, user.budgetCycleStartDay);
    const accounts = await listAccounts(userId);

    let safeLiquidAssetsMinor = 0;
    let netLiquidityMinor = 0;
    let creditCardDebtMinor = 0;

    for (const acc of accounts) {
      netLiquidityMinor += acc.cachedBalanceMinor;
      if (acc.type === 'CREDIT_CARD') {
        if (acc.cachedBalanceMinor < 0) creditCardDebtMinor += Math.abs(acc.cachedBalanceMinor);
      } else if (acc.includeInSafeToSpend) {
        safeLiquidAssetsMinor += acc.cachedBalanceMinor;
      }
    }

    const periodRows = await queryAll(`
      SELECT type, category_id, COALESCE(SUM(amount_minor), 0) AS sum_minor
      FROM transactions
      WHERE user_id = $1
        AND voided_at IS NULL
        AND occurred_on >= $2
        AND occurred_on <= $3
        AND type IN ('INCOME', 'EXPENSE', 'REFUND')
      GROUP BY type, category_id
    `, [userId, cycleStart, cycleEnd]);

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

    const [csY, csM, csD] = cycleStart.split('-').map(Number);
    const prevRefDt = new Date(Date.UTC(csY, csM - 1, csD - 1));
    const { cycleStart: prevCycleStart, cycleEnd: prevCycleEnd } = getBudgetCycleWindow(
      prevRefDt.toISOString().slice(0, 10),
      user.budgetCycleStartDay
    );

    const prevPeriodRows = await queryAll(`
      SELECT type, category_id, COALESCE(SUM(amount_minor), 0) AS sum_minor
      FROM transactions
      WHERE user_id = $1
        AND voided_at IS NULL
        AND occurred_on >= $2
        AND occurred_on <= $3
        AND type IN ('INCOME', 'EXPENSE', 'REFUND')
      GROUP BY type, category_id
    `, [userId, prevCycleStart, prevCycleEnd]);

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

    const rawCategories = await queryAll(`
      SELECT * FROM categories WHERE user_id = $1 ORDER BY usage_count DESC, name ASC
    `, [userId]);

    let totalMonthlyCapMinor = 0;
    const categories = rawCategories.map((c) => {
      const monthlyCapMinor = c.monthly_cap_minor !== null ? Number(c.monthly_cap_minor) : null;
      const netSpentMinor = c.kind === 'EXPENSE' ? (categorySpendMap.get(c.id) || 0) : 0;
      const previousNetSpentMinor = c.kind === 'EXPENSE' ? (prevCategorySpendMap.get(c.id) || 0) : 0;
      if (c.kind === 'EXPENSE' && monthlyCapMinor !== null) totalMonthlyCapMinor += monthlyCapMinor;
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
        percentUsed: monthlyCapMinor && monthlyCapMinor > 0 ? Math.round((netSpentMinor / monthlyCapMinor) * 100) : 0,
      };
    });

    const recurringRows = await queryAll(`
      SELECT r.*, a.name AS account_name, c.name AS category_name
      FROM recurring_rules r
      JOIN accounts a ON a.id = r.account_id
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.user_id = $1 AND r.is_active = TRUE
      ORDER BY r.next_due_date ASC
    `, [userId]);

    let unpaidRecurringMinor = 0;
    const dueRecurringRules = recurringRows.map((r) => {
      const amt = Number(r.default_amount_minor);
      const isDueInCycle = r.next_due_date <= cycleEnd;
      if (isDueInCycle && r.type === 'EXPENSE') unpaidRecurringMinor += amt;
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

    const txRows = await queryAll(`
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
      WHERE t.user_id = $1
      ORDER BY t.occurred_on DESC, t.created_at DESC
      LIMIT 100
    `, [userId]);

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

  async function listTransactions(userId, { limit = 30, offset = 0, type = 'ALL', search = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const whereClauses = ['t.user_id = $1'];
    const params = [userId];
    let pIdx = 2;

    if (type === 'EXPENSE') {
      whereClauses.push(`t.type IN ('EXPENSE', 'REFUND')`);
    } else if (type === 'INCOME' || type === 'TRANSFER') {
      whereClauses.push(`t.type = $${pIdx++}`);
      params.push(type);
    }

    const trimmedSearch = String(search || '').trim();
    if (trimmedSearch) {
      const pattern = `%${trimmedSearch.toLowerCase()}%`;
      whereClauses.push(`(
        LOWER(COALESCE(t.note, '')) LIKE $${pIdx}
        OR LOWER(COALESCE(c.name, '')) LIKE $${pIdx + 1}
        OR LOWER(COALESCE(a.name, '')) LIKE $${pIdx + 2}
        OR LOWER(COALESCE(da.name, '')) LIKE $${pIdx + 3}
      )`);
      params.push(pattern, pattern, pattern, pattern);
      pIdx += 4;
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = await queryOne(`
      SELECT COUNT(*) AS total
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts da ON da.id = t.transfer_destination_account_id
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${whereSql}
    `, params);

    const totalCount = Number(countRow?.total ?? 0);

    const rows = await queryAll(`
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
      LIMIT $${pIdx} OFFSET $${pIdx + 1}
    `, [...params, safeLimit, safeOffset]);

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

  async function exportLedgerCsv(userId) {
    const rows = await queryAll(`
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
      WHERE le.user_id = $1 AND le.voided_at IS NULL
      ORDER BY le.occurred_on ASC, le.created_at ASC
    `, [userId]);

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
    isAsync: true,
    pool,
    init,
    healthCheck,
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
    createPasswordResetToken,
    consumePasswordResetToken,
    createEmailVerificationCode,
    verifyEmailCode,
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
