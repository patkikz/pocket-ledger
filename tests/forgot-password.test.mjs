import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLedgerDb } from '../src/ledger.mjs';
import { createAppHandler } from '../src/server.mjs';

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
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
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

test('createPasswordResetToken returns null for unknown or demo emails', () => {
  const ledger = createLedgerDb(':memory:');
  try {
    assert.equal(ledger.createPasswordResetToken('missing@example.com'), null);

    ledger.createUser({
      id: 'demo-1',
      email: 'patrick@pocketledger.app',
      homeCurrencyCode: 'USD',
    });
    assert.equal(ledger.createPasswordResetToken('patrick@pocketledger.app'), null);
  } finally {
    ledger.db.close();
  }
});

test('createPasswordResetToken issues single-use token and invalidates prior unused tokens', () => {
  const ledger = createLedgerDb(':memory:');
  try {
    const user = ledger.registerUser({
      email: 'alice@example.com',
      password: 'old-password-123',
    });

    const first = ledger.createPasswordResetToken('Alice@Example.com');
    assert.ok(first?.rawToken);
    assert.equal(first.email, 'alice@example.com');
    assert.ok(new Date(first.expiresAt).getTime() > Date.now());

    const second = ledger.createPasswordResetToken('alice@example.com');
    assert.ok(second?.rawToken);
    assert.notEqual(second.rawToken, first.rawToken);

    // First token was invalidated when second was issued
    assert.throws(
      () => ledger.consumePasswordResetToken({ token: first.rawToken, newPassword: 'new-password-456' }),
      /invalid or expired/i
    );

    // Create a session before reset to verify all sessions are revoked
    const session = ledger.createSession(user.id);
    assert.equal(ledger.getSessionByToken(session.rawToken).userId, user.id);

    const ok = ledger.consumePasswordResetToken({
      token: second.rawToken,
      newPassword: 'new-password-456',
    });
    assert.equal(ok, true);

    // Old session is revoked
    assert.equal(ledger.getSessionByToken(session.rawToken), null);

    // Password was updated
    assert.equal(ledger.authenticateUser({ email: 'alice@example.com', password: 'old-password-123' }), null);
    assert.equal(ledger.authenticateUser({ email: 'alice@example.com', password: 'new-password-456' }).id, user.id);

    // Second attempt with the same token fails (single-use)
    assert.throws(
      () => ledger.consumePasswordResetToken({ token: second.rawToken, newPassword: 'another-password-789' }),
      /invalid or expired/i
    );
  } finally {
    ledger.db.close();
  }
});

test('consumePasswordResetToken rejects expired tokens and short passwords', () => {
  const ledger = createLedgerDb(':memory:');
  try {
    ledger.registerUser({
      email: 'bob@example.com',
      password: 'initial-password-1',
    });

    const expired = ledger.createPasswordResetToken('bob@example.com', { ttlMinutes: -1 });
    assert.throws(
      () => ledger.consumePasswordResetToken({ token: expired.rawToken, newPassword: 'new-password-2' }),
      /invalid or expired/i
    );

    const valid = ledger.createPasswordResetToken('bob@example.com', { ttlMinutes: 30 });
    assert.throws(
      () => ledger.consumePasswordResetToken({ token: valid.rawToken, newPassword: 'short' }),
      /at least 8 characters/i
    );
  } finally {
    ledger.db.close();
  }
});

test('POST /api/auth/forgot-password and /api/auth/reset-password full HTTP flow', async () => {
  const sentEmails = [];
  const { handler, ledger } = createAppHandler({
    dbPath: ':memory:',
    mailer: {
      async sendPasswordResetEmail(payload) {
        sentEmails.push(payload);
        return { delivered: true, mode: 'mock' };
      },
    },
  });

  try {
    // Register a normal user and verify login works
    const regRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
      body: { email: 'reset.user@example.com', password: 'old-password-123' },
    });
    assert.equal(regRes.status, 201);
    const oldCookie = regRes.headers['set-cookie'].split(';')[0];

    // Unregistered email returns identical 200 without sending email
    const unknownRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/forgot-password',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.2', host: 'pocketledger.test' },
      body: { email: 'nobody@example.com' },
    });
    assert.equal(unknownRes.status, 200);
    assert.equal(unknownRes.json().ok, true);
    assert.equal(sentEmails.length, 0);

    // Demo email returns identical 200 without sending email
    const demoRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/forgot-password',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.3', host: 'pocketledger.test' },
      body: { email: 'patrick@pocketledger.app' },
    });
    assert.equal(demoRes.status, 200);
    assert.equal(demoRes.json().ok, true);
    assert.equal(sentEmails.length, 0);

    // Registered user receives reset link email
    const forgotRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/forgot-password',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.4',
        'x-forwarded-proto': 'https',
        host: 'pocketledger.test',
      },
      body: { email: 'reset.user@example.com' },
    });
    assert.equal(forgotRes.status, 200);
    assert.equal(forgotRes.json().ok, true);
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, 'reset.user@example.com');
    const resetUrl = new URL(sentEmails[0].resetUrl);
    assert.equal(resetUrl.origin, 'https://pocketledger.test');
    const token = resetUrl.searchParams.get('resetToken');
    assert.ok(token);

    // Complete password reset
    const resetRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.4' },
      body: { token, newPassword: 'new-password-456' },
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json().ok, true);

    // Old session cookie is invalidated
    const meRes = await invokeHandler(handler, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: oldCookie },
    });
    assert.equal(meRes.json().authenticated, false);

    // Login succeeds with new password
    const loginRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.5' },
      body: { email: 'reset.user@example.com', password: 'new-password-456' },
    });
    assert.equal(loginRes.status, 200);

    // Token cannot be reused
    const reuseRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.4' },
      body: { token, newPassword: 'another-password-789' },
    });
    assert.equal(reuseRes.status, 400);
  } finally {
    ledger.db.close();
  }
});

test('POST /api/auth/forgot-password rate limits repeated requests with 429', async () => {
  const { handler, ledger } = createAppHandler({
    dbPath: ':memory:',
    mailer: { async sendPasswordResetEmail() { return { delivered: false, mode: 'mock' }; } },
  });

  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await invokeHandler(handler, {
        method: 'POST',
        url: '/api/auth/forgot-password',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.99' },
        body: { email: 'spam@example.com' },
      });
      assert.equal(res.status, 200);
    }

    const blocked = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/forgot-password',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.99' },
      body: { email: 'spam@example.com' },
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers['retry-after']);
    assert.ok(blocked.json().retryAfterSeconds > 0);
  } finally {
    ledger.db.close();
  }
});
