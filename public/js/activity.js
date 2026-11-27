import {
  state,
  showToast,
  openModal,
  closeModal,
  apiFetch,
  withButtonLoading,
  handleActionError,
  readErrorMessage,
} from './state.js';
import { fetchDashboard, renderTxItems, setActivityInvalidateHandler } from './dashboard.js';
import { confirmDialog } from './confirm.js';

const PAGE_SIZE = 25;

function renderSkeletonRows(containerEl) {
  containerEl.innerHTML = Array.from({ length: 4 })
    .map(
      () => `<div class="skeleton-row" aria-hidden="true">
        <div style="display:flex;flex-direction:column;gap:0.45rem;width:55%;">
          <div class="skeleton-bar" style="width:70%;"></div>
          <div class="skeleton-bar" style="width:45%;height:10px;"></div>
        </div>
        <div class="skeleton-bar" style="width:68px;"></div>
      </div>`
    )
    .join('');
}

function renderActivityList() {
  const listEl = document.getElementById('fullTxList');
  const loadMoreWrap = document.getElementById('activityLoadMoreWrap');
  const emptyMsg = state.searchQuery.trim()
    ? 'No matching transactions found.'
    : 'No transactions yet.';

  renderTxItems(state.activity.items, listEl, { showUndo: true, groupByDate: true, emptyMsg });
  loadMoreWrap.classList.toggle('hidden', !state.activity.hasMore);
}

export async function loadActivityPage({ reset = false } = {}) {
  if (state.activity.isLoading) return;
  if (!reset && !state.activity.hasMore && state.activity.loadedOnce) return;

  const offset = reset ? 0 : state.activity.nextOffset;
  state.activity.isLoading = true;

  const listEl = document.getElementById('fullTxList');
  const loadMoreBtn = document.getElementById('loadMoreTxBtn');

  if (reset) {
    renderSkeletonRows(listEl);
    document.getElementById('activityLoadMoreWrap').classList.add('hidden');
  } else if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
  }

  try {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      type: state.historyFilter,
      q: state.searchQuery.trim(),
    });
    const res = await apiFetch(`/api/transactions?${params.toString()}`);
    if (!res.ok) {
      showToast(await readErrorMessage(res, 'Could not load activity.'), true);
      return;
    }
    const data = await res.json();
    state.activity.items = reset ? data.items : [...state.activity.items, ...data.items];
    state.activity.totalCount = data.totalCount;
    state.activity.hasMore = data.hasMore;
    state.activity.nextOffset = data.nextOffset;
    state.activity.loadedOnce = true;
    renderActivityList();
  } catch (err) {
    handleActionError(err, 'Could not load activity.');
  } finally {
    state.activity.isLoading = false;
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
    }
  }
}

export function ensureActivityLoaded() {
  if (!state.activity.loadedOnce) {
    loadActivityPage({ reset: true });
  }
}

export function initActivityHandlers() {
  setActivityInvalidateHandler(() => loadActivityPage({ reset: true }));

  document.getElementById('loadMoreTxBtn').addEventListener('click', () => {
    loadActivityPage({ reset: false });
  });

  if ('IntersectionObserver' in window) {
    const sentinel = document.getElementById('activityScrollSentinel');
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && state.activeView === 'history' && state.activity.hasMore && !state.activity.isLoading) {
          loadActivityPage({ reset: false });
        }
      },
      { rootMargin: '120px' }
    );
    observer.observe(sentinel);
  }

  document.getElementById('fullTxList').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-tx]');
    if (editBtn) {
      const tx = state.activity.items.find((t) => t.id === editBtn.dataset.editTx)
        || state.dashboard?.recentTransactions.find((t) => t.id === editBtn.dataset.editTx);
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
    const confirmed = await confirmDialog({
      title: 'Undo this transaction?',
      message: 'This will void the entry and recalculate your account balances.',
      confirmText: 'Yes, undo',
      cancelText: 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) return;
    await withButtonLoading(btn, '…', async () => {
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
  });

  document.getElementById('editTxForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = e.target.querySelector('button[type="submit"]');
    const txId = document.getElementById('editTxId').value;
    const tx = state.activity.items.find((t) => t.id === txId)
      || state.dashboard?.recentTransactions.find((t) => t.id === txId);
    const amountMinor = Math.round(Number(document.getElementById('editTxAmount').value) * 100);
    const occurredOn = document.getElementById('editTxDate').value;
    const note = document.getElementById('editTxNote').value.trim();
    const categoryId = tx?.type === 'TRANSFER' ? null : document.getElementById('editTxCategory').value;

    await withButtonLoading(saveBtn, 'Saving…', async () => {
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
  });

  document.getElementById('voidTxFromModalBtn').addEventListener('click', async (e) => {
    const txId = document.getElementById('editTxId').value;
    if (!txId) return;
    const confirmed = await confirmDialog({
      title: 'Remove this transaction?',
      message: 'This will void the entry and recalculate your account balances.',
      confirmText: 'Yes, remove',
      cancelText: 'Cancel',
      tone: 'danger',
    });
    if (!confirmed) return;
    await withButtonLoading(e.currentTarget, 'Removing…', async () => {
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
  });

  let searchTimer = null;
  document.getElementById('activitySearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadActivityPage({ reset: true });
    }, 200);
  });

  document.getElementById('historyFilterPills').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    state.historyFilter = btn.dataset.filter;
    loadActivityPage({ reset: true });
  });
}
