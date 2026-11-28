# Sign-Up Email Verification (6-Digit OTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require new sign-ups to confirm their email with a 6-digit OTP sent via `src/mailer.mjs` before receiving a session or signing in.

**Architecture:** `src/ledger.mjs` and `src/ledger-pg.mjs` add `email_verified_at` on `users` (backfilling existing and demo users) plus `email_verification_codes` storing hashed 6-digit codes with a 15-minute expiry and 5-attempt cap. `src/mailer.mjs` adds `sendEmailVerificationCode`. `src/server.mjs` withholds sessions on `/api/auth/register`, blocks unverified logins with `403 EMAIL_NOT_VERIFIED`, and exposes rate-limited `/api/auth/verify-email` and `/api/auth/resend-verification`. `public/index.html`, `public/js/auth.js`, and `public/styles.css` add the 6-digit OTP verification view.

**Tech Stack:** Node.js v24 (ESM, `node:crypto`, `node:sqlite`, `node:test`), PostgreSQL (`pg`), Vanilla JS/HTML/CSS.

**Spec:** `docs/superpowers/specs/2026-11-28-email-verification-otp-design.md`

## Global Constraints

- Zero new npm runtime dependencies (`package.json` keeps only `pg`).
- Both SQLite (`src/ledger.mjs`) and PostgreSQL (`src/ledger-pg.mjs`) must implement identical behavior and additive migrations.
- Existing users and `DEMO_EMAILS` must remain verified on migration/seed.
- Only commit/push after the user reviews the completed changes.

## Review Focus

- **Brute-force protection on 6-digit code:** 5 wrong guesses on `verifyEmailCode` must lock/invalidate that code and require requesting a new one.
- **Unverified login handling:** `POST /api/auth/login` for an unverified user with the right password must return `403 EMAIL_NOT_VERIFIED` (not `401` and not setting a cookie), while wrong password still returns `401`.
- **Resend invalidates prior code:** Calling `createEmailVerificationCode` again deletes prior unused codes so only the newest 6-digit code works.
- **Existing users & demo accounts:** Migration backfills `email_verified_at` for existing rows and `createUser` sets it for seeded/demo users.
- **No session leak on register:** `POST /api/auth/register` returns `201` with `requiresVerification: true` and NO `set-cookie` header.

---

### Task 1: Mailer `sendEmailVerificationCode` (`src/mailer.mjs`)

**Files:**
- Modify: `src/mailer.mjs`
- Test: `tests/mailer.test.mjs`

- [ ] **Step 1: Add failing unit tests in `tests/mailer.test.mjs`** for `sendEmailVerificationCode` (Resend API call with 6-digit code + console fallback).
- [ ] **Step 2: Run `node --test tests/mailer.test.mjs`** (expect FAIL).
- [ ] **Step 3: Implement `sendEmailVerificationCode({ to, code, expiresMinutes = 15 })` in `src/mailer.mjs`**.
- [ ] **Step 4: Run `node --test tests/mailer.test.mjs`** (expect PASS).

---

### Task 2: Storage & Verification Logic (`src/ledger.mjs` & `src/ledger-pg.mjs`)

**Files:**
- Modify: `src/ledger.mjs` (`email_verified_at` column + backfill, `email_verification_codes` table, `registerUser` `emailVerified = false` default, `authenticateUser` `EMAIL_NOT_VERIFIED` guard, `createEmailVerificationCode`, `verifyEmailCode`)
- Modify: `src/ledger-pg.mjs` (matching Postgres schema, backfill, and async methods)
- Test: `tests/email-verification.test.mjs`

- [ ] **Step 1: Write failing ledger tests in `tests/email-verification.test.mjs`** covering unverified registration, `EMAIL_NOT_VERIFIED` on `authenticateUser`, 5-attempt cap, expiry, resend invalidating prior codes, and `verifyEmailCode` success.
- [ ] **Step 2: Run `node --test tests/email-verification.test.mjs`** (expect FAIL).
- [ ] **Step 3: Implement schema + methods in `src/ledger.mjs` and `src/ledger-pg.mjs`**.
- [ ] **Step 4: Run `node --test tests/email-verification.test.mjs`** (expect PASS).

---

### Task 3: Server Endpoints & Existing Test Updates (`src/server.mjs` + `tests/*.test.mjs`)

**Files:**
- Modify: `src/server.mjs` (`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/verify-email`, `POST /api/auth/resend-verification`, rate limiters)
- Modify: `tests/email-verification.test.mjs` (HTTP flow + rate-limit tests)
- Modify: Existing HTTP tests that register & expect immediate session (`tests/auth.test.mjs`, `tests/api-and-ui.test.mjs`, `tests/edit-and-insights.test.mjs`, `tests/forgot-password.test.mjs`, `tests/profile.test.mjs`, `tests/rate-limit.test.mjs`) to verify via OTP or test the new 2-step flow explicitly.

- [ ] **Step 1: Add HTTP integration tests in `tests/email-verification.test.mjs`**.
- [ ] **Step 2: Run `node --test tests/email-verification.test.mjs`** (expect FAIL).
- [ ] **Step 3: Update `src/server.mjs` endpoints and rate limiters**.
- [ ] **Step 4: Update existing HTTP tests for the 2-step OTP registration flow and run `node --test tests/*.test.mjs`** (expect all PASS).

---

### Task 4: Frontend 6-Digit OTP UI (`public/index.html`, `public/js/auth.js`, `public/styles.css`)

**Files:**
- Modify: `public/index.html` (add `#verifyEmailForm` with 6-digit numeric input, `#verifySubmitBtn`, `#verifyResendBtn`, `#verifyBackBtn`)
- Modify: `public/js/auth.js` (add `'verify'` mode to `setAuthMode`, `requiresVerification` handling on register, `EMAIL_NOT_VERIFIED` handling on login, OTP submit, resend with 60s cooldown)
- Modify: `public/styles.css` (styles for `.otp-input` and `.auth-resend-row`)

- [ ] **Step 1: Add markup and styles in `public/index.html` and `public/styles.css`**.
- [ ] **Step 2: Wire `'verify'` mode, OTP submit, and resend cooldown in `public/js/auth.js`**.
- [ ] **Step 3: Run `node --test tests/*.test.mjs` and `node --check public/js/auth.js`** (expect all PASS, 0 failures).
