import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
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

function openSseStream(handler, cookie) {
  const req = new PassThrough();
  req.method = 'GET';
  req.url = '/api/events';
  req.headers = { cookie };

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
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    },
    close() {
      req.emit('close');
    },
  };

  Promise.resolve(handler(req, res));
  return {
    get status() { return statusCode; },
    headers: resHeaders,
    getOutput() { return chunks.join(''); },
    close() { req.emit('close'); },
  };
}

test('GET /api/events rejects unauthenticated requests with 401', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });
  const res = await invokeHandler(handler, { method: 'GET', url: '/api/events' });
  assert.equal(res.status, 401);
});

test('SSE /api/events broadcasts ledger_updated only to the same authenticated user across devices', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });

  // Login User A (Patrick) and User B (Alex)
  const loginA = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: { email: 'patrick@pocketledger.app', password: 'pocketledger-demo' },
  });
  const cookieA = loginA.headers['set-cookie'].split(';')[0];

  const loginB = await invokeHandler(handler, {
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: { email: 'alex.isolated@pocketledger.app', password: 'pocketledger-demo' },
  });
  const cookieB = loginB.headers['set-cookie'].split(';')[0];

  const streamA = openSseStream(handler, cookieA);
  const streamB = openSseStream(handler, cookieB);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(streamA.status, 200);
  assert.match(streamA.headers['content-type'], /text\/event-stream/);

  // User A records a transaction
  const dashA = (await invokeHandler(handler, { url: '/api/dashboard', headers: { cookie: cookieA } })).json();
  await invokeHandler(handler, {
    method: 'POST',
    url: '/api/transactions',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: {
      type: 'EXPENSE',
      amountMinor: 500,
      accountId: dashA.smartDefaults.accountId,
      categoryId: dashA.smartDefaults.categoryId,
      occurredOn: '2026-11-27',
      note: 'Realtime coffee',
    },
  });

  await new Promise((r) => setTimeout(r, 20));

  assert.match(streamA.getOutput(), /event: ledger_updated/);
  assert.doesNotMatch(streamB.getOutput(), /event: ledger_updated/);

  streamA.close();
  streamB.close();
});
