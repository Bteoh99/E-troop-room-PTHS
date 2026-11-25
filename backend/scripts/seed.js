/**
 * Seed ~25 realistic scout store items across racks R01–R06, shelves A–D.
 * Only runs when the items table is empty. Uses DB_PATH (default data/store.db).
 */
import { pathToFileURL } from 'node:url';
import { openDb, resolveDbPath } from '../src/db/index.js';
import { countItems, createItem } from '../src/services/items.js';

export const SEED_ITEMS = [
  // R01 — Tents
  { code: 'TNT-001', name: '2-man hike tent', category: 'Tents', locationCode: 'R01-A-1', quantity: 4, condition: 'good', notes: 'Lightweight, for hikes and expeditions' },
  { code: 'TNT-004', name: '4-man dome tent', category: 'Tents', locationCode: 'R01-B-2', quantity: 6, condition: 'good', notes: 'Green, with rain fly' },
  { code: 'TNT-006', name: '6-man patrol tent', category: 'Tents', locationCode: 'R01-C-1', quantity: 3, condition: 'needs_repair', notes: 'One has a broken zip on the door' },
  { code: 'TNT-010', name: 'Dining shelter / flysheet 4x6 m', category: 'Tents', locationCode: 'R01-D-1', quantity: 2, condition: 'good', notes: 'Poles stored with it' },
  { code: 'TNT-020', name: 'Tent peg set (steel, 20 pcs)', category: 'Tents', locationCode: 'R01-D-3', quantity: 10, unit: 'sets', condition: 'good', notes: '' },
  // R02 — Cooking
  { code: 'CKG-001', name: 'Kuali (wok) 40 cm', category: 'Cooking', locationCode: 'R02-A-1', quantity: 3, condition: 'good', notes: '' },
  { code: 'CKG-002', name: 'Periuk (cooking pot) 10 L', category: 'Cooking', locationCode: 'R02-A-2', quantity: 4, condition: 'good', notes: 'Aluminium, with lids' },
  { code: 'CKG-005', name: 'Portable gas stove (single burner)', category: 'Cooking', locationCode: 'R02-B-1', quantity: 5, condition: 'good', notes: 'Gas canisters NOT stored here — see safety cabinet' },
  { code: 'CKG-008', name: 'Mess tin set', category: 'Cooking', locationCode: 'R02-C-1', quantity: 24, unit: 'sets', condition: 'good', notes: '' },
  { code: 'CKG-012', name: 'Water jerry can 20 L', category: 'Cooking', locationCode: 'R02-D-1', quantity: 6, condition: 'damaged', notes: 'Two leak at the tap' },
  // R03 — Ropes & pioneering
  { code: 'ROP-010', name: 'Manila rope 10 m', category: 'Ropes', locationCode: 'R03-A-1', quantity: 12, unit: 'coils', condition: 'good', notes: '' },
  { code: 'ROP-030', name: 'Nylon rope 30 m', category: 'Ropes', locationCode: 'R03-A-2', quantity: 6, unit: 'coils', condition: 'needs_repair', notes: 'Ends need whipping' },
  { code: 'ROP-050', name: 'Lashing cord 5 mm (bundle)', category: 'Ropes', locationCode: 'R03-B-1', quantity: 20, unit: 'bundles', condition: 'good', notes: 'For pioneering projects' },
  { code: 'PNR-001', name: 'Pioneering spar 3 m (bamboo)', category: 'Pioneering', locationCode: 'R03-D-1', quantity: 30, condition: 'good', notes: 'Bottom shelf, long items' },
  // R04 — Tools
  { code: 'TLS-001', name: 'Parang with sheath', category: 'Tools', locationCode: 'R04-A-1', quantity: 4, condition: 'good', notes: 'Adult supervision only' },
  { code: 'TLS-003', name: 'Folding saw', category: 'Tools', locationCode: 'R04-A-2', quantity: 5, condition: 'good', notes: '' },
  { code: 'TLS-005', name: 'Camp axe', category: 'Tools', locationCode: 'R04-B-1', quantity: 2, condition: 'needs_repair', notes: 'Handle loose on one' },
  { code: 'TLS-010', name: 'Mallet (rubber)', category: 'Tools', locationCode: 'R04-B-3', quantity: 6, condition: 'good', notes: '' },
  { code: 'TLS-015', name: 'Spade / cangkul', category: 'Tools', locationCode: 'R04-D-1', quantity: 3, condition: 'written_off', notes: 'Rusted through — to be replaced' },
  // R05 — First aid & lighting
  { code: 'FAK-001', name: 'First aid kit (patrol)', category: 'First Aid', locationCode: 'R05-A-1', quantity: 6, unit: 'kits', condition: 'good', notes: 'Check expiry dates every term' },
  { code: 'FAK-010', name: 'Triangular bandage', category: 'First Aid', locationCode: 'R05-A-3', quantity: 40, condition: 'good', notes: '' },
  { code: 'FAK-020', name: 'Stretcher (folding)', category: 'First Aid', locationCode: 'R05-C-1', quantity: 1, condition: 'good', notes: '' },
  { code: 'LGT-001', name: 'Gas lantern', category: 'Lighting', locationCode: 'R05-B-1', quantity: 4, condition: 'good', notes: '' },
  { code: 'LGT-005', name: 'Head torch (LED)', category: 'Lighting', locationCode: 'R05-B-2', quantity: 15, condition: 'good', notes: 'AAA batteries in the drawer' },
  // R06 — Flags & ceremonial
  { code: 'FLG-001', name: 'Jalur Gemilang flag (large)', category: 'Flags', locationCode: 'R06-A-1', quantity: 2, condition: 'good', notes: 'Fold properly after use' },
  { code: 'FLG-002', name: 'Troop flag', category: 'Flags', locationCode: 'R06-A-2', quantity: 1, condition: 'good', notes: '' },
  { code: 'FLG-010', name: 'Patrol pennant set', category: 'Flags', locationCode: 'R06-B-1', quantity: 8, unit: 'sets', condition: 'needs_repair', notes: 'Eagle pennant torn' },
  { code: 'FLG-020', name: 'Flagpole 6 m (sectional)', category: 'Flags', locationCode: 'R06-D-1', quantity: 2, condition: 'good', notes: '' },
];

export function seed(db) {
  if (countItems(db) > 0) return { inserted: 0, skipped: true };
  db.transaction(() => {
    for (const item of SEED_ITEMS) createItem(db, item);
  })();
  return { inserted: SEED_ITEMS.length, skipped: false };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const db = openDb();
  const { inserted, skipped } = seed(db);
  const where = resolveDbPath();
  console.log(skipped
    ? `Database already has items; seed skipped (${where}).`
    : `Seeded ${inserted} items into ${where}.`);
  db.close();
}
