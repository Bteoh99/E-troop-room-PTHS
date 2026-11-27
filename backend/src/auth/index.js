/**
 * Leader PIN auth: POST /api/auth/login, GET /api/auth/status, and `requireLeader` for writes.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, HttpError, zodDetails } from '../lib/errors.js';
import { createConfigSource, resolveConfigPath, verifyPin } from './config.js';
import { createLoginLimiter } from './rateLimit.js';
import { signToken, verifyToken } from './tokens.js';

export const PIN_NOT_SET_MESSAGE = 'Leader PIN not set. Run set-pin on the laptop.';
export const CONFIG_DAMAGED_MESSAGE = 'Leader settings file is damaged. Run set-pin on the laptop to repair it (it asks for a new PIN).';

const loginSchema = z.object({
  pin: z.union([z.string().max(32), z.number().int().nonnegative()], { error: 'pin is required' }).transform(String),
});

function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * @param {{ configPath?: string, limiter?: ReturnType<typeof createLoginLimiter> }} [opts]
 * Damaged config.json -> 503 on writes, login and status (never "PIN not set").
 */
export function createAuth({ configPath, limiter = createLoginLimiter() } = {}) {
  const getConfig = createConfigSource(resolveConfigPath(configPath));
  const pinSet = (cfg) => Boolean(cfg.pin && cfg.tokenSecret);

  function leaderStatus(req) {
    const cfg = getConfig();
    if (!pinSet(cfg)) return { cfg, ok: false, reason: 'no-pin' };
    const token = bearer(req);
    if (!token) return { cfg, ok: false, reason: 'missing' };
    const v = verifyToken(cfg.tokenSecret, token);
    return { cfg, ok: v.ok, reason: v.ok ? null : v.reason };
  }

  /** Middleware: 403 when no PIN is set up yet, 401 without a valid leader token. */
  function requireLeader(req, res, next) {
    const s = leaderStatus(req);
    if (s.ok) return next();
    if (s.cfg.broken) return next(new HttpError(503, CONFIG_DAMAGED_MESSAGE));
    if (s.reason === 'no-pin') return next(new HttpError(403, PIN_NOT_SET_MESSAGE));
    const message = s.reason === 'expired'
      ? 'Leader session expired. Enter the leader PIN again.'
      : 'Leader PIN required. Unlock leader mode first.';
    res.setHeader('WWW-Authenticate', 'Bearer');
    next(new HttpError(401, message));
  }

  const router = Router();
  router.get('/status', (req, res) => {
    const s = leaderStatus(req);
    if (s.cfg.broken) throw new HttpError(503, CONFIG_DAMAGED_MESSAGE);
    res.json({ pinSet: pinSet(s.cfg), leader: s.ok });
  });

  router.post('/login', asyncHandler(async (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const cfg = getConfig();
    if (cfg.broken) throw new HttpError(503, CONFIG_DAMAGED_MESSAGE);
    if (!pinSet(cfg)) throw new HttpError(403, PIN_NOT_SET_MESSAGE);
    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Send the PIN as { "pin": "1234" }', zodDetails(parsed.error));

    // Reserve the attempt BEFORE the slow scrypt check, so parallel requests can't get past the limits.
    const gate = limiter.begin(ip);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      const message = gate.reason === 'blocked'
        ? 'Too many wrong PIN attempts. Wait 5 minutes and try again.'
        : 'Too many PIN attempts at once. Wait a moment and try again.';
      throw new HttpError(429, message, { retryAfterSeconds: gate.retryAfterSec });
    }
    let outcome = 'neutral';
    try {
      const ok = /^\d{4,8}$/.test(parsed.data.pin) && (await verifyPin(parsed.data.pin, cfg.pin));
      outcome = ok ? 'ok' : 'fail';
    } finally {
      gate.done(outcome);
    }
    if (outcome !== 'ok') throw new HttpError(401, 'Wrong PIN.');
    res.json(signToken(cfg.tokenSecret));
  }));

  return { router, requireLeader, getConfig };
}
