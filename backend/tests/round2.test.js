// Round-2 fixes (docs/REVIEW-backend.md M1, M2, m1-m6, nits; lead decisions 1-10).
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, createItems, csv, xlsx, upload, allItems, expectErrorShape } from './helpers.js';
import { parseLocation, normalizeRack } from '../src/lib/location.js';
import { mapHeaders } from '../src/lib/headers.js';
import { checkXlsx, XLSX_LIMITS } from '../src/lib/xlsxGuard.js';
import { parseQuantity } from '../src/lib/importRows.js';

const real = { dryRun: 'false' };
const codes = (res) => res.body.items.map((i) => i.code);

describe('1. shelf/bin words without a rack are not coordinates', () => {
  it.each(['Bin 5', 'Level 2', 'Shelf 3', 'Slot 7', 'Petak 1', 'Pos 3', 'No. 4', 'Position 7', 'Tingkat 2', 'Para 1', 'R3 bin 2'])(
    '%j is kept as text', (s) => {
      expect(parseLocation(s)).toEqual({ locationCode: s, rack: null, level: null, compartment: null, shelf: null, bin: null });
    }
  );
  it.each([
    ['Rack 3 Shelf B Bin 2', 'R03-B-2'], ['Rak 3 Tingkat B Petak 2', 'R03-B-2'], ['Rack No. 4 B 1', 'R04-B-1'],
    ['R3 Level C', 'R03-C'], ['r3 b slot 4', 'R03-B-4'],
  ])('keywords after a rack still work: %j -> %s', (s, code) => {
    expect(parseLocation(s).locationCode).toBe(code);
  });
  it('normalizeRack and GET /api/racks reject shelf/bin words', async () => {
    expect(normalizeRack('bin 3')).toBeNull();
    const { app } = makeApp({ seeded: true });
    const res = await request(app).get('/api/racks/bin%203');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });
});

describe('10. en/em dashes and other hyphen look-alikes are separators', () => {
  it.each(['R03–B–2', 'R03—B—2', 'R03−B−2', 'R03－B－2', 'r3 ‒ b ‒ 2'])('%j -> R03-B-2', (s) => {
    expect(parseLocation(s)).toEqual({ locationCode: 'R03-B-2', rack: 'R03', level: null, compartment: null, shelf: 'B', bin: 2 });
  });
});

describe('2. blank import cells leave existing values unchanged (every field)', () => {
  let app, db, existing;
  beforeEach(async () => {
    ({ app, db } = makeApp());
    [existing] = await createItems(app, [{
      code: 'CKG-012', name: 'Jerry can', category: 'Cooking', locationCode: 'R02-D-1', quantity: 6,
      unit: 'cans', condition: 'damaged', notes: 'Two leak at the tap',
    }]);
  });

  it('existing item keeps condition, location, category, notes, quantity and unit', async () => {
    const file = csv([
      ['Kod', 'Nama', 'Kategori', 'Lokasi', 'Kuantiti', 'Unit', 'Keadaan', 'Catatan'],
      ['CKG-012', 'Jerry can 20 L', '', '', '', '', '', ''],
    ]);
    const dry = await upload(app, file, 'a.csv');
    // Phase 1.6: "condition damaged" is stored as counts (good 0 / bad 6)
    expect(dry.body.preview[0]).toMatchObject({ action: 'update', id: existing.id, name: 'Jerry can 20 L', goodQty: 0, badQty: 6, locationCode: 'R02-D-1' });
    const res = await upload(app, file, 'a.csv', real);
    expect(res.body).toMatchObject({ created: 0, updated: 1, skipped: 0, errors: [] });
    const item = (await request(app).get(`/api/items/${existing.id}`)).body;
    expect(item).toMatchObject({
      name: 'Jerry can 20 L', category: 'Cooking', locationCode: 'R02-D-1', rack: 'R02', shelf: 'D', bin: 1,
      quantity: 6, unit: 'cans', goodQty: 0, badQty: 6, status: 'attention', notes: 'Two leak at the tap',
    });
  });

  it('blank rack/shelf/bin columns also leave the location unchanged', async () => {
    await upload(app, csv([['Code', 'Name', 'Rack', 'Shelf', 'Bin'], ['CKG-012', 'Jerry can', '', '', '']]), 'a.csv', real);
    expect(allItems(db)[0]).toMatchObject({ location_code: 'R02-D-1', rack: 'R02' });
  });

  it('new items with blank cells still get the defaults', async () => {
    const res = await upload(app, csv([['Code', 'Name', 'Category', 'Location', 'Qty', 'Unit', 'Condition', 'Notes'], ['NEW-1', 'New', '', '', '', '', '', '']]), 'a.csv', real);
    // Phase 1.6: a blank Quantity cell on a new item = not counted (null) + "quantity missing"; no counts yet
    expect(allItems(db).find((r) => r.code === 'NEW-1')).toMatchObject({
      category: null, location_code: null, rack: null, quantity: null, unit: 'pcs', good_qty: null, bad_qty: null, notes: '',
    });
    expect(res.body.errors).toEqual([{ row: 2, message: 'Warning: quantity missing' }]);
  });
});

