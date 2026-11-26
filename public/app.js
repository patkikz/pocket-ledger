const state = {
  userId: 'user-demo-primary',
  currencyCode: 'USD',
  activeView: 'home',
  historyFilter: 'ALL',
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

function openQuickEntry() {
  document.getElementById('quickEntryOverlay').classList.remove('hidden');
}

function closeQuickEntry() {
  document.getElementById('quickEntryOverlay').classList.add('hidden');
}

function openSettings() {
  document.getElementById('settingsOverlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.add('hidden');
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
  const dateVal = document.getElementById('txDateInput').value || '2026-11-26';
  const res = await fetch(`/api/dashboard?date=${encodeURIComponent(dateVal)}`, {
    headers: { 'x-user-id': state.userId },
  });
  const data = await res.json();
  state.dashboard = data;
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

function renderTxItems(transactions, containerEl, { showUndo = false } = {}) {
  if (transactions.length === 0) {
    containerEl.innerHTML = `<div class="tx-item"><span class="tx-sub">No transactions yet.</span></div>`;
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
  document.getElementById('cycleStartDaySelect').value = String(d.user.budgetCycleStartDay);
  document.getElementById('csvExportLink').href = `/api/export.csv?userId=${encodeURIComponent(state.userId)}`;

  const tenantSelect = document.getElementById('tenantSelect');
  tenantSelect.innerHTML = d.availableTenants
    .map((t) => `<option value="${t.id}" ${t.id === state.userId ? 'selected' : ''}>${t.label}</option>`)
    .join('');

  // Hero Safe-to-Spend & Summary
  document.getElementById('kpiSafeToSpend').textContent = formatMoney(d.safeToSpendMinor);
  document.getElementById('kpiSafeSub').textContent =
    d.unpaidRecurringMinor > 0
      ? `Includes ${formatMoney(d.unpaidRecurringMinor)} reserved for upcoming bills`
      : 'All due bills for this cycle are paid';
  document.getElementById('kpiTotalSpent').textContent = formatMoney(d.totalSpentMinor);
  document.getElementById('kpiTotalIncome').textContent = formatMoney(d.totalIncomeMinor);
  document.getElementById('kpiCardDebt').textContent = formatMoney(d.creditCardDebtMinor);

  // Due Soon Bills (Hide section completely if no active recurring rules)
  const recurringSec = document.getElementById('recurringSection');
  const dueRules = d.dueRecurringRules.filter((r) => r.isDueInCycle);
  if (dueRules.length === 0) {
    recurringSec.classList.add('hidden');
  } else {
    recurringSec.classList.remove('hidden');
    document.getElementById('recurringList').innerHTML = dueRules
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

  // Monthly Budgets
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
      return `<div class="budget-card">
        <div class="budget-top">
          <span class="budget-name">${c.name}</span>
          <span class="budget-remaining ${isOver ? 'over' : ''}">${remLabel}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="background:${barColor};transform:scaleX(${ratio});"></div>
        </div>
        <div class="budget-meta">${formatMoney(c.netSpentMinor)} spent of ${formatMoney(cap)}</div>
      </div>`;
    })
    .join('');

  // Overview: Last 5 active transactions
  const activeRecent = d.recentTransactions.filter((t) => !t.voidedAt).slice(0, 5);
  renderTxItems(activeRecent, document.getElementById('recentTxList'), { showUndo: false });

  // Activity View: Filtered full list
  const filtered = d.recentTransactions.filter((t) => {
    if (state.historyFilter === 'ALL') return true;
    if (state.historyFilter === 'EXPENSE') return t.type === 'EXPENSE' || t.type === 'REFUND';
    return t.type === state.historyFilter;
  });
  renderTxItems(filtered, document.getElementById('fullTxList'), { showUndo: true });

  // Accounts View
  document.getElementById('netLiquidityLabel').textContent = `Total Net Liquidity: ${formatMoney(d.netLiquidityMinor)}`;
  document.getElementById('accountsGrid').innerHTML = d.accounts
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

  // Quick-Entry Modal Chips
  document.getElementById('sourceAccountStrip').innerHTML = d.accounts
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
    document.getElementById('categoryStrip').innerHTML = d.categories
      .filter((c) => c.kind === neededKind)
      .map((c) => {
        const sel = c.id === state.selectedCategoryId ? 'selected' : '';
        return `<button type="button" class="chip ${sel}" data-cat-id="${c.id}">
          <span style="width:8px;height:8px;border-radius:99px;background:${c.color};display:inline-block;" aria-hidden="true"></span>
          <span>${c.name}</span>
        </button>`;
      })
      .join('');
  }

  updateKeypadReadout();
}

// Navigation & Modal Triggers
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});
document.getElementById('seeAllActivityBtn').addEventListener('click', () => switchView('history'));
document.getElementById('openQuickEntryBtn').addEventListener('click', openQuickEntry);
document.getElementById('heroLogBtn').addEventListener('click', openQuickEntry);
document.getElementById('closeQuickEntryBtn').addEventListener('click', closeQuickEntry);
document.getElementById('openSettingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);

document.getElementById('quickEntryOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'quickEntryOverlay') closeQuickEntry();
});
document.getElementById('settingsOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'settingsOverlay') closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeQuickEntry();
    closeSettings();
  }
});

