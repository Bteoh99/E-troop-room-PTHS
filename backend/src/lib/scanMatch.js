/**
 * Scan matching (pure, no I/O): score items against noisy OCR text from a photo of the item's own
 * manufacturer label, and/or a decoded shop barcode.
 *
 * - Codes are compared "OCR-folded": upper-cased, O->0, I/L->1, S->5, B->8, Z->2, RN->M, and
 *   separators (- _ space . /) removed, on both sides. So "TNT-OO4", "TNT 004" and "tnt004" all find TNT-004.
 *   Codes split over several OCR words are found by joining up to 5 neighbouring words.
 * - Brand/model words of 5+ characters may differ by one edit (OCR typo).
 * - Weights: code > barcode > model > brand > name > category/notes.
 */

/** OCR noise and label boilerplate that says nothing about which item it is. */
export const STOPWORDS = new Set([
  'made', 'in', 'the', 'warning', 'kg', 'cm', 'mm', 'ml', 'and', 'for', 'with', 'of', 'to', 'by', 'use',
  'only', 'not', 'www', 'com', 'my', 'model', 'no', 'item', 'brand', 'size', 'weight', 'max', 'min',
  'china', 'malaysia', 'caution', 'keep', 'away', 'from', 'children', 'fire', 'this', 'is', 'a', 'an',
  'or', 'on', 'at', 'be', 'it', 'pcs', 'pc', 'set', 'qty', 'kod', 'buatan', 'dan', 'untuk', 'serial',
]);

export const WEIGHTS = { code: 1, barcode: 0.95, model: 0.5, brand: 0.3, name: 0.3, category: 0.08, notes: 0.08 };
/** Below this an item is not a "sensible" match. */
export const MIN_SCORE = 0.15;
export const MAX_MATCHES = 10;
/** Codes split by OCR into up to this many words ("TNT - 0 0 4") are joined back. */
const MAX_WINDOW = 5;

const OCR_MAP = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };

/** "tnt-OO4" -> "TNT004" (see module doc). */
export function ocrFold(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[\s\-_./\\]+/g, '')
    .replace(/RN/g, 'M') // OCR reads "m" as "rn" very often
    .replace(/[OILSBZ]/g, (c) => OCR_MAP[c]);
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

/** True when a and b differ by at most one insertion, deletion or substitution. */
export function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/**
 * Pre-compute what the item scoring needs from the text: tokens, folded tokens and folded
 * windows of 1-5 neighbouring raw words (so "TNT 0O4" still yields "TNT004").
 */
export function analyzeText(text) {
  const raw = words(text).slice(0, 2000);
  const windows = new Set();
  for (let i = 0; i < raw.length; i++) {
    let joined = '';
    for (let k = 0; k < MAX_WINDOW && i + k < raw.length; k++) {
      joined += raw[i + k];
      windows.add(ocrFold(joined));
    }
  }
  const tokens = tokenize(text);
  return { tokens, tokenSet: new Set(tokens), foldedTokens: new Set(tokens.map(ocrFold)), windows };
}

/** Fraction of the field's meaningful words found in the text (exact, or fuzzy for 5+ chars). */
function wordOverlap(fieldText, analysis, { fuzzy = false, fold = false } = {}) {
  const fieldTokens = tokenize(fieldText);
  if (fieldTokens.length === 0) return 0;
  let hit = 0;
  for (const t of fieldTokens) {
    const key = fold ? ocrFold(t) : t;
    const pool = fold ? analysis.foldedTokens : analysis.tokenSet;
    if (pool.has(key)) hit++;
    else if (fuzzy && key.length >= 5) {
      for (const cand of pool) {
        if (cand.length >= 4 && withinOneEdit(key, cand)) {
          hit++;
          break;
        }
      }
    }
  }
  return hit / fieldTokens.length;
}

/**
 * Score one item. Returns { score (0..1), matchedOn: string[] }.
 * @param {object} item  API Item (code, name, brand, model, barcode, category, notes)
 * @param {ReturnType<typeof analyzeText>} analysis
 */
export function scoreItem(item, analysis) {
  const matchedOn = [];
  let score = 0;

  const code = ocrFold(item.code);
  if (code.length >= 3 && analysis.windows.has(code)) {
    score += WEIGHTS.code;
    matchedOn.push('code');
  }
  if (item.barcode && analysis.windows.has(ocrFold(item.barcode))) {
    score += WEIGHTS.barcode;
    matchedOn.push('barcode');
  }
  if (item.model) {
    const whole = ocrFold(item.model);
    const frac = whole.length >= 3 && analysis.windows.has(whole) ? 1 : wordOverlap(item.model, analysis, { fuzzy: true, fold: true });
    if (frac > 0) {
      score += WEIGHTS.model * frac;
      matchedOn.push('model');
    }
  }
  if (item.brand) {
    const frac = wordOverlap(item.brand, analysis, { fuzzy: true, fold: true });
    if (frac > 0) {
      score += WEIGHTS.brand * frac;
      matchedOn.push('brand');
    }
  }
  for (const field of ['name', 'category', 'notes']) {
    const frac = item[field] ? wordOverlap(item[field], analysis) : 0;
    if (frac > 0) {
      score += WEIGHTS[field] * frac;
      matchedOn.push(field);
    }
  }
  return { score: Math.min(1, Math.round(score * 1000) / 1000), matchedOn };
}

/**
 * @param {object[]} items  all candidate Items
 * @param {{ text?: string, barcode?: string|null }} input  barcode already normalized (no spaces, upper-case)
 * @returns {{ matches: { item: object, score: number, matchedOn: string[] }[], query: { tokens: string[], barcode?: string } }}
 */
export function matchItems(items, { text = '', barcode = null } = {}) {
  const analysis = analyzeText(text);
  const query = { tokens: analysis.tokens, ...(barcode ? { barcode } : {}) };

  if (barcode) {
    const exact = items.find((it) => it.barcode && it.barcode === barcode);
    if (exact) return { matches: [{ item: exact, score: 1, matchedOn: ['barcode'] }], query };
    // A shop barcode may also have been used as the troop's own item code.
    const folded = ocrFold(barcode);
    const byCode = items.find((it) => ocrFold(it.code) === folded);
    if (byCode) return { matches: [{ item: byCode, score: 1, matchedOn: ['code'] }], query };
  }
  if (analysis.windows.size === 0) return { matches: [], query };

  const matches = [];
  for (const item of items) {
    const { score, matchedOn } = scoreItem(item, analysis);
    if (score >= MIN_SCORE) matches.push({ item, score, matchedOn });
  }
  matches.sort((a, b) => b.score - a.score || a.item.code.localeCompare(b.item.code));
  return { matches: matches.slice(0, MAX_MATCHES), query };
}
