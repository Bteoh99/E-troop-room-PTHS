// POST /api/import and GET /api/import/template
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import {
  makeApp, createItems, xlsx, csv, upload, readXlsx, binaryParser, allItems,
  expectErrorShape, IMPORT_KEYS, PREVIEW_KEYS,
} from './helpers.js';

let app;
let db;
beforeEach(() => {
  ({ app, db } = makeApp());
});

const count = () => db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
const byCode = (code) => db.prepare('SELECT * FROM items WHERE code = ?').get(code);
const real = { dryRun: 'false' };

const HEADER = ['Code', 'Name', 'Category', 'Location', 'Quantity', 'Unit', 'Condition', 'Notes'];

describe('POST /api/import - response shape and dry run', () => {
  const rows = [
    HEADER,
    ['tnt-004', '4-man dome tent', 'Tents', 'r3 b 2', 6, 'pcs', 'good', 'Green'],
    ['ROP-010', 'Manila rope 10 m', 'Ropes', 'R05-A-1', 12, 'coils', 'needs repair', ''],
  ];

  it('dry run (explicit) returns the full shape and writes nothing', async () => {
    const res = await upload(app, await xlsx(rows), 'items.xlsx', { dryRun: 'true' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(IMPORT_KEYS);
    expect(res.body).toMatchObject({ dryRun: true, created: 2, updated: 0, skipped: 0, errors: [], headerRow: 1, ignoredColumns: [] });
    expect(res.body.columns).toEqual({ code: 0, name: 1, category: 2, location: 3, quantity: 4, unit: 5, condition: 6, notes: 7 });
    expect(res.body.preview).toHaveLength(2);
    for (const p of res.body.preview) expect(Object.keys(p).sort()).toEqual(PREVIEW_KEYS);
    expect(res.body.preview[0]).toEqual({
      row: 2, action: 'create', id: null, code: 'TNT-004', name: '4-man dome tent', category: 'Tents',
      locationCode: 'R03-B-2', rack: 'R03', shelf: 'B', bin: 2, quantity: 6, unit: 'pcs', notes: 'Green',
      brand: null, model: null, barcode: null, // Phase 1.5 fields
      // Phase 1.6: condition good -> counts; level/compartment (v2), derived status, contents
      level: null, compartment: null, goodQty: 6, badQty: 0, status: 'ok', countsMismatch: false, contents: [],
    });
    expect(res.body.preview[1]).toMatchObject({ row: 3, code: 'ROP-010', goodQty: 0, badQty: 12, unit: 'coils', quantity: 12 }); // needs repair -> bad
    expect(count()).toBe(0);
  });

  it('dryRun defaults to true when omitted', async () => {
    const res = await upload(app, await xlsx(rows));
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.created).toBe(2);
    expect(count()).toBe(0);
  });

  it.each([['1', true], ['0', false]])('dryRun=%s -> %s', async (flag, expected) => {
    const res = await upload(app, await xlsx(rows), 'items.xlsx', { dryRun: flag });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(expected);
    expect(count()).toBe(expected ? 0 : 2);
  });

  it('invalid dryRun -> 400 and nothing written', async () => {
    const res = await upload(app, await xlsx(rows), 'items.xlsx', { dryRun: 'maybe' });
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(count()).toBe(0);
  });

  it('real import writes, and the dry run predicted the same counts', async () => {
    await createItems(app, [{ code: 'ROP-010', name: 'Old rope', quantity: 1 }]);
    const file = await xlsx(rows);
    const dry = await upload(app, file);
    const before = allItems(db);
    const wet = await upload(app, file, 'items.xlsx', real);
    expect(allItems(db)).not.toEqual(before);
    expect(dry.body.created).toBe(1);
    expect(dry.body.updated).toBe(1);
    expect(wet.body).toMatchObject({ dryRun: false, created: 1, updated: 1, skipped: 0 });
    // Preview of real import has ids; dry-run preview has id only for the existing item.
    expect(dry.body.preview.map((p) => [p.action, p.id === null])).toEqual([['create', true], ['update', false]]);
    expect(wet.body.preview.every((p) => typeof p.id === 'number')).toBe(true);
    const strip = (p) => ({ ...p, id: undefined });
    expect(wet.body.preview.map(strip)).toEqual(dry.body.preview.map(strip));
    const res = await request(app).get('/api/items').query({ q: 'TNT-004' });
    expect(res.body.items[0]).toMatchObject({ code: 'TNT-004', locationCode: 'R03-B-2', rack: 'R03', shelf: 'B', bin: 2, quantity: 6 });
  });

  it('dry run with errors writes nothing either', async () => {
    // Phase 1.6: a row without a code is fine now; a row without a name is still an error
    const file = await xlsx([HEADER, ['A1', 'x'], ['', 'no code'], ['A3', ''], ['A2', 'y', '', '', '', '', 'weird']]);
    const res = await upload(app, file);
    expect(res.body.created).toBe(3);
    expect(res.body.skipped).toBe(1);
    expect(count()).toBe(0);
  });
});

describe('POST /api/import - header aliases', () => {
  it('Malay headers (Kod, Nama, Kategori, Lokasi, Kuantiti, Keadaan, Catatan)', async () => {
    const file = await xlsx([
      ['Bil', 'Kod', 'Nama', 'Kategori', 'Lokasi', 'Kuantiti', 'Keadaan', 'Catatan'],
      [1, 'KHM-001', 'Khemah 4 orang', 'Khemah', 'R1-A-1', 3, 'baik', 'Hijau'],
      [2, 'KHM-002', 'Khemah 6 orang', 'Khemah', 'R1-A-2', 2, 'rosak', ''],
      [3, 'PRK-001', 'Periuk besar', 'Masak', 'R2-B', 1, 'rosak sikit', ''],
      [4, 'BDR-001', 'Bendera lama', 'Bendera', 'R6', 1, 'lupus', ''],
    ]);
    const res = await upload(app, file, 'stor.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 4, skipped: 0, errors: [], ignoredColumns: ['Bil'] });
    expect(res.body.columns).toEqual({ code: 1, name: 2, category: 3, location: 4, quantity: 5, condition: 6, notes: 7 });
    // Phase 1.6: Keadaan becomes good/bad counts (good -> good = quantity; rosak / rosak sikit / lupus -> bad = quantity)
    expect(byCode('KHM-001')).toMatchObject({ name: 'Khemah 4 orang', category: 'Khemah', location_code: 'R01-A-1', quantity: 3, good_qty: 3, bad_qty: 0, notes: 'Hijau' });
    expect(byCode('KHM-002')).toMatchObject({ good_qty: 0, bad_qty: 2 });
    expect(byCode('PRK-001')).toMatchObject({ good_qty: 0, bad_qty: 1, location_code: 'R02-B', bin: null });
    expect(byCode('BDR-001')).toMatchObject({ good_qty: 0, bad_qty: 1, notes: 'Written off', location_code: 'R06', shelf: null });
  });

  it.each([
    [['Item Code', 'Item Name', 'Coordinates', 'Qty', 'Remarks', 'Type']],
    [['ITEMCODE', 'ITEM', 'Rack Location', 'Jumlah', 'Notes', 'Category']],
    [['kod item', 'nama item', 'koordinat', 'quantity', 'catatan', 'kategori']],
    [['ID', 'Description', 'Coordinate', 'qty', 'remarks', 'type']],
    [['  code ', 'NAME:', 'location', 'QTY.', 'Remarks', 'Type']],
  ])('alias set %j', async (header) => {
    const file = await xlsx([header, ['x-1', 'Thing', 'r4/c/3', 7, 'note', 'Tools']]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 0, errors: [] });
    expect(byCode('X-1')).toMatchObject({ name: 'Thing', location_code: 'R04-C-3', quantity: 7, notes: 'note', category: 'Tools' });
  });

  it('unknown columns are ignored and listed in ignoredColumns', async () => {
    const file = await xlsx([['Code', 'Name', 'Purchased', 'Supplier'], ['A1', 'Tent', '2020', 'ACME']]);
    const res = await upload(app, file);
    expect(res.body.ignoredColumns).toEqual(['Purchased', 'Supplier']);
    expect(res.body.created).toBe(1);
  });

  it('header row below title rows is detected (headerRow is the sheet row)', async () => {
    const file = await xlsx([
      ['31st Troop store inventory'],
      ['Updated Nov 2026'],
      [],
      ['Code', 'Name', 'Location'],
      ['A1', 'Tent', 'R1-A-1'],
    ]);
    const res = await upload(app, file);
    expect(res.status).toBe(200);
    expect(res.body.headerRow).toBe(4);
    expect(res.body.preview[0]).toMatchObject({ row: 5, code: 'A1', locationCode: 'R01-A-1' });
  });

  it('missing code/name columns -> 400 with details.missingColumns and details.headersFound', async () => {
    const file = await xlsx([['Thing', 'Where', 'How many'], ['Tent', 'R1', 3]]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(res.body.error.details.missingColumns).toEqual(['name']); // Phase 1.6: only a name column is required
    expect(res.body.error.details.headersFound).toEqual(['Thing', 'Where', 'How many']);
    expect(count()).toBe(0);
  });

  it('name + location columns without codes are enough (Phase 1.6: codes are optional)', async () => {
    const res = await upload(app, csv([['Name', 'Location'], ['Tent', 'R1']]), 'a.csv');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 0 });
    expect(res.body.preview[0]).toMatchObject({ code: null, name: 'Tent', locationCode: 'R01' });
  });
});

