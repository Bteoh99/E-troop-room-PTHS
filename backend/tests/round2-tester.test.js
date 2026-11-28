// Round 2 (tester): regression tests for the earlier "possible issues" and docs/REVIEW-backend.md
// findings not already in round2.test.js, plus attempts to break the new code (xlsx guard,
// malformed multipart/JSON, mixed text+coordinate queries, Unicode).
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeApp, createItems, csv, xlsx, upload, allItems, expectErrorShape } from './helpers.js';
import { writeZip, rewriteZip } from './zip.js';
import { checkXlsx, XLSX_LIMITS } from '../src/lib/xlsxGuard.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = { dryRun: 'false' };
const codes = (res) => res.body.items.map((i) => i.code);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'etroop-test-'));

describe('R2 regression: blank cells and long locations on import', () => {
  let app, db, existing;
  beforeEach(async () => {
    ({ app, db } = makeApp());
    [existing] = await createItems(app, [{
      code: 'TNT-004', name: 'Tent', category: 'Tents', locationCode: 'R03-B-2', quantity: 6, unit: 'tents',
      condition: 'damaged', notes: 'Broken zip',
    }]);
  });

  it('whitespace / non-breaking-space-only cells count as blank (existing values kept)', async () => {
    const file = await xlsx([
      ['Code', 'Name', 'Category', 'Location', 'Qty', 'Unit', 'Condition', 'Notes'],
      ['TNT-004', 'Tent', '  ', '\u00a0', ' ', '\u00a0 ', '   ', '\u00a0'],
    ]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.body).toMatchObject({ created: 0, updated: 0, unchanged: 1, skipped: 0, errors: [] });
    expect((await request(app).get(`/api/items/${existing.id}`)).body).toEqual(existing);
  });

  it('a blank Condition cell never resets damaged to good (dry run and real)', async () => {
    const file = csv([['Code', 'Name', 'Keadaan'], ['TNT-004', 'Tent', '']]);
    // Phase 1.6: "damaged" is stored as counts (good 0 / bad 6); a blank cell keeps them
    expect((await upload(app, file, 'a.csv')).body.preview[0]).toMatchObject({ action: 'unchanged', goodQty: 0, badQty: 6, status: 'attention' });
    await upload(app, file, 'a.csv', real);
    expect(allItems(db)[0]).toMatchObject({ good_qty: 0, bad_qty: 6 });
  });

  it('an over-long location built from Rack/Shelf/Bin columns is a warning, row still imported', async () => {
    const res = await upload(app, csv([
      ['Code', 'Name', 'Rack', 'Shelf', 'Bin'],
      ['TNT-004', 'Tent renamed', 'x'.repeat(120), 'B', '2'],
    ]), 'a.csv', real);
    expect(res.body).toMatchObject({ updated: 1, skipped: 0 });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toMatch(/^Warning:/);
    expect(allItems(db)[0]).toMatchObject({ name: 'Tent renamed', location_code: 'R03-B-2' });
  });

  it('via the API an over-long location is still a 400 (spec)', async () => {
    const res = await request(app).put(`/api/items/${existing.id}`).send({ locationCode: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('English "Description" next to "Name" (no notes column) becomes notes', async () => {
    const res = await upload(app, csv([['Code', 'Name', 'Description'], ['D1', 'Tent', 'Green, big']]), 'a.csv', real);
    expect(res.body.columns).toEqual({ code: 0, name: 1, notes: 2 });
    expect(res.body.ignoredColumns).toEqual([]);
    expect(allItems(db).find((r) => r.code === 'D1').notes).toBe('Green, big');
  });

  it('"ID" next to "Code" is listed as a duplicate column and its values are not used as codes', async () => {
    const res = await upload(app, csv([['ID', 'Code', 'Name'], ['1', 'C1', 'Tent']]), 'a.csv', real);
    expect(res.body.ignoredColumns).toEqual(['ID (duplicate code column; "Code" is used)']);
    expect(allItems(db).map((r) => r.code).sort()).toEqual(['C1', 'TNT-004']);
  });
});

describe('R2 regression: duplicate codes and unchanged', () => {
  it('existing item edited on two rows that end where it started: unchanged AND not written', async () => {
    const { app } = makeApp();
    const [item] = await createItems(app, [{ code: 'DUP', name: 'Dup', quantity: 6 }]);
    await new Promise((r) => setTimeout(r, 5));
    const res = await upload(app, csv([['Code', 'Name', 'Qty'], ['DUP', 'Dup', '7'], ['dup', 'Dup', '6']]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    // spec: "unchanged (existing item the file leaves as is; not written, updatedAt kept)"
    expect((await request(app).get(`/api/items/${item.id}`)).body.updatedAt).toBe(item.updatedAt);
  });

  it('dry run and real run agree for a mix of create / update / unchanged / duplicate rows', async () => {
    const { app } = makeApp();
    await createItems(app, [{ code: 'U1', name: 'Same' }, { code: 'U2', name: 'Old' }]);
    const file = csv([
      ['Code', 'Name', 'Qty'],
      ['U1', 'Same', ''], ['U2', 'New', '3'], ['N1', 'New 1', '1'], ['n1', 'New 1b', ''], ['', 'x', ''],
    ]);
    const dry = await upload(app, file, 'a.csv');
    const wet = await upload(app, file, 'a.csv', real);
    const pick = (b) => ({ ...b, dryRun: undefined, preview: b.preview.map((p) => ({ ...p, id: undefined })) });
    expect(pick(wet.body)).toEqual(pick(dry.body));
    // Phase 1.6: the row without a code ("x") is an item now (codes are optional)
    expect(wet.body).toMatchObject({ created: 2, updated: 1, unchanged: 1, skipped: 0 });
    expect(wet.body.preview.map((p) => p.action)).toEqual(['unchanged', 'update', 'create', 'create']);
  });
});

describe('R2 search: coordinates, mixed queries, ranking', () => {
  let app;
  beforeEach(async () => {
    ({ app } = makeApp());
    await createItems(app, [
      { code: 'TNT-001', name: '2-man tent', locationCode: 'R01-A-1' },
      { code: 'TNT-002', name: 'Big tent', locationCode: 'R01-B-2' },
      { code: 'TNT-003', name: 'Old tent', locationCode: 'R03-A-1' },
      { code: 'R1-STOVE', name: 'Stove', locationCode: 'R04-A-1' },
      { code: 'X30', name: 'Far rack item', locationCode: 'R30-A-1' },
      { code: 'NOTE-1', name: 'Aaa first by name', notes: 'see r03-a-1' },
    ]);
  });
  const search = (q) => request(app).get('/api/items').query({ q });

  it.each([
    ['tent r1', ['TNT-001', 'TNT-002']],
    ['r1 tent', ['TNT-001', 'TNT-002']],
    ['tent R01-A-1', ['TNT-001']],
    ['tent 1-a', ['TNT-001']],
    ['tent r1 b', ['TNT-002']],
    ['tent r01–b–2', ['TNT-002']], // en dash inside a word
    ['r1 r3', []],
    ['tent r9', []],
    ['stove r4', ['R1-STOVE']],
  ])('%j -> %j', async (q, expected) => {
    expect(codes(await search(q)).sort()).toEqual([...expected].sort());
  });

  it('"r3" matches rack R03 only (not R30), plus codes containing "r3"', async () => {
    expect(codes(await search('r3')).sort()).toEqual(['TNT-003']);
  });

  it('"r1" coordinate word also matches a code containing "r1"', async () => {
    expect(codes(await search('r1')).sort()).toEqual(['R1-STOVE', 'TNT-001', 'TNT-002']);
  });

  it('exact location ranks before a notes match that sorts earlier by name', async () => {
    expect(codes(await search('R03-A-1'))).toEqual(['TNT-003', 'NOTE-1']);
  });

  it('every word must match, even with more than 8 words', async () => {
    await createItems(app, [{ code: 'W8', name: 'alpha bravo charlie delta echo foxtrot golf hotel' }]);
    expect(codes(await search('alpha bravo charlie delta echo foxtrot golf hotel'))).toEqual(['W8']);
    expect(codes(await search('alpha bravo charlie delta echo foxtrot golf hotel zzz'))).toEqual([]);
  });

  it('repeated words and extra spaces are harmless', async () => {
    expect(codes(await search('  tent   tent  r1 ')).sort()).toEqual(['TNT-001', 'TNT-002']);
  });
});

describe('R2 Unicode', () => {
  let app;
  beforeEach(async () => {
    ({ app } = makeApp());
    await createItems(app, [
      { code: '⛺-1', name: 'Khemah ⛺ 🏕️', notes: '中文 தமிழ் हिन्दी', category: 'Ölzeug' },
      { code: 'CAF-1', name: 'Café kettle', category: 'ölzeug' },
      { code: 'ö-1', name: 'Umlaut code' },
    ]);
  });
  const search = (q) => request(app).get('/api/items').query({ q });

  it.each([['⛺', ['⛺-1']], ['🏕️', ['⛺-1']], ['中文', ['⛺-1']], ['தமிழ்', ['⛺-1']], ['KHEMAH', ['⛺-1']], ['CAFÉ', ['CAF-1']], ['café', ['CAF-1']]])(
    'q %j', async (q, expected) => {
      expect(codes(await search(q))).toEqual(expected);
    }
  );

  it('Unicode codes are uppercased and duplicates are detected across case', async () => {
    expect(codes(await search('Ö-1'))).toEqual(['Ö-1']);
    const res = await request(app).post('/api/items').send({ code: 'Ö-1', name: 'again' });
    expect(res.status).toBe(409);
    const imp = await upload(app, csv([['Code', 'Name'], ['ö-1', 'Renamed']]), 'a.csv', real);
    expect(imp.body).toMatchObject({ created: 0, updated: 1 });
  });

  it('Unicode text survives an xlsx round trip', async () => {
    const res = await upload(app, await xlsx([['Kod', 'Nama', 'Catatan'], ['ஓ-1', 'கயிறு 10 m', 'குறிப்பு']]), 'a.xlsx', real);
    expect(res.body.created).toBe(1);
    expect(codes(await search('கயிறு'))).toEqual(['ஓ-1']);
  });

  it('categories are grouped case-insensitively for non-ASCII letters too (like the filter)', async () => {
    const filtered = codes(await request(app).get('/api/items').query({ category: 'ÖLZEUG' }));
    expect(filtered.sort()).toEqual(['CAF-1', '⛺-1'].sort());
    const cats = (await request(app).get('/api/categories')).body.categories;
    expect(cats).toHaveLength(1);
    expect(cats[0].count).toBe(2);
  });
});

describe('R2 xlsx guard: zip bombs and hostile zips', () => {
  let app, db;
  beforeEach(() => {
    ({ app, db } = makeApp());
  });

  it('a 200 MB sheet compressed to ~200 KB is rejected quickly with 400', async () => {
    const bomb = writeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(200 * 1024 * 1024, 0x20) }]);
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    const t0 = Date.now();
    const res = await upload(app, bomb, 'bomb.xlsx', real);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(res.body.error.message).toMatch(/too large once unpacked/);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('an entry that lies about its size (declares 10 bytes, inflates to 100 MB) is rejected through the API', async () => {
    const bomb = writeZip([{ name: 'docProps/junk.bin', data: Buffer.alloc(100 * 1024 * 1024), declaredSize: 10 }]);
    const res = await upload(app, bomb, 'bomb.xlsx', real);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/too large once unpacked/);
  });

  it('more than 2000 zip entries -> 400', async () => {
    const many = writeZip(Array.from({ length: 2001 }, (_, i) => ({ name: `x/${i}.txt`, data: 'a' })));
    const res = await upload(app, many, 'many.xlsx');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('stored (uncompressed) entries are read normally', async () => {
    const base = await xlsx([['Code', 'Name'], ['S1', 'Stored']]);
    const stored = rewriteZip(base, (es) => es.map((e) => ({ ...e, method: 0 })));
    const res = await upload(app, stored, 'stored.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
  });

  it('a password-protected workbook (OLE container, not zip) -> 400', async () => {
    const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(2048)]);
    const res = await upload(app, cfb, 'locked.xlsx');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('a zip that is not a workbook -> 400', async () => {
    const res = await upload(app, writeZip([{ name: 'hello.txt', data: 'hi' }]), 'z.xlsx');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('300 randomly corrupted workbooks and every truncation never give a 500', async () => {
    const base = await xlsx([['Code', 'Name', 'Location'], ['A1', 'Tent', 'R1-A-1'], ['A2', 'Rope', 'R2']]);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const statuses = new Set();
    for (let k = 0; k < 300; k++) {
      const b = Buffer.from(base);
      const flips = 1 + Math.floor(rnd() * 8);
      for (let j = 0; j < flips; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      statuses.add((await upload(app, b, 'f.xlsx')).status);
    }
    for (let len = 4; len < base.length; len += 97) statuses.add((await upload(app, base.subarray(0, len), 't.xlsx')).status);
    expect([...statuses].every((s) => s === 200 || s === 400)).toBe(true);
    expect(allItems(db)).toHaveLength(0); // all dry runs
  }, 60_000);

  // ExcelJS strips a leading "/" from entry names and matches sheets with an unanchored
  // /xl\/worksheets\/sheet(\d+)[.]xml/, so these names are still parsed as worksheets.
  it.each(['/xl/worksheets/sheet1.xml', 'xl/worksheets/sheet1.xml.bak'])(
    'rows in a sheet entry named %j are counted by the guard',
    async (entryName) => {
      const rows = [['Code', 'Name']];
      for (let i = 0; i < 30; i++) rows.push([`C${i}`, 'x']);
      const base = await xlsx(rows);
      const renamed = rewriteZip(base, (es) => es.map((e) => (e.name === 'xl/worksheets/sheet1.xml' ? { ...e, name: entryName } : e)));
      expect(() => checkXlsx(renamed, { ...XLSX_LIMITS, maxRows: 10 })).toThrow(/Too many rows/);
    }
  );

  it('(evidence) a leading-slash sheet name is still imported by ExcelJS', async () => {
    const base = await xlsx([['Code', 'Name'], ['L1', 'Slash sheet']]);
    const renamed = rewriteZip(base, (es) => es.map((e) => (e.name === 'xl/worksheets/sheet1.xml' ? { ...e, name: '/xl/worksheets/sheet1.xml' } : e)));
    const res = await upload(app, renamed, 'a.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
  });
});

describe('R2 CSV limits', () => {
  it('a CSV under the 20,000-row limit is not rejected because it has many (empty) columns', async () => {
    const { app } = makeApp();
    const header = ['Code', 'Name', ...Array.from({ length: 11 }, (_, i) => `Extra ${i + 1}`)];
    const rows = [header];
    for (let i = 0; i < 19_000; i++) rows.push([`W${i}`, 'n', ...Array(11).fill('')]);
    const res = await upload(app, csv(rows), 'wide.csv');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(19_000);
  }, 30_000);

  it('exactly 20,000 data rows are accepted (dry run)', async () => {
    const { app } = makeApp();
    const lines = ['Code,Name'];
    for (let i = 0; i < 20_000; i++) lines.push(`C${i},n`);
    const res = await upload(app, Buffer.from(lines.join('\n')), 'max.csv');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(20_000);
    expect(res.body.preview).toHaveLength(20);
  }, 30_000);

  it('a CSV with a million lines is rejected early with 400', async () => {
    const { app } = makeApp();
    const t0 = Date.now();
    const res = await upload(app, Buffer.from('Code,Name\n' + 'a,b\n'.repeat(1_000_000)), 'huge.csv');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('R2 malformed multipart', () => {
  const { app } = makeApp();
  const raw = (ct, body) => request(app).post('/api/import').set('Content-Type', ct).serialize((x) => x).send(body);
  const part = (headers, content) => `--B\r\n${headers}\r\n\r\n${content}\r\n--B--\r\n`;

  it.each([
    ['garbage with a boundary', 'multipart/form-data; boundary=B', 'hello world'],
    ['part without headers', 'multipart/form-data; boundary=B', '--B\r\n\r\nxx\r\n--B--\r\n'],
    ['100 KB part header', 'multipart/form-data; boundary=B',
      part(`Content-Disposition: form-data; name="file"; filename="a.csv"\r\nX: ${'a'.repeat(100_000)}`, 'Code,Name\nA,b')],
    ['empty boundary', 'multipart/form-data; boundary=', 'x'],
    ['multipart/mixed', 'multipart/mixed; boundary=B', '--B\r\n\r\nx\r\n--B--'],
    ['"file" sent as a text field (no filename)', 'multipart/form-data; boundary=B',
      part('Content-Disposition: form-data; name="file"', 'Code,Name\nA,b')],
  ])('%s -> 400', async (_label, ct, body) => {
    const res = await raw(ct, body);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('two files -> 400', async () => {
    const f = csv([['Code', 'Name'], ['A', 'b']]);
    const res = await request(app).post('/api/import').attach('file', f, 'a.csv').attach('file', f, 'b.csv');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('more than 10 extra fields -> 400; a few extra fields are fine', async () => {
    const f = csv([['Code', 'Name'], ['A', 'b']]);
    let req = request(app).post('/api/import').attach('file', f, 'a.csv');
    for (let i = 0; i < 12; i++) req = req.field(`f${i}`, 'x');
    expect((await req).status).toBe(400);
    expect((await request(app).post('/api/import').field('note', 'x').attach('file', f, 'a.csv')).status).toBe(200);
  });

  it.each(['../../etc/items.csv', 'stör ☃.csv', 'C:\\Users\\qm\\items.csv'])('odd but valid filename %j is accepted', async (name) => {
    const res = await raw('multipart/form-data; boundary=B',
      Buffer.from(part(`Content-Disposition: form-data; name="file"; filename="${name}"`, 'Code,Name\nA,b')));
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
  });
});

describe('R2 JSON bodies', () => {
  let app, db;
  beforeEach(() => {
    ({ app, db } = makeApp());
  });
  const post = (body, headers = {}) => {
    let r = request(app).post('/api/items');
    for (const [k, v] of Object.entries({ 'Content-Type': 'application/json', ...headers })) r = r.set(k, v);
    return r.serialize((x) => x).send(body);
  };

  it('UTF-16 JSON is accepted', async () => {
    const res = await post(Buffer.from('{"code":"U16","name":"x"}', 'utf16le'), { 'Content-Type': 'application/json; charset=utf-16le' });
    expect(res.status).toBe(201);
  });

  it('gzip-encoded JSON is accepted; corrupt gzip -> 400; unknown encoding -> 400; gzip bomb -> 413', async () => {
    expect((await post(zlib.gzipSync('{"code":"GZ","name":"x"}'), { 'Content-Encoding': 'gzip' })).status).toBe(201);
    const bad = await post(Buffer.from('notgzip'), { 'Content-Encoding': 'gzip' });
    expect(bad.status).toBe(400);
    expectErrorShape(expect, bad.body);
    expect((await post('{"code":"F","name":"x"}', { 'Content-Encoding': 'foo' })).status).toBe(400);
    const bomb = await post(zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20)), { 'Content-Encoding': 'gzip' });
    expect(bomb.status).toBe(413);
    expectErrorShape(expect, bomb.body);
  });

  it.each(['null', '"abc"', '42', '['.repeat(5000) + ']'.repeat(5000)])('non-object JSON %j -> 400', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('__proto__ / constructor keys do not pollute anything', async () => {
    const res = await post('{"code":"PR","name":"x","__proto__":{"condition":"damaged"},"constructor":{"prototype":{"x":1}}}');
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('condition'); // Phase 1.6: condition is no longer returned
    expect(res.body).toMatchObject({ goodQty: null, badQty: null, status: 'unchecked' });
    expect({}.condition).toBeUndefined();
    expect({}.x).toBeUndefined();
    expect(allItems(db)).toHaveLength(1);
  });
});

describe('R2 item ids', () => {
  it.each([['00001', 200], ['%31', 200], ['999999999999999', 404], ['9999999999999999', 400], ['1abc', 400], ['1%20', 400], ['-0', 400]])(
    'GET /api/items/%s -> %i', async (id, status) => {
      const { app } = makeApp();
      await createItems(app, [{ code: 'A', name: 'a' }]);
      expect((await request(app).get(`/api/items/${id}`)).status).toBe(status);
    }
  );
});

describe('R2 process-level: app import side effects and concurrent migrations', () => {
  it('importing src/app.js (and calling createApp with a DB) does not create the DB_PATH file', () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'should-not-exist.db');
    const script = `
      const m = await import(${JSON.stringify(path.join(BACKEND, 'src/app.js'))});
      const { openDb } = await import(${JSON.stringify(path.join(BACKEND, 'src/db/index.js'))});
      m.createApp(openDb(':memory:'));
      if (typeof m.app !== 'function') process.exit(2);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DB_PATH: dbFile }, encoding: 'utf8', timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(dbFile)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('4 processes opening the same fresh DB file at once all succeed and migrate once', async () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'race.db');
    const script = `
      const { openDb } = await import(${JSON.stringify(path.join(BACKEND, 'src/db/index.js'))});
      const db = openDb(${JSON.stringify(dbFile)}); db.close();`;
    const run = () => new Promise((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => resolve({ code, err }));
    });
    const results = await Promise.all([run(), run(), run(), run()]);
    for (const r of results) expect(r.code, r.err).toBe(0);
    const { openDb } = await import('../src/db/index.js');
    const db = openDb(dbFile);
    // Every migration applied exactly once (Phase 1.5 added version 2).
    const { migrations } = await import('../src/db/migrations.js');
    expect(db.prepare('SELECT version FROM schema_version ORDER BY version').all()).toEqual(migrations.map((m) => ({ version: m.version })));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('R2 import concurrency (one import at a time, small queue, then 429)', () => {
  it('8 simultaneous uploads: each gets 200 or 429 (never 500), and the lock is released afterwards', async () => {
    const { app, db } = makeApp();
    const rows = [['Code', 'Name', 'Location']];
    for (let i = 0; i < 3000; i++) rows.push([`C${i}`, `Item ${i}`, `R${(i % 6) + 1}-A-1`]);
    const file = await xlsx(rows);
    const results = await Promise.all(Array.from({ length: 8 }, () => upload(app, file, 'a.xlsx')));
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    for (const r of results.filter((x) => x.status === 429)) expectErrorShape(expect, r.body);
    for (const r of results.filter((x) => x.status === 200)) expect(r.body.created).toBe(3000);
    const after = await upload(app, csv([['Code', 'Name'], ['Z', 'z']]), 'z.csv', real);
    expect(after.status).toBe(200);
    expect(allItems(db)).toHaveLength(1);
  }, 60_000);
});
