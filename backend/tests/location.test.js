// Location coordinate parser (pure): spec "Location coordinate" section.
import { describe, it, expect } from 'vitest';
import { parseLocation, normalizeRack, combineLocation, formatRack } from '../src/lib/location.js';

const loc = (locationCode, rack, shelf, bin) => ({ locationCode, rack, shelf, bin });

describe('parseLocation - formats listed in the spec', () => {
  it.each([
    ['R03-B-2', loc('R03-B-2', 'R03', 'B', 2)],
    ['r3-b-2', loc('R03-B-2', 'R03', 'B', 2)],
    ['R3 B 2', loc('R03-B-2', 'R03', 'B', 2)],
    ['R3/B/2', loc('R03-B-2', 'R03', 'B', 2)],
    ['3-B-2', loc('R03-B-2', 'R03', 'B', 2)],
    ['R03-B', loc('R03-B', 'R03', 'B', null)],
    ['R03', loc('R03', 'R03', null, null)],
  ])('%s', (input, expected) => {
    expect(parseLocation(input)).toEqual(expected);
  });
});

describe('parseLocation - other loose formats', () => {
  it.each([
    ['  R03-B-2  ', 'R03-B-2'],
    ['r03b2', 'R03-B-2'],
    ['R3B2', 'R03-B-2'],
    ['R 3 - B - 2', 'R03-B-2'],
    ['R3.B.2', 'R03-B-2'],
    ['R3_B_2', 'R03-B-2'],
    ['R3\\B\\2', 'R03-B-2'],
    ['R3:B:2', 'R03-B-2'],
    ['R3, B, 2', 'R03-B-2'],
    ['R003-B-02', 'R03-B-2'],
    ['3/b/2', 'R03-B-2'],
    ['3 B', 'R03-B'],
    ['r3', 'R03'],
    ['3', 'R03'],
    ['R12-D-10', 'R12-D-10'],
    ['R105-A-1', 'R105-A-1'],
    ['Rack 3 Shelf B Bin 2', 'R03-B-2'],
    ['rack 3, shelf b, bin 2', 'R03-B-2'],
    ['Rak 3 B 2', 'R03-B-2'],
    ['R3 B 2', 'R03-B-2'], // non-breaking spaces (common in Excel)
  ])('%j -> %s', (input, code) => {
    expect(parseLocation(input).locationCode).toBe(code);
  });

  it('bin is a number, shelf is a single uppercase letter, rack is zero-padded to 2 digits', () => {
    const r = parseLocation('r7-c-12');
    expect(r).toEqual(loc('R07-C-12', 'R07', 'C', 12));
    expect(typeof r.bin).toBe('number');
  });

  it('accepts numeric input (e.g. an Excel number cell)', () => {
    expect(parseLocation(4)).toEqual(loc('R04', 'R04', null, null));
  });
});

describe('parseLocation - empty and garbage input', () => {
  it.each([null, undefined, '', '   '])('%j -> all null', (input) => {
    expect(parseLocation(input)).toEqual(loc(null, null, null, null));
  });

  it.each([
    'Store cupboard',
    'Top shelf near the door',
    'Box 12',
    'B-2',
    'R03-BB-2',
    'R03-1-2',
    'R3-B-2-5',
    'R1234',
    'R03-B-2 (top)',
    '???',
    'R',
    'Almari 2',
    'Rakit 3',
    '😀',
    '<script>alert(1)</script>',
  ])('%j is kept as-is with rack/shelf/bin null', (input) => {
    expect(parseLocation(input)).toEqual(loc(input, null, null, null));
  });

  it('keeps unparseable input trimmed', () => {
    expect(parseLocation('  Store cupboard ')).toEqual(loc('Store cupboard', null, null, null));
  });

  // A shelf/bin word followed by a number names no rack, so it must not become one.
  it.each(['Bin 2', 'Shelf 3', 'Level 2', 'Slot 4', 'Position 7', 'Tingkat 2', 'No. 5'])(
    '%j does not invent a rack (kept as text)',
    (input) => {
      expect(parseLocation(input)).toEqual(loc(input, null, null, null));
    }
  );
});

describe('normalizeRack / formatRack', () => {
  it.each([
    ['R03', 'R03'], ['r3', 'R03'], ['3', 'R03'], ['R003', 'R03'], ['Rack 3', 'R03'], [' r 3 ', 'R03'],
    ['12', 'R12'], [7, 'R07'], ['R-5', 'R05'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeRack(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'abc', 'R03-B', 'R', 'R1234', 'B'])('%j -> null', (input) => {
    expect(normalizeRack(input)).toBeNull();
  });

  it('formatRack zero-pads', () => {
    expect(formatRack(3)).toBe('R03');
    expect(formatRack('12')).toBe('R12');
    expect(formatRack(105)).toBe('R105');
  });
});

describe('combineLocation (separate rack/shelf/bin columns)', () => {
  it.each([
    [['R03', 'B', 2], 'R03-B-2'],
    [['3', 'b', '2'], 'R03-B-2'],
    [[3, 'B', 2], 'R03-B-2'],
    [['Rack 3', 'B', '02'], 'R03-B-2'],
    [['R03', 'B', ''], 'R03-B'],
    [['R03', '', ''], 'R03'],
    [['R03', null, undefined], 'R03'],
  ])('%j -> %s', (parts, code) => {
    expect(combineLocation(...parts).locationCode).toBe(code);
  });

  it('all blank -> null location', () => {
    expect(combineLocation('', null, undefined)).toEqual(loc(null, null, null, null));
  });

  it('nonsense parts are kept as text', () => {
    expect(combineLocation('Cupboard', 'top', '')).toEqual(loc('Cupboard-top', null, null, null));
  });
});