describe('POST /api/import - separate rack / shelf / bin columns', () => {
  it('are combined into a location', async () => {
    const file = await xlsx([
      ['Code', 'Name', 'Rack', 'Shelf', 'Bin'],
      ['A1', 'a', 'R03', 'B', 2],
      ['A2', 'a', 3, 'c', 4],
      ['A3', 'a', 'r5', 'a', ''],
      ['A4', 'a', '6', '', ''],
      ['A5', 'a', 'Rack 2', 'D', '01'],
      ['A6', 'a', '', '', ''],
    ]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 6, skipped: 0, errors: [] });
    expect(res.body.columns).toMatchObject({ rack: 2, shelf: 3, bin: 4 });
    const loc = (c) => { const r = byCode(c); return [r.location_code, r.rack, r.shelf, r.bin]; };
    expect(loc('A1')).toEqual(['R03-B-2', 'R03', 'B', 2]);
    expect(loc('A2')).toEqual(['R03-C-4', 'R03', 'C', 4]);
    expect(loc('A3')).toEqual(['R05-A', 'R05', 'A', null]);
    expect(loc('A4')).toEqual(['R06', 'R06', null, null]);
    expect(loc('A5')).toEqual(['R02-D-1', 'R02', 'D', 1]);
    expect(loc('A6')).toEqual([null, null, null, null]);
  });

  it('Malay rak / tingkat / petak headers', async () => {
    const res = await upload(app, csv([['Kod', 'Nama', 'Rak', 'Tingkat', 'Petak'], ['A1', 'a', '4', 'b', '3']]), 'a.csv', real);
    expect(res.body.columns).toMatchObject({ rack: 2, shelf: 3, bin: 4 });
    expect(byCode('A1').location_code).toBe('R04-B-3');
  });

  it('shelf/bin without a rack are kept as text with a warning', async () => {
    const res = await upload(app, csv([['Code', 'Name', 'Rack', 'Shelf', 'Bin'], ['A1', 'a', '', 'B', '2']]), 'a.csv', real);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ row: 2 });
    expect(res.body.errors[0].message).toMatch(/^Warning:/);
    expect(byCode('A1')).toMatchObject({ location_code: 'B-2', rack: null });
  });

  it('a Location column wins over rack/shelf/bin columns when filled', async () => {
    const res = await upload(app, csv([
      ['Code', 'Name', 'Location', 'Rack', 'Shelf', 'Bin'],
      ['A1', 'a', 'R1-A-1', '9', 'D', '9'],
      ['A2', 'a', '', '9', 'D', '9'],
    ]), 'a.csv', real);
    expect(res.body.created).toBe(2);
    expect(byCode('A1').location_code).toBe('R01-A-1');
    expect(byCode('A2').location_code).toBe('R09-D-9');
  });
});

