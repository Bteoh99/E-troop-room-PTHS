/**
 * Turn spreadsheet rows into validated item patches (pure, no DB).
 *
 * Input rows: [{ rowNumber, cells: unknown[] }] as read from the sheet (rowNumber = 1-based sheet row).
 * Output: { headerRow, mapping, ignoredColumns, records: [{ row, data }], errors: [{ row, message }], skipped }
 *
 * `data` only contains fields that have a non-blank value in this row. A blank cell therefore
 * leaves an existing item's value unchanged (and a new item gets the default), for every field.
 */
import { findHeaderRow, REQUIRED_FIELDS, HEADER_ALIASES } from './headers.js';
import { parseLocation, combineLocation } from './location.js';
import { mapCondition } from './condition.js';
import { updateItemSchema, LIMITS } from './itemSchema.js';
import { badRequest } from './errors.js';

/** Excel cell value (number/string/Date/boolean/null) -> trimmed string. */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).replace(/ /g, ' ').trim();
}

const isBlankRow = (cells) => cells.every((c) => cellText(c) === '');

/** "10", 10, "10 pcs", "5pcs", "1,000" -> { quantity, unit? } or null if not a whole number >= 0. */
export function parseQuantity(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? { quantity: v } : null;
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\s*([A-Za-z][A-Za-z\s.]*))?$/.exec(cellText(v));
  if (!m) return null;
  const quantity = Number(m[1].replace(/,/g, ''));
  if (!Number.isSafeInteger(quantity)) return null;
  return { quantity, ...(m[2] ? { unit: m[2].trim() } : {}) };
}

/**
 * @param {{ rowNumber: number, cells: unknown[] }[]} rows
 */
export function buildImportPlan(rows) {
  const header = findHeaderRow(rows.map((r) => r.cells));
  const missing = header ? REQUIRED_FIELDS.filter((f) => !(f in header.mapping)) : REQUIRED_FIELDS;
  if (!header || missing.length) {
    const shown = header ? rows[header.headerIndex] : rows.find((r) => !isBlankRow(r.cells));
    throw badRequest(
      `Could not find the required column(s): ${missing.join(', ')}. ` +
        `Expected a header row with e.g. "Code" / "Kod" and "Name" / "Nama".`,
      {
        missingColumns: missing,
        headersFound: shown ? shown.cells.map(cellText).filter(Boolean) : [],
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
    const text = (f) => (has(f) ? cellText(cells[mapping[f]]) : '');
    const warnings = [];
    const data = {};

    const code = text('code');
    const name = text('name');
    if (!code || !name) {
      const what = [!code && 'code', !name && 'name'].filter(Boolean).join(' and ');
      errors.push({ row: rowNumber, message: `Missing ${what}; row skipped` });
      skipped++;
      continue;
    }
    data.code = code;
    data.name = name;

    // Blank cell = not given: existing value kept, new item gets the default.
    for (const f of ['category', 'notes', 'unit']) {
      const v = text(f);
      if (v) data[f] = v;
    }

    // Location: a filled location column wins; otherwise combine rack / shelf / bin columns.
    const locText = text('location');
    let loc = null;
    if (locText) loc = parseLocation(locText);
    else {
      const [rack, shelf, bin] = [text('rack'), text('shelf'), text('bin')];
      if (rack) loc = combineLocation(rack, shelf, bin);
      // A shelf/bin without a rack isn't a usable coordinate; keep it as text.
      else if (shelf || bin) loc = parseLocation([shelf, bin].filter(Boolean).join('-'));
    }
    if (loc?.locationCode) {
      if (loc.locationCode.length > LIMITS.locationCode) {
        warnings.push(
          `Warning: location is longer than ${LIMITS.locationCode} characters; location left unchanged (empty for new items)`
        );
      } else {
        data.locationCode = loc.locationCode;
        if (!loc.rack) {
          warnings.push(`Warning: location "${loc.locationCode}" is not a rack coordinate like R03-B-2; kept as-is`);
        }
      }
    }

    const qtyText = text('quantity');
    if (qtyText) {
      const q = parseQuantity(cells[mapping.quantity]);
      if (q) {
        data.quantity = q.quantity;
        if (q.unit && !data.unit) data.unit = q.unit;
      } else {
        warnings.push(`Warning: quantity "${qtyText}" is not a whole number; quantity left unchanged (new items get 1)`);
      }
    }

    const condText = text('condition');
    if (condText) {
      const { condition, recognized } = mapCondition(condText);
      // Unknown text is treated like a bad quantity: existing items keep their condition,
      // new items get the default (good).
      if (recognized) data.condition = condition;
      else warnings.push(`Warning: unknown condition "${condText}"; existing item keeps its condition, new item gets good`);
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

  return {
    headerRow: headerRowNumber,
    mapping,
    ignoredColumns: header.ignored,
    unmappedHeaders: header.unmapped,
    records,
    errors,
    skipped,
  };
}
