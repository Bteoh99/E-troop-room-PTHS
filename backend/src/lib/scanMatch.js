/**
 * Scan matching (pure, no I/O): score items against noisy OCR text from a photo of the item's own
 * manufacturer label, and/or a decoded shop barcode.
 *
 * Codes
 * - Compared "OCR-folded": upper-cased, separators (- _ space . / \) removed, RN->M, O->0, I/L->1,
 *   S->5, B->8, Z->2 — on both sides. So "TNT-OO4", "TNT 004", "tnt004" and "T N T - 0 0 4" all find TNT-004.
 * - A code counts only on exact equality with ONE OCR word, or with neighbouring words joined back
 *   together (joined up to the length of the longest code/barcode in the inventory).
 * - "Weak" codes — digits only, letters only, or shorter than 4 folded characters — are easily hit by
 *   label noise ("220-240V", "2024", "OIL"->"011"). They only count on a whole single word of the same
 *   kind (a digit code needs a word with digits; a letter code the same word, unfolded), and only with
 *   a low weight, so they can never outrank a real match.
 * Barcodes compare with leading zeros ignored (a UPC that lost its leading 0 in Excel still matches).
 * Brand/model words of 5+ characters may differ by one edit (Damerau: a swap of two neighbours counts 1).
 * Compartment labels: text containing a location such as "AU0305" / "AU 0305" matches every item in
 * that compartment with score 1 (matchedOn: ["location"]).
 * Weights: location = code > barcode > model (exact whole model gets a bonus) > brand > name > category/notes.
 */

/** OCR noise and label boilerplate that says nothing about which item it is. */
export const STOPWORDS = new Set([
  'made', 'in', 'the', 'warning', 'kg', 'cm', 'mm', 'ml', 'and', 'for', 'with', 'of', 'to', 'by', 'use',
  'only', 'not', 'www', 'com', 'my', 'model', 'no', 'item', 'brand', 'size', 'weight', 'max', 'min',
  'china', 'malaysia', 'caution', 'keep', 'away', 'from', 'children', 'fire', 'this', 'is', 'a', 'an',
  'or', 'on', 'at', 'be', 'it', 'pcs', 'pc', 'set', 'qty', 'kod', 'buatan', 'dan', 'untuk', 'serial',
]);

export const WEIGHTS = {
  location: 1, code: 1, weakCode: 0.35, barcode: 0.95, model: 0.5, exactModel: 0.1, brand: 0.3, name: 0.3, category: 0.08, notes: 0.08,
};
/** Below this an item is not a "sensible" match. */
export const MIN_SCORE = 0.15;
export const MAX_MATCHES = 10;
/** OCR text beyond this is ignored (the route truncates instead of rejecting). */
export const MAX_TEXT = 2000;
/** Joined-word windows never grow beyond this many folded characters. */
const MAX_JOIN = 64;

const OCR_MAP = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };

/** "tnt-OO4" -> "TNT004" (see module doc). */
export function ocrFold(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[\s\-_./\\]+/g, '')
    .replace(/RN/g, 'M') // OCR reads "m" as "rn" very often
    .replace(/[OILSBZ]/g, (c) => OCR_MAP[c]);
}

/** Barcode comparison key: upper-case, no whitespace, leading zeros ignored ("0012" ~ "12"). */
export function barcodeKey(s) {
  const t = String(s ?? '').replace(/\s+/g, '').toUpperCase();
  return t.replace(/^0+(?=.)/, '');
}

/** Words of letters/digits, lower-cased. Keeps short words (needed to rebuild split codes). */
export function words(text) {
  return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Meaningful search tokens: >= 2 chars, not a stopword, de-duplicated, at most 200. */
export function tokenize(text) {
  const out = [];
  const seen = new Set();
  for (const w of words(text)) {
    if (w.length < 2 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 200) break;
  }
  return out;
}

/**
 * True when a and b differ by at most one edit: insertion, deletion, substitution, or a swap of two
 * neighbouring characters (optimal string alignment / Damerau, so "peztl" ~ "petzl").
 */
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let i = 0;
    while (i < la && a[i] === b[i]) i++;
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one substitution
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1); // one insertion/deletion
}

const hasDigit = (s) => /\d/.test(s);
const hasLetter = (s) => /\p{L}/u.test(s);

