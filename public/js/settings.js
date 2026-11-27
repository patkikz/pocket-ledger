import { state, showToast, apiFetch, handleActionError, readErrorMessage } from './state.js';
import { fetchDashboard } from './dashboard.js';

export function initSettingsHandlers() {
  document.getElementById('currencySelect').addEventListener('change', async (e) => {
    const homeCurrencyCode = e.target.value;
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ homeCurrencyCode }),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not update currency.'), true);
        return;
      }
      showToast(`Home currency updated to ${homeCurrencyCode}.`);
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not update currency.');
    }
  });

  document.getElementById('cycleStartDaySelect').addEventListener('change', async (e) => {
    const budgetCycleStartDay = Number(e.target.value);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budgetCycleStartDay }),
      });
      if (!res.ok) {
        showToast(await readErrorMessage(res, 'Could not update budget reset day.'), true);
        return;
      }
      showToast(`Monthly budget reset day updated to Day ${budgetCycleStartDay}.`);
      await fetchDashboard();
    } catch (err) {
      handleActionError(err, 'Could not update budget reset day.');
    }
  });

  document.getElementById('txDateInput').addEventListener('change', (e) => {
    if (e.target.value) {
      state.referenceDate = e.target.value;
      fetchDashboard().catch((err) => handleActionError(err, 'Could not load dashboard.'));
    }
  });
}
