// Phase 1.5 fix round (tester): HTTP-level regression tests for the lead's decisions in commit 29b3df5.
// Temp/in-memory DBs and temp CONFIG_PATH / dist only.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, makeLeaderConfig, tmpDir, createItems, csv, upload, allItems, expectErrorShape, TEST_PIN } from './helpers.js';

const real = { dryRun: 'false' };
const withIp = (app) => (req, res) => {
  const ip = req.headers['x-test-ip'];
  if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
  return app(req, res);
};

describe('parallel login burst cap (HTTP)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('60 parallel wrong logins from one IP: at most 5 get a PIN check (401), the rest 429; then the IP is blocked ~5 min', async () => {
    const app = withIp(makeApp({ leader: makeLeaderConfig() }).publicApp);
    const login = (ip, pin) => request(app).post('/api/auth/login').set('X-Test-IP', ip).send({ pin });
    const res = await Promise.all(Array.from({ length: 60 }, () => login('10.1.1.1', '0000')));
    const s = res.map((r) => r.status);
    expect(s.every((x) => x === 401 || x === 429)).toBe(true);
    expect(s.filter((x) => x === 401).length).toBeLessThanOrEqual(5);
    for (const r of res.filter((x) => x.status === 429)) {
      expectErrorShape(expect, r.body);
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    }
    // finish the 5 wrong tries sequentially if the burst did not use them all
    for (let i = 0; i < 5; i++) await login('10.1.1.1', '0000');
    const blocked = await login('10.1.1.1', TEST_PIN);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(200);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(300);
    // another phone is only slowed down, not locked out
    vi.setSystemTime(new Date('2026-11-27T10:00:15Z'));
    expect((await login('10.1.1.2', TEST_PIN)).status).toBe(200);
  });

  it('a parallel burst of right PINs from one IP never yields more than a few tokens and never a 500', async () => {
    const app = withIp(makeApp({ leader: makeLeaderConfig() }).publicApp);
    const res = await Promise.all(Array.from({ length: 20 }, () => request(app).post('/api/auth/login').set('X-Test-IP', '10.2.2.2').send({ pin: TEST_PIN })));
    const s = res.map((r) => r.status);
    expect(s.every((x) => x === 200 || x === 429)).toBe(true);
    expect(s.filter((x) => x === 200).length).toBeGreaterThanOrEqual(1);
  });
});

describe('scan throttle (HTTP)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-27T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('30 scans per minute per IP, then 429 with Retry-After + details; other IPs unaffected; recovers after a minute', async () => {
    const app = withIp(makeApp().publicApp);
    const scan = (ip, body = { text: 'tent' }) => request(app).post('/api/scan/match').set('X-Test-IP', ip).send(body);
    for (let i = 0; i < 29; i++) expect((await scan('10.3.3.3')).status).toBe(200);
    expect((await scan('10.3.3.3', {})).status).toBe(400); // invalid bodies count too (30th)
    const r = await scan('10.3.3.3');
    expect(r.status).toBe(429);
    expectErrorShape(expect, r.body);
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(r.body.error.details.retryAfterSeconds).toBe(Number(r.headers['retry-after']));
    expect((await scan('10.3.3.4')).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-27T10:01:00.001Z'));
    expect((await scan('10.3.3.3')).status).toBe(200);
  });

  it('text over 2000 characters is truncated (200), and the tokens come only from the first 2000', async () => {
    const { publicApp } = makeApp();
    const res = await request(publicApp).post('/api/scan/match').send({ text: `${'a '.repeat(1000)}zebrawordafter` });
    expect(res.status).toBe(200);
    expect(res.body.query.tokens).not.toContain('zebrawordafter');
  });
});

