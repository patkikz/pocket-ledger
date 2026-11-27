import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLedgerDb } from '../src/ledger.mjs';
import { createPostgresLedger } from '../src/ledger-pg.mjs';
import { seedDefaultTenants } from '../src/seed.mjs';
import { createAppHandler } from '../src/server.mjs';

async function invokeHandler(handler, { method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const rawBody = body !== null && body !== undefined
    ? (typeof body === 'string' ? body : JSON.stringify(body))
    : null;
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:3000', ...headers };

  let status = 200;
  const resHeaders = {};
  const chunks = [];
  const res = {
    writeHead(code, hdrs = {}) {
      status = code;
      for (const [k, v] of Object.entries(hdrs)) {
        resHeaders[k.toLowerCase()] = v;
      }
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      resolveDone();
    },
  };
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  await handler(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  return { status, headers: resHeaders, text, json: () => JSON.parse(text) };
}

function extractCookiePair(res) {
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header ? header.split(';')[0] : '';
}

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

test('getUser returns default profile fields and updateUserProfile validates & updates them', () => {
  const ledger = createLedgerDb(':memory:');
  try {
    const user = ledger.registerUser({ email: 'profile@example.com', password: 'password123' });
    assert.equal(user.displayName, null);
    assert.equal(user.avatarColor, '#6366f1');
    assert.equal(user.theme, 'system');
    assert.equal(user.defaultAccountId, null);

    const acc = ledger.createAccount(user.id, {
      name: 'Main Wallet',
      type: 'CASH_CHECKING',
      initialBalanceMinor: 10000,
    });
    const archivedAcc = ledger.createAccount(user.id, {
      name: 'Old Wallet',
      type: 'CASH_CHECKING',
      initialBalanceMinor: 0,
    });
    ledger.updateAccount(user.id, archivedAcc.id, { isArchived: true });

    const otherUser = ledger.registerUser({ email: 'other@example.com', password: 'password123' });
    const otherAcc = ledger.createAccount(otherUser.id, {
      name: 'Other Wallet',
      type: 'CASH_CHECKING',
      initialBalanceMinor: 0,
    });

    const updated = ledger.updateUserProfile(user.id, {
      displayName: '  Pat  ',
      avatarColor: '#10b981',
      theme: 'light',
      defaultAccountId: acc.id,
      homeCurrencyCode: 'PHP',
      budgetCycleStartDay: 15,
    });
    assert.equal(updated.displayName, 'Pat');
    assert.equal(updated.avatarColor, '#10b981');
    assert.equal(updated.theme, 'light');
    assert.equal(updated.defaultAccountId, acc.id);
    assert.equal(updated.homeCurrencyCode, 'PHP');
    assert.equal(updated.budgetCycleStartDay, 15);

    const cleared = ledger.updateUserProfile(user.id, {
      displayName: '   ',
      defaultAccountId: '',
    });
    assert.equal(cleared.displayName, null);
    assert.equal(cleared.defaultAccountId, null);

    assert.throws(() => ledger.updateUserProfile(user.id, { displayName: 'x'.repeat(61) }), RangeError);
    assert.throws(() => ledger.updateUserProfile(user.id, { avatarColor: '#000000' }), RangeError);
    assert.throws(() => ledger.updateUserProfile(user.id, { theme: 'neon' }), RangeError);
    assert.throws(() => ledger.updateUserProfile(user.id, { defaultAccountId: archivedAcc.id }));
    assert.throws(() => ledger.updateUserProfile(user.id, { defaultAccountId: otherAcc.id }));
  } finally {
    ledger.db.close();
  }
});

test('changePassword verifies current password, blocks demo accounts, and revokes other sessions', async () => {
  const ledger = createLedgerDb(':memory:');
  try {
    await seedDefaultTenants(ledger);
    const demoUser = ledger.authenticateUser({ email: 'patrick@pocketledger.app', password: 'pocketledger-demo' });
    assert.ok(demoUser);
    assert.throws(
      () => ledger.changePassword(demoUser.id, {
        currentPassword: 'pocketledger-demo',
        newPassword: 'new-password-123',
      }),
      (err) => err.statusCode === 403
    );

    const user = ledger.registerUser({ email: 'pw@example.com', password: 'old-password-1' });
    const s1 = ledger.createSession(user.id);
    const s2 = ledger.createSession(user.id);

    assert.throws(() => ledger.changePassword(user.id, {
      currentPassword: 'wrong-password',
      newPassword: 'new-password-2',
      currentSessionToken: s1.rawToken,
    }));

    assert.throws(() => ledger.changePassword(user.id, {
      currentPassword: 'old-password-1',
      newPassword: 'short',
      currentSessionToken: s1.rawToken,
    }), RangeError);

    const changed = ledger.changePassword(user.id, {
      currentPassword: 'old-password-1',
      newPassword: 'new-password-2',
      currentSessionToken: s1.rawToken,
    });
    assert.equal(changed, true);

    assert.equal(ledger.authenticateUser({ email: 'pw@example.com', password: 'old-password-1' }), null);
    assert.ok(ledger.authenticateUser({ email: 'pw@example.com', password: 'new-password-2' }));
    assert.ok(ledger.getSessionByToken(s1.rawToken), 'current session stays active');
    assert.equal(ledger.getSessionByToken(s2.rawToken), null, 'other sessions are revoked');
  } finally {
    ledger.db.close();
  }
});

test('createPostgresLedger.init adds profile columns and updateUserProfile updates parameterized fields', async () => {
  const pool = createMockPgPool((sql) => {
    if (sql.startsWith('SELECT * FROM users WHERE id = $1')) {
      return {
        rows: [{
          id: 'u1',
          email: 'pg@example.com',
          display_name: null,
          avatar_color: '#6366f1',
          theme: 'system',
          default_account_id: null,
          home_currency_code: 'USD',
          budget_cycle_start_day: 1,
          last_used_account_id: null,
          created_at: '2026-11-27T00:00:00.000Z',
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });

  const pgLedger = createPostgresLedger(null, { pool });
  await pgLedger.init();
  const alterSqls = pool.queries.map((q) => q.sql).filter((s) => s.includes('ALTER TABLE users ADD COLUMN IF NOT EXISTS'));
  assert.ok(alterSqls.some((s) => s.includes('display_name')));
  assert.ok(alterSqls.some((s) => s.includes('avatar_color')));
  assert.ok(alterSqls.some((s) => s.includes('theme')));
  assert.ok(alterSqls.some((s) => s.includes('default_account_id')));

  await pgLedger.updateUserProfile('u1', {
    displayName: 'Alex',
    avatarColor: '#38bdf8',
    theme: 'dark',
  });
  const updateQuery = pool.queries.find((q) => q.sql.startsWith('UPDATE users'));
  assert.ok(updateQuery);
  assert.equal(updateQuery.params[0], 'Alex');
  assert.equal(updateQuery.params[1], '#38bdf8');
  assert.equal(updateQuery.params[2], 'dark');
});

test('HTTP PATCH /api/profile and POST /api/auth/change-password enforce auth, validation, and demo guard', async () => {
  const { handler, ledger } = createAppHandler({ dbPath: ':memory:' });
  try {
    const unauth = await invokeHandler(handler, {
      method: 'PATCH',
      url: '/api/profile',
      headers: { 'content-type': 'application/json' },
      body: { displayName: 'Nope' },
    });
    assert.equal(unauth.status, 401);

    const reg = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      body: { email: 'http-profile@example.com', password: 'password123' },
    });
    assert.equal(reg.status, 201);
    const cookie = extractCookiePair(reg);

    const patchRes = await invokeHandler(handler, {
      method: 'PATCH',
      url: '/api/profile',
      headers: { 'content-type': 'application/json', cookie },
      body: { displayName: 'Pat', avatarColor: '#f59e0b', theme: 'light', homeCurrencyCode: 'EUR' },
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json().user.displayName, 'Pat');
    assert.equal(patchRes.json().user.avatarColor, '#f59e0b');
    assert.equal(patchRes.json().user.theme, 'light');
    assert.equal(patchRes.json().user.homeCurrencyCode, 'EUR');

    const badTheme = await invokeHandler(handler, {
      method: 'PATCH',
      url: '/api/profile',
      headers: { 'content-type': 'application/json', cookie },
      body: { theme: 'invalid' },
    });
    assert.equal(badTheme.status, 400);

    const badPw = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'content-type': 'application/json', cookie },
      body: { currentPassword: 'wrong', newPassword: 'new-password-1' },
    });
    assert.equal(badPw.status, 400);

    const okPw = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'content-type': 'application/json', cookie },
      body: { currentPassword: 'password123', newPassword: 'new-password-1' },
    });
    assert.equal(okPw.status, 200);
    assert.equal(okPw.json().ok, true);

    const demoLogin = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      body: { email: 'patrick@pocketledger.app', password: 'pocketledger-demo' },
    });
    assert.equal(demoLogin.status, 200);
    const demoCookie = extractCookiePair(demoLogin);
    const demoPw = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { 'content-type': 'application/json', cookie: demoCookie },
      body: { currentPassword: 'pocketledger-demo', newPassword: 'hacked-password' },
    });
    assert.equal(demoPw.status, 403);
  } finally {
    ledger.db.close();
  }
});

