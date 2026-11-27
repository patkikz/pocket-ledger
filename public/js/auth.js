import { state, closeAllModals, switchView, setAuthRequiredHandler } from './state.js';
import { startRealtimeSync, stopRealtimeSync } from './realtime.js';

export function showAuthError(msg) {
  const el = document.getElementById('authErrorBanner');
  el.textContent = msg;
  el.classList.remove('hidden');
}

export function clearAuthError() {
  const el = document.getElementById('authErrorBanner');
  el.textContent = '';
  el.classList.add('hidden');
}

export function setAuthMode(mode) {
  state.authMode = mode === 'register' ? 'register' : 'login';
  const isRegister = state.authMode === 'register';

  const signInBtn = document.getElementById('authModeSignInBtn');
  const registerBtn = document.getElementById('authModeRegisterBtn');
  signInBtn.classList.toggle('active', !isRegister);
  signInBtn.setAttribute('aria-selected', String(!isRegister));
  registerBtn.classList.toggle('active', isRegister);
  registerBtn.setAttribute('aria-selected', String(isRegister));

  document.getElementById('authRegisterExtras').classList.toggle('hidden', !isRegister);
  document.getElementById('authPassword').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
  document.getElementById('authSubmitBtn').textContent = isRegister ? 'Create Account' : 'Sign In';
  clearAuthError();
}

export function showAuthView({ demoEnabled = state.demoEnabled } = {}) {
  stopRealtimeSync();
  closeAllModals();
  state.user = null;
  state.dashboard = null;
  state.selectedAccountId = null;
  state.selectedDestinationAccountId = null;
  state.selectedCategoryId = null;
  state.digitsMinor = 0;
  state.searchQuery = '';
  state.historyFilter = 'ALL';
  state.txType = 'EXPENSE';
  state.referenceDate = '2026-11-26';
  state.activity = {
    items: [],
    totalCount: 0,
    hasMore: false,
    nextOffset: 0,
    isLoading: false,
    loadedOnce: false,
  };

  document.getElementById('toastBanner').classList.add('hidden');
  document.getElementById('txNoteInput').value = '';
  document.getElementById('txDateInput').value = state.referenceDate;
  document.getElementById('activitySearchInput').value = '';
  document.querySelectorAll('.filter-pill').forEach((p) => {
    p.classList.toggle('active', p.dataset.filter === 'ALL');
  });
  document.querySelectorAll('#quickEntryOverlay .mode-tabs .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.txType === 'EXPENSE');
  });
  switchView('home');

  document.querySelector('.topbar').classList.add('hidden');
  document.querySelector('main.container').classList.add('hidden');
  document.getElementById('demoLoginWrap').classList.toggle('hidden', !demoEnabled);
  document.getElementById('authView').classList.remove('hidden');
}

export function showAppShell(user) {
  state.user = user;
  if (user?.homeCurrencyCode) {
    state.currencyCode = user.homeCurrencyCode;
  }
  document.getElementById('settingsUserEmail').textContent = user?.email || '—';
  document.getElementById('authView').classList.add('hidden');
  document.querySelector('.topbar').classList.remove('hidden');
  document.querySelector('main.container').classList.remove('hidden');
  startRealtimeSync();
}

export function initAuthHandlers({ onAuthenticated }) {
  setAuthRequiredHandler(() => showAuthView({ demoEnabled: state.demoEnabled }));

  async function completeAuthSuccess(user) {
    clearAuthError();
    document.getElementById('authPassword').value = '';
    showAppShell(user);
    await onAuthenticated();
  }

  document.querySelector('.auth-mode-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-auth-mode]');
    if (!btn) return;
    setAuthMode(btn.dataset.authMode);
  });

  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();

    const submitBtn = document.getElementById('authSubmitBtn');
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const isRegister = state.authMode === 'register';

    const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
    const payload = isRegister
      ? {
          email,
          password,
          homeCurrencyCode: document.getElementById('authCurrency').value,
          budgetCycleStartDay: Number(document.getElementById('authCycleStartDay').value),
        }
      : { email, password };

    submitBtn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showAuthError(data.error || (isRegister ? 'Could not create account.' : 'Invalid email or password.'));
        return;
      }
      await completeAuthSuccess(data.user);
    } catch (err) {
      if (!err?.isAuthError) {
        showAuthError('Network error. Please try again.');
      }
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById('demoLoginBtn').addEventListener('click', async () => {
    clearAuthError();
    const demoBtn = document.getElementById('demoLoginBtn');
    demoBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'patrick@pocketledger.app',
          password: 'pocketledger-demo',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showAuthError(data.error || 'Demo sign in failed.');
        return;
      }
      await completeAuthSuccess(data.user);
    } catch (err) {
      if (!err?.isAuthError) {
        showAuthError('Network error. Please try again.');
      }
    } finally {
      demoBtn.disabled = false;
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      document.getElementById('authPassword').value = '';
      setAuthMode('login');
      showAuthView({ demoEnabled: state.demoEnabled });
    }
  });
}
