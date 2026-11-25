// GET /api/categories, GET /api/racks, GET /api/racks/:rack
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, createItems, expectItemShape, expectErrorShape } from './helpers.js';
import { SEED_ITEMS } from '../scripts/seed.js';

describe('GET /api/categories', () => {
  it('empty DB -> { categories: [] }', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ categories: [] });
  });

  it('distinct categories with counts; null/blank excluded; case-insensitive grouping', async () => {
    const { app } = makeApp();
    await createItems(app, [
      { code: 'A', name: 'a', category: 'Tents' },
      { code: 'B', name: 'b', category: 'Tents' },
      { code: 'C', name: 'c', category: 'tents' },
      { code: 'D', name: 'd', category: 'Ropes' },
      { code: 'E', name: 'e', category: null },
      { code: 'F', name: 'f', category: '' },
      { code: 'G', name: 'g' },
    ]);
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['categories']);
    const byName = Object.fromEntries(res.body.categories.map((c) => [c.name.toLowerCase(), c.count]));
    expect(byName).toEqual({ tents: 3, ropes: 1 });
    for (const c of res.body.categories) {
      expect(Object.keys(c).sort()).toEqual(['count', 'name']);
      expect(typeof c.name).toBe('string');
      expect(typeof c.count).toBe('number');
    }
  });

  it('reflects the seed data', async () => {
    const { app } = makeApp({ seeded: true });
    const res = await request(app).get('/api/categories');
    const expected = {};
    for (const i of SEED_ITEMS) expected[i.category] = (expected[i.category] ?? 0) + 1;
    expect(Object.fromEntries(res.body.categories.map((c) => [c.name, c.count]))).toEqual(expected);
  });

  it('updates after delete', async () => {
    const { app } = makeApp();
    const [a] = await createItems(app, [{ code: 'A', name: 'a', category: 'Solo' }]);
    await request(app).delete(`/api/items/${a.id}`);
    expect((await request(app).get('/api/categories')).body).toEqual({ categories: [] });
  });
});

describe('GET /api/racks', () => {
  it('empty DB -> { racks: [], unlocated: 0 }', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/racks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ racks: [], unlocated: 0 });
  });

  it('racks sorted numerically with distinct sorted shelves, itemCount and unlocated', async () => {
    const { app } = makeApp();
    await createItems(app, [
      { code: 'A', name: 'a', locationCode: 'R03-B-1' },
      { code: 'B', name: 'b', locationCode: 'R03-A-2' },
      { code: 'C', name: 'c', locationCode: 'R03-B-2' },
      { code: 'D', name: 'd', locationCode: 'R03' },          // rack, no shelf
      { code: 'E', name: 'e', locationCode: 'R10-C-1' },
      { code: 'F', name: 'f', locationCode: 'R2-D' },
      { code: 'G', name: 'g', locationCode: 'R100-A-1' },
      { code: 'H', name: 'h', locationCode: 'Store cupboard' }, // unparsed -> unlocated
      { code: 'I', name: 'i' },                                  // no location -> unlocated
    ]);
    const res = await request(app).get('/api/racks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      racks: [
        { rack: 'R02', shelves: ['D'], itemCount: 1 },
        { rack: 'R03', shelves: ['A', 'B'], itemCount: 4 },
        { rack: 'R10', shelves: ['C'], itemCount: 1 },
        { rack: 'R100', shelves: ['A'], itemCount: 1 },
      ],
      unlocated: 2,
    });
  });

  it('rack with only rack-level items has shelves []', async () => {
    const { app } = makeApp();
    await createItems(app, [{ code: 'A', name: 'a', locationCode: 'R07' }]);
    expect((await request(app).get('/api/racks')).body.racks).toEqual([{ rack: 'R07', shelves: [], itemCount: 1 }]);
  });

  it('seed data: R01..R06, shelves A-D', async () => {
    const { app } = makeApp({ seeded: true });
    const res = await request(app).get('/api/racks');
    expect(res.body.racks.map((r) => r.rack)).toEqual(['R01', 'R02', 'R03', 'R04', 'R05', 'R06']);
    expect(res.body.racks.reduce((n, r) => n + r.itemCount, 0)).toBe(SEED_ITEMS.length);
    expect(res.body.unlocated).toBe(0);
    for (const r of res.body.racks) for (const s of r.shelves) expect(['A', 'B', 'C', 'D']).toContain(s);
  });
});

describe('GET /api/racks/:rack', () => {
  let app;
  beforeEach(async () => {
    ({ app } = makeApp());
    await createItems(app, [
      { code: 'B10', name: 'b10', locationCode: 'R03-B-10' },
      { code: 'B2', name: 'b2', locationCode: 'R03-B-2' },
      { code: 'BX', name: 'bx', locationCode: 'R03-B' },       // shelf, no bin -> last in shelf
      { code: 'A1', name: 'a1', locationCode: 'R03-A-1' },
      { code: 'D1', name: 'd1', locationCode: 'R03-D-1' },
      { code: 'R3', name: 'rack level', locationCode: 'R03' }, // unshelved
      { code: 'OTHER', name: 'other', locationCode: 'R04-A-1' },
    ]);
  });

  it('items grouped by shelf (A..), sorted by bin, plus unshelved', async () => {
    const res = await request(app).get('/api/racks/R03');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['rack', 'shelves', 'unshelved']);
    expect(res.body.rack).toBe('R03');
    expect(res.body.shelves.map((s) => s.shelf)).toEqual(['A', 'B', 'D']);
    expect(res.body.shelves.map((s) => s.items.map((i) => i.code))).toEqual([['A1'], ['B2', 'B10', 'BX'], ['D1']]);
    for (const s of res.body.shelves) {
      expect(Object.keys(s).sort()).toEqual(['items', 'shelf']);
      s.items.forEach((i) => expectItemShape(expect, i));
    }
    expect(res.body.unshelved.map((i) => i.code)).toEqual(['R3']);
  });

  it.each(['r3', '3', 'R3', 'R003', 'Rack%203'])('accepts %s', async (rack) => {
    const res = await request(app).get(`/api/racks/${rack}`);
    expect(res.status).toBe(200);
    expect(res.body.rack).toBe('R03');
  });

  it('rack without items -> 404', async () => {
    const res = await request(app).get('/api/racks/R99');
    expect(res.status).toBe(404);
    expectErrorShape(expect, res.body);
  });

  it.each(['abc', 'R03-B', 'R', 'R1234'])('not a rack %s -> 400', async (rack) => {
    const res = await request(app).get(`/api/racks/${rack}`);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });
});
