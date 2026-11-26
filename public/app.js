const state = {
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
};

const CURRENCY_SYMBOLS = {
  USD: '$',
  PHP: '₱',
  EUR: '€',
  GBP: '£',
};

function formatMoney(amountMinor, currencyCode = state.currencyCode) {
  const sym = CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `;
  const isNeg = amountMinor < 0;
  const abs = Math.abs(amountMinor);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const cents = String(abs % 100).padStart(2, '0');
  return `${isNeg ? '-' : ''}${sym}${whole}.${cents}`;
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toastBanner');
  toast.textContent = msg;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4000);
}

function switchView(viewName) {
  state.activeView = viewName;
  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === viewName);
  });
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `view-${viewName}`);
  });
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function closeAllModals() {
  document.querySelectorAll('.modal-overlay').forEach((el) => el.classList.add('hidden'));
}

function showAuthError(msg) {
  const banner = document.getElementById('authErrorBanner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
}

function clearAuthError() {
  const banner = document.getElementById('authErrorBanner');
  banner.textContent = '';
  banner.classList.add('hidden');
}

function setAuthMode(mode) {
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

function showAuthView({ demoEnabled = state.demoEnabled } = {}) {
  closeAllModals();
  state.user = null;
  state.dashboard = null;
  state.selectedAccountId = null;
  state.selectedDestinationAccountId = null;
  state.selectedCategoryId = null;
  state.digitsMinor = 0;
  state.searchQuery = '';
  document.getElementById('activitySearchInput').value = '';
  switchView('home');

  document.querySelector('.topbar').classList.add('hidden');
  document.querySelector('main.container').classList.add('hidden');
  document.getElementById('demoLoginWrap').classList.toggle('hidden', !demoEnabled);
  document.getElementById('authView').classList.remove('hidden');
}

function showAppShell(user) {
  state.user = user;
  if (user?.homeCurrencyCode) {
    state.currencyCode = user.homeCurrencyCode;
  }
  document.getElementById('settingsUserEmail').textContent = user?.email || '—';
  document.getElementById('authView').classList.add('hidden');
  document.querySelector('.topbar').classList.remove('hidden');
  document.querySelector('main.container').classList.remove('hidden');
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    showAuthView({ demoEnabled: state.demoEnabled });
    const err = new Error('Authentication required');
    err.isAuthError = true;
    throw err;
  }
  return res;
}

function shiftReferenceMonth(deltaMonths) {
  const [y, m, d] = state.referenceDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, Math.min(d, 28)));
  state.referenceDate = dt.toISOString().slice(0, 10);
  document.getElementById('txDateInput').value = state.referenceDate;
  fetchDashboard();
}

function updateKeypadReadout() {
  document.getElementById('keypadAmountReadout').textContent = formatMoney(state.digitsMinor);
  const labels = {
    EXPENSE: 'Save Expense',
    REFUND: 'Save Refund',
    INCOME: 'Save Income',
    TRANSFER: 'Save Transfer',
  };
  const amountLabel = state.digitsMinor > 0 ? ` (${formatMoney(state.digitsMinor)})` : '';
  document.getElementById('submitTxBtn').querySelector('span').textContent = `${labels[state.txType]}${amountLabel}`;
}

function syncCategorySelection() {
  if (!state.dashboard) return;
  const neededKind = state.txType === 'INCOME' ? 'INCOME' : 'EXPENSE';
  const matching = state.dashboard.categories.filter((c) => c.kind === neededKind);
  if (!matching.some((c) => c.id === state.selectedCategoryId)) {
    state.selectedCategoryId = matching[0]?.id || null;
  }
}

async function fetchDashboard() {
  const res = await apiFetch(`/api/dashboard?date=${encodeURIComponent(state.referenceDate)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || 'Could not load dashboard.', true);
    return;
  }
  state.dashboard = data;
  state.user = data.user;
  state.currencyCode = data.user.homeCurrencyCode;

  const accountIds = new Set(data.accounts.map((a) => a.id));
  if (!state.selectedAccountId || !accountIds.has(state.selectedAccountId)) {
    state.selectedAccountId = data.smartDefaults.accountId;
  }

  const otherAcc = data.accounts.find((a) => a.id !== state.selectedAccountId);
  if (!state.selectedDestinationAccountId || !accountIds.has(state.selectedDestinationAccountId) || state.selectedDestinationAccountId === state.selectedAccountId) {
    state.selectedDestinationAccountId = otherAcc ? otherAcc.id : null;
  }

  syncCategorySelection();
  renderAll();
}

