import { state, openModal, closeModal, closeAllModals, switchView } from './js/state.js';
import { initAuthHandlers, setAuthMode, showAuthError, showAuthView, showAppShell } from './js/auth.js';
import { fetchDashboard, shiftReferenceMonth } from './js/dashboard.js';
import { initQuickEntryHandlers } from './js/quick-entry.js';
import { initAccountHandlers } from './js/accounts.js';
import { initBudgetAndRecurringHandlers, openAddCategoryModal } from './js/budgets.js';
import { initActivityHandlers } from './js/activity.js';
import { initSettingsHandlers } from './js/settings.js';

// Global Navigation & Modal Chrome
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});
document.getElementById('seeAllActivityBtn').addEventListener('click', () => switchView('history'));
document.getElementById('prevCycleBtn').addEventListener('click', () => shiftReferenceMonth(-1));
document.getElementById('nextCycleBtn').addEventListener('click', () => shiftReferenceMonth(1));
document.getElementById('openQuickEntryBtn').addEventListener('click', () => openModal('quickEntryOverlay'));
document.getElementById('heroLogBtn').addEventListener('click', () => openModal('quickEntryOverlay'));
document.getElementById('openSettingsBtn').addEventListener('click', () => openModal('settingsOverlay'));

document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllModals();
});

// Initialize Feature Modules
initAuthHandlers({ onAuthenticated: fetchDashboard });
initQuickEntryHandlers({ openAddCategoryModal });
initAccountHandlers();
initBudgetAndRecurringHandlers();
initActivityHandlers();
initSettingsHandlers();

async function boot() {
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
      await fetchDashboard();
    } else {
      showAuthView({ demoEnabled: state.demoEnabled });
    }
  } catch (err) {
    if (!err?.isAuthError) {
      showAuthView({ demoEnabled: state.demoEnabled });
      showAuthError('Unable to connect to PocketLedger. Please try again.');
    }
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
