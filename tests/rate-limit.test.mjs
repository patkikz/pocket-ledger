import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRateLimiter } from '../src/rate-limit.mjs';
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

test('createRateLimiter blocks after maxAttempts, resets on success, and expires after windowMs', () => {
  let fakeNow = 1_000_000;
  const limiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxAttempts: 5,
    nowFn: () => fakeNow,
  });

  // Before any failures, allowed
  assert.equal(limiter.check('user-1').allowed, true);

  // Record 5 failures
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.check('user-1').allowed, true);
    limiter.recordFailure('user-1');
  }

  // 6th check is blocked
  const blocked = limiter.check('user-1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);

  // Another key is still allowed
  assert.equal(limiter.check('user-2').allowed, true);

  // Advancing time past windowMs resets user-1
  fakeNow += 15 * 60 * 1000 + 1;
  assert.equal(limiter.check('user-1').allowed, true);

  // Record 3 failures, then reset -> allowed
  limiter.recordFailure('user-1');
  limiter.recordFailure('user-1');
  limiter.recordFailure('user-1');
  limiter.reset('user-1');
  assert.equal(limiter.check('user-1').allowed, true);
});

test('HTTP POST /api/auth/login rate-limits after 5 failed attempts with 429 and Retry-After', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  for (let i = 0; i < 5; i++) {
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
      body: { email: 'patrick@pocketledger.app', password: 'wrong-password' },
    });
    assert.equal(res.status, 401);
  }

  // 6th attempt is blocked with 429
  const blockedRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
    body: { email: 'patrick@pocketledger.app', password: 'pocketledger-demo' },
  });
  assert.equal(blockedRes.status, 429);
  assert.ok(Number(blockedRes.headers['retry-after']) > 0);
  const blockedData = blockedRes.json();
  assert.match(blockedData.error, /too many/i);
  assert.ok(blockedData.retryAfterSeconds > 0);

  // Different IP can still log in normally
  const otherIpRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
    body: { email: 'patrick@pocketledger.app', password: 'pocketledger-demo' },
  });
  assert.equal(otherIpRes.status, 200);
});

test('HTTP POST /api/auth/pin/verify rate-limits after 5 wrong PINs with 429 and Retry-After', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  const regRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.5' },
    body: { email: 'pinrate@example.com', password: 'password123' },
  });
  assert.equal(regRes.status, 201);
  const cookie = regRes.headers['set-cookie'].split(';')[0];

  const setPinRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/pin',
    headers: { 'content-type': 'application/json', cookie },
    body: { pin: '4829' },
  });
  assert.equal(setPinRes.status, 200);

  for (let i = 0; i < 5; i++) {
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/pin/verify',
      headers: { 'content-type': 'application/json', cookie },
      body: { pin: '0000' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json().attemptsRemaining, 4 - i);
  }

  // 6th attempt even with right PIN is blocked with 429
  const blockedRes = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/pin/verify',
    headers: { 'content-type': 'application/json', cookie },
    body: { pin: '4829' },
  });
  assert.equal(blockedRes.status, 429);
  assert.ok(Number(blockedRes.headers['retry-after']) > 0);
  const blockedData = blockedRes.json();
  assert.match(blockedData.error, /too many/i);
  assert.ok(blockedData.retryAfterSeconds > 0);
});

test('HTTP POST /api/auth/register rate-limits excessive signups from the same IP', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  for (let i = 0; i < 10; i++) {
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.50' },
      body: { email: `spam${i}@example.com`, password: 'password123' },
    });
    assert.equal(res.status, 201);
  }

  const blocked = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.50' },
    body: { email: 'spam10@example.com', password: 'password123' },
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
});