function renderTxItems(transactions, containerEl, { showUndo = false, emptyMsg = 'No transactions yet.' } = {}) {
  if (transactions.length === 0) {
    containerEl.innerHTML = `<div class="tx-item"><span class="tx-sub">${emptyMsg}</span></div>`;
    return;
  }

  containerEl.innerHTML = transactions
    .map((t) => {
      const isVoid = Boolean(t.voidedAt);
      const isPositive = t.type === 'INCOME' || t.type === 'REFUND';
      const sign = t.type === 'EXPENSE' ? '−' : isPositive ? '+' : '';
      const dotColor = t.categoryColor || (t.type === 'TRANSFER' ? '#38bdf8' : '#94a3b8');
      const title = t.note || t.categoryName || (t.type === 'TRANSFER' ? 'Account Transfer' : t.type);
      const accountInfo =
        t.type === 'TRANSFER'
          ? `${t.accountName} → ${t.transferDestinationAccountName}`
          : `${t.accountName}${t.categoryName ? ` • ${t.categoryName}` : ''}`;

      return `<div class="tx-item ${isVoid ? 'voided' : ''}">
        <div class="tx-left">
          <span class="tx-dot" style="background:${dotColor};" aria-hidden="true"></span>
          <div style="min-width:0;">
            <div class="tx-title">${title}</div>
            <div class="tx-sub">${t.occurredOn} • ${accountInfo}</div>
          </div>
        </div>
        <div class="tx-right">
          <span class="tx-amount ${isPositive ? 'positive' : ''}">${sign}${formatMoney(t.amountMinor)}</span>
          ${
            showUndo && !isVoid
              ? `<button type="button" class="btn-undo-sm" data-void-tx="${t.id}">Undo</button>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
}

function renderAll() {
  const d = state.dashboard;
  if (!d) return;

  // Header & Settings
  document.getElementById('cycleWindowLabel').textContent = `${d.cycleStart} to ${d.cycleEnd}`;
  document.getElementById('settingsUserEmail').textContent = d.user.email;
  document.getElementById('cycleStartDaySelect').value = String(d.user.budgetCycleStartDay);
  document.getElementById('currencySelect').value = d.user.homeCurrencyCode;
  document.getElementById('csvExportLink').href = '/api/export.csv';

  // Empty-state onboarding callout if user has no accounts yet
  document.getElementById('emptyAccountCallout').classList.toggle('hidden', d.accounts.length > 0);

  // Hero Safe-to-Spend & Summary
  document.getElementById('kpiSafeToSpend').textContent = formatMoney(d.safeToSpendMinor);
  document.getElementById('kpiSafeSub').textContent =
    d.unpaidRecurringMinor > 0
      ? `Includes ${formatMoney(d.unpaidRecurringMinor)} reserved for upcoming bills`
      : 'All due bills for this cycle are paid';
  document.getElementById('kpiTotalSpent').textContent = formatMoney(d.totalSpentMinor);
  document.getElementById('kpiTotalIncome').textContent = formatMoney(d.totalIncomeMinor);
  document.getElementById('kpiCardDebt').textContent = formatMoney(d.creditCardDebtMinor);

  // Due Soon Recurring Bills
  const dueRules = d.dueRecurringRules.filter((r) => r.isDueInCycle);
  const recurringList = document.getElementById('recurringList');
  if (dueRules.length === 0) {
    recurringList.innerHTML = `<div class="tx-card-list"><div class="tx-item"><span class="tx-sub">No upcoming bills due this cycle.</span></div></div>`;
  } else {
    recurringList.innerHTML = dueRules
      .map(
        (r) => `<div class="bill-card">
          <div>
            <div style="font-weight:700;font-size:0.92rem;">${r.title} • ${formatMoney(r.defaultAmountMinor)}</div>
            <div class="tx-sub">Due ${r.nextDueDate} from ${r.accountName}</div>
          </div>
          <div style="display:flex;gap:0.45rem;">
            <button type="button" class="btn-mark-paid" data-post-rule="${r.id}">Mark Paid</button>
            <button type="button" class="btn-secondary" data-skip-rule="${r.id}">Skip</button>
          </div>
        </div>`
      )
      .join('');
  }

  // Monthly Budgets (Click any card to edit its monthly limit)
  document.getElementById('categoryCapsGrid').innerHTML = d.categories
    .filter((c) => c.kind === 'EXPENSE')
    .map((c) => {
      const cap = c.monthlyCapMinor || 0;
      const ratio = cap > 0 ? Math.max(0, Math.min(1, c.netSpentMinor / cap)) : 0;
      const isOver = cap > 0 && c.netSpentMinor > cap;
      const barColor = isOver ? 'var(--accent-rose)' : c.color;
      const remLabel =
        c.remainingCapMinor >= 0
          ? `${formatMoney(c.remainingCapMinor)} left`
          : `${formatMoney(Math.abs(c.remainingCapMinor))} over`;
      return `<button type="button" class="budget-card budget-card-btn" data-edit-cat="${c.id}" data-cat-name="${c.name}" data-cat-cap="${cap}">
        <div class="budget-top">
          <span class="budget-name">${c.name}</span>
          <span class="budget-remaining ${isOver ? 'over' : ''}">${remLabel}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="background:${barColor};transform:scaleX(${ratio});"></div>
        </div>
        <div class="budget-meta">${formatMoney(c.netSpentMinor)} spent of ${formatMoney(cap)} · Tap to edit limit</div>
      </button>`;
    })
    .join('');

  // Overview: Last 5 active transactions
  const activeRecent = d.recentTransactions.filter((t) => !t.voidedAt).slice(0, 5);
  renderTxItems(activeRecent, document.getElementById('recentTxList'), { showUndo: false });

  // Activity View: Filtered & searched list
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = d.recentTransactions.filter((t) => {
    if (state.historyFilter === 'EXPENSE' && t.type !== 'EXPENSE' && t.type !== 'REFUND') return false;
    if (state.historyFilter !== 'ALL' && state.historyFilter !== 'EXPENSE' && t.type !== state.historyFilter) return false;
    if (!q) return true;
    const hay = `${t.note || ''} ${t.categoryName || ''} ${t.accountName || ''} ${t.transferDestinationAccountName || ''}`.toLowerCase();
    return hay.includes(q);
  });
  renderTxItems(filtered, document.getElementById('fullTxList'), {
    showUndo: true,
    emptyMsg: q ? 'No matching transactions found.' : 'No transactions yet.',
  });

  // Accounts View
  document.getElementById('netLiquidityLabel').textContent = `Total Net Liquidity: ${formatMoney(d.netLiquidityMinor)}`;
  const accountsGrid = document.getElementById('accountsGrid');
  if (d.accounts.length === 0) {
    accountsGrid.innerHTML = `<div class="account-card"><p class="tx-sub">No accounts yet. Click "+ Add Account" to get started.</p></div>`;
  } else {
    accountsGrid.innerHTML = d.accounts
      .map((a) => {
        const typeLabel =
          a.type === 'CASH_CHECKING' ? 'Cash / Checking' : a.type === 'SAVINGS' ? 'Savings' : 'Credit Card';
        return `<div class="account-card">
          <div class="account-header">
            <span class="account-name">${a.name}</span>
            <span class="account-type">${typeLabel}</span>
          </div>
          <div class="account-balance ${a.cachedBalanceMinor < 0 ? 'negative' : ''}">${formatMoney(a.cachedBalanceMinor)}</div>
          <button type="button" class="btn-secondary" style="justify-content:center;" data-reconcile-acc="${a.id}" data-acc-name="${a.name}" data-acc-bal="${a.cachedBalanceMinor}">
            Update Balance
          </button>
        </div>`;
      })
      .join('');
  }

  // Quick-Entry Modal Chips
  document.getElementById('sourceAccountStrip').innerHTML =
    d.accounts.length === 0
      ? `<span class="tx-sub">Add an account first</span>`
      : d.accounts
          .map((a) => {
            const sel = a.id === state.selectedAccountId ? 'selected' : '';
            return `<button type="button" class="chip ${sel}" data-source-acc="${a.id}">${a.name}</button>`;
          })
          .join('');

  const categorySection = document.getElementById('categorySection');
  const destSection = document.getElementById('destinationAccountSection');
  if (state.txType === 'TRANSFER') {
    categorySection.style.display = 'none';
    destSection.style.display = 'block';
    document.getElementById('destinationAccountStrip').innerHTML = d.accounts
      .filter((a) => a.id !== state.selectedAccountId)
      .map((a) => {
        const sel = a.id === state.selectedDestinationAccountId ? 'selected' : '';
        return `<button type="button" class="chip ${sel}" data-dest-acc="${a.id}">${a.name}</button>`;
      })
      .join('');
  } else {
    categorySection.style.display = 'block';
    destSection.style.display = 'none';
    const neededKind = state.txType === 'INCOME' ? 'INCOME' : 'EXPENSE';
    const catChips = d.categories
      .filter((c) => c.kind === neededKind)
      .map((c) => {
        const sel = c.id === state.selectedCategoryId ? 'selected' : '';
        return `<button type="button" class="chip ${sel}" data-cat-id="${c.id}">
          <span style="width:8px;height:8px;border-radius:99px;background:${c.color};display:inline-block;" aria-hidden="true"></span>
          <span>${c.name}</span>
        </button>`;
      })
      .join('');
    document.getElementById('categoryStrip').innerHTML =
      catChips + `<button type="button" class="chip" data-quick-add-cat="${neededKind}">+ New</button>`;
  }

  updateKeypadReadout();
}

// Navigation & Modal Triggers
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});
document.getElementById('seeAllActivityBtn').addEventListener('click', () => switchView('history'));
document.getElementById('prevCycleBtn').addEventListener('click', () => shiftReferenceMonth(-1));
document.getElementById('nextCycleBtn').addEventListener('click', () => shiftReferenceMonth(1));

