import {
  state,
  formatMoney,
  showToast,
  openModal,
  closeModal,
  apiFetch,
  handleActionError,
  readErrorMessage,
} from './state.js';
import { fetchDashboard } from './dashboard.js';
import { confirmDialog } from './confirm.js';

export function initAccountHandlers() {
  document.getElementById('openAddAccountBtn').addEventListener('click', () => openModal('addAccountOverlay'));
  document.getElementById('emptyAddAccountBtn').addEventListener('click', () => openModal('addAccountOverlay'));

  document.getElementById('addAccountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('newAccName').value.trim();
    const type = document.getElementById('newAccType').value;
    const initialBalanceMinor = Math.round(Number(document.getElementById('newAccBalance').value || 0) * 100);

    try {
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
        showToast(await readErrorMessage(res, 'Could not create account.'), true);
      }
    } catch (err) {
      handleActionError(err, 'Could not create account.');
    }
  });

  document.getElementById('accountsGrid').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-acc]');
    if (editBtn) {
      const acc = state.dashboard?.accounts.find((a) => a.id === editBtn.dataset.editAcc);
      if (!acc) return;
      document.getElementById('editAccountId').value = acc.id;
      document.getElementById('editAccName').value = acc.name;
      document.getElementById('editAccSafeToSpend').checked = acc.includeInSafeToSpend;
      document.getElementById('editAccSafeGroup').style.display = acc.type === 'CREDIT_CARD' ? 'none' : 'flex';
      openModal('editAccountOverlay');
      return;
    }

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

  document.getElementById('editAccountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editAccountId').value;
    const name = document.getElementById('editAccName').value.trim();
    const includeInSafeToSpend = document.getElementById('editAccSafeToSpend').checked;
    try {
      const res = await apiFetch(`/api/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, includeInSafeToSpend }),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not update account.'), true);
        return;
      }
      closeModal('editAccountOverlay');
      showToast(`Updated "${name}".`);
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not update account.');
    }
  });

  document.getElementById('archiveAccountBtn').addEventListener('click', async () => {
    const id = document.getElementById('editAccountId').value;
    const confirmed = await confirmDialog({
      title: 'Archive this account?',
      message: 'Historical transactions will be preserved, and this account will be hidden from active lists.',
      confirmText: 'Archive',
      cancelText: 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await apiFetch(`/api/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isArchived: true }),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not archive account.'), true);
        return;
      }
      state.selectedAccountId = null;
      closeModal('editAccountOverlay');
      showToast('Account archived.');
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not archive account.');
    }
  });

  document.getElementById('reconcileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const accountId = document.getElementById('reconcileAccId').value;
    const actualBalanceMinor = Math.round(Number(document.getElementById('reconcileNewBalance').value) * 100);
    try {
      const res = await apiFetch('/api/accounts/reconcile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, actualBalanceMinor, occurredOn: state.referenceDate }),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not update balance.'), true);
        return;
      }
      closeModal('reconcileOverlay');
      showToast(`Balance updated to ${formatMoney(actualBalanceMinor)}.`);
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not update balance.');
    }
  });
}
