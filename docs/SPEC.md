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

### Backend implementation notes (additive; nothing in the table above changed)
- Location parsing: the text must **start with a rack** (`3`, `R3`, `Rack 3`, `Rak 3`). Shelf/bin words (`Shelf`, `Level`, `Tingkat`, `Bin`, `Slot`, `Petak`, ...) are only understood after a rack, so `Bin 5` / `Tingkat 2` are kept as text (rack null). En/em dashes (`R03–B–2`) count as separators.
- `GET /api/items`: case-insensitive matching is Unicode-aware (`öl` finds `Ölfass`). If the whole `q` is a coordinate (`r3-b`, `R3 B 2`, `R03-B-1`), it matches items whose rack/shelf/bin **components** are equal (so `R03-B-1` does not match `R03-B-10`), plus items whose code/name/category/notes contain `q`. Otherwise every word of `q` must match; a coordinate word (`tent r1`) matches that rack/shelf/bin. Ranking: exact code, **exact location**, code prefix, name prefix, others; ties by name. `rack` filter accepts `3`, `r3`, `R03`. Invalid `condition` → 400.
- `GET /api/racks/:rack`: accepts `r3` / `3`; **404** if the rack has no items, 400 if not a rack. Response also has `"unshelved": Item[]` (items with a rack but no shelf, e.g. location `R03`).
- `POST /api/import`:
  - `dryRun` **defaults to `true`** when omitted (pass `dryRun=false` to write).
  - Extra response fields: `unchanged` (count), `headerRow` (sheet row of the detected header), `columns` (field → column index), `ignoredColumns` (strings: unrecognised headers, and duplicate columns as e.g. `"ID (duplicate code column; \"Code\" is used)"`). A losing `Description`/`Keterangan` column becomes `notes` when there is no notes column.
  - Counts are per **distinct code**: `created` (new), `updated` (existing item that changes), `unchanged` (existing item the file leaves as is; not written, `updatedAt` kept). A code repeated in the file is one item: later rows apply on top (warning), and its single preview entry shows the final values.
  - Each `preview` entry also has `row` (sheet row number, first row of that code), `action` (`"create" | "update" | "unchanged"`) and `id` (null only for new items).
  - Entries in `errors` whose message starts with `Warning:` are warnings: the row was still imported and is **not** counted in `skipped`.
  - **A blank cell never changes an existing item** (any field); new items get the defaults. So an import cannot clear a field: use the edit screen for that. Columns absent from the file are also left unchanged.
  - Unknown condition text → warning; an **existing item keeps its condition**, a new item gets `good` (same rule as a bad quantity).
  - A location longer than 100 characters → warning, location left unchanged (null for new items); via the API it is still a 400.
  - One import (dry run or real) is processed at a time per server; up to 2 more wait their turn, beyond that → **429** `{ error: { message } }` (frontend: show "try again in a moment").
  - Errors: no recognisable code + name columns → 400 (`details.missingColumns`, `details.headersFound`); wrong type, malformed upload, or a workbook too big once unpacked (more than 25,000 rows, 240,000 cells or 48 MB of XML; CSV has no cell cap) → 400; more than 20,000 data rows → 400; > 5 MB → 413.
- Malformed JSON / unsupported charset / malformed multipart → 400 with the standard error shape.
- Phase 2 note: `DELETE /api/items/:id` is a hard delete. Before loans reference `items.id`, switch to `ON DELETE RESTRICT` + map the FK error to 409, or soft delete.

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

---

# Phase 1.5 — Laptop hosting, Leader PIN, Scan, Locations

Decisions from the quartermaster:
- The app runs on an **old Windows 10 laptop** on the troop Wi-Fi; others open it from Android phones (Chrome) on the same Wi-Fi via `http://<laptop-ip>:3001`. Plain HTTP on the LAN (no HTTPS), so **no live camera stream / getUserMedia**.
- **Leader PIN**: anyone may search and view; adding, editing, deleting and importing need the PIN.
- **Scan**: scan the item's **own manufacturer label** (brand/model text) or a **shop barcode** — no printed labels.
- The real Excel has only **item name, item code, quantity** (no locations) → items will arrive unlocated and need fast location entry.

