import { state, getTodayIsoDate, closeAllModals, switchView, setAuthRequiredHandler } from './state.js';
import { startRealtimeSync, stopRealtimeSync } from './realtime.js';
import { renderProfile } from './profile.js';
import { clearPinSession } from './pin-lock.js';

export function showAuthError(msg) {
  clearAuthInfo();
  const el = document.getElementById('authErrorBanner');
  el.textContent = msg;
  el.classList.remove('hidden');
}

export function clearAuthError() {
  const el = document.getElementById('authErrorBanner');
  el.textContent = '';
  el.classList.add('hidden');
}

export function showAuthInfo(msg) {
  clearAuthError();
  const el = document.getElementById('authInfoBanner');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

export function clearAuthInfo() {
  const el = document.getElementById('authInfoBanner');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

export function setResetToken(token) {
  state.resetToken = token || '';
  setAuthMode('reset');
}

export function setAuthMode(mode) {
  const normalized = ['login', 'register', 'forgot', 'reset'].includes(mode) ? mode : 'login';
  state.authMode = normalized;
  const isRegister = normalized === 'register';
  const isAuthForm = normalized === 'login' || normalized === 'register';

  const modeTabs = document.querySelector('.auth-mode-tabs');
  if (modeTabs) modeTabs.classList.toggle('hidden', !isAuthForm);

  const signInBtn = document.getElementById('authModeSignInBtn');
  const registerBtn = document.getElementById('authModeRegisterBtn');
  signInBtn.classList.toggle('active', normalized === 'login');
  signInBtn.setAttribute('aria-selected', String(normalized === 'login'));
  registerBtn.classList.toggle('active', isRegister);
  registerBtn.setAttribute('aria-selected', String(isRegister));

  document.getElementById('authForm').classList.toggle('hidden', !isAuthForm);
  document.getElementById('forgotPasswordForm')?.classList.toggle('hidden', normalized !== 'forgot');
  document.getElementById('resetPasswordForm')?.classList.toggle('hidden', normalized !== 'reset');
  document.getElementById('forgotPasswordLinkBtn')?.classList.toggle('hidden', normalized !== 'login');
  document.getElementById('demoLoginWrap')?.classList.toggle('hidden', !isAuthForm || !state.demoEnabled);

  document.getElementById('authRegisterExtras').classList.toggle('hidden', !isRegister);
  document.getElementById('authPassword').setAttribute('autocomplete', isRegister ? 'new-password' : 'current-password');
  document.getElementById('authSubmitBtn').textContent = isRegister ? 'Create Account' : 'Sign In';

  const cardHeadings = {
    login: ['Welcome back', 'Sign in to your account'],
    register: ['Create your account', 'Get set up in less than a minute'],
    forgot: ['Reset your password', "We'll email you a one-time reset link"],
    reset: ['Set a new password', 'Choose a strong password (8+ characters)'],
  };
  const [title, sub] = cardHeadings[normalized];
  const titleEl = document.getElementById('authCardTitle');
  const subEl = document.getElementById('authCardSub');
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;

  clearAuthError();
  clearAuthInfo();
}

export function showAuthView({ demoEnabled = state.demoEnabled } = {}) {
  stopRealtimeSync();
  clearPinSession();
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
  state.referenceDate = getTodayIsoDate();
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
  document.getElementById('profileDropdown')?.classList.add('hidden');
  document.getElementById('changePasswordForm')?.reset();
  document.querySelectorAll('.filter-pill').forEach((p) => {
    p.classList.toggle('active', p.dataset.filter === 'ALL');
  });
  document.querySelectorAll('#quickEntryOverlay .mode-tabs .tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.txType === 'EXPENSE');
  });
  switchView('home', { push: false });

  document.querySelector('.topbar').classList.add('hidden');
  document.querySelector('main.container').classList.add('hidden');
  const isAuthForm = state.authMode === 'login' || state.authMode === 'register';
  document.getElementById('demoLoginWrap').classList.toggle('hidden', !demoEnabled || !isAuthForm);
  document.getElementById('authView').classList.remove('hidden');
}

export function showAppShell(user) {
  state.user = user;
  if (user?.homeCurrencyCode) {
    state.currencyCode = user.homeCurrencyCode;
  }
  renderProfile(user, []);
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

  document.getElementById('forgotPasswordLinkBtn')?.addEventListener('click', () => {
    const prefill = document.getElementById('authEmail').value.trim();
    const forgotEmailEl = document.getElementById('forgotEmail');
    if (forgotEmailEl && prefill) forgotEmailEl.value = prefill;
    setAuthMode('forgot');
  });

  const returnToLogin = () => {
    if (window.location.search.includes('resetToken=')) {
      const cleanUrl = `${window.location.pathname}${window.location.hash}`;
      window.history.replaceState({}, '', cleanUrl);
    }
    state.resetToken = '';
    setAuthMode('login');
  };

  document.getElementById('forgotBackBtn')?.addEventListener('click', returnToLogin);
  document.getElementById('resetBackBtn')?.addEventListener('click', returnToLogin);

  document.getElementById('forgotPasswordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();
    clearAuthInfo();
    const submitBtn = document.getElementById('forgotSubmitBtn');
    const email = document.getElementById('forgotEmail').value.trim();
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showAuthError(data.error || 'Unable to send reset link.');
        return;
      }
      showAuthInfo(data.message || 'If an account exists for that email, a password reset link has been sent.');
    } catch {
      showAuthError('Network error. Please try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });

  document.getElementById('resetPasswordForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();
    clearAuthInfo();
    const newPassword = document.getElementById('resetNewPassword').value;
    const confirmPassword = document.getElementById('resetConfirmPassword').value;
    if (newPassword !== confirmPassword) {
      showAuthError('Passwords do not match.');
      return;
    }

    const submitBtn = document.getElementById('resetSubmitBtn');
    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: state.resetToken || '', newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showAuthError(data.error || 'Reset link is invalid or expired.');
        return;
      }
      document.getElementById('resetPasswordForm').reset();
      returnToLogin();
      showAuthInfo(data.message || 'Password updated. Please sign in with your new password.');
    } catch {
      showAuthError('Network error. Please try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });
}
