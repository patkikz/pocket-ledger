import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createAppHandler } from '../src/server.mjs';

function invokeHandler(handler, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
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

test('GET /api/health returns 200 { ok: true } without authentication', async () => {
  const { handler } = createAppHandler({ dbPath: ':memory:' });
  const res = await invokeHandler(handler, { method: 'GET', url: '/api/health' });
  assert.equal(res.status, 200);
  const data = res.json();
  assert.equal(data.ok, true);
  assert.equal(data.status, 'healthy');
});

test('createAppHandler uses process.env.DB_PATH when dbPath option is omitted', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-ledger-dbpath-'));
  const customDbPath = path.join(tmpDir, 'custom.sqlite');
  const prevDbPath = process.env.DB_PATH;
  process.env.DB_PATH = customDbPath;

  try {
    const { ledger } = createAppHandler();
    assert.equal(fs.existsSync(customDbPath), true);
    ledger.db.close();
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = prevDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
