/**
 * Automatic database backups with better-sqlite3's online backup API (safe while the server runs).
 * Files: <BACKUP_DIR>/store-YYYY-MM-DD.db (local date; a second backup on the same day replaces it).
 * Keeps the newest BACKUP_KEEP files. Never throws: problems are logged as warnings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_BACKUP_DIR = path.join(BACKEND_ROOT, 'data', 'backups');
const BACKUP_RE = /^store-\d{4}-\d{2}-\d{2}\.db$/;

function intInRange(value, min, max, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Settings from env: BACKUP_DIR (relative = against backend/), BACKUP_HOUR (0-23, default 21), BACKUP_KEEP (default 30). */
export function backupSettings(env = process.env) {
  const dir = env.BACKUP_DIR ? path.resolve(BACKEND_ROOT, env.BACKUP_DIR) : DEFAULT_BACKUP_DIR;
  return { dir, hour: intInRange(env.BACKUP_HOUR, 0, 23, 21), keep: intInRange(env.BACKUP_KEEP, 1, 3650, 30) };
}

export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `store-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.db`;
}

/** Delete all but the newest `keep` store-YYYY-MM-DD.db files. Returns the deleted names. */
export function rotateBackups(dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().reverse();
  const old = files.slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return old;
}

/**
 * Back up now.
 * @returns {Promise<{ ok: true, file: string, deleted: string[] } | { ok: false, error: string }>}
 */
export async function runBackup(db, { dir = DEFAULT_BACKUP_DIR, keep = 30, now = new Date(), log = console } = {}) {
  const file = path.join(dir, backupFileName(now));
  const tmp = `${file}.partial`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    await db.backup(tmp);
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(file, { force: true }); // e.g. Windows refusing to replace; try once more
      fs.renameSync(tmp, file);
    }
    const deleted = rotateBackups(dir, keep);
    return { ok: true, file, deleted };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    log.warn(`Warning: backup to ${dir} failed: ${err.message}. The app keeps running; check BACKUP_DIR.`);
    return { ok: false, error: err.message };
  }
}

/** Milliseconds from `now` until the next `hour`:00 local time (tomorrow if already past). */
export function msUntilNextHour(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

/**
 * Back up once now, then every day at settings.hour. Timers are unref'd (they never keep the process alive).
 * @returns {{ stop(): void, first: Promise<object> }}
 */
export function scheduleBackups(db, settings = backupSettings(), { log = console } = {}) {
  let timer = null;
  let stopped = false;
  const opts = { dir: settings.dir, keep: settings.keep, log };
  const planNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const r = await runBackup(db, { ...opts, now: new Date() });
      if (r.ok) log.log(`Backup saved: ${r.file}`);
      planNext();
    }, msUntilNextHour(settings.hour));
    timer.unref?.();
  };
  const first = runBackup(db, { ...opts, now: new Date() }).then((r) => {
    if (r.ok) log.log(`Backup saved: ${r.file}`);
    return r;
  });
  planNext();
  return {
    first,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
