# Auth, Persistent Sessions & Mobile PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight multi-user registration and one-time login with 30-day persistent SQLite sessions, strict API auth enforcement, and full PWA installability for mobile home-screen use.

**Architecture:** Extend `src/ledger.mjs` with `scrypt` password hashing, SQLite `sessions` storage, and starter-category registration. Enforce cookie-based session auth across `src/server.mjs` (removing `x-user-id` / `?userId=` spoofing) with configurable `HOST`/`PORT`, gate `public/app.js` behind a mobile-first Sign In / Create Account view, and complete PWA installability with icons, manifest metadata, and an app-shell-only service worker.

**Tech Stack:** Node.js (`node:http`, `node:sqlite`, `node:crypto`, `node:test`), Vanilla HTML/CSS/JS, PWA Manifest + Service Worker.

**Spec:** [2026-11-26-auth-and-pwa-design.md](file:///c:/Users/Patpat/pocket-ledger/docs/superpowers/specs/2026-11-26-auth-and-pwa-design.md)

## Global Constraints
- Zero external npm dependencies (`package.json` stays dependency-free; use Node built-ins only).
- Additive SQLite schema migration via `PRAGMA table_info(users)` + `CREATE TABLE IF NOT EXISTS` so existing databases migrate cleanly.
- Never store plaintext passwords or plaintext session tokens in SQLite (`scryptSync` with 16-byte salt; SHA-256 hex digest for session tokens).
- Never cache `/api/*` responses in `public/sw.js` (balances and ledger mutations must always hit the network).
- Preserve existing mobile-native CSS rules in `public/styles.css` (`100dvh`, `env(safe-area-inset-*)`, `16px` inputs, capability-gated `:hover`).
- All tests in `npm test` (`node --test tests/*.test.mjs`) must pass after every task.

## Review Focus
- **Duplicate / case-variant email registration:** Registering `Alice@Example.com` when `alice@example.com` exists must normalize email (`trim().toLowerCase()`) and reject with `409 Conflict`, never creating duplicate accounts.
- **Short or missing password:** Registering with password `< 8` characters or non-string password must fail with `400 Bad Request` and clear error message.
- **Legacy `password_hash IS NULL` user row:** Attempting to log into a legacy user without a `password_hash` must fail with `401` (never throw an unhandled `TypeError` on `split(':')` or `timingSafeEqual`).
- **Expired or revoked session cookie:** An expired session row or a cookie cleared via `POST /api/auth/logout` must be rejected with `401` on protected `/api/*` routes, even if `x-user-id` header is also sent.
- **PWA service worker `/api/*` bypass:** `sw.js` must never intercept/cache `/api/*` requests so `POST /api/transactions` and `GET /api/dashboard` always reflect live SQLite state.

---

### Task 1: SQLite Schema Migration, Password Hashing, and Persistent Session Store

**Files:**
- Modify: `src/ledger.mjs` (schema init, `registerUser`, `authenticateUser`, `createSession`, `getSessionByToken`, `renewSessionIfNeeded`, `deleteSessionByToken`)
- Modify: `src/seed.mjs` (`seedDefaultTenants` demo password backfill + `DISABLE_DEMO=1` support)
- Test: `tests/auth.test.mjs` (create)

**Interfaces:**
- Produces on `ledger`:
  - `registerUser({ email, password, homeCurrencyCode = 'USD', budgetCycleStartDay = 1 }) -> User`
  - `authenticateUser({ email, password }) -> User | null`
  - `createSession(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) -> { rawToken, session }`
  - `getSessionByToken(rawToken) -> { id, userId, expiresAt, createdAt } | null`
  - `renewSessionIfNeeded(sessionId, ttlMs = 30 * 24 * 60 * 60 * 1000) -> { renewed: boolean, expiresAt: string } | null`
  - `deleteSessionByToken(rawToken) -> boolean`

- [ ] **Step 1: Write failing unit tests in `tests/auth.test.mjs`**
  - Test `registerUser` creates user with normalized lowercase email, `password_hash` (not plaintext), and seeds 5 starter categories (`Groceries`, `Dining & Coffee`, `Transport`, `Bills & Subs`, `Income / Paycheck`) with 0 accounts.
  - Test `registerUser` rejects duplicate email (case-insensitive) with error (`code: 'DUPLICATE_EMAIL'` or status `409` metadata) and rejects password `< 8` chars.
  - Test `authenticateUser` succeeds with right password, returns `null` with wrong password, and returns `null` (without throwing) for legacy `password_hash IS NULL` rows.
  - Test `createSession`, `getSessionByToken` (returns `null` when expired), `renewSessionIfNeeded` (extends `expiresAt` when `< 15 days` left), and `deleteSessionByToken`.

- [ ] **Step 2: Run tests to verify they fail**
  - Run: `node --test tests/auth.test.mjs`
  - Expected: FAIL (`ledger.registerUser is not a function` or similar).

- [ ] **Step 3: Implement schema migration, auth helpers, and session store in `src/ledger.mjs` and update `src/seed.mjs`**
  - In `src/ledger.mjs`:
    - Check `PRAGMA table_info(users)` and run `ALTER TABLE users ADD COLUMN password_hash TEXT` if missing.
    - Create `sessions` table (`id TEXT PRIMARY KEY`, `user_id TEXT NOT NULL REFERENCES users(id)`, `token_hash TEXT NOT NULL UNIQUE`, `expires_at TEXT NOT NULL`, `created_at TEXT NOT NULL`) + indexes on `token_hash` and `user_id`.
    - Implement `hashPassword(password)` (`16`-byte random salt + `crypto.scryptSync(password, salt, 64).toString('hex')`) and `verifyPassword(password, storedHash)` (`crypto.timingSafeEqual`).
    - Implement `registerUser`, `authenticateUser`, `createSession`, `getSessionByToken`, `renewSessionIfNeeded`, `deleteSessionByToken` and export them from `createLedgerDb`.
  - In `src/seed.mjs`:
    - Accept `{ disableDemo = process.env.DISABLE_DEMO === '1' } = {}` in `seedDefaultTenants(ledger, opts)`.
    - When `!disableDemo`, ensure `patrick@pocketledger.app` and `alex.isolated@pocketledger.app` have `password_hash` set to hashed `'pocketledger-demo'` if currently `NULL`.

- [ ] **Step 4: Run tests to verify they pass**
  - Run: `npm test`
  - Expected: PASS (all existing 10 tests + new `tests/auth.test.mjs` tests).

- [ ] **Step 5: Commit**
  - `git add src/ledger.mjs src/seed.mjs tests/auth.test.mjs && git commit -m "feat: add scrypt password auth and SQLite session store"`

---

### Task 2: HTTP Session Auth Endpoints, Cookie Middleware, and `HOST`/`PORT` Config

**Files:**
- Modify: `src/server.mjs` (cookie parsing, `pl_session` auth middleware, `/api/auth/*` routes, `HOST` env var)
- Modify: `tests/api-and-ui.test.mjs` (update API tests to use session cookies from `/api/auth/login` or `/api/auth/register`)
- Modify: `tests/auth.test.mjs` (add HTTP integration tests for auth routes, `401` enforcement, `x-user-id` ignored, `DISABLE_DEMO=1`)

**Interfaces:**
- Consumes: `ledger.registerUser`, `ledger.authenticateUser`, `ledger.createSession`, `ledger.getSessionByToken`, `ledger.renewSessionIfNeeded`, `ledger.deleteSessionByToken` from Task 1.
- Produces HTTP endpoints:
  - `POST /api/auth/register` -> `201 { user }` (sets `pl_session` cookie) | `409` duplicate | `400` validation
  - `POST /api/auth/login` -> `200 { user }` (sets `pl_session` cookie) | `401` invalid credentials | `403` if demo disabled & demo email
  - `POST /api/auth/logout` -> `200 { ok: true }` (clears `pl_session` cookie)
  - `GET /api/auth/me` -> `200 { authenticated: boolean, user: User | null, demoEnabled: boolean }`

- [ ] **Step 1: Write failing HTTP auth tests in `tests/auth.test.mjs`**
  - Test `GET /api/dashboard` without cookie returns `401`, even when `x-user-id` or `?userId=` is passed.
  - Test `POST /api/auth/register` returns `201`, sets `HttpOnly; SameSite=Lax; Max-Age=2592000` `pl_session` cookie, and subsequent `GET /api/dashboard` with that cookie returns `200`.
  - Test `POST /api/auth/login` with wrong password returns `401`; with valid password returns `200` and cookie.
  - Test `POST /api/auth/logout` deletes session so reusing the old cookie returns `401`.
  - Test `GET /api/auth/me` returns `{ authenticated: false, user: null, demoEnabled: true }` when logged out and `{ authenticated: true, user, demoEnabled: true }` when logged in.
  - Test `DISABLE_DEMO=1` makes `demoEnabled: false` and rejects demo login with `403`.

- [ ] **Step 2: Run tests to verify they fail**
  - Run: `node --test tests/auth.test.mjs`
  - Expected: FAIL (`404 API endpoint not found` or `200` instead of `401`).

- [ ] **Step 3: Implement cookie auth middleware and `/api/auth/*` routes in `src/server.mjs`, and update `tests/api-and-ui.test.mjs`**
  - In `src/server.mjs`:
    - Parse `Cookie` header for `pl_session`.
    - Helper `buildSessionCookie(rawToken, req, maxAgeSeconds = 2592000)` setting `HttpOnly; Path=/; SameSite=Lax; Max-Age=...` and `; Secure` if `req.headers['x-forwarded-proto'] === 'https'` or `req.socket?.encrypted`.
    - Handle `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me` before the protected `/api/*` gate.
    - For all other `/api/*` routes, require valid `getSessionByToken(token)` -> `401 { error: 'Authentication required' }` if missing/expired, call `renewSessionIfNeeded` and attach refreshed `Set-Cookie` if renewed, and bind `userId = session.userId` (remove `x-user-id` and `?userId=` fallback).
    - Remove `availableTenants` from `/api/dashboard` response (or keep user scoped strictly to `session.userId`).
    - Bind `server.listen(port, host, ...)` using `process.env.HOST || '127.0.0.1'` and `Number(process.env.PORT || 3000)`.
  - In `tests/api-and-ui.test.mjs`:
    - Add a small `loginAs(handler, email, password)` helper to obtain the `pl_session` cookie and pass `cookie` header in API test requests instead of `x-user-id`.

- [ ] **Step 4: Run full test suite to verify all tests pass**
  - Run: `npm test`
  - Expected: PASS (all tests in `tests/*.test.mjs`).

- [ ] **Step 5: Commit**
  - `git add src/server.mjs tests/auth.test.mjs tests/api-and-ui.test.mjs && git commit -m "feat: enforce persistent session cookie auth and configurable host"`

---

### Task 3: Frontend Auth Gate, Persistent Session Boot & Logout

**Files:**
- Modify: `public/index.html` (add `#authView` Sign In / Create Account card, user email + Log out button in Settings modal, remove tenant switcher)
- Modify: `public/styles.css` (style `#authView` using existing tokens and mobile-native `16px` inputs / `:active` states)
- Modify: `public/app.js` (boot via `GET /api/auth/me`, handle `401` -> show `#authView`, wire login/register/demo/logout, remove `x-user-id` headers)
- Test: `tests/api-and-ui.test.mjs` (assert served `index.html` has auth gate and `app.js` does not send `x-user-id`)

- [ ] **Step 1: Add failing UI markup/script assertions to `tests/api-and-ui.test.mjs`**
  - Assert `GET /` includes `id="authView"` and `id="logoutBtn"`.
  - Assert `GET /app.js` includes `/api/auth/me` and does not include `'x-user-id'`.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `node --test tests/api-and-ui.test.mjs`
  - Expected: FAIL.

- [ ] **Step 3: Implement Auth Gate UI and session boot in `public/index.html`, `public/styles.css`, and `public/app.js`**
  - In `public/index.html`:
    - Add `#authView` section (hidden by default until `/api/auth/me` resolves) with Sign In / Create Account mode toggle, email input (`type="email"`, `autocomplete="email"`), password input (`type="password"`, `minlength="8"`, `autocomplete="current-password"` / `"new-password"`), optional currency & cycle-start-day fields shown in Create Account mode, submit button, error banner, and `#demoLoginBtn` ("Try Demo Account").
    - In Settings modal, replace `#tenantSelect` with signed-in user email display (`#settingsUserEmail`) and `#logoutBtn` ("Log out").
  - In `public/styles.css`:
    - Style `.auth-shell` centered in `min-height: 100dvh` with safe-area padding, `16px` inputs, and `:active` press feedback.
  - In `public/app.js`:
    - Add `apiFetch(url, opts)` wrapper that checks `res.status === 401` -> switches UI to `#authView` and throws.
    - Replace all `fetch('/api/...', { headers: { 'x-user-id': ... } })` calls with `apiFetch` (browser sends `pl_session` cookie automatically).
    - On boot, call `GET /api/auth/me`: if `authenticated`, hide `#authView`, show main app shell, and call `fetchDashboard()`; otherwise show `#authView` and toggle `#demoLoginBtn` based on `demoEnabled`.
    - Wire Sign In, Create Account, Demo Login, and Log Out handlers.

- [ ] **Step 4: Run full test suite to verify it passes**
  - Run: `npm test`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add public/index.html public/styles.css public/app.js tests/api-and-ui.test.mjs && git commit -m "feat: add mobile-first auth gate and persistent session boot"`

---

### Task 4: Complete PWA Installability (Icons, Manifest, Apple Meta Tags, Service Worker)

**Files:**
- Create: `public/icons/icon.svg`
- Create: `public/sw.js`
- Modify: `public/manifest.json`
- Modify: `public/index.html` (add `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`, and manifest icon links)
- Modify: `public/app.js` (register `/sw.js` when `'serviceWorker' in navigator`)
- Modify: `tests/api-and-ui.test.mjs` (verify `/manifest.json`, `/sw.js`, and `/icons/icon.svg` serve `200` and `sw.js` bypasses `/api/`)

- [ ] **Step 1: Add failing PWA asset & service worker tests to `tests/api-and-ui.test.mjs`**
  - Request `/manifest.json` -> assert `200` and `icons` array has `/icons/icon.svg`.
  - Request `/icons/icon.svg` -> assert `200` and `image/svg+xml`.
  - Request `/sw.js` -> assert `200`, `application/javascript`, and contains `/api/` bypass check.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `node --test tests/api-and-ui.test.mjs`
  - Expected: FAIL (`404` for `/icons/icon.svg` and `/sw.js`).

- [ ] **Step 3: Create `public/icons/icon.svg` and `public/sw.js`, update `public/manifest.json`, `public/index.html`, and `public/app.js`**
  - `public/icons/icon.svg`: clean PocketLedger wallet emblem on `#090d16` rounded background, `512x512` viewBox.
  - `public/manifest.json`: add `id: "/"`, `scope: "/"`, `icons: [{ src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }]`.
  - `public/index.html`: add `<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />`, `<link rel="apple-touch-icon" href="/icons/icon.svg" />`, `<meta name="apple-mobile-web-app-capable" content="yes" />`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`.
  - `public/sw.js`: cache static shell (`/`, `/index.html`, `/styles.css`, `/app.js`, `/manifest.json`, `/icons/icon.svg`) on `install`, clean old caches on `activate`, return early (network-only) for non-GET requests and any URL whose pathname starts with `/api/`, and use network-first with cache fallback for static assets.
  - `public/app.js`: register `/sw.js` on `window` load.

- [ ] **Step 4: Run full test suite to verify it passes**
  - Run: `npm test`
  - Expected: PASS (all tests in `tests/*.test.mjs`).

- [ ] **Step 5: Commit**
  - `git add public/icons/icon.svg public/sw.js public/manifest.json public/index.html public/app.js tests/api-and-ui.test.mjs && git commit -m "feat: add PWA icons, service worker, and iOS home-screen meta tags"`
