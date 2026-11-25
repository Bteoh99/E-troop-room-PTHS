/**
 * Location parser — mirrors the rules in docs/SPEC.md ("Location coordinate").
 * The backend is the source of truth; this is used for the live preview in the form
 * and for normalising rack route params.
 *
 * Accepts loose input such as `R03-B-2`, `r3-b-2`, `R3 B 2`, `R3/B/2`, `3-B-2`,
 * `R03-B` (no bin) and `R03` (rack only) and normalises to `R03-B-2`.
 * Like the backend it also tolerates "R3B2", "Rack 3 Shelf B Bin 2" and "Rak 3 B 2".
 * Input that cannot be parsed is kept as typed (trimmed) with rack/shelf/bin = null.
 */
export interface ParsedLocation {
  /** Canonical code (e.g. "R03-B-2"), the raw trimmed text if unparseable, or null if empty. */
  locationCode: string | null;
  rack: string | null;
  shelf: string | null;
  bin: number | null;
  /** True when the input matched the coordinate pattern. */
  parsed: boolean;
}

const SEP = String.raw`[\s\-/\\._:,|]*`;
const PATTERN = new RegExp(String.raw`^R?${SEP}0*(\d{1,3})(?:${SEP}([A-Z])(?:${SEP}0*(\d{1,4}))?)?$`);
const RACK_PATTERN = /^R?\s*-?\s*0*(\d{1,3})$/;

/** Strip words people write around coordinates (English + Malay), e.g. "Rack 3 Shelf B Bin 2". */
function stripWords(s: string): string {
  return s
    .replace(/\b(RACK|RAK|R\.)\s*/g, 'R')
    .replace(/\b(SHELF|LEVEL|TINGKAT|PARA|BIN|POSITION|POS|SLOT|PETAK|NO\.?)\b/g, ' ')
    .trim();
}

export function formatRack(rackNumber: number | string): string {
  return `R${String(Number(rackNumber)).padStart(2, '0')}`;
}

export function parseLocation(input: string | null | undefined): ParsedLocation {
  const raw = (input ?? '').trim();
  if (raw === '') {
    return { locationCode: null, rack: null, shelf: null, bin: null, parsed: false };
  }

  const match = PATTERN.exec(stripWords(raw.toUpperCase()));
  if (!match) {
    return { locationCode: raw, rack: null, shelf: null, bin: null, parsed: false };
  }

  const [, rackDigits, shelf, binDigits] = match;
  const rack = formatRack(rackDigits ?? '0');
  const shelfLetter = shelf ?? null;
  const bin = binDigits !== undefined ? Number(binDigits) : null;

  let locationCode = rack;
  if (shelfLetter) locationCode += `-${shelfLetter}`;
  if (shelfLetter && bin !== null) locationCode += `-${bin}`;

  return { locationCode, rack, shelf: shelfLetter, bin, parsed: true };
}

/** Normalise a rack identifier like "r3" / "3" / "R03" / "Rack 3" to "R03". Returns null if not a rack. */
export function normalizeRack(input: string): string | null {
  const m = RACK_PATTERN.exec(stripWords(input.trim().toUpperCase()));
  return m ? formatRack(m[1] ?? '0') : null;
}

/** Human-friendly description, e.g. "Rack 03 · Shelf B · Bin 2". */
export function describeLocation(loc: { rack: string | null; shelf: string | null; bin: number | null }): string | null {
  if (!loc.rack) return null;
  const parts = [`Rack ${loc.rack.replace(/^R/, '')}`];
  if (loc.shelf) parts.push(`Shelf ${loc.shelf}`);
  if (loc.bin !== null) parts.push(`Bin ${loc.bin}`);
  return parts.join(' · ');
}

/** Shelf letters from A up to and including `last` (e.g. "C" -> ["A","B","C"]). */
export function shelfRange(last: string): string[] {
  const end = last.toUpperCase().charCodeAt(0);
  const start = 'A'.charCodeAt(0);
  if (Number.isNaN(end) || end < start || end > 'Z'.charCodeAt(0)) return [];
  const out: string[] = [];
  for (let c = start; c <= end; c++) out.push(String.fromCharCode(c));
  return out;
}
