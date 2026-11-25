import { describe, expect, it } from 'vitest';
import { normalizeRack, parseLocation } from '../src/lib/location';

describe('parseLocation (mirrors SPEC location rules)', () => {
  it.each([
    ['R03-B-2', 'R03-B-2', 'R03', 'B', 2],
    ['r3-b-2', 'R03-B-2', 'R03', 'B', 2],
    ['R3 B 2', 'R03-B-2', 'R03', 'B', 2],
    ['R3/B/2', 'R03-B-2', 'R03', 'B', 2],
    ['3-B-2', 'R03-B-2', 'R03', 'B', 2],
    ['R03-B', 'R03-B', 'R03', 'B', null],
    ['R03', 'R03', 'R03', null, null],
    ['  r12-c-10 ', 'R12-C-10', 'R12', 'C', 10],
    ['R3B2', 'R03-B-2', 'R03', 'B', 2],
    ['Rack 3 Shelf B Bin 2', 'R03-B-2', 'R03', 'B', 2],
  ])('%s -> %s', (input, code, rack, shelf, bin) => {
    expect(parseLocation(input)).toEqual({ locationCode: code, rack, shelf, bin, parsed: true });
  });

  it('keeps unparseable input as typed with null parts', () => {
    expect(parseLocation(' shed corner ')).toEqual({
      locationCode: 'shed corner',
      rack: null,
      shelf: null,
      bin: null,
      parsed: false,
    });
  });

  it('returns null for empty input', () => {
    expect(parseLocation('   ').locationCode).toBeNull();
  });

  it('normalizes rack params', () => {
    expect(normalizeRack('r3')).toBe('R03');
    expect(normalizeRack('R03-B')).toBeNull();
  });
});