/** Pre-compute everything matching needs from the inventory (cache this; rebuild after writes). */
export function buildScanIndex(items) {
  let maxLen = 0;
  const entries = items.map((item) => {
    const code = ocrFold(item.code);
    const raw = String(item.code ?? '').replace(/[\s\-_./\\]+/g, '');
    const weak = code.length < 4 || !hasDigit(raw) || !hasLetter(raw);
    const bc = item.barcode ? ocrFold(barcodeKey(item.barcode)).replace(/^0+(?=.)/, '') : null;
    maxLen = Math.max(maxLen, code.length, bc ? item.barcode.length : 0);
    return {
      item,
      location: item.level !== null && item.level !== undefined && item.compartment !== null && item.compartment !== undefined
        ? item.locationCode : null,
      code,
      weak,
      codeKind: weak ? (!hasLetter(raw) ? 'digits' : !hasDigit(raw) ? 'letters' : 'short') : 'strong',
      codeLower: raw.toLowerCase(),
      barcode: bc && bc.length >= 6 ? bc : null,
      modelWhole: item.model ? ocrFold(item.model) : null,
      // every word counts for brand/model (also short ones like the "4" in "Sundome 4"), so a
      // partial model never ties with an exact one
      model: item.model ? [...new Set(words(item.model).map(ocrFold))] : [],
      brand: item.brand ? [...new Set(words(item.brand).map(ocrFold))] : [],
      name: item.name ? tokenize(item.name) : [],
      category: item.category ? tokenize(item.category) : [],
      notes: item.notes ? tokenize(item.notes) : [],
    };
  });
  return { entries, maxLen: Math.min(Math.max(maxLen, 4), MAX_JOIN) };
}

/**
 * Analyse OCR text once per request.
 * - singles: each word (folded) and its raw lower-case form
 * - joined: neighbouring words joined back (2+ words), folded, up to maxLen characters
 */
export function analyzeText(text, maxLen = 20) {
  const raw = words(String(text ?? '').slice(0, MAX_TEXT));
  const singles = new Set(raw.map(ocrFold));
  const rawSet = new Set(raw);
  const digitWords = new Set(raw.filter(hasDigit).map(ocrFold));
  const joined = new Set();
  for (let i = 0; i < raw.length; i++) {
    let s = ocrFold(raw[i]);
    for (let j = i + 1; j < raw.length; j++) {
      s += ocrFold(raw[j]);
      if (s.length > maxLen) break;
      joined.add(s);
    }
  }
  const zeroless = (set) => new Set([...set].map((w) => w.replace(/^0+(?=.)/, '')));
  // Compartment labels ("AU0305", "AU 0305", "AU-03-05"); OCR often reads 0 as O.
  const locations = new Set();
  const upper = String(text ?? '').slice(0, MAX_TEXT).toUpperCase();
  for (const m of upper.matchAll(/(?<![A-Z0-9])([A-Z]{1,3})[\s-]?([0-9O]{2})[\s-]?([0-9O]{2})(?![0-9])/g)) {
    locations.add(`${m[1]}${m[2]}${m[3]}`.replace(/(?<=^[A-Z]{1,3}.*)O/g, '0'));
  }
  const tokens = tokenize(raw.join(' '));
  return {
    tokens,
    tokenSet: new Set(tokens),
    foldedTokens: new Set(tokens.map(ocrFold)),
    singles,
    rawSet,
    digitWords,
    joined,
    barcodeWindows: zeroless(new Set([...singles, ...joined])),
    locations,
    empty: raw.length === 0,
  };
}

/**
 * Fraction of the field's words found in the text: exact (in `pool`), or for 5+ characters one edit
 * away from a word in `fuzzyPool` (the <= 200 meaningful tokens, so this stays fast).
 */
function overlap(fieldTokens, pool, fuzzyPool = null) {
  if (fieldTokens.length === 0) return 0;
  let hit = 0;
  let longHit = false; // 1-character words (the "4" in "Sundome 4") only count next to a real word
  for (const key of fieldTokens) {
    let found = pool.has(key);
    if (!found && fuzzyPool && key.length >= 5) {
      for (const cand of fuzzyPool) {
        if (cand.length >= 4 && withinOneEdit(key, cand)) {
          found = true;
          break;
        }
      }
    }
    if (found) {
      hit++;
      if (key.length >= 2) longHit = true;
    }
  }
  return longHit ? hit / fieldTokens.length : 0;
}

