import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createLedgerDb } from '../src/ledger.mjs';
import { seedDefaultTenants } from '../src/seed.mjs';
import { createAppHandler } from '../src/server.mjs';

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
  ledger.registerUser({ email: 'alice@example.com', password: 'my-secret-password', emailVerified: true });

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

function invokeHandler(handler, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payloadStr = body ? JSON.stringify(body) : '';
    const req = Readable.from(payloadStr ? [Buffer.from(payloadStr)] : []);
    req.method = method;
    req.url = url;
    req.headers = headers;

    const resHeaders = {};
    let statusCode = 200;
    const chunks = [];

    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        for (const [k, v] of Object.entries(hdrs)) {
          resHeaders[k.toLowerCase()] = v;
        }
      },
      end(data) {
        if (data) {
          chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: statusCode,
          headers: resHeaders,
          text,
          json() {
            return JSON.parse(text);
          },
        });
      },
    };

    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function extractSessionCookie(res) {
  const raw = res.headers['set-cookie'];
  const headerVal = Array.isArray(raw) ? raw.find((c) => c.startsWith('pl_session=')) : raw;
  assert.ok(headerVal, 'Expected Set-Cookie header for pl_session');
  const pair = headerVal.split(';')[0];
  return { pair, full: headerVal };
}

test('HTTP auth gate: protected API routes return 401 without cookie and ignore x-user-id / ?userId=', async () => {
  const { handler, demoUserId } = createAppHandler({ dbPath: ':memory:' });

  const noAuth = await invokeHandler(handler, { method: 'GET', url: '/api/dashboard' });
  assert.equal(noAuth.status, 401);

  const headerSpoof = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard',
    headers: { 'x-user-id': demoUserId },
  });
  assert.equal(headerSpoof.status, 401);

  const querySpoof = await invokeHandler(handler, {
    method: 'GET',
    url: `/api/dashboard?userId=${encodeURIComponent(demoUserId)}`,
  });
  assert.equal(querySpoof.status, 401);

  const csvNoAuth = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/export.csv',
    headers: { 'x-user-id': demoUserId },
  });
  assert.equal(csvNoAuth.status, 401);
});

test('HTTP POST /api/auth/register creates unverified user, verifies via OTP, sets pl_session cookie, and authenticates /api/dashboard', async () => {
  const sentOtps = [];
  const { handler } = createAppHandler({
    dbPath: ':memory:',
    mailer: {
      async sendEmailVerificationCode(payload) {
        sentOtps.push(payload);
        return { delivered: true, mode: 'mock' };
      },
    },
  });

  const badRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: { email: 'newuser@example.com', password: 'short' },
  });
  assert.equal(badRes.status, 400);

  const regRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: {
      email: 'NewUser@Example.com',
      password: 'password123',
      homeCurrencyCode: 'EUR',
      budgetCycleStartDay: 5,
    },
  });
  assert.equal(regRes.status, 201);
  assert.equal(regRes.headers['set-cookie'], undefined);
  assert.equal(regRes.json().requiresVerification, true);
  assert.equal(regRes.json().email, 'newuser@example.com');

  const verifyRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/verify-email',
    headers: { 'content-type': 'application/json' },
    body: { email: 'NewUser@Example.com', code: sentOtps[0].code },
  });
  assert.equal(verifyRes.status, 200);
  const regJson = verifyRes.json();
  assert.equal(regJson.user.email, 'newuser@example.com');
  assert.equal(regJson.user.homeCurrencyCode, 'EUR');
  assert.equal(regJson.user.budgetCycleStartDay, 5);
  assert.equal('passwordHash' in regJson.user, false);
  assert.equal('password_hash' in regJson.user, false);

  const { pair, full } = extractSessionCookie(verifyRes);
  assert.match(full, /HttpOnly/);
  assert.match(full, /SameSite=Lax/);
  assert.match(full, /Max-Age=2592000/);

  const dupRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: { email: 'newuser@example.com', password: 'password123' },
  });
  assert.equal(dupRes.status, 409);

  const dashRes = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard?date=2026-11-26',
    headers: { cookie: pair },
  });
  assert.equal(dashRes.status, 200);
  const dash = dashRes.json();
  assert.equal(dash.user.id, regJson.user.id);
  assert.equal('availableTenants' in dash, false);

  // Reverse-proxy HTTPS sets Secure attribute on cookie
  const httpsRegRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: { email: 'httpsuser@example.com', password: 'password123' },
  });
  assert.equal(httpsRegRes.status, 201);
  const httpsVerifyRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/verify-email',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
    },
    body: { email: 'httpsuser@example.com', code: sentOtps[1].code },
  });
  assert.equal(httpsVerifyRes.status, 200);
  const { full: httpsCookie } = extractSessionCookie(httpsVerifyRes);
  assert.match(httpsCookie, /;\s*Secure/);
});