## A. Item fields (backend migration v2)
Add to Item: `brand` (string|null, ≤100), `model` (string|null, ≤100), `barcode` (string|null, ≤64, digits/letters only after trimming spaces; unique when not null → 409 on duplicate).
- Search `q` also matches brand, model, barcode. Exact barcode match ranks with exact code match (top tier).
- Excel aliases: brand: `brand`, `jenama`, `manufacturer`, `make`, `pengeluar`; model: `model`, `model no`, `model number`, `no model`; barcode: `barcode`, `kod bar`, `ean`, `upc`. (`description` stays a name/notes alias as before.)
- `GET /api/items?unlocated=true` → only items with `rack` null (both no location and unparseable location); sorted by code.

## B. Scan matching — `POST /api/scan/match`
Body: `{ "text"?: string (≤2000), "barcode"?: string (≤64) }` (at least one). Public (no PIN).
Response: `{ "matches": [{ "item": Item, "score": number (0..1), "matchedOn": string[] }], "query": { "tokens": string[], "barcode"?: string } }`, max 10, best first.
- `barcode` present and an item has that exact barcode → that item alone with score 1.
- `text` is raw OCR output (noisy, multi-line). Tokenise (letters/digits, drop tokens < 2 chars and common noise words like "made", "in", "the", "warning", "kg", "cm"). Score items by weighted token overlap against code (highest weight), barcode, brand, model, name, category, notes. Code matching must be OCR-tolerant: compare after mapping O→0, I/L→1, S→5, B→8, Z→2 on both sides and ignoring `-`/spaces/`_`, so `TNT-OO4`, `TNT 004`, `tnt004` all find `TNT-004`. Use a small edit-distance tolerance (≤1) for tokens ≥5 chars on brand/model.
- No sensible match → `matches: []` (200).
Pure scoring logic in its own module (unit-testable).

## C. Leader PIN (backend)
- PIN is 4–8 digits, stored only as a **scrypt hash + salt** in `data/config.json` (gitignored), never in code or logs. Set/change with `npm run set-pin` (prompts twice, hidden input; also accepts `--pin` for scripts). If no PIN is set, the server starts in **setup-needed** mode: writes return 403 `{error:{message:"Leader PIN not set. Run set-pin on the laptop."}}`.
- `POST /api/auth/login {pin}` → `{ token, expiresAt }`. Token = HMAC-SHA256-signed (secret random per install, stored in config.json) with 30-day expiry. Wrong PIN → 401. **Rate limit**: 5 wrong attempts per IP → 429 for 5 minutes (also a global cap of 20 wrong/5 min). Constant-time compare.
- `GET /api/auth/status` → `{ pinSet: bool, leader: bool }` (leader = valid token sent).
- Writes (`POST/PUT/DELETE /api/items*`, `POST /api/import` incl. dry run) require `Authorization: Bearer <token>`; missing/invalid/expired → 401. Reads, `/api/scan/match`, template download stay public.
- Changing the PIN (set-pin) rotates the secret → all existing tokens invalid.
- Tests: helper to set a known PIN in a temp config dir (`CONFIG_PATH` env, default `data/config.json`).

## D. Laptop mode (single server)
- In production the backend also serves `frontend/dist` (static, with SPA fallback to index.html for non-`/api` GETs) when that folder exists. Listen on `0.0.0.0`. On start, print the LAN URLs (e.g. `Open on phones: http://192.168.1.50:3001`).
- Security headers suitable for a LAN app (no external CDNs needed; everything self-hosted).
- **Automatic backup**: on start and then daily at `BACKUP_HOUR` (default 21), use better-sqlite3's online `db.backup()` into `BACKUP_DIR` (default `backend/data/backups`, can point at a Google Drive for desktop folder or USB) as `store-YYYY-MM-DD.db`; keep the newest `BACKUP_KEEP` (default 30). Never crash the server if the backup folder is missing/unwritable — log a warning. `npm run backup` does one now.
- Config via `backend/.env` (gitignored) read at start (PORT, BACKUP_DIR, BACKUP_HOUR, BACKUP_KEEP); `.env.example` committed.

