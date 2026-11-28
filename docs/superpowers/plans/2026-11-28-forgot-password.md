# Forgot Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement self-service password reset via time-limited, single-use email links using Resend's HTTP API (`fetch`), backed by both SQLite and PostgreSQL, with rate limiting and full auth UI support.

**Architecture:** `src/mailer.mjs` sends reset emails via Resend (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`) or falls back to console logging locally when unconfigured. `src/ledger.mjs` and `src/ledger-pg.mjs` store SHA-256 hashed single-use tokens in `password_reset_tokens` and atomically update `password_hash` while revoking all active sessions on consumption. `src/server.mjs` exposes rate-limited `POST /api/auth/forgot-password` and `POST /api/auth/reset-password`, and `public/index.html` + `public/js/auth.js` + `public/app.js` handle requesting and completing the reset.

**Tech Stack:** Node.js v24 (ESM, built-in `fetch`, `node:crypto`, `node:sqlite`, `node:test`), PostgreSQL (`pg`), Vanilla JS/HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-11-28-forgot-password-design.md`

## Global Constraints

- Zero new npm runtime dependencies (`package.json` keeps only `pg`).
- Both SQLite (`src/ledger.mjs`) and PostgreSQL (`src/ledger-pg.mjs`) must implement identical behavior and additive `CREATE TABLE IF NOT EXISTS` migrations.
- `DEMO_EMAILS` accounts must never receive reset tokens or have their passwords reset.
- `POST /api/auth/forgot-password` must always return `200` (unless `400` malformed email or `429` rate-limited) to prevent email enumeration.
- Only commit/push after the user reviews the completed changes.

## Review Focus

- **Expired or already-used token:** Submitting an expired or previously consumed `token` to `POST /api/auth/reset-password` must return `400` without modifying `password_hash` or sessions.
- **Re-requesting a reset invalidates prior tokens:** Requesting a second reset for the same email invalidates any earlier unused token so only the newest link works.
- **Session revocation on reset:** All existing `sessions` rows for that `user_id` must be deleted when a reset succeeds, forcing re-authentication everywhere.
- **Demo account protection:** Requesting or attempting a reset for `patrick@pocketledger.app` or `alex.isolated@pocketledger.app` must not create a token, send an email, or reveal anything via status code.
- **URL `?resetToken=` handling when a stale session cookie exists:** Opening `/?resetToken=...` must still show the Reset Password view (or handle it cleanly) and strip `resetToken` from the URL after completion.

---

### Task 1: Mailer Module (`src/mailer.mjs`)

**Files:**
- Create: `src/mailer.mjs`
- Test: `tests/mailer.test.mjs`

**Interfaces:**
- Produces: `createMailer({ apiKey, from, fetchImpl } = {}) -> { sendPasswordResetEmail({ to, resetUrl, expiresMinutes }) }`

- [ ] **Step 1: Write the failing tests in `tests/mailer.test.mjs`**

Test:
1. When `apiKey` and `from` are set, `sendPasswordResetEmail` calls `fetchImpl('https://api.resend.com/emails', ...)` with `Authorization: Bearer <apiKey>`, `to: [email]`, `from`, `subject`, and both `text` and `html` containing `resetUrl`, and returns `{ delivered: true, mode: 'resend', id }`.
2. When Resend returns non-2xx (e.g. `422`), `sendPasswordResetEmail` throws an `Error` with the status/message.
3. When `apiKey` is missing, `sendPasswordResetEmail` does not call `fetchImpl` and returns `{ delivered: false, mode: 'console' }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/mailer.test.mjs`
Expected: FAIL (`Cannot find module '../src/mailer.mjs'`).

- [ ] **Step 3: Implement `src/mailer.mjs`**

Implement `createMailer({ apiKey = process.env.RESEND_API_KEY, from = process.env.RESEND_FROM_EMAIL, fetchImpl = fetch } = {})` with `sendPasswordResetEmail({ to, resetUrl, expiresMinutes = 30 })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/mailer.test.mjs`
Expected: PASS (3/3).

---

### Task 2: Password Reset Token Storage (`src/ledger.mjs` & `src/ledger-pg.mjs`)

**Files:**
- Modify: `src/ledger.mjs` (schema + `createPasswordResetToken` + `consumePasswordResetToken` + export)
- Modify: `src/ledger-pg.mjs` (schema + `createPasswordResetToken` + `consumePasswordResetToken` + export)
- Test: `tests/forgot-password.test.mjs` (ledger unit tests)

**Interfaces:**
- Produces (on both SQLite and PG ledger instances):
  - `createPasswordResetToken(email, { ttlMinutes = 30 } = {}) -> { rawToken, email, expiresAt } | null`
  - `consumePasswordResetToken({ token, newPassword }) -> true` (throws `400` on invalid/expired/used token or short password, `403` on demo user)

- [ ] **Step 1: Write the failing ledger tests in `tests/forgot-password.test.mjs`**

Test against `createLedgerDb(':memory:')`:
1. Unknown email or `DEMO_EMAILS` email returns `null` from `createPasswordResetToken`.
2. Valid user gets `{ rawToken, email, expiresAt }`; calling `createPasswordResetToken` a second time invalidates the first token.
3. `consumePasswordResetToken` with valid token updates the password (verified via `authenticateUser`), revokes all existing sessions (`getSessionUser` returns `null`), and rejects a second attempt with the same token (`used_at` set).
4. `consumePasswordResetToken` rejects expired tokens (`ttlMinutes: -1` or past `expires_at`) and passwords shorter than 8 chars.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/forgot-password.test.mjs`
Expected: FAIL (`ledger.createPasswordResetToken is not a function`).

- [ ] **Step 3: Implement `password_reset_tokens` table & methods in `src/ledger.mjs` and `src/ledger-pg.mjs`**

- Add `CREATE TABLE IF NOT EXISTS password_reset_tokens (...)` in both `src/ledger.mjs` and `src/ledger-pg.mjs`.
- Implement `hashResetToken(rawToken)` (SHA-256 hex) and both `createPasswordResetToken` and `consumePasswordResetToken` in both files, exporting them on the returned ledger object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/forgot-password.test.mjs`
Expected: PASS.

---

### Task 3: Server Endpoints & Rate Limiting (`src/server.mjs`)

**Files:**
- Modify: `src/server.mjs` (`createApp` signature + limiters + `/api/auth/forgot-password` + `/api/auth/reset-password`)
- Test: `tests/forgot-password.test.mjs` (HTTP integration tests)

**Interfaces:**
- Consumes: `ledger.createPasswordResetToken`, `ledger.consumePasswordResetToken`, `createMailer`
- Produces:
  - `POST /api/auth/forgot-password` (`{ email }` -> `200 { ok: true, message }`, `400` invalid email, `429` rate limit)
  - `POST /api/auth/reset-password` (`{ token, newPassword }` -> `200 { ok: true, message }`, `400` invalid/expired/used token or short password, `429` rate limit)

- [ ] **Step 1: Write the failing HTTP integration tests in `tests/forgot-password.test.mjs`**

Test with `createApp({ dbPath: ':memory:', mailer: mockMailer })`:
1. `POST /api/auth/forgot-password` for registered email sends reset URL containing `?resetToken=...` via `mockMailer` and returns `200`.
2. `POST /api/auth/forgot-password` for unregistered email or demo email does NOT call `mockMailer` and still returns identical `200` response (anti-enumeration).
3. `POST /api/auth/reset-password` with captured token + new password returns `200`, invalidates old session cookie, allows login with new password, and rejects token reuse with `400`.
4. Rate limiting on `/api/auth/forgot-password` and `/api/auth/reset-password` returns `429` with `retryAfterSeconds` and `retry-after` header after threshold.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/forgot-password.test.mjs`
Expected: FAIL (404/non-200 on new endpoints).

- [ ] **Step 3: Implement endpoints & rate limiters in `src/server.mjs`**

- Accept `mailer = createMailer()` in `createApp(...)`.
- Add `forgotPasswordIpLimiter`, `forgotPasswordEmailLimiter`, and `resetPasswordLimiter` using `createRateLimiter`.
- Add `getAppBaseUrl(req)` using `process.env.APP_BASE_URL` or `x-forwarded-proto` / `host` headers.
- Implement `POST /api/auth/forgot-password` and `POST /api/auth/reset-password`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/forgot-password.test.mjs`
Expected: PASS.

---

### Task 4: Frontend Forgot & Reset Password UI (`public/index.html`, `public/js/auth.js`, `public/app.js`, `public/styles.css`)

**Files:**
- Modify: `public/index.html` (add `"Forgot password?"` button on Sign In + `#forgotPasswordForm` + `#resetPasswordForm` inside `#authView`)
- Modify: `public/js/auth.js` (mode switching between `login`, `register`, `forgot`, `reset`, form submissions, URL `?resetToken=` cleanup)
- Modify: `public/app.js` (detect `?resetToken=` on boot and open Reset Password mode)
- Modify: `public/styles.css` (styles for `.auth-link-btn`, `.auth-info` success banner, `.field-label-row`)

- [ ] **Step 1: Add UI markup in `public/index.html` and styles in `public/styles.css`**

- Add `.field-label-row` around Password label + `"Forgot password?"` button (`#forgotPasswordLinkBtn`).
- Add `#forgotPasswordForm` (email input, `"Send Reset Link"` button, `"Back to Sign In"` button) and `#resetPasswordForm` (New Password + Confirm Password with `.password-toggle-btn` eye toggles, `"Reset Password"` button, `"Back to Sign In"` button).
- Add `#authInfoBanner` (success/info feedback banner).

- [ ] **Step 2: Wire state transitions & API calls in `public/js/auth.js` and `public/app.js`**

- Extend `setAuthMode(mode)` to support `'login' | 'register' | 'forgot' | 'reset'`.
- Wire `#forgotPasswordLinkBtn`, `#forgotPasswordForm`, `#resetPasswordForm`, and back-to-sign-in buttons.
- In `public/app.js` `boot()`, check `new URLSearchParams(window.location.search).get('resetToken')`; if present, show auth view in `'reset'` mode with that token. On successful reset, strip `?resetToken` via `window.history.replaceState` and show the success message on Sign In.

- [ ] **Step 3: Run full test suite & syntax check**

Run: `node --test tests/*.test.mjs` and `node --check public/js/auth.js; node --check public/app.js`
Expected: All tests PASS with 0 failures and 0 syntax errors.
