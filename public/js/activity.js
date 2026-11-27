import {
  state,
  showToast,
  openModal,
  closeModal,
  apiFetch,
  handleActionError,
  readErrorMessage,
} from './state.js';
import { fetchDashboard, renderAll } from './dashboard.js';

export function initActivityHandlers() {
  document.getElementById('fullTxList').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-tx]');
    if (editBtn) {
      const tx = state.dashboard?.recentTransactions.find((t) => t.id === editBtn.dataset.editTx);
      if (!tx) return;
      document.getElementById('editTxId').value = tx.id;
      document.getElementById('editTxAmount').value = (tx.amountMinor / 100).toFixed(2);
      document.getElementById('editTxDate').value = tx.occurredOn;
      document.getElementById('editTxNote').value = tx.note || '';

      const catGroup = document.getElementById('editTxCategoryGroup');
      if (tx.type === 'TRANSFER') {
        catGroup.style.display = 'none';
      } else {
        catGroup.style.display = 'flex';
        const neededKind = tx.type === 'INCOME' ? 'INCOME' : 'EXPENSE';
        document.getElementById('editTxCategory').innerHTML = (state.dashboard?.categories || [])
          .filter((c) => c.kind === neededKind)
          .map((c) => `<option value="${c.id}" ${c.id === tx.categoryId ? 'selected' : ''}>${c.name}</option>`)
          .join('');
      }
      openModal('editTxOverlay');
      return;
    }

    const btn = e.target.closest('[data-void-tx]');
    if (!btn) return;
    try {
      const res = await apiFetch(`/api/transactions/${btn.dataset.voidTx}/void`, {
        method: 'POST',
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not remove transaction.'), true);
        return;
      }
      showToast('Transaction removed and balances updated.');
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not remove transaction.');
    }
  });

  document.getElementById('editTxForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const txId = document.getElementById('editTxId').value;
    const tx = state.dashboard?.recentTransactions.find((t) => t.id === txId);
    const amountMinor = Math.round(Number(document.getElementById('editTxAmount').value) * 100);
    const occurredOn = document.getElementById('editTxDate').value;
    const note = document.getElementById('editTxNote').value.trim();
    const categoryId = tx?.type === 'TRANSFER' ? null : document.getElementById('editTxCategory').value;

    try {
      const res = await apiFetch(`/api/transactions/${txId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountMinor, categoryId, occurredOn, note }),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not update transaction.'), true);
        return;
      }
      closeModal('editTxOverlay');
      showToast('Transaction updated.');
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not update transaction.');
    }
  });

  document.getElementById('voidTxFromModalBtn').addEventListener('click', async () => {
    const txId = document.getElementById('editTxId').value;
    if (!txId) return;
    try {
      const res = await apiFetch(`/api/transactions/${txId}/void`, { method: 'POST' });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not remove transaction.'), true);
        return;
      }
      closeModal('editTxOverlay');
      showToast('Transaction removed and balances updated.');
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not remove transaction.');
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
}
