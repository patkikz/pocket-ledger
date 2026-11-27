import {
  state,
  formatMoney,
  showToast,
  closeModal,
  apiFetch,
  handleActionError,
  readErrorMessage,
} from './state.js';
import { fetchDashboard, renderAll, syncCategorySelection, updateKeypadReadout } from './dashboard.js';

export function initQuickEntryHandlers({ openAddCategoryModal }) {
  document.addEventListener('keydown', (e) => {
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

    try {
      const res = await apiFetch('/api/transactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not save transaction.'), true);
        return;
      }
      const data = await res.json();

      state.digitsMinor = 0;
      document.getElementById('txNoteInput').value = '';
      closeModal('quickEntryOverlay');

      const remText =
        data.categoryRemainingCapMinor !== null && data.categoryRemainingCapMinor !== undefined
          ? ` • ${formatMoney(data.categoryRemainingCapMinor)} left in category`
          : '';
      showToast(`Saved ${formatMoney(data.transaction.amountMinor)}${remText}`);
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not save transaction.');
    }
  });
}
