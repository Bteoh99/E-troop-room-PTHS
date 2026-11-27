/**
 * Install config (data/config.json, gitignored): the leader PIN as a scrypt hash + salt, and the
 * random secret that signs leader tokens. The PIN itself is never stored or logged.
 * Path: CONFIG_PATH env (relative paths resolve against backend/), default backend/data/config.json.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_CONFIG_PATH = path.join(BACKEND_ROOT, 'data', 'config.json');

/** Default scrypt cost (N = 2^15: ~0.1 s on an old laptop; memory 32 MB, inside Node's default limit). */
export const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1, keylen: 32 };
const scryptMaxmem = (N, r) => 128 * N * r * 2;

export function resolveConfigPath(configPath = process.env.CONFIG_PATH) {
  if (!configPath) return DEFAULT_CONFIG_PATH;
  return path.isAbsolute(configPath) ? configPath : path.resolve(BACKEND_ROOT, configPath);
}

/** New PINs: 6 to 8 digits. (PINs set before this rule, 4-5 digits, keep working until changed.) */
export const MIN_PIN_DIGITS = 6;
export const MAX_PIN_DIGITS = 8;
export const PIN_RULE = `${MIN_PIN_DIGITS} to ${MAX_PIN_DIGITS} digits`;
export const isValidPin = (pin) => typeof pin === 'string' && /^\d{6,8}$/.test(pin);
/** What a stored PIN may look like at login (older installs allowed 4-5 digits). */
export const isLoginPinShape = (pin) => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

/**
 * Known length of the stored PIN, or null if unknown (set by an older version and nobody has
 * logged in since). The length is kept in the config so status can say "PIN too short".
 */
export function storedPinDigits(cfg) {
  const d = cfg?.pin?.digits;
  return Number.isInteger(d) ? d : null;
}
export const pinTooShort = (cfg) => {
  const d = storedPinDigits(cfg);
  return d !== null && d < MIN_PIN_DIGITS;
};

/** Read config; a missing file is an empty config. A corrupt file throws (never silently "no PIN"). */
export function readConfig(file) {
  let text;
  // An empty or unparseable file throws: it must never be read as "no PIN".
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const cfg = JSON.parse(text);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('not a settings object');
  return cfg;
}

/** Atomic write (temp file + rename), readable by the owner only where the OS supports it. */
export function writeConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(cfg, null, 2) + '\n');
    fs.fsyncSync(fd); // a power cut must not leave an empty config.json behind
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export class ConfigDamagedError extends Error {
  constructor(file, cause) {
    super(`The leader settings file ${file} is damaged (${cause.message}).`);
    this.code = 'CONFIG_DAMAGED';
  }
}

export function hashPin(pin, params = {}) {
  const { N, r, p, keylen } = { ...SCRYPT_DEFAULTS, ...params };
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin, salt, keylen, { N, r, p, maxmem: scryptMaxmem(N, r) });
  return { algo: 'scrypt', N, r, p, keylen, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

/** Constant-time check of a PIN against a stored record (async: does not block the server). */
export function verifyPin(pin, rec) {
  return new Promise((resolve) => {
    if (!rec || rec.algo !== 'scrypt' || typeof pin !== 'string') return resolve(false);
    const expected = Buffer.from(rec.hash, 'base64');
    crypto.scrypt(pin, Buffer.from(rec.salt, 'base64'), expected.length,
      { N: rec.N, r: rec.r, p: rec.p, maxmem: scryptMaxmem(rec.N, rec.r) },
      (err, got) => resolve(!err && got.length === expected.length && crypto.timingSafeEqual(got, expected)));
  });
}

/**
 * Set (or change) the PIN. Always rotates the token secret, so every existing leader token stops working.
 * @param {string} file config path
 * @param {string} pin 6-8 digits
 * @param {object} [scryptParams] tests use a cheap N
 * @param {{ force?: boolean }} [opts] force: replace a damaged config.json (it is renamed to .broken-<time> first)
 */
export function setPin(file, pin, scryptParams, { force = false } = {}) {
  if (!isValidPin(pin)) throw new Error(`The PIN must be ${PIN_RULE}.`);
  let cfg;
  try {
    cfg = readConfig(file);
  } catch (err) {
    if (!force) throw new ConfigDamagedError(file, err);
    // Repair: keep the damaged file for inspection, start again from an empty config.
    const kept = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, kept);
    cfg = {};
  }
  cfg.pin = { ...hashPin(pin, scryptParams), digits: pin.length };
  cfg.tokenSecret = crypto.randomBytes(32).toString('base64');
  cfg.pinUpdatedAt = new Date().toISOString();
  writeConfig(file, cfg);
  return cfg;
}

/**
 * Config reader for the running server: re-reads the file only when it changed on disk, so a PIN
 * changed with `npm run set-pin` takes effect (and old tokens die) without a restart.
 */
export function createConfigSource(file) {
  let cached = null;
  let stamp = null;
  return function getConfig() {
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      /* missing file = no PIN yet */
    }
    const now = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : 'missing';
    if (now !== stamp) {
      try {
        cached = st ? readConfig(file) : {};
      } catch (err) {
        console.warn(`Warning: could not read ${file} (${err.message}); leader writes are disabled until it is fixed.`);
        cached = { broken: true };
      }
      stamp = now;
    }
    return cached;
  };
}
