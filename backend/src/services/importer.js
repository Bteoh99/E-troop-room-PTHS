/**
 * Excel / CSV import: read the file, map rows (lib/importRows.js), then upsert by code.
 * Dry run computes exactly the same result but writes nothing; a real import runs in one transaction.
 */
import ExcelJS from 'exceljs';
import { ZodError } from 'zod';
import { parseCsv, decodeText } from '../lib/csv.js';
import { buildImportPlan } from '../lib/importRows.js';
import { findHeaderRow } from '../lib/headers.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { checkXlsx } from '../lib/xlsxGuard.js';
import { updateItemSchema } from '../lib/itemSchema.js';
import { buildNewItem, clearBarcode, createItem, getItemByBarcode, getItemByCode, mergeItem, updateItem } from './items.js';
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

/** Read rows from an .xlsx or .csv buffer. Picks the first (visible) sheet that has a usable header row. */
export async function readSpreadsheet(buffer, ext) {
  if (ext === '.csv') {
    try {
      // +200 leaves room for title/blank rows above the header; the exact check is in importItems.
      // No cell cap for CSV: plain strings are cheap, and the 5 MB upload limit bounds them.
      return parseCsv(decodeText(buffer), undefined, { maxRows: MAX_IMPORT_ROWS + 200 })
        .map((cells, i) => ({ rowNumber: i + 1, cells }));
    } catch (err) {
      if (err instanceof RangeError) {
        throw tooManyRows();
      }
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
  const sheets = wb.worksheets.filter((ws) => ws.state !== 'hidden' && ws.state !== 'veryHidden');
  const candidates = sheets.length ? sheets : wb.worksheets;
  let fallback = null;
  for (const ws of candidates) {
    const rows = sheetRows(ws);
    if (rows.length === 0) continue;
    fallback ??= rows;
    const header = findHeaderRow(rows.map((r) => r.cells));
    if (header && 'code' in header.mapping && 'name' in header.mapping) return rows;
  }
  return fallback ?? [];
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
    shelf: item.shelf,
    bin: item.bin,
    quantity: item.quantity,
    unit: item.unit,
    condition: item.condition,
    notes: item.notes,
    brand: item.brand,
    model: item.model,
    barcode: item.barcode,
  };
}

const COMPARED = ['code', 'name', 'category', 'locationCode', 'quantity', 'unit', 'condition', 'notes', 'brand', 'model', 'barcode'];
const sameItem = (a, b) => COMPARED.every((k) => a[k] === b[k]);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Buffer} buffer
 * @param {{ ext: '.xlsx'|'.csv', dryRun: boolean }} opts
 *
 * Counts are per distinct code: created (new code), updated (existing item that changes),
 * unchanged (existing item the file leaves as it is). A code that appears on several rows is one
 * item: later rows are applied on top of earlier ones (warning), and its single preview entry
 * shows the final result.
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
  const rows = await readSpreadsheet(buffer, ext);
  if (rows.length === 0) throw badRequest('The file is empty.');
  const plan = buildImportPlan(rows);
  if (plan.records.length + plan.skipped > MAX_IMPORT_ROWS) throw tooManyRows();

  const errors = [...plan.errors];
  let skipped = plan.skipped;

  // 1) Work out every code's final state in memory (identical for dry and real runs).
  const byCode = new Map(); // code -> { firstRow, lastRow, original (DB item or null), item (final) }
  // The file's view of barcode ownership (key ignores leading zeros): code, or null when a row moved
  // that barcode off its item. Anything not in here is looked up in the DB. Dry and real runs use
  // exactly this same planning, so their results agree.
  const barcodeOwner = new Map();
  const ownerOf = (bc) => {
    const k = barcodeKey(bc);
    return barcodeOwner.has(k) ? barcodeOwner.get(k) : getItemByBarcode(db, bc)?.code ?? null;
  };
  for (const { row, data } of plan.records) {
    const code = data.code.toUpperCase();
    const entry = byCode.get(code);
    const original = entry ? entry.original : getItemByCode(db, code);
    const current = entry ? entry.item : original;
    if (data.barcode) {
      if (current?.barcode && barcodeKey(current.barcode) === barcodeKey(data.barcode)) {
        delete data.barcode; // same barcode (e.g. Excel dropped a leading zero): keep the stored spelling
      } else {
        // A barcode identifies one item: never take it from another item (DB or earlier row).
        const owner = ownerOf(data.barcode);
        if (owner && owner !== code) {
          errors.push({ row, message: `Warning: barcode ${data.barcode} already belongs to item ${owner}; barcode not changed` });
          delete data.barcode;
        }
      }
    }
    let item;
    try {
      item = current ? mergeItem(current, updateItemSchema.parse(data)) : buildNewItem(data);
    } catch (err) {
      if (!(err instanceof ZodError)) throw err;
      const msg = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      errors.push({ row, message: `${msg}; row skipped` });
      skipped++;
      continue;
    }
    if (current?.barcode !== item.barcode) {
      if (current?.barcode) barcodeOwner.set(barcodeKey(current.barcode), null);
      if (item.barcode) barcodeOwner.set(barcodeKey(item.barcode), code);
    }
    if (entry) {
      errors.push({ row, message: `Warning: code ${code} also appears on row ${entry.lastRow}; this row is applied on top of it` });
      entry.item = item;
      entry.lastRow = row;
    } else {
      byCode.set(code, { firstRow: row, lastRow: row, original, item });
    }
  }

  // 2) Real run: one write per code, all in one transaction. Unchanged items are not written,
  //    even when several rows changed them and changed them back. Barcodes that move are freed
  //    first, so the write order can never trip the unique index.
  if (!dryRun) {
    db.transaction(() => {
      for (const { original, item } of byCode.values()) {
        if (original?.barcode && original.barcode !== item.barcode) clearBarcode(db, original.id);
      }
      for (const entry of byCode.values()) {
        const values = Object.fromEntries(COMPARED.map((k) => [k, entry.item[k]]));
        if (!entry.original) entry.item = createItem(db, values);
        else if (!sameItem(entry.original, entry.item)) entry.item = updateItem(db, entry.original.id, values);
      }
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
  };
  for (const { firstRow, original, item } of byCode.values()) {
    const action = !original ? 'create' : sameItem(original, item) ? 'unchanged' : 'update';
    result[action === 'create' ? 'created' : action === 'update' ? 'updated' : 'unchanged']++;
    if (result.preview.length < PREVIEW_ROWS) {
      result.preview.push(previewItem({ ...item, id: item.id ?? original?.id ?? null }, firstRow, action));
    }
  }
  return result;
}

/** Build the downloadable template workbook. */
export async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'e-Troop Store Room';
  wb.created = new Date();
  const ws = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Code', key: 'code', width: 14 },
    { header: 'Name', key: 'name', width: 32 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Location', key: 'location', width: 12 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Condition', key: 'condition', width: 14 },
    { header: 'Notes', key: 'notes', width: 40 },
  ];
  // Example codes are deliberately not real item codes, so importing an untouched template changes nothing real.
  ws.addRow({ code: 'EXAMPLE-1', name: '4-man dome tent', category: 'Tents', location: 'R03-B-2', quantity: 1, unit: 'pcs', condition: 'good', notes: 'Example row - replace or delete before importing' });
  ws.addRow({ code: 'EXAMPLE-2', name: 'Manila rope 10 m', category: 'Ropes', location: 'R05-A-1', quantity: 6, unit: 'coils', condition: 'needs_repair', notes: 'Example row - replace or delete before importing' });
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0E0' } };
  for (let r = 2; r <= 500; r++) {
    ws.getCell(`G${r}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: ['"good,needs_repair,damaged,written_off"'],
      showErrorMessage: false,
    };
  }

  const help = wb.addWorksheet('How to fill in');
  help.columns = [{ width: 18 }, { width: 90 }];
  [
    ['Column', 'What to enter'],
    ['Code', 'Required. Unique item code, e.g. TNT-004 (the EXAMPLE rows are only examples). Importing the same code again updates that item.'],
    ['Name', 'Required. What the item is, e.g. "4-man dome tent".'],
    ['Category', 'Optional. e.g. Tents, Cooking, Ropes, Tools, First Aid, Flags.'],
    ['Location', 'Rack-Shelf-Bin, e.g. R03-B-2 (Rack 03, Shelf B (A = top), Bin 2). "R3 B 2", "3/B/2", "R03-B" or "R03" also work. You may use separate Rack / Shelf / Bin columns instead.'],
    ['Quantity', 'Whole number, default 1.'],
    ['Unit', 'Default "pcs".'],
    ['Condition', 'good, needs_repair, damaged or written_off (Malay also accepted: baik, rosak sikit, rosak, lupus).'],
    ['Notes', 'Anything else.'],
    ['', ''],
    ['Malay headers', 'Kod, Nama, Kategori, Lokasi / Koordinat, Kuantiti / Jumlah, Keadaan, Catatan are recognised too.'],
  ].forEach((r) => help.addRow(r));
  help.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
