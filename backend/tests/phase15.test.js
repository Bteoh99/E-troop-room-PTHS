// Phase 1.5 (docs/SPEC.md "Phase 1.5"): brand/model/barcode, unlocated filter, scan matching,
// leader PIN, static frontend serving, backups, .env.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import {
  makeApp, makeLeaderConfig, tmpDir, createItems, csv, xlsx, upload, allItems, expectErrorShape, expectItemShape,
  TEST_PIN, TEST_SCRYPT,
} from './helpers.js';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { ocrFold, tokenize, withinOneEdit, matchItems } from '../src/lib/scanMatch.js';
import { readConfig, setPin, hashPin, verifyPin } from '../src/auth/config.js';
import { signToken, verifyToken } from '../src/auth/tokens.js';
import { createLoginLimiter } from '../src/auth/rateLimit.js';
import { runBackup, rotateBackups, backupFileName, msUntilNextHour, backupSettings, scheduleBackups } from '../src/services/backup.js';
import { parseEnv, loadEnvFile } from '../src/lib/env.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = { dryRun: 'false' };
const codes = (res) => res.body.items.map((i) => i.code);
const quiet = { warn() {}, log() {} };

describe('A. migration v2', () => {
  it('fresh DB has brand/model/barcode and a unique barcode index', () => {
    const db = openDb(':memory:');
    const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['brand', 'model', 'barcode']));
    expect(db.prepare('SELECT MAX(version) v FROM schema_version').get().v).toBe(migrations.at(-1).version);
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_items_barcode_key'").get(); // v3
    expect(idx.sql).toMatch(/UNIQUE.*ltrim\(barcode, '0'\)/is);
  });

  it('an existing v1 database is upgraded in place, keeping its items', () => {
    const file = path.join(tmpDir(), 'v1.db');
    const v1 = new Database(file);
    v1.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    v1.exec(migrations[0].sql);
    v1.prepare("INSERT INTO schema_version VALUES (1, 'items', '2026-01-01')").run();
    v1.prepare(`INSERT INTO items (code, name, created_at, updated_at) VALUES ('OLD-1', 'Old tent', 'x', 'x')`).run();
    v1.close();
    const db = openDb(file);
    expect(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    expect(db.prepare('SELECT code, brand, model, barcode FROM items').all()).toEqual([{ code: 'OLD-1', brand: null, model: null, barcode: null }]);
    db.close();
    openDb(file).close(); // re-opening is a no-op
  });
});

describe('A. brand / model / barcode on items', () => {
  let app;
  beforeEach(() => ({ app } = makeApp()));

  it('are stored; barcode spaces removed and letters upper-cased; blank -> null', async () => {
    const res = await request(app).post('/api/items').send({ code: 'T1', name: 'Tent', brand: ' Coleman ', model: 'Sundome 4', barcode: ' 0765 0112 345a ' });
    expect(res.status).toBe(201);
    expectItemShape(expect, res.body);
    expect(res.body).toMatchObject({ brand: 'Coleman', model: 'Sundome 4', barcode: '07650112345A' });
    const cleared = await request(app).put(`/api/items/${res.body.id}`).send({ brand: '', model: null, barcode: '  ' });
    expect(cleared.body).toMatchObject({ brand: null, model: null, barcode: null });
  });

  it.each([
    [{ barcode: '123-456' }, 'barcode'], [{ barcode: 'x'.repeat(65) }, 'barcode'],
    [{ brand: 'b'.repeat(101) }, 'brand'], [{ model: 'm'.repeat(101) }, 'model'],
  ])('invalid %j -> 400', async (extra, field) => {
    const res = await request(app).post('/api/items').send({ code: 'T1', name: 'Tent', ...extra });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path)).toContain(field);
  });

  it('duplicate barcode -> 409 on create and on update; own barcode can be re-sent', async () => {
    const [a, b] = await createItems(app, [{ code: 'A', name: 'a', barcode: '111' }, { code: 'B', name: 'b' }]);
    const dup = await request(app).post('/api/items').send({ code: 'C', name: 'c', barcode: '111' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toMatchObject({ field: 'barcode', code: 'A' });
    expect((await request(app).put(`/api/items/${b.id}`).send({ barcode: '111' })).status).toBe(409);
    expect((await request(app).put(`/api/items/${a.id}`).send({ barcode: '111', name: 'a2' })).status).toBe(200);
  });

  it('search matches brand, model and barcode; an exact barcode ranks with exact code', async () => {
    await createItems(app, [
      { code: 'AAA-1', name: 'Code contains 4006381333931 in notes', notes: '4006381333931' },
      { code: 'ZZZ-9', name: 'Head torch', brand: 'Petzl', model: 'Tikkina', barcode: '4006381333931' },
      { code: 'TNT-1', name: 'Dome tent', brand: 'Coleman', model: 'Sundome 4' },
    ]);
    const s = (q) => request(app).get('/api/items').query({ q });
    expect(codes(await s('coleman'))).toEqual(['TNT-1']);
    expect(codes(await s('sundome'))).toEqual(['TNT-1']);
    expect(codes(await s('petzl tikkina'))).toEqual(['ZZZ-9']);
    expect(codes(await s('4006381333931'))).toEqual(['ZZZ-9', 'AAA-1']);
  });
});

