/**
 * Excel / CSV import: read the workbook, map rows (lib/importRows.js), then upsert.
 * Upsert key: the item code when a row has one; otherwise location + folded name (the troop's real
 * file has no item codes). Dry run computes exactly the same result but writes nothing; a real import
 * runs in one transaction. Extra sheets named like an item (e.g. "Patrol Box") become kit contents.
 */
import ExcelJS from 'exceljs';
import { ZodError } from 'zod';
import { parseCsv, decodeText } from '../lib/csv.js';
import { buildImportPlan, buildKitContents, foldName } from '../lib/importRows.js';
import { findHeaderRow } from '../lib/headers.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { checkXlsx } from '../lib/xlsxGuard.js';
import { updateItemSchema } from '../lib/itemSchema.js';
import {
  buildNewItem, clearBarcode, createItem, findByLocationAndName, getItemByBarcode, getItemByCode, mergeItem,
  registerCompartment, updateItem,
} from './items.js';
import { barcodeKey } from '../lib/scanMatch.js';

export const MAX_IMPORT_ROWS = 20_000; // data rows (after the header)
export const PREVIEW_ROWS = 20;

/** ExcelJS cell value -> primitive (rich text, formulas, hyperlinks, errors flattened). */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== 'object') return v;
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
  if ('result' in v) return cellValue(v.result); // formula / shared formula
  if ('text' in v) return cellValue(v.text); // hyperlink
  if ('error' in v) return null;
  return String(v);
}

function sheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push({ rowNumber, cells: Array.from(values, cellValue) });
  });
  return rows;
}

const tooManyRows = () =>
  badRequest(`Too many rows; the maximum is ${MAX_IMPORT_ROWS} per import. Split the file into smaller files.`);

/**
 * Read an .xlsx or .csv buffer.
 * @returns {Promise<{ main: { name: string, rows: object[] } | null, others: { name: string, rows: object[] }[] }>}
 * main = the first visible sheet whose header has a name column plus a code or location column
 * (else the first with a name column, else the first non-empty sheet); others = the other sheets.
 */
export async function readWorkbook(buffer, ext) {
  if (ext === '.csv') {
    try {
      // +200 leaves room for title/blank rows above the header; the exact check is in importItems.
      // No cell cap for CSV: plain strings are cheap, and the 5 MB upload limit bounds them.
      const rows = parseCsv(decodeText(buffer), undefined, { maxRows: MAX_IMPORT_ROWS + 200 })
        .map((cells, i) => ({ rowNumber: i + 1, cells }));
      return { main: rows.length ? { name: 'CSV', rows } : null, others: [] };
    } catch (err) {
      if (err instanceof RangeError) throw tooManyRows();
      throw err;
    }
  }
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw badRequest('This file is not a valid .xlsx workbook. In Excel use "Save As" > "Excel Workbook (.xlsx)" or "CSV".');
  }
  checkXlsx(buffer); // bounded-memory size/row check before ExcelJS loads everything
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw badRequest('Could not read the Excel file. Make sure it is a valid .xlsx workbook.');
  }
  const visible = wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden');
  const candidates = (visible.length ? visible : wb.worksheets)
    .map((ws) => ({ name: ws.name, rows: sheetRows(ws) }))
    .filter((sh) => sh.rows.length > 0);
  const scored = candidates.map((sh) => {
    const h = findHeaderRow(sh.rows.map((r) => r.cells));
    const m = h?.mapping ?? {};
    return { sh, score: 'name' in m ? ('code' in m || 'location' in m ? 2 : 1) : 0 };
  });
  const best = scored.find((x) => x.score === 2) ?? scored.find((x) => x.score === 1) ?? scored[0];
  const main = best?.sh ?? null;
  return { main, others: candidates.filter((sh) => sh !== main) };
}

/** Rows of the main sheet (kept for callers/tests of the Phase 1 API). */
export async function readSpreadsheet(buffer, ext) {
  return (await readWorkbook(buffer, ext)).main?.rows ?? [];
}

