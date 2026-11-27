let activeResolve = null;
let initialized = false;

const ICONS = {
  danger: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  warning: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  info: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function settle(result) {
  const overlay = document.getElementById('confirmOverlay');
  if (overlay) overlay.classList.add('hidden');
  if (activeResolve) {
    const resolve = activeResolve;
    activeResolve = null;
    resolve(result);
  }
}

function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  document.getElementById('confirmCancelBtn').addEventListener('click', () => settle(false));
  document.getElementById('confirmAcceptBtn').addEventListener('click', () => settle(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeResolve) {
      settle(false);
    }
  });
}

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  tone = 'danger',
  icon = tone,
} = {}) {
  ensureInitialized();
  if (activeResolve) settle(false);

  const overlay = document.getElementById('confirmOverlay');
  const iconEl = document.getElementById('confirmIcon');
  const titleEl = document.getElementById('confirmTitle');
  const msgEl = document.getElementById('confirmMessage');
  const cancelBtn = document.getElementById('confirmCancelBtn');
  const acceptBtn = document.getElementById('confirmAcceptBtn');

  iconEl.className = `confirm-icon tone-${tone}`;
  iconEl.innerHTML = ICONS[icon] || ICONS.danger;
  titleEl.textContent = title;
  msgEl.textContent = message;
  msgEl.classList.toggle('hidden', !message);
  cancelBtn.textContent = cancelText;
  acceptBtn.textContent = confirmText;
  acceptBtn.className = tone === 'primary' ? 'btn-primary confirm-btn' : 'btn-danger confirm-btn';

  overlay.classList.remove('hidden');
  cancelBtn.focus();

  return new Promise((resolve) => {
    activeResolve = resolve;
  });
}
