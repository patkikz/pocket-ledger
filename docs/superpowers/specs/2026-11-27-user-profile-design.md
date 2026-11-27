# User Profile & Customizations Design

**Date:** 2026-11-27
**Status:** Approved

---

## 1. Intent & Why
PocketLedger currently scatters user-level settings inside a small **Preferences** modal (`#settingsOverlay`) with only Signed-in Account, Home Currency, and Monthly Budget Reset Day. Users have no way to personalize their identity, app theme, default quick-entry account, or password.

Adding a dedicated **Profile** section (`#view-profile`) gives all user customizations a single, clean home in the main navigation.

---

## 2. Goals, Non-Goals & Constraints

### Goals
- Replace the **Preferences** modal (`#settingsOverlay`) with a dedicated **Profile** tab (`#view-profile`) in `nav.main-nav` alongside *Overview*, *Accounts*, and *Activity*.
- Replace the topbar gear button (`#openSettingsBtn`) with a compact **Avatar chip** (`#openProfileBtn`) displaying the user's initials and chosen accent color, which jumps to the Profile tab.
- Support four customization areas on `#view-profile`:
  1. **Identity:** Display Name, Avatar Color (curated swatch palette, initials-based), and read-only Email.
  2. **Budget & Quick-Entry Preferences:** Home Currency (`USD`, `PHP`, `EUR`, `GBP`), Monthly Budget Reset Day, and Default Quick-Entry Account (optional pinned account overriding the smart `lastUsedAccountId` default).
  3. **Appearance:** Theme (`system`, `dark`, `light`) with light-mode CSS variables and no-flash boot application.
  4. **Account & Security:** Change Password (current + new + confirm) and Log Out.

### Non-Goals
- Profile photo/image uploads or cloud object storage.
- Email address changes or multi-factor authentication.
- Removing `POST /api/settings` (keep it working for API backwards compatibility).

### Constraints
- **Dual-DB parity:** All schema changes and queries must be implemented identically in both SQLite (`src/ledger.mjs`) and PostgreSQL (`src/ledger-pg.mjs`) using additive, idempotent migrations.
- **Real-time sync:** Profile updates must emit an SSE `ledger_updated` event via `notifyUser(userId, 'profile_updated')` so open devices reflect changes immediately.
- **PWA cache:** Any new frontend ES module (`public/js/profile.js`) must be added to `public/sw.js` precache assets.
- **Existing tests:** Any existing UI tests referencing `#settingsOverlay` or `#openSettingsBtn` must be updated cleanly to match the new Profile tab/chip.

---

## 3. Approaches Considered

| Approach | Summary | Trade-offs |
|---|---|---|
| **Option A: Unified Profile Tab (Chosen)** | Add a 4th **Profile** tab (`#view-profile`), move Currency / Reset Day / Log out out of `#settingsOverlay` into `#view-profile`, and replace the topbar gear icon with an Avatar chip. | One obvious place for all user customizations with zero duplicated UI. Expands `main-nav` from 3 tabs to 4. |
| **Option B: Profile Tab + Preferences Modal** | Add `#view-profile` only for Identity, Theme, and Password while keeping `#settingsOverlay` for Currency, Reset Day, and Log out. | Leaves `settings.js` untouched, but splits user settings across two separate places. |

**Decision:** Option A — a single unified Profile tab is cleaner and matches how mobile-first finance apps organize personal settings.

---

## 4. Architecture & Data Model

### 4.1 Database Schema (`users` table)
Add four columns to `users` in both `src/ledger.mjs` (SQLite `PRAGMA table_info` additive `ALTER TABLE`) and `src/ledger-pg.mjs` (PostgreSQL `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`):
- `display_name TEXT` (nullable, trimmed, max 60 chars)
- `avatar_color TEXT NOT NULL DEFAULT '#6366f1'` (validated against curated hex palette)
- `theme TEXT NOT NULL DEFAULT 'system'` (validated: `'system' | 'dark' | 'light'`)
- `default_account_id TEXT` (nullable; must belong to `userId` and not be archived when set)

`getUser(userId)` returns:
```js
{
  id, email, displayName, avatarColor, theme, defaultAccountId,
  homeCurrencyCode, budgetCycleStartDay, lastUsedAccountId, createdAt
}
```