describe('A. GET /api/items?unlocated=true', () => {
  it('lists items with no rack (no location or a non-coordinate location), sorted by code', async () => {
    const { app } = makeApp();
    await createItems(app, [
      { code: 'C', name: 'c' }, { code: 'A', name: 'a', locationCode: 'Store cupboard' },
      { code: 'B', name: 'b', locationCode: 'R01-A-1' }, { code: 'D', name: 'd', locationCode: 'R02' },
    ]);
    expect(codes(await request(app).get('/api/items?unlocated=true'))).toEqual(['A', 'C']);
    expect(codes(await request(app).get('/api/items?unlocated=1&q=cupboard'))).toEqual(['A']);
    expect(codes(await request(app).get('/api/items?unlocated=false'))).toEqual(['A', 'B', 'C', 'D']);
    const bad = await request(app).get('/api/items?unlocated=maybe');
    expect(bad.status).toBe(400);
    expectErrorShape(expect, bad.body);
  });
});

describe('A. import: brand / model / barcode columns', () => {
  it('English and Malay aliases; numeric EAN cells; blank keeps; barcode conflicts are warnings', async () => {
    const { app, db } = makeApp();
    await createItems(app, [{ code: 'OLD', name: 'Old', barcode: '999', brand: 'Keep' }]);
    const file = await xlsx([
      ['Kod', 'Nama', 'Jenama', 'No Model', 'Kod Bar'],
      ['T1', 'Tent', 'Coleman', 'Sundome 4', 76501123456],
      ['T2', 'Lamp', 'Petzl', '', '999'],
      ['T3', 'Saw', '', 'Pocketboy', '12-34'],
      ['OLD', 'Old', '', '', ''],
      ['T4', 'Knife', '', '', '76501123456'],
    ]);
    const res = await upload(app, file, 'a.xlsx', real);
    expect(res.status).toBe(200);
    expect(res.body.columns).toMatchObject({ brand: 2, model: 3, barcode: 4 });
    expect(res.body).toMatchObject({ created: 4, unchanged: 1, skipped: 0 });
    expect(res.body.errors.map((e) => e.row)).toEqual([3, 4, 6]);
    expect(res.body.errors.every((e) => e.message.startsWith('Warning:'))).toBe(true);
    const by = Object.fromEntries(allItems(db).map((r) => [r.code, r]));
    expect(by.T1).toMatchObject({ brand: 'Coleman', model: 'Sundome 4', barcode: '76501123456' });
    expect(by.T2).toMatchObject({ brand: 'Petzl', barcode: null });
    expect(by.T3).toMatchObject({ model: 'Pocketboy', barcode: null });
    expect(by.OLD).toMatchObject({ barcode: '999', brand: 'Keep' });
    expect(by.T4.barcode).toBeNull();
    expect(res.body.preview[0]).toMatchObject({ brand: 'Coleman', model: 'Sundome 4', barcode: '76501123456' });
  });

  it.each([['brand', 'Manufacturer'], ['brand', 'Make'], ['brand', 'Pengeluar'], ['model', 'Model Number'], ['barcode', 'EAN'], ['barcode', 'UPC']])(
    '%s alias %j', async (field, header) => {
      const { app } = makeApp();
      const res = await upload(app, csv([['Code', 'Name', header], ['A', 'a', 'X1']]), 'a.csv');
      expect(res.body.columns[field]).toBe(2);
    }
  );
});

