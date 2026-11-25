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
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
  const record = db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
    })();
  }
  return db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
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
