/**
 * Item data access. All SQL is parameterized. Functions take the db handle explicitly
 * so tests (and Phase 2 services) can use their own database.
 *
 * Item (Phase 1.6): { id, code (optional, hidden in the UI), name, category, locationCode, rack,
 *   level, compartment (v2 "AU0305"), shelf, bin (legacy "R03-B-2"), quantity (int or null),
 *   unit, goodQty, badQty (int or null), status ("attention" | "ok" | "unchecked", derived),
 *   countsMismatch (derived), notes, brand, model, barcode, contents ([{ name, quantity }]),
 *   createdAt, updatedAt }. The old `condition` is accepted on write (-> counts) but never returned.
 */
import { createItemSchema, updateItemSchema } from '../lib/itemSchema.js';
import { parseLocation, normalizeRack, isCompartmentCode } from '../lib/location.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

const stmtCache = new WeakMap();
function stmt(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) stmtCache.set(db, (cache = new Map()));
  let s = cache.get(sql);
  if (!s) cache.set(sql, (s = db.prepare(sql)));
  return s;
}

/** "attention" if any bad; "ok" if some good and no bad; otherwise "unchecked". */
export function deriveStatus(goodQty, badQty) {
  if (badQty > 0) return 'attention';
  if (goodQty > 0) return 'ok';
  return 'unchecked';
}

/** Warning only: all three are numbers and good + bad differs from the quantity. */
export const countsMismatch = (quantity, goodQty, badQty) =>
  Number.isInteger(quantity) && Number.isInteger(goodQty) && Number.isInteger(badQty) && goodQty + badQty !== quantity;

/** Add the read-only derived fields. */
function withDerived(item) {
  return {
    ...item,
    status: deriveStatus(item.goodQty, item.badQty),
    countsMismatch: countsMismatch(item.quantity, item.goodQty, item.badQty),
  };
}