describe('B. scan matching (pure)', () => {
  it('ocrFold maps O/I/L/S/B/Z and ignores separators', () => {
    for (const s of ['TNT-004', 'TNT-OO4', 'tnt 0o4', 'tnt_004', 'TNT004']) expect(ocrFold(s)).toBe('TNT004');
    expect(ocrFold('SL-1ZB')).toBe('51-128'.replace('-', ''));
  });
  it('tokenize drops short tokens and noise words', () => {
    expect(tokenize('MADE IN CHINA\nWarning: 2.5 kg  Coleman Sundome 4 x')).toEqual(['coleman', 'sundome']);
  });
  it('withinOneEdit', () => {
    expect(withinOneEdit('coleman', 'colemam')).toBe(true);
    expect(withinOneEdit('coleman', 'colman')).toBe(true);
    expect(withinOneEdit('coleman', 'coleeman')).toBe(true);
    expect(withinOneEdit('coleman', 'calemam')).toBe(false);
  });
  it('codes are found even when OCR splits or misreads them; unrelated text -> []', () => {
    const items = [
      { code: 'TNT-004', name: '4-man dome tent', brand: 'Coleman', model: 'Sundome 4', barcode: null },
      { code: 'TNT-006', name: '6-man patrol tent', brand: null, model: null, barcode: null },
    ];
    for (const text of ['TNT-OO4', 'tnt 004', 'tnt004', 'Item: TNT - 0 0 4']) {
      expect(matchItems(items, { text }).matches[0]).toMatchObject({ item: { code: 'TNT-004' }, score: 1, matchedOn: ['code'] });
    }
    expect(matchItems(items, { text: 'Colemam SUNDOME' }).matches[0]).toMatchObject({ item: { code: 'TNT-004' }, matchedOn: ['model', 'brand'] });
    expect(matchItems(items, { text: 'the quick brown fox' }).matches).toEqual([]);
  });
});

describe('B. POST /api/scan/match', () => {
  let publicApp;
  beforeEach(() => ({ publicApp } = makeApp({ seeded: true })));
  const scan = (body) => request(publicApp).post('/api/scan/match').send(body);

  it('is public and finds TNT-004 from a noisy label', async () => {
    const res = await scan({ text: 'COLEMAN®\nSundome 4\nTNT-OO4\nMADE IN CHINA  WARNING: keep away from fire' });
    expect(res.status).toBe(200);
    expect(res.body.matches[0].item.code).toBe('TNT-004');
    expect(res.body.matches[0].matchedOn).toEqual(expect.arrayContaining(['code', 'brand', 'model']));
    expectItemShape(expect, res.body.matches[0].item);
    expect(res.body.query.tokens).toEqual(expect.arrayContaining(['coleman', 'sundome']));
    expect(res.body.matches.length).toBeLessThanOrEqual(10);
    const scores = res.body.matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores.every((s) => s > 0 && s <= 1)).toBe(true);
  });

  it('exact barcode -> that item alone, score 1', async () => {
    const res = await scan({ barcode: '3342 5408 27257', text: 'Coleman' });
    expect(res.body).toEqual({ matches: [expect.objectContaining({ score: 1, matchedOn: ['barcode'] })], query: expect.objectContaining({ barcode: '3342540827257' }) });
    expect(res.body.matches[0].item.code).toBe('LGT-005');
  });

  it('unknown barcode without text -> no matches (200)', async () => {
    const res = await scan({ barcode: '0000000000000' });
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
  });

  it.each([[{}], [{ text: '   ' }], [{ barcode: 'x'.repeat(65) }], [{ text: 5 }], [{ barcode: 9312345678901 }]])('invalid %j -> 400', async (body) => {
    const res = await scan(body);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });
});

