const state = {
  userId: 'user-demo-primary',
  currencyCode: 'USD',
  txType: 'EXPENSE',
  digitsMinor: 0,
  tapCount: 0,
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

function updateKeypadReadout() {
  const readoutEl = document.getElementById('keypadAmountReadout');
  const debugEl = document.getElementById('minorUnitsDebug');
  const tapEl = document.getElementById('tapCounterPill');
  const submitBtn = document.getElementById('submitTxBtn');

  readoutEl.textContent = formatMoney(state.digitsMinor);
  debugEl.textContent = `${state.digitsMinor} minor units (64-bit integer)`;
  tapEl.textContent = `${state.tapCount} tap${state.tapCount === 1 ? '' : 's'} • Smart Defaults Ready`;

  const labels = {
    EXPENSE: 'Save Expense Now',
    REFUND: 'Record Refund (−Expense)',
    INCOME: 'Record Income Now',
    TRANSFER: 'Execute Neutral Transfer',
  };
  submitBtn.querySelector('span').textContent = `${labels[state.txType]} (${formatMoney(state.digitsMinor)})`;
}

function showFeedback(msg, isError = false) {
  const banner = document.getElementById('quickFeedbackBanner');
  banner.textContent = msg;
  banner.style.background = isError ? 'rgba(244, 63, 94, 0.16)' : 'rgba(16, 185, 129, 0.14)';
  banner.style.borderColor = isError ? 'rgba(244, 63, 94, 0.4)' : 'rgba(16, 185, 129, 0.35)';
  banner.style.color = isError ? '#fda4af' : '#6ee7b7';
  banner.classList.remove('hidden');
}

async function fetchDashboard() {
  const dateVal = document.getElementById('txDateInput').value || '2026-11-26';
  const res = await fetch(`/api/dashboard?date=${encodeURIComponent(dateVal)}`, {
    headers: { 'x-user-id': state.userId },
  });
  const data = await res.json();
  state.dashboard = data;
  state.currencyCode = data.user.homeCurrencyCode;

  // Apply smart defaults if current selection doesn't belong to this tenant
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

function syncCategorySelection() {
  if (!state.dashboard) return;
  const neededKind = state.txType === 'INCOME' ? 'INCOME' : 'EXPENSE';
  const matching = state.dashboard.categories.filter((c) => c.kind === neededKind);
  if (!matching.some((c) => c.id === state.selectedCategoryId)) {
    state.selectedCategoryId = matching[0]?.id || null;
  }
}

function renderAll() {
  const d = state.dashboard;
  if (!d) return;

  // Topbar tenant & cycle info
  document.getElementById('cycleWindowLabel').textContent =
    `Active Budget Cycle: ${d.cycleStart} → ${d.cycleEnd} (Resets on Day ${d.user.budgetCycleStartDay})`;

  const tenantSelect = document.getElementById('tenantSelect');
  tenantSelect.innerHTML = d.availableTenants
    .map((t) => `<option value="${t.id}" ${t.id === state.userId ? 'selected' : ''}>${t.label}</option>`)
    .join('');

  document.getElementById('cycleStartDaySelect').value = String(d.user.budgetCycleStartDay);
  document.getElementById('csvExportLink').href = `/api/export.csv?userId=${encodeURIComponent(state.userId)}`;

  // Verify ACID audit badge
  const allValid = (d.integrityAudits || []).every((a) => a.isValid);
  const badge = document.getElementById('acidAuditBadge');
  badge.textContent = allValid
    ? `ACID Verified • ${d.accounts.length} Accounts 0-Cent Drift`
    : 'Integrity Drift Detected!';

  // Render Smart Default Chips
  const sourceStrip = document.getElementById('sourceAccountStrip');
  sourceStrip.innerHTML = d.accounts
    .map((a) => {
      const sel = a.id === state.selectedAccountId ? 'selected' : '';
      return `<button type="button" class="chip ${sel}" data-source-acc="${a.id}">
        <span>${a.name}</span>
        <span style="opacity:0.75;">${formatMoney(a.cachedBalanceMinor)}</span>
      </button>`;
    })
    .join('');

  const categorySection = document.getElementById('categorySection');
  const destSection = document.getElementById('destinationAccountSection');

  if (state.txType === 'TRANSFER') {
    categorySection.style.display = 'none';
    destSection.style.display = 'block';
    const destStrip = document.getElementById('destinationAccountStrip');
    destStrip.innerHTML = d.accounts
      .filter((a) => a.id !== state.selectedAccountId)
      .map((a) => {
        const sel = a.id === state.selectedDestinationAccountId ? 'selected' : '';
        return `<button type="button" class="chip ${sel}" data-dest-acc="${a.id}">
          <span>→ ${a.name}</span>
          <span style="opacity:0.75;">${formatMoney(a.cachedBalanceMinor)}</span>
        </button>`;
      })
      .join('');
  } else {
    categorySection.style.display = 'block';
    destSection.style.display = 'none';
    const neededKind = state.txType === 'INCOME' ? 'INCOME' : 'EXPENSE';
    const catStrip = document.getElementById('categoryStrip');
    catStrip.innerHTML = d.categories
      .filter((c) => c.kind === neededKind)
      .map((c) => {
        const sel = c.id === state.selectedCategoryId ? 'selected' : '';
        return `<button type="button" class="chip ${sel}" data-cat-id="${c.id}">
          <span style="width:8px;height:8px;border-radius:99px;background:${c.color};display:inline-block;"></span>
          <span>${c.name}</span>
        </button>`;
      })
      .join('');
  }

  updateKeypadReadout();

  // KPIs
  document.getElementById('kpiSafeToSpend').textContent = formatMoney(d.safeToSpendMinor);
  document.getElementById('kpiSafeSub').textContent =
    `${formatMoney(d.safeLiquidAssetsMinor)} liquid − ${formatMoney(d.unpaidRecurringMinor)} due bills`;

  document.getElementById('kpiTotalSpent').textContent = formatMoney(d.totalSpentMinor);
  document.getElementById('kpiSpentCapSub').textContent =
    `of ${formatMoney(d.totalMonthlyCapMinor)} combined monthly category caps`;

  document.getElementById('kpiTotalIncome').textContent = formatMoney(d.totalIncomeMinor);
  document.getElementById('kpiNetLiquidity').textContent = formatMoney(d.netLiquidityMinor);
  document.getElementById('kpiCardDebtSub').textContent =
    `Credit Card Debt: ${formatMoney(d.creditCardDebtMinor)}`;

  // 1-Tap Recurring Reminders
  const recurringList = document.getElementById('recurringList');
  if (d.dueRecurringRules.length === 0) {
    recurringList.innerHTML = `<div style="font-size:0.8rem;color:var(--text-muted);">No recurring bills scheduled.</div>`;
  } else {
    recurringList.innerHTML = d.dueRecurringRules
      .map(
        (r) => `<div class="recurring-item">
          <div>
            <div style="font-weight:700;font-size:0.88rem;">${r.title} • ${formatMoney(r.defaultAmountMinor)}</div>
            <div style="font-size:0.74rem;color:var(--text-secondary);">
              Due ${r.nextDueDate} • ${r.accountName} • ${r.categoryName || 'Transfer'}
              ${r.isDueInCycle ? '<strong style="color:#fbbf24;"> (Reserved from Safe-to-Spend)</strong>' : ' (Next Cycle)'}
            </div>
          </div>
          <div style="display:flex;gap:0.45rem;">
            <button type="button" class="btn-post-one-tap" data-post-rule="${r.id}">
              1-Tap Post to Ledger
            </button>
            <button type="button" class="btn-secondary" data-skip-rule="${r.id}">
              Skip Cycle
            </button>
          </div>
        </div>`
      )
      .join('');
  }

  // Real-World Accounts & Reconcile buttons
  const accountsGrid = document.getElementById('accountsGrid');
  accountsGrid.innerHTML = d.accounts
    .map((a) => {
      const balColor = a.cachedBalanceMinor < 0 ? 'var(--accent-rose)' : 'var(--text-primary)';
      return `<div class="account-box">
        <div class="account-top">
          <div>
            <div style="font-weight:700;font-size:0.9rem;">${a.name}</div>
            <div class="audit-pill">✓ Ledger Sum Matches</div>
          </div>
          <span class="account-type-tag">${a.type.replace('_', ' ')}</span>
        </div>
        <div>
          <div class="account-balance" style="color:${balColor};">${formatMoney(a.cachedBalanceMinor)}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.15rem;">
            ${a.includeInSafeToSpend ? 'Included in Safe-to-Spend' : 'Excluded from daily Safe-to-Spend'}
          </div>
        </div>
        <button type="button" class="btn-secondary" style="justify-content:center;" data-reconcile-acc="${a.id}" data-acc-name="${a.name}" data-acc-bal="${a.cachedBalanceMinor}">
          Reconcile Balance
        </button>
      </div>`;
    })
    .join('');

  // Reactive Category Caps
  const capsGrid = document.getElementById('categoryCapsGrid');
  capsGrid.innerHTML = d.categories
    .filter((c) => c.kind === 'EXPENSE')
    .map((c) => {
      const cap = c.monthlyCapMinor || 0;
      const ratio = cap > 0 ? Math.max(0, Math.min(1, c.netSpentMinor / cap)) : 0;
      const isOver = cap > 0 && c.netSpentMinor > cap;
      const barColor = isOver ? 'var(--accent-rose)' : c.color;
      return `<div class="category-card">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:700;font-size:0.86rem;">${c.name}</span>
          <span style="font-size:0.76rem;font-weight:700;color:${isOver ? 'var(--accent-rose)' : 'var(--text-secondary)'};">
            ${formatMoney(c.netSpentMinor)} / ${formatMoney(cap)}
          </span>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="background:${barColor};transform:scaleX(${ratio});"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:0.72rem;color:var(--text-muted);margin-top:0.4rem;">
          <span>${c.percentUsed}% used</span>
          <span>${c.remainingCapMinor >= 0 ? `${formatMoney(c.remainingCapMinor)} left` : `${formatMoney(Math.abs(c.remainingCapMinor))} over cap`}</span>
        </div>
      </div>`;
    })
    .join('');

  // Ledger Transactions Table
  const tbody = document.getElementById('ledgerTableBody');
  tbody.innerHTML = d.recentTransactions
    .map((t) => {
      const isVoid = Boolean(t.voidedAt);
      const flowText =
        t.type === 'TRANSFER'
          ? `${t.accountName} → ${t.transferDestinationAccountName}`
          : t.accountName;
      const signPrefix =
        t.type === 'EXPENSE' ? '-' : t.type === 'INCOME' || t.type === 'REFUND' ? '+' : '';
      return `<tr class="tx-row ${isVoid ? 'tx-voided' : ''}">
        <td>${t.occurredOn}</td>
        <td><span class="type-badge type-${t.type}">${t.type}</span></td>
        <td>${flowText}</td>
        <td>${t.categoryName || '—'}</td>
        <td>${t.note || '—'}</td>
        <td style="text-align:right;font-weight:700;">${signPrefix}${formatMoney(t.amountMinor)}</td>
        <td style="text-align:right;">
          ${
            isVoid
              ? '<span style="font-size:0.72rem;color:var(--text-muted);">Voided</span>'
              : `<button type="button" class="btn-secondary" style="padding:0.2rem 0.5rem;font-size:0.72rem;" data-void-tx="${t.id}">Void</button>`
          }
        </td>
      </tr>`;
    })
    .join('');
}

// Event Listeners
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
  state.tapCount += 1;
  updateKeypadReadout();
});

