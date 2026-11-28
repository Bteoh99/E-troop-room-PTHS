/**
 * Location parser (pure, no I/O). Two schemes, one result shape:
 *
 *   { locationCode, rack, level, compartment, shelf, bin }
 *
 * v2 (the troop's real format, Phase 1.6): "AU0305" = rack AU, level 03 (level 01 is the BOTTOM),
 *   compartment 05. Rack ids are 1-3 letters. Loose input: "au0305", "AU 0305", "AU 03 05", "AU-3-5",
 *   "AU/03/05", "Rack AU level 3 compartment 5". Partial: "AU03" (rack + level, two digits, compact),
 *   "AU" / "Rack AU" (rack only; bare letters must be typed in capitals so words like "box" stay text).
 *   -> rack "AU", level 3, compartment 5, shelf/bin null. Level and compartment must be >= 1.
 * legacy (Phase 1): "R03-B-2" = rack R03, shelf B (A = top), bin 2. Loose input as before
 *   ("r3-b-2", "R3 B 2", "3-B-2", "Rack 3 Shelf B Bin 2", ...). -> rack "R03", shelf "B", bin 2, level/compartment null.
 *
 * Order: v2 full codes first (ambiguity rule: letters + 4 digits is always v2, e.g. "R1234"), then
 * legacy, then v2 partial. Unparseable text is kept as-is (trimmed) with everything else null.
 */

const SEP = String.raw`[\s\-\/\\._:,|#]*`;
const RACK_PART = String.raw`(?:(?:RACK|RAK|R)${SEP}(?:NO\.?${SEP})?)?0*(\d{1,3})`;
const SHELF_WORD = String.raw`(?:SHELF|LEVEL|TINGKAT|PARA)`;
const BIN_WORD = String.raw`(?:BIN|POSITION|POS|SLOT|PETAK|NO\.?)`;
const LEGACY_RE = new RegExp(
  String.raw`^${RACK_PART}(?:${SEP}(?:${SHELF_WORD}${SEP})?([A-Z])(?:${SEP}(?:${BIN_WORD}${SEP})?0*(\d{1,4}))?)?$`
);
const LEGACY_RACK_RE = new RegExp(String.raw`^${RACK_PART}$`);

const V2_SEP = String.raw`[\s\-\/\\._:,|#]`;
const RACK_WORD = String.raw`(?:(?:RACK|RAK)\s+)?`;
/** "AU0305", "AU 0305", "Rack AU 0305" */
const V2_COMPACT_RE = new RegExp(String.raw`^${RACK_WORD}([A-Z]{1,3})${V2_SEP}*(\d{2})(\d{2})$`);
/** "AU 03 05", "AU-3-5", "AU/03/05", "Rack AU level 3 compartment 5" */
const V2_SPLIT_RE = new RegExp(
  String.raw`^${RACK_WORD}([A-Z]{1,3})${V2_SEP}*(?:(?:LEVEL|LVL|TINGKAT|ARAS)\s*)?(\d{1,2})` +
    String.raw`(?:${V2_SEP}+(?:(?:COMPARTMENT|COMP|PETAK|BOX)\s*)?|\s*(?:COMPARTMENT|COMP|PETAK)\s*)(\d{1,2})$`
);
/** "AU03" (compact only) */
const V2_LEVEL_RE = /^([A-Z]{1,3})(\d{2})$/;
/** "Rack AU" */
const V2_RACK_WORD_RE = /^(?:RACK|RAK)\s+([A-Z]{1,3})$/;
/** Bare rack id: must already be capitals in the original text ("AU", not "box"). */
const V2_RACK_BARE_RE = /^[A-Z]{2,3}$/;

/** Hyphen look-alikes that AutoCorrect / copy-paste produce: ‐ ‑ ‒ – — ― − ﹘ ﹣ － */
const DASHES = /[‐-―−﹘﹣－]/g;

