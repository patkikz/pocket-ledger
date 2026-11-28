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

test('registerUser defaults to unverified and blocks authenticateUser until verified', () => {
  const ledger = createLedgerDb(':memory:');
  try {
    const user = ledger.registerUser({
      email: 'new.user@example.com',
      password: 'password-1234',
    });
    assert.equal(user.emailVerified, false);

    assert.throws(
      () => ledger.authenticateUser({ email: 'new.user@example.com', password: 'password-1234' }),
      (err) => err.code === 'EMAIL_NOT_VERIFIED' && err.statusCode === 403
    );

    // Wrong password still returns null instead of leaking verification status
    assert.equal(
      ledger.authenticateUser({ email: 'new.user@example.com', password: 'wrong-password' }),
      null
    );

    const otp = ledger.createEmailVerificationCode('new.user@example.com');
    assert.match(otp.code, /^\d{6}$/);

    const verifiedUser = ledger.verifyEmailCode({ email: 'new.user@example.com', code: otp.code });
    assert.equal(verifiedUser.id, user.id);
    assert.equal(verifiedUser.emailVerified, true);

    const authed = ledger.authenticateUser({ email: 'new.user@example.com', password: 'password-1234' });
    assert.equal(authed.id, user.id);
  } finally {
    ledger.db.close();
  }
});

test('verifyEmailCode enforces 5-attempt cap, expiry, and invalidates prior codes on resend', () => {
  const ledger = createLedgerDb(':memory:');
  try {
    ledger.registerUser({ email: 'otp.guard@example.com', password: 'password-1234' });

    const first = ledger.createEmailVerificationCode('otp.guard@example.com');
    const second = ledger.createEmailVerificationCode('otp.guard@example.com');

    // First code invalidated when second was issued
    if (first.code !== second.code) {
      assert.throws(
        () => ledger.verifyEmailCode({ email: 'otp.guard@example.com', code: first.code }),
        /invalid/i
      );
    }

    // 5 wrong attempts lock/invalidate the current code
    const fresh = ledger.createEmailVerificationCode('otp.guard@example.com');
    const wrongCode = fresh.code === '000000' ? '999999' : '000000';
    for (let i = 0; i < 5; i += 1) {
      assert.throws(
        () => ledger.verifyEmailCode({ email: 'otp.guard@example.com', code: wrongCode }),
        /invalid|too many/i
      );
    }

    // Even the real code no longer works after 5 wrong guesses
    assert.throws(
      () => ledger.verifyEmailCode({ email: 'otp.guard@example.com', code: fresh.code }),
      /too many|request a new code|invalid/i
    );

    // Expired code is rejected
    const expired = ledger.createEmailVerificationCode('otp.guard@example.com', { ttlMinutes: -1 });
    assert.throws(
      () => ledger.verifyEmailCode({ email: 'otp.guard@example.com', code: expired.code }),
      /expired|invalid/i
    );
  } finally {
    ledger.db.close();
  }
});

test('HTTP register -> unverified login blocked -> verify-email issues session -> resend works', async () => {
  const sentCodes = [];
  const { handler, ledger } = createAppHandler({
    dbPath: ':memory:',
    mailer: {
      async sendPasswordResetEmail() { return { delivered: false, mode: 'mock' }; },
      async sendEmailVerificationCode(payload) {
        sentCodes.push(payload);
        return { delivered: true, mode: 'mock' };
      },
    },
  });

  try {
    // 1. Register returns 201 without session cookie
    const regRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.0.1' },
      body: { email: 'verify.me@example.com', password: 'password-1234' },
    });
    assert.equal(regRes.status, 201);
    assert.equal(regRes.headers['set-cookie'], undefined);
    assert.equal(regRes.json().requiresVerification, true);
    assert.equal(sentCodes.length, 1);
    assert.match(sentCodes[0].code, /^\d{6}$/);

    // 2. Login before verification returns 403 EMAIL_NOT_VERIFIED and auto-sends a fresh OTP
    const loginBeforeRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.0.2' },
      body: { email: 'verify.me@example.com', password: 'password-1234' },
    });
    assert.equal(loginBeforeRes.status, 403);
    assert.equal(loginBeforeRes.json().code, 'EMAIL_NOT_VERIFIED');
    assert.equal(loginBeforeRes.json().codeSent, true);
    assert.equal(loginBeforeRes.headers['set-cookie'], undefined);
    assert.equal(sentCodes.length, 2);

    // 3. Resend issues a new code
    const resendRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/resend-verification',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.0.3' },
      body: { email: 'verify.me@example.com' },
    });
    assert.equal(resendRes.status, 200);
    assert.equal(sentCodes.length, 3);

    // 4. Verify with newest code sets session cookie and authenticates /api/dashboard
    const verifyRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/verify-email',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.0.4' },
      body: { email: 'verify.me@example.com', code: sentCodes[2].code },
    });
    assert.equal(verifyRes.status, 200);
    assert.ok(verifyRes.headers['set-cookie']);
    assert.equal(verifyRes.json().user.emailVerified, true);

    const cookie = verifyRes.headers['set-cookie'].split(';')[0];
    const dashRes = await invokeHandler(handler, {
      method: 'GET',
      url: '/api/dashboard',
      headers: { cookie },
    });
    assert.equal(dashRes.status, 200);
  } finally {
    ledger.db.close();
  }
});
