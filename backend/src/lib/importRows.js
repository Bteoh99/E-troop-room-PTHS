/**
 * Turn spreadsheet rows into validated item patches (pure, no DB).
 *
 * Input rows: [{ rowNumber, cells: unknown[] }] as read from the sheet (rowNumber = 1-based sheet row).
 * Output: { mapping, headerRow, records: [{ row, data, warnings }], errors: [{ row, message }], skipped }
 * `data` only contains fields whose column exists in the file, so an upsert leaves other fields untouched.
 */
import { findHeaderRow, REQUIRED_FIELDS, HEADER_ALIASES } from './headers.js';
import { parseLocation, combineLocation } from './location.js';
import { mapCondition } from './condition.js';
import { updateItemSchema } from './itemSchema.js';
import { badRequest } from './errors.js';

/** Excel cell value (number/string/Date/boolean/null) -> trimmed string. */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).replace(/ /g, ' ').trim();
}

const isBlankRow = (cells) => cells.every((c) => cellText(c) === '');

/** "10", 10, "10 pcs", "1,000" -> { quantity, unit? } or null if not a whole number >= 0. */
export function parseQuantity(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? { quantity: v } : null;
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\s*([A-Za-z][\w\s.]*))?$/.exec(cellText(v));
  if (!m) return null;
  const quantity = Number(m[1].replace(/,/g, ''));
  return { quantity, ...(m[2] ? { unit: m[2].trim() } : {}) };
}

/**
 * @param {{ rowNumber: number, cells: unknown[] }[]} rows
 */
export function buildImportPlan(rows) {
  const header = findHeaderRow(rows.map((r) => r.cells));
  const missing = header ? REQUIRED_FIELDS.filter((f) => !(f in header.mapping)) : REQUIRED_FIELDS;
  if (!header || missing.length) {
    const firstRow = rows.find((r) => !isBlankRow(r.cells));
    throw badRequest(
      `Could not find the required column(s): ${missing.join(', ')}. ` +
        `Expected a header row with e.g. "Code" / "Kod" and "Name" / "Nama".`,
      {
        missingColumns: missing,
        headersFound: firstRow ? firstRow.cells.map(cellText).filter(Boolean) : [],
        acceptedHeaders: HEADER_ALIASES,
      }
    );
  }

  const { mapping } = header;
  const headerRowNumber = rows[header.headerIndex].rowNumber;
  const has = (f) => f in mapping;
  const records = [];
  const errors = [];
  let skipped = 0;

  for (const { rowNumber, cells } of rows.slice(header.headerIndex + 1)) {
    if (isBlankRow(cells)) continue;
    const get = (f) => (has(f) ? cells[mapping[f]] : undefined);
    const warnings = [];
    const data = {};

    const code = cellText(get('code'));
    const name = cellText(get('name'));
    if (!code || !name) {
      const what = [!code && 'code', !name && 'name'].filter(Boolean).join(' and ');
      errors.push({ row: rowNumber, message: `Missing ${what}; row skipped` });
      skipped++;
      continue;
    }
    data.code = code;
    data.name = name;

    if (has('category')) data.category = cellText(get('category'));
    if (has('notes')) data.notes = cellText(get('notes'));
    if (has('unit')) {
      const unit = cellText(get('unit'));
      if (unit) data.unit = unit;
    }

    // Location: a location column wins; otherwise combine rack / shelf / bin columns.
    const locText = cellText(get('location'));
    let loc = null;
    if (locText) loc = parseLocation(locText);
    else if (has('rack') || has('shelf') || has('bin')) {
      const rackText = cellText(get('rack'));
      // A shelf/bin without a rack isn't a usable coordinate; keep it as text.
      loc = rackText
        ? combineLocation(rackText, cellText(get('shelf')), cellText(get('bin')))
        : parseLocation([get('shelf'), get('bin')].map(cellText).filter(Boolean).join('-'));
    }
    if (loc || has('location')) {
      data.locationCode = loc?.locationCode ?? null;
      if (loc?.locationCode && !loc.rack) {
        warnings.push(`Warning: location "${loc.locationCode}" is not a rack coordinate like R03-B-2; kept as-is`);
      }
    }

    if (has('quantity')) {
      const raw = get('quantity');
      if (cellText(raw) !== '') {
        const q = parseQuantity(raw);
        if (q) {
          data.quantity = q.quantity;
          if (q.unit && !data.unit) data.unit = q.unit;
        } else {
          warnings.push(`Warning: quantity "${cellText(raw)}" is not a whole number; quantity left unchanged (new items get 1)`);
        }
      }
    }

    if (has('condition')) {
      const raw = cellText(get('condition'));
      const { condition, recognized } = mapCondition(raw);
      data.condition = condition;
      if (!recognized) warnings.push(`Warning: unknown condition "${raw}"; imported as good`);
    }

    const parsed = updateItemSchema.safeParse(data);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      errors.push({ row: rowNumber, message: `${msg}; row skipped` });
      skipped++;
      continue;
    }
    for (const w of warnings) errors.push({ row: rowNumber, message: w });
    records.push({ row: rowNumber, data: parsed.data });
  }

  return { headerRow: headerRowNumber, mapping, unmappedHeaders: header.unmapped, records, errors, skipped };
}
