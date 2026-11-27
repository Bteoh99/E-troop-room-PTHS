// Shared test helpers. Every helper works on a fresh in-memory database; nothing touches data/store.db.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { seed } from '../scripts/seed.js';
import { readConfig, setPin } from '../src/auth/config.js';
import { signToken } from '../src/auth/tokens.js';

/** Cheap scrypt cost for tests only (production uses SCRYPT_DEFAULTS). */
export const TEST_SCRYPT = { N: 1024 };
export const TEST_PIN = '246810'; // new PINs must be 6-8 digits (lead decision V2)

/** A fresh temp folder (removed when the test process exits). */
export function tmpDir(prefix = 'etroop-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temp config.json with a known leader PIN. Returns { configPath, pin, token }. */
export function makeLeaderConfig(pin = TEST_PIN) {
  const configPath = path.join(tmpDir('etroop-config-'), 'config.json');
  setPin(configPath, pin, TEST_SCRYPT);
  const { token } = signToken(readConfig(configPath).tokenSecret);
  return { configPath, pin, token };
}

let sharedLeader = null;

/**
 * Fresh app + db (in-memory) with a leader PIN set up (temp CONFIG_PATH).
 * - `app` sends the leader token automatically (unless the request sets its own Authorization header),
 *   so tests of items/import behaviour do not have to log in.
 * - `publicApp` is the same server without the automatic token (for PIN / auth tests).
 */
export function makeApp({ seeded = false, leader = sharedLeader ??= makeLeaderConfig(), ...opts } = {}) {
  const db = openDb(':memory:');
  if (seeded) seed(db);
  const publicApp = createApp(db, { configPath: leader.configPath, staticDir: false, ...opts });
  const app = (req, res) => {
    if (!('authorization' in req.headers)) req.headers.authorization = `Bearer ${leader.token}`;
    return publicApp(req, res);
  };
  return { app, publicApp, db, ...leader };
}

export const ITEM_KEYS = [
  'id', 'code', 'name', 'category', 'locationCode', 'rack', 'shelf', 'bin',
  'quantity', 'unit', 'condition', 'notes', 'brand', 'model', 'barcode', 'createdAt', 'updatedAt',
].sort();

export const PREVIEW_KEYS = [
  'row', 'action', 'id', 'code', 'name', 'category', 'locationCode', 'rack', 'shelf', 'bin',
  'quantity', 'unit', 'condition', 'notes', 'brand', 'model', 'barcode',
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