document.getElementById('openQuickEntryBtn').addEventListener('click', () => openModal('quickEntryOverlay'));
document.getElementById('heroLogBtn').addEventListener('click', () => openModal('quickEntryOverlay'));
document.getElementById('openSettingsBtn').addEventListener('click', () => openModal('settingsOverlay'));
document.getElementById('openAddAccountBtn').addEventListener('click', () => openModal('addAccountOverlay'));
document.getElementById('emptyAddAccountBtn').addEventListener('click', () => openModal('addAccountOverlay'));

function openAddCategoryModal(defaultKind = 'EXPENSE') {
  document.getElementById('categoryModalTitle').textContent = 'Add Category';
  document.getElementById('editCategoryId').value = '';
  document.getElementById('newCatKindGroup').style.display = 'flex';
  document.getElementById('newCatKind').value = defaultKind;
  document.getElementById('newCatNameGroup').style.display = 'flex';
  document.getElementById('newCatName').required = true;
  document.getElementById('newCatName').value = '';
  document.getElementById('newCatCap').value = '';
  syncCategoryModalFields();
  openModal('categoryModalOverlay');
}

function syncCategoryModalFields() {
  const isIncome = document.getElementById('newCatKind').value === 'INCOME' && !document.getElementById('editCategoryId').value;
  document.getElementById('newCatCapGroup').style.display = isIncome ? 'none' : 'flex';
  document.getElementById('newCatCap').required = !isIncome;
}