test('Frontend Profile dropdown, Account settings view markup, and service worker precache include profile assets', () => {
  const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  assert.equal(html.includes('data-view="profile"'), false);
  assert.match(html, /id="profileDropdown"/);
  assert.match(html, /id="openAccountPageBtn"/);
  assert.match(html, /id="backToDashboardBtn"/);
  assert.match(html, /id="view-profile"/);
  assert.match(html, /id="openProfileBtn"/);
  assert.equal(html.includes('id="settingsOverlay"'), false);
  for (const id of ['authPassword', 'currentPasswordInput', 'newPasswordInput', 'confirmPasswordInput']) {
    assert.match(html, new RegExp(`data-toggle-password="${id}"`));
  }

  const sw = fs.readFileSync(path.resolve('public/sw.js'), 'utf8');
  assert.match(sw, /'\/js\/profile\.js'/);
});

test('SPA routes (/accounts, /activity, /account, /account/security) serve index.html for refresh support', async () => {
  const { handler, ledger } = createAppHandler({ dbPath: ':memory:' });
  try {
    for (const route of ['/accounts', '/activity', '/account', '/account/security']) {
      const res = await invokeHandler(handler, { method: 'GET', url: route });
      assert.equal(res.status, 200, `${route} should return 200`);
      assert.match(res.text, /id="view-profile"/);
    }
  } finally {
    ledger.db.close();
  }
});
