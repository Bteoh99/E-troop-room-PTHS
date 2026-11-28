// Pure helpers used by the importer: condition mapping, header aliases, CSV parser, quantity parser.
import { describe, it, expect } from 'vitest';
import { mapCondition } from '../src/lib/condition.js';
import { mapHeaders, findHeaderRow, normalizeHeader } from '../src/lib/headers.js';
import { parseCsv, detectDelimiter, decodeText } from '../src/lib/csv.js';
import { parseQuantity, cellText, buildImportPlan } from '../src/lib/importRows.js';

describe('mapCondition', () => {
  it.each([
    ['good', 'good'], ['Good', 'good'], ['GOOD', 'good'], ['baik', 'good'], ['Baik', 'good'], ['ok', 'good'], ['OK', 'good'],
    ['repair', 'needs_repair'], ['needs repair', 'needs_repair'], ['Needs Repair', 'needs_repair'],
    ['needs_repair', 'needs_repair'], ['needs-repair', 'needs_repair'], ['rosak sikit', 'needs_repair'], ['Rosak  Sikit', 'needs_repair'],
    ['damaged', 'damaged'], ['Damaged', 'damaged'], ['rosak', 'damaged'], ['ROSAK', 'damaged'],
    ['written off', 'written_off'], ['written_off', 'written_off'], ['Written-Off', 'written_off'], ['lupus', 'written_off'], ['LUPUS', 'written_off'],
    ['  good  ', 'good'],
  ])('%j -> %s (recognized)', (input, expected) => {
    expect(mapCondition(input)).toEqual({ condition: expected, recognized: true });
  });

  it.each([null, undefined, '', '  '])('blank %j -> good, recognized', (input) => {
    expect(mapCondition(input)).toEqual({ condition: 'good', recognized: true });
  });

  it.each(['excellent', 'meh', '???', '5'])('unknown %j -> good, not recognized', (input) => {
    expect(mapCondition(input)).toEqual({ condition: 'good', recognized: false });
  });
});

describe('header aliases', () => {
  const cases = {
    code: ['code', 'Item Code', 'itemcode', 'ITEM_CODE', 'Kod', 'kod item', 'ID', 'Code:'],
    name: ['name', 'Item', 'Item Name', 'Nama', 'nama item', 'Description', 'NAME '],
    location: ['location', 'Coordinate', 'coordinates', 'Koordinat', 'Lokasi', 'Rack Location'],
    category: ['category', 'Kategori', 'Type'],
    quantity: ['qty', 'Qty.', 'Quantity', 'Kuantiti', 'Jumlah'],
    unit: ['unit', 'Unit'],
    condition: ['condition', 'Keadaan'],
    notes: ['notes', 'Remarks', 'Catatan'],
    rack: ['rack', 'Rack'],
    shelf: ['shelf', 'Shelf'],
    bin: ['bin', 'Bin'],
  };
  for (const [field, aliases] of Object.entries(cases)) {
    it.each(aliases)(`%j -> ${field}`, (alias) => {
      expect(mapHeaders([alias]).mapping).toEqual({ [field]: 0 });
    });
  }

  it('normalizeHeader is case/space/punctuation-insensitive', () => {
    expect(normalizeHeader(' Item  Code: ')).toBe('itemcode');
    expect(normalizeHeader(null)).toBe('');
  });

  it('maps a full Malay header row and lists unknown headers', () => {
    const { mapping, unmapped } = mapHeaders(['Bil', 'Kod', 'Nama', 'Kategori', 'Lokasi', 'Kuantiti', 'Keadaan', 'Catatan', '', null]);
    expect(mapping).toEqual({ code: 1, name: 2, category: 3, location: 4, quantity: 5, condition: 6, notes: 7 });
    expect(unmapped).toEqual(['Bil']);
  });

  it('prefers "Code" over "ID" and "Name" over "Description" when both exist', () => {
    const { mapping } = mapHeaders(['ID', 'Description', 'Name', 'Code']);
    expect(mapping.code).toBe(3);
    expect(mapping.name).toBe(2);
  });

  it('findHeaderRow skips title rows', () => {
    const rows = [['Troop inventory 2026'], [], ['Code', 'Name', 'Location'], ['A', 'B', 'R1']];
    const h = findHeaderRow(rows);
    expect(h.headerIndex).toBe(2);
    expect(h.mapping).toEqual({ code: 0, name: 1, location: 2 });
  });

  it('findHeaderRow returns null when nothing is recognised', () => {
    expect(findHeaderRow([['foo', 'bar'], ['1', '2']])).toBeNull();
  });
});

