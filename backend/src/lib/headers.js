/**
 * Excel/CSV header mapping (pure). Header matching is case-, space- and punctuation-insensitive,
 * so "Item Code", "ITEM_CODE", "itemcode" and "Item code:" are all the same.
 */

/** Field -> aliases, in priority order (first alias found wins when several columns match). */
export const HEADER_ALIASES = {
  code: ['code', 'item code', 'itemcode', 'kod', 'kod item', 'kod barang', 'item no', 'item id', 'id'],
  name: ['name', 'item name', 'nama', 'nama item', 'nama barang', 'item', 'barang', 'description', 'keterangan'],
  location: ['location', 'coordinate', 'coordinates', 'koordinat', 'lokasi', 'rack location', 'location code', 'kedudukan'],
  category: ['category', 'kategori', 'type', 'jenis'],
  quantity: ['qty', 'quantity', 'kuantiti', 'jumlah', 'bilangan', 'count'],
  unit: ['unit', 'uom', 'units', 'unit of measure', 'unit ukuran'],
  condition: ['condition', 'keadaan', 'status', 'state'],
  notes: ['notes', 'note', 'remarks', 'remark', 'catatan', 'comments', 'comment', 'ulasan'],
  rack: ['rack', 'rak', 'rack no', 'rack number', 'no rak'],
  shelf: ['shelf', 'shelf level', 'level', 'tingkat', 'para'],
  bin: ['bin', 'bin no', 'position', 'slot', 'petak', 'kotak'],
};

export const REQUIRED_FIELDS = ['code', 'name'];

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

/**
 * Map a header row to field -> column index.
 * @param {unknown[]} headerCells
 * @returns {{ mapping: Record<string, number>, unmapped: string[] }}
 */
export function mapHeaders(headerCells) {
  const best = {}; // field -> { index, priority }
  const unmapped = [];
  headerCells.forEach((cell, index) => {
    const key = normalizeHeader(cell);
    if (!key) return;
    const hit = ALIAS_INDEX.get(key);
    if (!hit) {
      unmapped.push(String(cell).trim());
      return;
    }
    const cur = best[hit.field];
    if (!cur || hit.priority < cur.priority) best[hit.field] = { index, priority: hit.priority };
  });
  const mapping = Object.fromEntries(Object.entries(best).map(([f, v]) => [f, v.index]));
  return { mapping, unmapped };
}

/**
 * Find the header row among the first `maxScan` rows (real spreadsheets often have a title
 * or blank rows above the header). Picks the row with the most recognised headers,
 * preferring rows that contain both code and name.
 * @param {unknown[][]} rows
 * @returns {{ headerIndex: number, mapping: Record<string, number>, unmapped: string[] } | null}
 */
export function findHeaderRow(rows, maxScan = 15) {
  let best = null;
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i] ?? [];
    const { mapping, unmapped } = mapHeaders(cells);
    const count = Object.keys(mapping).length;
    if (count === 0) continue;
    const hasRequired = REQUIRED_FIELDS.every((f) => f in mapping);
    const score = (hasRequired ? 100 : 0) + count;
    if (!best || score > best.score) best = { headerIndex: i, mapping, unmapped, score };
    if (hasRequired && count >= 3) break;
  }
  if (!best) return null;
  const { score, ...rest } = best;
  return rest;
}
