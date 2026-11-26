# PocketLedger Auth, Persistent Sessions & Mobile PWA Design

**Date:** 2026-11-26
**Status:** Draft (Pending Approval)

## 1. Intent & Why
Make PocketLedger safe and ready to use off `localhost` on a phone's home screen. Users should be able to register once, log in once, and stay signed in across browser restarts and mobile PWA relaunches without exposing anyone else's ledger.

## 2. Goals, Non-Goals & Anti-Goals
### Goals
- **One-time registration & login:** Clean email + password registration (`POST /api/auth/register`) and login (`POST /api/auth/login`) with `crypto.scryptSync` + per-user random salt.
- **Persistent sessions:** 30-day `HttpOnly; SameSite=Lax; Path=/` session cookie backed by a `sessions` table in SQLite (`token_hash`, `user_id`, `expires_at`, `created_at`) with sliding renewal on authenticated requests and explicit revocation on logout (`POST /api/auth/logout`).
- **Strict auth isolation:** Remove unauthenticated `x-user-id` / `?userId=` tenant spoofing on `/api/*`. Every `/api/*` route (except `/api/auth/register`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`) requires a valid session cookie and scopes all reads/writes to `session.userId`.
- **Clean onboarding for new users:** Registering creates a new user (with chosen email, currency, and cycle start day) and drops them straight into their own empty ledger with an active session cookie.
- **Installable PWA & LAN hosting:** Add app icons (`192x192`, `512x512` SVG/PNG), update `public/manifest.json` and `public/index.html` (Apple touch icon, status bar meta tags), add `public/sw.js` (caches static shell assets only; `/api/*` is strictly network-only), and support `HOST` (default `127.0.0.1`) + `PORT` (default `3000`) env vars.

### Non-Goals
- Email verification, password reset via SMTP, OAuth/SSO, or Passkeys/WebAuthn (WebAuthn requires HTTPS + domain, breaking local LAN `http://` testing).
- Offline transaction queueing or IndexedDB sync (PocketLedger remains online-first so ACID ledger invariants stay single-source-of-truth in SQLite).

### Anti-Goals
- Caching `/api/*` responses in the service worker (stale balances or double-posted expenses would break trust).
- Storing plaintext session tokens or passwords in SQLite.

## 3. Constraints
- Zero external npm dependencies (use Node built-in `node:crypto`, `node:http`, `node:sqlite`).
- Must migrate existing `pocket-ledger.sqlite` databases cleanly (`ALTER TABLE` / `CREATE TABLE IF NOT EXISTS`) without losing existing demo/personal data.
- Must keep `npm test` passing, updating API/security tests to authenticate via session cookies.
- Mobile-native CSS rules already in `public/styles.css` (`100dvh`, `env(safe-area-inset-*)`, `16px` inputs, capability-gated `:hover`) must be preserved and applied to the new auth screen.

## 4. Approaches Considered
1. **SQLite Sessions + `scrypt` Password Auth + App-Shell PWA (Selected):**
   - Stores salted `scrypt` password hashes on `users` and SHA-256-hashed session tokens in a `sessions` table.
   - *Pros:* Zero dependencies, revocable sessions, survives server restarts and mobile PWA closes, works over both local `http://` Wi-Fi and `https://`.
   - *Cons:* Requires an additive schema migration for `users.password_hash` and `sessions`.
2. **Stateless HMAC Signed Cookie:**
   - *Rejected:* Cannot revoke a logged-out or compromised session server-side, and rotating the secret logs out all users.
3. **Passkey / WebAuthn Only:**
   - *Rejected:* Requires HTTPS + a valid domain, which blocks local LAN phone testing (`http://192.168.x.x:3000`).

## 5. Architecture & Key Decisions
- **Database Schema (`src/ledger.mjs`):**
  - Add `password_hash TEXT` column to `users` (nullable only for legacy rows; migrated safely via `PRAGMA table_info(users)`). Legacy demo accounts (`patrick@pocketledger.app`, `alex.isolated@pocketledger.app`) are backfilled with a known demo password when `DISABLE_DEMO !== '1'`; any legacy row with `password_hash IS NULL` cannot log in (no unauthenticated claim flow needed since only demo data exists locally).
  - Add `sessions` table: `id TEXT PRIMARY KEY`, `user_id TEXT NOT NULL REFERENCES users(id)`, `token_hash TEXT NOT NULL UNIQUE`, `expires_at TEXT NOT NULL`, `created_at TEXT NOT NULL`, plus index on `(token_hash)` and `(user_id)`.
- **Auth & Session Lifecycle (`src/ledger.mjs` + `src/server.mjs`):**
  - Password hashing: `salt:hash` using `crypto.randomBytes(16)` + `crypto.scryptSync(password, salt, 64)` and `crypto.timingSafeEqual` for verification. Minimum password length: 8 characters; email normalized with `trim().toLowerCase()`.
  - Session creation: `crypto.randomBytes(32).toString('base64url')` sent in `pl_session` cookie; SHA-256 hex digest stored in `sessions.token_hash`.
  - Cookie flags: `HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000` (30 days). Add `Secure` when `req.headers['x-forwarded-proto'] === 'https'` or `req.socket?.encrypted`.
  - Sliding renewal: If an authenticated request hits `/api/*` and the session has `< 15 days` remaining, extend `expires_at` by 30 days and refresh the `Set-Cookie` header.
  - Endpoints:
    - `POST /api/auth/register` — `{ email, password, homeCurrencyCode?, budgetCycleStartDay? }` → creates user, seeds the 5 starter categories (`Groceries`, `Dining & Coffee`, `Transport`, `Bills & Subs`, `Income / Paycheck`) with 0 accounts *(our call, matching `seedPersonalProfile`)*, creates session, sets cookie, returns `201 { user }`. Rejects duplicate email with `409`.
    - `POST /api/auth/login` — `{ email, password }` → verifies hash, creates session, sets cookie, returns `200 { user }`. Returns `401` on invalid credentials.
    - `POST /api/auth/logout` — deletes session row for current cookie, clears `pl_session` cookie (`Max-Age=0`), returns `200 { ok: true }`.
    - `GET /api/auth/me` — returns `200 { authenticated: true, user, demoEnabled }` or `200 { authenticated: false, user: null, demoEnabled }` (never `401` so initial boot is clean).
  - Demo access *(our call)*: Keep `patrick@pocketledger.app` from `src/seed.mjs` and expose `demoEnabled = process.env.DISABLE_DEMO !== '1'` on `GET /api/auth/me`. When `demoEnabled` is true, the login screen offers a "Try Demo Account" button that signs into `patrick@pocketledger.app`; when `DISABLE_DEMO=1`, demo seeding and demo login are disabled on the server and hidden in the UI. No cross-tenant switcher in the main app once logged in; Settings shows the signed-in user's email and a **Log out** button.
- **Frontend Auth Gate (`public/index.html`, `public/app.js`, `public/styles.css`):**
  - On boot, call `GET /api/auth/me`. If `authenticated: false`, render the mobile-first Auth view (Sign In / Create Account tabs, `16px` inputs with `autocomplete="email"` / `current-password` / `new-password`, optional Demo button if enabled) and hide the main app shell.
  - On `401` from any API call, clear client state and return to the Auth view.
- **PWA Installability (`public/manifest.json`, `public/sw.js`, `public/icons/*`, `public/index.html`):**
  - Add SVG/PNG icons (`icon-192.png` or SVG icons + `apple-touch-icon` in `public/icons/`).
  - Register `/sw.js` in `public/app.js` on load.
  - `sw.js` caches static shell assets (`/`, `/index.html`, `/styles.css`, `/app.js`, `/manifest.json`, icons) on `install`, cleans old caches on `activate`, and uses network-first (with cache fallback) for static navigation/assets while bypassing `/api/*` completely.

## 6. Left to the Builder (Planning & Implementation)
- Exact SQLite migration helper and unit/API tests for registration, login, persistent session renewal, logout revocation, and `401` enforcement.
- Exact SVG/PNG icon generation and `sw.js` cache versioning.
- Mobile-native CSS verification on the new Auth view (16px inputs, `:active` states, safe-area padding).
