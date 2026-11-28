export function getClientIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req?.socket?.remoteAddress || '127.0.0.1';
}

export function createRateLimiter({
  windowMs = 15 * 60 * 1000,
  maxAttempts = 5,
  maxEntries = 10000,
  nowFn = () => Date.now(),
} = {}) {
  const store = new Map();

  function pruneExpired(now) {
    if (store.size < maxEntries) return;
    for (const [k, entry] of store.entries()) {
      if (now >= entry.resetAt) {
        store.delete(k);
      }
    }
    // If still over cap, evict oldest entries
    while (store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  }

  function getActiveEntry(key, now) {
    const entry = store.get(key);
    if (!entry) return null;
    if (now >= entry.resetAt) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  function check(key) {
    const now = nowFn();
    const entry = getActiveEntry(key, now);
    if (!entry) {
      return { allowed: true, remaining: maxAttempts, retryAfterSeconds: 0 };
    }
    if (entry.count >= maxAttempts) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    return {
      allowed: true,
      remaining: Math.max(0, maxAttempts - entry.count),
      retryAfterSeconds: 0,
    };
  }

  function recordFailure(key) {
    const now = nowFn();
    pruneExpired(now);
    const entry = getActiveEntry(key, now);
    if (!entry) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  function reset(key) {
    store.delete(key);
  }

  return { check, recordFailure, reset };
}
