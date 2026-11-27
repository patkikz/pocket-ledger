import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedgerDb } from './ledger.mjs';
import { seedDefaultTenants } from './seed.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const SESSION_COOKIE_NAME = 'pl_session';
const SESSION_MAX_AGE_SECONDS = 2592000; // 30 days
const DEMO_EMAILS = new Set([
  'patrick@pocketledger.app',
  'alex.isolated@pocketledger.app',
]);

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header || typeof header !== 'string') {
    return {};
  }
  const cookies = {};
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    if (!name) continue;
    const rawVal = part.slice(eqIdx + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawVal);
    } catch {
      cookies[name] = rawVal;
    }
  }
  return cookies;
}

function isSecureRequest(req) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwardedProto === 'https' || Boolean(req.socket?.encrypted);
}

function buildSessionCookie(rawToken, req, maxAgeSeconds = SESSION_MAX_AGE_SECONDS) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken || '')}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export function createAppHandler({
  dbPath = path.join(__dirname, '..', 'pocket-ledger.sqlite'),
  disableDemo = process.env.DISABLE_DEMO === '1',
} = {}) {
  const ledger = createLedgerDb(dbPath);
  const { demoUserId, secondUserId, personalUserId } = seedDefaultTenants(ledger, { disableDemo });
  const demoEnabled = !disableDemo;

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const cookies = parseCookies(req);
      const rawToken = cookies[SESSION_COOKIE_NAME] || null;

      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJsonBody(req);
        let user;
        try {
          user = ledger.registerUser({
            email: body.email,
            password: body.password,
            ...(body.homeCurrencyCode !== undefined ? { homeCurrencyCode: body.homeCurrencyCode } : {}),
            ...(body.budgetCycleStartDay !== undefined ? { budgetCycleStartDay: body.budgetCycleStartDay } : {}),
          });
        } catch (err) {
          const status = err.statusCode || (err.code === 'DUPLICATE_EMAIL' ? 409 : 400);
          return sendJson(res, status, { error: err.message || 'Registration failed' });
        }
        const { rawToken: sessionToken } = ledger.createSession(user.id);
        return sendJson(res, 201, { user }, { 'set-cookie': buildSessionCookie(sessionToken, req) });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        const normalizedEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (disableDemo && DEMO_EMAILS.has(normalizedEmail)) {
          return sendJson(res, 403, { error: 'Demo accounts are disabled' });
        }
        const user = ledger.authenticateUser({
          email: body.email,
          password: body.password,
        });
        if (!user) {
          return sendJson(res, 401, { error: 'Invalid email or password' });
        }
        const { rawToken: sessionToken } = ledger.createSession(user.id);
        return sendJson(res, 200, { user }, { 'set-cookie': buildSessionCookie(sessionToken, req) });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        if (rawToken) {
          ledger.deleteSessionByToken(rawToken);
        }
        return sendJson(res, 200, { ok: true }, { 'set-cookie': buildSessionCookie('', req, 0) });
      }

      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const session = rawToken ? ledger.getSessionByToken(rawToken) : null;
        const user = session ? ledger.getUser(session.userId) : null;
        if (!session || !user) {
          return sendJson(res, 200, { authenticated: false, user: null, demoEnabled });
        }
        const renewal = ledger.renewSessionIfNeeded(session.id);
        const extraHeaders = renewal?.renewed ? { 'set-cookie': buildSessionCookie(rawToken, req) } : {};
        return sendJson(res, 200, { authenticated: true, user, demoEnabled }, extraHeaders);
      }

      if (url.pathname.startsWith('/api/')) {
        const session = rawToken ? ledger.getSessionByToken(rawToken) : null;
        const user = session ? ledger.getUser(session.userId) : null;
        if (!session || !user) {
          return sendJson(res, 401, { error: 'Authentication required' });
        }
        const userId = session.userId;
        const renewal = ledger.renewSessionIfNeeded(session.id);
        const authHeaders = renewal?.renewed ? { 'set-cookie': buildSessionCookie(rawToken, req) } : {};
        const replyJson = (statusCode, payload) => sendJson(res, statusCode, payload, authHeaders);

        if (req.method === 'GET' && url.pathname === '/api/dashboard') {
          const refDate = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
          const dash = ledger.getCycleDashboard(userId, refDate);
          const integrityAudits = dash.accounts.map((a) => ledger.verifyAccountIntegrity(userId, a.id));
          return replyJson(200, {
            ...dash,
            integrityAudits,
          });
        }

        if (req.method === 'POST' && url.pathname === '/api/transactions') {
          const body = await readJsonBody(req);
          const tx = ledger.recordTransaction(userId, {
            type: body.type,
            amountMinor: Number(body.amountMinor),
            accountId: body.accountId,
            transferDestinationAccountId: body.transferDestinationAccountId || null,
            categoryId: body.categoryId || null,
            occurredOn: body.occurredOn || new Date().toISOString().slice(0, 10),
            note: body.note || '',
          });

          const dash = ledger.getCycleDashboard(userId, tx.occurredOn);
          const catSummary = dash.categories.find((c) => c.id === tx.categoryId);
          return replyJson(201, {
            transaction: tx,
            categoryRemainingCapMinor: catSummary ? catSummary.remainingCapMinor : null,
            dashboard: dash,
          });
        }

        const txPatchMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)$/);
        if (req.method === 'PATCH' && txPatchMatch) {
          const txId = txPatchMatch[1];
          const body = await readJsonBody(req);
          try {
            const updated = ledger.updateTransaction(userId, txId, {
              amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
              categoryId: body.categoryId !== undefined ? body.categoryId : undefined,
              occurredOn: body.occurredOn !== undefined ? body.occurredOn : undefined,
              note: body.note !== undefined ? body.note : undefined,
            });
            return replyJson(200, { transaction: updated });
          } catch (err) {
            const status = /access denied|not found/i.test(err.message) ? 403 : 400;
            return replyJson(status, { error: err.message });
          }
        }

        const accPatchMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
        if (req.method === 'PATCH' && accPatchMatch) {
          const accountId = accPatchMatch[1];
          const body = await readJsonBody(req);
          try {
            const account = ledger.updateAccount(userId, accountId, {
              name: body.name,
              includeInSafeToSpend: body.includeInSafeToSpend,
              isArchived: body.isArchived,
            });
            return replyJson(200, { account });
          } catch (err) {
            const status = /access denied|not found/i.test(err.message) ? 403 : 400;
            return replyJson(status, { error: err.message });
          }
        }

        const catPatchMatch = url.pathname.match(/^\/api\/categories\/([^/]+)$/);
        if (req.method === 'PATCH' && catPatchMatch) {
          const categoryId = catPatchMatch[1];
          const body = await readJsonBody(req);
          try {
            const category = ledger.updateCategory(userId, categoryId, {
              name: body.name,
              monthlyCapMinor: body.monthlyCapMinor !== undefined
                ? (body.monthlyCapMinor !== null ? Number(body.monthlyCapMinor) : null)
                : undefined,
            });
            return replyJson(200, { category });
          } catch (err) {
            const status = /access denied|not found/i.test(err.message) ? 403 : 400;
            return replyJson(status, { error: err.message });
          }
        }

        const recurringPatchMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)$/);
        if (req.method === 'PATCH' && recurringPatchMatch) {
          const ruleId = recurringPatchMatch[1];
          const body = await readJsonBody(req);
          try {
            const rule = ledger.updateRecurringRule(userId, ruleId, {
              title: body.title,
              defaultAmountMinor: body.defaultAmountMinor !== undefined ? Number(body.defaultAmountMinor) : undefined,
              accountId: body.accountId,
              categoryId: body.categoryId,
              nextDueDate: body.nextDueDate,
              isActive: body.isActive,
            });
            return replyJson(200, { rule });
          } catch (err) {
            const status = /access denied|not found/i.test(err.message) ? 403 : 400;
            return replyJson(status, { error: err.message });
          }
        }

        const voidMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)\/void$/);
        if (req.method === 'POST' && voidMatch) {
          const txId = voidMatch[1];
          try {
            const voided = ledger.voidTransaction(userId, txId);
            return replyJson(200, { transaction: voided });
          } catch (err) {
            return replyJson(403, { error: err.message });
          }
        }

        const recurringPostMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)\/post$/);
        if (req.method === 'POST' && recurringPostMatch) {
          const ruleId = recurringPostMatch[1];
          const body = await readJsonBody(req);
          const result = ledger.postRecurringRule(userId, ruleId, body);
          return replyJson(200, result);
        }

        const recurringSkipMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)\/skip$/);
        if (req.method === 'POST' && recurringSkipMatch) {
          const ruleId = recurringSkipMatch[1];
          const rule = ledger.skipRecurringRuleCycle(userId, ruleId);
          return replyJson(200, { rule });
        }

        if (req.method === 'POST' && url.pathname === '/api/accounts/reconcile') {
          const body = await readJsonBody(req);
          const result = ledger.reconcileAccountBalance(
            userId,
            body.accountId,
            Number(body.actualBalanceMinor),
            body.occurredOn || new Date().toISOString().slice(0, 10),
            body.note || 'Weekly Desktop Balance Reconciliation'
          );
          return replyJson(200, result);
        }

        if (req.method === 'POST' && url.pathname === '/api/accounts') {
          const body = await readJsonBody(req);
          const account = ledger.createAccount(userId, {
            name: body.name,
            type: body.type,
            initialBalanceMinor: Number(body.initialBalanceMinor || 0),
            includeInSafeToSpend: body.includeInSafeToSpend,
          });
          return replyJson(201, { account });
        }

        if (req.method === 'POST' && url.pathname === '/api/categories') {
          const body = await readJsonBody(req);
          const category = ledger.createCategory(userId, {
            name: body.name,
            kind: body.kind || 'EXPENSE',
            monthlyCapMinor: body.monthlyCapMinor !== null && body.monthlyCapMinor !== undefined ? Number(body.monthlyCapMinor) : null,
            color: body.color || '#6366f1',
          });
          return replyJson(201, { category });
        }

        const catCapMatch = url.pathname.match(/^\/api\/categories\/([^/]+)\/cap$/);
        if (req.method === 'POST' && catCapMatch) {
          const categoryId = catCapMatch[1];
          const body = await readJsonBody(req);
          const category = ledger.updateCategoryCap(
            userId,
            categoryId,
            body.monthlyCapMinor !== null && body.monthlyCapMinor !== undefined ? Number(body.monthlyCapMinor) : null
          );
          return replyJson(200, { category });
        }

        if (req.method === 'POST' && url.pathname === '/api/recurring') {
          const body = await readJsonBody(req);
          const rule = ledger.createRecurringRule(userId, {
            title: body.title,
            type: body.type || 'EXPENSE',
            defaultAmountMinor: Number(body.defaultAmountMinor),
            accountId: body.accountId,
            categoryId: body.categoryId || null,
            frequency: body.frequency || 'MONTHLY',
            nextDueDate: body.nextDueDate,
          });
          return replyJson(201, { rule });
        }

        if (req.method === 'POST' && url.pathname === '/api/settings') {
          const body = await readJsonBody(req);
          const updatedUser = ledger.updateUserSettings(userId, {
            homeCurrencyCode: body.homeCurrencyCode,
            budgetCycleStartDay: body.budgetCycleStartDay,
          });
          return replyJson(200, { user: updatedUser });
        }

        if (req.method === 'GET' && url.pathname === '/api/export.csv') {
          const csv = ledger.exportLedgerCsv(userId);
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="pocket-ledger-${userId}.csv"`,
            ...authHeaders,
          });
          return res.end(csv);
        }

        return replyJson(404, { error: 'API endpoint not found' });
      }

      // Static file server for PWA frontend
      const safePath = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));
      if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }

      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(fs.readFileSync(filePath));
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Bad request' });
    }
  };

  return { handler, ledger, demoUserId, secondUserId, personalUserId };
}

export function createAppServer(opts = {}) {
  const { handler, ledger, demoUserId, secondUserId, personalUserId } = createAppHandler(opts);
  const server = http.createServer(handler);
  return { server, handler, ledger, demoUserId, secondUserId, personalUserId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const { server } = createAppServer();
  server.listen(port, host, () => {
    console.log(`PocketLedger V1 running at http://${host}:${port}`);
  });
}
