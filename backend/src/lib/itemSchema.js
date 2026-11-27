/**
 * Zod schemas for item input (API body and import rows).
 * Unknown keys (id, rack, shelf, bin, createdAt, ...) are stripped, so the frontend may
 * send a whole Item back on PUT. rack/shelf/bin are always derived from locationCode.
 */
import { z } from 'zod';
import { CONDITIONS } from './condition.js';

export const LIMITS = {
  code: 50, name: 200, category: 100, locationCode: 100, unit: 30, notes: 2000, quantity: 1_000_000,
  brand: 100, model: 100, barcode: 64,
};

/**
 * "9 312345 678901" -> "9312345678901": whitespace removed, ASCII letters upper-cased, '' -> null.
 * Anything that is not a string (e.g. a JSON number, which may already have lost digits) is left
 * as-is so validation rejects it.
 */
export function normalizeBarcode(v) {
  if (typeof v !== 'string') return v;
  const t = v.replace(/\s+/g, '').replace(/[a-z]/g, (c) => c.toUpperCase());
  return t === '' ? null : t;
}

/** numbers -> strings, trim strings; leave everything else for zod to reject. */
const asText = (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : v);
/** null/undefined -> '' so "required" gives a friendly message instead of a type error. */
const asRequiredText = (v) => (v === null || v === undefined ? '' : asText(v));
/** '' / null -> null */
const asNullableText = (v) => {
  const t = asText(v);
  return t === '' || t === null ? null : t;
};

const fields = {
  code: z.preprocess(
    asRequiredText,
    z.string().min(1, 'Code is required').max(LIMITS.code, `Code must be at most ${LIMITS.code} characters`)
      .transform((s) => s.toUpperCase())
  ),
  name: z.preprocess(
    asRequiredText,
    z.string().min(1, 'Name is required').max(LIMITS.name, `Name must be at most ${LIMITS.name} characters`)
  ),
  category: z.preprocess(asNullableText, z.string().max(LIMITS.category).nullable()),
  locationCode: z.preprocess(asNullableText, z.string().max(LIMITS.locationCode).nullable()),
  brand: z.preprocess(asNullableText, z.string().max(LIMITS.brand, `Brand must be at most ${LIMITS.brand} characters`).nullable()),
  model: z.preprocess(asNullableText, z.string().max(LIMITS.model, `Model must be at most ${LIMITS.model} characters`).nullable()),
  barcode: z.preprocess(
    normalizeBarcode,
    z.string({ error: 'Barcode must be text (put it in quotes), not a number' })
      .max(LIMITS.barcode, `Barcode must be at most ${LIMITS.barcode} characters`)
      .regex(/^[A-Z0-9]+$/, 'Barcode may only contain the letters A-Z and digits 0-9')
      .nullable()
  ),
  quantity: z.preprocess(
    // Only plain digit strings are coerced ("0x10", "1e3" stay strings and fail).
    (v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
    z.number({ error: 'Quantity must be a number' })
      .int('Quantity must be a whole number')
      .min(0, 'Quantity cannot be negative')
      .max(LIMITS.quantity, 'Quantity is too large')
  ),
  unit: z.preprocess((v) => {
    const t = asNullableText(v);
    return t === null ? 'pcs' : t;
  }, z.string().max(LIMITS.unit)),
  condition: z.enum(CONDITIONS, { error: `Condition must be one of: ${CONDITIONS.join(', ')}` }),
  notes: z.preprocess((v) => (v === null ? '' : asText(v)), z.string().max(LIMITS.notes)),
};

/** POST body: code + name required, the rest defaulted. */
export const createItemSchema = z.object({
  code: fields.code,
  name: fields.name,
  category: fields.category.optional().transform((v) => v ?? null),
  locationCode: fields.locationCode.optional().transform((v) => v ?? null),
  brand: fields.brand.optional().transform((v) => v ?? null),
  model: fields.model.optional().transform((v) => v ?? null),
  barcode: fields.barcode.optional().transform((v) => v ?? null),
  quantity: fields.quantity.optional().transform((v) => v ?? 1),
  unit: fields.unit.optional().transform((v) => v ?? 'pcs'),
  condition: fields.condition.optional().transform((v) => v ?? 'good'),
  notes: fields.notes.optional().transform((v) => v ?? ''),
});

/** PUT body: any subset of fields; absent keys are left unchanged. */
export const updateItemSchema = z.object(
  Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, s.optional()]))
);

export const idParamSchema = z
  .string()
  .regex(/^\d{1,15}$/, 'Item id must be a positive whole number')
  .transform(Number)
  .refine((n) => n > 0, 'Item id must be a positive whole number');

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(LIMITS.category).optional(),
  rack: z.string().trim().max(20).optional(),
  condition: z.union([z.literal(''), z.enum(CONDITIONS)], {
    error: `condition must be one of: ${CONDITIONS.join(', ')}`,
  }).optional(),
  unlocated: z.enum(['true', 'false', '1', '0', ''], { error: 'unlocated must be true or false' })
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});
