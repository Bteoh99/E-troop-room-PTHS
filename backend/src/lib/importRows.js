/**
 * Turn spreadsheet rows into validated item patches (pure, no DB).
 *
 * Input rows: [{ rowNumber, cells: unknown[] }] as read from the sheet (rowNumber = 1-based sheet row).
 * Output: {
 *   headerRow, mapping, ignoredColumns, codeIsLocation,
 *   records: [{ row, data, key, createDefaults, notesAppend, countsGiven, quantityMissing }],  // data: fields this row sets
 *   emptyCompartments: [{ row, code }], sections, corrections: [{ row, field, from, to }],
 *   errors: [{ row, message }], skipped }
 *
 * The troop's real file (Phase 1.6): the CODE column holds LOCATIONS ("AU0305"), "RACK AU" rows are
 * section headers, a code without a description is an empty compartment, quantities may be text
 * ("a box", "2 box(24)"), and GOOD/BAD columns are counts. Blank cells never change an existing item.
 */
import { findHeaderRow, REQUIRED_FIELDS, HEADER_ALIASES } from './headers.js';
import { parseLocation, combineLocation, isCompartmentCode } from './location.js';
import { mapCondition } from './condition.js';
import { updateItemSchema, LIMITS, normalizeBarcode } from './itemSchema.js';
import { cleanCell } from './corrections.js';
import { parseQuantityText } from './quantityText.js';
import { badRequest } from './errors.js';

/** Excel cell value (number/string/Date/boolean/null) -> trimmed string. */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  return String(v).replace(/ /g, ' ').trim();
}

const isBlankRow = (cells) => cells.every((c) => cellText(c) === '');

/** "10", 10, "10 pcs", "5pcs", "1,000", "a box", "2 box(24)" -> { quantity, unit?, note? } or null. */
export function parseQuantity(v) {
  const r = parseQuantityText(v);
  if (!r.ok) return null;
  const { ok, ...rest } = r;
  return rest;
}

/** "RACK AU" / "Rak AX" alone on a row: a section header, not an item. */
export const SECTION_RE = /^(?:RACK|RAK)\s+[A-Z]{1,3}$/i;
/** Compact v2 location as found in the real CODE column ("AU0305", "ax0304", "AU 0305"). */
const COMPACT_V2_RE = /^[A-Z]{1,3} ?\d{4}$/i;

export const foldName = (name) => String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function isSectionRow(cells) {
  const filled = cells.map(cellText).filter(Boolean);
  return filled.length === 1 && SECTION_RE.test(filled[0].replace(/\s+/g, ' '));
}

/**
 * The CODE column is really a location column when the file has no location columns and at least
 * 80% of the non-empty codes (section rows excluded) are compact v2 locations.
 */