describe('3. search is case-insensitive for non-ASCII letters', () => {
  it('Ölfass is found by öl and ÖL; category filter too', async () => {
    const { app } = makeApp();
    await createItems(app, [{ code: 'MSC-001', name: 'Ölfass', category: 'Ölzeug' }, { code: 'MSC-002', name: 'Other' }]);
    for (const q of ['öl', 'ÖL', 'ölfass']) expect(codes(await request(app).get('/api/items').query({ q }))).toEqual(['MSC-001']);
    expect(codes(await request(app).get('/api/items').query({ category: 'ölzeug' }))).toEqual(['MSC-001']);
  });
});

describe('4. over-long location on import', () => {
  it('row is imported with a warning; location left unchanged (null for new items)', async () => {
    const { app, db } = makeApp();
    await createItems(app, [{ code: 'A1', name: 'a', locationCode: 'R01-A-1' }]);
    const long = 'Under the stairs, in the big blue box next to the old flag poles, behind the broken tables near the door';
    expect(long.length).toBeGreaterThan(100);
    const res = await upload(app, csv([['Code', 'Name', 'Location'], ['A1', 'a', long], ['B1', 'b', long]]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 1, skipped: 0 });
    expect(res.body.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(res.body.errors.every((e) => e.message.startsWith('Warning:'))).toBe(true);
    const rows = allItems(db);
    expect(rows.find((r) => r.code === 'A1').location_code).toBe('R01-A-1');
    expect(rows.find((r) => r.code === 'B1').location_code).toBeNull();
  });
});

describe('5. workbook size guard (bounded memory before ExcelJS loads)', () => {
  it('rejects too many rows / cells / unpacked bytes with 400', async () => {
    const buf = await xlsx([['Code', 'Name'], ['A', 'a'], ['B', 'b'], ['C', 'c']]);
    expect(checkXlsx(buf)).toMatchObject({ rows: 4, cells: 8 });
    expect(() => checkXlsx(buf, { ...XLSX_LIMITS, maxRows: 3 })).toThrow(/Too many rows/);
    expect(() => checkXlsx(buf, { ...XLSX_LIMITS, maxCells: 7 })).toThrow(/too many cells/);
    expect(() => checkXlsx(buf, { ...XLSX_LIMITS, maxEntryBytes: 100 })).toThrow(/too large once unpacked/);
  });

  it('declared sizes cannot lie: the inflate output itself is capped', async () => {
    const buf = Buffer.from(await xlsx([['Code', 'Name'], ['A', 'a']]));
    for (let i = 0; i < buf.length - 4; i++) if (buf.readUInt32LE(i) === 0x02014b50) buf.writeUInt32LE(1, i + 24);
    expect(() => checkXlsx(buf, { ...XLSX_LIMITS, maxTotalBytes: 2000 })).toThrow(/too large once unpacked/);
  });

  it('a workbook over the row cap is rejected through the API', async () => {
    const { app, db } = makeApp();
    const rows = [['Code', 'Name']];
    for (let i = 0; i < XLSX_LIMITS.maxRows + 1; i++) rows.push([i, 'x']);
    const res = await upload(app, await xlsx(rows), 'big.xlsx', real);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(allItems(db)).toHaveLength(0);
  }, 30_000);
});

describe('6. malformed request bodies are 400, never 500', () => {
  const { app } = makeApp();
  it('multipart without a boundary', async () => {
    const res = await request(app).post('/api/import').set('Content-Type', 'multipart/form-data').send('garbage');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });
  it('truncated multipart body', async () => {
    const res = await request(app).post('/api/import')
      .set('Content-Type', 'multipart/form-data; boundary=XYZ')
      .send('--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nCode,Name\nA,b\n');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js/);
  });
  it('JSON with an unsupported charset', async () => {
    const res = await request(app).post('/api/items').set('Content-Type', 'application/json; charset=latin2').send('{"code":"A","name":"b"}');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });
});

