// GET /api/items: search, ranking, filters.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, createItems, expectItemShape, expectErrorShape } from './helpers.js';
import { LEGACY_SEED_ITEMS as SEED_ITEMS } from './fixtures/legacy-seed.js'; // Phase 1 demo data (the app seed changed in 1.6)

const codes = (res) => res.body.items.map((i) => i.code);
const search = (app, query) => request(app).get('/api/items').query(query);

describe('GET /api/items - listing', () => {
  it('empty DB -> { items: [] }', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('no q -> all items sorted by code, full Item shape', async () => {
    const { app } = makeApp({ seeded: true });
    const res = await request(app).get('/api/items');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['items']);
    expect(res.body.items).toHaveLength(SEED_ITEMS.length);
    res.body.items.forEach((i) => expectItemShape(expect, i));
    const sorted = [...SEED_ITEMS.map((i) => i.code)].sort();
    expect(codes(res)).toEqual(sorted);
  });

  it('blank q behaves like no q', async () => {
    const { app } = makeApp({ seeded: true });
    const res = await search(app, { q: '   ' });
    expect(res.body.items).toHaveLength(SEED_ITEMS.length);
  });
});

describe('GET /api/items - q matching', () => {
  let app;
  beforeEach(async () => {
    ({ app } = makeApp());
    await createItems(app, [
      { code: 'TNT-004', name: '4-man dome tent', category: 'Tents', locationCode: 'R01-B-2', notes: 'Green, with rain fly' },
      { code: 'ROP-010', name: 'Manila rope 10 m', category: 'Ropes', locationCode: 'R03-A-1', notes: '' },
      { code: 'ROP-011', name: 'Sisal rope', category: 'Ropes', locationCode: 'R03-A-10', notes: '' },
      { code: 'CKG-001', name: 'Kuali (wok)', category: 'Cooking', locationCode: 'R03-B', notes: 'Black handle' },
      { code: 'FLG-001', name: 'Troop flag', category: 'Flags', locationCode: 'Store cupboard', notes: '100% cotton' },
      { code: 'LGT-001', name: 'Lantern', category: 'Lighting', locationCode: 'R03', notes: 'needs gas_canister' },
    ]);
  });

  it.each([
    ['code (case-insensitive)', 'tnt-004', ['TNT-004']],
    ['part of code', 'rop', ['ROP-010', 'ROP-011']],
    ['name', 'DOME', ['TNT-004']],
    ['category', 'cooking', ['CKG-001']],
    ['locationCode text', 'store cup', ['FLG-001']],
    ['notes', 'rain fly', ['TNT-004']],
    ['notes, case-insensitive', 'BLACK', ['CKG-001']],
  ])('matches %s', async (_label, q, expected) => {
    const res = await search(app, { q });
    expect(res.status).toBe(200);
    expect(codes(res).sort()).toEqual(expected.sort());
  });

  it('several words must all match (in any field)', async () => {
    expect(codes(await search(app, { q: 'rope manila' }))).toEqual(['ROP-010']);
    expect(codes(await search(app, { q: 'tents green' }))).toEqual(['TNT-004']);
    expect(codes(await search(app, { q: 'rope tent' }))).toEqual([]);
  });

  it('no match -> empty list', async () => {
    expect((await search(app, { q: 'zzzz' })).body).toEqual({ items: [] });
  });

  it('% and _ are literal, not wildcards', async () => {
    expect(codes(await search(app, { q: '%' }))).toEqual(['FLG-001']);
    expect(codes(await search(app, { q: 'gas_c' }))).toEqual(['LGT-001']);
    expect(codes(await search(app, { q: '_' }))).toEqual(['LGT-001']);
  });

  it('quotes and SQL-looking input are harmless', async () => {
    const res = await search(app, { q: "'; DROP TABLE items; --" });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect((await request(app).get('/api/items')).body.items).toHaveLength(6);
  });

  it.each([
    ['r3-b', ['CKG-001']],
    ['R3 B', ['CKG-001']],
    ['r03-a-1', ['ROP-010']], // exact rack/shelf/bin components: R03-A-1 does not match R03-A-10 (lead decision 8)
    ['R3 A 1', ['ROP-010']],
    ['3-a-10', ['ROP-011']],
    ['r1-b-2', ['TNT-004']],
  ])('coordinate-like q %j matches the normalized locationCode', async (q, expected) => {
    expect(codes(await search(app, { q })).sort()).toEqual(expected.sort());
  });

  it('coordinate-like rack-only q "r3" matches the whole rack', async () => {
    expect(codes(await search(app, { q: 'r3' })).sort()).toEqual(['CKG-001', 'LGT-001', 'ROP-010', 'ROP-011']);
  });

  it('"bin 2" in q is words, not a rack coordinate', async () => {
    await createItems(app, [{ code: 'BIN-001', name: 'Bin liner', notes: '2 rolls', locationCode: 'R05-A-1' }, { code: 'POT-001', name: 'Pot', locationCode: 'R02-A-1' }]);
    expect(codes(await search(app, { q: 'bin 2' }))).toEqual(['BIN-001']);
  });

  it('q longer than 200 chars -> 400', async () => {
    const res = await search(app, { q: 'a'.repeat(201) });
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('repeated q param -> 400 (not a crash)', async () => {
    const res = await request(app).get('/api/items?q=a&q=b');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('case-insensitive for non-ASCII letters too', async () => {
    await createItems(app, [{ code: 'MSC-001', name: 'Ölfass (Öl drum)' }]);
    expect(codes(await search(app, { q: 'öl' }))).toEqual(['MSC-001']);
  });
});

describe('GET /api/items - ranking', () => {
  it('exact code, then code prefix, then name prefix, then others; ties by name', async () => {
    const { app } = makeApp();
    await createItems(app, [
      { code: 'X-9', name: 'Big tent (other)' },             // other: "tent" in name
      { code: 'X-8', name: 'Annex for tent (other)' },        // other
      { code: 'Y-1', name: 'Tent pegs (name prefix)' },       // name prefix
      { code: 'Y-2', name: 'tent bag (name prefix)' },        // name prefix
      { code: 'TENT-2', name: 'Zebra tent (code prefix)' },   // code prefix
      { code: 'TENT-1', name: 'Yak tent (code prefix)' },     // code prefix
      { code: 'TENT', name: 'Zulu (exact code)' },            // exact code
      { code: 'Z-1', name: 'Pole', notes: 'for the tent' },   // other (notes)
    ]);
    const res = await search(app, { q: 'Tent' });
    expect(codes(res)).toEqual([
      'TENT',                    // exact code
      'TENT-1', 'TENT-2',        // code prefix, by name: "Yak..." < "Zebra..."
      'Y-2', 'Y-1',              // name prefix, by name (case-insensitive): "tent bag" < "Tent pegs"
      'X-8', 'X-9', 'Z-1',       // others by name: Annex < Big < Pole
    ]);
  });

  it('exact code match ranks first even if another item has the code as a prefix', async () => {
    const { app } = makeApp();
    await createItems(app, [
      { code: 'ROP-0100', name: 'Aaa rope' },
      { code: 'ROP-010', name: 'Zzz rope' },
    ]);
    expect(codes(await search(app, { q: 'rop-010' }))).toEqual(['ROP-010', 'ROP-0100']);
  });

  it('works on the seed data: "tent" puts TNT/tent items first', async () => {
    const { app } = makeApp({ seeded: true });
    const res = await search(app, { q: 'tent' });
    const names = res.body.items.map((i) => i.name);
    expect(names.length).toBeGreaterThanOrEqual(4);
    // name-prefix item ("Tent peg set") precedes "other" matches ("2-man hike tent"...)
    expect(names[0]).toBe('Tent peg set (steel, 20 pcs)');
  });
});

describe('GET /api/items - filters', () => {
  let app;
  beforeEach(async () => {
    ({ app } = makeApp());
    await createItems(app, [
      { code: 'A1', name: 'Tent A', category: 'Tents', locationCode: 'R03-A-1', condition: 'good' },
      { code: 'A2', name: 'Tent B', category: 'tents', locationCode: 'R03-B-1', condition: 'damaged' },
      { code: 'B1', name: 'Rope', category: 'Ropes', locationCode: 'R10-A-1', condition: 'damaged' },
      { code: 'B2', name: 'Rope 2', category: 'Ropes', locationCode: 'R01-A-1', condition: 'needs_repair' },
      { code: 'C1', name: 'Loose', category: null, locationCode: null, condition: 'written_off' },
    ]);
  });

  it('category (case-insensitive exact)', async () => {
    expect(codes(await search(app, { category: 'Tents' }))).toEqual(['A1', 'A2']);
    expect(codes(await search(app, { category: 'TENTS' }))).toEqual(['A1', 'A2']);
    expect(codes(await search(app, { category: 'Tent' }))).toEqual([]);
  });

  it.each(['3', 'r3', 'R03', 'R3', '03'])('rack=%s', async (rack) => {
    expect(codes(await search(app, { rack }))).toEqual(['A1', 'A2']);
  });

  it('rack=1 does not match R10', async () => {
    expect(codes(await search(app, { rack: '1' }))).toEqual(['B2']);
  });

  it('unknown rack -> empty list', async () => {
    expect(codes(await search(app, { rack: 'abc' }))).toEqual([]);
  });

  // Phase 1.6: the condition filter was replaced by status (condition on write became good/bad counts:
  // good -> ok; needs_repair / damaged / written_off -> attention).
  it('status (replaces the condition filter)', async () => {
    expect(codes(await search(app, { status: 'attention' }))).toEqual(['A2', 'B1', 'B2', 'C1']);
    expect(codes(await search(app, { status: 'ok' }))).toEqual(['A1']);
    expect(codes(await search(app, { status: 'unchecked' }))).toEqual([]);
    expect(codes(await search(app, { status: '' }))).toHaveLength(5);
    expect(codes(await search(app, { condition: '' }))).toHaveLength(5);
  });

  it.each([{ condition: 'damaged' }, { condition: 'broken' }, { status: 'broken' }])('retired/invalid filter %j -> 400', async (query) => {
    const res = await search(app, query);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('filters combine with each other and with q', async () => {
    expect(codes(await search(app, { category: 'tents', status: 'attention' }))).toEqual(['A2']);
    expect(codes(await search(app, { q: 'rope', status: 'attention' }))).toEqual(['B1', 'B2']);
    expect(codes(await search(app, { q: 'tent', rack: 'r3', status: 'ok' }))).toEqual(['A1']);
    expect(codes(await search(app, { q: 'r3', category: 'Ropes' }))).toEqual([]);
  });
});