describe('C. leader PIN', () => {
  it('config stores only a scrypt hash + salt and a token secret', () => {
    const { configPath } = makeLeaderConfig('135790');
    const text = fs.readFileSync(configPath, 'utf8');
    expect(text).not.toContain('135790');
    const cfg = JSON.parse(text);
    expect(cfg.pin).toMatchObject({ algo: 'scrypt', salt: expect.any(String), hash: expect.any(String) });
    expect(cfg.tokenSecret).toEqual(expect.any(String));
  });

  it('verifyPin is right only for the right PIN; tokens verify and expire', async () => {
    const rec = hashPin('1234', TEST_SCRYPT);
    expect(await verifyPin('1234', rec)).toBe(true);
    expect(await verifyPin('1235', rec)).toBe(false);
    const secret = Buffer.alloc(32, 1).toString('base64');
    const { token } = signToken(secret, { now: 1000, ttlMs: 10 });
    expect(verifyToken(secret, token, { now: 1005 })).toMatchObject({ ok: true });
    expect(verifyToken(secret, token, { now: 1010 })).toEqual({ ok: false, reason: 'expired' });
    expect(verifyToken(Buffer.alloc(32, 2).toString('base64'), token, { now: 1005 })).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyToken(secret, token.slice(0, -2) + 'xx', { now: 1005 }).ok).toBe(false);
  });

  it('no PIN set: status says so, writes and login -> 403, reads/scan/template stay public', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, { configPath: path.join(tmpDir(), 'none.json'), staticDir: false });
    expect((await request(app).get('/api/auth/status')).body).toEqual({ pinSet: false, leader: false });
    for (const r of [
      request(app).post('/api/items').send({ code: 'A', name: 'a' }),
      request(app).post('/api/auth/login').send({ pin: '1234' }),
      request(app).post('/api/import').attach('file', csv([['Code', 'Name'], ['A', 'a']]), 'a.csv'),
    ]) {
      const res = await r;
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: 'Leader PIN not set. Run set-pin on the laptop.' } });
    }
    expect((await request(app).get('/api/items')).status).toBe(200);
    expect((await request(app).get('/api/import/template')).status).toBe(200);
    expect((await request(app).post('/api/scan/match').send({ text: 'tent' })).status).toBe(200);
  });

  it('login: wrong PIN 401, right PIN -> token that unlocks writes; status reports leader', async () => {
    const { publicApp } = makeApp({ leader: makeLeaderConfig() });
    const wrong = await request(publicApp).post('/api/auth/login').send({ pin: '0000' });
    expect(wrong.status).toBe(401);
    expectErrorShape(expect, wrong.body);
    expect((await request(publicApp).post('/api/auth/login').send({})).status).toBe(400);
    const ok = await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body).sort()).toEqual(['expiresAt', 'token']);
    const days = (Date.parse(ok.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const auth = { Authorization: `Bearer ${ok.body.token}` };
    expect((await request(publicApp).get('/api/auth/status').set(auth)).body).toEqual({ pinSet: true, leader: true });
    expect((await request(publicApp).get('/api/auth/status')).body).toEqual({ pinSet: true, leader: false });
    expect((await request(publicApp).post('/api/items').set(auth).send({ code: 'A', name: 'a' })).status).toBe(201);
  });

  it('every write needs a valid token (missing / garbage / other install) -> 401; reads do not', async () => {
    const { publicApp } = makeApp();
    const [item] = await createItems(makeApp().app, [{ code: 'A', name: 'a' }]); // other db, just for an id shape
    const other = makeLeaderConfig().token;
    const writes = [
      () => request(publicApp).post('/api/items').send({ code: 'B', name: 'b' }),
      () => request(publicApp).put(`/api/items/${item.id}`).send({ name: 'x' }),
      () => request(publicApp).delete(`/api/items/${item.id}`),
      () => request(publicApp).post('/api/import?dryRun=true').attach('file', csv([['Code', 'Name'], ['A', 'a']]), 'a.csv'),
    ];
    for (const header of [undefined, 'Bearer garbage', `Bearer ${other}`, 'Basic abc']) {
      for (const w of writes) {
        let r = w();
        if (header) r = r.set('Authorization', header);
        const res = await r;
        expect(res.status).toBe(401);
        expectErrorShape(expect, res.body);
      }
    }
    expect((await request(publicApp).get('/api/items')).status).toBe(200);
    expect((await request(publicApp).get('/api/racks')).status).toBe(200);
    expect((await request(publicApp).get('/api/categories')).status).toBe(200);
  });

  it('changing the PIN (set-pin) rotates the secret: old tokens stop working without a restart', async () => {
    const leader = makeLeaderConfig();
    const { publicApp } = makeApp({ leader });
    const auth = { Authorization: `Bearer ${leader.token}` };
    expect((await request(publicApp).get('/api/auth/status').set(auth)).body.leader).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    setPin(leader.configPath, '975310', TEST_SCRYPT);
    expect((await request(publicApp).get('/api/auth/status').set(auth)).body.leader).toBe(false);
    expect((await request(publicApp).post('/api/items').set(auth).send({ code: 'A', name: 'a' })).status).toBe(401);
    expect((await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN })).status).toBe(401);
    expect((await request(publicApp).post('/api/auth/login').send({ pin: '975310' })).status).toBe(200);
  });

  it('rate limit: 5 wrong tries -> 429 (even for the right PIN) for 5 minutes, then allowed again', async () => {
    let clock = 1_000_000;
    const limiter = createLoginLimiter({ now: () => clock });
    const { publicApp } = makeApp({ leader: makeLeaderConfig(), limiter });
    const login = (pin) => request(publicApp).post('/api/auth/login').send({ pin });
    for (let i = 0; i < 5; i++) expect((await login('1111')).status).toBe(401);
    const blocked = await login(TEST_PIN);
    expect(blocked.status).toBe(429);
    expectErrorShape(expect, blocked.body);
    expect(Number(blocked.headers['retry-after'])).toBe(300);
    clock += 5 * 60 * 1000;
    expect((await login(TEST_PIN)).status).toBe(200);
  });

  it('limiter: checks are reserved before scrypt; correct PIN clears the count; global slowdown, not lock-out', () => {
    let clock = 0;
    const l = createLoginLimiter({ now: () => clock });
    const fail = (ip) => l.begin(ip).done('fail');
    // one check in flight per IP: a second parallel attempt is refused straight away
    const first = l.begin('a');
    expect(first.ok).toBe(true);
    expect(l.begin('a')).toMatchObject({ ok: false, reason: 'busy', retryAfterSec: 1 });
    first.done('fail');
    for (let i = 0; i < 3; i++) fail('a');
    l.begin('a').done('ok'); // correct PIN resets 'a'
    fail('a');
    expect(l.begin('a').ok).toBe(true); // (left in flight on purpose)
    // two checks in flight globally
    const b = l.begin('b');
    expect(b.ok).toBe(true);
    expect(l.begin('c')).toMatchObject({ ok: false, reason: 'busy' });
    b.done('neutral');
    // global bucket: 10 wrong tries, then ~1 s waits for everyone; refills over time
    const l2 = createLoginLimiter({ now: () => clock });
    for (let i = 0; i < 10; i++) l2.begin(`ip${i}`).done('fail');
    expect(l2.begin('someone-else')).toMatchObject({ ok: false, reason: 'slow', retryAfterSec: 1 });
    clock += 1000;
    expect(l2.begin('someone-else').ok).toBe(true);
  });

  it('npm run set-pin -- --pin / --check (script)', () => {
    const configPath = path.join(tmpDir(), 'cfg', 'config.json');
    const run = (...args) => spawnSync(process.execPath, ['scripts/set-pin.js', ...args], {
      cwd: BACKEND, env: { ...process.env, CONFIG_PATH: configPath }, encoding: 'utf8', timeout: 20_000,
    });
    expect(run('--check').status).toBe(1);
    expect(run('--pin', '12').status).toBe(1);
    expect(run('--pin', '12345').status).toBe(1); // V2: new PINs need 6-8 digits
    const ok = run('--pin', '864200');
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).not.toContain('864200');
    expect(run('--check').status).toBe(0);
    expect(readConfig(configPath).pin.algo).toBe('scrypt');
  }, 30_000);
});

