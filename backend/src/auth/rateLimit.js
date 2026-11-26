/**
 * Wrong-PIN limiter (in memory): 5 wrong tries from one IP -> that IP is blocked for 5 minutes;
 * 20 wrong tries from anywhere within 5 minutes -> everyone is blocked for 5 minutes.
 * A correct PIN clears that IP's count. `now` is injectable for tests.
 */
export function createLoginLimiter({ perIp = 5, global = 20, windowMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const ipFails = new Map(); // ip -> { times: number[], blockedUntil: number }
  let globalTimes = [];
  let globalBlockedUntil = 0;

  const prune = (times, t) => times.filter((x) => t - x < windowMs);

  return {
    /** @returns {{ blocked: boolean, retryAfterSec: number }} */
    check(ip) {
      const t = now();
      const until = Math.max(ipFails.get(ip)?.blockedUntil ?? 0, globalBlockedUntil);
      return until > t ? { blocked: true, retryAfterSec: Math.ceil((until - t) / 1000) } : { blocked: false, retryAfterSec: 0 };
    },
    fail(ip) {
      const t = now();
      const rec = ipFails.get(ip) ?? { times: [], blockedUntil: 0 };
      rec.times = prune(rec.times, t);
      rec.times.push(t);
      if (rec.times.length >= perIp) {
        rec.blockedUntil = t + windowMs;
        rec.times = [];
      }
      ipFails.set(ip, rec);
      globalTimes = prune(globalTimes, t);
      globalTimes.push(t);
      if (globalTimes.length >= global) {
        globalBlockedUntil = t + windowMs;
        globalTimes = [];
      }
      if (ipFails.size > 10_000) {
        for (const [k, v] of ipFails) if (v.blockedUntil <= t && prune(v.times, t).length === 0) ipFails.delete(k);
      }
    },
    success(ip) {
      ipFails.delete(ip);
    },
  };
}
