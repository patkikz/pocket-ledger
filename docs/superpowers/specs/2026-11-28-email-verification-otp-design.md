# Sign-Up Email Verification (6-Digit OTP) Design

**Date:** 2026-11-28
**Status:** Draft — awaiting approval

## Intent & Why

Currently, `POST /api/auth/register` creates an account and immediately logs the user in without confirming email ownership, allowing dummy or mistyped emails to access the app. Requiring a 6-digit one-time verification code sent via our mailer ensures only users who control their email address can activate an account and sign in.

## Goals, Non-Goals, & Anti-Goals

- **Goals:**
  - Block newly registered users from receiving a session until they enter the 6-digit code sent to their email.
  - Support Resend HTTP API in production (`RESEND_API_KEY`) and console fallback locally, matching `src/mailer.mjs`.
  - Allow users who close the tab or try to sign in while unverified (`EMAIL_NOT_VERIFIED`) to enter their code or request a new one.
  - Grandfather existing users and demo accounts as verified so no existing user is locked out on deployment.
- **Non-Goals:**
  - Changing email address after registration, or requiring OTP on every login (2FA).
- **Anti-Goals:**
  - Allowing unlimited brute-force guesses on a 6-digit code (must cap attempts per code and rate-limit endpoints).
  - Breaking existing demo accounts (`DEMO_EMAILS`).

## Constraints

- Zero new npm runtime dependencies (`package.json` keeps only `pg`).
- Identical behavior and additive migrations in both SQLite (`src/ledger.mjs`) and PostgreSQL (`src/ledger-pg.mjs`).
- Live production delivery to arbitrary user emails requires a verified custom domain in Resend (`RESEND_FROM_EMAIL`).

## Approaches Considered

1. **6-Digit Email Code (OTP) — *Chosen***
   - User stays on the auth card right after sign-up and enters the 6-digit code (`inputmode="numeric"`, `autocomplete="one-time-code"`), activating their account and signing in immediately.
2. **Email Verification Link (`/?verifyToken=...`)**
   - Requires switching tabs/windows on mobile to complete sign-up.

## Architecture & Behavior

### 1. Storage (`src/ledger.mjs` & `src/ledger-pg.mjs`)

- **Users table migration:**
  - Add `email_verified_at TEXT` column to `users`.
  - On migration, backfill existing rows (`UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL`) so existing accounts remain verified.
  - `createUser` (used by `seedDefaultTenants` / demo accounts) sets `email_verified_at = now`.
  - `registerUser({ email, password, homeCurrencyCode, budgetCycleStartDay, emailVerified = false })` sets `email_verified_at = emailVerified ? now : null`.
- **New table `email_verification_codes`:**
  - `id TEXT PRIMARY KEY`
  - `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `code_hash TEXT NOT NULL` (SHA-256 hex of `${userId}:${code}`)
  - `attempts INTEGER NOT NULL DEFAULT 0`
  - `expires_at TEXT NOT NULL` (15 minutes from creation)
  - `used_at TEXT`
  - `created_at TEXT NOT NULL`
- **Ledger methods:**
  - `createEmailVerificationCode(email, { ttlMinutes = 15 } = {})`:
    - Finds unverified user by `LOWER(email)` (skips demo/already-verified users, returning `null`).
    - Deletes prior unused codes for that `user_id`, generates a 6-digit code via `crypto.randomInt(100000, 1000000).toString()`, stores `code_hash`, and returns `{ code, email: row.email, expiresAt }`.
  - `verifyEmailCode({ email, code })`:
    - Looks up latest unused, non-expired code for `LOWER(email)`.
    - Rejects if missing/expired (`400`), or if `attempts >= 5` (`400` too many wrong attempts—request a new code).
    - On mismatch, increments `attempts` and throws `400`.
    - On match, atomically marks `used_at = now` and `users.email_verified_at = now`, returning the sanitized `user`.
  - `authenticateUser({ email, password })`:
    - Verifies password first; if password matches and `!row.email_verified_at`, throws an error with `statusCode = 403` and `code = 'EMAIL_NOT_VERIFIED'`.

### 2. Mailer (`src/mailer.mjs`)

- Add `sendEmailVerificationCode({ to, code, expiresMinutes = 15 })` to `createMailer`:
  - Sends a clean HTML + plain-text email highlighting the 6-digit code (`expiresMinutes` expiry) via Resend, or logs `[PocketLedger] Email verification code for ${to}: ${code}` in console mode when `RESEND_API_KEY` is unset.

### 3. API Endpoints (`src/server.mjs`)

- `POST /api/auth/register`:
  - Creates user with `emailVerified: false`, generates 6-digit code, and calls `mailer.sendEmailVerificationCode(...)`.
  - Returns `201 { requiresVerification: true, email: user.email, message: 'We sent a 6-digit verification code to your email.' }` **without** setting `pl_session`.
- `POST /api/auth/login`:
  - If `authenticateUser` throws `EMAIL_NOT_VERIFIED`, returns `403 { error: 'Please confirm your email address before signing in.', code: 'EMAIL_NOT_VERIFIED', email: normalizedEmail }`.
- `POST /api/auth/verify-email`:
  - Rate-limited by IP and IP+email; calls `ledger.verifyEmailCode({ email, code })`, creates session via `ledger.createSession(user.id)`, and returns `200 { user }` with `Set-Cookie: pl_session=...`.
- `POST /api/auth/resend-verification`:
  - Rate-limited (`3 / 15m` per IP+email); calls `ledger.createEmailVerificationCode(email)` and sends email if unverified user exists; always returns `200 { ok: true, message: 'If an unverified account exists for that email, a new code has been sent.' }`.

### 4. Frontend UI (`public/index.html`, `public/js/auth.js`, `public/styles.css`)

- Extend `setAuthMode` with `'verify'` mode (`"Confirm your email"`, `"Enter the 6-digit code sent to <email>"`).
- Add `#verifyEmailForm`:
  - Centered 6-digit code input (`type="text"`, `inputmode="numeric"`, `pattern="[0-9]{6}"`, `maxlength="6"`, `autocomplete="one-time-code"`).
  - **Verify & Sign In** submit button, **Resend code** button (with 60s countdown), and **Back to Sign In** button.
- Handle `requiresVerification` from `/api/auth/register` and `EMAIL_NOT_VERIFIED` (`403`) from `/api/auth/login` by switching directly into `'verify'` mode for that email.
