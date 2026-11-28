import { state, openModal, switchView, parseRoute, setViewChangeHandler, applyTheme } from './js/state.js';
import { initModalComponents } from './js/modal.js';
import { initAuthHandlers, setAuthMode, setResetToken, showAuthError, showAuthView, showAppShell } from './js/auth.js';
import { fetchDashboard, shiftReferenceMonth } from './js/dashboard.js';
import { initQuickEntryHandlers } from './js/quick-entry.js';
import { initAccountHandlers } from './js/accounts.js';
import { initBudgetAndRecurringHandlers, openAddCategoryModal } from './js/budgets.js';
import { initActivityHandlers, ensureActivityLoaded } from './js/activity.js';
import { initProfileHandlers } from './js/profile.js';
import { initPinLockHandlers, requirePinIfEnabled } from './js/pin-lock.js';
import { initRealtimeWakeRefresh } from './js/realtime.js';
import { initPullToRefresh } from './js/pull-to-refresh.js';

try {
  applyTheme(localStorage.getItem('pl_theme') || 'system');
} catch {
  applyTheme('system');
}

// Global Navigation & Modal Chrome
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});
document.getElementById('seeAllActivityBtn').addEventListener('click', () => switchView('history'));
document.getElementById('prevCycleBtn').addEventListener('click', () => shiftReferenceMonth(-1));
document.getElementById('nextCycleBtn').addEventListener('click', () => shiftReferenceMonth(1));
document.getElementById('openQuickEntryBtn').addEventListener('click', () => openModal('quickEntryOverlay'));
document.getElementById('heroLogBtn').addEventListener('click', () => openModal('quickEntryOverlay'));

const scrollTopBtn = document.getElementById('scrollTopBtn');
if (scrollTopBtn) {
  window.addEventListener('scroll', () => {
    scrollTopBtn.classList.toggle('hidden', window.scrollY <= 240);
  }, { passive: true });
  scrollTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

initModalComponents();

const EYE_OPEN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

document.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('[data-toggle-password]');
  if (!toggleBtn) return;
  const input = document.getElementById(toggleBtn.dataset.togglePassword);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  toggleBtn.setAttribute('aria-pressed', String(show));
  toggleBtn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  toggleBtn.innerHTML = show ? EYE_OFF_SVG : EYE_OPEN_SVG;
});

// Initialize Feature Modules
setViewChangeHandler((viewName) => {
  if (viewName === 'history') ensureActivityLoaded();
});
window.addEventListener('popstate', () => {
  if (!state.user) return;
  const { viewName, accountTab } = parseRoute(window.location.pathname);
  switchView(viewName, { push: false, accountTab });
});
initAuthHandlers({
  onAuthenticated: async () => {
    await fetchDashboard();
    const { viewName, accountTab } = parseRoute(window.location.pathname);
    switchView(viewName, { push: false, accountTab });
  },
});
initQuickEntryHandlers({ openAddCategoryModal });
initAccountHandlers();
initBudgetAndRecurringHandlers();
initActivityHandlers();
initProfileHandlers();
initPinLockHandlers();
initRealtimeWakeRefresh();
initPullToRefresh();

function hideBootLoader() {
  const loader = document.getElementById('bootLoader');
  if (!loader || loader.classList.contains('hidden')) return;
  loader.classList.add('fade-out');
  setTimeout(() => loader.classList.add('hidden'), 180);
}

async function boot() {
  document.getElementById('txDateInput').value = state.referenceDate;
  const resetToken = new URLSearchParams(window.location.search).get('resetToken');
  if (resetToken) {
    setResetToken(resetToken);
    showAuthView({ demoEnabled: false });
    hideBootLoader();
    return;
  }
  setAuthMode('login');
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      showAuthView({ demoEnabled: false });
      return;
    }
    const data = await res.json();
    state.demoEnabled = Boolean(data.demoEnabled);
    if (data.authenticated && data.user) {
      showAppShell(data.user);
      requirePinIfEnabled(data.user);
      await fetchDashboard();
      const { viewName, accountTab } = parseRoute(window.location.pathname);
      switchView(viewName, { push: false, accountTab });
    } else {
      showAuthView({ demoEnabled: state.demoEnabled });
    }
  } catch (err) {
    if (!err?.isAuthError) {
      showAuthView({ demoEnabled: state.demoEnabled });
      showAuthError('Unable to connect to PocketLedger. Please try again.');
    }
  } finally {
    hideBootLoader();
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
