# Session Handover — Auth Flows (Forgot Password, 6-Digit Email OTP) & UI Revamp

**Date:** 2026-11-28 (Afternoon)
**Repo:** `C:\Users\patrick\.gemini\antigravity\scratch\pocket-ledger`
**Branch:** `master` (HEAD: `85b937a`, pushed to `https://github.com/patkikz/pocket-ledger`)

---

## Completed & Pushed Today

1. **PIN Lock Live Retry Countdown (`cf59c07`)**
   - `src/server.mjs`: Added `formatRetryDuration(retryAfterSeconds)` (exact `Xm YYs` formatting) and `attemptsRemaining` / `retryAfterSeconds` in `400` and `429` JSON payloads.
   - `public/js/pin-lock.js`: Disables keypad on lockout and ticks a live 1-second countdown until unlock.

2. **Forgot Password & Login UI Revamp (`8e98d6a`)**
   - `src/mailer.mjs`: Zero-dependency Resend HTTP API client (`fetch`) using `RESEND_API_KEY` & `RESEND_FROM_EMAIL`, with console-log fallback locally.
   - `src/ledger.mjs` & `src/ledger-pg.mjs`: Added `password_reset_tokens` table (SHA-256 hashed, 30-min expiry, single-use) and session revocation on password reset; demo accounts remain blocked.
   - `src/server.mjs`: Rate-limited `POST /api/auth/forgot-password` (anti-enumeration `200`) and `POST /api/auth/reset-password`.
   - `public/index.html`, `public/js/auth.js`, `public/app.js`, `public/styles.css`: Responsive split-screen login layout (desktop hero + mobile card, friendly non-jargon copy), **"Forgot password?"** below password input, and `/?resetToken=...` reset flow.
   - Specs & plan: `docs/superpowers/specs/2026-11-28-forgot-password-design.md`, `docs/superpowers/specs/2026-11-28-login-ui-revamp-design.md`, `docs/superpowers/plans/2026-11-28-forgot-password.md`.

3. **6-Digit Email OTP Verification on Sign-Up (`fab4587`)**
   - `src/ledger.mjs` & `src/ledger-pg.mjs`: Added `email_verified_at` on `users` (demo accounts remain verified; existing non-demo users stay `NULL` so they confirm via OTP on next sign-in) and `email_verification_codes` (15-min expiry, 5-attempt cap per code).
   - `src/mailer.mjs`: Added `sendEmailVerificationCode`.
   - `src/server.mjs`: `POST /api/auth/register` withholds `pl_session` and sends 6-digit OTP; `POST /api/auth/login` returns `403 EMAIL_NOT_VERIFIED` and auto-sends a fresh OTP (`codeSent: true`); added rate-limited `POST /api/auth/verify-email` and `POST /api/auth/resend-verification`.
   - `public/index.html`, `public/js/auth.js`, `public/styles.css`: Revamped **"Check your inbox"** card with 6 segmented digit boxes (auto-advance, backspace, paste) and 60s resend cooldown.
   - Spec & plan: `docs/superpowers/specs/2026-11-28-email-verification-otp-design.md`, `docs/superpowers/plans/2026-11-28-email-verification-otp.md`.

4. **Tracing Wallet Boot Loader & Uniform App Icons (`4e8c14e`, `85b937a`)**
   - Unified all `.brand-logo` icons (`public/index.html`, `public/styles.css`, `public/icons/icon.svg`) to the box-free `#818cf8` -> `#34d399` gradient wallet outline.
   - Made topbar logo/title (`#brandHomeBtn`, `#brandHomeTitle`) and **Overview** tab trigger `#bootLoader` on navigation (`public/app.js`).

---

## Uncommitted Local Changes (`git status -s`)

- `M public/index.html` — Restored Option B `stroke-dasharray: 42 38` tracing contour SVG inside `#bootLoader`.
- `M public/styles.css` — Restored `@keyframes bootTrace`, added `contain: layout style paint` on `.boot-loader`, `will-change: stroke-dashoffset` on `.boot-trace-stroke`, and kept zero-blur `radial-gradient` on `.boot-glow`.
- `M public/app.js` — Chunked secondary module initialization (`featureInitPromise` across `requestAnimationFrame` turns) so `#bootLoader` paints before secondary handler setup.
- `?? docs/superpowers/handovers/2026-11-28-auth-otp-and-ui-revamp-handover.md` — This handover file.

---

## Verification & Profiling Status

- **Test Suite:** `node --test tests/*.test.mjs` — **58/58 passed** (`0` failures, `0` skipped).
- **Syntax Check:** `node --check public/app.js` — exited `0`.
- **Chrome Mobile Trace (`390×844`, `4×` CPU throttling):**
  - Pre-optimization baseline (Option B): `#bootLoader` visible `139.3 ms`–`922.7 ms`, avg `21.76 ms`, max/p95 `50.1 ms`, `7` dropped frames in first ~`450 ms`, steady `60 fps` (`16.6–16.8 ms`) after ~`450 ms`.
  - Post-optimization re-trace was not run yet because Chrome `DevToolsActivePort` disconnected.

---

## Environment & User Preferences

- **Git / Deploy Workflow:** Wait for user review before committing new work; when the user says **"commit, push and deploy"** (or **"commit and push"**), commit and push to `master` immediately (Render auto-deploys from `master`).
- **Render Env Vars:** Set `RESEND_API_KEY` and a verified-domain `RESEND_FROM_EMAIL` (plus optional `APP_BASE_URL`) in Render so all users can receive reset and OTP emails.
- **Local SQLite (`pocket-ledger.sqlite`):** `kikazaru29@gmail.com` was reset to `email_verified_at = NULL` for local OTP testing.

---

## Recommended Next Steps

1. Re-run the `4×` CPU-throttled Chrome mobile trace (with `chrome://inspect/#remote-debugging` enabled) or verify directly on mobile, then **commit, push, and deploy** the uncommitted boot-frame optimization + this handover file.
2. Verify a custom sending domain in Resend and configure `RESEND_API_KEY` + `RESEND_FROM_EMAIL` on Render.