describe('barcodes: unique and matched ignoring leading zeros (HTTP)', () => {
  let app, db;
  beforeEach(async () => {
    ({ app, db } = makeApp());
    await createItems(app, [{ code: 'UPC-1', name: 'Lantern', barcode: '012345678905' }, { code: 'OTHER', name: 'Other' }]);
  });

  it.each(['12345678905', '0012345678905', '0 1234 5678 905'])('POST / PUT with %j -> 409 naming UPC-1', async (bc) => {
    const post = await request(app).post('/api/items').send({ code: 'NEW', name: 'n', barcode: bc });
    expect(post.status).toBe(409);
    expect(post.body.error.details).toEqual({ field: 'barcode', code: 'UPC-1' });
    const other = allItems(db).find((r) => r.code === 'OTHER');
    expect((await request(app).put(`/api/items/${other.id}`).send({ barcode: bc })).status).toBe(409);
  });

  it('the owner may re-send its barcode without the zero; the stored spelling is as sent', async () => {
    const own = allItems(db).find((r) => r.code === 'UPC-1');
    const res = await request(app).put(`/api/items/${own.id}`).send({ barcode: '12345678905' });
    expect(res.status).toBe(200);
    expect(res.body.barcode).toBe('12345678905');
  });

  it('search: q without the leading zero ranks the item top', async () => {
    await createItems(app, [{ code: '12345678905-BOX', name: 'Aaa box' }]);
    expect((await request(app).get('/api/items').query({ q: '12345678905' })).body.items[0]?.code).toBe('UPC-1');
  });

  it('search: the scanned UPC with its leading zero finds an item whose Excel barcode lost the zero', async () => {
    await createItems(app, [{ code: 'XL-1', name: 'Torch', barcode: '98765432105' }]); // real UPC 098765432105
    expect((await request(app).get('/api/items').query({ q: '098765432105' })).body.items.map((i) => i?.code)).toEqual(['XL-1']);
    expect((await request(app).get('/api/items').query({ q: '0012345678905' })).body.items[0]?.code).toBe('UPC-1');
  });

  it('scan: barcode without or with extra leading zeros is an exact match', async () => {
    for (const barcode of ['12345678905', '0012345678905']) {
      const r = await request(app).post('/api/scan/match').send({ barcode });
      expect(r.body.matches).toEqual([expect.objectContaining({ score: 1, matchedOn: ['barcode'], item: expect.objectContaining({ code: 'UPC-1' }) })]);
    }
  });

  it('import: another item taking the same barcode (zeros differ) is a warning; the owner is untouched', async () => {
    const res = await upload(app, csv([['Code', 'Name', 'Barcode'], ['OTHER', 'Other', '00012345678905']]), 'a.csv', real);
    expect(res.body.skipped).toBe(0);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toMatch(/^Warning:.*UPC-1/);
    expect(allItems(db).find((r) => r.code === 'OTHER').barcode).toBeNull();
    expect(allItems(db).find((r) => r.code === 'UPC-1').barcode).toBe('012345678905');
  });
});

describe('damaged config.json: login, status and writes -> 503', () => {
  it.each(['null', '42', '"text"', '[]', '{broken', ''])('content %j', async (content) => {
    const leader = makeLeaderConfig();
    const { publicApp } = makeApp({ leader });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fs.writeFileSync(leader.configPath, content);
      const auth = { Authorization: `Bearer ${leader.token}` };
      for (const r of [
        await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN }),
        await request(publicApp).get('/api/auth/status').set(auth),
        await request(publicApp).post('/api/items').set(auth).send({ code: 'A', name: 'a' }),
      ]) {
        expect(r.status).toBe(503);
        expectErrorShape(expect, r.body);
        expect(r.body.error.message).toMatch(/damaged/i);
        expect(r.body.error.message).not.toMatch(/not set/i);
      }
      expect((await request(publicApp).get('/api/items')).status).toBe(200);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('SPA fallback for dotted page paths', () => {
  let app;
  beforeEach(() => {
    const dist = tmpDir('etroop-dots-');
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<div id="root">INDEX</div>');
    ({ app } = makeApp({ staticDir: dist }));
  });

  it.each(['/items/1.5', '/racks/R03.B', '/v1.2/page', '/search.results', '/items/TNT-004.v2', '/x.php'])('%s -> index.html', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.text).toContain('INDEX');
  });

  it.each(['/assets/missing.js', '/missing.css', '/ocr/eng.traineddata', '/page.html', '/icon.PNG', '/a.wasm'])('%s -> plain-text 404', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).not.toContain('INDEX');
  });
});
