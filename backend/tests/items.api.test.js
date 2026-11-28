// CRUD endpoints: /api/health, /api/items, /api/items/:id
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { makeApp, expectItemShape, expectErrorShape, createItems } from './helpers.js';

let app;
let db;
beforeEach(() => {
  ({ app, db } = makeApp());
});

describe('GET /api/health', () => {
  it('returns { ok: true }', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('unknown routes and bad bodies', () => {
  it('unknown /api route -> 404 JSON error', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expectErrorShape(expect, res.body);
  });

  it('malformed JSON -> 400 JSON error', async () => {
    const res = await request(app).post('/api/items').set('Content-Type', 'application/json').send('{"code": ');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('oversized JSON body -> 413 JSON error', async () => {
    const res = await request(app).post('/api/items').send({ code: 'X', name: 'Y', notes: 'a'.repeat(200_000) });
    expect(res.status).toBe(413);
    expectErrorShape(expect, res.body);
  });
});

describe('POST /api/items', () => {
  it('creates with defaults and returns 201 + Item', async () => {
    const res = await request(app).post('/api/items').send({ code: 'TNT-004', name: '4-man dome tent' });
    expect(res.status).toBe(201);
    expectItemShape(expect, res.body);
    expect(res.body).toMatchObject({
      code: 'TNT-004', name: '4-man dome tent', category: null, locationCode: null,
      rack: null, shelf: null, bin: null, quantity: 1, unit: 'pcs', notes: '',
      // Phase 1.6: condition -> counts; nothing counted yet
      goodQty: null, badQty: null, status: 'unchecked', countsMismatch: false, level: null, compartment: null, contents: [],
    });
    expect(res.body.createdAt).toBe(res.body.updatedAt);
  });

  it('stores code uppercase and trimmed, trims name, normalizes location', async () => {
    const res = await request(app).post('/api/items').send({
      code: '  tnt-004 ', name: '  4-man dome tent ', category: 'Tents', locationCode: 'r3 b 2',
      quantity: 6, unit: 'tents', condition: 'needs_repair', notes: 'Broken zip',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'TNT-004', name: '4-man dome tent', category: 'Tents', locationCode: 'R03-B-2',
      rack: 'R03', shelf: 'B', bin: 2, quantity: 6, unit: 'tents', notes: 'Broken zip',
      goodQty: 0, badQty: 6, status: 'attention', // Phase 1.6: condition needs_repair -> bad = quantity
    });
  });

  // Phase 1.6: `condition` is still accepted on write, but becomes good/bad counts and is not returned.
  it('accepts all four conditions (mapped to good/bad counts)', async () => {
    const expected = {
      good: { goodQty: 3, badQty: 0, status: 'ok', notes: '' },
      needs_repair: { goodQty: 0, badQty: 3, status: 'attention', notes: '' },
      damaged: { goodQty: 0, badQty: 3, status: 'attention', notes: '' },
      written_off: { goodQty: 0, badQty: 3, status: 'attention', notes: 'Written off' },
    };
    for (const [i, condition] of Object.keys(expected).entries()) {
      const res = await request(app).post('/api/items').send({ code: `C-${i}`, name: 'x', condition, quantity: 3 });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject(expected[condition]);
      expect(res.body).not.toHaveProperty('condition');
    }
  });

  it('keeps an unparseable location as-is (never rejects the item)', async () => {
    const res = await request(app).post('/api/items').send({ code: 'X1', name: 'Box', locationCode: 'Store cupboard' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ locationCode: 'Store cupboard', rack: null, shelf: null, bin: null });
  });

  it('a location like "Shelf 3" names no rack, so it is kept as text', async () => {
    const res = await request(app).post('/api/items').send({ code: 'X2', name: 'Box', locationCode: 'Shelf 3' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ locationCode: 'Shelf 3', rack: null, shelf: null, bin: null });
  });

  it('ignores id / timestamps / rack / shelf / bin in the body (derived from locationCode)', async () => {
    const res = await request(app).post('/api/items').send({
      id: 999, code: 'X1', name: 'Box', locationCode: 'R03-B-2', rack: 'R09', shelf: 'Z', bin: 77,
      createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(999);
    expect(res.body).toMatchObject({ rack: 'R03', shelf: 'B', bin: 2 });
    expect(res.body.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('empty strings for optional fields -> null / defaults', async () => {
    const res = await request(app).post('/api/items').send({ code: 'X1', name: 'Box', category: '', locationCode: '  ', unit: '', notes: null });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ category: null, locationCode: null, unit: 'pcs', notes: '' });
  });

  it('numeric strings for quantity are accepted; numeric code becomes a string', async () => {
    const res = await request(app).post('/api/items').send({ code: 123, name: 'Box', quantity: '5' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: '123', quantity: 5 });
  });

  it('quantity 0 is allowed', async () => {
    const res = await request(app).post('/api/items').send({ code: 'Z', name: 'Box', quantity: 0 });
    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(0);
  });

  it.each([
    // Phase 1.6: code is optional ("missing code" / "blank code" now create an item; see below)
    ['missing name', { code: 'A' }, 'name'],
    ['blank name', { code: 'A', name: '' }, 'name'],
    ['negative quantity', { code: 'A', name: 'x', quantity: -1 }, 'quantity'],
    ['fractional quantity', { code: 'A', name: 'x', quantity: 1.5 }, 'quantity'],
    ['text quantity', { code: 'A', name: 'x', quantity: 'lots' }, 'quantity'],
    ['bad condition', { code: 'A', name: 'x', condition: 'excellent' }, 'condition'],
    ['code too long', { code: 'A'.repeat(51), name: 'x' }, 'code'],
    ['name too long', { code: 'A', name: 'x'.repeat(201) }, 'name'],
    ['object as name', { code: 'A', name: { a: 1 } }, 'name'],
  ])('%s -> 400 with details', async (_label, body, field) => {
    const res = await request(app).post('/api/items').send(body);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.map((d) => d.path)).toContain(field);
  });

  it('code is optional (Phase 1.6): missing or blank code -> 201 with code null', async () => {
    for (const body of [{ name: 'x' }, { code: '   ', name: 'y' }]) {
      const res = await request(app).post('/api/items').send(body);
      expect(res.status).toBe(201);
      expect(res.body.code).toBeNull();
    }
  });

  it('empty body -> 400', async () => {
    const res = await request(app).post('/api/items');
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('JSON array body -> 400', async () => {
    const res = await request(app).post('/api/items').send([{ code: 'A', name: 'x' }]);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('duplicate code -> 409 (case-insensitive, trimmed)', async () => {
    await createItems(app, [{ code: 'TNT-004', name: 'Tent' }]);
    for (const code of ['TNT-004', 'tnt-004', ' Tnt-004 ']) {
      const res = await request(app).post('/api/items').send({ code, name: 'Another' });
      expect(res.status).toBe(409);
      expectErrorShape(expect, res.body);
    }
    expect(db.prepare('SELECT COUNT(*) n FROM items').get().n).toBe(1);
  });
});

describe('GET /api/items/:id', () => {
  it('returns the Item', async () => {
    const [created] = await createItems(app, [{ code: 'A1', name: 'Tent', locationCode: 'R1-A-1' }]);
    const res = await request(app).get(`/api/items/${created.id}`);
    expect(res.status).toBe(200);
    expectItemShape(expect, res.body);
    expect(res.body).toEqual(created);
  });

  it('unknown id -> 404', async () => {
    const res = await request(app).get('/api/items/9999');
    expect(res.status).toBe(404);
    expectErrorShape(expect, res.body);
  });

  it.each(['abc', '0', '-1', '1.5'])('invalid id %j -> 400', async (id) => {
    const res = await request(app).get(`/api/items/${id}`);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });
});

describe('PUT /api/items/:id', () => {
  let item;
  beforeEach(async () => {
    [item] = await createItems(app, [{
      code: 'TNT-004', name: 'Tent', category: 'Tents', locationCode: 'R03-B-2', quantity: 6, unit: 'pcs',
      condition: 'good', notes: 'Green',
    }]);
  });

  it('partial update changes only given fields', async () => {
    const res = await request(app).put(`/api/items/${item.id}`).send({ quantity: 4 });
    expect(res.status).toBe(200);
    expectItemShape(expect, res.body);
    // Phase 1.6: good (6) + bad (0) no longer equals the quantity (4) -> derived countsMismatch
    expect(res.body).toEqual({ ...item, quantity: 4, countsMismatch: true, updatedAt: res.body.updatedAt });
    expect(res.body.updatedAt >= item.updatedAt).toBe(true);
    expect(res.body.createdAt).toBe(item.createdAt);
  });

  it('changing locationCode re-derives rack/shelf/bin', async () => {
    const res = await request(app).put(`/api/items/${item.id}`).send({ locationCode: '5/d/7' });
    expect(res.body).toMatchObject({ locationCode: 'R05-D-7', rack: 'R05', shelf: 'D', bin: 7 });
    const res2 = await request(app).put(`/api/items/${item.id}`).send({ locationCode: 'R06' });
    expect(res2.body).toMatchObject({ locationCode: 'R06', rack: 'R06', shelf: null, bin: null });
  });

  it('clearing locationCode (null or "") sets rack/shelf/bin to null', async () => {
    for (const locationCode of [null, '']) {
      const res = await request(app).put(`/api/items/${item.id}`).send({ locationCode });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ locationCode: null, rack: null, shelf: null, bin: null });
    }
  });

  it('accepts a whole Item sent back (unknown/derived keys ignored)', async () => {
    const res = await request(app).put(`/api/items/${item.id}`).send({ ...item, name: 'Big tent', rack: 'R99', id: 12345 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: item.id, name: 'Big tent', rack: 'R03' });
  });

  it('empty body returns the item unchanged', async () => {
    const res = await request(app).put(`/api/items/${item.id}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(item);
  });

  it('code is uppercased; renaming to own code in other case is fine', async () => {
    const res = await request(app).put(`/api/items/${item.id}`).send({ code: 'tnt-004' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('TNT-004');
    const res2 = await request(app).put(`/api/items/${item.id}`).send({ code: 'tnt-005' });
    expect(res2.body.code).toBe('TNT-005');
  });

  it('changing code to another item\'s code -> 409', async () => {
    await createItems(app, [{ code: 'ROP-010', name: 'Rope' }]);
    const res = await request(app).put(`/api/items/${item.id}`).send({ code: 'rop-010' });
    expect(res.status).toBe(409);
    expectErrorShape(expect, res.body);
    expect((await request(app).get(`/api/items/${item.id}`)).body.code).toBe('TNT-004');
  });

  it.each([
    // Phase 1.6: { code: '' } clears the optional code and { quantity: null } means "not counted" (both valid now)
    [{ name: '' }], [{ quantity: -5 }], [{ condition: 'broken' }], [{ name: null }], [{ goodQty: -1 }], [{ contents: 'x' }],
  ])('invalid patch %j -> 400 and item unchanged', async (patch) => {
    const res = await request(app).put(`/api/items/${item.id}`).send(patch);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
    expect((await request(app).get(`/api/items/${item.id}`)).body).toEqual(item);
  });

  it('unknown id -> 404', async () => {
    const res = await request(app).put('/api/items/9999').send({ name: 'x' });
    expect(res.status).toBe(404);
    expectErrorShape(expect, res.body);
  });

  it('invalid id -> 400', async () => {
    const res = await request(app).put('/api/items/abc').send({ name: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/items/:id', () => {
  it('204 then 404 on GET and on a second DELETE', async () => {
    const [item] = await createItems(app, [{ code: 'A1', name: 'x' }]);
    const res = await request(app).delete(`/api/items/${item.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect((await request(app).get(`/api/items/${item.id}`)).status).toBe(404);
    const again = await request(app).delete(`/api/items/${item.id}`);
    expect(again.status).toBe(404);
    expectErrorShape(expect, again.body);
  });

  it('invalid id -> 400', async () => {
    expect((await request(app).delete('/api/items/abc')).status).toBe(400);
  });

  it('the code can be reused after delete', async () => {
    const [item] = await createItems(app, [{ code: 'A1', name: 'x' }]);
    await request(app).delete(`/api/items/${item.id}`);
    expect((await request(app).post('/api/items').send({ code: 'a1', name: 'y' })).status).toBe(201);
  });
});
