import {
  state,
  showToast,
  openModal,
  closeModal,
  apiFetch,
  handleActionError,
  readErrorMessage,
} from './state.js';
import { fetchDashboard } from './dashboard.js';

function syncCategoryModalFields() {
  const isIncome = document.getElementById('newCatKind').value === 'INCOME' && !document.getElementById('editCategoryId').value;
  document.getElementById('newCatCapGroup').style.display = isIncome ? 'none' : 'flex';
  document.getElementById('newCatCap').required = !isIncome;
}

export function openAddCategoryModal(defaultKind = 'EXPENSE') {
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

function populateRecurringSelects() {
  const d = state.dashboard;
  document.getElementById('newBillAccount').innerHTML = d.accounts
    .map((a) => `<option value="${a.id}">${a.name}</option>`)
    .join('');
  document.getElementById('newBillCategory').innerHTML = d.categories
    .filter((c) => c.kind === 'EXPENSE')
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join('');
}

export function initBudgetAndRecurringHandlers() {
  document.getElementById('openAddCategoryBtn').addEventListener('click', () => openAddCategoryModal('EXPENSE'));
  document.getElementById('newCatKind').addEventListener('change', syncCategoryModalFields);

  document.getElementById('categoryCapsGrid').addEventListener('click', (e) => {
    const card = e.target.closest('[data-edit-cat]');
    if (!card) return;
    document.getElementById('categoryModalTitle').textContent = `Edit ${card.dataset.catName} Budget`;
    document.getElementById('editCategoryId').value = card.dataset.editCat;
    document.getElementById('newCatKindGroup').style.display = 'none';
    document.getElementById('newCatNameGroup').style.display = 'flex';
    document.getElementById('newCatName').required = true;
    document.getElementById('newCatName').value = card.dataset.catName;
    document.getElementById('newCatCapGroup').style.display = 'flex';
    document.getElementById('newCatCap').required = true;
    document.getElementById('newCatCap').value = (Number(card.dataset.catCap) / 100).toFixed(2);
    openModal('categoryModalOverlay');
  });

  document.getElementById('categoryForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('editCategoryId').value;
    const kind = document.getElementById('newCatKind').value;
    const name = document.getElementById('newCatName').value.trim();
    const capVal = document.getElementById('newCatCap').value;
    const monthlyCapMinor = kind === 'INCOME' && !editId ? null : Math.round(Number(capVal) * 100);

    try {
      if (editId) {
        const res = await apiFetch(`/api/categories/${editId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, monthlyCapMinor }),
        });
        if (!res.ok) {
          showToast(await readErrorMessage(res, 'Could not update category.'), true);
          return;
        }
        closeModal('categoryModalOverlay');
        showToast('Category updated.');
        await fetchDashboard();
      } else {
        const color = kind === 'INCOME' ? '#14b8a6' : '#6366f1';
        const res = await apiFetch('/api/categories', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, kind, monthlyCapMinor, color }),
        });
        if (!res.ok) {
          showToast(await readErrorMessage(res, 'Could not create category.'), true);
          return;
        }
        const created = await res.json();
        state.selectedCategoryId = created.category.id;
        closeModal('categoryModalOverlay');
        showToast(`Added "${name}" category.`);
        await fetchDashboard();
      }
    } catch (err) {
      handleActionError(err, 'Could not save category.');
    }
  });

  document.getElementById('openAddRecurringBtn').addEventListener('click', () => {
    const d = state.dashboard;
    if (!d || d.accounts.length === 0) {
      showToast('Please add an account first.', true);
      return;
    }
    document.getElementById('recurringModalTitle').textContent = 'Add Recurring Bill';
    document.getElementById('editRuleId').value = '';
    document.getElementById('recurringForm').reset();
    populateRecurringSelects();
    document.getElementById('newBillDate').value = state.referenceDate;
    document.getElementById('saveRuleBtn').textContent = 'Save Bill Reminder';
    document.getElementById('deleteRuleBtn').classList.add('hidden');
    openModal('recurringModalOverlay');
  });

  document.getElementById('recurringForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editRuleId = document.getElementById('editRuleId').value;
    const title = document.getElementById('newBillTitle').value.trim();
    const defaultAmountMinor = Math.round(Number(document.getElementById('newBillAmount').value) * 100);
    const accountId = document.getElementById('newBillAccount').value;
    const categoryId = document.getElementById('newBillCategory').value;
    const nextDueDate = document.getElementById('newBillDate').value;

    try {
      const res = await apiFetch(editRuleId ? `/api/recurring/${editRuleId}` : '/api/recurring', {
        method: editRuleId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          editRuleId
            ? { title, defaultAmountMinor, accountId, categoryId, nextDueDate }
            : { title, type: 'EXPENSE', defaultAmountMinor, accountId, categoryId, frequency: 'MONTHLY', nextDueDate }
        ),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not save bill reminder.'), true);
        return;
      }
      document.getElementById('recurringForm').reset();
      closeModal('recurringModalOverlay');
      showToast(editRuleId ? `Updated "${title}".` : `Added "${title}" bill reminder.`);
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not save bill reminder.');
    }
  });

  document.getElementById('deleteRuleBtn').addEventListener('click', async () => {
    const editRuleId = document.getElementById('editRuleId').value;
    if (!editRuleId) return;
    try {
      const res = await apiFetch(`/api/recurring/${editRuleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not remove bill.'), true);
        return;
      }
      closeModal('recurringModalOverlay');
      showToast('Recurring bill removed.');
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not remove bill.');
    }
  });

  document.getElementById('recurringList').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-rule]');
    if (editBtn) {
      const rule = state.dashboard?.dueRecurringRules.find((r) => r.id === editBtn.dataset.editRule);
      if (!rule) return;
      document.getElementById('recurringModalTitle').textContent = 'Edit Recurring Bill';
      document.getElementById('editRuleId').value = rule.id;
      populateRecurringSelects();
      document.getElementById('newBillTitle').value = rule.title;
      document.getElementById('newBillAmount').value = (rule.defaultAmountMinor / 100).toFixed(2);
      document.getElementById('newBillAccount').value = rule.accountId;
      if (rule.categoryId) document.getElementById('newBillCategory').value = rule.categoryId;
      document.getElementById('newBillDate').value = rule.nextDueDate;
      document.getElementById('saveRuleBtn').textContent = 'Save Changes';
      document.getElementById('deleteRuleBtn').classList.remove('hidden');
      openModal('recurringModalOverlay');
      return;
    }

    const postBtn = e.target.closest('[data-post-rule]');
    if (postBtn) {
      try {
        const res = await apiFetch(`/api/recurring/${postBtn.dataset.postRule}/post`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          showToast(await readErrorMessage(res, 'Could not post bill.'), true);
          return;
        }
        showToast('Bill marked as paid and added to your activity.');
        await fetchDashboard();
      } catch (err) {
        handleActionError(err, 'Could not post bill.');
      }
      return;
    }

    const skipBtn = e.target.closest('[data-skip-rule]');
    if (skipBtn) {
      try {
        const res = await apiFetch(`/api/recurring/${skipBtn.dataset.skipRule}/skip`, {
          method: 'POST',
        });
        if (!res.ok) {
          showToast(await readErrorMessage(res, 'Could not skip bill.'), true);
          return;
        }
        showToast('Bill skipped for this cycle.');
        await fetchDashboard();
      } catch (err) {
        handleActionError(err, 'Could not skip bill.');
      }
    }
  });
}
