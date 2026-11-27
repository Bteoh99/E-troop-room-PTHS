// Phase 1.5 fix round (docs/REVIEW-backend.md "Phase 1.5 review" P1-P10 + lead decisions 1-13).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { makeApp, makeLeaderConfig, tmpDir, createItems, csv, upload, allItems, expectErrorShape, TEST_PIN, TEST_SCRYPT } from './helpers.js';
import { openDb } from '../src/db/index.js';
import { createItem } from '../src/services/items.js';
import { matchItems, withinOneEdit, barcodeKey } from '../src/lib/scanMatch.js';
import { readConfig, setPin } from '../src/auth/config.js';
import { signToken, verifyToken } from '../src/auth/tokens.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = { dryRun: 'false' };

/** Each request may claim a client IP with X-Test-IP (shadows Express's req.ip getter). */
const withIp = (app) => (req, res) => {
  const ip = req.headers['x-test-ip'];
  if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
  return app(req, res);
};

describe('1. P1: parallel logins cannot get past the limits', () => {
  it('200 parallel wrong logins from one IP: at most 5 PINs are actually checked', async () => {
    const { publicApp } = makeApp({ leader: makeLeaderConfig() });
    const pins = Array.from({ length: 200 }, (_, i) => String(4700 + i)); // TEST_PIN is not among them
    const results = await Promise.all(pins.map((pin) => request(publicApp).post('/api/auth/login').send({ pin })));
    const statuses = results.map((r) => r.status);
    const checked = statuses.filter((s) => s === 401 || s === 200).length;
    expect(checked).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBe(200 - checked);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    for (const r of results.filter((x) => x.status === 429)) expectErrorShape(expect, r.body);
  }, 30_000);

  it('a burst that includes the right PIN is still capped (right PIN found only if it is among the first 5 checks)', async () => {
    const { publicApp } = makeApp({ leader: makeLeaderConfig() });
    const pins = [...Array.from({ length: 99 }, (_, i) => String(1000 + i)), TEST_PIN];
    const results = await Promise.all(pins.map((pin) => request(publicApp).post('/api/auth/login').send({ pin })));
    expect(results.filter((r) => r.status === 401 || r.status === 200).length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 200)).toHaveLength(0);
  }, 30_000);

  it('at most 2 checks in flight globally: other IPs get 429 (busy) during a burst, never a free check', async () => {
    const app = withIp(makeApp({ leader: makeLeaderConfig() }).publicApp);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      request(app).post('/api/auth/login').set('X-Test-IP', `10.1.0.${i}`).send({ pin: '0000' })));
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(10); // global bucket
    expect(results.every((r) => r.status === 401 || r.status === 429)).toBe(true);
  }, 30_000);
});

describe('4. P3: short / numeric codes cannot win from label noise', () => {
  const items = [
    { code: 'TNT-004', name: '4-man dome tent', brand: 'Coleman', model: 'Sundome 4' },
    { code: '220', name: 'Extension cable' },
    { code: '2024', name: 'Camp banner' },
    { code: 'BOIL', name: 'Kettle' },
    { code: '011', name: 'Cooking oil jug' },
  ];
  const label = 'Coleman dome tent\nAC 220-240V 50Hz\nMade in China 2024\nDo not B O I L water\nOIL\nTNT - 0 O 4';

  it('the real code wins; 220 / 2024 / BOIL / 011 are never top and never score 1', () => {
    const { matches } = matchItems(items, { text: label });
    expect(matches[0]).toMatchObject({ item: { code: 'TNT-004' }, score: 1 });
    for (const m of matches.slice(1)) expect(m.score).toBeLessThan(0.5);
    expect(matches.find((m) => m.item.code === 'BOIL')).toBeUndefined(); // letter-spaced word is not rebuilt for a weak code
    expect(matches.find((m) => m.item.code === '011')).toBeUndefined(); // "OIL" (no digit) does not fold into 011
  });

  it('a weak code still matches on its own whole word, with a low score', () => {
    expect(matchItems(items, { text: 'item 2024' }).matches[0]).toMatchObject({ item: { code: '2024' }, matchedOn: ['code'] });
    expect(matchItems(items, { text: 'item 2024' }).matches[0].score).toBeLessThan(0.5);
    expect(matchItems(items, { text: 'BOIL' }).matches[0].item.code).toBe('BOIL');
    expect(matchItems(items, { text: 'boiling water' }).matches).toEqual([]);
  });

  it('ties break by number of matched fields, then code', () => {
    const tie = [{ code: 'AAA-1', name: 'Tent pegs' }, { code: 'ZZZ-1', name: 'Tent pegs', notes: 'tent pegs' }];
    expect(matchItems(tie, { text: 'tent pegs' }).matches.map((m) => m.item.code)).toEqual(['ZZZ-1', 'AAA-1']);
  });
});

