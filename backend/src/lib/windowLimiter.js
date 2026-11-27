/**
 * Fixed-size sliding-window request limiter per key (e.g. client IP), in memory.
 * `hit(key)` -> { ok: true } or { ok: false, retryAfterSec }.
 */
export function createWindowLimiter({ limit = 30, windowMs = 60_000, now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const hits = new Map(); // key -> timestamps (oldest first)
  return {
    hit(key) {
      const t = now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)) };
      }
      list.push(t);
      hits.set(key, list);
      if (hits.size > maxKeys) {
        for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] >= windowMs) hits.delete(k);
      }
      return { ok: true };
    },
  };
}