## E. Windows 10 scripts — `windows/` folder (repo root)
Laptop must be 64-bit Windows 10 with Node.js 22 LTS (x64) and Git installed. PowerShell 5.1 compatible (built into Windows 10 — no PowerShell 7 features).
- `install.ps1` (run once as Administrator): check Node ≥22 x64 & npm; `npm ci` backend + frontend; build frontend; run set-pin if no PIN; add Windows Firewall inbound rule for TCP 3001 on **Private** profile only; register a **Task Scheduler** task "e-Troop Store Room" that runs at system startup (whether or not anyone logs in, restart on failure, no time limit) launching `start.bat`; offer to set power plan so the laptop never sleeps while plugged in (`powercfg`); print the LAN URL. Idempotent (safe to run again).
- `start.bat`: starts the server with `NODE_ENV=production`, appending output to `backend/data/logs/server.log` (rotate when > 5 MB).
- `update.ps1`: stop task → `git pull` → `npm ci` both → build → start task.
- `stop.ps1`, `uninstall.ps1` (removes task + firewall rule, **keeps data**), `backup-now.bat`.
- `windows/README.md` is not needed — the guide is `docs/SETUP-WINDOWS.md` (plain English, step by step, written for a non-technical leader: install Node & Git, download repo, run install, set Wi-Fi to Private network, give the laptop a fixed IP / router reservation, open on Android + Add to Home screen, where backups are, how to update, troubleshooting).

## F. Frontend
1. **Leader mode**: a lock button in the header/tab bar (🔒 "Leader" / 🔓 "Leader mode on"). Unlock dialog with numeric PIN input (`inputmode="numeric"`, `autocomplete="off"`). Token kept in localStorage (wrapped in try/catch). Add/Edit/Delete/Import controls are visible but, when locked, tapping them opens the PIN dialog first, then continues. Any 401 → token cleared, PIN dialog shown, action retried after unlock. 429 → "Too many wrong tries — wait 5 minutes". Setup-needed (403) → explain the PIN must be set on the laptop. "Lock" button to leave leader mode.
2. **Scan** (new tab "Scan", also a 📷 button beside the search box): `<input type="file" accept="image/*" capture="environment">` (works over plain HTTP). Flow: take photo → show the photo thumbnail + progress ("Looking for a barcode…", "Reading text…") → first try barcode decoding on the photo (e.g. zxing-wasm / @zxing/library, bundled locally), then OCR with **tesseract.js running fully offline**: worker, core wasm and the English traineddata must be **bundled/served from our own server** (copied into the build from npm packages, e.g. `@tesseract.js-data/eng` or `tesseract.js-core`), never fetched from a CDN at runtime. Downscale/greyscale the image before OCR (max ~1600 px) for speed on old phones. Then call `/api/scan/match` and show results as normal result cards (big 📍 badge) with "Matched on: brand, model". Show the recognised text (editable) with a "Search with this text" button, so the user can fix OCR mistakes. No match → friendly message + buttons "Try another photo" and "Type to search". Lazy-load the scan code so the main app stays fast. Tips shown on the screen: good light, fill the frame with the label, hold steady.
3. **Needs a location** page (`/locate`, linked from the Map page "X items have no location" and from a dashboard-style badge on Search when > 0): list unlocated items (code, name, qty) each with an inline location input + live normalized preview + Save (needs leader mode). After saving, the row slides away and focus jumps to the next item's input, so a leader can walk along racks entering locations quickly. Optional "Rack prefix" helper: choose rack R03 once, then type just `B-2`.
4. Item form/detail/search cards show brand, model, barcode when present. Form fields for them.
5. Import preview shows brand/model/barcode columns when present.

