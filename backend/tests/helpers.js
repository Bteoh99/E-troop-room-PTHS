// Shared test helpers. Every helper works on a fresh in-memory database; nothing touches data/store.db.
import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { seed } from '../scripts/seed.js';

/** Fresh app + db (in-memory). */
export function makeApp({ seeded = false } = {}) {
  const db = openDb(':memory:');
  if (seeded) seed(db);
  const app = createApp(db);
  return { app, db };
}

export const ITEM_KEYS = [
  'id', 'code', 'name', 'category', 'locationCode', 'rack', 'shelf', 'bin',
  'quantity', 'unit', 'condition', 'notes', 'createdAt', 'updatedAt',
].sort();

export const PREVIEW_KEYS = [
  'row', 'action', 'id', 'code', 'name', 'category', 'locationCode', 'rack', 'shelf', 'bin',
  'quantity', 'unit', 'condition', 'notes',
].sort();

export const IMPORT_KEYS = [
  'dryRun', 'created', 'updated', 'unchanged', 'skipped', 'errors', 'preview', 'headerRow', 'columns', 'ignoredColumns',
].sort();

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Assert the value is a full Item exactly as in the spec. */
export function expectItemShape(expect, item) {
  expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
  expect(typeof item.id).toBe('number');
  expect(typeof item.code).toBe('string');
  expect(typeof item.name).toBe('string');
  expect(item.category === null || typeof item.category === 'string').toBe(true);
  expect(item.locationCode === null || typeof item.locationCode === 'string').toBe(true);
  expect(item.rack === null || /^R\d{2,3}$/.test(item.rack)).toBe(true);
  expect(item.shelf === null || /^[A-Z]$/.test(item.shelf)).toBe(true);
  expect(item.bin === null || Number.isInteger(item.bin)).toBe(true);
  expect(Number.isInteger(item.quantity) && item.quantity >= 0).toBe(true);
  expect(typeof item.unit).toBe('string');
  expect(['good', 'needs_repair', 'damaged', 'written_off']).toContain(item.condition);
  expect(typeof item.notes).toBe('string');
  expect(item.createdAt).toMatch(ISO_RE);
  expect(item.updatedAt).toMatch(ISO_RE);
}

/** Assert the spec error shape { error: { message, details? } }. */
export function expectErrorShape(expect, body) {
  expect(body).toHaveProperty('error');
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  for (const k of Object.keys(body.error)) expect(['message', 'details']).toContain(k);
}

/** Insert items through the API (asserts 201). */
export async function createItems(app, items) {
  const out = [];
  for (const it of items) {
    const res = await request(app).post('/api/items').send(it);
    if (res.status !== 201) throw new Error(`create ${JSON.stringify(it)} -> ${res.status} ${JSON.stringify(res.body)}`);
    out.push(res.body);
  }
  return out;
}

/**
 * Build an .xlsx buffer.
 * @param {Array<Array<unknown>>|{name?:string,rows:Array<Array<unknown>>,state?:string}[]} sheets
 *   either rows for a single sheet, or a list of sheets.
 */
export async function xlsx(sheets) {
  const list = Array.isArray(sheets) && (sheets.length === 0 || Array.isArray(sheets[0])) ? [{ rows: sheets }] : sheets;
  const wb = new ExcelJS.Workbook();
  list.forEach((s, i) => {
    const ws = wb.addWorksheet(s.name ?? `Sheet${i + 1}`);
    if (s.state) ws.state = s.state;
    s.rows.forEach((r, ri) => {
      // Write cell by cell so blank rows really stay blank (and row numbers stay exact).
      (r ?? []).forEach((v, ci) => {
        if (v !== undefined && v !== null) ws.getCell(ri + 1, ci + 1).value = v;
      });
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Build a CSV buffer from rows (cells containing , ; " or newlines get quoted). */
export function csv(rows, delimiter = ',') {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\t\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return Buffer.from(rows.map((r) => r.map(esc).join(delimiter)).join('\r\n') + '\r\n', 'utf8');
}

/** POST /api/import with a file. `query` e.g. { dryRun: 'false' }. */
export function upload(app, buffer, filename = 'items.xlsx', query = {}) {
  const qs = new URLSearchParams(query).toString();
  return request(app).post(`/api/import${qs ? `?${qs}` : ''}`).attach('file', buffer, filename);
}

/** Read a workbook buffer with exceljs. */
export async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

/** supertest parser that collects the raw body into a Buffer (for binary downloads). */
export function binaryParser(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

export function allItems(db) {
  return db.prepare('SELECT * FROM items ORDER BY code').all();
}
