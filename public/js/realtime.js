import { state } from './state.js';
import { fetchDashboard } from './dashboard.js';

let eventSource = null;
let refreshTimer = null;

function scheduleSyncRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (state.user) {
      fetchDashboard().catch(() => {});
    }
  }, 150);
}

export function startRealtimeSync() {
  if (typeof EventSource === 'undefined') return;
  stopRealtimeSync();

  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('ledger_updated', () => {
    scheduleSyncRefresh();
  });
}

export function stopRealtimeSync() {
  clearTimeout(refreshTimer);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

export function initRealtimeWakeRefresh() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) {
      scheduleSyncRefresh();
    }
  });
}
