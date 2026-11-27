# PocketLedger

A fast, zero-dependency personal budget and expense tracker built with Node.js (`node:sqlite`, `node:http`) and an installable mobile-first PWA frontend.

## Key Features
* **Zero-Drift ACID Ledger:** All amounts are stored as 64-bit integer minor units (cents/centavos) with double-entry postings (`ledger_entries`) and soft-voiding.
* **Sub-5-Second Mobile Quick Entry:** Numeric keypad with smart defaults (`last_used_account_id` + top-used category) and desktop keyboard shortcuts.
* **Real-World Accounts & Cycle Budgets:** Cash/Checking, Savings, and Credit Cards with Safe-to-Spend calculation, custom monthly reset days (`1–28`), 1-tap recurring bills, and cycle-over-cycle spending insights.
* **Real-Time Cross-Device Sync:** Authenticated Server-Sent Events (`GET /api/events`) keep desktop and phone in sync automatically, alongside mobile pull-to-refresh and lazy-loaded Activity pagination.
* **Multi-Tenant Auth & CSV Export:** `scrypt` password hashing, 30-day `HttpOnly` session cookies, and 100% ledger CSV export.

## Requirements
* **Node.js v24+** (uses built-in `node:sqlite` and `node:test`, zero external npm dependencies).

## Running Locally

```bash
# Run the automated test suite
npm test

# Start locally on http://127.0.0.1:3000
npm start
```

### Testing on Your Phone (Same Wi-Fi)
```powershell
$env:HOST="0.0.0.0"; npm start
```
Then open `http://<your-PC-LAN-IP>:3000` on your phone.

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN or cloud containers) |
| `PORT` | `3000` | HTTP server port |
| `DATABASE_URL` | unset | PostgreSQL connection string (e.g. Supabase **Session Pooler** URI). When set, uses PostgreSQL instead of SQLite. |
| `DB_PATH` | `./pocket-ledger.sqlite` | Path to SQLite database file when `DATABASE_URL` is not set |
| `DISABLE_DEMO` | unset (`0`) | Set to `1` in production to disable demo account seeding and demo login |

## Health Check
* `GET /api/health` returns `200 { "ok": true, "status": "healthy" }` without authentication for cloud load-balancer probes.
