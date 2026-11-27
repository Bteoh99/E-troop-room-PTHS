// Phase 1.5 (tester): auth on every write, PIN rate limiting, setup/corrupt config, brand/model/barcode,
// unlocated, import aliases, migration v1 -> v2, scan matching, static serving, backups.
// Temp/in-memory DBs, temp CONFIG_PATH / BACKUP_DIR / dist only.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import {
  makeApp, makeLeaderConfig, tmpDir, createItems, csv, xlsx, upload, allItems, expectErrorShape, expectItemShape,
  TEST_PIN, TEST_SCRYPT,
} from './helpers.js';
import { createApp, resolveStaticDir } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { readConfig, setPin } from '../src/auth/config.js';
import { signToken } from '../src/auth/tokens.js';
import { createItem } from '../src/services/items.js';
import { matchItems } from '../src/lib/scanMatch.js';
import { runBackup, rotateBackups, scheduleBackups } from '../src/services/backup.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const real = { dryRun: 'false' };
const codes = (res) => res.body.items.map((i) => i.code);
const quiet = { warn() {}, log() {} };
const REQUIRED = 'Leader PIN required. Unlock leader mode first.';
const EXPIRED = 'Leader session expired. Enter the leader PIN again.';
const NOT_SET = 'Leader PIN not set. Run set-pin on the laptop.';

/** Wrap an app so each request can claim a client IP via the X-Test-IP header (own `ip` shadows Express's getter). */
const withIp = (app) => (req, res) => {
  const ip = req.headers['x-test-ip'];
  if (ip) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
  return app(req, res);
};

function tamperPayload(token) {
  const [payload, sig] = token.split('.');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  data.exp += 365 * DAY;
  return `${Buffer.from(JSON.stringify(data)).toString('base64url')}.${sig}`;
}
function tamperSig(token) {
  const [payload, sig] = token.split('.');
  const mid = Math.floor(sig.length / 2);
  return `${payload}.${sig.slice(0, mid)}${sig[mid] === 'A' ? 'B' : 'A'}${sig.slice(mid + 1)}`;
}

