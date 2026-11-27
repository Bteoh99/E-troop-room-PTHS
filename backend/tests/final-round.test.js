// Final backend round (docs/REVIEW-backend.md "Phase 1.5 verification"): V1 migration v3 on
// near-duplicate barcodes, V2 6-8 digit PINs with legacy 4-5 digit PINs still working.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { makeApp, tmpDir, TEST_SCRYPT } from './helpers.js';
import { openDb } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';
import { hashPin, isValidPin, readConfig, setPin, writeConfig } from '../src/auth/config.js';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('V1: migration v3 on a v2 database with barcodes that differ only by leading zeros', () => {
  function makeV2(file) {
    const db = new Database(file);
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of migrations.filter((x) => x.version <= 2)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(m.version, m.name, '2026-11-01T00:00:00.000Z');
    }
    const add = db.prepare(`INSERT INTO items (code, name, notes, barcode, created_at, updated_at) VALUES (?, ?, ?, ?, 'x', 'x')`);
    add.run('A-1', 'Lantern', '', '012345678905');
    add.run('B-2', 'Lantern copy', 'Blue', '12345678905');
    add.run('C-3', 'Lantern 3', '', '0012345678905');
    add.run('D-4', 'Other', 'keep', '777');
    add.run('E-5', 'No barcode', '', null);
    db.close();
  }

  it('keeps the barcode on the lowest id, clears the others with a note, warns with the count, then starts', () => {
    const file = path.join(tmpDir(), 'v2.db');
    makeV2(file);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let db;
    try {
      db = openDb(file); // must not throw SQLITE_CONSTRAINT_UNIQUE
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/2 barcode\(s\) removed/);
    } finally {
      warn.mockRestore();
    }
    const rows = Object.fromEntries(db.prepare('SELECT code, barcode, notes FROM items').all().map((r) => [r.code, r]));
    expect(rows['A-1']).toEqual({ code: 'A-1', barcode: '012345678905', notes: '' });
    expect(rows['B-2']).toEqual({ code: 'B-2', barcode: null, notes: 'Blue Barcode 12345678905 removed: duplicate of A-1 (leading zeros)' });
    expect(rows['C-3']).toEqual({ code: 'C-3', barcode: null, notes: 'Barcode 0012345678905 removed: duplicate of A-1 (leading zeros)' });
    expect(rows['D-4']).toMatchObject({ barcode: '777', notes: 'keep' });
    expect(rows['E-5'].barcode).toBeNull();
    expect(db.prepare('SELECT MAX(version) v FROM schema_version').get().v).toBe(migrations.at(-1).version);
    expect(() => db.prepare("INSERT INTO items (code, name, barcode, created_at, updated_at) VALUES ('F','f','12345678905','x','x')").run()).toThrow(/UNIQUE/);
    db.close();
  });

  it('a v2 database without near-duplicates migrates silently', () => {
    const file = path.join(tmpDir(), 'clean.db');
    const db = new Database(file);
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of migrations.filter((x) => x.version <= 2)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(m.version, m.name, 'x');
    }
    db.prepare(`INSERT INTO items (code, name, barcode, created_at, updated_at) VALUES ('A', 'a', '0123', 'x', 'x')`).run();
    db.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const upgraded = openDb(file);
      expect(warn).not.toHaveBeenCalled();
      expect(upgraded.prepare('SELECT barcode FROM items').get().barcode).toBe('0123');
      upgraded.close();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('V2: new PINs are 6-8 digits; an existing 4-5 digit PIN keeps working until changed', () => {
  it('isValidPin / setPin accept 6-8 digits only, and record the length', () => {
    for (const pin of ['123456', '1234567', '12345678']) expect(isValidPin(pin)).toBe(true);
    for (const pin of ['1234', '12345', '123456789', '12345a', '']) expect(isValidPin(pin)).toBe(false);
    const file = path.join(tmpDir(), 'config.json');
    expect(() => setPin(file, '12345', TEST_SCRYPT)).toThrow(/6 to 8 digits/);
    setPin(file, '123456', TEST_SCRYPT);
    expect(readConfig(file).pin.digits).toBe(6);
  });

  /** A config written by an older version: 4-digit PIN, no recorded length. */
  function legacyConfig(pin = '1234', extra = {}) {
    const file = path.join(tmpDir(), 'config.json');
    writeConfig(file, { pin: { ...hashPin(pin, TEST_SCRYPT), ...extra }, tokenSecret: crypto.randomBytes(32).toString('base64') });
    return file;
  }

  it('a legacy 4-digit PIN still logs in; its length is learned and status then says pinTooShort', async () => {
    const configPath = legacyConfig('1234');
    const { publicApp } = makeApp({ leader: { configPath, token: 'unused', pin: '1234' } });
    expect((await request(publicApp).get('/api/auth/status')).body).toEqual({ pinSet: true, leader: false });
    const login = await request(publicApp).post('/api/auth/login').send({ pin: '1234' });
    expect(login.status).toBe(200);
    expect(readConfig(configPath).pin.digits).toBe(4);
    const status = await request(publicApp).get('/api/auth/status').set('Authorization', `Bearer ${login.body.token}`);
    expect(status.body).toEqual({ pinSet: true, leader: true, pinTooShort: true });
    // the token from that login keeps working (the secret did not change)
    expect((await request(publicApp).post('/api/items').set('Authorization', `Bearer ${login.body.token}`).send({ code: 'A', name: 'a' })).status).toBe(201);
  });

  it('a 6+ digit PIN never reports pinTooShort', async () => {
    const { publicApp } = makeApp(); // helpers' TEST_PIN is 6 digits
    expect((await request(publicApp).get('/api/auth/status')).body).toEqual({ pinSet: true, leader: false });
  });

  it('set-pin --check warns about a short PIN; set-pin refuses 4-5 digits', () => {
    const configPath = legacyConfig('12345', { digits: 5 });
    const run = (...args) => spawnSync(process.execPath, ['scripts/set-pin.js', ...args], {
      cwd: BACKEND, env: { ...process.env, CONFIG_PATH: configPath }, encoding: 'utf8', timeout: 20_000,
    });
    const check = run('--check');
    expect(check.status).toBe(0);
    expect(check.stdout).toMatch(/Warning: the leader PIN has only 5 digits/);
    for (const pin of ['1234', '12345']) {
      const r = run('--pin', pin);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/6 to 8 digits/);
    }
    expect(run('--pin', '135792').status).toBe(0);
    expect(run('--check').stdout).not.toMatch(/Warning/);
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('135792');
  }, 30_000);
});