test('HTTP POST /api/auth/login, GET /api/auth/me, sliding renewal, and POST /api/auth/logout lifecycle', async () => {
  const { handler, ledger } = createAppHandler({ dbPath: ':memory:' });

  const meLoggedOut = await invokeHandler(handler, { method: 'GET', url: '/api/auth/me' });
  assert.equal(meLoggedOut.status, 200);
  assert.deepEqual(meLoggedOut.json(), {
    authenticated: false,
    user: null,
    demoEnabled: true,
  });

  const badLogin = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: { email: 'patrick@pocketledger.app', password: 'wrong-password' },
  });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.headers['set-cookie'], undefined);

  const goodLogin = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: { email: 'patrick@pocketledger.app', password: 'pocketledger-demo' },
  });
  assert.equal(goodLogin.status, 200);
  const loginJson = goodLogin.json();
  assert.equal(loginJson.user.email, 'patrick@pocketledger.app');
  const { pair } = extractSessionCookie(goodLogin);

  const meLoggedIn = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/auth/me',
    headers: { cookie: pair },
  });
  assert.equal(meLoggedIn.status, 200);
  assert.deepEqual(meLoggedIn.json(), {
    authenticated: true,
    user: loginJson.user,
    demoEnabled: true,
  });

  // Force session expiry under 15 days to verify sliding renewal Set-Cookie on protected request
  const tenDaysFromNow = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  ledger.db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(tenDaysFromNow, loginJson.user.id);
  const renewedDash = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard',
    headers: { cookie: pair },
  });
  assert.equal(renewedDash.status, 200);
  const { full: renewedCookie } = extractSessionCookie(renewedDash);
  assert.match(renewedCookie, /Max-Age=2592000/);

  // Logout deletes session and clears cookie
  const logoutRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: pair },
  });
  assert.equal(logoutRes.status, 200);
  assert.deepEqual(logoutRes.json(), { ok: true });
  const { full: clearedCookie } = extractSessionCookie(logoutRes);
  assert.match(clearedCookie, /Max-Age=0/);

  // Reusing old cookie now fails with 401
  const afterLogoutDash = await invokeHandler(handler, {
    method: 'GET',
    url: '/api/dashboard',
    headers: { cookie: pair },
  });
  assert.equal(afterLogoutDash.status, 401);
});

test('DISABLE_DEMO=1 disables demoEnabled in /api/auth/me and rejects demo login with 403', async () => {
  const prevDisableDemo = process.env.DISABLE_DEMO;
  process.env.DISABLE_DEMO = '1';
  try {
    const sentOtps = [];
    const { handler, demoUserId } = createAppHandler({
      dbPath: ':memory:',
      mailer: {
        async sendEmailVerificationCode(payload) {
          sentOtps.push(payload);
          return { delivered: true, mode: 'mock' };
        },
      },
    });
    assert.equal(demoUserId, null);

    const meRes = await invokeHandler(handler, { method: 'GET', url: '/api/auth/me' });
    assert.equal(meRes.status, 200);
    assert.deepEqual(meRes.json(), {
      authenticated: false,
      user: null,
      demoEnabled: false,
    });

    const demoLogin = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      body: { email: 'patrick@pocketledger.app', password: 'pocketledger-demo' },
    });
    assert.equal(demoLogin.status, 403);

    const regRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      body: { email: 'solo@example.com', password: 'password123' },
    });
    assert.equal(regRes.status, 201);
    const verifyRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      body: { email: 'solo@example.com', code: sentOtps[0].code },
    });
    assert.equal(verifyRes.status, 200);
    const { pair } = extractSessionCookie(verifyRes);

    const meAuthed = await invokeHandler(handler, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: pair },
    });
    assert.equal(meAuthed.status, 200);
    assert.equal(meAuthed.json().authenticated, true);
    assert.equal(meAuthed.json().demoEnabled, false);
  } finally {
    if (prevDisableDemo === undefined) {
      delete process.env.DISABLE_DEMO;
    } else {
      process.env.DISABLE_DEMO = prevDisableDemo;
    }
  }
});
