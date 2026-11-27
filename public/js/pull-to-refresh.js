import { state } from './state.js';
import { fetchDashboard } from './dashboard.js';
import { loadActivityPage } from './activity.js';

const THRESHOLD_PX = 72;
const MAX_PULL_PX = 112;
const DAMPING = 0.45;

export function initPullToRefresh() {
  const mainEl = document.querySelector('main.container');
  const indicatorEl = document.getElementById('ptrIndicator');
  const arrowEl = indicatorEl?.querySelector('.ptr-arrow');
  const labelEl = document.getElementById('ptrLabel');
  if (!mainEl || !indicatorEl || !labelEl) return;

  let startY = 0;
  let currentPull = 0;
  let isPulling = false;
  let isRefreshing = false;

  function canStartPull() {
    if (isRefreshing || !state.user) return false;
    if (window.scrollY > 0) return false;
    if (!document.getElementById('authView').classList.contains('hidden')) return false;
    if (document.querySelector('.modal-overlay:not(.hidden)')) return false;
    return true;
  }

  function applyTrackTransform(pullY) {
    const progress = Math.min(1, pullY / THRESHOLD_PX);
    mainEl.style.transition = 'none';
    indicatorEl.style.transition = 'none';
    mainEl.style.transform = `translate3d(0, ${pullY}px, 0)`;
    indicatorEl.style.transform = `translate3d(-50%, ${Math.min(pullY - 40, 20)}px, 0)`;
    indicatorEl.style.opacity = String(Math.min(1, progress * 1.15));
    if (arrowEl) {
      arrowEl.style.transform = pullY >= THRESHOLD_PX ? 'rotate(180deg)' : 'rotate(0deg)';
    }
    labelEl.textContent = pullY >= THRESHOLD_PX ? 'Release to refresh' : 'Pull to refresh';
  }

  function resetPosition() {
    mainEl.style.transition = 'transform 220ms var(--ease-drawer)';
    indicatorEl.style.transition = 'transform 200ms var(--ease-out), opacity 180ms var(--ease-out)';
    mainEl.style.transform = 'translate3d(0, 0, 0)';
    indicatorEl.style.transform = 'translate3d(-50%, -60px, 0)';
    indicatorEl.style.opacity = '0';
    indicatorEl.classList.remove('refreshing');
  }

  window.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length > 1) {
        isPulling = false;
        return;
      }
      if (!canStartPull()) return;
      startY = e.touches[0].clientY;
      currentPull = 0;
      isPulling = true;
    },
    { passive: true }
  );

  window.addEventListener(
    'touchmove',
    (e) => {
      if (!isPulling || e.touches.length > 1) return;
      const deltaY = e.touches[0].clientY - startY;
      if (deltaY <= 8) {
        if (currentPull > 0) {
          currentPull = 0;
          applyTrackTransform(0);
        }
        return;
      }
      if (window.scrollY > 0) {
        isPulling = false;
        resetPosition();
        return;
      }
      currentPull = Math.min(MAX_PULL_PX, (deltaY - 8) * DAMPING);
      applyTrackTransform(currentPull);
    },
    { passive: true }
  );

  window.addEventListener('touchend', async () => {
    if (!isPulling) return;
    isPulling = false;

    if (currentPull >= THRESHOLD_PX) {
      isRefreshing = true;
      indicatorEl.classList.add('refreshing');
      labelEl.textContent = 'Refreshing…';
      mainEl.style.transition = 'transform 200ms var(--ease-drawer)';
      indicatorEl.style.transition = 'transform 200ms var(--ease-drawer), opacity 180ms var(--ease-out)';
      mainEl.style.transform = 'translate3d(0, 52px, 0)';
      indicatorEl.style.transform = 'translate3d(-50%, 10px, 0)';
      indicatorEl.style.opacity = '1';

      try {
        await fetchDashboard();
        if (state.activeView === 'history') {
          await loadActivityPage({ reset: true });
        }
      } catch {
        // errors handled by fetchDashboard/loadActivityPage
      } finally {
        isRefreshing = false;
        currentPull = 0;
        resetPosition();
      }
    } else {
      currentPull = 0;
      resetPosition();
    }
  });

  window.addEventListener('touchcancel', () => {
    if (!isPulling) return;
    isPulling = false;
    currentPull = 0;
    resetPosition();
  });
}
