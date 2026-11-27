# User Profile & Customizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `#settingsOverlay` Preferences modal with a dedicated **Profile** tab (`#view-profile`) and topbar Avatar chip (`#openProfileBtn`), supporting Display Name, Avatar Color, Theme (`system` / `dark` / `light`), Default Quick-Entry Account, Home Currency, Monthly Budget Reset Day, Change Password, CSV Export, and Sign Out across both SQLite and PostgreSQL.

**Architecture:** Additive schema migration adds `display_name`, `avatar_color`, `theme`, and `default_account_id` to `users` in both `src/ledger.mjs` and `src/ledger-pg.mjs`. `src/server.mjs` exposes `PATCH /api/profile` and `POST /api/auth/change-password` while keeping `POST /api/settings` backwards-compatible. The frontend replaces `#settingsOverlay` with a stacked-list `#view-profile` section managed by `public/js/profile.js` and adds light-mode CSS tokens in `public/styles.css`.

**Tech Stack:** Node.js >= 24 (`node:sqlite`, `node:crypto`, `node:test`), PostgreSQL (`pg`), Vanilla ES Modules, HTML/CSS.

**Spec:** [2026-11-27-user-profile-design.md](file:///c:/Users/Patpat/pocket-ledger/docs/superpowers/specs/2026-11-27-user-profile-design.md)

## Global Constraints
- Dual-DB parity: all schema changes and queries must work identically in `src/ledger.mjs` (SQLite) and `src/ledger-pg.mjs` (PostgreSQL).
- Keep `POST /api/settings` and `updateUserSettings` working for backwards compatibility.
- Emit SSE `notifyUser(userId, 'profile_updated')` on `PATCH /api/profile`.
- Demo accounts (`DEMO_EMAILS`) are blocked from changing password (`403`).
- Update `public/sw.js` precache list (`SHELL_ASSETS`) and bump cache name if adding `public/js/profile.js`.

## Review Focus
- Invalid `avatarColor` (non-palette hex) or invalid `theme` (anything other than `'system'`, `'dark'`, `'light'`) must be rejected with `RangeError`/`TypeError` (HTTP `400`), never silently stored.
- Setting `defaultAccountId` to an archived account or another user's account must be rejected (HTTP `400`/`404`); setting it to `null` or `""` clears it cleanly.
- Clearing `displayName` to `""` or whitespace stores `null` so the UI falls back to the user's email prefix cleanly; names > 60 chars are rejected.
- `changePassword` must verify `currentPassword`, reject `newPassword.length < 8`, reject `DEMO_EMAILS` with `403`, and revoke *other* sessions while keeping the caller's current session valid.
- Light/dark theme must apply via `localStorage.getItem('pl_theme')` before `/api/auth/me` resolves so there is no theme flash on reload.

---

### Task 1: SQLite & PostgreSQL Profile Schema, `updateUserProfile`, and `changePassword`

**Files:**
- Modify: `src/ledger.mjs` (`ensureColumn` migrations, `getUser`, `updateUserProfile`, `updateUserSettings`, `changePassword`)
- Modify: `src/ledger-pg.mjs` (`init` `ALTER TABLE` migrations, `getUser`, `updateUserProfile`, `updateUserSettings`, `changePassword`)
- Create: `tests/profile.test.mjs`

**Interfaces:**
- Produces:
  - `ledger.updateUserProfile(userId, { displayName, avatarColor, theme, defaultAccountId, homeCurrencyCode, budgetCycleStartDay })` -> `User`
  - `ledger.changePassword(userId, { currentPassword, newPassword, currentSessionToken })` -> `boolean`
  - `User` shape: `{ id, email, displayName, avatarColor, theme, defaultAccountId, homeCurrencyCode, budgetCycleStartDay, lastUsedAccountId, createdAt }`

- [ ] **Step 1: Write the failing unit tests in `tests/profile.test.mjs`**
  Test:
  1. `getUser` returns default `displayName: null`, `avatarColor: '#6366f1'`, `theme: 'system'`, `defaultAccountId: null`.
  2. `updateUserProfile` updates `displayName` (trimmed, `""` -> `null`, >60 chars throws), `avatarColor` (rejects invalid hex), `theme` (rejects `'neon'`), and `defaultAccountId` (accepts active owned account, clears on `null`, rejects archived or another user's account).
  3. `changePassword` verifies `currentPassword`, rejects short `newPassword`, rejects `DEMO_EMAILS`, updates `password_hash`, and revokes other sessions while keeping `currentSessionToken` valid.
  4. `createPostgresLedger` mock query test verifies `init` issues `ALTER TABLE users ADD COLUMN IF NOT EXISTS` for the 4 new columns and `updateUserProfile` issues parameterized `UPDATE users`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/profile.test.mjs`
  Expected: FAIL (`updateUserProfile is not a function` / `changePassword is not a function`).

- [ ] **Step 3: Implement SQLite & PostgreSQL profile columns, `updateUserProfile`, and `changePassword`**
  - In `src/ledger.mjs`:
    - Add `display_name TEXT`, `avatar_color TEXT NOT NULL DEFAULT '#6366f1'`, `theme TEXT NOT NULL DEFAULT 'system'`, `default_account_id TEXT` to `CREATE TABLE IF NOT EXISTS users` and additive `PRAGMA table_info(users)` `ALTER TABLE` migration.
    - Update `getUser` to return `displayName`, `avatarColor`, `theme`, `defaultAccountId`.
    - Implement `updateUserProfile(userId, patch)` with palette validation (`#6366f1`, `#10b981`, `#f59e0b`, `#f43f5e`, `#38bdf8`, `#a855f7`), theme validation (`system`, `dark`, `light`), `displayName` validation (<= 60 chars), and `defaultAccountId` ownership/active check. Delegate `updateUserSettings` to `updateUserProfile`.
    - Implement `changePassword(userId, { currentPassword, newPassword, currentSessionToken })` checking `DEMO_EMAILS` (`Error('Demo accounts cannot change password')` with `.statusCode = 403`), verifying `currentPassword`, hashing `newPassword`, updating `password_hash`, and deleting other sessions for `userId` (`token_hash != currentTokenHash`).
  - Mirror the exact same schema, validations, `getUser`, `updateUserProfile`, `updateUserSettings`, and `changePassword` in `src/ledger-pg.mjs`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `node --test tests/profile.test.mjs`
  Expected: PASS.

---

### Task 2: HTTP API (`PATCH /api/profile` & `POST /api/auth/change-password`)

**Files:**
- Modify: `src/server.mjs` (add `PATCH /api/profile` and `POST /api/auth/change-password`; map `403` from `changePassword`)
- Modify: `tests/profile.test.mjs` (add HTTP integration tests)

**Interfaces:**
- Consumes: `ledger.updateUserProfile`, `ledger.changePassword`, `notifyUser`, `parseCookies`
- Produces:
  - `PATCH /api/profile` -> `200 { user }` (broadcasts `notifyUser(userId, 'profile_updated')`)
  - `POST /api/auth/change-password` -> `200 { ok: true }` (or `400`/`403`)

- [ ] **Step 1: Write the failing HTTP tests in `tests/profile.test.mjs`**
  Test:
  1. `PATCH /api/profile` requires auth (`401` without cookie), updates `displayName`, `avatarColor`, `theme`, `defaultAccountId`, `homeCurrencyCode`, `budgetCycleStartDay`, and returns `200 { user }`.
  2. `PATCH /api/profile` returns `400` for invalid `theme` or invalid `avatarColor`.
  3. `POST /api/auth/change-password` returns `403` for demo user, `400`/`401` for wrong current password, and `200 { ok: true }` for valid user (then new password logs in, old password fails).

- [ ] **Step 2: Run test to verify it fails**
  Run: `node --test tests/profile.test.mjs`
  Expected: FAIL (`404 API endpoint not found`).

- [ ] **Step 3: Implement `PATCH /api/profile` and `POST /api/auth/change-password` in `src/server.mjs`**
  - Add `PATCH /api/profile` in the authenticated API block, calling `ledger.updateUserProfile(userId, body)`, calling `notifyUser(userId, 'profile_updated')`, and returning `200 { user }`.
  - Add `POST /api/auth/change-password` in the authenticated API block, passing `currentSessionToken: cookies[SESSION_COOKIE]` to `ledger.changePassword`, and returning `200 { ok: true }`. Ensure `err.statusCode === 403` maps to HTTP `403`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `node --test tests/profile.test.mjs`
  Expected: PASS.

---

### Task 3: Dedicated `#view-profile` Markup, Topbar Avatar Chip, Light/Dark Theme Tokens & `sw.js`

**Files:**
- Modify: `public/index.html` (replace `#openSettingsBtn` with `#openProfileBtn` avatar chip; add 4th `.nav-tab[data-view="profile"]`; add `#view-profile` stacked-list section; remove `#settingsOverlay`)
- Modify: `public/styles.css` (add `:root[data-theme="light"]` tokens, `.profile-chip`, `.profile-card`, `.profile-header`, `.profile-row`, `.theme-radio-list`, `.color-swatch-grid`)
- Modify: `public/sw.js` (add `/js/profile.js`, bump `CACHE_NAME` to `pocketledger-shell-v5`)

- [ ] **Step 1: Update `public/index.html`**
  - Replace `#openSettingsBtn` with `<button type="button" class="profile-chip" id="openProfileBtn" aria-label="Profile"><span id="topbarAvatar" class="profile-avatar-sm">?</span></button>`.
  - Add 4th `<button type="button" class="nav-tab" data-view="profile">` in `nav.main-nav`.
  - Add `<section id="view-profile" class="view-section">` with:
    - Profile header (`#profileAvatarLg`, `#profileDisplayName`, `#profileEmail`, `#toggleEditIdentityBtn`) + collapsible/inline identity editor (`#profileIdentityForm`, `#profileNameInput`, `#profileColorPicker` swatches, `#saveIdentityBtn`).
    - Account & Security rows (`#toggleChangePasswordBtn`, `#changePasswordForm` with demo notice `#demoPasswordNotice`, and `<a href="/api/export.csv" class="profile-row" download>` for CSV Export).
    - Theme radio list (`data-theme-choice="system|dark|light"`).
    - Budget & Ledger rows (`#currencySelect`, `#cycleStartDaySelect`, `#defaultAccountSelect`).
    - Sign Out row (`#logoutBtn`).
  - Remove `#settingsOverlay`.

- [ ] **Step 2: Update `public/styles.css` and `public/sw.js`**
  - Add `:root[data-theme="light"]` custom properties and `color-scheme: light` in `public/styles.css`, plus clean styling for `.profile-chip`, `.profile-card`, `.profile-row`, `.theme-radio-list`, and `.color-swatch-grid`.
  - Add `'/js/profile.js'` to `SHELL_ASSETS` and bump `CACHE_NAME` to `'pocketledger-shell-v5'` in `public/sw.js`.

- [ ] **Step 3: Verify HTML/CSS/SW assets test**
  Run: `node --test tests/auth-ui.test.mjs`
  Expected: PASS.

---

### Task 4: Frontend Profile Module, Theme Boot Sync, Quick-Entry Default & Auth Wiring

**Files:**
- Create: `public/js/profile.js`
- Modify: `public/js/state.js` (theme helper `applyTheme(theme)`)
- Modify: `public/js/auth.js` (render profile header/chip on `showAppShell`, reset profile sub-forms on `showAuthView`)
- Modify: `public/js/dashboard.js` (populate `#defaultAccountSelect`, prefer `user.defaultAccountId` over `lastUsedAccountId` for quick entry, sync profile UI on dashboard refresh)
- Modify: `public/js/settings.js` (keep or delegate cleanly if still imported, or replace import in `public/app.js` with `profile.js`)
- Modify: `public/app.js` (apply cached `pl_theme` on boot, wire `#openProfileBtn` to `switchView('profile')`, initialize `initProfileHandlers()`)
- Modify: `tests/profile.test.mjs` (add frontend/HTML/SW assertions for `#view-profile`, `#openProfileBtn`, `data-view="profile"`, and `sw.js` precaching `/js/profile.js`)

- [ ] **Step 1: Write frontend markup & SW assertions in `tests/profile.test.mjs`**
  Assert `public/index.html` contains `data-view="profile"`, `id="view-profile"`, `id="openProfileBtn"`, and no `id="settingsOverlay"`; assert `public/sw.js` includes `'/js/profile.js'`.

- [ ] **Step 2: Implement `applyTheme` in `public/js/state.js` and `public/js/profile.js`**
  - `applyTheme(theme)` resolves `'system'` via `window.matchMedia('(prefers-color-scheme: light)').matches`, sets `document.documentElement.dataset.theme`, and writes `localStorage.setItem('pl_theme', theme)`.
  - `renderProfile(user, accounts)` updates `#topbarAvatar`, `#profileAvatarLg`, `#profileDisplayName`, `#profileEmail`, color swatch active state, theme radio active dot, `#currencySelect`, `#cycleStartDaySelect`, `#defaultAccountSelect`, and demo-account password notice.
  - `initProfileHandlers()` wires identity save (`PATCH /api/profile`), theme radio clicks (`PATCH /api/profile`), currency/reset-day/default-account changes (`PATCH /api/profile`), and change-password submit (`POST /api/auth/change-password`).

- [ ] **Step 3: Wire `public/app.js`, `public/js/auth.js`, and `public/js/dashboard.js`**
  - Apply cached `pl_theme` immediately on `app.js` load; wire `#openProfileBtn` -> `switchView('profile')`.
  - Update `dashboard.js` to prefer `d.user.defaultAccountId` (if active) over `d.user.lastUsedAccountId` when setting `state.quickEntryAccountId`, and call `renderProfile(d.user, d.accounts)`.

- [ ] **Step 4: Run full test suite**
  Run: `npm test`
  Expected: All tests pass (0 failed, 0 skipped).
