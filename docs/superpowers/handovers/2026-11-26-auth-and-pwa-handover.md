# PocketLedger Session Handover — Auth, Persistent Sessions & Mobile PWA

**Date:** 2026-11-26
**Branch:** `master` (HEAD: `ea1e8c6`, fast-forward merged from `feat/auth-and-pwa`)
**Test Status:** `npm test` passing **23/23** tests (0 failed, 0 skipped)

---

## 1. What Was Built This Session
We took PocketLedger from a `localhost`-only prototype with header-based tenant switching (`x-user-id`) to a session-authenticated, installable mobile PWA ready for real-device dogfooding:

1. **Password Auth & Persistent SQLite Sessions (`src/ledger.mjs`, `src/seed.mjs`):**
   - Additive SQLite migration via `PRAGMA table_info(users)` adding `users.password_hash` and creating the `sessions` table (`id`, `user_id`, `token_hash`, `expires_at`, `created_at`).
   - Zero-dependency password hashing using `crypto.scryptSync` (16-byte random salt, 64-byte derived key) + `crypto.timingSafeEqual`.
   - 30-day persistent sessions stored as SHA-256 hex digests (`token_hash`) with `< 15 days` sliding renewal.
   - `registerUser` normalizes email (`trim().toLowerCase()`), requires password `>= 8` chars, and seeds 5 starter categories (`Groceries`, `Dining & Coffee`, `Transport`, `Bills & Subs`, `Income / Paycheck`) with 0 accounts inside a transaction.
   - Demo accounts (`patrick@pocketledger.app`, `alex.isolated@pocketledger.app`) are backfilled with password `pocketledger-demo` unless `DISABLE_DEMO=1`.

2. **HTTP Cookie Auth & Configurable Hosting (`src/server.mjs`):**
   - Added `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me` (`{ authenticated, user, demoEnabled }`).
   - Removed `x-user-id` header and `?userId=` query param tenant spoofing; all non-auth `/api/*` routes require a valid `pl_session` cookie (`HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`, plus `; Secure` on HTTPS / `x-forwarded-proto: https`).
   - Added `'.png': 'image/png'` to `MIME_TYPES` and `HOST` (default `127.0.0.1`) / `PORT` (default `3000`) env configuration.

3. **Mobile-First Auth Gate & Error Handling (`public/index.html`, `public/styles.css`, `public/app.js`):**
   - Added `#authView` (Sign In / Create Account toggle, `16px` inputs with `autocomplete`, optional "Try Demo Account" button controlled by `demoEnabled`).
   - Bootstraps via `GET /api/auth/me`; `apiFetch` handles `401` by clearing client state and returning to `#authView`.
   - Replaced Settings tenant switcher with signed-in email display (`#settingsUserEmail`) and `#logoutBtn`.
   - Added `handleActionError` and `readErrorMessage` across async UI handlers to prevent unhandled `401` promise rejections and false-positive toasts.

4. **Complete PWA Installability (`public/manifest.json`, `public/sw.js`, `public/icons/*`):**
   - Added `public/icons/icon.svg`, `public/icons/icon-192.png`, and `public/icons/icon-512.png`, plus `apple-touch-icon` and iOS status-bar meta tags in `public/index.html`.
   - Added `public/sw.js` caching static shell assets while strictly bypassing `/api/*` and non-`GET` requests.

---

## 2. Key Artifacts & Commits
- **Design Spec:** `docs/superpowers/specs/2026-11-26-auth-and-pwa-design.md`
- **Implementation Plan:** `docs/superpowers/plans/2026-11-26-auth-and-pwa.md`
- **Commits on `master`:**
  - `69fe84c` — `docs: add auth, persistent sessions, and PWA spec and plan`
  - `e9d80cb` — `feat: add scrypt password auth and SQLite session store`
  - `cca61f9` — `feat: enforce persistent session cookie auth and configurable host`
  - `aac2db2` — `feat: add mobile-first auth gate and persistent session boot`
  - `928175d` — `fix: scope quick entry mode-tabs and ignore auth errors in boot`
  - `1019b14` — `feat: add PWA icons, service worker, and iOS home-screen meta tags`
  - `ea1e8c6` — `fix(pwa,ui): add PNG icons, sw waitUntil, sw vm test, and 401/res.ok guards`

---

## 3. Running & Testing
```powershell
# Run full test suite (23 tests across tests/*.test.mjs)
npm test

# Start locally (127.0.0.1:3000)
npm start

# Start on LAN for phone testing (optional DISABLE_DEMO=1)
$env:HOST="0.0.0.0"; npm start
```

---

## 4. Known Deferred Minors & Next Steps
**Deferred Minor Items (low-priority, non-blocking):**
- `src/ledger.mjs`: `authenticateUser` returns early without a dummy `scryptSync` when user/hash is missing; `budgetCycleStartDay` coerces booleans via `Number(...)`.
- `src/server.mjs`: JSON `null`/primitive bodies hit `TypeError` (`400`) instead of an explicit object-shape validation message; `DEMO_EMAILS` is listed in both `src/seed.mjs` and `src/server.mjs`.
- `public/app.js`: `showAuthView` does not reset `#toastBanner`, `#txNoteInput`, `state.historyFilter`, `state.txType`, or `state.referenceDate` on logout.

**Recommended Next Steps:**
1. **Real-Device Dogfooding:** Open `http://<LAN-IP>:3000` on your phone, install to home screen, and verify icon rendering, safe-area insets, 30-day session persistence across app closes, and `<5s` keypad entry.
2. **Everyday CRUD Polish:** Add transaction editing (note/category/date/amount) and edit/archive support for accounts, categories, and recurring bills.
3. **Insights & Bank CSV Import:** Add cycle-over-cycle spending comparisons and CSV statement import for faster weekly reconciliation.
