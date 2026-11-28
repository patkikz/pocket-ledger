# Login Page UI Revamp Design

**Date:** 2026-11-28
**Status:** Draft — awaiting approval

## Intent & Why

The current `#authView` renders a single `400px` card centered on a flat dark background, leaving most of the desktop viewport empty and feeling like a generic modal. Revamping it into a responsive split-screen fintech layout makes first impressions feel intentional on desktop while keeping mobile sign-in fast and uncluttered.

## Goals, Non-Goals, & Anti-Goals

- **Goals:**
  - Desktop (`>= 900px`): Two-column split layout with a brand/value-proposition hero panel on the left and an elevated auth card on the right, over a subtle radial indigo/emerald ambient backdrop.
  - Mobile (`< 900px`): Collapse cleanly to the focused auth card with a compact brand header and `44px+` touch-friendly controls.
  - Support both dark and light themes (`:root[data-theme="light"]`) using existing CSS tokens, and preserve all existing form IDs (`#authView`, `#authForm`, `#forgotPasswordForm`, `#resetPasswordForm`, `#demoLoginWrap`).
- **Non-Goals:**
  - Changing auth API endpoints, form validation logic, or adding external CSS frameworks.
- **Anti-Goals:**
  - Heavy decorative animations or cluttering mobile screens with marketing copy above the sign-in form.

## Approaches Considered

1. **Split-Screen Fintech Layout (Desktop) + Ambient Mobile Card — *Chosen***
   - Rich desktop presence with a concise hero panel + elevated card; collapses to a focused mobile card.
2. **Elevated Centered Card (Minimalist)**
   - Keeps one column everywhere, leaving wide empty margins on desktop.

## Design Details

- **Backdrop (`.auth-shell`):** Full-viewport (`100dvh`) flex container with subtle dual radial gradients (`--accent-primary` top-left, `--accent-emerald` bottom-right) at low opacity (`0.12` / `0.09`) so both dark and light themes look crisp.
- **Layout Grid (`.auth-layout`):**
  - On desktop (`>= 900px`), `max-width: 960px`, 2-column CSS grid (`1.1fr 420px`, `gap: 3.5rem`, centered vertically).
  - Left column (`.auth-hero`, hidden below `900px` since mobile shows the compact `.auth-brand` inside the card):
    - Brand badge + **PocketLedger** wordmark.
    - Headline: *"Know your Safe-to-Spend in seconds."*
    - Short subtitle: *"Track every peso or dollar with ACID ledger accuracy—built for 4-tap mobile entry and effortless monthly reconciliation."*
    - 3 compact feature rows with SVG icons:
      1. **Sub-5-Second Entry** — Smart wallet & category defaults for instant logging.
      2. **Real-Time Sync** — Instant updates across your desktop and phone.
      3. **Private & Protected** — Scrypt auth, rate-limited logins, and optional 4-digit app PIN.
- **Auth Card (`.auth-card`):**
  - Elevated surface (`--bg-surface`), `1px solid var(--border-strong)`, subtle top highlight and soft shadow, `border-radius: 1.35rem`, `padding: 1.75rem`.
  - Compact `.auth-brand` visible on `< 900px` (hidden on desktop where `.auth-hero` already shows the brand).
  - Dynamic card heading (`#authCardTitle` / `#authCardSub`) updated by `setAuthMode(mode)`:
    - `login`: *"Welcome back"* / *"Sign in to your ledger"*
    - `register`: *"Create your ledger"* / *"Start tracking in under a minute"*
    - `forgot`: *"Reset your password"* / *"We'll email you a one-time reset link"*
    - `reset`: *"Set a new password"* / *"Choose a strong password (8+ characters)"*
  - Larger touch-friendly inputs (`min-height: 44px`), clearer focus rings (`--accent-primary`), refined gradient primary button with subtle hover lift, and `prefers-reduced-motion` respected.
