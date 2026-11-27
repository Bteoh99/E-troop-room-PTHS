/**
 * Wrong-PIN limiter (in memory). Every check is RESERVED before the slow scrypt verification starts,
 * so parallel requests cannot slip past the limits:
 * - per IP: at most 1 PIN check in flight; 5 wrong tries within 5 minutes -> that IP is blocked for 5 minutes
 *   (pending checks count against the 5, so a burst of 200 requests gets at most 5 checks).
 * - globally: at most 2 checks in flight, and a slowdown instead of a lock-out: a token bucket of
 *   10 wrong tries that refills at 1 per second. When it is empty everyone waits ~1 second (429 with a
 *   short Retry-After), so one person cannot lock every leader out for minutes.
 * A correct PIN clears that IP's count and gives its bucket token back. `now` is injectable for tests.
 */
export function createLoginLimiter({
  perIp = 5,
  windowMs = 5 * 60 * 1000,
  maxInFlightPerIp = 1,
  maxInFlight = 2,
  globalBurst = 10,
  globalPerSecond = 1,
  now = () => Date.now(),
} = {}) {
  const ips = new Map(); // ip -> { times: number[], blockedUntil: number, inFlight: number }
  let inFlight = 0;
  let tokens = globalBurst;
  let refilledAt = now();

  const rec = (ip) => {
    let r = ips.get(ip);
    if (!r) ips.set(ip, (r = { times: [], blockedUntil: 0, inFlight: 0 }));
    return r;
  };
  const refill = (t) => {
    tokens = Math.min(globalBurst, tokens + ((t - refilledAt) / 1000) * globalPerSecond);
    refilledAt = t;
  };
  const deny = (reason, ms) => ({ ok: false, reason, retryAfterSec: Math.max(1, Math.ceil(ms / 1000)) });

  return {
    /**
     * Reserve one PIN check. Returns { ok: false, reason: 'blocked'|'busy'|'slow', retryAfterSec }
     * or { ok: true, done(outcome) } where outcome is 'ok' | 'fail' | 'neutral' (not a PIN check after all).
     */
    begin(ip) {
      const t = now();
      const r = rec(ip);
      if (r.blockedUntil > t) return deny('blocked', r.blockedUntil - t);
      r.times = r.times.filter((x) => t - x < windowMs);
      if (r.inFlight >= maxInFlightPerIp || r.times.length + r.inFlight >= perIp || inFlight >= maxInFlight) {
        return deny('busy', 1000);
      }
      refill(t);
      if (tokens < 1) return deny('slow', ((1 - tokens) / globalPerSecond) * 1000);
      tokens -= 1;
      r.inFlight++;
      inFlight++;
      let finished = false;
      return {
        ok: true,
        done(outcome) {
          if (finished) return;
          finished = true;
          r.inFlight--;
          inFlight--;
          const t2 = now();
          if (outcome === 'fail') {
            r.times = r.times.filter((x) => t2 - x < windowMs);
            r.times.push(t2);
            if (r.times.length >= perIp) {
              r.blockedUntil = t2 + windowMs;
              r.times = [];
            }
          } else {
            refill(t2);
            tokens = Math.min(globalBurst, tokens + 1); // only wrong tries use up the global budget
            if (outcome === 'ok') {
              r.times = [];
            }
          }
          if (ips.size > 10_000) {
            for (const [k, v] of ips) if (!v.inFlight && v.blockedUntil <= t2 && !v.times.some((x) => t2 - x < windowMs)) ips.delete(k);
          }
        },
      };
    },
  };
}