function codeMatch(e, a) {
  if (!e.code) return 0;
  if (!e.weak) return a.singles.has(e.code) || a.joined.has(e.code) ? WEIGHTS.code : 0;
  // Weak codes: one whole word of the same kind only.
  if (e.codeKind === 'letters') return e.codeLower.length >= 2 && a.rawSet.has(e.codeLower) ? WEIGHTS.weakCode : 0;
  return a.digitWords.has(e.code) ? WEIGHTS.weakCode : 0;
}

/**
 * Score one index entry. Returns { score (0..1), matchedOn: string[] }.
 * @param {ReturnType<typeof buildScanIndex>['entries'][number]} e
 * @param {ReturnType<typeof analyzeText>} a
 */
export function scoreEntry(e, a) {
  const matchedOn = [];
  let score = 0;
  const add = (field, value) => {
    if (value > 0) {
      score += value;
      matchedOn.push(field);
    }
  };
  // A photographed compartment label: every item in that compartment.
  if (e.location) add('location', a.locations.has(e.location) ? WEIGHTS.location : 0);
  add('code', codeMatch(e, a));
  if (e.barcode) add('barcode', a.barcodeWindows.has(e.barcode) ? WEIGHTS.barcode : 0);
  if (e.modelWhole) {
    // The whole model, exactly (folded), beats a partial match: "Sundome 4P" > "Sundome 4" for "SUNDOME 4P".
    const whole = e.modelWhole.length >= 4 && (a.singles.has(e.modelWhole) || a.joined.has(e.modelWhole));
    add('model', whole ? WEIGHTS.model + WEIGHTS.exactModel : WEIGHTS.model * overlap(e.model, a.singles, a.foldedTokens));
  }
  add('brand', WEIGHTS.brand * overlap(e.brand, a.singles, a.foldedTokens));
  add('name', WEIGHTS.name * overlap(e.name, a.tokenSet));
  add('category', WEIGHTS.category * overlap(e.category, a.tokenSet));
  add('notes', WEIGHTS.notes * overlap(e.notes, a.tokenSet));
  return { score: Math.min(1, Math.round(score * 1000) / 1000), matchedOn };
}

/** Back-compat helper: score a single Item. */
export function scoreItem(item, text) {
  const index = buildScanIndex([item]);
  return scoreEntry(index.entries[0], analyzeText(text, index.maxLen));
}

/**
 * @param {object[] | ReturnType<typeof buildScanIndex>} itemsOrIndex  Items, or a prebuilt index
 * @param {{ text?: string, barcode?: string|null }} input  barcode: no spaces, upper-case
 * @returns {{ matches: { item: object, score: number, matchedOn: string[] }[], query: { tokens: string[], barcode?: string } }}
 */
export function matchItems(itemsOrIndex, { text = '', barcode = null } = {}) {
  const index = Array.isArray(itemsOrIndex) ? buildScanIndex(itemsOrIndex) : itemsOrIndex;
  const a = analyzeText(text, index.maxLen);
  const query = { tokens: a.tokens, ...(barcode ? { barcode } : {}) };

  if (barcode) {
    const key = barcodeKey(barcode);
    const exact = index.entries.find((e) => e.item.barcode && barcodeKey(e.item.barcode) === key);
    if (exact) return { matches: [{ item: exact.item, score: 1, matchedOn: ['barcode'] }], query };
    // A shop barcode may also have been used as the troop's own item code.
    const folded = ocrFold(barcode);
    const byCode = index.entries.find((e) => e.code && e.code === folded);
    if (byCode) return { matches: [{ item: byCode.item, score: 1, matchedOn: ['code'] }], query };
  }
  if (a.empty) return { matches: [], query };

  const matches = [];
  for (const e of index.entries) {
    const { score, matchedOn } = scoreEntry(e, a);
    if (score >= MIN_SCORE) matches.push({ item: e.item, score, matchedOn });
  }
  const tie = (it) => `${it.code ?? ''}\u0000${it.locationCode ?? ''}\u0000${it.name ?? ''}`;
  matches.sort((x, y) => y.score - x.score || y.matchedOn.length - x.matchedOn.length || tie(x.item).localeCompare(tie(y.item)));
  return { matches: matches.slice(0, MAX_MATCHES), query };
}