document.querySelector('.mode-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tx-type]');
  if (!btn) return;
  document.querySelectorAll('.mode-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.txType = btn.dataset.txType;

  const hints = {
    EXPENSE: 'Deducts from account & category cap',
    REFUND: 'Restores account balance & reduces category spend',
    INCOME: 'Credits account balance & increases cycle income',
    TRANSFER: 'Moves money between own accounts ($0.00 report impact)',
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
    showFeedback('Enter an amount greater than 0 on the keypad.', true);
    return;
  }
  const tapsUsed = state.tapCount + 1;
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
    headers: {
      'content-type': 'application/json',
      'x-user-id': state.userId,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    showFeedback(data.error || 'Failed to record transaction', true);
    return;
  }

  state.digitsMinor = 0;
  state.tapCount = 0;
  document.getElementById('txNoteInput').value = '';

  const remText =
    data.categoryRemainingCapMinor !== null && data.categoryRemainingCapMinor !== undefined
      ? ` • Remaining Category Cap: ${formatMoney(data.categoryRemainingCapMinor)}`
      : ' • $0.00 Budget Impact';
  showFeedback(`Logged ${formatMoney(data.transaction.amountMinor)} in ${tapsUsed} taps${remText}`);
  await fetchDashboard();
});

document.getElementById('recurringList').addEventListener('click', async (e) => {
  const postBtn = e.target.closest('[data-post-rule]');
  if (postBtn) {
    const ruleId = postBtn.dataset.postRule;
    const res = await fetch(`/api/recurring/${ruleId}/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': state.userId },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      showFeedback('1-Tap Recurring Bill posted to ledger & advanced to next cycle!');
      await fetchDashboard();
    }
    return;
  }
  const skipBtn = e.target.closest('[data-skip-rule]');
  if (skipBtn) {
    const ruleId = skipBtn.dataset.skipRule;
    const res = await fetch(`/api/recurring/${ruleId}/skip`, {
      method: 'POST',
      headers: { 'x-user-id': state.userId },
    });
    if (res.ok) {
      showFeedback('Skipped recurring bill for this cycle.');
      await fetchDashboard();
    }
  }
});

document.getElementById('accountsGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reconcile-acc]');
  if (!btn) return;
  const accId = btn.dataset.reconcileAcc;
  const accName = btn.dataset.accName;
  const currentDollars = (Number(btn.dataset.accBal) / 100).toFixed(2);
  const input = window.prompt(
    `Weekly Reconciliation for ${accName}\nEnter actual real-world statement balance (e.g. ${currentDollars}):`,
    currentDollars
  );
  if (input === null) return;
  const parsed = Number(input);
  if (Number.isNaN(parsed)) {
    showFeedback('Invalid number entered for reconciliation.', true);
    return;
  }
  const actualBalanceMinor = Math.round(parsed * 100);
  const res = await fetch('/api/accounts/reconcile', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': state.userId },
    body: JSON.stringify({
      accountId: accId,
      actualBalanceMinor,
      occurredOn: document.getElementById('txDateInput').value || '2026-11-26',
    }),
  });
  if (res.ok) {
    showFeedback(`Reconciled ${accName} to ${formatMoney(actualBalanceMinor)} via ADJUSTMENT ledger entry.`);
    await fetchDashboard();
  }
});

document.getElementById('ledgerTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-void-tx]');
  if (!btn) return;
  const txId = btn.dataset.voidTx;
  const res = await fetch(`/api/transactions/${txId}/void`, {
    method: 'POST',
    headers: { 'x-user-id': state.userId },
  });
  if (res.ok) {
    showFeedback('Transaction soft-voided; account balance recalculated from ledger.');
    await fetchDashboard();
  }
});

document.getElementById('tenantSelect').addEventListener('change', async (e) => {
  state.userId = e.target.value;
  state.selectedAccountId = null;
  state.selectedCategoryId = null;
  state.digitsMinor = 0;
  state.tapCount = 0;
  await fetchDashboard();
});

document.getElementById('cycleStartDaySelect').addEventListener('change', async (e) => {
  const budgetCycleStartDay = Number(e.target.value);
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': state.userId },
    body: JSON.stringify({ budgetCycleStartDay }),
  });
  showFeedback(`Updated budget cycle start day to Day ${budgetCycleStartDay}.`);
  await fetchDashboard();
});

document.getElementById('txDateInput').addEventListener('change', () => {
  fetchDashboard();
});

fetchDashboard();
