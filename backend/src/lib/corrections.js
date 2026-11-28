/**
 * Import tidy-up and spelling corrections (pure).
 *
 * - Tidy (never reported): trim, collapse runs of spaces, capitalise the first letter of names.
 * - Corrections (reported to the user): known typos from the quartermaster's lists, fixed as whole
 *   words/phrases, case-insensitively. Add new ones to CORRECTIONS: [wrong, right].
 */

export const CORRECTIONS = [
  ['repenllent', 'repellent'],
  ['fox nad spoon', 'fork and spoon'],
  ['bid ladle', 'big ladle'],
  ['safety vase', 'safety vest'],
  ['bax', 'box'],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(list) {
  return list.map(([from, to]) => ({
    re: new RegExp(`(?<![\\p{L}\\p{N}])${from.trim().split(/\s+/).map(escapeRe).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu'),
    to,
  }));
}
const DEFAULT_RULES = compile(CORRECTIONS);

/** Keep the case style of what was matched: "BAX" -> "BOX", "Bax" -> "Box", "bax" -> "box". */
function matchCase(found, replacement) {
  if (found === found.toUpperCase() && found !== found.toLowerCase()) return replacement.toUpperCase();
  if (found[0] === found[0].toUpperCase() && found[0] !== found[0].toLowerCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

/** Trim and collapse whitespace. */
export const tidySpaces = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

export const capitaliseFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Apply the corrections to a text (after tidying spaces).
 * @returns {{ text: string, corrected: boolean }}
 */
export function applyCorrections(text, rules = DEFAULT_RULES) {
  const tidy = tidySpaces(text);
  let out = tidy;
  for (const { re, to } of rules) out = out.replace(re, (m) => matchCase(m, to));
  return { text: out, corrected: out !== tidy };
}

/**
 * Tidy + correct one cell. `correction` is { from, to } when a spelling fix happened (tidy-only changes
 * such as spaces or capitalisation are not corrections). `value` is what gets stored.
 */
export function cleanCell(raw, { capitalise = false, keepLines = false, rules = DEFAULT_RULES } = {}) {
  // keepLines (notes): keep line breaks, only trim; otherwise collapse all whitespace.
  const original = keepLines ? String(raw ?? '').replace(/\u00a0/g, ' ').trim() : tidySpaces(raw);
  let text = original;
  for (const { re, to } of rules) text = text.replace(re, (m) => matchCase(m, to));
  const corrected = text !== original;
  const value = capitalise ? capitaliseFirst(text) : text;
  return { value, correction: corrected ? { from: String(raw ?? '').trim(), to: text } : null };
}