function parseContents(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** DB row -> API Item */
export function rowToItem(r) {
  if (!r) return null;
  return withDerived({
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    locationCode: r.location_code,
    rack: r.rack,
    level: r.level,
    compartment: r.compartment,
    shelf: r.shelf,
    bin: r.bin,
    quantity: r.quantity,
    unit: r.unit,
    goodQty: r.good_qty,
    badQty: r.bad_qty,
    notes: r.notes,
    brand: r.brand,
    model: r.model,
    barcode: r.barcode,
    contents: parseContents(r.contents),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

/** Item-like values (validated) -> DB columns, with the location parts derived from locationCode. */
function toColumns(v) {
  const loc = parseLocation(v.locationCode);
  return {
    code: v.code ?? null,
    name: v.name,
    category: v.category,
    location_code: loc.locationCode,
    rack: loc.rack,
    level: loc.level,
    compartment: loc.compartment,
    shelf: loc.shelf,
    bin: loc.bin,
    quantity: v.quantity,
    unit: v.unit,
    good_qty: v.goodQty,
    bad_qty: v.badQty,
    notes: v.notes,
    brand: v.brand,
    model: v.model,
    barcode: v.barcode,
    contents: v.contents && v.contents.length ? JSON.stringify(v.contents) : null,
  };
}

const appendNote = (notes, text) => (notes ? (notes.includes(text) ? notes : `${notes} ${text}`) : text);

/**
 * The retired `condition` as good/bad counts (same rule as migration v4):
 * good -> good = quantity, bad = 0; needs_repair / damaged -> bad = quantity, good = 0;
 * written_off -> bad = quantity and the note "Written off".
 */
export function conditionToCounts(condition, quantity, notes = '') {
  if (condition === 'good') return { goodQty: quantity, badQty: 0, notes };
  if (condition === 'written_off') return { goodQty: 0, badQty: quantity, notes: appendNote(notes, 'Written off') };
  return { goodQty: 0, badQty: quantity, notes };
}

function applyCondition(values, input) {
  const { condition, ...rest } = values;
  if (!condition || input.goodQty !== undefined || input.badQty !== undefined) return rest;
  return { ...rest, ...conditionToCounts(condition, rest.quantity, rest.notes) };
}

const ITEM_FIELDS = ['code', 'name', 'category', 'locationCode', 'quantity', 'unit', 'goodQty', 'badQty', 'notes', 'brand', 'model', 'barcode', 'contents'];
const pickItemFields = (v) => Object.fromEntries(ITEM_FIELDS.map((k) => [k, v[k]]));

/** Re-derive location parts from locationCode and the derived fields. Pure. */
function finish(values) {
  const loc = parseLocation(values.locationCode);
  return withDerived({
    ...values,
    locationCode: loc.locationCode, rack: loc.rack, level: loc.level, compartment: loc.compartment, shelf: loc.shelf, bin: loc.bin,
  });
}

/** Build the full Item (without id/timestamps) that `input` would create. Throws ZodError. */
export function buildNewItem(input) {
  return finish(pickItemFields(applyCondition(createItemSchema.parse(input), input)));
}

/** Apply a validated partial patch to an existing Item, re-deriving location and status. Pure. */
export function mergeItem(existing, patch) {
  const { condition, ...rest } = patch;
  let merged = { ...existing, ...rest };
  if (condition && patch.goodQty === undefined && patch.badQty === undefined) {
    merged = { ...merged, ...conditionToCounts(condition, merged.quantity, merged.notes) };
  }
  return finish(merged);
}

export const foldName = (name) => String(name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export function getItem(db, id) {
  return rowToItem(stmt(db, 'SELECT * FROM items WHERE id = ?').get(id));
}

export function getItemByCode(db, code) {
  if (code === null || code === undefined || String(code).trim() === '') return null;
  return rowToItem(stmt(db, 'SELECT * FROM items WHERE code = ? COLLATE NOCASE').get(String(code).trim()));
}

/** Import key for items without a code: same (normalized) location + same folded name. */
export function findByLocationAndName(db, locationCode, name) {
  const key = foldName(name);
  const rows = stmt(db, 'SELECT * FROM items WHERE location_code IS ? ORDER BY id').all(locationCode ?? null);
  const hit = rows.find((r) => foldName(r.name) === key);
  return hit ? rowToItem(hit) : null;
}

/** Barcodes compare ignoring leading zeros (same expression as the unique index). */
export function getItemByBarcode(db, barcode) {
  return rowToItem(stmt(db, "SELECT * FROM items WHERE barcode IS NOT NULL AND ltrim(barcode, '0') = ltrim(?, '0')").get(barcode));
}

/** Import helper: free a barcode before another item takes it in the same transaction. */
export function clearBarcode(db, id) {
  stmt(db, 'UPDATE items SET barcode = NULL WHERE id = ?').run(id);
}

function assertBarcodeFree(db, barcode, selfId = null) {
  if (!barcode) return;
  const other = getItemByBarcode(db, barcode);
  if (other && other.id !== selfId) {
    const who = other.code ? `item ${other.code}` : `${other.name}${other.locationCode ? ` (${other.locationCode})` : ''}`;
    throw conflict(`Barcode ${barcode} is already used by ${who}`, { field: 'barcode', code: other.code });
  }
}

/** Remember a v2 compartment ("AU0305") in the rack layout. */
export function registerCompartment(db, locationCode) {
  const loc = parseLocation(locationCode);
  if (!isCompartmentCode(loc)) return false;
  return stmt(db, `INSERT OR IGNORE INTO compartments (code, rack, level, compartment, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(loc.locationCode, loc.rack, loc.level, loc.compartment, new Date().toISOString()).changes > 0;
}

/** Delete an EMPTY compartment from the layout: 400 not a code, 404 unknown, 409 still has items. */
export function deleteCompartment(db, code) {
  const loc = parseLocation(code);
  if (!isCompartmentCode(loc)) throw badRequest(`"${code}" is not a compartment code like AU0305`);
  const n = stmt(db, 'SELECT COUNT(*) AS n FROM items WHERE location_code = ?').get(loc.locationCode).n;
  if (n > 0) throw conflict(`Compartment ${loc.locationCode} still has ${n} item(s); move them first`, { items: n });
  const info = stmt(db, 'DELETE FROM compartments WHERE code = ?').run(loc.locationCode);
  if (info.changes === 0) throw notFound(`Compartment ${loc.locationCode} not found`);
}

export function countItems(db) {
  return stmt(db, 'SELECT COUNT(*) AS n FROM items').get().n;
}

const INSERT_SQL = `INSERT INTO items
    (code, name, category, location_code, rack, level, compartment, shelf, bin, quantity, unit, good_qty, bad_qty,
     notes, brand, model, barcode, contents, created_at, updated_at)
  VALUES (@code, @name, @category, @location_code, @rack, @level, @compartment, @shelf, @bin, @quantity, @unit,
     @good_qty, @bad_qty, @notes, @brand, @model, @barcode, @contents, @now, @now)`;

export function createItem(db, input) {
  const item = buildNewItem(input);
  if (item.code && getItemByCode(db, item.code)) throw conflict(`An item with code ${item.code} already exists`, { field: 'code' });
  assertBarcodeFree(db, item.barcode);
  const info = stmt(db, INSERT_SQL).run({ ...toColumns(item), now: new Date().toISOString() });
  registerCompartment(db, item.locationCode);
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
  if (patch.barcode) assertBarcodeFree(db, patch.barcode, existing.id);
  const merged = mergeItem(existing, patch);
  stmt(db, `UPDATE items SET code = @code, name = @name, category = @category, location_code = @location_code,
      rack = @rack, level = @level, compartment = @compartment, shelf = @shelf, bin = @bin, quantity = @quantity,
      unit = @unit, good_qty = @good_qty, bad_qty = @bad_qty, notes = @notes, brand = @brand, model = @model,
      barcode = @barcode, contents = @contents, updated_at = @now WHERE id = @id`)
    .run({ ...toColumns(merged), now: new Date().toISOString(), id: existing.id });
  registerCompartment(db, merged.locationCode);
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

const TEXT_FIELDS = ['code', 'name', 'category', 'notes', 'brand', 'model', 'barcode'];
const contains = (fields, param) =>
  '(' + fields.map((f) => `instr(fold(COALESCE(${f}, '')), @${param}) > 0`).join(' OR ') + ')';

/**
 * A query or word that names a location: has a letter (so "2" stays text) and parses to a rack.
 * Search is lenient: lower-case "au" also means rack AU.
 */
function asCoordinate(text) {
  if (!/[a-z]/i.test(text)) return null;
  const loc = parseLocation(text, { allowBareRack: true });
  return loc.rack ? loc : null;
}

/** SQL matching an item's parsed location parts exactly (so R03-B-1 does not match R03-B-10). */
function locationMatch(loc, params, prefix) {
  params[`${prefix}r`] = loc.rack;
  const parts = [`rack = @${prefix}r`];
  for (const [field, col] of [['level', 'level'], ['compartment', 'compartment'], ['shelf', 'shelf'], ['bin', 'bin']]) {
    if (loc[field] !== null && loc[field] !== undefined) {
      params[`${prefix}${col}`] = loc[field];
      parts.push(`${col} = @${prefix}${col}`);
    }
  }
  return '(' + parts.join(' AND ') + ')';
}

const STATUS_SQL = {
  attention: 'bad_qty > 0',
  ok: 'good_qty > 0 AND COALESCE(bad_qty, 0) = 0',
  unchecked: 'COALESCE(bad_qty, 0) = 0 AND COALESCE(good_qty, 0) = 0',
};

/** Items without a code (the real inventory) sort by location, then name. */
const DEFAULT_ORDER = 'code IS NULL, code COLLATE NOCASE, location_code IS NULL, location_code, fold(name), id';

/**
 * List / search items.
 * - q as a whole is a location ("AU0305", "au 03 05", "AU03" = whole level, "AU" = whole rack, legacy
 *   "r3-b"): items at that location (exact parts), plus items whose text fields contain q.
 * - otherwise every whitespace-separated word must match (case-insensitive, Unicode-aware):
 *   a location word ("r1", "au03") matches that location or the text fields; any other word matches the
 *   text fields or the locationCode text.
 * - Text fields: code, name, category, notes, brand, model, barcode (+ locationCode text).
 * - Ranking: exact code or exact barcode, exact location, code prefix, name prefix, others; ties by name.
 * - Filters: category (case-insensitive exact), rack ("AU", "3", "r3", "R03"), status, unlocated
 *   (rack is null: no location or a location that is not a coordinate).
 */
export function listItems(db, { q, category, rack, status, unlocated } = {}) {
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
  if (status) where.push(`(${STATUS_SQL[status]})`);
  if (unlocated) where.push('rack IS NULL');

  const query = (q ?? '').trim().replace(/\s+/g, ' ');
  let orderBy = DEFAULT_ORDER;
  let rankSelect = '';
  if (query) {
    const ql = query.toLowerCase();
    params.ql = ql;
    params.bc = query.replace(/\s+/g, '').toUpperCase();
    params.loc = null;
    const whole = asCoordinate(query);
    const textMatch = [];
    // A location with digits ("R03-B-1", "AU03") matches its parts exactly, never as location text
    // (so R03-B-1 does not find R03-B-10). Letters alone ("cup", "au") may be a rack id or a word, so
    // they also match the location text ("Store cupboard").
    const fieldsFor = (t) => (/\d/.test(t) ? TEXT_FIELDS : [...TEXT_FIELDS, 'location_code']);
    if (whole) {
      params.loc = whole.locationCode;
      textMatch.push(`(${locationMatch(whole, params, 'w')} OR ${contains(fieldsFor(ql), 'ql')})`);
    } else {
      const tokens = [...new Set(ql.split(' '))]; // q is at most 200 chars, so this stays small
      tokens.forEach((t, i) => {
        params[`t${i}`] = t;
        const loc = asCoordinate(t);
        textMatch.push(loc
          ? `(${locationMatch(loc, params, `c${i}`)} OR ${contains(fieldsFor(t), `t${i}`)})`
          : contains([...TEXT_FIELDS, 'location_code'], `t${i}`));
      });
    }
    // A barcode typed with (or without) the leading zeros Excel tends to drop still finds the item,
    // using the same leading-zero-insensitive rule as the ranking, uniqueness check and scan.
    const barcodeMatch = `(barcode IS NOT NULL AND ltrim(@bc, '0') <> '' AND ltrim(barcode, '0') = ltrim(@bc, '0'))`;
    where.push(`((${textMatch.join(' AND ')}) OR ${barcodeMatch})`);
    rankSelect = `, CASE
        WHEN fold(code) = @ql OR (barcode IS NOT NULL AND ltrim(barcode, '0') = ltrim(@bc, '0')) THEN 0
        WHEN @loc IS NOT NULL AND location_code = @loc THEN 1
        WHEN substr(fold(code), 1, length(@ql)) = @ql THEN 2
        WHEN substr(fold(name), 1, length(@ql)) = @ql THEN 3
        ELSE 4 END AS search_rank`;
    orderBy = 'search_rank, fold(name), name, code COLLATE NOCASE, id';
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

/** Legacy racks are "R" + digits ("R03"); v2 racks are letters ("AU"). */
export const isLegacyRack = (rack) => /^R\d+$/.test(rack);
const byRackId = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * GET /api/racks: { racks: [{ rack, levels, compartments, emptyCompartments, itemCount }], unlocated }.
 * v2 racks: levels = distinct levels, compartments = known compartments (layout table + item codes),
 * emptyCompartments = compartments with no items. Legacy racks: levels = number of shelves,
 * compartments = distinct shelf+bin places, emptyCompartments 0, plus `shelves: ["A", ...]`.
 */
export function listRacks(db) {
  const byRack = new Map();
  const get = (rack) => {
    if (!byRack.has(rack)) byRack.set(rack, { itemCount: 0, levels: new Set(), comps: new Set(), used: new Set(), shelves: new Set(), places: new Set() });
    return byRack.get(rack);
  };
  for (const r of stmt(db, 'SELECT rack, level, compartment, shelf, bin, location_code FROM items WHERE rack IS NOT NULL').all()) {
    const g = get(r.rack);
    g.itemCount++;
    if (r.level !== null) g.levels.add(r.level);
    if (r.compartment !== null) {
      g.comps.add(r.location_code);
      g.used.add(r.location_code);
    }
    if (r.shelf) {
      g.shelves.add(r.shelf);
      g.places.add(`${r.shelf}-${r.bin ?? ''}`);
    }
  }
  for (const c of stmt(db, 'SELECT code, rack, level FROM compartments').all()) {
    const g = get(c.rack);
    g.levels.add(c.level);
    g.comps.add(c.code);
  }
  const racks = [...byRack.keys()].sort(byRackId).map((rack) => {
    const g = byRack.get(rack);
    if (isLegacyRack(rack)) {
      return { rack, levels: g.shelves.size, compartments: g.places.size, emptyCompartments: 0, itemCount: g.itemCount, shelves: [...g.shelves].sort() };
    }
    return { rack, levels: g.levels.size, compartments: g.comps.size, emptyCompartments: g.comps.size - g.used.size, itemCount: g.itemCount };
  });
  const unlocated = stmt(db, 'SELECT COUNT(*) AS n FROM items WHERE rack IS NULL').get().n;
  return { racks, unlocated };
}

/**
 * GET /api/racks/:rack. Returns null if the rack has neither items nor known compartments.
 * - v2:     { rack, levels: [{ level, compartments: [{ code, compartment, items }] }], unshelved }
 *           levels DESCENDING (top first, level 01 last), compartments ascending, empty ones with items: [].
 *           unshelved = items with only a rack or rack + level ("AU", "AU03").
 * - legacy: { rack, shelves: [{ shelf, items }], unshelved } (shelves A.., items by bin).
 */
export function getRack(db, rack) {
  ensureFold(db);
  const rows = stmt(db, `SELECT * FROM items WHERE rack = ?
      ORDER BY level DESC, compartment, shelf, bin IS NULL, bin, fold(name), id`);
  const items = rows.all(rack).map(rowToItem);
  if (isLegacyRack(rack)) {
    if (items.length === 0) return null;
    const shelves = new Map();
    const unshelved = [];
    for (const item of items) {
      if (!item.shelf) {
        unshelved.push(item);
        continue;
      }
      if (!shelves.has(item.shelf)) shelves.set(item.shelf, []);
      shelves.get(item.shelf).push(item);
    }
    for (const list of shelves.values()) list.sort((a, b) => (a.bin ?? Infinity) - (b.bin ?? Infinity) || String(a.code).localeCompare(String(b.code)));
    return {
      rack,
      shelves: [...shelves.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([shelf, list]) => ({ shelf, items: list })),
      unshelved,
    };
  }

  const comps = stmt(db, 'SELECT code, level, compartment FROM compartments WHERE rack = ?').all(rack);
  if (items.length === 0 && comps.length === 0) return null;
  const levels = new Map(); // level -> Map(code -> { code, compartment, items })
  const slot = (level, compartment, code) => {
    if (!levels.has(level)) levels.set(level, new Map());
    const m = levels.get(level);
    if (!m.has(code)) m.set(code, { code, compartment, items: [] });
    return m.get(code);
  };
  for (const c of comps) slot(c.level, c.compartment, c.code);
  const unshelved = [];
  for (const item of items) {
    if (item.level !== null && item.compartment !== null) slot(item.level, item.compartment, item.locationCode).items.push(item);
    else {
      if (item.level !== null && !levels.has(item.level)) levels.set(item.level, new Map());
      unshelved.push(item);
    }
  }
  return {
    rack,
    levels: [...levels.entries()]
      .sort(([a], [b]) => b - a)
      .map(([level, m]) => ({ level, compartments: [...m.values()].sort((a, b) => a.compartment - b.compartment || a.code.localeCompare(b.code)) })),
    unshelved,
  };
}
