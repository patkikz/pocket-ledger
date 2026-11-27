import { state, formatMoney, showToast, apiFetch, handleActionError } from './state.js';

export function syncCategorySelection() {
  if (!state.dashboard) return;
  const neededKind = state.txType === 'INCOME' ? 'INCOME' : 'EXPENSE';
  const matching = state.dashboard.categories.filter((c) => c.kind === neededKind);
  if (!matching.some((c) => c.id === state.selectedCategoryId)) {
    state.selectedCategoryId = matching[0]?.id || null;
  }
}

export function updateKeypadReadout() {
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

export function renderTxItems(transactions, containerEl, { showUndo = false, emptyMsg = 'No transactions yet.' } = {}) {
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
            showUndo && !isVoid && t.type !== 'ADJUSTMENT'
              ? `<button type="button" class="btn-undo-sm" data-edit-tx="${t.id}">Edit</button>`
              : ''
          }
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

export function renderAll() {
  const d = state.dashboard;
  if (!d) return;

  document.getElementById('cycleWindowLabel').textContent = `${d.cycleStart} to ${d.cycleEnd}`;
  document.getElementById('settingsUserEmail').textContent = d.user.email;
  document.getElementById('cycleStartDaySelect').value = String(d.user.budgetCycleStartDay);
  document.getElementById('currencySelect').value = d.user.homeCurrencyCode;
  document.getElementById('csvExportLink').href = '/api/export.csv';

  document.getElementById('emptyAccountCallout').classList.toggle('hidden', d.accounts.length > 0);

  document.getElementById('kpiSafeToSpend').textContent = formatMoney(d.safeToSpendMinor);
  document.getElementById('kpiSafeSub').textContent =
    d.unpaidRecurringMinor > 0
      ? `Includes ${formatMoney(d.unpaidRecurringMinor)} reserved for upcoming bills`
      : 'All due bills for this cycle are paid';

  document.getElementById('kpiTotalSpent').textContent = formatMoney(d.totalSpentMinor);
  const spentTrendEl = document.getElementById('kpiSpentTrend');
  if (d.previousTotalSpentMinor > 0) {
    const delta = d.spentDeltaMinor;
    if (delta < 0) {
      spentTrendEl.textContent = `↓ ${formatMoney(Math.abs(delta))} vs last cycle`;
      spentTrendEl.className = 'stat-trend down';
    } else if (delta > 0) {
      spentTrendEl.textContent = `↑ ${formatMoney(delta)} vs last cycle`;
      spentTrendEl.className = 'stat-trend up';
    } else {
      spentTrendEl.textContent = 'Same as last cycle';
      spentTrendEl.className = 'stat-trend';
    }
  } else {
    spentTrendEl.textContent = '';
    spentTrendEl.className = 'stat-trend';
  }
  document.getElementById('kpiTotalIncome').textContent = formatMoney(d.totalIncomeMinor);
  document.getElementById('kpiCardDebt').textContent = formatMoney(d.creditCardDebtMinor);

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
            <button type="button" class="btn-secondary" data-edit-rule="${r.id}">Edit</button>
            <button type="button" class="btn-secondary" data-skip-rule="${r.id}">Skip</button>
          </div>
        </div>`
      )
      .join('');
  }

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
      let trendHtml = '';
      if (c.previousNetSpentMinor > 0) {
        if (c.deltaMinor < 0) {
          trendHtml = `<div class="budget-trend down">↓ ${formatMoney(Math.abs(c.deltaMinor))} vs last cycle</div>`;
        } else if (c.deltaMinor > 0) {
          trendHtml = `<div class="budget-trend up">↑ ${formatMoney(c.deltaMinor)} vs last cycle</div>`;
        }
      }
      return `<button type="button" class="budget-card budget-card-btn" data-edit-cat="${c.id}" data-cat-name="${c.name}" data-cat-cap="${cap}">
        <div class="budget-top">
          <span class="budget-name">${c.name}</span>
          <span class="budget-remaining ${isOver ? 'over' : ''}">${remLabel}</span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="background:${barColor};transform:scaleX(${ratio});"></div>
        </div>
        <div class="budget-meta">${formatMoney(c.netSpentMinor)} spent of ${formatMoney(cap)} · Tap to edit</div>
        ${trendHtml}
      </button>`;
    })
    .join('');

  const activeRecent = d.recentTransactions.filter((t) => !t.voidedAt).slice(0, 5);
  renderTxItems(activeRecent, document.getElementById('recentTxList'), { showUndo: false });

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
          <div class="account-actions">
            <button type="button" class="btn-secondary" style="justify-content:center;" data-reconcile-acc="${a.id}" data-acc-name="${a.name}" data-acc-bal="${a.cachedBalanceMinor}">
              Update Balance
            </button>
            <button type="button" class="btn-secondary" data-edit-acc="${a.id}">
              Edit
            </button>
          </div>
        </div>`;
      })
      .join('');
  }

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

export async function fetchDashboard() {
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

export function shiftReferenceMonth(deltaMonths) {
  const [y, m, d] = state.referenceDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, Math.min(d, 28)));
  state.referenceDate = dt.toISOString().slice(0, 10);
  document.getElementById('txDateInput').value = state.referenceDate;
  fetchDashboard().catch((err) => handleActionError(err, 'Could not load dashboard.'));
}
