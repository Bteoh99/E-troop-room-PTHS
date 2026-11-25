/**
 * Small RFC 4180-style CSV parser (pure). Handles quoted fields, "" escapes, CRLF/LF,
 * a UTF-8 BOM and auto-detects the delimiter (comma, semicolon or tab), since Excel
 * in some locales saves "CSV" with semicolons.
 */

/** Decode bytes as UTF-8, falling back to Windows-1252/Latin-1 for legacy Excel CSV exports. */
export function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

export function detectDelimiter(text) {
  const firstLines = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 5);
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestScore = 0;
  for (const d of candidates) {
    let score = 0;
    for (const line of firstLines) {
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === d && !inQuotes) score++;
      }
    }
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/**
 * @param {string} text
 * @param {string} [delimiter] auto-detected when omitted
 * @param {{ maxRows?: number, maxCells?: number }} [limits] stop early (throws a RangeError) on huge input
 * @returns {string[][]} rows of cells (row i = line i+1 of the file, counting quoted newlines as one record)
 */
export function parseCsv(text, delimiter, { maxRows = Infinity, maxCells = Infinity } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter ?? detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let cells = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field);
      field = '';
      if (++cells > maxCells) throw new RangeError('CSV_TOO_MANY_CELLS');
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      if (rows.length > maxRows) throw new RangeError('CSV_TOO_MANY_ROWS');
      if (++cells > maxCells) throw new RangeError('CSV_TOO_MANY_CELLS');
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
