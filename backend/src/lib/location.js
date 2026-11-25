/**
 * Location coordinate parser (pure, no I/O).
 *
 * Canonical form: "R03-B-2" = Rack 03, Shelf B (A = top), Bin 2.
 * Accepts loose input such as "R03-B-2", "r3-b-2", "R3 B 2", "R3/B/2", "3-B-2", "R03-B", "R03",
 * "R3B2", "R03–B–2" (en/em dashes), "Rack 3 Shelf B Bin 2", "Rak 3 Tingkat B Petak 2".
 *
 * The text must START with a rack (a number, optionally after R / Rack / Rak). Shelf and bin
 * keywords are only understood after the rack, so "Bin 5", "Shelf 3" or "Tingkat 2" are NOT
 * coordinates. Unparseable input is kept as-is (trimmed) with rack/shelf/bin = null.
 */

const SEP = String.raw`[\s\-\/\\._:,|#]*`;
const RACK_PART = String.raw`(?:(?:RACK|RAK|R)${SEP}(?:NO\.?${SEP})?)?0*(\d{1,3})`;
const SHELF_WORD = String.raw`(?:SHELF|LEVEL|TINGKAT|PARA)`;
const BIN_WORD = String.raw`(?:BIN|POSITION|POS|SLOT|PETAK|NO\.?)`;
const LOCATION_RE = new RegExp(
  String.raw`^${RACK_PART}(?:${SEP}(?:${SHELF_WORD}${SEP})?([A-Z])(?:${SEP}(?:${BIN_WORD}${SEP})?0*(\d{1,4}))?)?$`
);
const RACK_RE = new RegExp(String.raw`^${RACK_PART}$`);

/** Hyphen look-alikes that AutoCorrect / copy-paste produce: ‐ ‑ ‒ – — ― − ﹘ ﹣ － */
const DASHES = /[‐-―−﹘﹣－]/g;

function prepare(input) {
  return String(input).replace(DASHES, '-').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** Zero-pad a rack number to 2 digits: 3 -> "R03", 12 -> "R12", 105 -> "R105". */
export function formatRack(num) {
  return `R${String(Number(num)).padStart(2, '0')}`;
}

/** Normalize a rack identifier ("r3", "3", "R003", "Rack 3") to "R03", or null. */
export function normalizeRack(input) {
  if (input === null || input === undefined) return null;
  const m = RACK_RE.exec(prepare(input));
  return m ? formatRack(m[1]) : null;
}

/**
 * @param {unknown} input
 * @returns {{ locationCode: string|null, rack: string|null, shelf: string|null, bin: number|null }}
 */
export function parseLocation(input) {
  const empty = { locationCode: null, rack: null, shelf: null, bin: null };
  if (input === null || input === undefined) return empty;
  const raw = String(input).trim();
  if (raw === '') return empty;

  const m = LOCATION_RE.exec(prepare(raw));
  if (!m) return { ...empty, locationCode: raw };

  const rack = formatRack(m[1]);
  const shelf = m[2] ?? null;
  const bin = m[3] !== undefined ? Number(m[3]) : null;

  let locationCode = rack;
  if (shelf) locationCode += `-${shelf}`;
  if (shelf && bin !== null) locationCode += `-${bin}`;
  return { locationCode, rack, shelf, bin };
}

/**
 * Build a location from separate rack / shelf / bin values (e.g. Excel columns).
 * Returns the same shape as parseLocation.
 */
export function combineLocation(rack, shelf, bin) {
  const parts = [rack, shelf, bin]
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter((v) => v !== '');
  if (parts.length === 0) return parseLocation(null);
  return parseLocation(parts.join('-'));
}
