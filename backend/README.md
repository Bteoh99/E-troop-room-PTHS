# e-Troop Store Room — Backend (Phase 1)

Express 4 + better-sqlite3 API for finding store items by rack coordinate (`R03-B-2`),
editing them, and importing the inventory from Excel/CSV. The contract is `../docs/SPEC.md`.

## Run

```bash
cd backend
npm install
npm run seed        # 28 sample items in R01–R06, shelves A–D (only if the DB is empty)
npm run dev         # http://localhost:3001/api, restarts on file changes
# or: npm start
npm test            # vitest (uses an in-memory DB)
```

Environment variables:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `DB_PATH` | `data/store.db` | relative paths resolve against `backend/`; `:memory:` for tests |

To start over: stop the server, delete `data/store.db*`, run `npm run seed`.

## Quick check

```bash
curl localhost:3001/api/health
curl "localhost:3001/api/items?q=tent"
curl localhost:3001/api/racks
curl -o item-template.xlsx localhost:3001/api/import/template
curl -F file=@item-template.xlsx "localhost:3001/api/import?dryRun=true"
```

## Layout

```
src/app.js              createApp(db) + default `app` export (no listen) — use with Supertest
src/server.js           listens on PORT
src/db/                 openDb(), migrations (schema_version table; append new versions for Phase 2)
src/lib/location.js     parseLocation / normalizeRack / combineLocation (pure)
src/lib/headers.js      Excel header aliases (EN + Malay), mapHeaders, findHeaderRow (pure)
src/lib/condition.js    mapCondition (EN + Malay) (pure)
src/lib/importRows.js   spreadsheet rows -> validated item patches, row errors/warnings (pure)
src/lib/csv.js          CSV parser (quotes, BOM, , ; or tab delimiter, Windows-1252 fallback) (pure)
src/lib/itemSchema.js   zod schemas for create / update / query
src/services/items.js   item queries (search ranking, racks, categories)
src/services/importer.js  xlsx/csv reading, dry-run/real upsert, template workbook
src/routes/             items, categories, racks, import
scripts/seed.js         seed data
tests/                  vitest + supertest
```

## Testing notes

- `import { app } from '../src/app.js'` gives an app on `DB_PATH` (`:memory:` under vitest, set in
  `vitest.config.js`; each test file runs in its own process, so it gets its own empty DB).
- For a fresh DB per test: `createApp(openDb(':memory:'))` (`openDb` from `src/db/index.js`).
- `seed(db)` and `SEED_ITEMS` are exported from `scripts/seed.js`.

## Import behaviour (tolerant on purpose — the real file arrives later)

- Accepts `.xlsx` and `.csv` up to 5 MB, field name `file`. `dryRun` defaults to `true`.
- Header row is auto-detected in the first 15 rows (title rows above it are fine). Headers are
  case/space/punctuation-insensitive and include Malay aliases (`Kod`, `Nama`, `Lokasi`, `Kuantiti`,
  `Keadaan`, `Catatan`, ...). Separate `Rack` / `Shelf` / `Bin` columns are combined. Unknown columns are
  ignored and listed in `ignoredColumns`.
- Uses the first visible sheet that has code + name headers.
- Rows missing code or name → error, skipped. Blank rows ignored. Odd locations are kept as text
  (warning). Unknown condition → `good` (warning). Bad quantity → warning, quantity unchanged
  (1 for new items). `"5 pcs"` → quantity 5, unit `pcs`. Same code twice → later row wins (warning).
- Upsert by code (case-insensitive). Only columns present in the file overwrite existing values.
- A real import runs in a single transaction; a dry run writes nothing.
