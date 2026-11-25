/**
 * Zod schemas for item input (API body and import rows).
 * Unknown keys (id, rack, shelf, bin, createdAt, ...) are stripped, so the frontend may
 * send a whole Item back on PUT. rack/shelf/bin are always derived from locationCode.
 */
import { z } from 'zod';
import { CONDITIONS } from './condition.js';

export const LIMITS = { code: 50, name: 200, category: 100, locationCode: 100, unit: 30, notes: 2000, quantity: 1_000_000 };

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
  quantity: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v),
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
  quantity: fields.quantity.optional().transform((v) => v ?? 1),
  unit: fields.unit.optional().transform((v) => v ?? 'pcs'),
  condition: fields.condition.optional().transform((v) => v ?? 'good'),
  notes: fields.notes.optional().transform((v) => v ?? ''),
});

/** PUT body: any subset of fields; absent keys are left unchanged. */
export const updateItemSchema = z.object(
  Object.fromEntries(Object.entries(fields).map(([k, s]) => [k, s.optional()]))
);

export const idParamSchema = z.coerce.number().int().positive();

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(LIMITS.category).optional(),
  rack: z.string().trim().max(20).optional(),
  condition: z.union([z.literal(''), z.enum(CONDITIONS)], {
    error: `condition must be one of: ${CONDITIONS.join(', ')}`,
  }).optional(),
});
