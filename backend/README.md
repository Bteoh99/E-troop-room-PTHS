# e-Troop Store Room — Backend

Express 4 + better-sqlite3 API for finding store items by rack coordinate (`R03-B-2`), editing them,
importing the inventory from Excel/CSV and matching scanned labels/barcodes. In laptop mode it also
serves the built frontend. The contract is `../docs/SPEC.md`; Windows laptop setup is `../docs/SETUP-WINDOWS.md`.

## Run

```bash
cd backend
npm install
npm run set-pin     # leader PIN (4-8 digits); without it, adding/editing/importing returns 403
npm run seed        # 28 sample items in R01–R06, shelves A–D (only if the DB is empty)
npm run dev         # http://localhost:3001/api, restarts on file changes (frontend via Vite on :5173)
npm test            # vitest (in-memory DB, temp PIN config)

# Laptop / production mode: serves ../frontend/dist too, on 0.0.0.0, prints LAN URLs
(cd ../frontend && npm ci && npm run build)
NODE_ENV=production npm start
npm run backup      # one backup now
```

Settings come from environment variables or `backend/.env` (copy `.env.example`; real env vars win):

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `HOST` | `0.0.0.0` | |
| `DB_PATH` | `data/store.db` | relative paths resolve against `backend/`; `:memory:` for tests |
| `CONFIG_PATH` | `data/config.json` | leader PIN hash + token secret (never the PIN itself) |
| `BACKUP_DIR` / `BACKUP_HOUR` / `BACKUP_KEEP` | `data/backups` / `21` / `30` | backup on start + daily |
| `NODE_ENV=production` or `SERVE_FRONTEND=1` | off | serve `FRONTEND_DIST` (default `../frontend/dist`) |

To start over: stop the server, delete `data/store.db*`, run `npm run seed`.

## Quick check

```bash
curl localhost:3001/api/health
curl "localhost:3001/api/items?q=tent"
TOKEN=$(curl -s -H 'content-type: application/json' -d '{"pin":"1234"}' localhost:3001/api/auth/login | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -H "Authorization: Bearer $TOKEN" -F file=@items.xlsx "localhost:3001/api/import?dryRun=true"
curl -H 'content-type: application/json' -d '{"text":"Coleman Sundome TNT-OO4"}' localhost:3001/api/scan/match
```

## Layout

```
src/app.js              createApp(db) + lazy default `app` (opens DB_PATH on first request; no listen)
src/server.js           listens on PORT
src/db/                 openDb(), migrations (schema_version table; append new versions for Phase 2)
src/lib/location.js     parseLocation / normalizeRack / combineLocation (pure)
src/lib/headers.js      Excel header aliases (EN + Malay), mapHeaders, findHeaderRow (pure)
src/lib/condition.js    mapCondition (EN + Malay) (pure)
src/lib/importRows.js   spreadsheet rows -> validated item patches, row errors/warnings (pure)
src/lib/csv.js          CSV parser (quotes, BOM, , ; or tab delimiter, Windows-1252 fallback) (pure)
src/lib/xlsxGuard.js    zip pre-flight: bounded inflate, row/cell caps before ExcelJS loads (pure)
src/lib/itemSchema.js   zod schemas for create / update / query
src/services/items.js   item queries (search ranking, racks, categories)
src/services/importer.js  xlsx/csv reading, dry-run/real upsert, template workbook
src/lib/scanMatch.js    scan scoring: OCR folding, tokenising, weighted overlap (pure)
src/lib/env.js          .env parser/loader (src/loadEnv.js applies backend/.env in entry points)
src/auth/               leader PIN: config.json (scrypt), signed tokens, wrong-PIN rate limit, middleware
src/services/backup.js  db.backup() to BACKUP_DIR, rotation, daily schedule
src/routes/             items, categories, racks, import, scan
scripts/seed.js         seed data
scripts/set-pin.js      set/change the leader PIN (hidden prompt, --pin, --check)
scripts/backup.js       one backup now
tests/                  vitest + supertest
```

## Testing notes

- `import { app } from '../src/app.js'` gives an app on `DB_PATH`, opened on first request (`:memory:`
  under vitest, set in `vitest.config.js`; each test file runs in its own process, so it gets its own empty DB).
- `makeApp()` in `tests/helpers.js` gives a fresh in-memory DB with a temp leader PIN: its `app` sends the
  leader token automatically, `publicApp` does not (for auth tests). Without a PIN the default app is in
  setup-needed mode (writes → 403).
- `seed(db)` and `SEED_ITEMS` are exported from `scripts/seed.js`.

## Import behaviour (tolerant on purpose — the real file arrives later)

- Accepts `.xlsx` and `.csv` up to 5 MB, field name `file`. `dryRun` defaults to `true`.
- Header row is auto-detected in the first 15 rows (title rows above it are fine). Headers are
  case/space/punctuation-insensitive and include Malay aliases (`Kod`, `Nama`, `Lokasi`, `Kuantiti`,
  `Keadaan`, `Catatan`, ...). Separate `Rack` / `Shelf` / `Bin` columns are combined. Unknown and
  duplicate columns are ignored and listed in `ignoredColumns` (a losing `Description` / `Keterangan`
  becomes notes if there is no notes column).
- Uses the first visible sheet that has code + name headers.
- Rows missing code or name → error, skipped. Blank rows ignored. Odd locations are kept as text
  (warning). Unknown condition → warning; existing items keep theirs, new items get `good`. Bad quantity → warning, quantity unchanged
  (1 for new items). `"5 pcs"` → quantity 5, unit `pcs`. Location > 100 chars → warning, not changed.
- Upsert by code (case-insensitive). **Blank cells and missing columns never change an existing item**;
  new items get the defaults. Counts are per distinct code: `created`, `updated`, `unchanged`
  (unchanged items are not written). A code repeated in the file is one item (later rows on top, warning).
- A real import runs in a single transaction; a dry run writes nothing.
- Memory safety: before ExcelJS loads a workbook, `src/lib/xlsxGuard.js` reads the zip directory and
  inflates each entry with a hard cap, rejecting workbooks over 25,000 rows / 240,000 cells / 48 MB of
  XML (ExcelJS needs ~0.75 KB per cell, so the worst accepted file peaks around 200 MB). Rows, cells and
  shared strings are counted in every zip entry with a namespace/whitespace-tolerant regex, and entry
  names are normalized like ExcelJS does (leading `/`). CSV parsing stops early past the row limit.
- One import runs at a time per process (`runExclusive` in `src/services/importer.js`); up to 2 more
  wait, further requests get 429.
