import { Router } from 'express';
import { z } from 'zod';
import { badRequest, HttpError, zodDetails } from '../lib/errors.js';
import { normalizeBarcode } from '../lib/itemSchema.js';
import { buildScanIndex, matchItems, MAX_TEXT } from '../lib/scanMatch.js';
import { createWindowLimiter } from '../lib/windowLimiter.js';
import { rowToItem } from '../services/items.js';

const scanSchema = z
  .object({
    // Long OCR output is cut to MAX_TEXT characters instead of being rejected.
    text: z.string().optional().transform((t) => (t === undefined ? t : t.slice(0, MAX_TEXT))),
    barcode: z.preprocess(normalizeBarcode, z.string().max(64, 'barcode must be at most 64 characters').nullable().optional()),
  })
  .refine((b) => (b.text && b.text.trim()) || b.barcode, { message: 'Send "text" and/or "barcode"' });

/**
 * POST /api/scan/match — public (no PIN), throttled per client IP (default 30 per minute).
 * The scoring index over all items is cached and rebuilt only when the database changed
 * (SQLite total_changes() for this connection + data_version for other connections).
 */
export function scanRouter(db, { perMinute = 30, limiter = createWindowLimiter({ limit: perMinute }) } = {}) {
  const router = Router();
  const all = db.prepare('SELECT * FROM items');
  const stamp = db.prepare('SELECT total_changes() AS c');
  let cache = { key: null, index: null };
  const currentIndex = () => {
    const key = `${stamp.get().c}:${db.pragma('data_version', { simple: true })}`;
    if (cache.key !== key) cache = { key, index: buildScanIndex(all.all().map(rowToItem)) };
    return cache.index;
  };

  router.post('/match', (req, res) => {
    const gate = limiter.hit(req.ip || req.socket?.remoteAddress || 'unknown');
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      throw new HttpError(429, 'Too many scans from this phone. Wait a moment and try again.', { retryAfterSeconds: gate.retryAfterSec });
    }
    const parsed = scanSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid scan request', zodDetails(parsed.error));
    res.json(matchItems(currentIndex(), { text: parsed.data.text ?? '', barcode: parsed.data.barcode ?? null }));
  });
  return router;
}
