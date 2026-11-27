import { state } from './state.js';
import { fetchDashboard } from './dashboard.js';

let eventSource = null;
let refreshTimer = null;
let reconnectTimer = null;
let fallbackPollTimer = null;

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

  eventSource.onerror = () => {
    if (eventSource && eventSource.readyState === EventSource.CLOSED && state.user) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (state.user) startRealtimeSync();
      }, 3000);
    }
  };

  // Fallback check if mobile browser suspends SSE while backgrounded
  fallbackPollTimer = setInterval(() => {
    if (state.user && document.visibilityState === 'visible' && (!eventSource || eventSource.readyState !== EventSource.OPEN)) {
      scheduleSyncRefresh();
    }
  }, 10000);
}

export function stopRealtimeSync() {
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  clearInterval(fallbackPollTimer);
  fallbackPollTimer = null;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

export function initRealtimeWakeRefresh() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) {
      scheduleSyncRefresh();
      if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        startRealtimeSync();
      }
    }
  });
  window.addEventListener('focus', () => {
    if (state.user) {
      scheduleSyncRefresh();
    }
  });
}
