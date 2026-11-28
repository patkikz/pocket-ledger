# Forgot Password (Email Reset Link) Design

**Date:** 2026-11-28
**Status:** Draft — awaiting approval

## Intent & Why

Users who forget their PocketLedger password currently have no self-service way to regain access; only an authenticated **Change Password** form exists under Account Settings. Adding an email-based **Forgot Password** flow gives users the standard recovery experience while keeping sessions secure and demo accounts protected.

## Goals, Non-Goals, & Anti-Goals

- **Goals:**
  - Let registered, non-demo users request a time-limited, single-use password reset link by email.
  - Let users open that link (`/?resetToken=...`) to set a new password (min 8 chars) and revoke all existing sessions.
  - Work seamlessly in both SQLite (`src/ledger.mjs`) and PostgreSQL (`src/ledger-pg.mjs`), plus local dev/test without requiring live email credentials.
- **Non-Goals:**
  - Account email verification on signup, magic-link passwordless login, or PIN reset via email.
  - Changing demo account credentials (`DEMO_EMAILS` remain blocked from password changes/resets).
- **Anti-Goals:**
  - Leaking whether an email address is registered via `forgot-password` error/success responses (no email enumeration).
  - Adding heavy npm email dependencies (`nodemailer`, SDKs) when Node 24's built-in `fetch` suffices.

## Constraints

- Zero new runtime dependencies (`package.json` keeps only `pg`).
- Must support both SQLite (`src/ledger.mjs`) and PostgreSQL (`src/ledger-pg.mjs` on Render + Supabase) with additive `CREATE TABLE IF NOT EXISTS` migrations.
- Rate-limited on both request and reset endpoints, matching existing `src/rate-limit.mjs` patterns.
- Production email delivery uses `RESEND_API_KEY` and `RESEND_FROM_EMAIL` configured in Render; local dev/tests must work without them.

## Approaches Considered

1. **Email reset link via Resend HTTP API (`fetch`) — *Chosen***
   - Standard UX: user clicks **"Forgot password?"**, receives an email link, sets a new password. No pre-saved codes required.
2. **In-house One-Time Recovery Codes**
   - Zero external credentials, but locks out any user who forgot to save recovery codes beforehand.
3. **In-house SMTP**
   - Avoids third-party email APIs, but requires adding an SMTP library and managing mail server credentials/deliverability.

## Architecture & Behavior

### 1. Storage (`src/ledger.mjs` & `src/ledger-pg.mjs`)

Add `password_reset_tokens` table (additive migration on init):
- `id TEXT PRIMARY KEY`
- `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `token_hash TEXT NOT NULL UNIQUE` (SHA-256 hex digest of the raw 32-byte random token; raw token is never persisted)
- `expires_at TEXT NOT NULL` (ISO timestamp, 30 minutes from creation)
- `used_at TEXT` (nullable ISO timestamp; set atomically when consumed)
- `created_at TEXT NOT NULL`

Ledger methods:
- `createPasswordResetToken(email, { ttlMinutes = 30 } = {})`:
  - Normalizes email; returns `null` if user does not exist or `DEMO_EMAILS.has(email)` or user has no `password_hash`.
  - Deletes/invalidates any prior unused reset tokens for that `user_id`, generates `crypto.randomBytes(32).toString('hex')`, stores `sha256(rawToken)`, and returns `{ rawToken, email, expiresAt }`.
- `consumePasswordResetToken({ token, newPassword })`:
  - Validates `newPassword` (`>= 8` chars).
  - Looks up `token_hash = sha256(token)` where `used_at IS NULL` and `expires_at > now`.
  - Blocks `DEMO_EMAILS` as defense in depth.
  - Inside a transaction: marks `used_at = now`, updates `users.password_hash = hashPassword(newPassword)`, and deletes all rows from `sessions` for that `user_id`.

### 2. Email Delivery (`src/mailer.mjs`)

- Exports `createMailer({ apiKey = process.env.RESEND_API_KEY, from = process.env.RESEND_FROM_EMAIL, fetchImpl = fetch } = {})`:
  - `sendPasswordResetEmail({ to, resetUrl, expiresMinutes })`:
    - If `apiKey` and `from` are configured, `POST https://api.resend.com/emails` with Bearer auth, plain-text + clean HTML email containing `resetUrl` and expiry notice (`30 minutes`). Throws on non-2xx response.
    - If `apiKey` is not configured (local dev), logs the reset URL via `console.info` and returns `{ delivered: false, mode: 'console' }` so local testing works without an API key.
- `createApp({ ..., mailer })` accepts an optional `mailer` dependency so automated tests can capture reset URLs cleanly without network calls.

### 3. API Endpoints (`src/server.mjs`)

- `POST /api/auth/forgot-password`
  - Rate-limited via `forgotPasswordIpLimiter` (e.g., 10 / 15m per IP) and `forgotPasswordEmailLimiter` (e.g., 3 / 15m per IP+email). Returns `429` with `retryAfterSeconds` and `retry-after` header if exceeded.
  - Validates email format (`400` if missing/malformed).
  - Calls `ledger.createPasswordResetToken(email)`. If a token is created, builds `${baseUrl}/?resetToken=${rawToken}` (using `APP_BASE_URL` if set, otherwise request `x-forwarded-proto` + `host`) and calls `mailer.sendPasswordResetEmail(...)`.
  - Always responds `200 { ok: true, message: 'If an account exists for that email, a password reset link has been sent.' }` to prevent account enumeration.
- `POST /api/auth/reset-password`
  - Rate-limited by IP (`resetPasswordLimiter`).
  - Validates `{ token, newPassword }`, calls `ledger.consumePasswordResetToken({ token, newPassword })`.
  - Returns `200 { ok: true, message: 'Password updated. Please sign in with your new password.' }`, or `400` with a clear error on invalid/expired/used token or short password.

### 4. Frontend UI (`public/index.html`, `public/js/auth.js`, `public/app.js`, `public/styles.css`)

- **Sign In view (`#authForm`):**
  - Add a `"Forgot password?"` link button in the password label row (hidden when in Create Account mode).
- **Forgot Password mode (inside `#authView`):**
  - Hides mode tabs and Sign In/Register fields; shows an email input, `"Send Reset Link"` submit button, success/error banner, and `"Back to Sign In"` button.
- **Reset Password mode (inside `#authView`):**
  - On startup (`app.js`), if `new URLSearchParams(window.location.search).get('resetToken')` is present (and user is not authenticated, or even if stale cookie exists, renders reset form cleanly), switches `#authView` into Reset Password mode: **New Password** + **Confirm Password** fields (using existing `.password-toggle-btn` eye toggles) and `"Reset Password"` button.
  - On `200` success, strips `?resetToken` from the URL with `window.history.replaceState`, returns to Sign In mode, and displays a confirmation banner.

## Left to the Builder

- Exact HTML/CSS class naming, copy polish, and test case breakdown (SQLite, PostgreSQL, HTTP rate-limit/reset flow, and mailer fallback).