describe('7. duplicate-mapped columns', () => {
  it('losing columns are listed in ignoredColumns with a reason', () => {
    const { mapping, ignored } = mapHeaders(['ID', 'Code', 'Name', 'Notes', 'Remarks']);
    expect(mapping).toEqual({ code: 1, name: 2, notes: 3 });
    expect(ignored).toEqual(['ID (duplicate code column; "Code" is used)', 'Remarks (duplicate notes column; "Notes" is used)']);
  });

  it('Kod/Nama/Keterangan: Keterangan becomes notes', async () => {
    const { app, db } = makeApp();
    const res = await upload(app, csv([['Kod', 'Nama', 'Lokasi', 'Keterangan'], ['K1', 'Khemah', 'R1', 'Zip rosak']]), 'a.csv', real);
    expect(res.body.columns).toEqual({ code: 0, name: 1, location: 2, notes: 3 });
    expect(res.body.ignoredColumns).toEqual([]);
    expect(allItems(db)[0].notes).toBe('Zip rosak');
  });

  it('Name + Description (with Notes present): Description is ignored with a reason', async () => {
    const { app } = makeApp();
    const res = await upload(app, csv([['Code', 'Name', 'Description', 'Notes'], ['A1', 'Tent', 'Big', 'n']]), 'a.csv');
    expect(res.body.ignoredColumns).toEqual(['Description (duplicate name column; "Name" is used)']);
  });
});

describe('8. coordinate search matches rack/shelf/bin exactly; words AND with coordinates', () => {
  let app;
  beforeEach(async () => {
    ({ app } = makeApp());
    await createItems(app, [
      { code: 'X-1', name: 'Axe', locationCode: 'R03-B-10' },
      { code: 'ROP-050', name: 'Lashing cord', locationCode: 'R03-B-1' },
      { code: 'TNT-001', name: '2-man tent', locationCode: 'R01-A-1' },
      { code: 'TNT-002', name: 'Big tent', locationCode: 'R02-A-1' },
      { code: 'BIN-001', name: 'Bin liner', notes: '2 rolls', locationCode: 'R05-A-1' },
      { code: 'POT-001', name: 'Pot', locationCode: 'R02-A-2' },
    ]);
  });
  const search = (q) => request(app).get('/api/items').query({ q });

  it('R03-B-1 does not match R03-B-10', async () => {
    expect(codes(await search('R03-B-1'))).toEqual(['ROP-050']);
    expect(codes(await search('r3 b 10'))).toEqual(['X-1']);
  });
  it('"tent r1" = name tent AND rack R01', async () => {
    expect(codes(await search('tent r1'))).toEqual(['TNT-001']);
    expect(codes(await search('r2 tent'))).toEqual(['TNT-002']);
  });
  it('"bin 2" and "level 1" are words, not coordinates', async () => {
    expect(codes(await search('bin 2'))).toEqual(['BIN-001']);
    expect(codes(await search('level 1'))).toEqual([]);
  });
  it('an exact location hit ranks right after an exact code hit', async () => {
    await createItems(app, [{ code: 'R03-B-1', name: 'Zzz box' }]);
    expect(codes(await search('R03-B-1'))).toEqual(['R03-B-1', 'ROP-050']);
  });
});

