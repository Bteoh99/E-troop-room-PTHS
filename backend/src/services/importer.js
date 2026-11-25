/**
 * Excel / CSV import: read the file, map rows (lib/importRows.js), then upsert by code.
 * Dry run computes exactly the same result but writes nothing; a real import runs in one transaction.
 */
import ExcelJS from 'exceljs';
import { ZodError } from 'zod';
import { parseCsv, decodeText } from '../lib/csv.js';
import { buildImportPlan } from '../lib/importRows.js';
import { findHeaderRow } from '../lib/headers.js';
import { badRequest } from '../lib/errors.js';
import { buildNewItem, createItem, getItemByCode, mergeItem, updateItem } from './items.js';

export const MAX_IMPORT_ROWS = 20_000;
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

/** Read rows from an .xlsx or .csv buffer. Picks the first (visible) sheet that has a usable header row. */
export async function readSpreadsheet(buffer, ext) {
  if (ext === '.csv') {
    return parseCsv(decodeText(buffer)).map((cells, i) => ({ rowNumber: i + 1, cells }));
  }
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw badRequest('This file is not a valid .xlsx workbook. In Excel use "Save As" > "Excel Workbook (.xlsx)" or "CSV".');
  }
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
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Buffer} buffer
 * @param {{ ext: '.xlsx'|'.csv', dryRun: boolean }} opts
 */
export async function importItems(db, buffer, { ext, dryRun }) {
  const rows = await readSpreadsheet(buffer, ext);
  if (rows.length === 0) throw badRequest('The file is empty.');
  if (rows.length > MAX_IMPORT_ROWS + 1) {
    throw badRequest(`Too many rows (${rows.length}); the maximum is ${MAX_IMPORT_ROWS} per import.`);
  }
  const plan = buildImportPlan(rows);

  const result = {
    dryRun,
    created: 0,
    updated: 0,
    skipped: plan.skipped,
    errors: [...plan.errors],
    preview: [],
    headerRow: plan.headerRow,
    columns: plan.mapping,
    ignoredColumns: plan.unmappedHeaders,
  };

  const run = () => {
    const seen = new Map(); // code -> { item, row } already handled in this file
    for (const { row, data } of plan.records) {
      const code = data.code.toUpperCase();
      const prior = seen.get(code);
      const base = prior?.item ?? getItemByCode(db, code);
      let item;
      let action;
      try {
        if (base) {
          action = 'update';
          item = dryRun ? mergeItem(base, data) : updateItem(db, base.id, data);
        } else {
          action = 'create';
          item = dryRun ? buildNewItem(data) : createItem(db, data);
        }
      } catch (err) {
        if (!(err instanceof ZodError)) throw err;
        const msg = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        result.errors.push({ row, message: `${msg}; row skipped` });
        result.skipped++;
        continue;
      }
      if (prior) {
        result.errors.push({ row, message: `Warning: code ${code} also appears on row ${prior.row}; this row overwrites it` });
      }
      seen.set(code, { item, row });
      result[action === 'create' ? 'created' : 'updated']++;
      if (result.preview.length < PREVIEW_ROWS) result.preview.push(previewItem(item, row, action));
    }
  };

  if (dryRun) run();
  else db.transaction(run)();

  result.errors.sort((a, b) => a.row - b.row);
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