describe('5. rebuilt codes are bounded by length, not by a word count', () => {
  it.each(['T N T - 0 0 4', 'T N T 0 0 4', 'T-N-T-0-0-4'])('%j finds TNT-004', (text) => {
    expect(matchItems([{ code: 'TNT-004', name: 'Tent' }], { text }).matches[0]).toMatchObject({ item: { code: 'TNT-004' }, score: 1 });
  });
  it('a long letter-spaced code works too', () => {
    const items = [{ code: 'PIONEER-SPAR-0012', name: 'Spar' }];
    expect(matchItems(items, { text: 'P I O N E E R - S P A R - 0 0 1 2' }).matches[0].item.code).toBe('PIONEER-SPAR-0012');
  });
});

describe('6. P4: damaged config.json', () => {
  it.each([['{broken'], [''], ['[]']])('%j: login and status answer 503 "damaged" (not "PIN not set")', async (content) => {
    const leader = makeLeaderConfig();
    const { publicApp } = makeApp({ leader });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fs.writeFileSync(leader.configPath, content);
      for (const res of [
        await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN }),
        await request(publicApp).get('/api/auth/status'),
      ]) {
        expect(res.status).toBe(503);
        expect(res.body.error.message).toMatch(/settings file is damaged/);
      }
      expect(error).not.toHaveBeenCalled(); // an expected 503 is not logged as a crash
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('setPin refuses a damaged file unless force; force keeps the damaged file', () => {
    const file = path.join(tmpDir(), 'config.json');
    fs.writeFileSync(file, '{broken');
    expect(() => setPin(file, '123456', TEST_SCRYPT)).toThrow(/damaged/);
    setPin(file, '123456', TEST_SCRYPT, { force: true });
    expect(readConfig(file).pin.algo).toBe('scrypt');
    const kept = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('config.json.broken-'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8')).toBe('{broken');
  });

  it('npm run set-pin -- --force repairs it; without --force it explains how', () => {
    const file = path.join(tmpDir(), 'config.json');
    fs.writeFileSync(file, '');
    const run = (...args) => spawnSync(process.execPath, ['scripts/set-pin.js', ...args], {
      cwd: BACKEND, env: { ...process.env, CONFIG_PATH: file }, encoding: 'utf8', timeout: 20_000,
    });
    expect(run('--check').status).toBe(2);
    const refused = run('--pin', '135790');
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/--force/);
    expect(run('--pin', '135790', '--force').status).toBe(0);
    expect(run('--check').status).toBe(0);
  }, 30_000);
});

describe('8. P7: scan index cache and throttle', () => {
  it('the cached index sees every write (API, import, raw SQL)', async () => {
    const { app, publicApp, db } = makeApp();
    const scan = (text) => request(publicApp).post('/api/scan/match').send({ text });
    expect((await scan('Coleman')).body.matches).toEqual([]);
    const [item] = await createItems(app, [{ code: 'TNT-1', name: 'Tent', brand: 'Coleman' }]);
    expect((await scan('Coleman')).body.matches.map((m) => m.item.code)).toEqual(['TNT-1']);
    await request(app).put(`/api/items/${item.id}`).send({ brand: 'Vango' });
    expect((await scan('Coleman')).body.matches).toEqual([]);
    await upload(app, csv([['Code', 'Name', 'Brand'], ['TNT-2', 'Tent', 'Coleman']]), 'a.csv', real);
    expect((await scan('Coleman')).body.matches.map((m) => m.item.code)).toEqual(['TNT-2']);
    db.prepare("UPDATE items SET brand = 'Coleman' WHERE code = 'TNT-1'").run();
    expect((await scan('Coleman')).body.matches.map((m) => m.item.code).sort()).toEqual(['TNT-1', 'TNT-2']);
    await request(app).delete(`/api/items/${item.id}`);
    expect((await scan('Coleman')).body.matches.map((m) => m.item.code)).toEqual(['TNT-2']);
  });

  it('per-IP throttle: 30 scans per minute, then 429 with Retry-After; other IPs unaffected', async () => {
    const app = withIp(makeApp().publicApp);
    const scan = (ip) => request(app).post('/api/scan/match').set('X-Test-IP', ip).send({ text: 'tent' });
    for (let i = 0; i < 30; i++) expect((await scan('10.2.0.1')).status).toBe(200);
    const r = await scan('10.2.0.1');
    expect(r.status).toBe(429);
    expectErrorShape(expect, r.body);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await scan('10.2.0.2')).status).toBe(200);
  });
});

