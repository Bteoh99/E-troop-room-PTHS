/**
 * Ordered, append-only list of schema migrations: `sql`, or `up(db, log)` for steps that need logic.
 * Each runs once, inside a transaction,
 * and is recorded in schema_version. Statements use IF NOT EXISTS so re-running is harmless.
 * Phase 2 (members, check-out/check-in transactions) = add the next version here; never edit old ones.
 * (ALTER TABLE steps are not idempotent by themselves; the version check makes them run once.)
 */
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
];
