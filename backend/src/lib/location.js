/**
 * Location coordinate parser (pure, no I/O).
 *
 * Canonical form: "R03-B-2" = Rack 03, Shelf B (A = top), Bin 2.
 * Accepts loose input such as "R03-B-2", "r3-b-2", "R3 B 2", "R3/B/2", "3-B-2",
 * "R03-B", "R03", "R3B2", "Rack 3 Shelf B Bin 2", "Rak 3 B 2".
 * Unparseable input is kept as-is (trimmed) with rack/shelf/bin = null.
 */

const SEP = String.raw`[\s\-\/\\._:,|]*`;
const LOCATION_RE = new RegExp(
  String.raw`^R?${SEP}0*(\d{1,3})(?:${SEP}([A-Z])(?:${SEP}0*(\d{1,4}))?)?$`
);
const RACK_RE = /^R?\s*-?\s*0*(\d{1,3})$/;

/** Words people write around the coordinates (English + Malay). */
function stripWords(s) {
  return s
    .replace(/\b(RACK|RAK|R\.)\s*/g, 'R')
    .replace(/\b(SHELF|LEVEL|TINGKAT|PARA|BIN|POSITION|POS|SLOT|PETAK|NO\.?)\b/g, ' ')
    .trim();
}

/** Zero-pad a rack number to 2 digits: 3 -> "R03", 12 -> "R12", 105 -> "R105". */
export function formatRack(num) {
  return `R${String(Number(num)).padStart(2, '0')}`;
}

/**
 * Normalize a rack identifier ("r3", "3", "R003", "Rack 3") to "R03", or null.
 */
export function normalizeRack(input) {
  if (input === null || input === undefined) return null;
  const s = stripWords(String(input).trim().toUpperCase());
  const m = RACK_RE.exec(s);
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

  const s = stripWords(raw.toUpperCase());
  const m = LOCATION_RE.exec(s);
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
