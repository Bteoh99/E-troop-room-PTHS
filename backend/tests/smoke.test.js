// Minimal smoke tests so `npm test` is wired up. Thorough tests belong to the backend tester.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { parseLocation } from '../src/lib/location.js';

describe('smoke', () => {
  it('GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('creates and finds an item by location', async () => {
    const created = await request(app).post('/api/items').send({ code: 'tnt-004', name: '4-man dome tent', locationCode: 'r3 b 2' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'TNT-004', locationCode: 'R03-B-2', rack: 'R03', shelf: 'B', bin: 2 });
    const list = await request(app).get('/api/items').query({ q: 'tent' });
    expect(list.body.items.map((i) => i.code)).toContain('TNT-004');
  });

  it('parses loose locations', () => {
    expect(parseLocation('3-B-2').locationCode).toBe('R03-B-2');
    expect(parseLocation('Store cupboard')).toEqual({ locationCode: 'Store cupboard', rack: null, shelf: null, bin: null });
  });
});
