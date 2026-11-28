/**
 * Seed ~30 demo items in the Phase 1.6 format: racks BA, BB, BC, BD; 3-4 levels each (level 01 is the
 * bottom); some shared compartments, some empty compartments, a few bad counts, and one kit
 * ("Patrol Box") with contents. Only runs when the items table is empty. Uses DB_PATH (default data/store.db).
 * (Demo data only - not the troop's real list.)
 */
import '../src/loadEnv.js';
import { pathToFileURL } from 'node:url';
import { openDb, resolveDbPath } from '../src/db/index.js';
import { countItems, createItem, registerCompartment } from '../src/services/items.js';

const PATROL_BOX = [
  { name: 'Parang', quantity: 1 },
  { name: 'Folding saw', quantity: 1 },
  { name: 'Pot', quantity: 2 },
  { name: 'Frying pan', quantity: 1 },
  { name: 'Gas stove', quantity: 1 },
  { name: 'First aid pouch', quantity: 1 },
];

const item = (locationCode, name, quantity, goodQty, badQty, extra = {}) => ({ locationCode, name, quantity, goodQty, badQty, ...extra });

export const SEED_ITEMS = [
  // Rack BA - tents and shelters (4 levels)
  item('BA0101', 'Dome tent (4 person)', 6, 5, 1, { brand: 'Coleman', model: 'Sundome 4', notes: 'One has a broken zip' }),
  item('BA0102', 'Patrol tent (6 person)', 3, 3, 0),
  item('BA0201', 'Fly sheet', 10, 10, 0),
  item('BA0201', 'Ground sheet', 8, 7, 1),
  item('BA0202', 'Tent pegs', 4, 4, 0, { unit: 'box' }),
  item('BA0301', 'Tent spare parts', 1, 1, 0, { unit: 'box' }),
  item('BA0401', 'Dining shelter', 1, 1, 0),
  // Rack BB - cooking (3 levels)
  item('BB0101', 'Water jerry can', 6, 4, 2, { notes: 'Two leak at the tap' }),
  item('BB0102', 'Patrol Box', 1, 1, 0, { contents: PATROL_BOX }),
  item('BB0103', 'Patrol Box', 1, 1, 0, { contents: PATROL_BOX }),
  item('BB0201', 'Gas stove', 4, 4, 0, { brand: 'Campingaz', model: 'Camp Bistro' }),
  item('BB0201', 'Kerosene lamp', 3, 3, 0),
  item('BB0202', 'Big kettle', 2, 2, 0),
  item('BB0202', 'Ladle', 3, 3, 0),
  item('BB0202', 'Frying pan', 2, 1, 1),
  item('BB0203', 'Pot', 5, 5, 0),
  item('BB0301', 'Paper cups', 1, null, null, { unit: 'box', notes: 'Not counted yet' }),
  // Rack BC - tools and pioneering (4 levels)
  item('BC0101', 'Bamboo spar 3 m', 30, 28, 2),
  item('BC0102', 'Mallet', 6, 6, 0),
  item('BC0201', 'Parang', 8, 8, 0),
  item('BC0201', 'Folding saw', 6, 5, 1, { brand: 'Silky', model: 'Pocketboy 170' }),
  item('BC0201', 'Axe', 2, 2, 0),
  item('BC0302', 'Manila rope 10 m', 12, 12, 0, { unit: 'coils' }),
  item('BC0302', 'Lashing cord', 20, 20, 0, { unit: 'bundles' }),
  item('BC0401', 'Safety vest', 15, 15, 0),
  // Rack BD - first aid, lighting, flags (3 levels)
  item('BD0101', 'First aid kit', 6, 6, 0, { unit: 'kits', notes: 'Check expiry dates every term' }),
  item('BD0102', 'Stretcher', 1, 1, 0),
  item('BD0201', 'Head torch', 15, 13, 2, { brand: 'Petzl', model: 'Tikkina', barcode: '3342540827257' }),
  item('BD0202', 'Gas lantern', 4, 4, 0),
  item('BD0301', 'Patrol flags', 8, 7, 1, { unit: 'sets' }),
  item('BD0301', 'Flag pole (sectional)', 2, 2, 0),
];

/** Compartments that exist on the racks but are empty right now. */
export const SEED_EMPTY_COMPARTMENTS = ['BA0302', 'BA0402', 'BB0302', 'BB0303', 'BC0301', 'BC0402', 'BD0203', 'BD0302'];

export function seed(db, items = SEED_ITEMS, emptyCompartments = items === SEED_ITEMS ? SEED_EMPTY_COMPARTMENTS : []) {
  if (countItems(db) > 0) return { inserted: 0, skipped: true };
  db.transaction(() => {
    for (const it of items) createItem(db, it);
    for (const code of emptyCompartments) registerCompartment(db, code);
  })();
  return { inserted: items.length, skipped: false };
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
