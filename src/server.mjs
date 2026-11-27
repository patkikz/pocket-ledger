import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedgerDb } from './ledger.mjs';
import { createPostgresLedger } from './ledger-pg.mjs';
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
  dbPath,
  databaseUrl = process.env.DATABASE_URL,
  disableDemo = process.env.DISABLE_DEMO === '1',
} = {}) {
  const usePostgres = !dbPath && Boolean(databaseUrl);
  const resolvedDbPath = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'pocket-ledger.sqlite');
  const ledger = usePostgres
    ? createPostgresLedger(databaseUrl)
    : createLedgerDb(resolvedDbPath);

  let demoUserId = null;
  let secondUserId = null;
  let personalUserId = null;
  let readyPromise = null;

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        if (ledger.init) {
          await ledger.init();
        }
        const seeded = await seedDefaultTenants(ledger, { disableDemo });
        demoUserId = seeded.demoUserId;
        secondUserId = seeded.secondUserId;
        personalUserId = seeded.personalUserId;
      })();
    }
    return readyPromise;
  }

  // Eagerly seed synchronous SQLite immediately so tests inspecting demoUserId synchronously work
  if (!ledger.isAsync) {
    const seeded = seedDefaultTenants(ledger, { disableDemo });
    demoUserId = seeded.demoUserId;
    secondUserId = seeded.secondUserId;
    personalUserId = seeded.personalUserId;
    readyPromise = Promise.resolve();
  }

  const demoEnabled = !disableDemo;
  const sseClients = new Map();

  function notifyUser(userId, reason = 'mutation') {
    const clients = sseClients.get(userId);
    if (!clients || clients.size === 0) return;
    const frame = `event: ledger_updated\ndata: ${JSON.stringify({ reason, ts: Date.now() })}\n\n`;
    for (const clientRes of clients) {
      try {
        clientRes.write(frame);
      } catch {
        clients.delete(clientRes);
      }
    }
  }

  const heartbeatTimer = setInterval(() => {
    for (const clients of sseClients.values()) {
      for (const clientRes of clients) {
        try {
          clientRes.write(': ping\n\n');
        } catch {
          clients.delete(clientRes);
        }
      }
    }
  }, 25000);
  if (typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }

  const handler = async (req, res) => {
    try {
      await ensureReady();
      const url = new URL(req.url, 'http://localhost');
      const cookies = parseCookies(req);
      const rawToken = cookies[SESSION_COOKIE_NAME] || null;

      if (req.method === 'GET' && url.pathname === '/api/health') {
        try {
          if (ledger.healthCheck) {
            await ledger.healthCheck();
          } else {
            ledger.db.prepare('SELECT 1 AS ok').get();
          }
          return sendJson(res, 200, { ok: true, status: 'healthy' });
        } catch (err) {
          return sendJson(res, 503, { ok: false, status: 'unhealthy', error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/register') {
        const body = await readJsonBody(req);
        let user;
        try {
          user = await ledger.registerUser({
            email: body.email,
            password: body.password,
            ...(body.homeCurrencyCode !== undefined ? { homeCurrencyCode: body.homeCurrencyCode } : {}),
            ...(body.budgetCycleStartDay !== undefined ? { budgetCycleStartDay: body.budgetCycleStartDay } : {}),
          });
        } catch (err) {
          const status = err.statusCode || (err.code === 'DUPLICATE_EMAIL' ? 409 : 400);
          return sendJson(res, status, { error: err.message || 'Registration failed' });
        }
        const { rawToken: sessionToken } = await ledger.createSession(user.id);
        return sendJson(res, 201, { user }, { 'set-cookie': buildSessionCookie(sessionToken, req) });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        const normalizedEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (disableDemo && DEMO_EMAILS.has(normalizedEmail)) {
          return sendJson(res, 403, { error: 'Demo accounts are disabled' });
        }
        const user = await ledger.authenticateUser({
          email: body.email,
          password: body.password,
        });
        if (!user) {
          return sendJson(res, 401, { error: 'Invalid email or password' });
        }
        const { rawToken: sessionToken } = await ledger.createSession(user.id);
        return sendJson(res, 200, { user }, { 'set-cookie': buildSessionCookie(sessionToken, req) });
      }

      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        if (rawToken) {
          await ledger.deleteSessionByToken(rawToken);
        }
        return sendJson(res, 200, { ok: true }, { 'set-cookie': buildSessionCookie('', req, 0) });
      }

      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const session = rawToken ? await ledger.getSessionByToken(rawToken) : null;
        const user = session ? await ledger.getUser(session.userId) : null;
        if (!session || !user) {
          return sendJson(res, 200, { authenticated: false, user: null, demoEnabled });
        }
        const renewal = await ledger.renewSessionIfNeeded(session.id);
        const extraHeaders = renewal?.renewed ? { 'set-cookie': buildSessionCookie(rawToken, req) } : {};
        return sendJson(res, 200, { authenticated: true, user, demoEnabled }, extraHeaders);
      }

      if (url.pathname.startsWith('/api/')) {
        const session = rawToken ? await ledger.getSessionByToken(rawToken) : null;
        const user = session ? await ledger.getUser(session.userId) : null;
        if (!session || !user) {
          return sendJson(res, 401, { error: 'Authentication required' });
        }
        const userId = session.userId;
        const renewal = await ledger.renewSessionIfNeeded(session.id);
        const authHeaders = renewal?.renewed ? { 'set-cookie': buildSessionCookie(rawToken, req) } : {};
        const replyJson = (statusCode, payload) => sendJson(res, statusCode, payload, authHeaders);

        if (req.method === 'GET' && url.pathname === '/api/events') {
          req.setTimeout?.(0);
          res.setTimeout?.(0);
          req.socket?.setKeepAlive?.(true);
          req.socket?.setNoDelay?.(true);
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            ...authHeaders,
          });
          res.flushHeaders?.();
          res.write(': connected\n\n');
          if (!sseClients.has(userId)) {
            sseClients.set(userId, new Set());
          }
          const userStreams = sseClients.get(userId);
          userStreams.add(res);
          req.on('close', () => {
            userStreams.delete(res);
            if (userStreams.size === 0) {
              sseClients.delete(userId);
            }
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/dashboard') {
          const refDate = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
          const dash = await ledger.getCycleDashboard(userId, refDate);
          const integrityAudits = await Promise.all(
            dash.accounts.map((a) => ledger.verifyAccountIntegrity(userId, a.id))
          );
          return replyJson(200, {
            ...dash,
            integrityAudits,
          });
        }

        if (req.method === 'GET' && url.pathname === '/api/transactions') {
          const limit = Number(url.searchParams.get('limit') || 30);
          const offset = Number(url.searchParams.get('offset') || 0);
          const type = url.searchParams.get('type') || 'ALL';
          const search = url.searchParams.get('q') || '';
          const result = await ledger.listTransactions(userId, { limit, offset, type, search });
          return replyJson(200, result);
        }

        if (req.method === 'POST' && url.pathname === '/api/transactions') {
          const body = await readJsonBody(req);
          const tx = await ledger.recordTransaction(userId, {
            type: body.type,
            amountMinor: Number(body.amountMinor),
            accountId: body.accountId,
            transferDestinationAccountId: body.transferDestinationAccountId || null,
            categoryId: body.categoryId || null,
            occurredOn: body.occurredOn || new Date().toISOString().slice(0, 10),
            note: body.note || '',
          });

          const dash = await ledger.getCycleDashboard(userId, tx.occurredOn);
          const catSummary = dash.categories.find((c) => c.id === tx.categoryId);
          notifyUser(userId, 'transaction_created');
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
            const updated = await ledger.updateTransaction(userId, txId, {
              amountMinor: body.amountMinor !== undefined ? Number(body.amountMinor) : undefined,
              categoryId: body.categoryId !== undefined ? body.categoryId : undefined,
              occurredOn: body.occurredOn !== undefined ? body.occurredOn : undefined,
              note: body.note !== undefined ? body.note : undefined,
            });
            notifyUser(userId, 'transaction_updated');
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
            const account = await ledger.updateAccount(userId, accountId, {
              name: body.name,
              includeInSafeToSpend: body.includeInSafeToSpend,
              isArchived: body.isArchived,
            });
            notifyUser(userId, 'account_updated');
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
            const category = await ledger.updateCategory(userId, categoryId, {
              name: body.name,
              monthlyCapMinor: body.monthlyCapMinor !== undefined
                ? (body.monthlyCapMinor !== null ? Number(body.monthlyCapMinor) : null)
                : undefined,
            });
            notifyUser(userId, 'category_updated');
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
            const rule = await ledger.updateRecurringRule(userId, ruleId, {
              title: body.title,
              defaultAmountMinor: body.defaultAmountMinor !== undefined ? Number(body.defaultAmountMinor) : undefined,
              accountId: body.accountId,
              categoryId: body.categoryId,
              nextDueDate: body.nextDueDate,
              isActive: body.isActive,
            });
            notifyUser(userId, 'recurring_updated');
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
            const voided = await ledger.voidTransaction(userId, txId);
            notifyUser(userId, 'transaction_voided');
            return replyJson(200, { transaction: voided });
          } catch (err) {
            return replyJson(403, { error: err.message });
          }
        }

        const recurringPostMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)\/post$/);
        if (req.method === 'POST' && recurringPostMatch) {
          const ruleId = recurringPostMatch[1];
          const body = await readJsonBody(req);
          const result = await ledger.postRecurringRule(userId, ruleId, body);
          notifyUser(userId, 'recurring_posted');
          return replyJson(200, result);
        }

        const recurringSkipMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)\/skip$/);
        if (req.method === 'POST' && recurringSkipMatch) {
          const ruleId = recurringSkipMatch[1];
          const rule = await ledger.skipRecurringRuleCycle(userId, ruleId);
          notifyUser(userId, 'recurring_skipped');
          return replyJson(200, { rule });
        }

        if (req.method === 'POST' && url.pathname === '/api/accounts/reconcile') {
          const body = await readJsonBody(req);
          const result = await ledger.reconcileAccountBalance(
            userId,
            body.accountId,
            Number(body.actualBalanceMinor),
            body.occurredOn || new Date().toISOString().slice(0, 10),
            body.note || 'Weekly Desktop Balance Reconciliation'
          );
          notifyUser(userId, 'account_reconciled');
          return replyJson(200, result);
        }

        if (req.method === 'POST' && url.pathname === '/api/accounts') {
          const body = await readJsonBody(req);
          const account = await ledger.createAccount(userId, {
            name: body.name,
            type: body.type,
            initialBalanceMinor: Number(body.initialBalanceMinor || 0),
            includeInSafeToSpend: body.includeInSafeToSpend,
          });
          notifyUser(userId, 'account_created');
          return replyJson(201, { account });
        }

        if (req.method === 'POST' && url.pathname === '/api/categories') {
          const body = await readJsonBody(req);
          const category = await ledger.createCategory(userId, {
            name: body.name,
            kind: body.kind || 'EXPENSE',
            monthlyCapMinor: body.monthlyCapMinor !== null && body.monthlyCapMinor !== undefined ? Number(body.monthlyCapMinor) : null,
            color: body.color || '#6366f1',
          });
          notifyUser(userId, 'category_created');
          return replyJson(201, { category });
        }

        const catCapMatch = url.pathname.match(/^\/api\/categories\/([^/]+)\/cap$/);
        if (req.method === 'POST' && catCapMatch) {
          const categoryId = catCapMatch[1];
          const body = await readJsonBody(req);
          const category = await ledger.updateCategoryCap(
            userId,
            categoryId,
            body.monthlyCapMinor !== null && body.monthlyCapMinor !== undefined ? Number(body.monthlyCapMinor) : null
          );
          notifyUser(userId, 'category_cap_updated');
          return replyJson(200, { category });
        }

        if (req.method === 'POST' && url.pathname === '/api/recurring') {
          const body = await readJsonBody(req);
          const rule = await ledger.createRecurringRule(userId, {
            title: body.title,
            type: body.type || 'EXPENSE',
            defaultAmountMinor: Number(body.defaultAmountMinor),
            accountId: body.accountId,
            categoryId: body.categoryId || null,
            frequency: body.frequency || 'MONTHLY',
            nextDueDate: body.nextDueDate,
          });
          notifyUser(userId, 'recurring_created');
          return replyJson(201, { rule });
        }

        if (req.method === 'POST' && url.pathname === '/api/settings') {
          const body = await readJsonBody(req);
          const updatedUser = await ledger.updateUserSettings(userId, {
            homeCurrencyCode: body.homeCurrencyCode,
            budgetCycleStartDay: body.budgetCycleStartDay,
          });
          notifyUser(userId, 'settings_updated');
          return replyJson(200, { user: updatedUser });
        }

        if (req.method === 'GET' && url.pathname === '/api/export.csv') {
          const csv = await ledger.exportLedgerCsv(userId);
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
      const cacheControl = ext === '.html' || ext === '.js' || ext === '.css'
        ? 'no-cache, must-revalidate'
        : 'public, max-age=3600';
      res.writeHead(200, {
        'content-type': MIME_TYPES[ext] || 'application/octet-stream',
        'cache-control': cacheControl,
      });
      res.end(fs.readFileSync(filePath));
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Bad request' });
    }
  };

  return {
    handler,
    ledger,
    ensureReady,
    get demoUserId() { return demoUserId; },
    get secondUserId() { return secondUserId; },
    get personalUserId() { return personalUserId; },
  };
}

export function createAppServer(opts = {}) {
  const app = createAppHandler(opts);
  const server = http.createServer(app.handler);
  return { server, ...app };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const { server, ensureReady } = createAppServer();
  ensureReady()
    .then(() => {
      server.listen(port, host, () => {
        console.log(`PocketLedger V1 running at http://${host}:${port}`);
      });
    })
    .catch((err) => {
      console.error('Failed to initialize PocketLedger:', err);
      process.exit(1);
    });
}
