import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeRack, parseLocation } from '../src/lib/location';

// The form preview must show exactly what the backend will save. Compare against the
// backend's parser (read-only import of backend/src/lib/location.js).
const here = path.dirname(fileURLToPath(import.meta.url));
const backendFile = path.resolve(here, '../../backend/src/lib/location.js');

interface BackendLocationModule {
  parseLocation(input: unknown): { locationCode: string | null; rack: string | null; shelf: string | null; bin: number | null };
  normalizeRack(input: unknown): string | null;
}

/**
 * Load the backend parser. It is a pure module with no imports, so we evaluate its source
 * directly (Vite's module runner refuses files outside frontend/, and jsdom has no native import()).
 */
function loadBackend(): BackendLocationModule {
  const src = readFileSync(backendFile, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('backend location.js now has imports; update this loader');
  const body = src.replace(/^export\s+/gm, '');
  return new Function(`${body}\nreturn { parseLocation, normalizeRack };`)() as BackendLocationModule;
}
const backend = loadBackend();

const INPUTS = [
  'R03-B-2', 'r3-b-2', 'R3 B 2', 'R3/B/2', '3-B-2', 'R03-B', 'R03', 'R3B2', 'Rack 3 Shelf B Bin 2', 'Rak 3 B 2',
  ' r12-c-10 ', 'R003-b-02', 'R3.B.2', 'R3_B_2', 'R3:B:2', 'R3|B|2', 'R3\\B\\2', 'R 3 - B - 2', '0', '000',
  'R1234', 'R12-B-12345', 'R3-BB-2', 'R3-B-2-1', 'shelf corner', 'shed', '', '   ', 'Rack3', 'RACK 03 LEVEL A POS 4',
  'r3 tingkat b petak 2', 'R3-b', '12', 'R-3', 'B-3', 'R3 B', 'Store 2', '🙂', 'R3,B,2', 'r3-z-0',
];

describe('location parser parity with the backend', () => {
  it.each(INPUTS)('parseLocation(%j) matches backend', (input) => {
    const { parsed: _parsed, ...front } = parseLocation(input);
    void _parsed;
    expect(front).toEqual(backend.parseLocation(input));
  });

  it.each(['r3', '3', 'R03', 'R003', 'Rack 3', 'R-3', 'R3-B', 'abc', '', 'rak 12'])(
    'normalizeRack(%j) matches backend',
    (input) => {
        expect(normalizeRack(input)).toEqual(backend.normalizeRack(input));
    },
  );
});
