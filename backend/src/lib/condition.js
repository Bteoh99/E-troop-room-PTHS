/**
 * Condition text mapping (pure). Accepts English and Malay variants.
 */

export const CONDITIONS = /** @type {const} */ (['good', 'needs_repair', 'damaged', 'written_off']);
export const DEFAULT_CONDITION = 'good';

const ALIASES = {
  good: ['good', 'baik', 'ok', 'okay', 'elok', 'new', 'baru', 'fine', 'working', 'usable', 'boleh guna'],
  needs_repair: [
    'needs repair', 'need repair', 'needs_repair', 'repair', 'to repair', 'requires repair',
    'rosak sikit', 'rosak sedikit', 'perlu baiki', 'perlu dibaiki', 'baiki', 'fair', 'worn',
  ],
  damaged: ['damaged', 'damage', 'rosak', 'broken', 'bad', 'rusak', 'teruk', 'rosak teruk'],
  written_off: [
    'written off', 'written_off', 'write off', 'writeoff', 'written-off', 'lupus', 'dilupuskan',
    'disposed', 'lost', 'hilang',
  ],
};

const LOOKUP = new Map();
for (const [value, words] of Object.entries(ALIASES)) {
  for (const w of words) LOOKUP.set(normalizeConditionText(w), value);
}

function normalizeConditionText(s) {
  return String(s).toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {unknown} input
 * @returns {{ condition: string, recognized: boolean }}
 *   Blank -> good (recognized). Unknown text -> good (recognized: false) so the caller can warn.
 */
export function mapCondition(input) {
  if (input === null || input === undefined) return { condition: DEFAULT_CONDITION, recognized: true };
  const key = normalizeConditionText(input);
  if (key === '') return { condition: DEFAULT_CONDITION, recognized: true };
  const value = LOOKUP.get(key);
  return value ? { condition: value, recognized: true } : { condition: DEFAULT_CONDITION, recognized: false };
}