describe('D. serving the built frontend', () => {
  let app;
  beforeEach(() => {
    const dist = tmpDir('etroop-dist-');
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Store</title><div id="root"></div>');
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dist, 'assets', 'ocr.wasm'), Buffer.from([0, 97, 115, 109]));
    ({ app } = makeApp({ staticDir: dist }));
  });

  it('serves index.html for / and client-side routes, with security headers', async () => {
    for (const url of ['/', '/items/3', '/map', '/locate']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<div id="root">');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
    const res = await request(app).get('/');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).not.toMatch(/upgrade-insecure-requests/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('hashed assets are cached long; wasm has the right type; missing files and APIs are not index.html', async () => {
    const js = await request(app).get('/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toMatch(/immutable/);
    expect((await request(app).get('/assets/ocr.wasm')).headers['content-type']).toBe('application/wasm');
    expect((await request(app).get('/assets/missing.js')).status).toBe(404);
    const api = await request(app).get('/api/nope');
    expect(api.status).toBe(404);
    expectErrorShape(expect, api.body);
    expect((await request(app).get('/api/items')).headers['cache-control']).toBe('no-store');
  });

  it('is off when staticDir is false or the folder has no index.html', async () => {
    expect((await request(makeApp({ staticDir: false }).app).get('/')).status).toBe(404);
    expect((await request(makeApp({ staticDir: tmpDir() }).app).get('/')).status).toBe(404);
  });
});

describe('D. backups', () => {
  it('runBackup writes a readable copy named store-YYYY-MM-DD.db and keeps only the newest N', async () => {
    const { app, db } = makeApp();
    await createItems(app, [{ code: 'BK-1', name: 'Backed up' }]);
    const dir = path.join(tmpDir(), 'backups');
    for (let day = 1; day <= 5; day++) {
      const r = await runBackup(db, { dir, keep: 3, now: new Date(2026, 10, day, 21), log: quiet });
      expect(r.ok).toBe(true);
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['store-2026-11-03.db', 'store-2026-11-04.db', 'store-2026-11-05.db']);
    const copy = new Database(path.join(dir, 'store-2026-11-05.db'), { readonly: true });
    expect(copy.prepare('SELECT code FROM items').all()).toEqual([{ code: 'BK-1' }]);
    copy.close();
    // same day again: replaced, not duplicated
    expect((await runBackup(db, { dir, keep: 3, now: new Date(2026, 10, 5, 22), log: quiet })).ok).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(3);
  });

  it('an unusable backup folder only logs a warning', async () => {
    const { db } = makeApp();
    const notADir = path.join(tmpDir(), 'file.txt');
    fs.writeFileSync(notADir, 'x');
    const warnings = [];
    const r = await runBackup(db, { dir: path.join(notADir, 'sub'), log: { warn: (m) => warnings.push(m) } });
    expect(r.ok).toBe(false);
    expect(warnings[0]).toMatch(/backup .* failed/i);
  });

  it('rotateBackups ignores other files; helpers', () => {
    const dir = tmpDir();
    for (const f of ['store-2026-01-01.db', 'store-2026-01-02.db', 'notes.txt', 'store-latest.db']) fs.writeFileSync(path.join(dir, f), '');
    expect(rotateBackups(dir, 1)).toEqual(['store-2026-01-01.db']);
    expect(fs.readdirSync(dir).sort()).toEqual(['notes.txt', 'store-2026-01-02.db', 'store-latest.db']);
    expect(backupFileName(new Date(2026, 0, 9))).toBe('store-2026-01-09.db');
    expect(msUntilNextHour(21, new Date(2026, 0, 1, 20, 30))).toBe(30 * 60 * 1000);
    expect(msUntilNextHour(21, new Date(2026, 0, 1, 21, 0))).toBe(24 * 60 * 60 * 1000);
    expect(backupSettings({ BACKUP_HOUR: '7', BACKUP_KEEP: '5' })).toMatchObject({ hour: 7, keep: 5 });
    expect(backupSettings({ BACKUP_HOUR: '25', BACKUP_KEEP: 'x' })).toMatchObject({ hour: 21, keep: 30 });
  });

  it('scheduleBackups backs up immediately and can be stopped', async () => {
    const { db } = makeApp();
    const dir = path.join(tmpDir(), 'b');
    const s = scheduleBackups(db, { dir, hour: 21, keep: 30 }, { log: quiet });
    expect((await s.first).ok).toBe(true);
    s.stop();
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('npm run backup (script) writes into BACKUP_DIR', () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'store.db');
    openDb(dbFile).close();
    const r = spawnSync(process.execPath, ['scripts/backup.js'], {
      cwd: BACKEND, env: { ...process.env, DB_PATH: dbFile, BACKUP_DIR: path.join(dir, 'bk') }, encoding: 'utf8', timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'bk'))).toEqual([backupFileName()]);
  }, 30_000);
});

describe('D. .env loading', () => {
  it('parses KEY=VALUE, quotes and comments; real env wins', () => {
    expect(parseEnv('# c\nPORT=3001\nBACKUP_DIR="C:\\\\Users\\\\x\\\\My Drive"\nA = b # note\nexport B=\'q\'\nbad line\n')).toEqual({
      PORT: '3001', BACKUP_DIR: 'C:\\\\Users\\\\x\\\\My Drive', A: 'b', B: 'q',
    });
    const file = path.join(tmpDir(), '.env');
    fs.writeFileSync(file, 'X1=from-file\nX2=from-file\n');
    const env = { X1: 'from-env' };
    expect(loadEnvFile(file, env)).toEqual(['X2']);
    expect(env).toEqual({ X1: 'from-env', X2: 'from-file' });
    expect(loadEnvFile(path.join(tmpDir(), 'missing'), env)).toEqual([]);
  });
});
