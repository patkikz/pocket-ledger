export const state = {
  user: null,
  demoEnabled: false,
  authMode: 'login',
  currencyCode: 'USD',
  referenceDate: '2026-11-26',
  activeView: 'home',
  historyFilter: 'ALL',
  searchQuery: '',
  txType: 'EXPENSE',
  digitsMinor: 0,
  selectedAccountId: null,
  selectedDestinationAccountId: null,
  selectedCategoryId: null,
  dashboard: null,
  activity: {
    items: [],
    totalCount: 0,
    hasMore: false,
    nextOffset: 0,
    isLoading: false,
    loadedOnce: false,
  },
};

const CURRENCY_SYMBOLS = {
  USD: '$',
  PHP: '₱',
  EUR: '€',
  GBP: '£',
};

let onAuthRequired = null;
let onViewChange = null;

export function setAuthRequiredHandler(fn) {
  onAuthRequired = fn;
}

export function setViewChangeHandler(fn) {
  onViewChange = fn;
}

export async function withButtonLoading(btn, loadingText, fn) {
  if (!btn || btn.disabled) return;
  const span = btn.querySelector('span');
  const originalText = span ? span.textContent : btn.textContent;
  btn.disabled = true;
  if (span) span.textContent = loadingText;
  else btn.textContent = loadingText;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    if (span) span.textContent = originalText;
    else btn.textContent = originalText;
  }
}

export function formatMoney(amountMinor, currencyCode = state.currencyCode) {
  const sym = CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `;
  const isNeg = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const cents = String(abs % 100).padStart(2, '0');
  return `${isNeg ? '-' : ''}${sym}${whole}.${cents}`;
}

export function showToast(msg, isError = false) {
  const toast = document.getElementById('toastBanner');
  toast.textContent = msg;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

export function switchView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === viewName);
  });
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });
  if (onViewChange) onViewChange(viewName);
}

export function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

export function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

export function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach((el) => el.classList.add('hidden'));
}

export async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    if (onAuthRequired) onAuthRequired();
    const err = new Error('Authentication required');
    err.isAuthError = true;
    throw err;
  }
  return res;
}

export function handleActionError(err, fallbackMsg = 'Request failed') {
  if (err?.isAuthError) return;
  showToast(err?.message || fallbackMsg, true);
}

export async function readErrorMessage(res, fallbackMsg) {
  const data = await res.json().catch(() => ({}));
  return data.error || fallbackMsg;
}
