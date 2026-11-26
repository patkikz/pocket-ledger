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
};

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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function createAppHandler({ dbPath = path.join(__dirname, '..', 'pocket-ledger.sqlite') } = {}) {
  const ledger = createLedgerDb(dbPath);
  const { demoUserId, secondUserId, personalUserId } = seedDefaultTenants(ledger);

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const userId = req.headers['x-user-id'] || url.searchParams.get('userId') || demoUserId;

      if (url.pathname.startsWith('/api/')) {
        const user = ledger.getUser(userId);
        if (!user) {
          return sendJson(res, 403, { error: `Access denied: tenant '${userId}' does not exist` });
        }

        if (req.method === 'GET' && url.pathname === '/api/dashboard') {
          const refDate = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
          const dash = ledger.getCycleDashboard(userId, refDate);
          const integrityAudits = dash.accounts.map((a) => ledger.verifyAccountIntegrity(userId, a.id));
          return sendJson(res, 200, {
            ...dash,
            integrityAudits,
            availableTenants: [
              { id: demoUserId, label: 'Demo: Patrick (USD • 1st)' },
              { id: secondUserId, label: 'Demo: Alex (PHP • 15th)' },
              { id: personalUserId, label: 'My Personal Budget (Clean Slate)' },
            ],
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
          return sendJson(res, 201, {
            transaction: tx,
            categoryRemainingCapMinor: catSummary ? catSummary.remainingCapMinor : null,
            dashboard: dash,
          });
        }

        const voidMatch = url.pathname.match(/^\/api\/transactions\/([^/]+)\/void$/);
        if (req.method === 'POST' && voidMatch) {
          const txId = voidMatch[1];
          try {
            const voided = ledger.voidTransaction(userId, txId);
            return sendJson(res, 200, { transaction: voided });
          } catch (err) {
            return sendJson(res, 403, { error: err.message });
          }
        }

        const recurringPostMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)\/post$/);
        if (req.method === 'POST' && recurringPostMatch) {
          const ruleId = recurringPostMatch[1];
          const body = await readJsonBody(req);
          const result = ledger.postRecurringRule(userId, ruleId, body);
          return sendJson(res, 200, result);
        }

        const recurringSkipMatch = url.pathname.match(/^\/api\/recurring\/([^/]+)\/skip$/);
        if (req.method === 'POST' && recurringSkipMatch) {
          const ruleId = recurringSkipMatch[1];
          const rule = ledger.skipRecurringRuleCycle(userId, ruleId);
          return sendJson(res, 200, { rule });
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
          return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && url.pathname === '/api/accounts') {
          const body = await readJsonBody(req);
          const account = ledger.createAccount(userId, {
            name: body.name,
            type: body.type,
            initialBalanceMinor: Number(body.initialBalanceMinor || 0),
            includeInSafeToSpend: body.includeInSafeToSpend,
          });
          return sendJson(res, 201, { account });
        }

        if (req.method === 'POST' && url.pathname === '/api/categories') {
          const body = await readJsonBody(req);
          const category = ledger.createCategory(userId, {
            name: body.name,
            kind: body.kind || 'EXPENSE',
            monthlyCapMinor: body.monthlyCapMinor !== null && body.monthlyCapMinor !== undefined ? Number(body.monthlyCapMinor) : null,
            color: body.color || '#6366f1',
          });
          return sendJson(res, 201, { category });
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
          return sendJson(res, 200, { category });
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
          return sendJson(res, 201, { rule });
        }

        if (req.method === 'POST' && url.pathname === '/api/settings') {
          const body = await readJsonBody(req);
          const updatedUser = ledger.updateUserSettings(userId, {
            homeCurrencyCode: body.homeCurrencyCode,
            budgetCycleStartDay: body.budgetCycleStartDay,
          });
          return sendJson(res, 200, { user: updatedUser });
        }

        if (req.method === 'GET' && url.pathname === '/api/export.csv') {
          const csv = ledger.exportLedgerCsv(userId);
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="pocket-ledger-${userId}.csv"`,
          });
          return res.end(csv);
        }

        return sendJson(res, 404, { error: 'API endpoint not found' });
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
  const port = Number(process.env.PORT || 3000);
  const { server } = createAppServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`PocketLedger V1 running at http://127.0.0.1:${port}`);
  });
}
