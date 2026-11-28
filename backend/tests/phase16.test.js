// Phase 1.6 (docs/SPEC.md "Phase 1.6"): location scheme v2, compartments + rack layout, item fields v4,
// migration v4, import of the troop's real format, search/scan by location, new seed + template.
// Workbooks here are GENERATED with the same structure as the real file (no real rows are copied).
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import Database from 'better-sqlite3';
import { makeApp, createItems, upload, allItems, tmpDir, expectItemShape, expectErrorShape, binaryParser, readXlsx } from './helpers.js';
import { parseLocation, normalizeRack, formatV2, describeLocation } from '../src/lib/location.js';
import { parseQuantityText } from '../src/lib/quantityText.js';
import { applyCorrections, cleanCell, CORRECTIONS } from '../src/lib/corrections.js';
import { codeColumnIsLocation } from '../src/lib/importRows.js';
import { matchItems } from '../src/lib/scanMatch.js';
import { openDb } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { SEED_ITEMS, SEED_EMPTY_COMPARTMENTS } from '../scripts/seed.js';

const real = { dryRun: 'false' };
const names = (res) => res.body.items.map((i) => i.name);

// ---------------------------------------------------------------------------------------------
describe('A. location scheme v2', () => {
  const v2 = (locationCode, rack, level, compartment) => ({ locationCode, rack, level, compartment, shelf: null, bin: null });
  it.each([
    ['AU0305', v2('AU0305', 'AU', 3, 5)], ['au0305', v2('AU0305', 'AU', 3, 5)], ['AU 03 05', v2('AU0305', 'AU', 3, 5)],
    ['AU-03-05', v2('AU0305', 'AU', 3, 5)], ['AU-3-5', v2('AU0305', 'AU', 3, 5)], ['AU/03/05', v2('AU0305', 'AU', 3, 5)],
    ['Rack AU level 3 compartment 5', v2('AU0305', 'AU', 3, 5)], ['AU 0305', v2('AU0305', 'AU', 3, 5)],
    ['AU–03–05', v2('AU0305', 'AU', 3, 5)], ['A0112', v2('A0112', 'A', 1, 12)], ['ABC9901', v2('ABC9901', 'ABC', 99, 1)],
    ['AU03', v2('AU03', 'AU', 3, null)], ['AU', v2('AU', 'AU', null, null)], ['Rack AU', v2('AU', 'AU', null, null)],
    ['RACK AX', v2('AX', 'AX', null, null)], ['R1234', v2('R1234', 'R', 12, 34)],
  ])('%j', (input, expected) => {
    expect(parseLocation(input)).toEqual(expected);
  });

  it('legacy R03-B-2 still works (v2 first, then legacy)', () => {
    expect(parseLocation('R03-B-2')).toEqual({ locationCode: 'R03-B-2', rack: 'R03', level: null, compartment: null, shelf: 'B', bin: 2 });
    expect(parseLocation('R03').rack).toBe('R03');
    expect(parseLocation('3-b-2').locationCode).toBe('R03-B-2');
  });

  it.each(['au', 'box', 'Hut', 'AU0000', 'AU0005', 'AU00', 'ABCD0305', 'AU 3', 'Box 12', 'tent'])('%j is kept as text', (input) => {
    expect(parseLocation(input)).toMatchObject({ locationCode: input, rack: null });
  });

  it('bare lower-case rack ids only when asked (search)', () => {
    expect(parseLocation('au', { allowBareRack: true }).rack).toBe('AU');
  });

  it('formatV2 / describeLocation / normalizeRack', () => {
    expect(formatV2('AU', 3, 5)).toBe('AU0305');
    expect(formatV2('AU', 3)).toBe('AU03');
    expect(describeLocation(parseLocation('AU0305'))).toBe('Rack AU · Level 3 · Compartment 05');
    expect(normalizeRack('au')).toBe('AU');
    expect(normalizeRack('AU0305')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('C. item fields v4', () => {
  let app;
  beforeEach(() => ({ app } = makeApp()));
  const post = (body) => request(app).post('/api/items').send(body);

  it.each([
    [{ quantity: 5, goodQty: 5 }, 'ok', false],
    [{ quantity: 5, goodQty: 4, badQty: 1 }, 'attention', false],
    [{ quantity: 5, goodQty: 0, badQty: 0 }, 'unchecked', true],
    [{ quantity: 5 }, 'unchecked', false],
    [{ quantity: 2, goodQty: 0, badQty: 4 }, 'attention', true],
    [{ quantity: null, goodQty: 3, badQty: 1 }, 'attention', false],
    [{ quantity: 4, goodQty: 4, badQty: null }, 'ok', false],
  ])('%j -> status %s, countsMismatch %s', async (fields, status, mismatch) => {
    const res = await post({ name: 'Tent', ...fields });
    expect(res.status).toBe(201);
    expectItemShape(expect, res.body);
    expect(res.body).toMatchObject({ status, countsMismatch: mismatch });
  });

  it('quantity null = not counted; absent quantity defaults to 1', async () => {
    expect((await post({ name: 'a', quantity: null })).body.quantity).toBeNull();
    expect((await post({ name: 'b' })).body.quantity).toBe(1);
  });

  it('code is optional and unique only when present', async () => {
    expect((await post({ name: 'a' })).status).toBe(201);
    expect((await post({ name: 'b' })).status).toBe(201);
    expect((await post({ name: 'c', code: 'K1' })).status).toBe(201);
    expect((await post({ name: 'd', code: 'k1' })).status).toBe(409);
  });

  it('contents: list of { name, quantity }, stored and returned; validated', async () => {
    const res = await post({ name: 'Patrol Box', contents: [{ name: 'Parang', quantity: 2 }, { name: 'Pot' }] });
    expect(res.body.contents).toEqual([{ name: 'Parang', quantity: 2 }, { name: 'Pot', quantity: null }]);
    const put = await request(app).put(`/api/items/${res.body.id}`).send({ contents: [] });
    expect(put.body.contents).toEqual([]);
    for (const contents of ['x', [{ quantity: 1 }], [{ name: 'a', quantity: -1 }], Array(101).fill({ name: 'a' })]) {
      expect((await post({ name: 'k', contents })).status).toBe(400);
    }
  });

  it('PUT with the retired condition maps to counts using the item quantity', async () => {
    const { body } = await post({ name: 'Tent', quantity: 4, goodQty: 4 });
    expect((await request(app).put(`/api/items/${body.id}`).send({ condition: 'written_off' })).body)
      .toMatchObject({ goodQty: 0, badQty: 4, status: 'attention', notes: 'Written off' });
    // explicit counts win over condition
    expect((await request(app).put(`/api/items/${body.id}`).send({ condition: 'good', goodQty: 1, badQty: 3 })).body)
      .toMatchObject({ goodQty: 1, badQty: 3 });
  });

  it('status filter; condition filter is retired (400)', async () => {
    await createItems(app, [
      { name: 'Ok one', quantity: 2, goodQty: 2 }, { name: 'Bad one', quantity: 2, goodQty: 1, badQty: 1 }, { name: 'New one' },
    ]);
    const q = (query) => request(app).get('/api/items').query(query);
    expect(names(await q({ status: 'attention' }))).toEqual(['Bad one']);
    expect(names(await q({ status: 'ok' }))).toEqual(['Ok one']);
    expect(names(await q({ status: 'unchecked' }))).toEqual(['New one']);
    const res = await q({ condition: 'good' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Invalid query/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('B. compartments and rack layout', () => {
  let app, publicApp, db;
  beforeEach(async () => {
    ({ app, publicApp, db } = makeApp());
    await createItems(app, [
      { name: 'Parang', locationCode: 'AU0305' }, { name: 'Saw', locationCode: 'au 03 05' },
      { name: 'Axe', locationCode: 'AU0306' }, { name: 'Dome tent', locationCode: 'AU0101' },
      { name: 'Spare box', locationCode: 'AU03' }, { name: 'Whole rack', locationCode: 'AU' },
      { name: 'Old style', code: 'OLD-1', locationCode: 'R03-B-2' }, { name: 'Loose' },
    ]);
    // empty compartments come from imports (or saved items that later moved)
    await upload(app, Buffer.from('Location,Item description\nAU0307,\nAU0201,\nAX0101,\n'), 'empty.csv', real);
  });

  it('GET /api/racks: v2 counts incl. empty compartments; legacy racks keep shelves; sorted by rack id', async () => {
    const res = await request(publicApp).get('/api/racks');
    expect(res.body).toEqual({
      racks: [
        { rack: 'AU', levels: 3, compartments: 5, emptyCompartments: 2, itemCount: 6 },
        { rack: 'AX', levels: 1, compartments: 1, emptyCompartments: 1, itemCount: 0 },
        { rack: 'R03', levels: 1, compartments: 1, emptyCompartments: 0, itemCount: 1, shelves: ['B'] },
      ],
      unlocated: 1,
    });
  });

  it('GET /api/racks/AU: levels top first (01 last), compartments ascending, empty ones with items []', async () => {
    const res = await request(publicApp).get('/api/racks/au');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['levels', 'rack', 'unshelved']);
    expect(res.body.levels.map((l) => l.level)).toEqual([3, 2, 1]);
    const shape = res.body.levels.map((l) => [l.level, l.compartments.map((c) => [c.code, c.compartment, c.items.map((i) => i.name)])]);
    expect(shape).toEqual([
      [3, [['AU0305', 5, ['Parang', 'Saw']], ['AU0306', 6, ['Axe']], ['AU0307', 7, []]]],
      [2, [['AU0201', 1, []]]],
      [1, [['AU0101', 1, ['Dome tent']]]],
    ]);
    expect(res.body.unshelved.map((i) => i.name).sort()).toEqual(['Spare box', 'Whole rack']);
    res.body.levels[0].compartments[0].items.forEach((i) => expectItemShape(expect, i));
  });

  it('a rack with only empty compartments is still shown; unknown rack 404', async () => {
    expect((await request(publicApp).get('/api/racks/AX')).body.levels).toEqual([{ level: 1, compartments: [{ code: 'AX0101', compartment: 1, items: [] }] }]);
    expect((await request(publicApp).get('/api/racks/ZZ')).status).toBe(404);
  });

  it('DELETE /api/compartments/:code: leader only; empty -> 204; with items -> 409; unknown 404; not a code 400', async () => {
    expect((await request(publicApp).delete('/api/compartments/AU0307')).status).toBe(401);
    expect((await request(app).delete('/api/compartments/AU0305')).status).toBe(409);
    expect((await request(app).delete('/api/compartments/au0307')).status).toBe(204);
    expect((await request(app).delete('/api/compartments/AU0307')).status).toBe(404);
    const bad = await request(app).delete('/api/compartments/R03-B-2');
    expect(bad.status).toBe(400);
    expectErrorShape(expect, bad.body);
    expect(db.prepare('SELECT code FROM compartments ORDER BY code').all().map((r) => r.code)).toEqual(['AU0101', 'AU0201', 'AU0305', 'AU0306', 'AX0101']);
  });

  it('saving an item registers its compartment', async () => {
    const [it] = await createItems(app, [{ name: 'New', locationCode: 'AY0412' }]);
    await request(app).put(`/api/items/${it.id}`).send({ locationCode: 'AY0411' });
    expect(db.prepare("SELECT code FROM compartments WHERE rack = 'AY' ORDER BY code").all().map((r) => r.code)).toEqual(['AY0411', 'AY0412']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('migration v4 on a populated v3 database', () => {
  it('counts from condition, written-off note, nullable code/quantity, compartments, ids kept', () => {
    const file = path.join(tmpDir(), 'v3.db');
    const db3 = new Database(file);
    db3.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of migrations.filter((x) => x.version <= 3)) {
      if (m.up) m.up(db3, { warn() {} });
      else db3.exec(m.sql);
      db3.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(m.version, m.name, 'x');
    }
    const ins = db3.prepare(`INSERT INTO items (id, code, name, location_code, rack, shelf, bin, quantity, condition, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'c', 'u')`);
    ins.run(7, 'A', 'Good tent', 'R03-B-2', 'R03', 'B', 2, 4, 'good', '');
    ins.run(9, 'B', 'Broken tent', 'AU0305', null, null, null, 3, 'damaged', 'zip');
    ins.run(12, 'C', 'Old flag', null, null, null, null, 2, 'written_off', 'torn');
    ins.run(13, 'D', 'Pot', 'Store', null, null, null, 1, 'needs_repair', '');
    db3.close();

    const db = openDb(file);
    const rows = Object.fromEntries(db.prepare('SELECT * FROM items').all().map((r) => [r.code, r]));
    expect(rows.A).toMatchObject({ id: 7, good_qty: 4, bad_qty: 0, rack: 'R03', shelf: 'B', bin: 2, level: null });
    expect(rows.B).toMatchObject({ id: 9, good_qty: 0, bad_qty: 3, location_code: 'AU0305', rack: 'AU', level: 3, compartment: 5 });
    expect(rows.C).toMatchObject({ id: 12, good_qty: 0, bad_qty: 2, notes: 'torn Written off' });
    expect(rows.D).toMatchObject({ good_qty: 0, bad_qty: 1, rack: null });
    expect(db.prepare('SELECT code FROM compartments').all()).toEqual([{ code: 'AU0305' }]);
    db.prepare("INSERT INTO items (name, quantity, created_at, updated_at) VALUES ('no code', NULL, 'x', 'x')").run();
    db.prepare("INSERT INTO items (name, created_at, updated_at) VALUES ('no code 2', 'x', 'x')").run();
    expect(db.prepare('SELECT MAX(version) v FROM schema_version').get().v).toBe(migrations.at(-1).version);
    db.close();
    openDb(file).close(); // no-op
  });
});

// ---------------------------------------------------------------------------------------------
/** A workbook with the STRUCTURE of the troop's real "QM List" (invented rows). */
async function realFormatWorkbook({ withKit = true } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Overall List');
  const rows = [
    [null, 'CODE ', 'ITEM DESCRIPTION', 'QUANTITY', 'GOOD CONDITION', 'BAD CONDITION'], // 1
    [null, 'RACK BQ'], // 2 section
    [null, 'BQ0101', 'Tarp', '4', 4], // 3
    [null, 'BQ0102', 'Patrol Box', '1', 1], // 4
    [null, 'BQ0103', 'Patrol Box', '2', 2], // 5
    [null, 'BQ0204', 'Lantern', '2', null, 4], // 6 counts don't add up
    [null, 'BQ0305', 'Mallet', '5', 5], // 7 shared compartment
    [null, 'BQ0305', 'pegs', 'a box', 'a box'], // 8 shared, lower-case name, text qty
    [null, 'bq0306', ' tent  spare part', '1 box', '1 box'], // 9 lower-case code, spaces
    [null, 'BQ0307'], // 10 empty compartment
    [null, 'RACK BR'], // 11 section
    [null, 'BR0101', 'plank '], // 12 quantity missing
    [null, 'BR0102', 'brick ', '2 box(24)', '2 box(24)'], // 13 bracket
    [null, 'BR0103', 'mosquito repenllent', '3 small box', '3 small bax'], // 14 typos
    [null, 'BR0104', 'gas', '2 box', '2 box'], // 15
    [null, 'BR0104', 'gas stove', '2', 2], // 16
    [null, 'BR0104', 'gas', '2 box', '2 box'], // 17 duplicate row
    [null, 'BR0105', 'plastic fox nad spoon', '2 pack', '2 pack'], // 18
    [null, 'BR0106', 'bid ladle', 1, 1], // 19 numeric cells
    [null, 'BR0107', 'safety vase', '30', 30], // 20
    [null, 'BR0108', 'Rope', 'lots', 'lots'], // 21 unparseable
    [null, 'BR0209'], // 22 empty
    [null, 'RACK BS'], // 23
    [null, 'BS0101'], // 24 empty
  ];
  rows.forEach((r, i) => r.forEach((v, c) => { if (v !== null && v !== undefined) ws.getCell(i + 1, c + 1).value = v; }));
  if (withKit) {
    const kit = wb.addWorksheet('Patrol Box');
    [[], [], [null, 'Patrol Box', 'Item Description', 'Quantity', 'Condition'],
      [null, 1, 'Parang', 2], [null, 2, 'Saw', 2], [null, 3, 'pot', 1], [null, 4, 'frying pan', 1], [null, 5, 'gas stove', 2]]
      .forEach((r, i) => r.forEach((v, c) => { if (v !== null && v !== undefined) kit.getCell(i + 1, c + 1).value = v; }));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('D. import of the real format', () => {
  let app, db;
  beforeEach(() => ({ app, db } = makeApp()));

  it('dry run: CODE as location, sections, empty compartments, quantity text, corrections, warnings, kit', async () => {
    const res = await upload(app, await realFormatWorkbook(), 'QM List.xlsx');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: true, created: 16, updated: 0, unchanged: 0, skipped: 0, sections: 3, emptyCompartments: 3, headerRow: 1,
      columns: { location: 1, name: 2, quantity: 3, goodQty: 4, badQty: 5 },
    });
    expect(res.body.columns).not.toHaveProperty('code');
    expect(res.body.corrections).toEqual([
      { row: 14, field: 'name', from: 'mosquito repenllent', to: 'mosquito repellent' },
      { row: 14, field: 'goodQty', from: '3 small bax', to: '3 small box' },
      { row: 18, field: 'name', from: 'plastic fox nad spoon', to: 'plastic fork and spoon' },
      { row: 19, field: 'name', from: 'bid ladle', to: 'big ladle' },
      { row: 20, field: 'name', from: 'safety vase', to: 'safety vest' },
    ]);
    expect(res.body.errors).toEqual([
      { row: 6, message: "Warning: counts don't add up (quantity 2, good -, bad 4)" },
      { row: 12, message: 'Warning: quantity missing' },
      { row: 17, message: expect.stringMatching(/^Warning: duplicate row \(BR0104 Gas\) ignored — check the Excel/) },
      { row: 21, message: expect.stringMatching(/^Warning: quantity "lots" is not a whole number/) },
      { row: 21, message: expect.stringMatching(/^Warning: good count "lots" is not a number/) },
    ]);
    expect(res.body.kits).toEqual([{ name: 'Patrol Box', items: 5, appliedTo: 2 }]);
    const p = Object.fromEntries(res.body.preview.map((x) => [`${x.locationCode} ${x.name}`, x]));
    expect(p['BQ0305 Pegs']).toMatchObject({ code: null, quantity: 1, unit: 'box', goodQty: 1, badQty: null, rack: 'BQ', level: 3, compartment: 5, status: 'ok' });
    expect(p['BQ0306 Tent spare part']).toMatchObject({ locationCode: 'BQ0306', quantity: 1, unit: 'box' });
    expect(p['BQ0204 Lantern']).toMatchObject({ quantity: 2, goodQty: null, badQty: 4, status: 'attention', countsMismatch: false });
    expect(p['BR0102 Brick']).toMatchObject({ quantity: 2, unit: 'box', goodQty: 2, notes: 'Excel quantity: 2 box(24)' });
    expect(p['BR0103 Mosquito repellent']).toMatchObject({ quantity: 3, unit: 'small box', goodQty: 3 });
    expect(p['BR0101 Plank']).toMatchObject({ quantity: null, status: 'unchecked' });
    expect(p['BQ0102 Patrol Box'].contents).toEqual([
      { name: 'Parang', quantity: 2 }, { name: 'Saw', quantity: 2 }, { name: 'Pot', quantity: 1 },
      { name: 'Frying pan', quantity: 1 }, { name: 'Gas stove', quantity: 2 },
    ]);
    expect(allItems(db)).toHaveLength(0);
  });

  it('real import, then re-import changes nothing; dry run predicted the real run', async () => {
    const file = await realFormatWorkbook();
    const dry = await upload(app, file, 'qm.xlsx');
    const wet = await upload(app, file, 'qm.xlsx', real);
    const pick = (b) => ({ ...b, dryRun: undefined, preview: b.preview.map((x) => ({ ...x, id: undefined })) });
    expect(pick(wet.body)).toEqual(pick(dry.body));
    expect(allItems(db)).toHaveLength(16);
    const again = await upload(app, file, 'qm.xlsx', real);
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 16 });
    expect(allItems(db)).toHaveLength(16);
    const racks = (await request(app).get('/api/racks')).body.racks;
    expect(racks.map((r) => [r.rack, r.itemCount, r.emptyCompartments])).toEqual([['BQ', 7, 1], ['BR', 9, 1], ['BS', 0, 1]]);
    const rack = (await request(app).get('/api/racks/BQ')).body;
    expect(rack.levels.map((l) => l.level)).toEqual([3, 2, 1]);
    expect(rack.levels[0].compartments.map((c) => [c.code, c.items.length])).toEqual([['BQ0305', 2], ['BQ0306', 1], ['BQ0307', 0]]);
  });

  it('a changed count in the file updates only that item; app edits of absent fields are kept', async () => {
    await upload(app, await realFormatWorkbook({ withKit: false }), 'qm.xlsx', real);
    const tarp = (await request(app).get('/api/items').query({ q: 'tarp' })).body.items[0];
    await request(app).put(`/api/items/${tarp.id}`).send({ brand: 'Coleman', category: 'Tents' });
    const res = await upload(app, await realFormatWorkbook({ withKit: false }), 'qm.xlsx', real);
    expect(res.body).toMatchObject({ created: 0, updated: 0, unchanged: 16 });
    expect((await request(app).get(`/api/items/${tarp.id}`)).body).toMatchObject({ brand: 'Coleman', category: 'Tents' });
  });

  it('CODE stays an item code when its values are not mostly v2 locations', () => {
    const rows = (codes) => codes.map((c, i) => ({ rowNumber: i + 2, cells: [c, 'x'] }));
    expect(codeColumnIsLocation(rows(['TNT-004', 'ROP-010', 'AU0101']), { code: 0, name: 1 })).toBe(false);
    expect(codeColumnIsLocation(rows(['AU0101', 'AU0102', 'AU0103', 'AU0104', 'TNT-4']), { code: 0, name: 1 })).toBe(true);
    expect(codeColumnIsLocation(rows(['ITM-0001', 'ITM-0002']), { code: 0, name: 1 })).toBe(false);
    expect(codeColumnIsLocation(rows(['AU0101']), { code: 0, name: 1, location: 2 })).toBe(false);
  });

  it('upsert key without codes = location + folded name', async () => {
    await createItems(app, [{ name: 'Gas Stove', locationCode: 'BR0104', quantity: 1 }]);
    const res = await upload(app, Buffer.from('Location,Item description,Quantity\nbr0104,gas  stove,3\nBR0105,gas stove,1\n'), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    // the file's spelling of the name wins (tidied: spaces collapsed, first letter capitalised)
    expect(allItems(db).map((r) => [r.location_code, r.name, r.quantity])).toEqual([['BR0104', 'Gas stove', 3], ['BR0105', 'Gas stove', 1]]);
  });
});

describe('D. quantity text and corrections (pure)', () => {
  it.each([
    ['4', { quantity: 4 }], [4, { quantity: 4 }], ['a box', { quantity: 1, unit: 'box' }], ['an box', { quantity: 1, unit: 'box' }],
    ['one box', { quantity: 1, unit: 'box' }], ['1 box', { quantity: 1, unit: 'box' }], ['3 small box', { quantity: 3, unit: 'small box' }],
    ['2 pack', { quantity: 2, unit: 'pack' }], ['2 box(24)', { quantity: 2, unit: 'box', note: 'Excel quantity: 2 box(24)' }],
  ])('%j', (input, expected) => {
    expect(parseQuantityText(input)).toEqual({ ok: true, ...expected });
  });
  it.each(['lots', '', null, -1, 2.5, '0x10', 'box'])('%j is not a quantity', (input) => {
    expect(parseQuantityText(input).ok).toBe(false);
  });

  it('corrections are whole words/phrases, case-insensitive, and the list is extensible', () => {
    expect(CORRECTIONS.length).toBeGreaterThanOrEqual(5);
    expect(applyCorrections('Bax of PLASTIC FOX NAD SPOON')).toEqual({ text: 'Box of PLASTIC FORK AND SPOON', corrected: true });
    expect(applyCorrections('boxer saxophone')).toEqual({ text: 'boxer saxophone', corrected: false });
    expect(cleanCell('  axe  ', { capitalise: true })).toEqual({ value: 'Axe', correction: null });
    const rules = [{ re: /\bbrom\b/giu, to: 'broom' }];
    expect(applyCorrections('old brom', rules).text).toBe('old broom');
  });
});

// ---------------------------------------------------------------------------------------------
describe('E. search and scan by location', () => {
  let app, publicApp;
  beforeEach(async () => {
    ({ app, publicApp } = makeApp());
    await createItems(app, [
      { name: 'Parang', locationCode: 'AU0305' }, { name: 'Saw', locationCode: 'AU0305' }, { name: 'Axe', locationCode: 'AU0306' },
      { name: 'Hammer', locationCode: 'AU0406' }, { name: 'Pail', locationCode: 'AY0102' }, { name: 'Note about AU0305', notes: 'see AU0305' },
    ]);
  });
  const s = (q) => request(publicApp).get('/api/items').query({ q });

  it.each([
    // a location query also matches text that contains it ("Note about AU0305")
    ['AU0305', ['Parang', 'Saw', 'Note about AU0305']], ['au 03 05', ['Parang', 'Saw']],
    ['AU03', ['Axe', 'Parang', 'Saw', 'Note about AU0305']],
    ['AU', ['Axe', 'Hammer', 'Parang', 'Saw', 'Note about AU0305']], ['au', ['Axe', 'Hammer', 'Parang', 'Saw', 'Note about AU0305']],
    ['saw au03', ['Saw']], ['AY0102', ['Pail']],
  ])('q=%j', async (q, expected) => {
    expect(names(await s(q)).sort()).toEqual(expected.sort());
  });

  it('exact location ranks first', async () => {
    expect(names(await s('AU0305')).slice(0, 2).sort()).toEqual(['Parang', 'Saw']);
  });

  it('scan: a compartment label returns the items in that compartment', async () => {
    const res = await request(publicApp).post('/api/scan/match').send({ text: 'STORE ROOM\nAU 0305\n' });
    expect(res.body.matches.map((m) => [m.item.name, m.score, m.matchedOn])).toEqual([['Parang', 1, ['location']], ['Saw', 1, ['location']]]);
    expect(matchItems([{ name: 'x', locationCode: 'AU0305', level: 3, compartment: 5, code: null }], { text: 'AU O3O5' }).matches[0].matchedOn).toEqual(['location']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('F. seed and template', () => {
  it('demo seed: ~30 items in racks BA-BD, 3-4 levels, shared and empty compartments, bad counts, a Patrol Box kit', async () => {
    const { app } = makeApp({ seeded: 'demo' });
    expect(SEED_ITEMS.length).toBeGreaterThanOrEqual(25);
    const racks = (await request(app).get('/api/racks')).body.racks;
    expect(racks.map((r) => r.rack)).toEqual(['BA', 'BB', 'BC', 'BD']);
    for (const r of racks) expect(r.levels).toBeGreaterThanOrEqual(3);
    expect(racks.reduce((n, r) => n + r.emptyCompartments, 0)).toBe(SEED_EMPTY_COMPARTMENTS.length);
    const items = (await request(app).get('/api/items')).body.items;
    expect(items.every((i) => i.code === null)).toBe(true);
    expect(items.filter((i) => i.status === 'attention').length).toBeGreaterThanOrEqual(3);
    expect(items.find((i) => i.name === 'Patrol Box').contents.length).toBeGreaterThan(3);
    const shared = new Map();
    for (const i of items) shared.set(i.locationCode, (shared.get(i.locationCode) ?? 0) + 1);
    expect([...shared.values()].some((n) => n > 1)).toBe(true);
  });

  it('template has the Phase 1.6 columns and v2 example locations', async () => {
    const { app } = makeApp();
    const tpl = await request(app).get('/api/import/template').buffer(true).parse(binaryParser);
    const ws = (await readXlsx(tpl.body)).worksheets[0];
    expect(ws.getRow(1).values.slice(1)).toEqual(['Location', 'Item description', 'Quantity', 'Unit', 'Good', 'Bad', 'Brand', 'Model', 'Barcode', 'Notes']);
    expect(ws.getRow(2).getCell(1).value).toMatch(/^[A-Z]{2}\d{4}$/);
  });
});