document.getElementById('openAddCategoryBtn').addEventListener('click', () => openAddCategoryModal('EXPENSE'));
document.getElementById('newCatKind').addEventListener('change', syncCategoryModalFields);

document.getElementById('openAddRecurringBtn').addEventListener('click', () => {
  const d = state.dashboard;
  if (!d || d.accounts.length === 0) {
    showToast('Please add an account first.', true);
    return;
  }
  document.getElementById('newBillAccount').innerHTML = d.accounts
    .map((a) => `<option value="${a.id}">${a.name}</option>`)
    .join('');
  document.getElementById('newBillCategory').innerHTML = d.categories
    .filter((c) => c.kind === 'EXPENSE')
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join('');
  document.getElementById('newBillDate').value = state.referenceDate;
  openModal('recurringModalOverlay');
});

document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});

document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// Keyboard shortcuts: Escape closes modals; digits/Backspace/Enter work inside Quick Entry
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllModals();
    return;
  }

  const quickOpen = !document.getElementById('quickEntryOverlay').classList.contains('hidden');
  if (!quickOpen) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    if (state.digitsMinor <= 99999999) {
      state.digitsMinor = state.digitsMinor * 10 + Number(e.key);
      updateKeypadReadout();
    }
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    state.digitsMinor = Math.floor(state.digitsMinor / 10);
    updateKeypadReadout();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('submitTxBtn').click();
  }
});