export function codeColumnIsLocation(rows, mapping) {
  if (!('code' in mapping) || 'location' in mapping || 'rack' in mapping) return false;
  let total = 0;
  let v2 = 0;
  for (const { cells } of rows) {
    if (isSectionRow(cells)) continue;
    const t = cellText(cells[mapping.code]);
    if (!t) continue;
    total++;
    if (COMPACT_V2_RE.test(t) && isCompartmentCode(parseLocation(t))) v2++;
  }
  return total > 0 && v2 / total >= 0.8;
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
        `Expected a header row with e.g. "Item description" / "Name" / "Nama".`,
      {
        missingColumns: missing,
        headersFound: shown ? shown.cells.map(cellText).filter(Boolean) : [],
        acceptedHeaders: HEADER_ALIASES,
      }
    );
  }

  const mapping = { ...header.mapping };
  const dataRows = rows.slice(header.headerIndex + 1);
  const codeIsLocation = codeColumnIsLocation(dataRows, mapping);
  if (codeIsLocation) {
    mapping.location = mapping.code;
    delete mapping.code;
  }
  const headerRowNumber = rows[header.headerIndex].rowNumber;
  const has = (f) => f in mapping;
  const records = [];
  const errors = [];
  const corrections = [];
  const emptyCompartments = [];
  let sections = 0;
  let skipped = 0;

  for (const { rowNumber, cells } of dataRows) {
    if (isBlankRow(cells)) continue;
    if (isSectionRow(cells)) {
      sections++;
      continue;
    }
    const text = (f) => (has(f) ? cellText(cells[mapping[f]]) : '');
    const warnings = [];
    const data = {};
    const createDefaults = {};
    const notesAppend = [];
    /** Tidy + correct a text cell; record spelling fixes. */
    const clean = (f, opts) => {
      const r = cleanCell(text(f), opts);
      if (r.correction) corrections.push({ row: rowNumber, field: f, ...r.correction });
      return r.value;
    };

    const code = text('code');
    const name = clean('name', { capitalise: true });

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

    if (!name) {
      const others = Object.keys(mapping).filter((f) => f !== 'location' && f !== 'code' && text(f) !== '');
      if (loc && isCompartmentCode(loc) && others.length === 0 && !code) {
        emptyCompartments.push({ row: rowNumber, code: loc.locationCode });
        continue;
      }
      errors.push({ row: rowNumber, message: 'Missing name (item description); row skipped' });
      skipped++;
      continue;
    }
    if (code) data.code = code;
    data.name = name;

    // Blank cell = not given: existing value kept, new item gets the default.
    const category = clean('category');
    if (category) data.category = category;
    const notes = clean('notes', { keepLines: true });
    if (notes) data.notes = notes;
    for (const f of ['unit', 'brand', 'model']) {
      const v = text(f);
      if (v) data[f] = v.replace(/\s+/g, ' ');
    }

    const barcodeText = text('barcode');
    if (barcodeText) {
      const bc = normalizeBarcode(barcodeText);
      if (bc.length <= LIMITS.barcode && /^[A-Z0-9]+$/.test(bc)) data.barcode = bc;
      else warnings.push(`Warning: barcode "${barcodeText}" must be letters/digits (max ${LIMITS.barcode}); barcode not changed`);
    }

    if (loc?.locationCode) {
      if (loc.locationCode.length > LIMITS.locationCode) {
        warnings.push(
          `Warning: location is longer than ${LIMITS.locationCode} characters; location left unchanged (empty for new items)`
        );
      } else {
        data.locationCode = loc.locationCode;
        if (!loc.rack) {
          warnings.push(`Warning: location "${loc.locationCode}" is not a rack location like AU0305; kept as-is`);
        }
      }
    }

    // Quantity: number or text ("a box", "2 box(24)"). Missing/unreadable -> null for new items.
    if (has('quantity')) {
      const raw = text('quantity');
      const qText = clean('quantity');
      if (!raw) {
        createDefaults.quantity = null; // the importer warns "quantity missing" when this creates an item
      } else {
        const q = parseQuantity(typeof cells[mapping.quantity] === 'number' ? cells[mapping.quantity] : qText);
        if (q) {
          data.quantity = q.quantity;
          if (q.unit && !data.unit) data.unit = q.unit;
          if (q.note) notesAppend.push(q.note);
        } else {
          createDefaults.quantity = null;
          notesAppend.push(`Excel quantity: ${raw}`);
          warnings.push(`Warning: quantity "${raw}" is not a whole number; quantity left unchanged (not counted for new items)`);
        }
      }
    }

    // Good / bad counts (number part only).
    for (const [f, label] of [['goodQty', 'good'], ['badQty', 'bad']]) {
      if (!has(f)) continue;
      const raw = text(f);
      if (!raw) continue;
      const v = clean(f);
      const q = parseQuantity(typeof cells[mapping[f]] === 'number' ? cells[mapping[f]] : v);
      if (q) data[f] = q.quantity;
      else warnings.push(`Warning: ${label} count "${raw}" is not a number; left unchanged`);
    }

    // Legacy Condition column (Phase 1 files) -> counts, unless good/bad columns are given.
    if (has('condition')) {
      const condText = text('condition');
      if (condText) {
        const { condition, recognized } = mapCondition(condText);
        // Unknown text is treated like a bad quantity: existing items keep their counts.
        if (recognized) data.condition = condition;
        else warnings.push(`Warning: unknown condition "${condText}"; existing item keeps its counts`);
      }
    }

    const parsed = updateItemSchema.safeParse(data);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      errors.push({ row: rowNumber, message: `${msg}; row skipped` });
      skipped++;
      continue;
    }
    for (const w of warnings) errors.push({ row: rowNumber, message: w });
    const key = parsed.data.code
      ? { type: 'code', code: parsed.data.code }
      : { type: 'place', locationCode: parsed.data.locationCode ?? null, nameKey: foldName(parsed.data.name) };
    records.push({
      row: rowNumber,
      data: parsed.data,
      key,
      createDefaults,
      notesAppend,
      countsGiven: ['quantity', 'goodQty', 'badQty'].some((f) => parsed.data[f] !== undefined),
      quantityMissing: has('quantity') && !text('quantity'),
    });
  }

  return {
    headerRow: headerRowNumber,
    mapping,
    codeIsLocation,
    ignoredColumns: header.ignored,
    unmappedHeaders: header.unmapped,
    records,
    emptyCompartments,
    sections,
    corrections,
    errors,
    skipped,
  };
}

/**
 * Kit contents from an extra sheet (e.g. "Patrol Box"): rows with a name (+ optional quantity).
 * Returns { contents: [{ name, quantity }], corrections } or null when the sheet has no name column.
 */
export function buildKitContents(rows, sheetName) {
  const header = findHeaderRow(rows.map((r) => r.cells));
  if (!header || !('name' in header.mapping)) return null;
  const { mapping } = header;
  const contents = [];
  const corrections = [];
  for (const { rowNumber, cells } of rows.slice(header.headerIndex + 1)) {
    if (isBlankRow(cells) || isSectionRow(cells)) continue;
    const r = cleanCell(cellText(cells[mapping.name]), { capitalise: true });
    if (!r.value) continue;
    if (r.correction) corrections.push({ sheet: sheetName, row: rowNumber, field: 'contents', ...r.correction });
    const q = 'quantity' in mapping ? parseQuantity(cells[mapping.quantity]) : null;
    contents.push({ name: r.value.slice(0, LIMITS.name), quantity: q ? q.quantity : null });
    if (contents.length >= LIMITS.contents) break;
  }
  return { contents, corrections };
}
