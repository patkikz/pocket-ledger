const CACHE_NAME = 'pocketledger-shell-v5';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/js/state.js',
  '/js/auth.js',
  '/js/dashboard.js',
  '/js/quick-entry.js',
  '/js/accounts.js',
  '/js/budgets.js',
  '/js/activity.js',
  '/js/settings.js',
  '/js/profile.js',
  '/js/realtime.js',
  '/js/pull-to-refresh.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  // Strictly bypass all API endpoints so auth, balances, and ledger mutations always hit the network.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const clone = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {})
          );
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