// Keypad Touch Input
document.getElementById('numpadGrid').addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-key]');
  if (!btn) return;
  e.preventDefault();
  const key = btn.dataset.key;
  if (key === 'BACKSPACE') {
    state.digitsMinor = Math.floor(state.digitsMinor / 10);
  } else if (key === '00') {
    if (state.digitsMinor <= 9999999) state.digitsMinor *= 100;
  } else {
    const digit = Number(key);
    if (state.digitsMinor <= 99999999) {
      state.digitsMinor = state.digitsMinor * 10 + digit;
    }
  }
  updateKeypadReadout();
});

document.querySelector('#quickEntryOverlay .mode-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tx-type]');
  if (!btn) return;
  document.querySelectorAll('#quickEntryOverlay .mode-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.txType = btn.dataset.txType;

  const hints = {
    EXPENSE: 'Counts toward your monthly budget · Type numbers or tap below',
    REFUND: 'Reduces spending in this category',
    INCOME: 'Adds to your account and monthly income',
    TRANSFER: 'Moves money between your accounts without affecting budgets',
  };
  document.getElementById('typeHintText').textContent = hints[state.txType];
  syncCategorySelection();
  renderAll();
});

document.getElementById('sourceAccountStrip').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-source-acc]');
  if (!btn) return;
  state.selectedAccountId = btn.dataset.sourceAcc;
  if (state.selectedDestinationAccountId === state.selectedAccountId && state.dashboard) {
    const alt = state.dashboard.accounts.find((a) => a.id !== state.selectedAccountId);
    state.selectedDestinationAccountId = alt ? alt.id : null;
  }
  renderAll();
});

document.getElementById('destinationAccountStrip').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dest-acc]');
  if (!btn) return;
  state.selectedDestinationAccountId = btn.dataset.destAcc;
  renderAll();
});

document.getElementById('categoryStrip').addEventListener('click', (e) => {
  const addBtn = e.target.closest('[data-quick-add-cat]');
  if (addBtn) {
    openAddCategoryModal(addBtn.dataset.quickAddCat);
    return;
  }
  const btn = e.target.closest('[data-cat-id]');
  if (!btn) return;
  state.selectedCategoryId = btn.dataset.catId;
  renderAll();
});