describe('9. duplicate code in one file is one item', () => {
  it('new code on two rows: created 1, one preview entry (create, final values), same in dry and real run', async () => {
    const { app, db } = makeApp();
    await createItems(app, [{ code: 'OLD', name: 'Old' }]);
    const file = csv([['Code', 'Name', 'Qty'], ['NEW-1', 'first', '1'], ['OLD', 'Renamed', ''], ['new-1', 'second', '2']]);
    const dry = await upload(app, file, 'a.csv');
    const wet = await upload(app, file, 'a.csv', real);
    for (const r of [dry, wet]) {
      expect(r.body).toMatchObject({ created: 1, updated: 1, unchanged: 0, skipped: 0 });
      expect(r.body.preview.map((p) => [p.row, p.action, p.code, p.name, p.quantity])).toEqual([
        [2, 'create', 'NEW-1', 'Second', 2], // Phase 1.6 tidy: first letter capitalised
        [3, 'update', 'OLD', 'Renamed', 1],
      ]);
      expect(r.body.preview.some((p) => p.action === 'update' && p.id === null)).toBe(false);
      expect(r.body.errors).toHaveLength(1);
      expect(r.body.errors[0]).toMatchObject({ row: 4 });
    }
    expect(allItems(db).find((i) => i.code === 'NEW-1')).toMatchObject({ name: 'Second', quantity: 2 });
  });
});

describe('nits', () => {
  it('no-op re-import: counted as unchanged and updatedAt is not bumped', async () => {
    const { app } = makeApp();
    const [item] = await createItems(app, [{ code: 'A1', name: 'Tent', locationCode: 'R01-A-1', quantity: 2 }]);
    await new Promise((r) => setTimeout(r, 5));
    const res = await upload(app, csv([['Code', 'Name', 'Location', 'Qty'], ['a1', 'Tent', 'r1 a 1', '2']]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(res.body.preview[0]).toMatchObject({ action: 'unchanged', id: item.id });
    expect((await request(app).get(`/api/items/${item.id}`)).body.updatedAt).toBe(item.updatedAt);
  });

  it('quantity "0x10" / "1e3" are not numbers; id "1e2" is not an id', async () => {
    const { app } = makeApp();
    for (const quantity of ['0x10', '1e3']) {
      expect((await request(app).post('/api/items').send({ code: 'Q', name: 'q', quantity })).status).toBe(400);
    }
    expect(parseQuantity('0x10')).toBeNull();
    expect(parseQuantity('5pcs')).toEqual({ quantity: 5, unit: 'pcs' });
    expect((await request(app).get('/api/items/1e2')).status).toBe(400);
  });

  it('importing src/app.js does not open the database', async () => {
    const mod = await import('../src/app.js');
    expect(typeof mod.createApp).toBe('function');
    expect(typeof mod.app).toBe('function');
  });

  it('headersFound shows the header-like row, not the title row', async () => {
    const { app } = makeApp();
    const res = await upload(app, csv([['Laporan Stor'], ['Kod', 'Barang X']]), 'a.csv');
    expect(res.status).toBe(400);
    expect(res.body.error.details.headersFound).toEqual(['Kod', 'Barang X']);
  });
});

// ---- Round 3 (REVIEW-backend.md "Round 2 verification": R2-1, R2-3) ----
import zlib from 'node:zlib';
import ExcelJS from 'exceljs';
import { listZipEntries } from '../src/lib/xlsxGuard.js';
import { runExclusive, IMPORT_QUEUE_LIMIT } from '../src/services/importer.js';

/** Unpack a zip buffer into [{ name, data }] (test helper, stored/deflate only). */
function unzip(buf) {
  return listZipEntries(buf).map((e) => {
    const p = e.localOffset;
    const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const raw = buf.subarray(start, start + e.compressedSize);
    return { name: e.name, data: e.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) };
  });
}

/** Write [{ name, data }] as a deflate zip (test helper). */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const n = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, n, comp);
    centrals.push(cen, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('R2-1: xlsxGuard cannot be bypassed by entry names or tag spelling', () => {
  const limits = { ...XLSX_LIMITS, maxRows: 10, maxCells: 1000 };
  let original;
  beforeEach(async () => {
    const rows = [['Code', 'Name']];
    for (let i = 0; i < 30; i++) rows.push([`C${i}`, 'x']);
    original = await xlsx(rows);
  });
  const rowsSeenByExcelJS = async (buf) => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    return wb.worksheets[0].actualRowCount;
  };

  it('baseline: the normal file is over the row cap', () => {
    expect(() => checkXlsx(original, limits)).toThrow(/Too many rows/);
  });

  it('entry names with a leading "/" are still counted', async () => {
    const renamed = zip(unzip(original).map((f) => ({ ...f, name: `/${f.name}` })));
    expect(await rowsSeenByExcelJS(renamed)).toBe(31); // the trick is real: ExcelJS reads these rows
    expect(() => checkXlsx(renamed, limits)).toThrow(/Too many rows/);
  });

  it('tags written as "<row\\n" / "<c\\n" are still counted', async () => {
    const respaced = zip(unzip(original).map((f) => (/worksheets\//.test(f.name)
      ? { ...f, data: Buffer.from(f.data.toString('utf8').replace(/<row /g, '<row\n').replace(/<c /g, '<c\n')) }
      : f)));
    expect(await rowsSeenByExcelJS(respaced)).toBe(31);
    expect(() => checkXlsx(respaced, limits)).toThrow(/Too many rows/);
  });

  it('namespaced tags ("<x:row", "<x:c") are counted too', () => {
    const ns = zip(unzip(original).map((f) => (/worksheets\//.test(f.name)
      ? { ...f, data: Buffer.from(f.data.toString('utf8').replace(/<row[\s>]/g, (m) => `<x:row${m.slice(4)}`)) }
      : f)));
    expect(() => checkXlsx(ns, limits)).toThrow(/Too many rows/);
  });
});

