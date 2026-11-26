import { Router } from 'express';
import { z } from 'zod';
import { badRequest, zodDetails } from '../lib/errors.js';
import { normalizeBarcode } from '../lib/itemSchema.js';
import { matchItems } from '../lib/scanMatch.js';
import { rowToItem } from '../services/items.js';

const scanSchema = z
  .object({
    text: z.string().max(2000, 'text must be at most 2000 characters').optional(),
    barcode: z.preprocess(normalizeBarcode, z.string().max(64, 'barcode must be at most 64 characters').nullable().optional()),
  })
  .refine((b) => (b.text && b.text.trim()) || b.barcode, { message: 'Send "text" and/or "barcode"' });

/** POST /api/scan/match — public (no PIN). */
export function scanRouter(db) {
  const router = Router();
  const all = db.prepare('SELECT * FROM items');
  router.post('/match', (req, res) => {
    const parsed = scanSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Invalid scan request', zodDetails(parsed.error));
    const items = all.all().map(rowToItem);
    res.json(matchItems(items, { text: parsed.data.text ?? '', barcode: parsed.data.barcode ?? null }));
  });
  return router;
}