describe('9. P9: a barcode moved between items in one file', () => {
  it.each([
    ['A releases X before B takes it', [['A', 'a', 'Y'], ['B', 'b', 'X']]],
    ['B listed first, A releases X in a later row of A', [['B', 'b', ''], ['A', 'a', 'Y'], ['B', 'b', 'X']]],
  ])('%s: dry run and real import agree, B gets X, A gets Y', async (_label, rows) => {
    const { app, db } = makeApp();
    await createItems(app, [{ code: 'A', name: 'a', barcode: 'X0001' }, { code: 'B', name: 'b' }]);
    const file = csv([['Code', 'Name', 'Barcode'], ...rows.map(([c, n, b]) => [c, n, b && `${b}0001`])]);
    const dry = await upload(app, file, 'a.csv');
    const wet = await upload(app, file, 'a.csv', real);
    expect(wet.status).toBe(200);
    const strip = (b) => ({ ...b, dryRun: undefined, preview: b.preview.map((p) => ({ ...p, id: undefined })) });
    expect(strip(wet.body)).toEqual(strip(dry.body));
    expect(wet.body.errors.filter((e) => /barcode/.test(e.message))).toEqual([]);
    const by = Object.fromEntries(allItems(db).map((r) => [r.code, r.barcode]));
    expect(by).toEqual({ A: 'Y0001', B: 'X0001' });
  });

  it('taking a barcode that is NOT released is still a warning, in both runs', async () => {
    const { app, db } = makeApp();
    await createItems(app, [{ code: 'A', name: 'a', barcode: 'X0001' }]);
    const file = csv([['Code', 'Name', 'Barcode'], ['B', 'b', 'X0001']]);
    for (const q of [{}, real]) {
      const res = await upload(app, file, 'a.csv', q);
      expect(res.body.errors[0].message).toMatch(/^Warning: barcode X0001 already belongs to item A/);
    }
    expect(allItems(db).find((r) => r.code === 'B').barcode).toBeNull();
  });
});

describe('11. barcodes: text only, ASCII only, unique ignoring leading zeros', () => {
  let app;
  beforeEach(() => ({ app } = makeApp()));
  const post = (body) => request(app).post('/api/items').send({ code: 'A', name: 'a', ...body });

  it.each([[9312345678901], [true], [{ v: 1 }], ['ß12'], ['１２３']])('barcode %j -> 400', async (barcode) => {
    const res = await post({ barcode });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path)).toContain('barcode');
  });

  it('stored as given; "012345678905" and "12345678905" are the same barcode', async () => {
    const a = (await post({ barcode: '012345678905' })).body;
    expect(a.barcode).toBe('012345678905');
    const dup = await request(app).post('/api/items').send({ code: 'B', name: 'b', barcode: '12345678905' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toMatchObject({ field: 'barcode', code: 'A' });
    expect((await request(app).get('/api/items').query({ q: '12345678905' })).body.items[0].code).toBe('A');
  });

  it('scan: a scanned UPC matches an item whose barcode lost its leading zero in Excel', async () => {
    const { app: a2, publicApp } = makeApp();
    const res = await upload(a2, csv([['Code', 'Name', 'Barcode'], ['U1', 'Lantern', '12345678905']]), 'a.csv', real);
    expect(res.body.created).toBe(1);
    const scan = await request(publicApp).post('/api/scan/match').send({ barcode: '012345678905' });
    expect(scan.body.matches).toEqual([expect.objectContaining({ item: expect.objectContaining({ code: 'U1' }), score: 1 })]);
    // printed digits in OCR text, with the leading zero
    const text = await request(publicApp).post('/api/scan/match').send({ text: 'Lantern 0 12345 67890 5' });
    expect(text.body.matches[0]).toMatchObject({ item: { code: 'U1' }, matchedOn: expect.arrayContaining(['barcode']) });
  });

  it('import: same barcode without its leading zero does not overwrite the stored spelling', async () => {
    const { app: a2, db } = makeApp();
    await createItems(a2, [{ code: 'U1', name: 'Lantern', barcode: '012345678905' }]);
    const res = await upload(a2, csv([['Code', 'Name', 'Barcode'], ['U1', 'Lantern', '12345678905']]), 'a.csv', real);
    expect(res.body).toMatchObject({ unchanged: 1, updated: 0, errors: [] });
    expect(allItems(db)[0].barcode).toBe('012345678905');
  });

  it('barcodeKey', () => {
    expect(barcodeKey(' 0012 3 ')).toBe('123');
    expect(barcodeKey('000')).toBe('0');
  });
});