document.getElementById('submitTxBtn').addEventListener('click', async () => {
  if (!state.selectedAccountId) {
    showToast('Please add an account first.', true);
    return;
  }
  if (state.digitsMinor <= 0) {
    showToast('Please enter an amount greater than zero.', true);
    return;
  }
  const payload = {
    type: state.txType,
    amountMinor: state.digitsMinor,
    accountId: state.selectedAccountId,
    transferDestinationAccountId: state.txType === 'TRANSFER' ? state.selectedDestinationAccountId : null,
    categoryId: state.txType === 'TRANSFER' ? null : state.selectedCategoryId,
    occurredOn: document.getElementById('txDateInput').value || state.referenceDate,
    note: document.getElementById('txNoteInput').value.trim(),
  };

  const res = await apiFetch('/api/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || 'Could not save transaction.', true);
    return;
  }

  state.digitsMinor = 0;
  document.getElementById('txNoteInput').value = '';
  closeModal('quickEntryOverlay');

  const remText =
    data.categoryRemainingCapMinor !== null && data.categoryRemainingCapMinor !== undefined
      ? ` • ${formatMoney(data.categoryRemainingCapMinor)} left in category`
      : '';
  showToast(`Saved ${formatMoney(data.transaction.amountMinor)}${remText}`);
  await fetchDashboard();
});

// Add Account Form
document.getElementById('addAccountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('newAccName').value.trim();
  const type = document.getElementById('newAccType').value;
  const initialBalanceMinor = Math.round(Number(document.getElementById('newAccBalance').value || 0) * 100);

  const res = await apiFetch('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, type, initialBalanceMinor }),
  });
  if (res.ok) {
    document.getElementById('addAccountForm').reset();
    closeModal('addAccountOverlay');
    showToast(`Added account "${name}".`);
    await fetchDashboard();
  } else {
    const err = await res.json();
    showToast(err.error || 'Could not create account.', true);
  }
});

// Open Update Balance Modal
document.getElementById('accountsGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-reconcile-acc]');
  if (!btn) return;
  const accName = btn.dataset.accName;
  const currentDollars = (Number(btn.dataset.accBal) / 100).toFixed(2);
  document.getElementById('reconcileAccId').value = btn.dataset.reconcileAcc;
  document.getElementById('reconcileTitle').textContent = `Update ${accName}`;
  document.getElementById('reconcileHelper').textContent = `Current balance: ${formatMoney(Number(btn.dataset.accBal))}. Enter the balance shown by your bank.`;
  document.getElementById('reconcileNewBalance').value = currentDollars;
  openModal('reconcileOverlay');
});

document.getElementById('reconcileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const accountId = document.getElementById('reconcileAccId').value;
  const actualBalanceMinor = Math.round(Number(document.getElementById('reconcileNewBalance').value) * 100);
  const res = await apiFetch('/api/accounts/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, actualBalanceMinor, occurredOn: state.referenceDate }),
  });
  if (res.ok) {
    closeModal('reconcileOverlay');
    showToast(`Balance updated to ${formatMoney(actualBalanceMinor)}.`);
    await fetchDashboard();
  }
});

// Edit Monthly Budget Cap or Add Category
document.getElementById('categoryCapsGrid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-edit-cat]');
  if (!card) return;
  document.getElementById('categoryModalTitle').textContent = `Edit ${card.dataset.catName} Budget`;
  document.getElementById('editCategoryId').value = card.dataset.editCat;
  document.getElementById('newCatKindGroup').style.display = 'none';
  document.getElementById('newCatNameGroup').style.display = 'none';
  document.getElementById('newCatName').required = false;
  document.getElementById('newCatCapGroup').style.display = 'flex';
  document.getElementById('newCatCap').required = true;
  document.getElementById('newCatCap').value = (Number(card.dataset.catCap) / 100).toFixed(2);
  openModal('categoryModalOverlay');
});