### Phase 1.5 backend implementation notes (additions to A–E; frontend please read)
- **Item** now always has `brand`, `model`, `barcode` (null when empty). Barcode input: all whitespace removed and letters upper-cased (`"9 312345 678901"` → `"9312345678901"`); any other character → 400. Duplicate barcode → 409 `details: { field: "barcode", code: "<item that has it>" }`. Sending `""`/`null` clears a field.
- **Search**: exact barcode (spaces ignored) ranks in the top tier with exact code. `unlocated` accepts `true|false|1|0`; combined with `q` the normal ranking applies, otherwise sorted by code.
- **Import**: brand/model/barcode columns follow the "blank cell never changes an existing item" rule. An invalid barcode, or one that already belongs to another item (in the DB or earlier in the file) → `Warning:` and the barcode is not changed. Preview entries include `brand`, `model`, `barcode`.
- **Scan** `POST /api/scan/match`:
  - `matchedOn` values come from `code`, `barcode`, `brand`, `model`, `name`, `category`, `notes`. Items scoring under 0.15 are left out.
  - A `barcode` that equals an item's **code** (OCR-folded) also counts as an exact match (score 1, `matchedOn: ["code"]`).
  - An unknown barcode with no text → `{ matches: [] }`.
  - Codes split over up to 5 OCR words are joined back (`TNT - 0 0 4`). OCR folding also maps `rn` → `m`.
  - Body validation errors → 400 (empty or whitespace-only text with no barcode included).
- **Auth**:
  - `POST /api/auth/login` → 200 `{ token, expiresAt }`. Wrong PIN → 401 `"Wrong PIN."`. Missing `pin` → 400 (not counted as a wrong try). No PIN set → 403 (same message as for writes).
  - Rate limited → 429 with a `Retry-After` header (seconds) and `details.retryAfterSeconds`. While blocked, even the right PIN gets 429.
  - Writes without a valid token → 401: `"Leader PIN required. Unlock leader mode first."`, or `"Leader session expired. Enter the leader PIN again."` for an expired token. A damaged `config.json` → 503 on writes.
  - Tokens die when the PIN is changed with `set-pin`; the running server notices the file change, no restart needed.
  - Send the token as `Authorization: Bearer <token>`.
- **Serving**:
  - `frontend/dist` (or `FRONTEND_DIST`) is served only when `NODE_ENV=production` or `SERVE_FRONTEND=1`, and only if it contains `index.html`. `windows/start.bat` sets `NODE_ENV=production`.
  - SPA fallback applies to every GET page path. Only a missing file with a known asset extension (`.js .mjs .css .png .jpg .jpeg .gif .webp .svg .ico .wasm .json .map .woff .woff2 .ttf .txt .webmanifest .traineddata .gz .html`) is a real 404, as plain text. So `/items/1.5` gets `index.html`.
  - `assets/*` gets `Cache-Control: public, max-age=31536000, immutable`; everything else outside `/api` gets `no-cache`; `/api/*` gets `no-store`. `.wasm` is served as `application/wasm`.
- **Security headers on every response:**
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  - What this means for the frontend: no inline `<script>`, no CDNs, and no `eval`/`new Function` outside WebAssembly. Tell the backend if tesseract.js or zxing needs more.
  - Also set: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, and a `Permissions-Policy` that blocks geolocation, microphone, payment and USB. There is **no** HSTS or upgrade-insecure-requests, because the app runs on plain HTTP on the LAN.
- **Laptop mode**:
  - `HOST` defaults to `0.0.0.0`.
  - Extra env vars: `DB_PATH`, `CONFIG_PATH`, `HOST`, `FRONTEND_DIST`, `SERVE_FRONTEND` (all optional). Real environment variables win over `backend/.env`.
  - Backups are written as `<name>.partial`, then renamed, so a half-written file never looks like a backup. A second backup on the same day replaces that day's file.
  - New npm scripts: `npm run set-pin [-- --pin 1234 | --check]` and `npm run backup`.
- **Windows**:
  - Double-click wrappers `install.bat`, `update.bat`, `stop.bat`, `uninstall.bat`, `start-app.bat`, `set-pin.bat`, `settings.bat` and `backup-now.bat` sit next to their `.ps1` scripts. Each script asks for Administrator rights by itself.
  - The startup task runs as **SYSTEM**. That is why a Google Drive backup folder must be in "Mirror files" mode.
  - `start.bat` restarts the server 10 s after it exits. It rotates `server.log` (over 5 MB → `server.log.1`) each time the server (re)starts.
  - The guide is `docs/SETUP-WINDOWS.md`.