describe('R2-1: only one import is processed at a time', () => {
  it('queues up to IMPORT_QUEUE_LIMIT, runs them in order, then answers 429', async () => {
    let release;
    const order = [];
    const first = runExclusive(() => new Promise((r) => { release = r; }).then(() => order.push('first')));
    const queued = Array.from({ length: IMPORT_QUEUE_LIMIT }, (_, i) => runExclusive(async () => order.push(`q${i}`)));
    await expect(runExclusive(async () => 'too many')).rejects.toMatchObject({ status: 429 });
    release();
    await Promise.all([first, ...queued]);
    expect(order).toEqual(['first', ...queued.map((_, i) => `q${i}`)]);
    expect(await runExclusive(async () => 'free again')).toBe('free again');
  });

  it('a failing import releases the lock', async () => {
    await expect(runExclusive(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await runExclusive(async () => 'ok')).toBe('ok');
  });
});

describe('R2-3: unknown condition text keeps an existing item\'s condition', () => {
  // Phase 1.6: counts instead of condition; unknown text never changes them, a new item stays "not counted"
  it('existing damaged item stays damaged (warning); new item gets good', async () => {
    const { app, db } = makeApp();
    await createItems(app, [{ code: 'CKG-012', name: 'Jerry can', condition: 'damaged' }]);
    const res = await upload(app, csv([['Code', 'Name', 'Keadaan'], ['CKG-012', 'Jerry can', 'rosak teruk sekali'], ['NEW-1', 'New', 'shiny']]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 1, updated: 0, unchanged: 1, skipped: 0 });
    expect(res.body.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(res.body.errors.every((e) => e.message.startsWith('Warning:'))).toBe(true);
    const rows = allItems(db);
    expect(rows.find((r) => r.code === 'CKG-012')).toMatchObject({ good_qty: 0, bad_qty: 1 });
    expect(rows.find((r) => r.code === 'NEW-1')).toMatchObject({ good_qty: null, bad_qty: null });
  });
});