function previewItem(item, row, action) {
  return {
    row,
    action,
    id: item.id ?? null,
    code: item.code,
    name: item.name,
    category: item.category,
    locationCode: item.locationCode,
    rack: item.rack,
    level: item.level,
    compartment: item.compartment,
    shelf: item.shelf,
    bin: item.bin,
    quantity: item.quantity,
    unit: item.unit,
    goodQty: item.goodQty,
    badQty: item.badQty,
    status: item.status,
    countsMismatch: item.countsMismatch,
    notes: item.notes,
    brand: item.brand,
    model: item.model,
    barcode: item.barcode,
    contents: item.contents,
  };
}

const COMPARED = ['code', 'name', 'category', 'locationCode', 'quantity', 'unit', 'goodQty', 'badQty', 'notes', 'brand', 'model', 'barcode', 'contents'];
const same = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a ?? []) === JSON.stringify(b ?? []) : a === b);
const sameItem = (a, b) => COMPARED.every((k) => same(a[k], b[k]));
const appendNote = (notes, text) => (notes ? (notes.includes(text) ? notes : `${notes} ${text}`) : text);
const show = (v) => (v === null || v === undefined ? '-' : v);
/** Identity of an item for barcode ownership (code, else location + folded name). */
const identity = (item) => (item.code ? `code:${String(item.code).toUpperCase()}` : `place:${item.locationCode ?? ''}|${foldName(item.name)}`);
const keyString = (key) => (key.type === 'code' ? `code:${key.code.toUpperCase()}` : `place:${key.locationCode ?? ''}|${key.nameKey}`);
/** How an item is named in messages: its code if it has one, else location + name. */
const label = (item) => item.code ?? (item.locationCode ? `${item.locationCode} ${item.name}` : item.name);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Buffer} buffer
 * @param {{ ext: '.xlsx'|'.csv', dryRun: boolean }} opts
 *
 * Counts are per distinct item: created, updated (existing item that changes), unchanged.
 * - A code that appears on several rows is one item: later rows are applied on top (warning).
 * - The same location + name twice (no code): the first row is kept, the later one ignored (warning).
 */
export function importItems(db, buffer, opts) {
  return runExclusive(() => importItemsNow(db, buffer, opts));
}

/**
 * One import (dry run or real) at a time per process: each workbook load is CPU- and memory-heavy.
 * Up to IMPORT_QUEUE_LIMIT further requests wait their turn; beyond that -> 429.
 */
export const IMPORT_QUEUE_LIMIT = 2;
let importActive = false;
const importWaiting = [];
export async function runExclusive(fn) {
  if (importActive) {
    if (importWaiting.length >= IMPORT_QUEUE_LIMIT) {
      throw new HttpError(429, 'Another import is being processed. Please try again in a moment.');
    }
    await new Promise((resolve) => importWaiting.push(resolve));
  } else importActive = true;
  try {
    return await fn();
  } finally {
    const next = importWaiting.shift();
    if (next) next(); // hand the lock straight to the next waiter
    else importActive = false;
  }
}

