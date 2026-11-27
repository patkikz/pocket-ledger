# PocketLedger Session Handover — User Profile, SPA Routing, UI Overhaul & PWA 4-Digit PIN Lock

**Date:** 2026-11-28
**Branch:** `master` (HEAD before handover commit: `de27293`, pushed to `https://github.com/patkikz/pocket-ledger`)
**Test Status:** `npm test` passing **42/42** tests (0 failed, 0 skipped)

---

## 1. What Was Built This Session

1. **User Profile, Avatar Dropdown & Profile Settings (`src/ledger.mjs`, `src/ledger-pg.mjs`, `src/server.mjs`, `public/js/profile.js`, `public/index.html`, `public/styles.css`):**
   - Added additive `users` columns (`display_name`, `avatar_color`, `theme`, `default_account_id`) in both SQLite and PostgreSQL (`ALTER TABLE users ADD COLUMN IF NOT EXISTS ...`).
   - Added `PATCH /api/profile` (emits SSE `profile_updated`) and `POST /api/auth/change-password` (blocks `DEMO_EMAILS` with `403`, revokes other active sessions).
   - Replaced `#settingsOverlay` with a topbar **Avatar chip** (`#openProfileBtn`) + `#profileDropdown` (Name/Email header, **Profile**, inline **Theme** radio list `System`/`Dark`/`Light`, and rose-highlighted **Sign out**), opening a two-column **Profile Settings** view (`#view-profile`) with **Preferences** and **Security** tabs.
   - Added full Light mode CSS tokens (`:root[data-theme="light"]`) with `localStorage` (`pl_theme`) flash-free boot sync, and password visibility eye toggles (`[data-toggle-password]`) across all 4 password fields.

2. **Client-Side & SPA Fallback Routing (`public/js/state.js`, `public/app.js`, `src/server.mjs`, `public/sw.js`):**
   - Implemented History API routing (`parseRoute`, `buildRoutePath`, `popstate`) for `/`, `/accounts`, `/activity`, `/profile`, and `/profile/security` (with `/account*` aliases), hiding `.main-nav` while inside Profile Settings.
   - Added SPA fallback in `src/server.mjs` and offline navigation fallback in `public/sw.js` so refreshing any route restores the active tab/view.

3. **UI Uniformity & Reusable Components (`public/js/modal.js`, `public/js/confirm.js`, `public/js/dashboard.js`, `public/styles.css`):**
   - **Accounts Tab:** Added Net Liquidity summary banner (`#accountsSummaryMeta` with account count, Cash & Savings, and Card Debt pills) and color-coded account cards with type icons and Default badge.
   - **Activity Tab:** Added date-grouped headers (`.tx-date-header`), search icon (`padding-left: 38px`), aligned amount column (`.tx-actions`), and tinted `Edit` (indigo) / `Undo` (rose) buttons.
   - **Reusable Components & Polish:** Extracted `public/js/modal.js` (`openModal`, `closeModal`, `closeAllModals`, `initModalComponents`), added Swal-style `confirmDialog` (`public/js/confirm.js`) for Activity Undo / Transaction Remove / Archive Account, centered all modals on mobile & small screens, converted `#toastBanner` to an upper-right floating toast, added `#scrollTopBtn` across mobile & desktop, and unified `--radius-card`, `--radius-control`, `--shadow-card`, button, input, and select styles.

4. **4-Digit PWA App PIN Lock (`src/ledger.mjs`, `src/ledger-pg.mjs`, `src/server.mjs`, `public/js/pin-lock.js`, `public/sw.js`):**
   - Added `pin_hash` column to `users` (`hasPin` boolean in `getUser`), `setPin`, `removePin`, `verifyPin`, and `POST/DELETE /api/auth/pin` + `POST /api/auth/pin/verify` (returning `400` on wrong PIN so it never logs the user out).
   - Added **App PIN Lock** controls in **Profile → Security** and the **Circular Fintech Keypad** lock overlay (`#pinLockOverlay`) with personalized avatar (`Welcome back, <Name>`), 4 animated dots with shake feedback, auto-submit on 4th digit, and **Sign out** fallback.
   - Scoped PIN lock strictly to installed PWA mode (`isStandalonePwa()` checking `standalone`, `minimal-ui`, `fullscreen`, and iOS `navigator.standalone`), locking on launch, `visibilitychange`, `pagehide`, and `pageshow` (`e.persisted`), while staying disabled in desktop/browser tabs.
   - Bumped service worker cache to `pocketledger-shell-v11` precaching `/js/profile.js`, `/js/modal.js`, `/js/confirm.js`, and `/js/pin-lock.js`.

---

## 2. Key Commits Today (`master`)
- `67a61bf` — `feat: add user profile dropdown, account settings page, and light/dark theme`
- `e25b882` — `feat: add client-side and SPA fallback routing for tabs and account settings`
- `b4cf2d1` — `style: highlight sign out action in rose in profile dropdown`
- `d447edb` — `feat: hide nav in account settings and add password visibility toggles`
- `f0d4099` — `style: polish theme segmented control and select inputs in account settings`
- `f4889c2` — `fix: center modals on mobile and unify modal, button, and input components`
- `faf1eb4` — `feat: add 4-digit app PIN lock with circular keypad and Profile Security controls`
- `2ebbb6b` — `fix: scope app PIN lock to standalone PWA mode and lock on open/background`
- `de27293` — `fix: broaden PWA display-mode detection and add pageshow BFCache PIN lock`

---

## 3. Verification & Notes
- **Tests:** `npm test` passing **42/42** tests (including [tests/profile.test.mjs](file:///c:/Users/Patpat/pocket-ledger/tests/profile.test.mjs)).
- **Local SQLite:** `node_modules` installed via `npm ci`; local `kikazaru29@gmail.com` password updated in `pocket-ledger.sqlite`.
- **Render + Supabase:** `de27293` pushed to `master`; `createPostgresLedger.init()` automatically runs additive `ALTER TABLE users ADD COLUMN IF NOT EXISTS ...` migrations on startup.