describe('CSV parser', () => {
  it('parses quoted fields with delimiters, escaped quotes and newlines', () => {
    const text = 'code,name,notes\r\nA1,"Tent, 4-man","He said ""hi""\nsecond line"\r\nA2,Rope,\r\n';
    expect(parseCsv(text)).toEqual([
      ['code', 'name', 'notes'],
      ['A1', 'Tent, 4-man', 'He said "hi"\nsecond line'],
      ['A2', 'Rope', ''],
    ]);
  });

  it('strips a UTF-8 BOM', () => {
    expect(parseCsv('﻿code,name\nA,B')).toEqual([['code', 'name'], ['A', 'B']]);
  });

  it('detects ; and tab delimiters', () => {
    expect(detectDelimiter('code;name;qty\nA;B;1')).toBe(';');
    expect(detectDelimiter('code\tname\nA\tB')).toBe('\t');
    expect(detectDelimiter('code,name\nA,B')).toBe(',');
    expect(parseCsv('code;name\nA;"x;y"')).toEqual([['code', 'name'], ['A', 'x;y']]);
  });

  it('keeps blank lines as rows so row numbers match the file', () => {
    expect(parseCsv('a,b\n\nc,d\n')).toEqual([['a', 'b'], [''], ['c', 'd']]);
  });

  it('decodes UTF-8, falls back to Windows-1252', () => {
    expect(decodeText(Buffer.from('Café', 'utf8'))).toBe('Café');
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
  });
});

describe('parseQuantity / cellText', () => {
  it.each([
    [10, { quantity: 10 }], [0, { quantity: 0 }], ['10', { quantity: 10 }], [' 7 ', { quantity: 7 }],
    ['1,000', { quantity: 1000 }], ['5 pcs', { quantity: 5, unit: 'pcs' }], ['12 sets', { quantity: 12, unit: 'sets' }],
  ])('%j -> %j', (input, expected) => {
    expect(parseQuantity(input)).toEqual(expected);
  });

  it.each([-1, 1.5, '-3', '1.5', 'abc', 'many', '', 'pcs 5'])('%j -> null', (input) => {
    expect(parseQuantity(input)).toBeNull();
  });

  it('cellText flattens values', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(12)).toBe('12');
    expect(cellText('  x  ')).toBe('x');
    expect(cellText(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
  });
});

describe('buildImportPlan (pure)', () => {
  const rows = (arr) => arr.map((cells, i) => ({ rowNumber: i + 1, cells }));

  it('throws 400 with details when code/name columns are missing', () => {
    try {
      // Phase 1.6: only a name column is required (codes are optional)
      buildImportPlan(rows([['Foo', 'Code'], ['1', 'x']]));
      expect.unreachable();
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.details.missingColumns).toEqual(['name']);
      expect(err.details.headersFound).toEqual(['Foo', 'Code']);
    }
  });

  it('only includes fields whose column exists', () => {
    const plan = buildImportPlan(rows([['Code', 'Name'], ['a1', 'Tent']]));
    expect(plan.records.map(({ row, data }) => ({ row, data }))).toEqual([{ row: 2, data: { code: 'A1', name: 'Tent' } }]); // records carry more planning info since 1.6
  });
});