describe('scan: an exact model outranks a partial one (frontend review)', () => {
  const items = [
    { code: 'TNT-004', name: '4-man dome tent', brand: 'Coleman', model: 'Sundome 4' },
    { code: 'TNT-005', name: '4-person dome tent', brand: 'Coleman', model: 'Sundome 4P' },
  ];
  it.each(['COLEMAN SUNDOME 4P', 'Coleman\nSundome 4P\nMade in China', 'sundome 4p'])('%j -> Sundome 4P first', (text) => {
    const { matches } = matchItems(items, { text });
    expect(matches.map((m) => m.item.code)).toEqual(['TNT-005', 'TNT-004']);
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });
  it('and the other way round: "SUNDOME 4" -> Sundome 4 first', () => {
    const { matches } = matchItems(items, { text: 'COLEMAN SUNDOME 4' });
    expect(matches[0].item.code).toBe('TNT-004');
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });
  it('exact brand + model beats brand + partial model even when the partial item matches the name', () => {
    const { matches } = matchItems(items, { text: 'Coleman Sundome 4P dome tent' });
    expect(matches[0].item.code).toBe('TNT-005');
  });
});

describe('12. scan text truncation and Damerau distance', () => {
  it('text over 2000 characters is truncated, not rejected', async () => {
    const { publicApp, db } = makeApp();
    createItem(db, { code: 'TNT-004', name: 'Tent' });
    const res = await request(publicApp).post('/api/scan/match').send({ text: 'TNT-004 ' + 'x'.repeat(5000) + ' ignored-tail' });
    expect(res.status).toBe(200);
    expect(res.body.matches[0].item.code).toBe('TNT-004');
    expect(res.body.query.tokens).not.toContain('ignored');
  });

  it('a swap of two neighbouring letters is one edit', () => {
    expect(withinOneEdit('petzl', 'peztl')).toBe(true);
    expect(withinOneEdit('coleman', 'oclemna')).toBe(false);
    expect(matchItems([{ code: 'LGT-5', name: 'Head torch', brand: 'Petzl', model: 'Tikkina' }], { text: 'Peztl Tikkian' }).matches[0])
      .toMatchObject({ matchedOn: ['model', 'brand'] });
  });
});

describe('13. SPA fallback for page paths with a dot', () => {
  it('unknown extensions fall back to index.html; known asset types are real 404s (plain text)', async () => {
    const dist = tmpDir('etroop-dist-');
    fs.writeFileSync(path.join(dist, 'index.html'), '<div id="root">INDEX</div>');
    const { app } = makeApp({ staticDir: dist });
    for (const url of ['/items/1.5', '/search/v1.2', '/racks/R03.B']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('INDEX');
    }
    for (const url of ['/assets/x.js', '/x.css', '/a.png', '/b.svg', '/favicon.ico', '/core.wasm', '/m.json', '/x.js.map',
      '/f.woff2', '/robots.txt', '/manifest.webmanifest', '/eng.traineddata', '/eng.traineddata.gz']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    }
  });
});

describe('nits', () => {
  it('N2: a token with junk appended is rejected', () => {
    const secret = Buffer.alloc(32, 7).toString('base64');
    const { token } = signToken(secret);
    expect(verifyToken(secret, token).ok).toBe(true);
    for (const t of [`${token}!`, `${token}=`, `${token} `]) expect(verifyToken(secret, t).ok).toBe(false);
  });

  it('the DB index itself treats "0555" and "555" as the same barcode', () => {
    const db = openDb(':memory:');
    createItem(db, { code: 'A', name: 'a', barcode: '555' });
    expect(() => db.prepare("INSERT INTO items (code, name, barcode, created_at, updated_at) VALUES ('B','b','0555','x','x')").run()).toThrow(/UNIQUE/);
  });
});
