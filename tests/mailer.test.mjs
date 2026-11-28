import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailer } from '../src/mailer.mjs';

test('mailer sends password reset email via Resend HTTP API when configured', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: 'email_123' };
      },
    };
  };

  const mailer = createMailer({
    apiKey: 're_test_key',
    from: 'PocketLedger <no-reply@example.com>',
    fetchImpl,
  });

  const result = await mailer.sendPasswordResetEmail({
    to: 'user@example.com',
    resetUrl: 'https://app.example.com/?resetToken=abc123',
    expiresMinutes: 30,
  });

  assert.equal(result.delivered, true);
  assert.equal(result.mode, 'resend');
  assert.equal(result.id, 'email_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_test_key');

  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.from, 'PocketLedger <no-reply@example.com>');
  assert.deepEqual(payload.to, ['user@example.com']);
  assert.match(payload.subject, /reset/i);
  assert.match(payload.text, /https:\/\/app\.example\.com\/\?resetToken=abc123/);
  assert.match(payload.html, /https:\/\/app\.example\.com\/\?resetToken=abc123/);
});

test('mailer throws on non-2xx Resend API response', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 422,
    async text() {
      return '{"message":"Invalid from address"}';
    },
  });

  const mailer = createMailer({
    apiKey: 're_test_key',
    from: 'bad@example.com',
    fetchImpl,
  });

  await assert.rejects(
    () =>
      mailer.sendPasswordResetEmail({
        to: 'user@example.com',
        resetUrl: 'https://app.example.com/?resetToken=abc123',
      }),
    /422/
  );
});

test('mailer falls back to console mode when RESEND_API_KEY is not configured', async () => {
  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  };

  const logs = [];
  const mailer = createMailer({
    apiKey: '',
    from: '',
    fetchImpl,
    logger: { info: (msg) => logs.push(msg) },
  });

  const result = await mailer.sendPasswordResetEmail({
    to: 'user@example.com',
    resetUrl: 'http://localhost:3000/?resetToken=local123',
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.delivered, false);
  assert.equal(result.mode, 'console');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /local123/);
});

test('mailer sends 6-digit email verification code via Resend and falls back to console', async () => {
  const calls = [];
  const resendMailer = createMailer({
    apiKey: 're_test_key',
    from: 'PocketLedger <no-reply@example.com>',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 'otp_123' };
        },
      };
    },
  });

  const res = await resendMailer.sendEmailVerificationCode({
    to: 'newuser@example.com',
    code: '482913',
    expiresMinutes: 15,
  });

  assert.equal(res.delivered, true);
  assert.equal(res.mode, 'resend');
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ['newuser@example.com']);
  assert.match(body.text, /482913/);
  assert.match(body.html, /482913/);

  const logs = [];
  const consoleMailer = createMailer({
    apiKey: '',
    from: '',
    logger: { info: (msg) => logs.push(msg) },
  });
  const localRes = await consoleMailer.sendEmailVerificationCode({
    to: 'newuser@example.com',
    code: '482913',
  });
  assert.equal(localRes.delivered, false);
  assert.equal(localRes.mode, 'console');
  assert.match(logs[0], /482913/);
});