function prepare(input) {
  return String(input).replace(DASHES, '-').replace(/\s+/g, ' ').trim().toUpperCase();
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Zero-pad a legacy rack number to 2 digits: 3 -> "R03", 12 -> "R12", 105 -> "R105". */
export function formatRack(num) {
  return `R${String(Number(num)).padStart(2, '0')}`;
}

/** v2 code from parts: ("AU", 3, 5) -> "AU0305"; ("AU", 3) -> "AU03"; ("AU") -> "AU". */
export function formatV2(rack, level = null, compartment = null) {
  let code = rack;
  if (level !== null && level !== undefined) code += pad2(level);
  if (level !== null && level !== undefined && compartment !== null && compartment !== undefined) code += pad2(compartment);
  return code;
}

const result = (locationCode, rack = null, { level = null, compartment = null, shelf = null, bin = null } = {}) => ({
  locationCode, rack, level, compartment, shelf, bin,
});

function v2(rack, level, compartment) {
  if (level !== null && level < 1) return null;
  if (compartment !== null && compartment < 1) return null;
  return result(formatV2(rack, level, compartment), rack, { level, compartment });
}

/** Parse only the v2 forms (no legacy, no fallback). Returns null if not v2. */
export function parseV2(input, { allowBareRack = false } = {}) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  const s = prepare(raw);
  let m = V2_COMPACT_RE.exec(s) || V2_SPLIT_RE.exec(s);
  if (m) return v2(m[1], Number(m[2]), Number(m[3]));
  if ((m = V2_LEVEL_RE.exec(s))) return v2(m[1], Number(m[2]), null);
  if ((m = V2_RACK_WORD_RE.exec(s))) return v2(m[1], null, null);
  if (V2_RACK_BARE_RE.test(s) && (allowBareRack || /^[A-Z]{2,3}$/.test(raw))) return v2(s, null, null);
  return null;
}

function parseLegacy(s) {
  const m = LEGACY_RE.exec(s);
  if (!m) return null;
  const rack = formatRack(m[1]);
  const shelf = m[2] ?? null;
  const bin = m[3] !== undefined ? Number(m[3]) : null;
  let locationCode = rack;
  if (shelf) locationCode += `-${shelf}`;
  if (shelf && bin !== null) locationCode += `-${bin}`;
  return result(locationCode, rack, { shelf, bin });
}

/**
 * @param {unknown} input
 * @param {{ allowBareRack?: boolean }} [opts] allowBareRack: lower-case "au" also means rack AU (search)
 * @returns {{ locationCode: string|null, rack: string|null, level: number|null, compartment: number|null,
 *   shelf: string|null, bin: number|null }}
 */
export function parseLocation(input, opts = {}) {
  if (input === null || input === undefined) return result(null);
  const raw = String(input).trim();
  if (raw === '') return result(null);
  const s = prepare(raw);

  const full = V2_COMPACT_RE.exec(s) || V2_SPLIT_RE.exec(s);
  if (full) {
    const r = v2(full[1], Number(full[2]), Number(full[3]));
    if (r) return r;
  }
  const legacy = parseLegacy(s);
  if (legacy) return legacy;
  const partial = parseV2(raw, opts);
  if (partial) return partial;
  return result(raw);
}

/** True for a complete v2 compartment code ("AU0305"). */
export const isCompartmentCode = (loc) => Boolean(loc?.rack && loc.level !== null && loc.compartment !== null);

/**
 * Normalize a rack id: legacy "r3", "3", "R003", "Rack 3" -> "R03"; v2 "AU", "au", "Rack AU" -> "AU".
 * Anything else (a full location, garbage) -> null.
 */
export function normalizeRack(input) {
  if (input === null || input === undefined) return null;
  const s = prepare(input);
  const m = LEGACY_RACK_RE.exec(s);
  if (m) return formatRack(m[1]);
  const w = V2_RACK_WORD_RE.exec(s);
  if (w) return w[1];
  return /^[A-Z]{1,3}$/.test(s) ? s : null;
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

/** "Rack AU · Level 3 · Compartment 05" / "Rack R03 · Shelf B · Bin 2" (for messages). */
export function describeLocation(loc) {
  if (!loc?.rack) return loc?.locationCode ?? '';
  const parts = [`Rack ${loc.rack}`];
  if (loc.level !== null) parts.push(`Level ${loc.level}`);
  if (loc.compartment !== null) parts.push(`Compartment ${pad2(loc.compartment)}`);
  if (loc.shelf) parts.push(`Shelf ${loc.shelf}`);
  if (loc.bin !== null) parts.push(`Bin ${loc.bin}`);
  return parts.join(' · ');
}