async function importItemsNow(db, buffer, { ext, dryRun }) {
  const book = await readWorkbook(buffer, ext);
  const rows = book.main?.rows ?? [];
  if (rows.length === 0) throw badRequest('The file is empty.');
  const plan = buildImportPlan(rows);
  if (plan.records.length + plan.skipped + plan.emptyCompartments.length > MAX_IMPORT_ROWS) throw tooManyRows();

  const errors = [...plan.errors];
  const corrections = [...plan.corrections];
  let skipped = plan.skipped;

  // 1) Work out every item's final state in memory (identical for dry and real runs).
  const byKey = new Map(); // key -> { firstRow, lastRow, original (DB item or null), item (final) }
  // The file's view of barcode ownership (key ignores leading zeros): item identity, or null when a row
  // moved that barcode off its item. Anything not in here is looked up in the DB.
  const barcodeOwner = new Map();
  const ownerOf = (bc) => {
    const k = barcodeKey(bc);
    if (barcodeOwner.has(k)) return barcodeOwner.get(k);
    const owner = getItemByBarcode(db, bc);
    return owner ? { id: identity(owner), label: label(owner) } : null;
  };
  for (const record of plan.records) {
    const { row, data, key } = record;
    const k = keyString(key);
    const entry = byKey.get(k);
    if (entry && key.type === 'place') {
      errors.push({ row, message: `Warning: duplicate row (${label(entry.item)}) ignored — check the Excel (first seen on row ${entry.firstRow})` });
      continue;
    }
    const original = entry ? entry.original
      : key.type === 'code' ? getItemByCode(db, key.code) : findByLocationAndName(db, key.locationCode, data.name);
    const current = entry ? entry.item : original;
    if (data.barcode) {
      if (current?.barcode && barcodeKey(current.barcode) === barcodeKey(data.barcode)) {
        delete data.barcode; // same barcode (e.g. Excel dropped a leading zero): keep the stored spelling
      } else {
        // A barcode identifies one item: never take it from another item (DB or earlier row).
        const owner = ownerOf(data.barcode);
        if (owner && owner.id !== k) {
          errors.push({ row, message: `Warning: barcode ${data.barcode} already belongs to item ${owner.label}; barcode not changed` });
          delete data.barcode;
        }
      }
    }
    let item;
    try {
      item = current ? mergeItem(current, updateItemSchema.parse(data)) : buildNewItem({ ...record.createDefaults, ...data });
    } catch (err) {
      if (!(err instanceof ZodError)) throw err;
      const msg = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      errors.push({ row, message: `${msg}; row skipped` });
      skipped++;
      continue;
    }
    for (const note of record.notesAppend) item = { ...item, notes: appendNote(item.notes, note) };
    if (!current && record.quantityMissing) errors.push({ row, message: 'Warning: quantity missing' });
    if (record.countsGiven && Number.isInteger(item.quantity) && (item.goodQty !== null || item.badQty !== null)
        && (item.goodQty ?? 0) + (item.badQty ?? 0) !== item.quantity) {
      errors.push({ row, message: `Warning: counts don't add up (quantity ${item.quantity}, good ${show(item.goodQty)}, bad ${show(item.badQty)})` });
    }
    if (current?.barcode !== item.barcode) {
      if (current?.barcode) barcodeOwner.set(barcodeKey(current.barcode), null);
      if (item.barcode) barcodeOwner.set(barcodeKey(item.barcode), { id: k, label: label(item) });
    }
    if (entry) {
      errors.push({ row, message: `Warning: code ${key.code} also appears on row ${entry.lastRow}; this row is applied on top of it` });
      entry.item = item;
      entry.lastRow = row;
    } else {
      byKey.set(k, { firstRow: row, lastRow: row, original, item });
    }
  }

  // 2) Kits: an extra sheet named like an item ("Patrol Box") lists what that item contains.
  const kits = [];
  for (const sheet of book.others) {
    const targets = [...byKey.values()].filter((e) => foldName(e.item.name) === foldName(sheet.name));
    if (targets.length === 0) continue;
    const kit = buildKitContents(sheet.rows, sheet.name);
    if (!kit || kit.contents.length === 0) continue;
    corrections.push(...kit.corrections);
    for (const e of targets) e.item = { ...e.item, contents: kit.contents };
    kits.push({ name: sheet.name, items: kit.contents.length, appliedTo: targets.length });
  }

  // 3) Real run: one write per item, all in one transaction. Unchanged items are not written,
  //    even when several rows changed them and changed them back. Barcodes that move are freed
  //    first, so the write order can never trip the unique index.
  if (!dryRun) {
    db.transaction(() => {
      for (const { original, item } of byKey.values()) {
        if (original?.barcode && original.barcode !== item.barcode) clearBarcode(db, original.id);
      }
      for (const entry of byKey.values()) {
        const values = Object.fromEntries(COMPARED.map((f) => [f, entry.item[f]]));
        if (!entry.original) entry.item = createItem(db, values);
        else if (!sameItem(entry.original, entry.item)) entry.item = updateItem(db, entry.original.id, values);
      }
      for (const { code } of plan.emptyCompartments) registerCompartment(db, code);
      for (const { item } of byKey.values()) registerCompartment(db, item.locationCode);
    })();
  }

  const result = {
    dryRun,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped,
    errors: errors.sort((a, b) => a.row - b.row),
    preview: [],
    headerRow: plan.headerRow,
    columns: plan.mapping,
    ignoredColumns: plan.ignoredColumns,
    sections: plan.sections,
    emptyCompartments: plan.emptyCompartments.length,
    corrections: corrections.sort((a, b) => (a.sheet ? 1 : 0) - (b.sheet ? 1 : 0) || a.row - b.row),
    kits,
  };
  for (const { firstRow, original, item } of byKey.values()) {
    const action = !original ? 'create' : sameItem(original, item) ? 'unchanged' : 'update';
    result[action === 'create' ? 'created' : action === 'update' ? 'updated' : 'unchanged']++;
    if (result.preview.length < PREVIEW_ROWS) {
      result.preview.push(previewItem({ ...item, id: item.id ?? original?.id ?? null }, firstRow, action));
    }
  }
  return result;
}

