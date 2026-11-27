import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_DB_PATH = path.join(BACKEND_ROOT, 'data', 'store.db');

/** Resolve DB_PATH: ':memory:' as-is, relative paths against the backend folder. */
export function resolveDbPath(dbPath = process.env.DB_PATH) {
  if (!dbPath) return DEFAULT_DB_PATH;
  if (dbPath === ':memory:') return dbPath;
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(BACKEND_ROOT, dbPath);
}

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const currentVersion = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version');
  const record = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations) {
    // IMMEDIATE takes the write lock first, and the version is re-read inside it, so two processes
    // starting on a fresh DB (e.g. `npm run seed` while `npm run dev` boots) never apply a step twice.
    db.transaction(() => {
      if (currentVersion.get().v >= m.version) return;
      if (m.up) m.up(db);
      else db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
    }).immediate();
  }
  return currentVersion.get().v;
}

/** Open (creating if needed) and migrate a SQLite database. */
export function openDb(dbPath) {
  const file = resolveDbPath(dbPath);
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