document.getElementById('categoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const editId = document.getElementById('editCategoryId').value;
  const kind = document.getElementById('newCatKind').value;
  const capVal = document.getElementById('newCatCap').value;
  const monthlyCapMinor = kind === 'INCOME' && !editId ? null : Math.round(Number(capVal) * 100);

  if (editId) {
    const res = await apiFetch(`/api/categories/${editId}/cap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ monthlyCapMinor }),
    });
    if (res.ok) {
      closeModal('categoryModalOverlay');
      showToast('Monthly budget limit updated.');
      await fetchDashboard();
    }
  } else {
    const name = document.getElementById('newCatName').value.trim();
    const color = kind === 'INCOME' ? '#14b8a6' : '#6366f1';
    const res = await apiFetch('/api/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, kind, monthlyCapMinor, color }),
    });
    if (res.ok) {
      const created = await res.json();
      state.selectedCategoryId = created.category.id;
      closeModal('categoryModalOverlay');
      showToast(`Added "${name}" category.`);
      await fetchDashboard();
    }
  }
});

// Add Recurring Bill
document.getElementById('recurringForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('newBillTitle').value.trim();
  const defaultAmountMinor = Math.round(Number(document.getElementById('newBillAmount').value) * 100);
  const accountId = document.getElementById('newBillAccount').value;
  const categoryId = document.getElementById('newBillCategory').value;
  const nextDueDate = document.getElementById('newBillDate').value;

  const res = await apiFetch('/api/recurring', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, type: 'EXPENSE', defaultAmountMinor, accountId, categoryId, frequency: 'MONTHLY', nextDueDate }),
  });
  if (res.ok) {
    document.getElementById('recurringForm').reset();
    closeModal('recurringModalOverlay');
    showToast(`Added "${title}" bill reminder.`);
    await fetchDashboard();
  }
});

document.getElementById('recurringList').addEventListener('click', async (e) => {
  const postBtn = e.target.closest('[data-post-rule]');
  if (postBtn) {
    const res = await apiFetch(`/api/recurring/${postBtn.dataset.postRule}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      showToast('Bill marked as paid and added to your activity.');
      await fetchDashboard();
    }
    return;
  }
  const skipBtn = e.target.closest('[data-skip-rule]');
  if (skipBtn) {
    const res = await apiFetch(`/api/recurring/${skipBtn.dataset.skipRule}/skip`, {
      method: 'POST',
    });
    if (res.ok) {
      showToast('Bill skipped for this cycle.');
      await fetchDashboard();
    }
  }
});

document.getElementById('fullTxList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-void-tx]');
  if (!btn) return;
  const res = await apiFetch(`/api/transactions/${btn.dataset.voidTx}/void`, {
    method: 'POST',
  });
  if (res.ok) {
    showToast('Transaction removed and balances updated.');
    await fetchDashboard();
  }
});

document.getElementById('activitySearchInput').addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderAll();
});

document.getElementById('historyFilterPills').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  state.historyFilter = btn.dataset.filter;
  renderAll();
});

document.getElementById('currencySelect').addEventListener('change', async (e) => {
  const homeCurrencyCode = e.target.value;
  await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ homeCurrencyCode }),
  });
  showToast(`Home currency updated to ${homeCurrencyCode}.`);
  await fetchDashboard();
});

document.getElementById('cycleStartDaySelect').addEventListener('change', async (e) => {
  const budgetCycleStartDay = Number(e.target.value);
  await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ budgetCycleStartDay }),
  });
  showToast(`Monthly budget reset day updated to Day ${budgetCycleStartDay}.`);
  await fetchDashboard();
});

document.getElementById('txDateInput').addEventListener('change', (e) => {
  if (e.target.value) {
    state.referenceDate = e.target.value;
    fetchDashboard();
  }
});

// Auth Gate Handlers
document.querySelector('.auth-mode-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-auth-mode]');
  if (!btn) return;
  setAuthMode(btn.dataset.authMode);
});

async function completeAuthSuccess(user) {
  clearAuthError();
  document.getElementById('authPassword').value = '';
  showAppShell(user);
  await fetchDashboard();
}

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
  } catch {
    showAuthError('Network error. Please try again.');
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
  } catch {
    showAuthError('Network error. Please try again.');
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
