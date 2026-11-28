# e-Troop Store Room — Backend

Express 4 + better-sqlite3 API for finding store items by rack coordinate (`R03-B-2`), editing them,
importing the inventory from Excel/CSV and matching scanned labels/barcodes. In laptop mode it also
serves the built frontend. The contract is `../docs/SPEC.md`; Windows laptop setup is `../docs/SETUP-WINDOWS.md`.

## Run

```bash
cd backend
npm install
npm run set-pin     # leader PIN (6-8 digits; --force repairs a damaged config); without it writes return 403
npm run seed        # 31 demo items in racks BA–BD (AU0305-style locations, good/bad counts, a kit; only if the DB is empty)
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
src/lib/location.js     parseLocation (v2 AU0305 + legacy R03-B-2) / normalizeRack / combineLocation (pure)
src/lib/corrections.js  import tidy + spelling corrections list (pure; add typos to CORRECTIONS)
src/lib/quantityText.js "a box", "2 box(24)", "3 small box" -> quantity + unit (pure)
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
src/routes/             items, categories, racks, compartments, import, scan
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
- `seed(db)` and `SEED_ITEMS` are exported from `scripts/seed.js`. `makeApp({ seeded: true })` uses the
  Phase 1 demo list in `tests/fixtures/legacy-seed.js`; `makeApp({ seeded: 'demo' })` uses the new seed.

## Import behaviour (Phase 1.6: built for the troop's real QM list)

- Accepts `.xlsx` and `.csv` up to 5 MB, field name `file`. `dryRun` defaults to `true`.
- The header row is found in the first 20 rows. Only a name column (`Item description`, `Name`,
  `Nama`, ...) is required. Malay and English aliases are recognised, including `GOOD CONDITION` /
  `BAD CONDITION`.
- A `CODE` column full of codes like `AU0305` is read as the **location** (rack AU, level 03 from the
  bottom, compartment 05). `RACK AU` rows are section headings. A code without a description is an
  **empty compartment**.
- Quantities may be text (`a box`, `2 box(24)`, `3 small box`). Good/Bad are counts. Warnings cover:
  counts that don't add up, missing quantity, unreadable counts, and duplicate rows.
- Names are tidied (spaces, first capital letter). Known typos (`src/lib/corrections.js`) are fixed and
  listed in `corrections`, both in the dry run and the real run.
- Upsert by code when a row has one, else by location + name. Blank cells and missing columns never
  change an existing item. Re-importing the same file changes nothing (`unchanged`).
- An extra sheet named like an item (e.g. "Patrol Box") becomes that item's kit `contents` (`kits`).
- A real import runs in a single transaction; a dry run writes nothing.
- Memory safety: before ExcelJS loads a workbook, `src/lib/xlsxGuard.js` reads the zip directory and
  inflates each entry with a hard cap, rejecting workbooks over 25,000 rows / 240,000 cells / 48 MB of
  XML (ExcelJS needs ~0.75 KB per cell, so the worst accepted file peaks around 200 MB). Rows, cells and
  shared strings are counted in every zip entry with a namespace/whitespace-tolerant regex, and entry
  names are normalized like ExcelJS does (leading `/`). CSV parsing stops early past the row limit.
- One import runs at a time per process (`runExclusive` in `src/services/importer.js`); up to 2 more
  wait, further requests get 429.
