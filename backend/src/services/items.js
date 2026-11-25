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

const SEARCH_FIELDS = ['code', 'name', "COALESCE(category, '')", "COALESCE(location_code, '')", 'notes'];

/**
 * List / search items.
 * - q: every whitespace-separated word must appear (case-insensitive) in code, name, category,
 *   locationCode or notes. A q that looks like a coordinate ("r3-b", "R3 B 2") also matches the
 *   normalized location ("R03-B..."). Ranking: exact code, code prefix, name prefix, others; ties by name.
 * - category (case-insensitive exact), rack ("3", "r3", "R03"), condition.
 */
export function listItems(db, { q, category, rack, condition } = {}) {
  const where = [];
  const params = {};

  if (category) {
    where.push('category = @category COLLATE NOCASE');
    params.category = category;
  }
  if (rack) {
    params.rack = normalizeRack(rack) ?? rack.toUpperCase();
    where.push('rack = @rack');
  }
  if (condition) {
    where.push('condition = @condition');
    params.condition = condition;
  }

  const query = (q ?? '').trim();
  let orderBy = 'code COLLATE NOCASE';
  let rankSelect = '';
  if (query) {
    const ql = query.toLowerCase();
    params.q = query;
    params.ql = ql;
    const tokens = [...new Set(ql.split(/\s+/).filter(Boolean))].slice(0, 8);
    const tokenClauses = tokens.map((t, i) => {
      params[`t${i}`] = t;
      return '(' + SEARCH_FIELDS.map((f) => `instr(lower(${f}), @t${i}) > 0`).join(' OR ') + ')';
    });
    let textMatch = tokenClauses.join(' AND ');

    // Coordinate-style query, e.g. "r3-b" -> also match location_code "R03-B" / "R03-B-…".
    const loc = /[a-z]/i.test(query) ? parseLocation(query) : null;
    if (loc?.rack) {
      params.loc = loc.locationCode;
      params.locPrefix = `${loc.locationCode}-`;
      textMatch = `(${textMatch}) OR location_code = @loc OR substr(location_code, 1, length(@locPrefix)) = @locPrefix`;
    }
    where.push(`(${textMatch})`);
    rankSelect = `, CASE
        WHEN code = @q COLLATE NOCASE THEN 0
        WHEN substr(lower(code), 1, length(@ql)) = @ql THEN 1
        WHEN substr(lower(name), 1, length(@ql)) = @ql THEN 2
        ELSE 3 END AS search_rank`;
    orderBy = 'search_rank, name COLLATE NOCASE, code COLLATE NOCASE';
  }

  const sql = `SELECT *${rankSelect} FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy}`;
  return db.prepare(sql).all(params).map(rowToItem);
}

export function listCategories(db) {
  return stmt(db, `SELECT MIN(category) AS name, COUNT(*) AS count FROM items
      WHERE category IS NOT NULL AND category <> ''
      GROUP BY category COLLATE NOCASE ORDER BY name COLLATE NOCASE`).all();
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