### Phase 1.5 fix round (backend + Windows; overrides the notes above where they differ)
- **Login rate limit** (this replaces the spec's "global cap of 20 wrong/5 min"):
  - The attempt is reserved **before** the scrypt check.
  - At most **1 PIN check in flight per IP** and **2 globally**. Extra concurrent requests get 429 at once, with `Retry-After: 1` and the message "Too many PIN attempts at once. Wait a moment and try again."
  - Pending checks count against the per-IP limit of 5 wrong tries per 5 minutes, so a burst of 200 parallel logins gets at most 5 checks.
  - **Global slowdown instead of a global lock-out:** a bucket of 10 wrong tries refills at 1 per second; when it is empty, 429 with `Retry-After: 1`. A correct PIN gives its token back.
  - A per-IP block still answers 429 "Too many wrong PIN attempts. Wait 5 minutes…" with `Retry-After` up to 300.
  - `set-pin` and the guide recommend a 6-digit PIN; 4–8 digits are still accepted.
- **Damaged `config.json`** (empty, unparseable or not an object): writes, `POST /api/auth/login` **and** `GET /api/auth/status` → **503** "Leader settings file is damaged. Run set-pin on the laptop to repair it…".
  - `set-pin --force` (and `windows/set-pin.bat`) replaces it and keeps the damaged file as `config.json.broken-<time>`.
  - `set-pin --check` exits 0 = set, 1 = not set, 2 = damaged.
  - Config writes are fsynced. Expected 503s are not logged as crashes.
- **Barcodes:**
  - The JSON value must be a **string**; a number, boolean or object → 400.
  - **ASCII** letters/digits only, so `ß12` → 400 (it no longer becomes `SS12`).
  - Stored as given, but compared and kept **unique ignoring leading zeros** (migration v3: unique index on `ltrim(barcode,'0')`). So `012345678905` and `12345678905` are the same barcode for 409s, search ranking and scan matching.
  - An import row whose barcode differs from the stored one only by leading zeros does not change it.
- **Import:**
  - Barcode ownership is planned once, the same way for dry and real runs.
  - A barcode that an earlier row in the file moved off its item may be taken by a later row. Moved barcodes are freed first inside the transaction.
- **Scan:**
  - `text` over 2000 characters is **truncated** server-side, not a 400.
  - Throttled to **30 requests per minute per IP**; beyond that, 429 with `Retry-After` and `details.retryAfterSeconds`.
  - The scoring index is cached and rebuilt after any database change.
  - Codes: an exact match on one OCR word, or on neighbouring words joined back up to the longest code/barcode length (so `T N T - 0 0 4` works).
  - "Weak" codes (digits only, letters only, or under 4 folded characters) only count on a whole word of the same kind, with score 0.35. So `220`, `2024`, `BOIL` or `011` never win from label noise such as `220-240V`, years, `B O I L` or `OIL`.
  - An exact whole model gets a bonus over a partial one: `SUNDOME 4P` ranks model "Sundome 4P" above "Sundome 4".
  - Brand/model allow one Damerau edit, so a swap like `Peztl`/`Petzl` counts as one edit.
  - Ties are broken by the number of matched fields, then by code.
- **Tokens:** a signature with extra or junk characters is rejected (only the canonical base64url form is accepted).
- **Windows:**
  - `install.ps1` locks the install folder with icacls. Owner is Administrators; SYSTEM and Administrators have full control; Users have read & execute only; inheritance is broken. `backend\data` is readable by SYSTEM and Administrators only.
  - It records the absolute `node.exe` path in `backend\data\node-path.txt`, and `start.bat` uses only that (never a bare `node`). A per-user Node install is refused with "reinstall for all users".
  - The firewall rule is Private profile **and** `RemoteAddress LocalSubnet`. The installer offers to remove inbound Block rules for node.exe.
  - `update.ps1` always tries to restart the task and reports what failed.
  - New scripts: `start-app` (start without internet), `set-pin`, `settings` (edit `.env` + restart) and `backup-now`, each as `.ps1` + `.bat`.