/** Build the downloadable template workbook (Phase 1.6 columns, v2 locations). */
export async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'e-Troop Store Room';
  wb.created = new Date();
  const ws = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Location', key: 'location', width: 12 },
    { header: 'Item description', key: 'name', width: 32 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Good', key: 'good', width: 8 },
    { header: 'Bad', key: 'bad', width: 8 },
    { header: 'Brand', key: 'brand', width: 14 },
    { header: 'Model', key: 'model', width: 14 },
    { header: 'Barcode', key: 'barcode', width: 16 },
    { header: 'Notes', key: 'notes', width: 40 },
  ];
  // Examples use rack "EX", so importing an untouched template only adds two obvious example rows.
  ws.addRow({ location: 'EX0101', name: 'Dome tent (example)', quantity: 4, unit: 'pcs', good: 3, bad: 1, brand: 'Coleman', model: 'Sundome 4', barcode: '', notes: 'Example row - replace or delete before importing' });
  ws.addRow({ location: 'EX0102', name: 'Tent pegs (example)', quantity: 'a box', unit: '', good: 'a box', bad: '', brand: '', model: '', barcode: '', notes: 'Example row - replace or delete before importing' });
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0E0' } };

  const help = wb.addWorksheet('How to fill in');
  help.columns = [{ width: 18 }, { width: 90 }];
  [
    ['Column', 'What to enter'],
    ['Location', 'Rack + level + compartment, e.g. AU0305 = Rack AU, Level 03 (01 is the bottom), Compartment 05. "AU 03 05" and "AU-3-5" work too. A location with no item description = an empty compartment. Rows like "RACK AU" are section headings.'],
    ['Item description', 'Required. What the item is, e.g. "Dome tent". The same location + description again updates that item.'],
    ['Quantity', 'A number, or text such as "a box", "2 box", "3 small box". Leave empty if not counted.'],
    ['Unit', 'Optional; default "pcs" (or the word after the number, e.g. "box").'],
    ['Good / Bad', 'How many are in good / bad condition (numbers).'],
    ['Brand / Model / Barcode', 'Optional; they help the Scan screen recognise the item.'],
    ['Notes', 'Anything else.'],
    ['Kits', 'Add a sheet named exactly like an item (e.g. "Patrol Box") with columns Item description + Quantity to list what that kit contains.'],
    ['', ''],
    ['Other headers', 'CODE (used as the location when it holds codes like AU0305), ITEM DESCRIPTION, GOOD CONDITION, BAD CONDITION, Lokasi, Nama, Kuantiti, Baik, Rosak, Catatan are recognised too.'],
  ].forEach((r) => help.addRow(r));
  help.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