describe('POST /api/import - values', () => {
  it('condition mapping incl. Malay; unknown -> good + warning (row still imported)', async () => {
    // Phase 1.6: condition becomes counts (quantity defaults to 1 without a Qty column):
    // good -> good 1 / bad 0; any other recognised condition -> good 0 / bad 1; blank or unknown -> not counted.
    const G = { good_qty: 1, bad_qty: 0 };
    const B = { good_qty: 0, bad_qty: 1 };
    const N = { good_qty: null, bad_qty: null };
    const conds = [
      ['good', G], ['Baik', G], ['OK', G],
      ['repair', B], ['Needs Repair', B], ['rosak sikit', B],
      ['damaged', B], ['Rosak', B],
      ['written off', B], ['Lupus', B],
      ['', N], ['excellent', N],
    ];
    const file = await xlsx([['Code', 'Name', 'Keadaan'], ...conds.map(([c], i) => [`C${i}`, 'x', c])]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(conds.length);
    expect(res.body.skipped).toBe(0);
    conds.forEach(([, expected], i) => expect(byCode(`C${i}`)).toMatchObject(expected));
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].row).toBe(conds.length + 1);
    expect(res.body.errors[0].message).toMatch(/^Warning:.*excellent/);
  });

  it('rows missing code or name are skipped with an error; blank rows ignored', async () => {
    const file = await xlsx([
      HEADER,
      ['A1', 'ok'],
      [],                                  // blank row (row 3) -> ignored
      ['', 'no code'],                     // row 4
      ['A2', ''],                          // row 5
      [null, null, 'Tents'],               // row 6: missing both
      ['  ', '  '],                        // row 7: whitespace only -> blank, ignored
      ['A3', 'ok too'],                    // row 8
    ]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(200);
    // Phase 1.6: row 4 (name, no code) is imported now; only rows without a name are errors
    expect(res.body).toMatchObject({ created: 3, updated: 0, skipped: 2 });
    // (rows 2, 4 and 8 also get "Warning: quantity missing": the Quantity column exists but is blank)
    const rowErrors = res.body.errors.filter((e) => !e.message.startsWith('Warning:'));
    expect(rowErrors.map((e) => e.row)).toEqual([5, 6]);
    expect(rowErrors[0].message).toMatch(/name/i);
    expect(rowErrors[1].message).toMatch(/name/i);
    expect(res.body.errors.filter((e) => e.message === 'Warning: quantity missing').map((e) => e.row)).toEqual([2, 4, 8]);
    expect(res.body.preview.map((p) => p.row)).toEqual([2, 4, 8]);
    expect(count()).toBe(3);
  });

  // Phase 1.6: an unreadable or missing quantity on a NEW item means "not counted" (null), with a warning
  it('quantity: "5 pcs" -> 5 + unit, bad quantity -> warning and null, too large -> row error', async () => {
    const file = await xlsx([
      ['Code', 'Name', 'Qty'],
      ['Q1', 'a', '5 pcs'],
      ['Q2', 'a', 'lots'],
      ['Q3', 'a', -2],
      ['Q4', 'a', 2.5],
      ['Q5', 'a', '1,200'],
      ['Q6', 'a', 5_000_000],
      ['Q7', 'a', ''],
    ]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(byCode('Q1')).toMatchObject({ quantity: 5, unit: 'pcs' });
    expect(byCode('Q2').quantity).toBeNull();
    expect(byCode('Q3').quantity).toBeNull();
    expect(byCode('Q4').quantity).toBeNull();
    expect(byCode('Q5').quantity).toBe(1200);
    expect(byCode('Q6')).toBeUndefined();
    expect(byCode('Q7').quantity).toBeNull();
    expect(res.body.skipped).toBe(1);
    const warnRows = res.body.errors.filter((e) => e.message.startsWith('Warning:')).map((e) => e.row);
    expect(warnRows).toEqual([3, 4, 5, 8]); // row 8: quantity missing
    expect(res.body.errors.find((e) => e.row === 7).message).not.toMatch(/^Warning:/);
  });

  it('odd location is kept as text with a warning', async () => {
    const res = await upload(app, csv([['Code', 'Name', 'Location'], ['A1', 'a', 'Store cupboard']]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 1, skipped: 0 });
    expect(res.body.errors[0].message).toMatch(/^Warning:/);
    expect(byCode('A1')).toMatchObject({ location_code: 'Store cupboard', rack: null, shelf: null, bin: null });
  });

  it('too-long code / name -> row error, skipped', async () => {
    const res = await upload(app, csv([['Code', 'Name'], ['A'.repeat(51), 'a'], ['B1', 'x'.repeat(201)], ['C1', 'fine']]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 1, skipped: 2 });
    expect(res.body.errors.map((e) => e.row)).toEqual([2, 3]);
  });

  it('rich text, formula and hyperlink cells are flattened', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Items');
    ws.addRow(['Code', 'Name', 'Quantity', 'Notes']);
    ws.getCell('A2').value = { richText: [{ text: 'RT-' }, { font: { bold: true }, text: '001' }] };
    ws.getCell('B2').value = { text: 'Linked tent', hyperlink: 'https://example.com' };
    ws.getCell('C2').value = { formula: '2+3', result: 5 };
    ws.getCell('D2').value = { formula: 'NA()', result: { error: '#N/A' } };
    const res = await upload(app, Buffer.from(await wb.xlsx.writeBuffer()), 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(byCode('RT-001')).toMatchObject({ name: 'Linked tent', quantity: 5, notes: '' });
  });

  it('numeric code cells become strings', async () => {
    const res = await upload(app, await xlsx([['Code', 'Name'], [1001, 'Numbered thing']]), 'a.xlsx', real);
    expect(res.body.created).toBe(1);
    expect(byCode('1001').name).toBe('Numbered thing');
  });

  it('same code twice in a file: later row wins, with a warning', async () => {
    const file = csv([['Code', 'Name', 'Qty'], ['A1', 'first', '1'], ['a1', 'second', '2']]);
    const dry = await upload(app, file, 'a.csv');
    const res = await upload(app, file, 'a.csv', real);
    for (const r of [dry, res]) {
      expect(r.body.skipped).toBe(0);
      expect(r.body.errors).toHaveLength(1);
      expect(r.body.errors[0]).toMatchObject({ row: 3 });
      expect(r.body.errors[0].message).toMatch(/^Warning:/);
    }
    expect(dry.body.created + dry.body.updated).toBe(res.body.created + res.body.updated);
    expect(count()).toBe(1);
    expect(byCode('A1')).toMatchObject({ name: 'Second', quantity: 2 }); // Phase 1.6 tidy: first letter capitalised
  });

  it('errors are sorted by row', async () => {
    const res = await upload(app, csv([
      ['Code', 'Name', 'Location', 'Condition'],
      ['A1', 'a', 'cupboard', 'meh'],
      ['', 'b', '', ''],
      ['A3', 'c', 'R1', 'huh'],
    ]), 'a.csv');
    const rows = res.body.errors.map((e) => e.row);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    expect(rows).toEqual([2, 2, 4]); // Phase 1.6: row 3 (name without code) is no longer an error
  });

  it('preview holds only the first 20 rows; counts cover all rows', async () => {
    const rows = [['Code', 'Name']];
    for (let i = 1; i <= 25; i++) rows.push([`P-${String(i).padStart(2, '0')}`, `Item ${i}`]);
    const res = await upload(app, await xlsx(rows), 'a.xlsx', real);
    expect(res.body.created).toBe(25);
    expect(res.body.preview).toHaveLength(20);
    expect(res.body.preview[0].row).toBe(2);
    expect(res.body.preview[19].row).toBe(21);
    expect(count()).toBe(25);
  });
});

describe('POST /api/import - upsert by code', () => {
  let existing;
  beforeEach(async () => {
    [existing] = await createItems(app, [{
      code: 'TNT-004', name: 'Old tent', category: 'Tents', locationCode: 'R01-A-1', quantity: 6,
      unit: 'tents', condition: 'damaged', notes: 'keep me',
    }]);
  });

  it('matches existing code case-insensitively and updates in place', async () => {
    const res = await upload(app, csv([['Code', 'Name', 'Location'], ['tnt-004', 'New tent', 'R2-B-3']]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    expect(res.body.preview[0]).toMatchObject({ action: 'update', id: existing.id, code: 'TNT-004' });
    expect(count()).toBe(1);
    const item = (await request(app).get(`/api/items/${existing.id}`)).body;
    expect(item).toMatchObject({ name: 'New tent', locationCode: 'R02-B-3', rack: 'R02', shelf: 'B', bin: 3 });
  });

  it('only overwrites fields whose column exists in the file', async () => {
    await upload(app, csv([['Code', 'Name'], ['TNT-004', 'Renamed']]), 'a.csv', real);
    const item = (await request(app).get(`/api/items/${existing.id}`)).body;
    expect(item).toMatchObject({
      name: 'Renamed', category: 'Tents', locationCode: 'R01-A-1', rack: 'R01', quantity: 6,
      unit: 'tents', goodQty: 0, badQty: 6, status: 'attention', notes: 'keep me', createdAt: existing.createdAt, // condition damaged -> counts
    });
  });

  it('dry run update preview shows the merged item but DB stays unchanged', async () => {
    const res = await upload(app, csv([['Code', 'Name', 'Qty'], ['TNT-004', 'Renamed', '9']]), 'a.csv');
    expect(res.body).toMatchObject({ dryRun: true, created: 0, updated: 1 });
    expect(res.body.preview[0]).toMatchObject({ action: 'update', id: existing.id, name: 'Renamed', quantity: 9, notes: 'keep me', locationCode: 'R01-A-1' });
    expect((await request(app).get(`/api/items/${existing.id}`)).body).toEqual(existing);
  });

  it('a bad quantity on an existing item leaves its quantity unchanged', async () => {
    await upload(app, csv([['Code', 'Name', 'Qty'], ['TNT-004', 'Old tent', 'many']]), 'a.csv', real);
    expect(byCode('TNT-004').quantity).toBe(6);
  });

  it('re-importing the same file is idempotent (second time = all unchanged)', async () => {
    // Rows that change nothing are counted as `unchanged`, not `updated` (lead nit: no-op re-import).
    const file = csv([['Code', 'Name'], ['TNT-004', 'Old tent'], ['NEW-1', 'New']]);
    const first = await upload(app, file, 'a.csv', real);
    const second = await upload(app, file, 'a.csv', real);
    expect(first.body).toMatchObject({ created: 1, updated: 0, unchanged: 1 });
    expect(second.body).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(count()).toBe(2);
  });
});

describe('POST /api/import - transaction', () => {
  it('a failure mid-import rolls back every row (creates and updates)', async () => {
    await createItems(app, [{ code: 'KEEP', name: 'Original', quantity: 3 }]);
    // Make the DB itself fail on the 3rd row, simulating an unexpected error during the write.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON items WHEN NEW.name = 'BOOM'
             BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await upload(app, csv([
      ['Code', 'Name', 'Qty'],
      ['KEEP', 'Changed', '99'],
      ['NEW-1', 'First new', '1'],
      ['NEW-2', 'BOOM', '1'],
      ['NEW-3', 'After', '1'],
    ]), 'a.csv', real);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expectErrorShape(expect, res.body);
    expect(count()).toBe(1);
    expect(byCode('KEEP')).toMatchObject({ name: 'Original', quantity: 3 });
    expect(byCode('NEW-1')).toBeUndefined();
  });
});

describe('POST /api/import - CSV specifics', () => {
  it('semicolon-delimited CSV with BOM, CRLF and quoted fields', async () => {
    const text = '﻿Kod;Nama;Lokasi;Catatan\r\nA1;"Khemah; besar";R3 B 2;"Line1\nLine2"\r\nA2;Tali;R1;\r\n';
    const res = await upload(app, Buffer.from(text, 'utf8'), 'stor.csv', real);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, skipped: 0 });
    expect(byCode('A1')).toMatchObject({ name: 'Khemah; besar', location_code: 'R03-B-2', notes: 'Line1\nLine2' });
  });

  it('tab-delimited', async () => {
    const res = await upload(app, Buffer.from('Code\tName\tQty\nA1\tTent\t4\n'), 'a.csv', real);
    expect(res.body.created).toBe(1);
    expect(byCode('A1').quantity).toBe(4);
  });

  it('Windows-1252 encoded CSV (legacy Excel export)', async () => {
    const latin = Buffer.concat([Buffer.from('Code,Name\nA1,Caf'), Buffer.from([0xe9]), Buffer.from(' kettle\n')]);
    const res = await upload(app, latin, 'a.csv', real);
    expect(res.body.created).toBe(1);
    expect(byCode('A1').name).toBe('Café kettle');
  });

  it('.CSV extension in upper case is accepted', async () => {
    const res = await upload(app, csv([['Code', 'Name'], ['A1', 'a']]), 'ITEMS.CSV');
    expect(res.status).toBe(200);
  });

  it('blank lines in CSV are ignored and row numbers match file lines', async () => {
    const res = await upload(app, Buffer.from('Code,Name\n\nA1,a\n,,\n,b\n'), 'a.csv');
    // Phase 1.6: ",b" (name, no code) is an item now
    expect(res.body.created).toBe(2);
    expect(res.body.preview.map((p) => p.row)).toEqual([3, 5]);
    expect(res.body.errors).toEqual([]);
  });
});

describe('POST /api/import - workbook specifics', () => {
  it('uses the first visible sheet that has code + name headers', async () => {
    const file = await xlsx([
      { name: 'Hidden', state: 'hidden', rows: [['Code', 'Name'], ['H1', 'hidden']] },
      { name: 'Cover', rows: [['Troop store'], ['Prepared by QM']] },
      { name: 'Items', rows: [['Code', 'Name'], ['V1', 'visible']] },
    ]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(byCode('V1')).toBeTruthy();
    expect(byCode('H1')).toBeUndefined();
  });

  it('empty workbook -> 400', async () => {
    const res = await upload(app, await xlsx([[]]), 'a.xlsx');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('header only -> 200 with nothing to do', async () => {
    const res = await upload(app, await xlsx([HEADER]), 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, updated: 0, skipped: 0, errors: [], preview: [] });
  });
});

describe('POST /api/import - file validation', () => {
  it('no file -> 400', async () => {
    const res = await request(app).post('/api/import?dryRun=false');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('multipart without the "file" field -> 400', async () => {
    const res = await request(app).post('/api/import').field('foo', 'bar');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('file in the wrong field -> 400', async () => {
    const res = await request(app).post('/api/import').attach('upload', csv([['Code', 'Name'], ['A', 'b']]), 'a.csv');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it.each(['items.txt', 'items.xls', 'items.pdf', 'items', 'items.json'])('wrong type %s -> 400', async (name) => {
    const res = await upload(app, csv([['Code', 'Name'], ['A', 'b']]), name, real);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(count()).toBe(0);
  });

  it('.xls gets a "Save As .xlsx" hint', async () => {
    const res = await upload(app, Buffer.from('dummy'), 'old.xls');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/xlsx/);
  });

  it('.xlsx that is really text -> 400', async () => {
    const res = await upload(app, Buffer.from('Code,Name\nA,b\n'), 'fake.xlsx', real);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('.xlsx with a zip signature but corrupt -> 400', async () => {
    const res = await upload(app, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]), 'bad.xlsx');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('empty .csv -> 400', async () => {
    const res = await upload(app, Buffer.alloc(0), 'empty.csv');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('file over 5 MB -> 413 and nothing written', async () => {
    const big = Buffer.concat([Buffer.from('Code,Name\nA1,a\n'), Buffer.alloc(5 * 1024 * 1024 + 10, 0x20)]);
    let res;
    try {
      res = await upload(app, big, 'big.csv', real);
    } catch (err) {
      // The server may answer before the client finished sending; that's still a rejection.
      if (!['ECONNRESET', 'EPIPE'].includes(err.code)) throw err;
    }
    if (res) {
      expect(res.status).toBe(413);
      expectErrorShape(expect, res.body);
    }
    expect(count()).toBe(0);
  });

  it('file just under 5 MB is accepted', async () => {
    const head = 'Code,Name,Padding\nA1,a,';
    const filler = Buffer.alloc(5 * 1024 * 1024 - head.length - 100, 0x78); // one huge ignored cell
    const res = await upload(app, Buffer.concat([Buffer.from(head), filler, Buffer.from('\n')]), 'ok.csv');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 0, ignoredColumns: ['Padding'] });
  });

  it('more than 20,000 data rows -> 400', async () => {
    const lines = ['Code,Name'];
    for (let i = 0; i < 20_001; i++) lines.push(`C${i},n`);
    const res = await upload(app, Buffer.from(lines.join('\n')), 'many.csv', real);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(count()).toBe(0);
  });
});

describe('GET /api/import/template', () => {
  it('downloads item-template.xlsx that is a valid workbook with header + 2 example rows', async () => {
    const res = await request(app).get('/api/import/template').buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/attachment;\s*filename="item-template\.xlsx"/);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.subarray(0, 2).toString('latin1')).toBe('PK');

    const wb = await readXlsx(res.body);
    const ws = wb.worksheets[0];
    const header = ws.getRow(1).values.slice(1);
    // Phase 1.6 template columns
    expect(header).toEqual(['Location', 'Item description', 'Quantity', 'Unit', 'Good', 'Bad', 'Brand', 'Model', 'Barcode', 'Notes']);
    let dataRows = 0;
    ws.eachRow((row, n) => { if (n > 1 && row.getCell(1).value) dataRows++; });
    expect(dataRows).toBe(2);
  });

  it('the template imports cleanly (round trip)', async () => {
    const tpl = await request(app).get('/api/import/template').buffer(true).parse(binaryParser);
    const res = await upload(app, tpl.body, 'item-template.xlsx');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, created: 2, updated: 0, skipped: 0, errors: [], headerRow: 1 });
    expect(res.body.preview.map((p) => p.locationCode)).toEqual(['EX0101', 'EX0102']); // Phase 1.6 example rows
    expect(res.body.preview[0]).toMatchObject({ quantity: 4, goodQty: 3, badQty: 1, status: 'attention' });
    expect(res.body.preview[1]).toMatchObject({ quantity: 1, unit: 'box', goodQty: 1 });
    expect(count()).toBe(0);
  });
});