### 4.2 Ledger Methods (`src/ledger.mjs` & `src/ledger-pg.mjs`)
- `updateUserProfile(userId, patch)`:
  - Validates and updates any provided subset of `displayName`, `avatarColor`, `theme`, `defaultAccountId`, `homeCurrencyCode`, `budgetCycleStartDay`.
  - If `defaultAccountId` is `""` or `null`, clears it (`null`). If non-null, verifies the account exists, belongs to `userId`, and is not archived.
  - Keep `updateUserSettings` as a thin alias/delegation to `updateUserProfile` so existing callers/tests stay compatible.
- `changePassword(userId, { currentPassword, newPassword, currentSessionToken })`:
  - *(Builder/design call)* Rejects demo accounts (`DEMO_EMAILS`) with a `403` error so "Try Demo Account" cannot be broken; `#view-profile` disables the password form with a brief demo-account notice when signed in as a demo user.
  - Verifies `currentPassword` against `password_hash` using existing `scrypt` verification (returns `400`/`403` error if wrong or if user has no password hash).
  - Validates `newPassword` is a string with length `>= 8`.
  - Updates `password_hash` and revokes other active sessions for `userId` while keeping the current session (if `currentSessionToken` is provided) active.

### 4.3 HTTP API (`src/server.mjs`)
- `PATCH /api/profile`: Authenticated. Calls `ledger.updateUserProfile(userId, body)`, emits `notifyUser(userId, 'profile_updated')`, returns `200 { user }`.
- `POST /api/auth/change-password`: Authenticated. Calls `ledger.changePassword(userId, { currentPassword, newPassword, currentSessionToken })`, returns `200 { ok: true }`.
- `POST /api/settings`: Kept intact for backwards compatibility, delegating to `ledger.updateUserSettings`.

### 4.4 Frontend (`public/*`)
- **Navigation & Topbar (`public/index.html`, `public/app.js`, `public/js/state.js`):**
  - Add 4th tab `<button class="nav-tab" data-view="profile">Profile</button>` to `nav.main-nav`.
  - Replace `#openSettingsBtn` with `<button id="openProfileBtn" class="profile-chip" aria-label="Profile">` showing user initials + `avatarColor` background.
  - Remove `#settingsOverlay` modal.
- **Profile View (`#view-profile`, `public/js/profile.js`):**
  Uses a clean, stacked-list card layout:
  1. **Profile Header:** Avatar badge (initials derived from `displayName` or `email`) + **Display Name** + read-only **Email**.
  2. **Account & Security Rows:**
     - **Edit Profile** (expands or opens inline editor for Display Name + 6-color Avatar swatch picker `#6366f1`, `#10b981`, `#f59e0b`, `#f43f5e`, `#38bdf8`, `#a855f7`).
     - **Change Password** (Current Password, New Password, Confirm Password; disabled with a demo-account notice when signed in as `DEMO_EMAILS`).
     - **Export Ledger (CSV)** (links to/downloads `/api/export.csv`).
  3. **Theme Radio List:** `System`, `Dark`, `Light` with active indicator dot. Applying theme sets `data-theme` on `<html>` (`light` / `dark` / resolved from `prefers-color-scheme`) and caches `pl_theme` in `localStorage` for flash-free initial paint.
  4. **Budget & Ledger Rows:** Home Currency select, Monthly Budget Reset Day select, Default Quick-Entry Account select (`Smart default (last used)` + active accounts).
  5. **Sign Out** row (`#logoutBtn`) at the bottom.
- **Quick Entry Integration (`public/js/dashboard.js`):**
  - When pre-selecting the default account for quick entry, prefer `user.defaultAccountId` (if present and active) over `user.lastUsedAccountId`.
- **Styling (`public/styles.css`):**
  - Add light-mode CSS custom properties under `:root[data-theme="light"]` (and `color-scheme: light`), plus `.profile-chip`, `.profile-avatar-lg`, `.color-swatch-grid`, and `.profile-grid` responsive layout.

---

## 5. Left to the Builder
- Exact CSS spacing, responsive breakpoints, and icon SVGs for the Profile tab and Avatar chip.
- Whether `settings.js` is replaced by `profile.js` or kept as a re-export, as long as `sw.js` precaches all `/js/*.js` files.
- Exact test file organization (extending `tests/auth.test.mjs` / `tests/edit-and-insights.test.mjs` or adding `tests/profile.test.mjs`).
