/**
 * Item data access. All SQL is parameterized. Functions take the db handle explicitly
 * so tests (and Phase 2 services) can use their own database.
 */
import { createItemSchema, updateItemSchema } from '../lib/itemSchema.js';
import { parseLocation, normalizeRack } from '../lib/location.js';
import { conflict, notFound } from '../lib/errors.js';

const stmtCache = new WeakMap();
function stmt(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) stmtCache.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
}

/** DB row -> API Item */
export function rowToItem(r) {
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    locationCode: r.location_code,
    rack: r.rack,
    shelf: r.shelf,
    bin: r.bin,
    quantity: r.quantity,
    unit: r.unit,
    condition: r.condition,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Item-like values (validated) -> DB columns, with rack/shelf/bin derived from locationCode. */
function toColumns(v) {
  const loc = parseLocation(v.locationCode);
  return {
    code: v.code,
    name: v.name,
    category: v.category,
    location_code: loc.locationCode,
    rack: loc.rack,
    shelf: loc.shelf,
    bin: loc.bin,
    quantity: v.quantity,
    unit: v.unit,
    condition: v.condition,
    notes: v.notes,
  };
}

/** Build the full Item (without id/timestamps) that `input` would create. Throws ZodError. */
export function buildNewItem(input) {
  const v = createItemSchema.parse(input);
  const c = toColumns(v);
  return { code: c.code, name: c.name, category: c.category, locationCode: c.location_code, rack: c.rack,
    shelf: c.shelf, bin: c.bin, quantity: c.quantity, unit: c.unit, condition: c.condition, notes: c.notes };
}

/** Apply a validated partial patch to an existing Item, re-deriving the location. Pure. */
export function mergeItem(existing, patch) {
  const merged = { ...existing, ...patch };
  const loc = parseLocation(merged.locationCode);
  return { ...merged, locationCode: loc.locationCode, rack: loc.rack, shelf: loc.shelf, bin: loc.bin };
}

export function getItem(db, id) {
  return rowToItem(stmt(db, 'SELECT * FROM items WHERE id = ?').get(id));
}

export function getItemByCode(db, code) {
  return rowToItem(stmt(db, 'SELECT * FROM items WHERE code = ? COLLATE NOCASE').get(String(code).trim()));
}

export function countItems(db) {
  return stmt(db, 'SELECT COUNT(*) AS n FROM items').get().n;
}

export function createItem(db, input) {
  const item = buildNewItem(input);
  if (getItemByCode(db, item.code)) throw conflict(`An item with code ${item.code} already exists`, { field: 'code' });
  const now = new Date().toISOString();
  const info = stmt(db, `INSERT INTO items
      (code, name, category, location_code, rack, shelf, bin, quantity, unit, condition, notes, created_at, updated_at)
    VALUES (@code, @name, @category, @location_code, @rack, @shelf, @bin, @quantity, @unit, @condition, @notes, @now, @now)`)
    .run({ ...toColumns(item), now });
  return getItem(db, info.lastInsertRowid);
}

export function updateItem(db, id, input) {
  const existing = getItem(db, id);
  if (!existing) throw notFound(`Item ${id} not found`);
  const patch = updateItemSchema.parse(input);
  if (Object.keys(patch).length === 0) return existing;
  if (patch.code && patch.code !== existing.code) {
    const other = getItemByCode(db, patch.code);
    if (other && other.id !== existing.id) {
      throw conflict(`An item with code ${patch.code} already exists`, { field: 'code' });
    }
  }
  const merged = mergeItem(existing, patch);
  stmt(db, `UPDATE items SET code = @code, name = @name, category = @category, location_code = @location_code,
      rack = @rack, shelf = @shelf, bin = @bin, quantity = @quantity, unit = @unit, condition = @condition,
      notes = @notes, updated_at = @now WHERE id = @id`)
    .run({ ...toColumns(merged), now: new Date().toISOString(), id: existing.id });
  return getItem(db, existing.id);
}

export function deleteItem(db, id) {
  const info = stmt(db, 'DELETE FROM items WHERE id = ?').run(id);
  if (info.changes === 0) throw notFound(`Item ${id} not found`);
}

/** SQLite's lower() only folds A-Z; register a Unicode-aware fold() (JS toLowerCase) once per db. */
const folded = new WeakSet();
function ensureFold(db) {
  if (folded.has(db)) return;
  db.function('fold', { deterministic: true }, (v) => (v === null || v === undefined ? null : String(v).toLowerCase()));
  folded.add(db);
}

const TEXT_FIELDS = ['code', 'name', 'category', 'notes'];
const contains = (fields, param) =>
  '(' + fields.map((f) => `instr(fold(COALESCE(${f}, '')), @${param}) > 0`).join(' OR ') + ')';

/** A query or word that names a coordinate: has a letter (so "2" stays text) and parses to a rack. */
function asCoordinate(text) {
  if (!/[a-z]/i.test(text)) return null;
  const loc = parseLocation(text);
  return loc.rack ? loc : null;
}

/** SQL matching an item's parsed rack/shelf/bin exactly (so R03-B-1 does not match R03-B-10). */
function locationMatch(loc, params, prefix) {
  params[`${prefix}r`] = loc.rack;
  const parts = [`rack = @${prefix}r`];
  if (loc.shelf) {
    params[`${prefix}s`] = loc.shelf;
    parts.push(`shelf = @${prefix}s`);
  }
  if (loc.bin !== null) {
    params[`${prefix}b`] = loc.bin;
    parts.push(`bin = @${prefix}b`);
  }
  return '(' + parts.join(' AND ') + ')';
}

/**
 * List / search items.
 * - q as a whole is a coordinate ("r3-b", "R3 B 2", "rack 3"): items at that rack/shelf/bin (exact
 *   components), plus items whose code/name/category/notes contain q.
 * - otherwise every whitespace-separated word must match (case-insensitive, Unicode-aware):
 *   a coordinate word ("r1") matches that rack/shelf/bin or code/name/category/notes; any other word
 *   matches code, name, category, locationCode text or notes.
 * - Ranking: exact code, exact location, code prefix, name prefix, others; ties by name.
 * - Filters: category (case-insensitive exact), rack ("3", "r3", "R03"), condition.
 */
export function listItems(db, { q, category, rack, condition } = {}) {
  ensureFold(db);
  const where = [];
  const params = {};

  if (category) {
    where.push('fold(category) = @category');
    params.category = category.toLowerCase();
  }
  if (rack) {
    params.rack = normalizeRack(rack) ?? rack.toUpperCase();
    where.push('rack = @rack');
  }
  if (condition) {
    where.push('condition = @condition');
    params.condition = condition;
  }

  const query = (q ?? '').trim().replace(/\s+/g, ' ');
  let orderBy = 'code COLLATE NOCASE';
  let rankSelect = '';
  if (query) {
    const ql = query.toLowerCase();
    params.ql = ql;
    params.loc = null;
    const whole = asCoordinate(query);
    if (whole) {
      params.loc = whole.locationCode;
      where.push(`(${locationMatch(whole, params, 'w')} OR ${contains(TEXT_FIELDS, 'ql')})`);
    } else {
      const tokens = [...new Set(ql.split(' '))]; // q is at most 200 chars, so this stays small
      tokens.forEach((t, i) => {
        params[`t${i}`] = t;
        const loc = asCoordinate(t);
        where.push(loc
          ? `(${locationMatch(loc, params, `c${i}`)} OR ${contains(TEXT_FIELDS, `t${i}`)})`
          : contains([...TEXT_FIELDS, 'location_code'], `t${i}`));
      });
    }
    rankSelect = `, CASE
        WHEN fold(code) = @ql THEN 0
        WHEN @loc IS NOT NULL AND location_code = @loc THEN 1
        WHEN substr(fold(code), 1, length(@ql)) = @ql THEN 2
        WHEN substr(fold(name), 1, length(@ql)) = @ql THEN 3
        ELSE 4 END AS search_rank`;
    orderBy = 'search_rank, fold(name), name, code COLLATE NOCASE';
  }

  const sql = `SELECT *${rankSelect} FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
  return db.prepare(sql).all(params).map(rowToItem);
}

/** Distinct categories with counts, grouped case-insensitively (Unicode-aware, like the filter). */
export function listCategories(db) {
  const groups = new Map(); // folded -> { name, count }
  for (const { name, count } of stmt(db, `SELECT category AS name, COUNT(*) AS count FROM items
      WHERE category IS NOT NULL AND category <> '' GROUP BY category`).all()) {
    const key = name.toLowerCase();
    const g = groups.get(key);
    if (!g) groups.set(key, { name, count });
    else {
      g.count += count;
      if (name < g.name) g.name = name; // stable display name: the smallest spelling
    }
  }
  return [...groups.entries()]
    .sort(([a, ga], [b, gb]) => (a < b ? -1 : a > b ? 1 : ga.name < gb.name ? -1 : 1))
    .map(([, g]) => g);
}

const rackNumber = (r) => Number(r.replace(/^R/, ''));
const byRack = (a, b) => rackNumber(a.rack) - rackNumber(b.rack) || a.rack.localeCompare(b.rack);

export function listRacks(db) {
  const racks = stmt(db, `SELECT rack, COUNT(*) AS itemCount,
        GROUP_CONCAT(DISTINCT shelf) AS shelves
      FROM items WHERE rack IS NOT NULL GROUP BY rack`).all()
    .map((r) => ({
      rack: r.rack,
      shelves: r.shelves ? r.shelves.split(',').sort() : [],
      itemCount: r.itemCount,
    }))
    .sort(byRack);
  const unlocated = stmt(db, 'SELECT COUNT(*) AS n FROM items WHERE rack IS NULL').get().n;
  return { racks, unlocated };
}

/** Items of one rack grouped by shelf (A..), each sorted by bin. Returns null if the rack has no items. */
export function getRack(db, rack) {
  const rows = stmt(db, `SELECT * FROM items WHERE rack = ?
      ORDER BY shelf, bin IS NULL, bin, code COLLATE NOCASE`).all(rack);
  if (rows.length === 0) return null;
  const shelves = new Map();
  const unshelved = [];
  for (const row of rows) {
    const item = rowToItem(row);
    if (!item.shelf) {
      unshelved.push(item);
      continue;
    }
    if (!shelves.has(item.shelf)) shelves.set(item.shelf, []);
    shelves.get(item.shelf).push(item);
  }
  return {
    rack,
    shelves: [...shelves.entries()].map(([shelf, items]) => ({ shelf, items })),
    unshelved,
  };
}
