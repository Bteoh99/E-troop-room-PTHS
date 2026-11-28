/**
 * Ordered, append-only list of schema migrations: `sql`, or `up(db, log)` for steps that need logic.
 * Each runs once, inside a transaction,
 * and is recorded in schema_version. Statements use IF NOT EXISTS so re-running is harmless.
 * Phase 2 (members, check-out/check-in transactions) = add the next version here; never edit old ones.
 * (ALTER TABLE steps are not idempotent by themselves; the version check makes them run once.)
 */
import { parseLocation, isCompartmentCode } from '../lib/location.js';

export const migrations = [
  {
    version: 1,
    name: 'items',
    sql: `
      CREATE TABLE IF NOT EXISTS items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        code          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        name          TEXT    NOT NULL,
        category      TEXT,
        location_code TEXT,
        rack          TEXT,
        shelf         TEXT,
        bin           INTEGER,
        quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
        unit          TEXT    NOT NULL DEFAULT 'pcs',
        condition     TEXT    NOT NULL DEFAULT 'good'
                      CHECK (condition IN ('good','needs_repair','damaged','written_off')),
        notes         TEXT    NOT NULL DEFAULT '',
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_location ON items (rack, shelf, bin);
      CREATE INDEX IF NOT EXISTS idx_items_category ON items (category COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_items_name     ON items (name COLLATE NOCASE);
    `,
  },
  {
    // Phase 1.5: manufacturer label + shop barcode, for scanning.
    version: 2,
    name: 'items brand/model/barcode',
    sql: `
      ALTER TABLE items ADD COLUMN brand   TEXT;
      ALTER TABLE items ADD COLUMN model   TEXT;
      ALTER TABLE items ADD COLUMN barcode TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode ON items (barcode) WHERE barcode IS NOT NULL;
    `,
  },
  {
    // Barcodes are unique ignoring leading zeros: a UPC "012345678905" that lost its leading zero in a
    // numeric Excel cell is the same barcode. Stored as given; compared with ltrim(barcode, '0').
    // v2 allowed such near-duplicates, so first keep the barcode on the lowest id of each group and
    // move it into the notes of the others; otherwise the unique index (and so the server) fails.
    version: 3,
    name: 'barcode unique ignoring leading zeros',
    up(db, log = console) {
      const removed = db.prepare(`
        UPDATE items SET
          notes = trim(notes || CASE WHEN notes = '' THEN '' ELSE ' ' END ||
            'Barcode ' || barcode || ' removed: duplicate of ' ||
            (SELECT k.code FROM items k WHERE k.id = (
              SELECT MIN(m.id) FROM items m WHERE m.barcode IS NOT NULL AND ltrim(m.barcode, '0') = ltrim(items.barcode, '0'))) ||
            ' (leading zeros)'),
          barcode = NULL
        WHERE barcode IS NOT NULL
          AND id NOT IN (SELECT MIN(id) FROM items WHERE barcode IS NOT NULL GROUP BY ltrim(barcode, '0'))
      `).run().changes;
      if (removed > 0) {
        log.warn(`Warning: ${removed} barcode(s) removed because they duplicated another item's barcode apart from leading zeros; see those items' notes.`);
      }
      db.exec(`
        DROP INDEX IF EXISTS idx_items_barcode;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode_key ON items (ltrim(barcode, '0')) WHERE barcode IS NOT NULL;
      `);
    },
  },
  {
    // Phase 1.6 (the troop's real inventory): code becomes optional, quantity nullable, condition
    // becomes good/bad counts, v2 locations (rack AU, level, compartment), kit contents, and a
    // compartments table for the rack layout (including empty compartments).
    // SQLite cannot drop NOT NULL in place, so the items table is rebuilt (ids are kept).
    version: 4,
    name: 'real inventory format: counts, v2 locations, compartments, contents',
    up(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_items_location;
        DROP INDEX IF EXISTS idx_items_category;
        DROP INDEX IF EXISTS idx_items_name;
        DROP INDEX IF EXISTS idx_items_barcode;
        DROP INDEX IF EXISTS idx_items_barcode_key;
        CREATE TABLE items_v4 (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          code          TEXT    UNIQUE COLLATE NOCASE,           -- optional, hidden in the UI
          name          TEXT    NOT NULL,
          category      TEXT,
          location_code TEXT,
          rack          TEXT,
          level         INTEGER,                                 -- v2: level 1 = bottom
          compartment   INTEGER,                                 -- v2
          shelf         TEXT,                                    -- legacy R03-B-2
          bin           INTEGER,                                 -- legacy
          quantity      INTEGER CHECK (quantity IS NULL OR quantity >= 0),
          unit          TEXT    NOT NULL DEFAULT 'pcs',
          good_qty      INTEGER CHECK (good_qty IS NULL OR good_qty >= 0),
          bad_qty       INTEGER CHECK (bad_qty IS NULL OR bad_qty >= 0),
          condition     TEXT,                                    -- retired (Phase 1 value kept for history)
          notes         TEXT    NOT NULL DEFAULT '',
          brand         TEXT,
          model         TEXT,
          barcode       TEXT,
          contents      TEXT,                                    -- JSON [{ name, quantity }] or NULL
          created_at    TEXT    NOT NULL,
          updated_at    TEXT    NOT NULL
        );
        INSERT INTO items_v4 (id, code, name, category, location_code, rack, shelf, bin, quantity, unit,
            good_qty, bad_qty, condition, notes, brand, model, barcode, contents, created_at, updated_at)
          SELECT id, code, name, category, location_code, rack, shelf, bin, quantity, unit,
            CASE condition WHEN 'good' THEN quantity ELSE 0 END,
            CASE condition WHEN 'good' THEN 0 ELSE quantity END,
            condition,
            CASE WHEN condition = 'written_off'
              THEN trim(notes || CASE WHEN notes = '' THEN '' ELSE ' ' END || 'Written off') ELSE notes END,
            brand, model, barcode, NULL, created_at, updated_at
          FROM items;
        DROP TABLE items;
        ALTER TABLE items_v4 RENAME TO items;
        CREATE INDEX IF NOT EXISTS idx_items_location ON items (rack, level, compartment, shelf, bin);
        CREATE INDEX IF NOT EXISTS idx_items_location_code ON items (location_code);
        CREATE INDEX IF NOT EXISTS idx_items_category ON items (category COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_items_name ON items (name COLLATE NOCASE);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode_key ON items (ltrim(barcode, '0')) WHERE barcode IS NOT NULL;
        CREATE TABLE IF NOT EXISTS compartments (
          code        TEXT PRIMARY KEY,                          -- "AU0305"
          rack        TEXT NOT NULL,
          level       INTEGER NOT NULL,
          compartment INTEGER NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_compartments_rack ON compartments (rack, level, compartment);
      `);
      // Re-derive every location with the v2-aware parser and register v2 compartments.
      const rows = db.prepare('SELECT id, location_code FROM items WHERE location_code IS NOT NULL').all();
      const setLoc = db.prepare(`UPDATE items SET location_code = @locationCode, rack = @rack, level = @level,
        compartment = @compartment, shelf = @shelf, bin = @bin WHERE id = @id`);
      const addComp = db.prepare(`INSERT OR IGNORE INTO compartments (code, rack, level, compartment, created_at)
        VALUES (?, ?, ?, ?, ?)`);
      const now = new Date().toISOString();
      for (const r of rows) {
        const loc = parseLocation(r.location_code);
        setLoc.run({ id: r.id, ...loc });
        if (isCompartmentCode(loc)) addComp.run(loc.locationCode, loc.rack, loc.level, loc.compartment, now);
      }
    },
  },
];
