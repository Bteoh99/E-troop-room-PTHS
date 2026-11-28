/**
 * Excel/CSV header mapping (pure). Header matching is case-, space- and punctuation-insensitive,
 * so "Item Code", "ITEM_CODE", "itemcode" and "Item code:" are all the same.
 */

/** Field -> aliases, in priority order (first alias found wins when several columns match). */
export const HEADER_ALIASES = {
  code: ['code', 'item code', 'itemcode', 'kod', 'kod item', 'kod barang', 'item no', 'item id', 'id'],
  name: ['name', 'item name', 'item description', 'nama', 'nama item', 'nama barang', 'item', 'barang', 'description', 'keterangan'],
  location: ['location', 'coordinate', 'coordinates', 'koordinat', 'lokasi', 'rack location', 'location code', 'kedudukan'],
  category: ['category', 'kategori', 'type', 'jenis'],
  quantity: ['qty', 'quantity', 'kuantiti', 'jumlah', 'bilangan', 'count'],
  unit: ['unit', 'uom', 'units', 'unit of measure', 'unit ukuran'],
  condition: ['condition', 'keadaan', 'status', 'state'],
  notes: ['notes', 'note', 'remarks', 'remark', 'catatan', 'comments', 'comment', 'ulasan'],
  rack: ['rack', 'rak', 'rack no', 'rack number', 'no rak'],
  shelf: ['shelf', 'shelf level', 'level', 'tingkat', 'para'],
  bin: ['bin', 'bin no', 'position', 'slot', 'petak', 'kotak'],
  brand: ['brand', 'jenama', 'manufacturer', 'make', 'pengeluar'],
  model: ['model', 'model no', 'model number', 'no model'],
  barcode: ['barcode', 'kod bar', 'ean', 'upc'],
  goodQty: ['good condition', 'good', 'good qty', 'qty good', 'baik', 'keadaan baik', 'bilangan baik'],
  badQty: ['bad condition', 'bad', 'bad qty', 'qty bad', 'rosak', 'keadaan rosak', 'bilangan rosak'],
};

/** Since Phase 1.6 only a name column is required (codes are optional; the real file's CODE is a location). */
export const REQUIRED_FIELDS = ['name'];

/** "Item Code:" -> "itemcode" */
export function normalizeHeader(h) {
  if (h === null || h === undefined) return '';
  return String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ALIAS_INDEX = new Map(); // normalized alias -> { field, priority }
for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
  aliases.forEach((alias, priority) => {
    const key = normalizeHeader(alias);
    if (!ALIAS_INDEX.has(key)) ALIAS_INDEX.set(key, { field, priority });
  });
}

/** Headers that, when they lose the "name" slot to a better column, are really remarks. */
const NOTES_FALLBACK = new Set(['description', 'keterangan'].map(normalizeHeader));

/**
 * Map a header row to field -> column index.
 * When several columns match the same field, the highest-priority alias wins; the others are
 * reported in `shadowed` (and a losing "Description"/"Keterangan" becomes notes if no notes column exists).
 * @param {unknown[]} headerCells
 * @returns {{ mapping: Record<string, number>, unmapped: string[],
 *   shadowed: { index: number, header: string, field: string, winner: string }[],
 *   ignored: string[] }}  ignored = unmapped + shadowed, in column order, for display
 */
export function mapHeaders(headerCells) {
  const best = {}; // field -> { index, priority }
  const hits = []; // { index, header, key, field, priority }
  const ignoredByIndex = new Map();
  const unmapped = [];
  headerCells.forEach((cell, index) => {
    const key = normalizeHeader(cell);
    if (!key) return;
    const header = String(cell).trim();
    const hit = ALIAS_INDEX.get(key);
    if (!hit) {
      unmapped.push(header);
      ignoredByIndex.set(index, header);
      return;
    }
    hits.push({ index, header, key, ...hit });
    const cur = best[hit.field];
    if (!cur || hit.priority < cur.priority) best[hit.field] = { index, priority: hit.priority };
  });

  const shadowed = [];
  for (const h of hits) {
    if (best[h.field].index === h.index) continue;
    if (h.field === 'name' && NOTES_FALLBACK.has(h.key) && !best.notes) {
      best.notes = { index: h.index, priority: Infinity };
      continue;
    }
    const winner = String(headerCells[best[h.field].index]).trim();
    shadowed.push({ index: h.index, header: h.header, field: h.field, winner });
    ignoredByIndex.set(h.index, `${h.header} (duplicate ${h.field} column; "${winner}" is used)`);
  }

  const mapping = Object.fromEntries(Object.entries(best).map(([f, v]) => [f, v.index]));
  const ignored = [...ignoredByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text);
  return { mapping, unmapped, shadowed, ignored };
}

/**
 * Find the header row among the first `maxScan` (20) rows (real spreadsheets often have a title
 * or blank rows above the header). Picks the row with the most recognised headers,
 * preferring rows that contain both code and name.
 * @param {unknown[][]} rows
 * @returns {{ headerIndex: number, mapping: Record<string, number>, unmapped: string[], ignored: string[] } | null}
 */
export function findHeaderRow(rows, maxScan = 20) {
  let best = null;
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i] ?? [];
    const { mapping, unmapped, ignored } = mapHeaders(cells);
    const count = Object.keys(mapping).length;
    if (count === 0) continue;
    const hasRequired = REQUIRED_FIELDS.every((f) => f in mapping);
    const score = (hasRequired ? 100 : 0) + count;
    if (!best || score > best.score) best = { headerIndex: i, mapping, unmapped, ignored, score };
    if (hasRequired && count >= 3) break;
  }
  if (!best) return null;
  const { score, ...rest } = best;
  return rest;
}
