/**
 * Pre-flight check of an .xlsx (zip) buffer BEFORE handing it to ExcelJS, which loads the whole
 * workbook into memory. A 5 MB upload can expand to gigabytes (zip bomb / millions of tiny rows),
 * so we read the zip directory ourselves, inflate every entry with a hard output cap (declared
 * sizes can lie), and count rows/cells/shared strings in the worksheet XML. Memory use is bounded
 * by MAX_ENTRY_BYTES (one entry is inflated at a time and then dropped).
 */
import zlib from 'node:zlib';
import { badRequest } from './errors.js';

// ExcelJS needs roughly 0.75 KB of heap per cell, so 240k cells (20,000 rows x 12 columns) peaks
// around 190 MB. Measured: 20k x 10 cells = +156 MB RSS, 20k x 19 = +283 MB.
export const XLSX_LIMITS = {
  maxEntries: 2000,
  maxEntryBytes: 24 * 1024 * 1024, // per uncompressed zip entry
  maxTotalBytes: 48 * 1024 * 1024, // all entries together
  maxRows: 25_000, // all worksheets together
  maxCells: 240_000, // all worksheets together
  maxSharedStrings: 240_000,
};

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

// Tolerant of whitespace after the tag name and of any namespace prefix ("<row\n", "<x:row ", "<c/>").
const ROW_RE = /<(?:[\w.-]+:)?row[\s>\/]/g;
const CELL_RE = /<(?:[\w.-]+:)?c[\s>\/]/g;
const SI_RE = /<(?:[\w.-]+:)?si[\s>\/]/g;

function countTags(text, re) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

/** List zip entries from the central directory. Throws 400 if this is not a readable zip. */
export function listZipEntries(buf) {
  const invalid = () => badRequest('Could not read the Excel file. Make sure it is a valid .xlsx workbook.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid();
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw invalid(); // zip64: never needed for a 5 MB file
  if (count > XLSX_LIMITS.maxEntries) throw badRequest('The Excel file has too many parts to be a normal workbook.');
  const entries = [];
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw invalid();
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    // Normalized the way ExcelJS reads them: no leading slashes / backslashes.
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/').replace(/^\/+/, '');
    entries.push({ name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf, entry, cap) {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw badRequest('Could not read the Excel file. Make sure it is a valid .xlsx workbook.');
  }
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (data.length > cap) throw tooBig();
    return data;
  }
  if (entry.method !== 8) throw badRequest('The Excel file uses an unsupported compression method.');
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: cap });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw tooBig();
    throw badRequest('Could not read the Excel file. Make sure it is a valid .xlsx workbook.');
  }
}

const tooBig = () =>
  badRequest('The Excel file is too large once unpacked. Split it into smaller files or save it as CSV.');

/**
 * Throws a 400 HttpError if the workbook is unreadable or would be too big to load safely.
 * @returns {{ rows: number, cells: number, sharedStrings: number, bytes: number }}
 */
export function checkXlsx(buf, limits = XLSX_LIMITS) {
  const entries = listZipEntries(buf);
  const declared = entries.reduce((s, e) => s + e.size, 0);
  if (declared > limits.maxTotalBytes) throw tooBig();
  let bytes = 0;
  let rows = 0;
  let cells = 0;
  let sharedStrings = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const cap = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - bytes);
    const out = inflateEntry(buf, entry, cap);
    bytes += out.length;
    // Count in EVERY entry rather than picking worksheets by name: ExcelJS strips a leading "/" and
    // matches sheet names loosely, so a renamed entry must not escape the count. Real tags can't
    // appear in text (XML escapes "<"), so counting everywhere only adds noise from binary parts.
    const text = out.toString('latin1');
    rows += countTags(text, ROW_RE);
    cells += countTags(text, CELL_RE);
    sharedStrings += countTags(text, SI_RE);
    if (rows > limits.maxRows) {
      throw badRequest(`Too many rows in the workbook (more than ${limits.maxRows}). Split it into smaller files.`);
    }
    if (cells > limits.maxCells || sharedStrings > limits.maxSharedStrings) {
      throw badRequest('The workbook has too many cells to import. Delete unused columns/sheets or save it as CSV.');
    }
  }
  return { rows, cells, sharedStrings, bytes };
}
