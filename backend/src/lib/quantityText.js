/**
 * Quantity cells from the real inventory (pure): a number, or text such as "a box", "1 box",
 * "2 box(24)", "3 small box", "2 pack", "5 pcs", "1,200".
 *   -> { ok: true, quantity, unit?, note? }  (note: "Excel quantity: 2 box(24)" when a bracket was dropped)
 *   -> { ok: false }                         (cannot read a whole number >= 0)
 */
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)`;
const UNIT = String.raw`([A-Za-z][A-Za-z\s.]*?)`;
const ONE_RE = new RegExp(String.raw`^(?:a|an|one|satu)\s+${UNIT}\s*(\(.*\))?$`, 'i');
const NUM_RE = new RegExp(String.raw`^${NUMBER}(?:\s*${UNIT})?\s*(\(.*\))?$`);

export function parseQuantityText(v) {
  if (v === null || v === undefined) return { ok: false };
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? { ok: true, quantity: v } : { ok: false };
  const raw = String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  if (raw === '') return { ok: false };
  let quantity;
  let unit;
  let bracket;
  let m = NUM_RE.exec(raw);
  if (m) {
    quantity = Number(m[1].replace(/,/g, ''));
    unit = m[2];
    bracket = m[3];
  } else if ((m = ONE_RE.exec(raw))) {
    quantity = 1;
    unit = m[1];
    bracket = m[2];
  } else {
    return { ok: false };
  }
  if (!Number.isSafeInteger(quantity)) return { ok: false };
  const out = { ok: true, quantity };
  if (unit && unit.trim()) out.unit = unit.trim().toLowerCase();
  if (bracket) out.note = `Excel quantity: ${raw}`;
  return out;
}
