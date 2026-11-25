# e-Troop Store Room — Shared Spec (Phase 1)

This file is the **contract** between frontend and backend. Every agent reads it first.
If you must change the contract, update this file and say so in your report.

## Goal of Phase 1
A quartermaster can **search for an item** by name/code and immediately see **which rack, shelf and bin** it is in, highlighted on a store-room map. Items can be added/edited, and the existing inventory can be **imported from an Excel file**.

## Stack
| Part | Tech |
|---|---|
| Backend | Node 22, Express 4, better-sqlite3, zod (validation), multer + exceljs (Excel/CSV import) |
| Backend tests | Vitest + Supertest |
| Frontend | React 18 + TypeScript + Vite, React Router, plain CSS (no UI kit), mobile-first |
| Frontend tests | Vitest + @testing-library/react + jsdom; Playwright for e2e (Chromium preinstalled — do NOT run `playwright install`) |

Layout:
```
backend/   src/ (app.js exports the Express app, server.js listens), data/ (sqlite file, gitignored), tests/
frontend/  src/, tests/ (unit), e2e/ (playwright)
docs/      SPEC.md, REVIEW-*.md, TEST-*.md
```
Ports: backend `3001`; frontend dev `5173` with Vite proxy `/api` -> `http://localhost:3001`.
Backend must export the app from `src/app.js` (no listen) so Supertest can use it; DB path from env `DB_PATH` (default `data/store.db`; tests use `:memory:`).

## Location coordinate
Canonical code: **`R03-B-2`** = Rack 03, Shelf level B (A = top), Bin/position 2.
- `rack` string like `"R03"` (zero-padded to 2 digits), `shelf` single uppercase letter, `bin` integer.
- The parser must accept loose input: `R03-B-2`, `r3-b-2`, `R3 B 2`, `R3/B/2`, `3-B-2`, `R03-B` (no bin), `R03` (rack only). Normalize to canonical.
- If the input cannot be parsed, keep it as-is in `locationCode` and set `rack/shelf/bin` to `null` (never reject the item for an odd location).

## Item
```json
{
  "id": 1,
  "code": "TNT-004",              // unique, required, stored uppercase, trimmed
  "name": "4-man dome tent",      // required
  "category": "Tents",            // string or null
  "locationCode": "R03-B-2",      // normalized string or null
  "rack": "R03", "shelf": "B", "bin": 2,   // derived from locationCode, may be null
  "quantity": 1,                  // integer >= 0, default 1
  "unit": "pcs",                  // string, default "pcs"
  "condition": "good",            // "good" | "needs_repair" | "damaged" | "written_off", default "good"
  "notes": "",
  "createdAt": "ISO-8601", "updatedAt": "ISO-8601"
}
```

## API (all JSON, prefix `/api`)
Errors: `{ "error": { "message": string, "details"?: any } }` with proper status (400 validation, 404 not found, 409 duplicate code, 500).

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{ "ok": true }` |
| GET | `/api/items?q=&category=&rack=&condition=` | `{ "items": Item[] }`. `q` matches (case-insensitive) code, name, category, locationCode, notes. Ranking: exact code match first, then code prefix, then name prefix, then others; ties by name. No `q` = all items sorted by code. |
| GET | `/api/items/:id` | `Item` |
| POST | `/api/items` | create; body = Item fields except id/timestamps/rack/shelf/bin. 201 + Item |
| PUT | `/api/items/:id` | partial update allowed; returns Item |
| DELETE | `/api/items/:id` | 204 |
| GET | `/api/categories` | `{ "categories": [{ "name": string, "count": number }] }` (distinct from items) |
| GET | `/api/racks` | `{ "racks": [{ "rack": "R03", "shelves": ["A","B"], "itemCount": 12 }] }` sorted by rack; plus `"unlocated": number` (items with null rack) at top level |
| GET | `/api/racks/:rack` | `{ "rack": "R03", "shelves": [{ "shelf": "A", "items": Item[] }] }` — items grouped by shelf, sorted by bin |
| POST | `/api/import?dryRun=true\|false` | multipart field `file` (.xlsx or .csv, max 5 MB). Returns `{ "dryRun": bool, "created": n, "updated": n, "skipped": n, "errors": [{ "row": n, "message": string }], "preview": Item-like[] (first 20 rows) }`. Upsert by `code`. Dry run writes nothing. Whole real import runs in one transaction. |
| GET | `/api/import/template` | downloads `item-template.xlsx` with header row + 2 example rows |

### Excel column mapping (header row, case/space-insensitive)
The quartermaster's real file will arrive later, so be flexible. Map these header aliases:
- code: `code`, `item code`, `itemcode`, `kod`, `kod item`, `id`
- name: `name`, `item`, `item name`, `nama`, `nama item`, `description`
- location: `location`, `coordinate`, `coordinates`, `koordinat`, `lokasi`, `rack location`
- category: `category`, `kategori`, `type`
- quantity: `qty`, `quantity`, `kuantiti`, `jumlah`
- unit, condition (`condition`, `keadaan`), notes (`notes`, `remarks`, `catatan`)
Also support separate `rack`, `shelf`, `bin` columns that get combined into a location.
Condition text mapping: good/baik/ok → good; repair/needs repair/rosak sikit → needs_repair; damaged/rosak → damaged; written off/lupus → written_off; unknown → good + note in errors as a warning (row still imported).
Rows missing code or name → error for that row, skipped. Blank rows ignored.

## Seed data
`npm run seed` in backend inserts ~25 realistic scout store items (tents, cooking, ropes, tools, first aid, flags) spread across racks R01–R06, shelves A–D. Only if DB is empty.

## Frontend screens
1. **Search (home `/`)** — big search box with autofocus, results update as you type (debounced ~200 ms). Each result card: code, name, **big location badge `📍 R03-B-2`**, condition chip, quantity. Tapping a result opens item detail.
2. **Item detail `/items/:id`** — all fields, a **mini rack diagram** showing that rack's shelves A..n with the item's shelf/bin highlighted, and the store-room map with the rack highlighted. Edit and Delete buttons (delete asks to confirm).
3. **Store-room map `/map`** — grid of rack tiles (from `/api/racks`), each with item count; tap a rack → `/racks/:rack` showing shelves and their items.
4. **Add / Edit item `/items/new`, `/items/:id/edit`** — form with validation messages; location field with live preview of the normalized code.
5. **Import `/import`** — upload Excel/CSV → show dry-run preview (counts + errors table) → "Confirm import" button. Link to download the template.
Navigation: bottom tab bar on mobile (Search, Map, Add, Import), top bar on desktop. Must work at 360 px wide. Accessible: labels on inputs, keyboard usable, color is never the only signal.
Condition colors: good=green, needs_repair=amber, damaged=red, written_off=grey, always with text.

## Out of scope for Phase 1 (do not build yet)
Check-in/out log, members, login/roles, maintenance log, QR codes, stocktake. Keep code structured so these can be added (Phase 2 = check-out/check-in).