// ---------------------------------------------------------------------------------------------
describe('C. every write endpoint requires a valid leader token', () => {
  let publicApp, db, leader, item;
  beforeEach(async () => {
    leader = makeLeaderConfig();
    ({ publicApp, db } = makeApp({ leader }));
    item = createItem(db, { code: 'KEEP', name: 'Keep me', quantity: 3 });
  });

  const secret = () => readConfig(leader.configPath).tokenSecret;
  const otherInstall = () => signToken(readConfig(makeLeaderConfig().configPath).tokenSecret).token;
  const badAuth = {
    'no header': () => undefined,
    'empty Bearer': () => 'Bearer ',
    'Basic scheme': () => 'Basic dXNlcjpwYXNz',
    'garbage token': () => 'Bearer not-a-token',
    'tampered payload (exp extended)': () => `Bearer ${tamperPayload(leader.token)}`,
    'tampered signature': () => `Bearer ${tamperSig(leader.token)}`,
    'token from another install': () => `Bearer ${otherInstall()}`,
    'extra segment': () => `Bearer ${leader.token}.x`,
    'two tokens': () => `Bearer ${leader.token} ${leader.token}`,
    '600-char token': () => `Bearer ${'a'.repeat(600)}`,
    'token without scheme': () => leader.token,
  };
  const writes = {
    'POST /api/items': (r) => r.post('/api/items').send({ code: 'NEW', name: 'New' }),
    'PUT /api/items/:id': (r) => r.put(`/api/items/${item.id}`).send({ name: 'Changed' }),
    'DELETE /api/items/:id': (r) => r.delete(`/api/items/${item.id}`),
    'POST /api/import (dry run)': (r) => r.post('/api/import').attach('file', csv([['Code', 'Name'], ['NEW', 'New']]), 'a.csv'),
    'POST /api/import (real)': (r) => r.post('/api/import?dryRun=false').attach('file', csv([['Code', 'Name'], ['NEW', 'New']]), 'a.csv'),
  };
  const send = (endpoint, auth) => {
    const r = request(publicApp);
    const wrap = { post: (u) => withAuth(r.post(u)), put: (u) => withAuth(r.put(u)), delete: (u) => withAuth(r.delete(u)) };
    function withAuth(req) {
      return auth === undefined ? req : req.set('Authorization', auth);
    }
    return writes[endpoint](wrap);
  };

  for (const endpoint of Object.keys(writes)) {
    it.each(Object.keys(badAuth))(`${endpoint} with %s -> 401, nothing written`, async (variant) => {
      const before = allItems(db);
      const res = await send(endpoint, badAuth[variant]());
      expect(res.status).toBe(401);
      expectErrorShape(expect, res.body);
      expect(res.body.error.message).toBe(REQUIRED);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(allItems(db)).toEqual(before);
    });

    it(`${endpoint} with an expired token -> 401 "session expired"`, async () => {
      const { token } = signToken(secret(), { now: Date.now() - 31 * DAY });
      const res = await send(endpoint, `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe(EXPIRED);
    });

    it(`${endpoint} with a valid token (also lower-case "bearer") succeeds`, async () => {
      const res = await send(endpoint, `bearer ${leader.token}`);
      expect([200, 201, 204]).toContain(res.status);
    });
  }

  it('the 401 comes before body validation (invalid body, no token -> 401 not 400)', async () => {
    const res = await request(publicApp).post('/api/items').send({ quantity: -5 });
    expect(res.status).toBe(401);
  });

  it('PATCH / OPTIONS on items also need the token', async () => {
    expect((await request(publicApp).patch(`/api/items/${item.id}`).send({})).status).toBe(401);
    expect((await request(publicApp).options('/api/items')).status).toBe(401);
  });

  it('reads, scan and template stay public even with a garbage token', async () => {
    const bad = { Authorization: 'Bearer garbage' };
    for (const url of ['/api/items', `/api/items/${item.id}`, '/api/categories', '/api/racks', '/api/import/template', '/api/health', '/api/auth/status']) {
      expect((await request(publicApp).get(url).set(bad)).status, url).toBe(200);
    }
    expect((await request(publicApp).post('/api/scan/match').set(bad).send({ text: 'keep' })).status).toBe(200);
  });

  it('auth/status: leader true only with a valid, unexpired token', async () => {
    const st = (auth) => request(publicApp).get('/api/auth/status').set(auth ? { Authorization: auth } : {});
    expect((await st()).body).toEqual({ pinSet: true, leader: false });
    expect((await st(`Bearer ${leader.token}`)).body).toEqual({ pinSet: true, leader: true });
    expect((await st(`Bearer ${tamperSig(leader.token)}`)).body.leader).toBe(false);
    expect((await st(`Bearer ${signToken(secret(), { now: Date.now() - 31 * DAY }).token}`)).body.leader).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('C. login and token lifetime', () => {
  afterEach(() => vi.useRealTimers());

  it('login returns { token, expiresAt } 30 days ahead; the token works for writes', async () => {
    const { publicApp } = makeApp({ leader: makeLeaderConfig() });
    const res = await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'token']);
    expect(Math.abs(Date.parse(res.body.expiresAt) - (Date.now() + 30 * DAY))).toBeLessThan(60_000);
    const w = await request(publicApp).post('/api/items').set('Authorization', `Bearer ${res.body.token}`).send({ code: 'A', name: 'a' });
    expect(w.status).toBe(201);
  });

  it('PIN may be sent as a number; missing / non-string pin -> 400', async () => {
    const { publicApp } = makeApp({ leader: makeLeaderConfig() });
    expect((await request(publicApp).post('/api/auth/login').send({ pin: Number(TEST_PIN) })).status).toBe(200);
    for (const body of [{}, { pin: null }, { pin: ['2468'] }, { pin: 'x'.repeat(40) }]) {
      const r = await request(publicApp).post('/api/auth/login').send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expectErrorShape(expect, r.body);
    }
  });

  it('wrong PIN -> 401 "Wrong PIN."; malformed PINs are simply wrong', async () => {
    const { publicApp } = makeApp({ leader: makeLeaderConfig() });
    for (const pin of ['1357', '123', 'abcd', ' 2468', '24680000']) {
      const r = await request(publicApp).post('/api/auth/login').send({ pin });
      expect(r.status, pin).toBe(401);
      expect(r.body.error.message).toBe('Wrong PIN.');
    }
  });

  it('a token expires after 30 days (fake clock): 401 "session expired", status leader false', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T10:00:00Z'));
    const { publicApp } = makeApp({ leader: makeLeaderConfig() });
    const { token } = (await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN })).body;
    const auth = { Authorization: `Bearer ${token}` };
    vi.setSystemTime(new Date('2026-12-26T09:59:00Z'));
    expect((await request(publicApp).post('/api/items').set(auth).send({ code: 'A', name: 'a' })).status).toBe(201);
    vi.setSystemTime(new Date('2026-12-26T10:00:01Z'));
    const res = await request(publicApp).post('/api/items').set(auth).send({ code: 'B', name: 'b' });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe(EXPIRED);
    expect((await request(publicApp).get('/api/auth/status').set(auth)).body.leader).toBe(false);
  });

  it('changing the PIN (setPin) invalidates all tokens without a restart; old PIN stops working', async () => {
    const leader = makeLeaderConfig();
    const { publicApp } = makeApp({ leader });
    const t1 = (await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN })).body.token;
    const t2 = (await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN })).body.token;
    setPin(leader.configPath, '13579', TEST_SCRYPT);
    for (const t of [t1, t2, leader.token]) {
      expect((await request(publicApp).delete('/api/items/1').set('Authorization', `Bearer ${t}`)).status).toBe(401);
    }
    expect((await request(publicApp).post('/api/auth/login').send({ pin: TEST_PIN })).status).toBe(401);
    const fresh = (await request(publicApp).post('/api/auth/login').send({ pin: '13579' })).body.token;
    expect((await request(publicApp).post('/api/items').set('Authorization', `Bearer ${fresh}`).send({ code: 'A', name: 'a' })).status).toBe(201);
  });

  it('changing the PIN with the set-pin script (separate process) also invalidates tokens of a running app', async () => {
    const leader = makeLeaderConfig();
    const { publicApp } = makeApp({ leader });
    const auth = { Authorization: `Bearer ${leader.token}` };
    expect((await request(publicApp).get('/api/auth/status').set(auth)).body.leader).toBe(true);
    const r = spawnSync(process.execPath, ['scripts/set-pin.js', '--pin', '86420'], {
      cwd: BACKEND, env: { ...process.env, CONFIG_PATH: leader.configPath }, encoding: 'utf8', timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('86420');
    expect((await request(publicApp).get('/api/auth/status').set(auth)).body.leader).toBe(false);
    expect((await request(publicApp).post('/api/auth/login').send({ pin: '86420' })).status).toBe(200);
  }, 30_000);

  it('config.json never contains the PIN in clear text', () => {
    const { configPath } = makeLeaderConfig('24681357');
    const text = fs.readFileSync(configPath, 'utf8');
    expect(text).not.toContain('24681357');
    expect(JSON.parse(text).pin).toMatchObject({ algo: 'scrypt', salt: expect.any(String), hash: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------------------------
describe('C. PIN rate limiting (default limiter, fake clock)', () => {
  let app;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T10:00:00Z'));
    app = withIp(makeApp({ leader: makeLeaderConfig() }).publicApp);
  });
  afterEach(() => vi.useRealTimers());
  const login = (ip, pin) => request(app).post('/api/auth/login').set('X-Test-IP', ip).send({ pin });

  it('5 wrong tries from one IP -> 429 with Retry-After 300 and details.retryAfterSeconds; even the right PIN', async () => {
    for (let i = 0; i < 5; i++) expect((await login('10.0.0.1', '0000')).status).toBe(401);
    for (const pin of ['0000', TEST_PIN]) {
      const r = await login('10.0.0.1', pin);
      expect(r.status).toBe(429);
      expectErrorShape(expect, r.body);
      expect(r.headers['retry-after']).toBe('300');
      expect(r.body.error.details).toEqual({ retryAfterSeconds: 300 });
    }
  });

  it('Retry-After counts down; the block expires after 5 minutes', async () => {
    for (let i = 0; i < 5; i++) await login('10.0.0.1', '0000');
    vi.setSystemTime(new Date('2026-11-26T10:02:00Z'));
    expect((await login('10.0.0.1', TEST_PIN)).headers['retry-after']).toBe('180');
    vi.setSystemTime(new Date('2026-11-26T10:04:59.500Z'));
    expect((await login('10.0.0.1', TEST_PIN)).headers['retry-after']).toBe('1');
    vi.setSystemTime(new Date('2026-11-26T10:05:00.001Z'));
    expect((await login('10.0.0.1', TEST_PIN)).status).toBe(200);
  });

  it('the limit is per IP: another IP can still log in', async () => {
    for (let i = 0; i < 5; i++) await login('10.0.0.1', '0000');
    expect((await login('10.0.0.1', TEST_PIN)).status).toBe(429);
    expect((await login('10.0.0.2', TEST_PIN)).status).toBe(200);
    expect((await login('10.0.0.1', TEST_PIN)).status).toBe(429); // B's success does not unblock A
  });

  it('wrong tries spread over more than 5 minutes do not block', async () => {
    for (let i = 0; i < 4; i++) await login('10.0.0.1', '0000');
    vi.setSystemTime(new Date('2026-11-26T10:05:01Z'));
    for (let i = 0; i < 4; i++) expect((await login('10.0.0.1', '0000')).status).toBe(401);
    expect((await login('10.0.0.1', TEST_PIN)).status).toBe(200);
  });

  it('a correct PIN resets that IP\'s count', async () => {
    for (let i = 0; i < 4; i++) await login('10.0.0.1', '0000');
    expect((await login('10.0.0.1', TEST_PIN)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login('10.0.0.1', '0000')).status).toBe(401);
    expect((await login('10.0.0.1', TEST_PIN)).status).toBe(200);
  });

  // fix round (lead decision 2): the global 20-wrong / 5-minute lock-out became a global SLOWDOWN
  // (bucket of 10 wrong tries, refilling 1 per second), so nobody can lock every leader out for minutes.
  it('global slowdown: after 10 wrong tries from many IPs everyone waits ~1 s (not 5 minutes)', async () => {
    for (let ip = 1; ip <= 5; ip++) {
      for (let i = 0; i < 2; i++) expect((await login(`10.0.1.${ip}`, '0000')).status).toBe(401);
    }
    const r = await login('10.9.9.9', TEST_PIN); // never tried before
    expect(r.status).toBe(429);
    expectErrorShape(expect, r.body);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(1);
    vi.setSystemTime(new Date('2026-11-26T10:00:01.000Z'));
    expect((await login('10.9.9.9', TEST_PIN)).status).toBe(200);
  });

  it('400 (missing pin) attempts are not counted as wrong tries', async () => {
    for (let i = 0; i < 10; i++) expect((await request(app).post('/api/auth/login').set('X-Test-IP', '10.0.0.7').send({})).status).toBe(400);
    expect((await login('10.0.0.7', TEST_PIN)).status).toBe(200);
  });

  it('writes are not rate limited by wrong PINs (a blocked IP keeps a valid token working)', async () => {
    const { token } = (await login('10.0.0.1', TEST_PIN)).body;
    for (let i = 0; i < 5; i++) await login('10.0.0.1', '0000');
    const w = await request(app).post('/api/items').set('X-Test-IP', '10.0.0.1').set('Authorization', `Bearer ${token}`).send({ code: 'A', name: 'a' });
    expect(w.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------
describe('C. setup-needed (no PIN) and damaged config', () => {
  const missingConfig = () => path.join(tmpDir('etroop-nocfg-'), 'config.json');

  it('no config file: writes 403 with the exact message, login 403, status pinSet false; reads public', async () => {
    const db = openDb(':memory:');
    const app = createApp(db, { configPath: missingConfig(), staticDir: false });
    const tries = [
      request(app).post('/api/items').send({ code: 'A', name: 'a' }),
      request(app).put('/api/items/1').send({ name: 'x' }),
      request(app).delete('/api/items/1'),
      request(app).post('/api/import').attach('file', csv([['Code', 'Name'], ['A', 'a']]), 'a.csv'),
      request(app).post('/api/auth/login').send({ pin: TEST_PIN }),
    ];
    for (const res of await Promise.all(tries)) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { message: NOT_SET } });
    }
    expect((await request(app).get('/api/auth/status')).body).toEqual({ pinSet: false, leader: false });
    expect((await request(app).get('/api/items')).status).toBe(200);
    expect((await request(app).get('/api/import/template')).status).toBe(200);
    expect((await request(app).post('/api/scan/match').send({ text: 'tent' })).status).toBe(200);
  });

  it('a config with a PIN but no token secret counts as not set', async () => {
    const configPath = missingConfig();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ pin: { algo: 'scrypt', salt: 'x', hash: 'y' } }));
    const app = createApp(openDb(':memory:'), { configPath, staticDir: false });
    expect((await request(app).post('/api/items').send({ code: 'A', name: 'a' })).status).toBe(403);
  });

  it('setting the PIN while running ends setup mode without a restart', async () => {
    const configPath = missingConfig();
    const app = createApp(openDb(':memory:'), { configPath, staticDir: false });
    expect((await request(app).post('/api/auth/login').send({ pin: TEST_PIN })).status).toBe(403);
    setPin(configPath, TEST_PIN, TEST_SCRYPT);
    expect((await request(app).post('/api/auth/login').send({ pin: TEST_PIN })).status).toBe(200);
  });

  it.each([['{broken'], ['']])('damaged config.json %j -> 503 on every write (even with a token), recovers after set-pin', async (content) => {
    const leader = makeLeaderConfig();
    const { publicApp } = makeApp({ leader });
    const auth = { Authorization: `Bearer ${leader.token}` };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(leader.configPath, content);
    try {
      for (const res of [
        await request(publicApp).post('/api/items').set(auth).send({ code: 'A', name: 'a' }),
        await request(publicApp).put('/api/items/1').set(auth).send({ name: 'a' }),
        await request(publicApp).delete('/api/items/1').set(auth),
        await request(publicApp).post('/api/import').set(auth).attach('file', csv([['Code', 'Name'], ['A', 'a']]), 'a.csv'),
        await request(publicApp).post('/api/items').send({ code: 'A', name: 'a' }),
      ]) {
        expect(res.status).toBe(503);
        expectErrorShape(expect, res.body);
      }
      expect((await request(publicApp).get('/api/items')).status).toBe(200);
      fs.rmSync(leader.configPath);
      setPin(leader.configPath, '5555', TEST_SCRYPT);
      const { token } = (await request(publicApp).post('/api/auth/login').send({ pin: '5555' })).body;
      expect((await request(publicApp).post('/api/items').set('Authorization', `Bearer ${token}`).send({ code: 'A', name: 'a' })).status).toBe(201);
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('A. brand / model / barcode CRUD', () => {
  let app;
  beforeEach(() => ({ app } = makeApp()));
  const post = (body) => request(app).post('/api/items').send(body);

  it('defaults to null; full Item shape includes them', async () => {
    const res = await post({ code: 'A', name: 'a' });
    expectItemShape(expect, res.body);
    expect(res.body).toMatchObject({ brand: null, model: null, barcode: null });
  });

  it('brand / model trimmed; "" and null clear; > 100 chars -> 400', async () => {
    const res = await post({ code: 'A', name: 'a', brand: '  Coleman ', model: ' Sundome 4 ' });
    expect(res.body).toMatchObject({ brand: 'Coleman', model: 'Sundome 4' });
    const cleared = await request(app).put(`/api/items/${res.body.id}`).send({ brand: '', model: null });
    expect(cleared.body).toMatchObject({ brand: null, model: null });
    for (const f of ['brand', 'model']) {
      const bad = await post({ code: `X-${f}`, name: 'x', [f]: 'b'.repeat(101) });
      expect(bad.status).toBe(400);
      expect(bad.body.error.details.map((d) => d.path)).toContain(f);
    }
  });

  it.each([
    ['9 312345 678901', '9312345678901'],
    ['  0765 0112 345a ', '07650112345A'],
    ['\t12\n34', '1234'],
    ['abcDEF123', 'ABCDEF123'],
  ])('barcode %j is normalized to %s', async (input, expected) => {
    expect((await post({ code: 'A', name: 'a', barcode: input })).body.barcode).toBe(expected);
  });

  // fix round (lead decision 11): a JSON number is rejected (it may already have lost digits/leading zeros); ASCII only (no ß -> SS)
  it.each(['abc-1', '9312345.678', 'é123', '１２３', '١٢٣', '<x>', '1'.repeat(65), 9312345678901, 'ß12'])('barcode %j -> 400', async (input) => {
    const res = await post({ code: 'A', name: 'a', barcode: input });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path)).toContain('barcode');
  });

  it('64-character barcode is accepted', async () => {
    expect((await post({ code: 'A', name: 'a', barcode: '1'.repeat(64) })).status).toBe(201);
  });

  it('barcode uniqueness: 409 with details on create and update (spaces/case ignored); own barcode OK; clear frees it', async () => {
    const a = (await post({ code: 'A', name: 'a', barcode: 'ab 12' })).body;
    const b = (await post({ code: 'B', name: 'b' })).body;
    for (const res of [
      await post({ code: 'C', name: 'c', barcode: 'AB12' }),
      await post({ code: 'C', name: 'c', barcode: ' a b 1 2 ' }),
      await request(app).put(`/api/items/${b.id}`).send({ barcode: 'ab12' }),
    ]) {
      expect(res.status).toBe(409);
      expectErrorShape(expect, res.body);
      expect(res.body.error.details).toEqual({ field: 'barcode', code: 'A' });
    }
    expect((await request(app).put(`/api/items/${a.id}`).send({ barcode: 'AB12', name: 'a2' })).status).toBe(200);
    expect((await request(app).put(`/api/items/${a.id}`).send({ barcode: '' })).body.barcode).toBeNull();
    expect((await request(app).put(`/api/items/${b.id}`).send({ barcode: 'AB12' })).status).toBe(200);
    // many items may have no barcode
    expect((await post({ code: 'D', name: 'd', barcode: null })).status).toBe(201);
    expect((await post({ code: 'E', name: 'e', barcode: '' })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------
describe('A. search with brand / model / barcode; ?unlocated', () => {
  let app;
  beforeEach(async () => {
    ({ app } = makeApp());
    await createItems(app, [
      { code: 'A-1', name: 'Zebra lantern', barcode: '4006381333931' },
      { code: '4006381333931-SET', name: 'Aaa set' },                    // code prefix
      { code: 'N-1', name: 'Aardvark', notes: 'box 4006381333931' },       // other
      { code: 'B-1', name: 'Stove', brand: 'Campingaz', model: 'Bistro 2', locationCode: 'R02-A-1' },
      { code: 'C-1', name: 'Unplaced', locationCode: 'Store cupboard' },
      { code: 'C-0', name: 'Nowhere' },
      { code: 'D-1', name: 'Rack only', locationCode: 'R05' },
    ]);
  });
  const search = (query) => request(app).get('/api/items').query(query);

  it('an exact barcode ranks top (with exact code), before code prefix and other matches', async () => {
    expect(codes(await search({ q: '4006381333931' }))).toEqual(['A-1', '4006381333931-SET', 'N-1']);
    expect(codes(await search({ q: '4006 3813 33931' }))[0]).toBe('A-1');
  });

  it('brand, model and part of a barcode are searchable (case-insensitive)', async () => {
    expect(codes(await search({ q: 'campingaz' }))).toEqual(['B-1']);
    expect(codes(await search({ q: 'BISTRO 2' }))).toEqual(['B-1']);
    expect(codes(await search({ q: '333931' })).sort()).toEqual(['4006381333931-SET', 'A-1', 'N-1']);
  });

  it('unlocated=true: no rack (none or unparseable), sorted by code; false/0/""= all; other -> 400', async () => {
    for (const v of ['true', '1']) expect(codes(await search({ unlocated: v }))).toEqual(['4006381333931-SET', 'A-1', 'C-0', 'C-1', 'N-1']);
    for (const v of ['false', '0', '']) expect(codes(await search({ unlocated: v }))).toHaveLength(7);
    for (const v of ['yes', 'TRUE', '2']) {
      const r = await search({ unlocated: v });
      expect(r.status).toBe(400);
      expectErrorShape(expect, r.body);
    }
  });

  it('unlocated combines with q (normal ranking) and with other filters', async () => {
    expect(codes(await search({ unlocated: 'true', q: 'aa' }))).toEqual(['4006381333931-SET', 'N-1']);
    expect(codes(await search({ unlocated: 'true', rack: 'R05' }))).toEqual([]);
    expect(codes(await search({ unlocated: 'true', q: 'cupboard' }))).toEqual(['C-1']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('A. import with brand / model / barcode', () => {
  let app, db;
  beforeEach(() => ({ app, db } = makeApp()));
  const row = (code) => allItems(db).find((r) => r.code === code);

  it.each([
    [['Code', 'Name', 'Brand', 'Model', 'Barcode']],
    [['Kod', 'Nama', 'Jenama', 'No Model', 'Kod Bar']],
    [['Kod', 'Nama', 'Pengeluar', 'Model No', 'EAN']],
    [['Item Code', 'Item Name', 'Manufacturer', 'Model Number', 'UPC']],
    [['code', 'name', 'Make', 'MODEL', 'barcode']],
  ])('header aliases %j', async (header) => {
    const res = await upload(app, csv([header, ['T1', 'Tent', 'Coleman', 'Sundome 4', '9 312345 678901']]), 'a.csv', real);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 0, errors: [] });
    expect(res.body.columns).toMatchObject({ brand: 2, model: 3, barcode: 4 });
    expect(row('T1')).toMatchObject({ brand: 'Coleman', model: 'Sundome 4', barcode: '9312345678901' });
    expect(res.body.preview[0]).toMatchObject({ brand: 'Coleman', model: 'Sundome 4', barcode: '9312345678901' });
  });

  it('numeric EAN cells in xlsx keep all digits', async () => {
    const res = await upload(app, await xlsx([['Code', 'Name', 'EAN'], ['T1', 'Tent', 9312345678901], ['T2', 'Tent 2', 12345678901234]]), 'a.xlsx', real);
    expect(res.body.created).toBe(2);
    expect(row('T1').barcode).toBe('9312345678901');
    expect(row('T2').barcode).toBe('12345678901234');
  });

  it('invalid barcodes are warnings; the row is imported without a barcode change', async () => {
    const res = await upload(app, csv([
      ['Code', 'Name', 'Barcode'],
      ['T1', 'Tent', '9.31235E+12'],       // Excel scientific notation in a CSV export
      ['T2', 'Rope', 'ABC-123'],
      ['T3', 'Pot', '1'.repeat(65)],
    ]), 'a.csv', real);
    expect(res.body).toMatchObject({ created: 3, skipped: 0 });
    expect(res.body.errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(res.body.errors.every((e) => e.message.startsWith('Warning:'))).toBe(true);
    expect(allItems(db).map((r) => r.barcode)).toEqual([null, null, null]);
  });

  it('a barcode owned by another item (in the DB or earlier in the file) is a warning and is not moved', async () => {
    await createItems(app, [{ code: 'OWNER', name: 'Owner', barcode: '111' }, { code: 'OTHER', name: 'Other', barcode: '999' }]);
    const file = csv([
      ['Code', 'Name', 'Barcode'],
      ['OTHER', 'Other', '111'],        // belongs to OWNER in the DB
      ['NEW-1', 'New 1', '222'],
      ['NEW-2', 'New 2', '2 2 2'],      // same as NEW-1 after normalizing
      ['new-1', 'New 1', '222'],        // same item again: fine
    ]);
    const dry = await upload(app, file, 'a.csv');
    const res = await upload(app, file, 'a.csv', real);
    for (const r of [dry, res]) {
      const warnings = r.body.errors.filter((e) => e.message.startsWith('Warning:'));
      expect(warnings.map((e) => e.row)).toEqual([2, 4, 5]);
      expect(warnings[0].message).toMatch(/OWNER/);
      expect(warnings[1].message).toMatch(/NEW-1/);
      expect(r.body.skipped).toBe(0);
    }
    expect(row('OWNER').barcode).toBe('111');
    expect(row('OTHER').barcode).toBe('999');
    expect(row('NEW-1').barcode).toBe('222');
    expect(row('NEW-2').barcode).toBeNull();
  });

  it('blank brand/model/barcode cells never change an existing item', async () => {
    await createItems(app, [{ code: 'T1', name: 'Tent', brand: 'Coleman', model: 'Sundome', barcode: '123' }]);
    const res = await upload(app, csv([['Code', 'Name', 'Jenama', 'Model', 'Kod Bar'], ['T1', 'Tent', '', ' ', '']]), 'a.csv', real);
    expect(res.body).toMatchObject({ unchanged: 1, errors: [] });
    expect(row('T1')).toMatchObject({ brand: 'Coleman', model: 'Sundome', barcode: '123' });
  });

  it('changing an existing item\'s barcode by import works and is counted as update', async () => {
    await createItems(app, [{ code: 'T1', name: 'Tent', barcode: '123' }]);
    const res = await upload(app, csv([['Code', 'Name', 'Barcode'], ['T1', 'Tent', '456']]), 'a.csv', real);
    expect(res.body).toMatchObject({ updated: 1, errors: [] });
    expect(row('T1').barcode).toBe('456');
  });
});

// ---------------------------------------------------------------------------------------------
describe('A. migration v1 -> v2 keeps data', () => {
  it('a populated v1 database is upgraded in place with every value intact and works through the API', async () => {
    const file = path.join(tmpDir(), 'v1.db');
    const v1 = new Database(file);
    v1.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    v1.exec(migrations[0].sql);
    v1.prepare("INSERT INTO schema_version VALUES (1, 'items', '2026-01-01T00:00:00.000Z')").run();
    const ins = v1.prepare(`INSERT INTO items (code, name, category, location_code, rack, shelf, bin, quantity, unit, condition, notes, created_at, updated_at)
      VALUES (@code, @name, @category, @loc, @rack, @shelf, @bin, @qty, @unit, @cond, @notes, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`);
    const rows = [
      { code: 'TNT-004', name: '4-man tent', category: 'Tents', loc: 'R03-B-2', rack: 'R03', shelf: 'B', bin: 2, qty: 6, unit: 'pcs', cond: 'damaged', notes: 'zip' },
      { code: 'ROP-010', name: 'Rope', category: null, loc: 'Store cupboard', rack: null, shelf: null, bin: null, qty: 0, unit: 'coils', cond: 'good', notes: '' },
    ];
    for (const r of rows) ins.run(r);
    const before = v1.prepare('SELECT * FROM items ORDER BY id').all();
    v1.close();

    const db = openDb(file);
    const after = db.prepare('SELECT * FROM items ORDER BY id').all();
    expect(after).toEqual(before.map((r) => ({ ...r, brand: null, model: null, barcode: null })));
    // fix round: migration v3 (barcode unique ignoring leading zeros) was added after v2
    expect(db.prepare('SELECT version FROM schema_version ORDER BY version').all()).toEqual(migrations.map((m) => ({ version: m.version })));
    expect(db.prepare("SELECT applied_at FROM schema_version WHERE version = 1").get().applied_at).toBe('2026-01-01T00:00:00.000Z');

    const leader = makeLeaderConfig();
    const upgraded = createApp(db, { configPath: leader.configPath, staticDir: false });
    const auth = { Authorization: `Bearer ${leader.token}` };
    const list = await request(upgraded).get('/api/items');
    expect(list.body.items.map((i) => i.code)).toEqual(['ROP-010', 'TNT-004']);
    list.body.items.forEach((i) => expectItemShape(expect, i));
    const put = await request(upgraded).put('/api/items/1').set(auth).send({ barcode: '123', brand: 'Coleman' });
    expect(put.body).toMatchObject({ code: 'TNT-004', condition: 'damaged', barcode: '123', brand: 'Coleman', createdAt: '2026-01-01T00:00:00.000Z' });
    expect((await request(upgraded).post('/api/items').set(auth).send({ code: 'X', name: 'x', barcode: '123' })).status).toBe(409);
    db.close();

    const again = openDb(file); // re-open: no-op
    expect(again.prepare('SELECT COUNT(*) n FROM schema_version').get().n).toBe(migrations.length);
    again.close();
  });
});

// ---------------------------------------------------------------------------------------------
describe('B. POST /api/scan/match', () => {
  let publicApp, db;
  beforeEach(async () => {
    ({ publicApp, db } = makeApp());
    for (const it of [
      { code: 'TNT-004', name: '4-man dome tent', category: 'Tents', brand: 'Coleman', model: 'Sundome 4', barcode: '9312345678901' },
      { code: 'TNT-006', name: '6-man patrol tent', category: 'Tents' },
      { code: 'CKG-005', name: 'Portable gas stove', category: 'Cooking', brand: 'Campingaz', model: 'Bistro 2' },
      { code: 'LGT-005', name: 'Head torch', category: 'Lighting', brand: 'Petzl', model: 'Tikkina' },
    ]) createItem(db, it);
  });
  const scan = (body) => request(publicApp).post('/api/scan/match').send(body);
  const top = (res) => res.body.matches.map((m) => m.item.code);

  it('is public and returns the documented shape', async () => {
    const res = await scan({ text: 'TNT-004' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['matches', 'query']);
    const m = res.body.matches[0];
    expect(Object.keys(m).sort()).toEqual(['item', 'matchedOn', 'score']);
    expectItemShape(expect, m.item);
    expect(m.score).toBeGreaterThan(0);
    expect(m.score).toBeLessThanOrEqual(1);
    expect(res.body.query.tokens).toEqual(['tnt', '004']);
  });

  it('exact barcode (spaces ignored) -> that item alone with score 1, even if text points elsewhere', async () => {
    const res = await scan({ barcode: '9 312345 678901', text: 'Campingaz Bistro 2' });
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0]).toMatchObject({ item: { code: 'TNT-004' }, score: 1, matchedOn: ['barcode'] });
    expect(res.body.query.barcode).toBe('9312345678901');
  });

  it('a barcode equal to an item code (OCR-folded) counts as exact', async () => {
    const res = await scan({ barcode: 'tnt-oo4' });
    expect(res.body.matches).toEqual([expect.objectContaining({ score: 1, matchedOn: ['code'], item: expect.objectContaining({ code: 'TNT-004' }) })]);
  });

  it('unknown barcode: alone -> []; with text -> text matching is used', async () => {
    expect((await scan({ barcode: '0000000000000' })).body.matches).toEqual([]);
    expect(top(await scan({ barcode: '0000000000000', text: 'Campingaz Bistro 2' }))[0]).toBe('CKG-005');
  });

  it.each([
    'TNT-OO4', 'tnt 0O4', 'tnt004', 'TNT 004', 'TNT - 0 0 4', 'TNT_O04', 'Item: TNT-OO4\nMADE IN CHINA',
  ])('OCR-noisy code %j finds TNT-004 with score 1', async (text) => {
    const res = await scan({ text });
    expect(res.body.matches[0]).toMatchObject({ item: { code: 'TNT-004' }, score: 1 });
    expect(res.body.matches[0].matchedOn).toContain('code');
  });

  it('a fully letter-spaced code "T N T - 0 0 4" (6 OCR words) finds TNT-004', async () => {
    expect(top(await scan({ text: 'T N T - 0 0 4' }))[0]).toBe('TNT-004');
  });

  it.each([
    ['Colernan Sundorne 4', 'TNT-004'],   // rn -> m
    ['Co1eman SUNDOME', 'TNT-004'],       // l -> 1 folding
    ['Colemam Sundome', 'TNT-004'],       // one substitution
    ['Campingas Bistr0 2', 'CKG-005'],
    ['Petz1 Tikina', 'LGT-005'],          // one deletion in a 7-letter model
  ])('brand/model with OCR typos %j -> %s', async (text, code) => {
    const res = await scan({ text });
    expect(res.body.matches[0].item.code).toBe(code);
    expect(res.body.matches[0].matchedOn).toEqual(expect.arrayContaining(['brand', 'model']));
  });

  it('matches are sorted best first and capped at 10', async () => {
    for (let i = 0; i < 15; i++) createItem(db, { code: `TEN-${i}`, name: `Tent spare ${i}`, brand: 'Coleman' });
    const res = await scan({ text: 'Coleman Sundome 4 tent spare' });
    expect(res.body.matches.length).toBeLessThanOrEqual(10);
    expect(res.body.matches[0].item.code).toBe('TNT-004');
    const scores = res.body.matches.map((m) => m.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it.each([
    'MADE IN CHINA\nWARNING: keep away from children. 5 kg 30 cm',
    'the and of in',
    '!!!! ---- .... ////',
    '®©™',
    'a b c d e f g',
  ])('noise-only text %j -> matches []', async (text) => {
    const res = await scan({ text });
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([]);
  });

  it.each([
    [{}],
    [{ text: '' }],
    [{ text: '   \n\t ' }],
    // fix round (lead decision 12): text over 2000 characters is truncated server-side, not a 400
    [{ barcode: '1'.repeat(65) }],
    [{ barcode: '   ' }],
    [{ text: 5 }],
    [{ text: ['tent'] }],
    [[]],
  ])('invalid body %j -> 400', async (body) => {
    const res = await scan(body);
    expect(res.status).toBe(400);
    expectErrorShape(expect, res.body);
  });

  it('2000-character text is accepted; GET is not a route', async () => {
    expect((await scan({ text: 'tent '.repeat(400) })).status).toBe(200);
    expect((await request(publicApp).get('/api/scan/match')).status).toBe(404);
  });

  it('pure matchItems never returns items under the 0.15 threshold', () => {
    const items = db.prepare('SELECT * FROM items').all().map((r) => ({ ...r }));
    const res = matchItems(items, { text: 'tent' });
    expect(res.matches.every((m) => m.score >= 0.15)).toBe(true);
  });

  it('performance: 5,000 items and a 2,000-character noisy OCR text answer in < 300 ms', async () => {
    const brands = ['Coleman', 'Campingaz', 'Petzl', 'Vango', 'Quechua', 'Deuter', 'Primus', 'Jetboil', 'MSR', 'Osprey'];
    db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        createItem(db, {
          code: `ITM-${String(i).padStart(4, '0')}`, name: `Item number ${i} assorted gear ${i % 37}`,
          brand: brands[i % 10], model: `Model ${i % 250} Pro`, barcode: String(9300000000000 + i),
          category: ['Tents', 'Cooking', 'Ropes', 'Tools'][i % 4], notes: `Donated ${2000 + (i % 25)} by parents association`,
        });
      }
    })();
    const words = ['Colernan', 'warning', 'Sundorne', '4500mAh', 'batteries', 'included', 'outdoor', 'camping', 'lantern', 'rechargeable', 'IPX4', 'lumens', 'ITM-1234'];
    const text = Array.from({ length: 400 }, (_, i) => words[i % words.length] + (i % 7)).join(' ').slice(0, 2000);
    await scan({ text }); // warm-up
    const times = [];
    let res;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      res = await scan({ text });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(res.status).toBe(200);
    expect(times[1]).toBeLessThan(300);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
describe('D. static frontend serving (temp dist)', () => {
  let app, root;
  beforeEach(() => {
    root = tmpDir('etroop-static-');
    const dist = path.join(root, 'dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root">INDEX</div>');
    fs.writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{}');
    fs.writeFileSync(path.join(dist, '.secret'), 'DOTSECRET');
    fs.writeFileSync(path.join(dist, 'assets', 'index-abc.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dist, 'assets', 'worker-abc.mjs'), 'export {}');
    fs.writeFileSync(path.join(dist, 'assets', 'core.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    fs.writeFileSync(path.join(root, 'secret.txt'), 'TOPSECRET');
    ({ app } = makeApp({ staticDir: dist }));
  });

  it.each(['/', '/items/3', '/items/3/edit', '/map', '/racks/R03', '/locate', '/scan', '/import', '/some/deep/unknown/route'])(
    'SPA fallback: GET %s -> index.html (no-cache, security headers)', async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('INDEX');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['permissions-policy']).toMatch(/geolocation=\(\)/);
      expect(res.headers['strict-transport-security']).toBeUndefined();
    }
  );

  it('query strings do not break the fallback', async () => {
    expect((await request(app).get('/?q=tent')).text).toContain('INDEX');
  });

  it('/api paths never fall back to index.html: unknown API -> JSON 404 with no-store', async () => {
    for (const url of ['/api/nope', '/api/items/999', '/api/racks/R99', '/api']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expectErrorShape(expect, res.body);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('missing files with an extension are a real 404 (not index.html)', async () => {
    for (const url of ['/assets/missing.js', '/missing.png', '/assets/core2.wasm']) {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(404);
      expect(res.text ?? '').not.toContain('INDEX');
      expect(res.headers['content-security-policy']).toBeDefined();
    }
  });

  it('cache headers and content types for real files', async () => {
    const js = await request(app).get('/assets/index-abc.js');
    expect(js.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await request(app).get('/assets/core.wasm')).headers['content-type']).toBe('application/wasm');
    expect((await request(app).get('/assets/worker-abc.mjs')).headers['content-type']).toMatch(/^text\/javascript/);
    expect((await request(app).get('/manifest.webmanifest')).headers['content-type']).toMatch(/^application\/manifest\+json/);
    const svg = await request(app).get('/favicon.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers['cache-control']).toBe('no-cache');
    expect((await request(app).get('/index.html')).headers['cache-control']).toBe('no-cache');
  });

  it.each([
    '/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt', '/assets/..%5c..%5csecret.txt', '/.secret', '/%2esecret',
    '/assets/%2e%2e%2f.secret', '//secret.txt', '/index.html%00.js', '/%c0%ae%c0%ae/secret.txt',
  ])('path traversal / dotfile attempt %s never leaks a file outside dist or a dotfile', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).not.toBe(500);
    expect(res.text ?? '').not.toContain('TOPSECRET');
    expect(res.text ?? '').not.toContain('DOTSECRET');
  });

  it('non-GET on a page path is not served index.html', async () => {
    const res = await request(app).post('/map').send({});
    expect(res.status).toBe(404);
    expect(res.text ?? '').not.toContain('INDEX');
    expect((await request(app).head('/map')).status).toBe(200);
  });

  it('resolveStaticDir: only in production / SERVE_FRONTEND=1, via FRONTEND_DIST, and only with index.html', () => {
    const dist = path.join(root, 'dist');
    const saved = { NODE_ENV: process.env.NODE_ENV, SERVE_FRONTEND: process.env.SERVE_FRONTEND, FRONTEND_DIST: process.env.FRONTEND_DIST };
    try {
      process.env.FRONTEND_DIST = dist;
      process.env.NODE_ENV = 'test';
      delete process.env.SERVE_FRONTEND;
      expect(resolveStaticDir(undefined)).toBeNull();
      process.env.NODE_ENV = 'production';
      expect(resolveStaticDir(undefined)).toBe(dist);
      process.env.NODE_ENV = 'test';
      process.env.SERVE_FRONTEND = '1';
      expect(resolveStaticDir(undefined)).toBe(dist);
      process.env.FRONTEND_DIST = root; // no index.html there
      expect(resolveStaticDir(undefined)).toBeNull();
      expect(resolveStaticDir(false)).toBeNull();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('API responses carry the security headers too', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

// ---------------------------------------------------------------------------------------------
describe('D. backups (temp dirs)', () => {
  afterEach(() => vi.useRealTimers());

  function dbWithItem(code = 'BK-1') {
    const db = openDb(':memory:');
    createItem(db, { code, name: 'Backed up' });
    return db;
  }

  it('rotation keeps the N newest by date, whatever order they were made in', async () => {
    const db = dbWithItem();
    const dir = path.join(tmpDir(), 'bk');
    for (const day of [5, 1, 9, 3, 7]) {
      expect((await runBackup(db, { dir, keep: 2, now: new Date(2026, 10, day, 21), log: quiet })).ok).toBe(true);
    }
    expect(fs.readdirSync(dir).sort()).toEqual(['store-2026-11-07.db', 'store-2026-11-09.db']);
  });

  it('never deletes files that are not its own backups', async () => {
    const db = dbWithItem();
    const dir = tmpDir();
    const foreign = [
      'notes.txt', 'store-latest.db', 'Store-2020-01-01.db', 'store-2020-1-1.db', 'store-2020-01-01.db.bak',
      'store-2020-01-01.db.partial', 'my-store-2020-01-01.db', 'store-2020-01-01.sqlite',
    ];
    for (const f of foreign) fs.writeFileSync(path.join(dir, f), 'keep');
    fs.mkdirSync(path.join(dir, 'subfolder'));
    fs.writeFileSync(path.join(dir, 'subfolder', 'store-2019-01-01.db'), 'keep');
    for (let day = 1; day <= 4; day++) await runBackup(db, { dir, keep: 1, now: new Date(2026, 0, day), log: quiet });
    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual([...foreign, 'store-2026-01-04.db', 'subfolder'].sort());
    expect(fs.existsSync(path.join(dir, 'subfolder', 'store-2019-01-01.db'))).toBe(true);
    expect(rotateBackups(dir, 0).length).toBe(1); // only its own file is a candidate
    for (const f of foreign) expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe('keep');
  });

  it('the backup is a consistent, readable copy and no .partial file is left', async () => {
    const db = dbWithItem('SNAP-1');
    const dir = tmpDir();
    const r = await runBackup(db, { dir, keep: 5, log: quiet });
    expect(r.ok).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.partial'))).toBe(false);
    const copy = new Database(r.file, { readonly: true });
    expect(copy.prepare('SELECT code FROM items').all()).toEqual([{ code: 'SNAP-1' }]);
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    copy.close();
  });

  it.each([
    ['a file where the folder should be', (base) => { fs.writeFileSync(path.join(base, 'f'), 'x'); return path.join(base, 'f', 'sub'); }],
    ['the target name is taken by a folder', (base) => { fs.mkdirSync(path.join(base, 'store-2026-03-03.db')); return base; }],
  ])('unusable backup folder (%s) only warns, never throws, and leaves no .partial', async (_label, mk) => {
    const base = tmpDir();
    const dir = mk(base);
    const warnings = [];
    const db = dbWithItem();
    const r = await runBackup(db, { dir, keep: 3, now: new Date(2026, 2, 3), log: { warn: (m) => warnings.push(m), log() {} } });
    expect(r.ok).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Warning: backup to .* failed/);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
    expect(walk(base).some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('scheduleBackups (fake clock): one now, then daily at BACKUP_HOUR, failures do not stop the schedule', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date(2026, 10, 26, 20, 59, 0));
    const db = dbWithItem();
    const dir = path.join(tmpDir(), 'sched');
    const warnings = [];
    const s = scheduleBackups(db, { dir, hour: 21, keep: 30 }, { log: { warn: (m) => warnings.push(m), log() {} } });
    expect((await s.first).ok).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['store-2026-11-26.db']);
    // Wait (on real setImmediate ticks) until the scheduled backup has finished.
    const until = async (cond) => {
      for (let i = 0; i < 20_000 && !cond(); i++) await new Promise((r) => setImmediate(r));
      return cond();
    };
    const files = () => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).sort() : []);
    const mtime = () => fs.statSync(path.join(dir, 'store-2026-11-26.db')).mtimeMs;
    fs.utimesSync(path.join(dir, 'store-2026-11-26.db'), 0, 0);
    await vi.advanceTimersByTimeAsync(61_000); // 21:00:01 -> same-day backup replaced
    expect(await until(() => files().length === 1 && mtime() > 0)).toBe(true);
    expect(files()).toEqual(['store-2026-11-26.db']);
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, 'now a file'); // next run fails
    await vi.advanceTimersByTimeAsync(DAY);
    expect(await until(() => warnings.length === 1)).toBe(true);
    fs.rmSync(dir);
    await vi.advanceTimersByTimeAsync(DAY); // and the day after works again
    expect(await until(() => files().includes('store-2026-11-28.db'))).toBe(true);
    expect(files()).toEqual(['store-2026-11-28.db']);
    s.stop();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    for (let i = 0; i < 2000; i++) await new Promise((r) => setImmediate(r));
    expect(files()).toEqual(['store-2026-11-28.db']);
  });
});
