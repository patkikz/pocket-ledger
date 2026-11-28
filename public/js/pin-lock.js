import { state, apiFetch, showToast, getUserInitials } from './state.js';

let enteredPin = '';
let verifying = false;

export function isStandalonePwa() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.matchMedia?.('(display-mode: minimal-ui)')?.matches ||
    window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
    window.navigator?.standalone === true
  );
}

function renderDots() {
  const dotsEl = document.getElementById('pinDots');
  if (!dotsEl) return;
  dotsEl.innerHTML = Array.from({ length: 4 })
    .map((_, idx) => `<span class="pin-dot ${idx < enteredPin.length ? 'filled' : ''}"></span>`)
    .join('');
}

function triggerDotShake() {
  const dotsEl = document.getElementById('pinDots');
  if (!dotsEl) return;
  dotsEl.classList.remove('shake');
  void dotsEl.offsetWidth;
  dotsEl.classList.add('shake');
}

function setPinError(msg = '') {
  const errEl = document.getElementById('pinLockError');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.classList.toggle('hidden', !msg);
  if (!msg) {
    document.getElementById('toastBanner')?.classList.add('hidden');
  }
}

export function clearPinSession() {
  enteredPin = '';
  document.getElementById('pinLockOverlay')?.classList.add('hidden');
}

export function lockAppNow(user = state.user) {
  if (!user?.hasPin || !isStandalonePwa()) return;
  enteredPin = '';
  setPinError('');
  renderDots();
  const avatarEl = document.getElementById('pinLockAvatar');
  if (avatarEl) {
    avatarEl.textContent = getUserInitials(user);
    avatarEl.style.background = user.avatarColor || '#6366f1';
  }
  const label = document.getElementById('pinLockUserLabel');
  if (label) {
    const rawName = user.displayName || (user.email ? user.email.split('@')[0] : '');
    const firstName = rawName.trim().split(/\s+/)[0];
    label.textContent = firstName ? `Welcome back, ${firstName}` : 'Welcome back';
  }
  document.getElementById('pinLockOverlay')?.classList.remove('hidden');
}

export function requirePinIfEnabled(user) {
  if (!user?.hasPin || !isStandalonePwa()) {
    clearPinSession();
    return;
  }
  lockAppNow(user);
}

async function submitPin() {
  if (verifying || enteredPin.length < 4) return;
  verifying = true;
  renderDots();
  setPinError('');
  try {
    const res = await apiFetch('/api/auth/pin/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: enteredPin }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg = errData.error || 'Incorrect PIN. Please try again.';
      enteredPin = '';
      renderDots();
      triggerDotShake();
      setPinError(msg);
      showToast(msg, true);
      return;
    }
    enteredPin = '';
    renderDots();
    setPinError('');
    document.getElementById('pinLockOverlay')?.classList.add('hidden');
  } catch {
    setPinError('Unable to verify PIN right now.');
  } finally {
    verifying = false;
    renderDots();
  }
}

export function initPinLockHandlers() {
  const overlay = document.getElementById('pinLockOverlay');
  if (!overlay) return;

  overlay.addEventListener('click', (e) => {
    const keyBtn = e.target.closest('[data-pin-key]');
    if (!keyBtn) return;
    const key = keyBtn.dataset.pinKey;
    setPinError('');
    if (key === 'clear') {
      enteredPin = '';
    } else if (key === 'back') {
      enteredPin = enteredPin.slice(0, -1);
    } else if (/^\d$/.test(key) && enteredPin.length < 4) {
      enteredPin += key;
    }
    renderDots();
    if (enteredPin.length === 4) submitPin();
  });

  document.getElementById('pinLogoutBtn')?.addEventListener('click', () => {
    clearPinSession();
    document.getElementById('logoutBtn')?.click();
    showToast('Signed out.');
  });

  document.addEventListener('keydown', (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (/^\d$/.test(e.key) && enteredPin.length < 4) {
      setPinError('');
      enteredPin += e.key;
      renderDots();
      if (enteredPin.length === 4) submitPin();
    } else if (e.key === 'Backspace') {
      enteredPin = enteredPin.slice(0, -1);
      renderDots();
    } else if (e.key === 'Enter' && enteredPin.length >= 4) {
      submitPin();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.user?.hasPin) {
      lockAppNow(state.user);
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.user?.hasPin) {
      lockAppNow(state.user);
    }
  });

  window.addEventListener('pageshow', (e) => {
    if (e.persisted && state.user?.hasPin) {
      lockAppNow(state.user);
    }
  });
}