// Keypad Input
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

document.querySelector('.mode-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tx-type]');
  if (!btn) return;
  document.querySelectorAll('.mode-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.txType = btn.dataset.txType;

  const hints = {
    EXPENSE: 'Counts toward your monthly budget',
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
  const btn = e.target.closest('[data-cat-id]');
  if (!btn) return;
  state.selectedCategoryId = btn.dataset.catId;
  renderAll();
});

document.getElementById('submitTxBtn').addEventListener('click', async () => {
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
    occurredOn: document.getElementById('txDateInput').value || '2026-11-26',
    note: document.getElementById('txNoteInput').value.trim(),
  };

  const res = await fetch('/api/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': state.userId },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(data.error || 'Could not save transaction.', true);
    return;
  }

  state.digitsMinor = 0;
  document.getElementById('txNoteInput').value = '';
  closeQuickEntry();

  const remText =
    data.categoryRemainingCapMinor !== null && data.categoryRemainingCapMinor !== undefined
      ? ` • ${formatMoney(data.categoryRemainingCapMinor)} left in category`
      : '';
  showToast(`Saved ${formatMoney(data.transaction.amountMinor)}${remText}`);
  await fetchDashboard();
});

document.getElementById('recurringList').addEventListener('click', async (e) => {
  const postBtn = e.target.closest('[data-post-rule]');
  if (postBtn) {
    const res = await fetch(`/api/recurring/${postBtn.dataset.postRule}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': state.userId },
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
    const res = await fetch(`/api/recurring/${skipBtn.dataset.skipRule}/skip`, {
      method: 'POST',
      headers: { 'x-user-id': state.userId },
    });
    if (res.ok) {
      showToast('Bill skipped for this cycle.');
      await fetchDashboard();
    }
  }
});

document.getElementById('accountsGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reconcile-acc]');
  if (!btn) return;
  const accName = btn.dataset.accName;
  const currentDollars = (Number(btn.dataset.accBal) / 100).toFixed(2);
  const input = window.prompt(
    `Update ${accName} balance\nEnter the current balance shown by your bank (e.g. ${currentDollars}):`,
    currentDollars
  );
  if (input === null) return;
  const parsed = Number(input);
  if (Number.isNaN(parsed)) {
    showToast('Please enter a valid number.', true);
    return;
  }
  const actualBalanceMinor = Math.round(parsed * 100);
  const res = await fetch('/api/accounts/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': state.userId },
    body: JSON.stringify({
      accountId: btn.dataset.reconcileAcc,
      actualBalanceMinor,
      occurredOn: document.getElementById('txDateInput').value || '2026-11-26',
    }),
  });
  if (res.ok) {
    showToast(`Updated ${accName} balance to ${formatMoney(actualBalanceMinor)}.`);
    await fetchDashboard();
  }
});

document.getElementById('fullTxList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-void-tx]');
  if (!btn) return;
  const res = await fetch(`/api/transactions/${btn.dataset.voidTx}/void`, {
    method: 'POST',
    headers: { 'x-user-id': state.userId },
  });
  if (res.ok) {
    showToast('Transaction removed and balances updated.');
    await fetchDashboard();
  }
});

document.getElementById('historyFilterPills').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
  btn.classList.add('active');
  state.historyFilter = btn.dataset.filter;
  renderAll();
});

document.getElementById('tenantSelect').addEventListener('change', async (e) => {
  state.userId = e.target.value;
  state.selectedAccountId = null;
  state.selectedCategoryId = null;
  state.digitsMinor = 0;
  closeSettings();
  await fetchDashboard();
});

document.getElementById('cycleStartDaySelect').addEventListener('change', async (e) => {
  const budgetCycleStartDay = Number(e.target.value);
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': state.userId },
    body: JSON.stringify({ budgetCycleStartDay }),
  });
  showToast(`Monthly budget reset day updated to Day ${budgetCycleStartDay}.`);
  await fetchDashboard();
});

document.getElementById('txDateInput').addEventListener('change', () => {
  fetchDashboard();
});

fetchDashboard();
