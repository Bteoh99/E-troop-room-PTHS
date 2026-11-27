# Backend Review — Phase 1

Reviewer: Backend Code Reviewer · Scope: `backend/src/**`, `backend/scripts/seed.js` (tests and frontend not reviewed).
Contract: `docs/SPEC.md`, including the "Backend implementation notes".

How I checked: I read every file, ran the pure helpers directly, and ran the server
(`PORT=3101`, `DB_PATH` set to a temp file, seeded, stopped afterwards). I sent curl requests covering
search, CRUD, racks and import, using CSV and `.xlsx` files I built with title rows, merged cells,
rich text, hyperlinks, formulas, error cells, a hidden sheet, Malay headers, duplicate codes, files that
were too big, files of the wrong type, malformed multipart bodies, and a highly compressed workbook.
I reproduced every finding below against the running server or the module.

**Counts:** Critical 0 · Major 2 · Minor 6 · Nit 7

---

## Critical

None found.

---

## Major

### M1. Shelf/bin keywords are stripped, so the number left over becomes a **rack**
`backend/src/lib/location.js:17-22` (`stripWords`), used by `parseLocation` (l.49) and `normalizeRack` (l.34)

**Problem.** `stripWords` deletes `SHELF|LEVEL|TINGKAT|PARA|BIN|POSITION|POS|SLOT|PETAK|NO.` and only then
runs `LOCATION_RE`, whose first number is always the rack. When the text has no rack part, the bin or
shelf number is read as the rack. The result looks like a valid coordinate and no warning is raised.
The spec says input that cannot be parsed must be kept as-is.

Verified:
```
parseLocation("Bin 5")   -> { locationCode: "R05", rack: "R05" }
parseLocation("Level 2") -> R02      parseLocation("Shelf 3") -> R03
parseLocation("Slot 7")  -> R07      parseLocation("Petak 1") -> R01
parseLocation("Pos 3")   -> R03      parseLocation("No. 4")   -> R04
normalizeRack("bin 3")   -> "R03"    (GET /api/racks/bin%203 returns rack R03)
```
**Failure scenarios.**
- Import: the real file has a Location column with values like `Bin 5` or `Tingkat 2` (a sub-location
  inside a cupboard). Each item is filed under rack R05 / R02 with no warning. The map highlights the
  wrong rack and the quartermaster looks in the wrong place.
- Search: `GET /api/items?q=bin%202` returns every item in **rack R02** (verified: CKG-001…CKG-012). None
  of them is in bin 2. `q=level 1` returns all of R01. The search box gives confident but wrong results.

**Fix.** Only strip shelf/bin keywords when a rack is actually present. Either require a rack keyword
(`R`, `RACK`, `RAK`), or require the full `<rack> <shelf>` shape after stripping. A string that starts
with a shelf or bin keyword (`^(BIN|SHELF|LEVEL|…)\b`) should be treated as unparseable and kept as
text. Add unit tests for the cases above.

### M2. Blank cells in a present column silently overwrite existing data, and some fields don't follow the rule
`backend/src/lib/importRows.js:75-76, 93-98, 113-118`

**Problem.** For an existing item, a blank cell in a column that exists in the file:
- `Condition` blank → `mapCondition('')` → `good` (counted as recognised, so no warning). `damaged`,
  `needs_repair` and `written_off` are reset.
- `Location` blank → `locationCode: null`. The item drops off the map and its rack.
- `Notes` blank → `''`. `Category` blank → `null`.

But blank `Quantity` and blank `Unit` mean "unchanged". The behaviour is inconsistent, and nothing in
`errors` tells the user that data is being removed.

Verified with a real import (`dryRun=false`) of a sheet `Kod,Nama,Lokasi,Kuantiti,Keadaan,Catatan`:
```
CKG-012 before: condition "damaged", notes "Two leak at the tap"
CKG-012 after : condition "good",    notes ""          (no warning)
TNT-001 row with blank Lokasi -> locationCode null, rack null (no warning)
```
**Failure scenario.** The quartermaster marks broken kit as `damaged` in the app, or files items into
racks in the app. Later they re-import the master spreadsheet, where the Keadaan and Lokasi columns are
only partly filled. All that status and location data is wiped, and the import reports success.

**Fix.** Pick one rule and apply it to every field. The safest for an update is: blank cell = leave the
field unchanged (as quantity already does). For new items, the defaults (`good`, `pcs`, `''`, `null`)
still apply. If clearing is wanted, require an explicit marker such as `-`, or at least add a
`Warning: … will be cleared` entry so the dry-run preview shows it.

---

## Minor

### m1. A small, highly compressed `.xlsx` is fully loaded before the row limit applies (memory/CPU DoS)
`backend/src/services/importer.js:44-61, 90`

**Problem.** `wb.xlsx.load(buffer)` loads the whole workbook into memory. `MAX_IMPORT_ROWS` is checked
only after that. The 5 MB limit applies to the compressed file.

**Verified.** A 4.9 MB workbook with 580,000 two-cell rows took 7 s to reject ("Too many rows").
Server RSS peaked at **1.36 GB** and stayed there. `/api/health` took 1.9 s during the upload because
the event loop was blocked. Two such uploads at once could exhaust memory on a small machine (e.g. a
Raspberry Pi in the scout hall), and there is no auth in Phase 1. A large real workbook could do the
same by accident.

**Fix.** Use `ExcelJS.stream.xlsx.WorkbookReader` and stop after `MAX_IMPORT_ROWS + header` rows. At a
minimum, read the sheet `<dimension ref>` or the uncompressed entry sizes from the zip before loading.

### m2. Client errors from body-parser / busboy return **500** and log a stack trace
`backend/src/app.js:43-59`

**Problem.** `toErrorResponse` ignores `err.status` / `err.statusCode`, so client errors fall through to
500.

Verified:
```
POST /api/import with a truncated multipart body      -> 500 (busboy "Unexpected end of form")
POST /api/import, multipart/form-data with no boundary -> 500 ("Multipart: Boundary not found")
PUT /api/items/1 with Content-Type: application/json; charset=latin2 -> 500 (body-parser 415)
```
No stack reaches the client, so nothing leaks. But the status codes break the "400 for bad input"
contract, and the server log fills with stacks when a user's upload is interrupted.

**Fix.** Before the generic 500, add:
`if (Number.isInteger(err?.status ?? err?.statusCode) && (err.status ?? err.statusCode) < 500) return { status, body: body(err.expose ? err.message : 'Bad request') }`.
Also map errors raised inside the multer middleware (they have `storageErrors`, or messages starting
`Multipart:` / `Unexpected end of form`) to 400 "Upload was incomplete or malformed".

### m3. Header columns hidden by a higher-priority alias are dropped without a mention
`backend/src/lib/headers.js:9, 47-55`

**Problem.** When two columns map to the same field, the lower-priority one is discarded. It is **not**
added to `unmapped`, so it is missing from `ignoredColumns` as well.

**Verified.** The sheet `Kod,Nama,Lokasi,Keterangan` gives `columns: {code,name,location}` and
`ignoredColumns: []`. The Keterangan values ("Zip rosak") disappear. In Malaysian inventory forms
*Keterangan* is usually the remarks column, but here it is a `name` alias. `Description` next to `Name`,
and `ID` next to `Code`, behave the same way.

**Fix.** Add shadowed columns to `unmapped` (or return a separate `shadowedColumns`) so the preview shows
them. Also consider mapping `keterangan` / `description` to `notes` when a better `name` column exists.

### m4. Coordinate search: a bin-prefix collision, and mixed text+coordinate queries return nothing
`backend/src/services/items.js:152-172`

**Problem.**
1. The text-token `instr` also matches `location_code` as a substring. So `q=R03-B-1` also returns
   `R03-B-10…R03-B-19`. Both get rank 3 and are sorted by name, so the exact bin can come second.
   Verified: `q=R03-B-1` gave `ROP-050 R03-B-1, X-1 R03-B-10`. Rename X-1 to "Axe" and it sorts first.
2. Coordinate detection only works when the **whole** `q` parses. `q=tent r1` returns `[]`: "r1" is not a
   substring of "r01-…", and "tent r1" is not a coordinate. Typing a name plus a rack is a natural way
   to narrow results.

**Fix.** Check each token with `parseLocation`. If a token parses to a rack, match it with
`location_code = @loc OR location_code LIKE @loc || '-%'` and do not use the substring `instr` for that
token. Add a rank tier for an exact `location_code = @loc` hit (just after the exact code match).

### m5. Duplicate code within one file is counted as created **and** updated, and the preview is misleading
`backend/src/services/importer.js:108-135`

**Problem.** A new code that appears on two rows gives `created: 1, updated: 1` for one item. Verified
with `NEW-1` on rows 5 and 6: the counts were `created 1, updated 3` for 3 distinct items. In a dry run,
the second preview entry also has `action: "update", id: null`, which is an update of an item that does
not exist yet. The "Confirm import" screen will show inflated numbers.

**Fix.** Count distinct codes. For a duplicate, keep the first row's action (`create` stays `create`),
replace its preview entry instead of adding a second one, and keep the existing warning.

### m6. The location parser rejects en/em dashes
`backend/src/lib/location.js:10`

**Problem.** `SEP` only allows the ASCII `-`. Excel/Word AutoCorrect and copy-paste often produce
`R03–B–2` (U+2013) or `R03—B—2`. Verified: these are kept as unparsed text with rack null (a warning is
raised). The item does not appear on the map.

**Fix.** Add `‐-―−` (and possibly full-width `－`) to `SEP`, or normalise the string first.

---

## Nit

### n1. `headersFound` shows the title row, not the header-like row
`backend/src/lib/importRows.js:39-46`. For `Laporan Stor` above `Kod,Barang X` the 400 response gives
`headersFound: ["Laporan Stor"]`. **Fix:** use the cells of the best candidate row from `findHeaderRow`
when there is one.

### n2. Quantity and id coercion are too lenient
`backend/src/lib/itemSchema.js:33-39, 65`.
- `Number()` accepts hex and exponents: `POST {"quantity":"0x10"}` stored **16** (verified), `"1e3"` → 1000.
- `GET /api/items/1e2` is treated as id 100.
- In the import, `parseQuantity("0x10")` gives quantity 0 with unit `"x10"`.

**Fix:** require `/^\d+$/` before converting.

### n3. Migration version is read outside the transaction
`backend/src/db/index.js:23-31`. The version check happens before `BEGIN`. If two processes start on a
fresh DB at the same time (e.g. `npm run seed` while `npm run dev` starts), both apply v1, and the
second crashes on the `schema_version` primary key. Phase 2 `ALTER TABLE` migrations cannot be written
with `IF NOT EXISTS`. **Fix:** run each step in `db.transaction(...).immediate()` and re-read
`MAX(version)` inside it.

### n4. Importing `app.js` has a side effect
`backend/src/app.js:62`. `export const app = createApp()` opens and migrates `DB_PATH` (default
`data/store.db`) whenever the module is imported, even by code that only wants `createApp`. **Fix:** move
the default instance into `server.js`, or create it lazily.

### n5. Import reports unchanged rows as `updated` and bumps `updatedAt`
`backend/src/services/items.js:95-112`, `importer.js:118`. Re-importing the same file says "updated 28"
and changes every timestamp. **Fix:** compare the merged item with the existing one, skip the write when
nothing changed, and report an `unchanged` count.

### n6. Numeric shelves from separate columns can't be used
`backend/src/lib/location.js:67-73`. Rack 3 / Shelf 2 / Bin 1 columns become the text `"3-2-1"` (with a
warning). This follows the spec (shelves are letters). Many store rooms number their shelves, though, so
when the real file arrives consider mapping 1→A, 2→B in `combineLocation`, either behind an option or
only when the shelf column is all numbers.

### n7. Phase 2 schema readiness: hard delete
`backend/src/db/migrations.js`, `services/items.js` `deleteItem`. `DELETE /api/items/:id` removes the row
for good. With `foreign_keys = ON` (good), Phase 2 loan rows that reference `items.id` will either block
the delete (unexpected 500, not 409) or need a cascade that loses history. **Fix (Phase 2):** add
`ON DELETE RESTRICT` and map `SQLITE_CONSTRAINT_FOREIGNKEY` to 409, or use soft delete / `written_off`.

---

## Verified as correct (no action)
- All SQL is parameterized. The dynamic parts of `listItems` (`SEARCH_FIELDS`, `ORDER BY`) are constants,
  and `instr` avoids LIKE wildcard problems. No injection path found.
- Duplicate code on POST and on PUT (case-insensitive) → 409 `{ field: "code" }`. The UNIQUE constraint
  is also mapped to 409, which covers races.
- Search ranking (exact code → code prefix → name prefix → rest, ties by name), AND logic for several
  words, the `rack` filter accepting `3`/`r3`/`R03`, invalid `condition` → 400, and array query params → 400.
- `/api/racks` (numeric sort, `unlocated`), `/api/racks/:rack` (404 for empty, 400 for invalid,
  `unshelved`), `/api/categories` (merged case-insensitively).
- Import: `dryRun` defaults to true; invalid `dryRun` → 400; > 5 MB → 413; `.xls`/`.txt` → 400 with a
  hint; a non-zip or corrupt `.xlsx` → 400; empty file → 400; wrong field name or two files → 400.
  The header is detected below title rows. Rich text, hyperlinks, formula results and error cells are
  flattened. Hidden sheets are skipped. Malay headers and conditions work. `"5 pcs"` is split into
  quantity and unit. The real import runs inside one `db.transaction`, and the dry-run results matched
  the real import.
- Error bodies always have the shape `{ error: { message, details? } }`, and 500 responses never include
  internal details.
- No dead code of note.

## Overall verdict
**Approve once M1 and M2 are fixed.** The code is clean, well structured and safe (parameterized SQL,
transactional import, consistent error shape, good test seams). The two Major issues both corrupt
locations or statuses silently, which defeats the purpose of Phase 1 ("see which rack it is in"). Both
fixes are small and local. m1–m6 should be fixed before the real quartermaster file is imported (m3 and
m6 especially, since real spreadsheets are likely to hit them). The Nits can wait until Phase 2.

---

## Round 2 verification (commit `b27ebb9`)

How I checked: I re-read every changed file in `backend/src` and ran the full vitest suite
(9 files, 405 tests, all passing). I re-ran every Round 1 reproduction against a fresh server
(`PORT=3101`, temp `DB_PATH`, seeded, stopped afterwards). I also tried to get past the new
`xlsxGuard.js`.

### Status of Round 1 findings

| # | Finding | Status | Evidence |
|---|---|---|---|
| M1 | Shelf/bin keyword read as a rack | **Fixed** | `Bin 5`, `Level 2`, `Shelf 3`, `Slot 7`, `Petak 1`, `Pos 3`, `No. 4` and `Tingkat 2` are now kept as text (rack null). `Rack No. 3`, `Rak 3 Tingkat B Petak 2` and `R03 B No 2` still parse. `normalizeRack("bin 3")` returns null, so `/api/racks/bin%203` → 400. `q=bin 2` no longer returns rack R02. |
| M2 | Blank cells wipe existing data | **Fixed** | I re-imported the Round 1 file with `dryRun=false`. CKG-012 kept `damaged` and its notes, TNT-001 kept `R01-A-1`, and both were reported as `unchanged`. `updatedAt` was not changed. |
| m1 | Compressed `.xlsx` loaded before limits | **Partially fixed** | The normal-name file is now rejected in 0.2 s with about 140 MB peak memory. The guard can be bypassed, though: see **R2-1**. |
| m2 | 500 for busboy/body-parser client errors | **Fixed** | Truncated multipart → 400. Missing boundary → 400. `charset=latin2` → 400. An unknown `Content-Encoding` → 400. All use the standard error shape. |
| m3 | Duplicate columns dropped silently | **Fixed** | For `ID,Code,Name,Description,Remarks,Keterangan`, `ignoredColumns` lists ID, Description and Keterangan as duplicates. With `Kod,Nama,Lokasi,Keterangan`, Keterangan becomes `notes` ("Zip rosak"). |
| m4 | Coordinate search imprecision | **Fixed** | `q=R03-B-1` no longer returns R03-B-10. `tent r1` and `r3 rope` work. In `q=R03-A-1`, the exact-location item ranks above a notes-only match. Unicode matching works (`öl` and `ÖLFASS` both find "Ölfass"). |
| m5 | Duplicate code counted twice | **Fixed** | NEW-1 on rows 5 and 6 → `created: 1`, a single preview entry (row 5, final values), and one warning. |
| m6 | En/em dashes rejected | **Fixed** | `R03–B–2` and `R03—B—2` → `R03-B-2`. |
| n1 | `headersFound` shows title row | **Fixed** | It now shows `["Kod","Barang X"]`. |
| n2 | Lenient quantity/id coercion | **Fixed** | `quantity:"0x10"` → 400. `/items/1e2` and `/items/0` → 400. In the import, `"0x10"` now gives a warning and the quantity is left unchanged. |
| n3 | Migration race | **Fixed** | The step runs in `.immediate()` and the version is re-read inside the transaction. |
| n4 | `app.js` import side effect | **Fixed** | The default app is created lazily. `server.js` opens its own DB. No test uses `app.locals` or `app.listen`. |
| n5 | No-op rows reported as updated | **Fixed** | There is a new `unchanged` count. The write and the `updatedAt` change are skipped when nothing differs. |
| n6 | Numeric shelves from separate columns | **Not fixed (deferred)** | `3`/`2`/`1` columns still become the text `"3-2-1"` with a warning. This follows the spec. Revisit when the real file arrives. |
| n7 | Hard delete for Phase 2 | **Acknowledged** | It is documented as a Phase 2 note in SPEC.md, which is fine for now. |

### New findings

#### R2-1 (Minor) — `xlsxGuard` counts rows by entry name and exact tag bytes, so it is easy to get past
`backend/src/lib/xlsxGuard.js:37-38, 114-118`

**Problem.** The guard only counts rows and cells in entries matching `^xl\/worksheets\/[^/]+\.xml$`,
and only the byte patterns `<row ` / `<row>` and `<c ` / `<c>`. ExcelJS reads the zip differently in
two ways:
- It strips a leading `/` from entry names and matches worksheets with the **unanchored**
  `/xl\/worksheets\/sheet(\d+)[.]xml/` (`node_modules/exceljs/lib/xlsx/xlsx.js:284, 361`).
- Its XML parser accepts any whitespace after the tag name, for example `<row\nr="1">`.

**Verified.** I took a 2.9 MB workbook with 2 × 175,000 rows. With normal names it is rejected by the
guard in 0.2 s. I then built two variants: one with the sheet entries renamed to
`/xl/worksheets/sheetN.xml`, and one with `<row ` / `<c ` replaced by `<row\n` / `<c\n`. For both,
`checkXlsx` returned `{ rows: 0, cells: 0 }`. ExcelJS then loaded all 350k rows before the 20,000-row
check: 5 s and **764 MB** peak RSS per request, and **1.84 GB** with three uploads at once.

The 48 MB uncompressed cap still bounds each request, so this is better than Round 1. Even so, the
guard's own target (about 190 MB) is easily exceeded by a deliberately crafted file. Normal Excel
output is not affected.

**Fix.**
- Count the tags with a regex that allows whitespace and an optional prefix, e.g.
  `/<(?:[\w.-]+:)?row[\s>\/]/g` and `/<(?:[\w.-]+:)?c[\s>\/]/g`.
- Run it on **every** inflated entry instead of choosing entries by name. Alternatively, normalise
  names the way ExcelJS does (strip a leading `/`, unanchored match).
- Optionally allow only one import at a time, since each load is CPU- and memory-heavy.

#### R2-2 (Nit) — the 240,000-cell cap also applies to CSV and counts empty cells
`backend/src/services/importer.js:46`, `xlsxGuard.js:116`

The cell cap exists because ExcelJS uses about 0.75 KB per cell. It is also applied to CSV, which is
parsed into plain strings and doesn't need it. Empty trailing cells count too: a CSV with 1,000 rows
× 302 mostly-empty columns is rejected with "too many cells". The same goes for any file over 12
columns × 20,000 rows. The limit is documented in SPEC.md and a scout troop will not hit it, so this is
a Nit. If it is kept, consider dropping the cap for CSV, or counting only non-empty cells there.

#### R2-3 (Nit) — unknown condition text still overwrites an existing item's condition with `good`
`backend/src/lib/importRows.js:118-123`

"A blank cell never changes an existing item" now holds. But for an existing `damaged` item, a
condition cell with unrecognised text (e.g. `rosak teruk sekali`) still sets it to `good`, with a
warning. That follows the spec ("unknown → good + warning"), but it no longer matches how quantity is
handled ("not a whole number → left unchanged"). Suggestion: for existing items, keep the current
condition and say so in the warning. Update the spec line if this is adopted.

### Round 2 verdict
**Approve.** Both Major findings and Minors m2–m6 are fixed, and I verified each one against the
running server. The new import counts and the "blank never changes" rule work, and all 405 tests pass.
The one remaining item worth doing before the app is exposed beyond trusted users is **R2-1**, a
one-line regex change plus dropping the entry-name filter. R2-2 and R2-3 are optional.

---

## Phase 1.5 review (commit `599115c`)

Scope: `backend/src/auth/*`, `app.js` (headers, static/SPA, write gating), `server.js`, `lib/env.js`,
`lib/scanMatch.js`, `routes/scan.js`, migration v2, `services/backup.js`, `scripts/{set-pin,backup}.js`,
the import and search changes, `windows/*.ps1|*.bat`, and `docs/SETUP-WINDOWS.md`.

How I checked:
- I ran the server on `PORT=3101` with a temporary `DB_PATH`, `CONFIG_PATH` and `BACKUP_DIR`, and a
  stand-in `FRONTEND_DIST`. Afterwards I stopped it and deleted the temporary files.
- I tried every write route without a token, with bad tokens and with a valid token, and attacked
  login, the token, static serving and the scan endpoint.
- I migrated a real v1 database, and benchmarked scan matching with 5,000 items and 2,000-character
  noisy text.
- The vitest suite passes: 10 files, 532 tests.
- Windows items were reviewed by reading only. They are marked **(needs Windows verification)**.

**Counts:** Critical 1 · Major 2 · Minor 7 · Nit 8

### Critical

#### P1 — Sending many login requests at once gets past the PIN rate limit; a 4-digit PIN falls in about an hour
`backend/src/auth/index.js:165-182`, `auth/rateLimit.js:201-225`

**Problem.** The login handler calls `limiter.check(ip)`, then `await verifyPin()` (scrypt, about
40-100 ms on the thread pool), and only then `limiter.fail(ip)`. Any number of requests that arrive
before the first wrong try is recorded all pass `check()`. The 5-per-IP and 20-global limits only
start working once the first scrypt finishes.

**Verified from one client:**
- 200 parallel logins with PINs 4700-4899 → **132 × 401, 67 × 429, and 1 × 200: PIN 4821 found in a
  single burst.**
- 1,000 parallel logins → **591 PINs actually checked** (instead of 5) in 22 s.

So one phone on the troop Wi-Fi can try about 600 PINs every 5 minutes. All 10,000 four-digit PINs take
about 85 minutes (about 40 on average), and an old laptop is no protection because scrypt runs per
request. The same bursts also keep the server's CPU and thread pool busy (backups and file I/O share
the pool).

**Fix.** Reserve the attempt *before* the `await`:
- Count in-flight attempts per IP and globally in `check()`/`begin()`.
- Treat `pending + recent failures >= limit` as blocked.
- Release the reservation as a failure or a success when scrypt returns.

Simplest of all: allow at most 1 login in flight per IP and about 2 globally (reply 429 to the rest).
Add a test that fires 50 parallel wrong logins and expects at most 5 to be checked.

### Major

#### P2 — Any Windows user can change code that runs as SYSTEM, and can read the PIN hash and token secret (needs Windows verification)
`windows/install.ps1:97-107`, `windows/start.bat:12-14`, `docs/SETUP-WINDOWS.md` §5, `auth/config.js:42`

**Problem.** The guide puts the app in `C:\eTroop`. A folder created directly under `C:\` inherits
**Authenticated Users: Modify** from the root of the drive. Nothing in `install.ps1` narrows this. The
startup task then runs `start.bat` → `node.exe src\server.js` (and everything in `node_modules`) as
**SYSTEM**.

Three consequences:
1. Any standard (non-admin) account on the laptop, such as a shared "Scouts" login, can edit
   `windows\start.bat`, `backend\src\*.js` or `node_modules`, and that code runs as SYSTEM at the next boot.
2. `start.bat` uses `where node.exe`, and cmd searches the **current directory** (`backend\`) before
   PATH. A `node.exe` dropped into `C:\eTroop\backend` would be run as SYSTEM.
3. `data\config.json` is readable by every user. `mode: 0o600` has no effect on Windows. That gives
   them the scrypt hash (a 4-digit PIN is cracked offline in minutes) and `tokenSecret`, which lets
   them forge leader tokens directly.

**Fix.**
- In `install.ps1`, lock the install folder down:
  `icacls "$RepoRoot" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX"`.
  Only SYSTEM and Administrators may write. Note that `npm run set-pin` then needs an admin prompt, so
  update guide §10, or add a `set-pin.bat` that elevates.
- In `start.bat`, use an absolute node path recorded at install time, e.g. `(Get-Command node.exe).Source`
  written into the task arguments or an env var. Never rely on a bare `node.exe` from the current
  directory.
- Alternatively, run the task as `LOCAL SERVICE` with write access to `backend\data` only.

#### P3 — Scan matching gives short or numeric item codes a perfect score from unrelated label text
`backend/src/lib/scanMatch.js:27-35, 86-98, 130-134`

**Problem.** Codes are compared after OCR folding (`O→0, I/L→1, S→5, B→8, Z→2`), against joins of up to
5 neighbouring words, with only a `length >= 3` guard. A code match adds weight 1, so it beats any real
brand+model+name match. Ties are broken by code.

**Verified:**
- For the label text `"Coleman dome tent / AC 220-240V 50Hz / Made in China 2024 / TNT - 0 O 4"`, items
  with codes **`2024` and `220` score 1.0 and rank above `TNT-004`** (also 1.0).
- `"Do not B O I L water"` gives code `BOIL` a score of 1.
- With numeric codes, everyday words fold into them: `OIL`→`011`, `SOS`→`505`, `ZOO`→`200`.

The quartermaster's real file has "item code" with an unknown format. Short or numeric codes such as
`001` or `102` are common in troop inventories, and the scan screen would then show the wrong item first.

**Fix.**
- Only count a code match when the folded code has at least 4 characters **and** contains at least one
  character that was a letter in the original code. Or, for all-digit codes, require that the matching
  window comes from a single OCR word.
- Give all-digit codes a lower weight (e.g. 0.4).
- Break ties by the number of other fields matched, not by code.

Check this against the real code format when the file arrives.

### Minor

#### P4 — A damaged or empty `config.json` cannot be repaired with the tool the error message names
`backend/src/auth/config.js:26-36, 70-77`, `auth/index.js:150, 173`

Writes return 503 "Leader settings file is damaged. **Run set-pin** on the laptop." But `setPin()` calls
`readConfig()` first, and that throws. Verified: `set-pin --pin 1111` on `{bad` or on a 0-byte file
exits with code 1 and prints a JSON error. `writeConfig` doesn't `fsync` before the rename, so a power
cut on an old laptop can leave exactly that 0-byte file. In this state, `/auth/login` answers 403 "PIN
not set" and `/auth/status` says `pinSet:false`, which contradicts the 503. Each write also logs a full
stack trace, because 503 ≥ 500.

**Fix.**
- In `setPin`, treat an unreadable config as `{}`, after renaming the bad file to `config.json.broken`.
- `fsync` the temporary file before the rename.
- Give login and status the same "damaged" message.
- Don't log stacks for `HttpError` 503.

#### P5 — Anyone on the Wi-Fi can lock every leader out indefinitely (global cap)
`backend/src/auth/rateLimit.js:216-220`

20 wrong PINs from anywhere block **all** logins for 5 minutes. A scout's phone sending 20 wrong PINs
every 5 minutes keeps the leaders out for good. This follows the spec, but now that P1 shows the
per-IP limit is what really matters, consider:
- Exempting `127.0.0.1`/`::1` (the laptop itself) from the global block.
- Not counting IPs that have logged in successfully in the last 30 days.
- Lowering the global block to 1 minute.

Either way, tell the guide's troubleshooting section that login works on the laptop at
`http://localhost:3001`.

#### P6 — `update.ps1`, the restore procedure and "start again" all need a full reinstall, and a failed update leaves the app stopped (needs Windows verification)
`windows/update.ps1:27`, `windows/stop.ps1:8`, `docs/SETUP-WINDOWS.md` §11 step 4 and §13

- If `Install-AppDependencies` fails after a successful `git pull` (no internet, or the better-sqlite3
  prebuilt download is blocked), `Stop-WithError` exits with the task **stopped**, and
  `node_modules` was already deleted by `npm ci`. The message "Nothing else was changed after this
  step" is wrong here.
- To start the app after `stop.bat`, or after a restore, the guide says to run `install.bat`. That
  re-runs `npm ci` and the build, which needs internet and 5-15 minutes.

**Fix.**
- Add `start.ps1`/`start.bat` (`Start-ScheduledTask` + `Wait-ForServer`), and use it in the guide.
- In `update.ps1`, wrap the install step so that on failure it says clearly that the app is stopped and
  how to retry. Alternatively, run `npm ci` into a staging copy before stopping the app.

#### P7 — Scan endpoint: about 120 ms of blocking work per request, public and unthrottled
`backend/src/routes/scan.js:305-310`, `lib/scanMatch.js`

Each request runs `SELECT *` on every item and builds the Item objects, then re-tokenises every
item's fields. **Measured:** 5,000 items with 2,000-character text took 108-137 ms per request, with the
event loop blocked for that time, and 20 parallel requests took 1.3 s. An old laptop will be several
times slower.

This is fine for a few phones. But it's public, so one misbehaving client loop can keep the server
busy, and it grows linearly with the number of items.

**Fix.** Cache the item list and each item's pre-tokenised and folded fields, and invalidate the cache
on any write (a version counter bumped in create/update/delete/import). Optionally add a simple
per-IP limit of a few requests per second.

#### P8 — The startup task finds node through the PATH of SYSTEM (needs Windows verification)
`windows/start.bat:12-14`, `install.ps1:13-21`

`install.ps1` checks `node.exe` in the *admin user's* PATH, but the task runs as SYSTEM, which only
sees the machine PATH, falling back to `%ProgramFiles%\nodejs`. If Node was installed per user (nvm-windows,
fnm, winget user scope or a portable zip), the install succeeds but `start.bat` loops every 10 s,
logging "not recognized", and phones can't connect.

**Fix.** Save `(Get-Command node.exe).Source` at install time. Refuse paths under `C:\Users\` with a
clear message, and pass the path to `start.bat`. This also fixes part of P2.

#### P9 — Dry run and real import can disagree on a barcode moved between items
`backend/src/services/importer.js` (`barcodeOwner` / `getItemByBarcode`)

Take a file where row 3 changes item A's barcode from X to Y, and row 5 gives X to item B. In the real
import, A has already been updated inside the transaction, so B gets X. In the dry run, the database
still says A owns X, so B gets a "barcode not changed" warning. The preview then doesn't match what the
real import does.

**Fix.** In the dry run, keep the in-file view: record "A released X" in `barcodeOwner` when a row
changes A's barcode, and check that map before the database.

#### P10 — Firewall rule allows any remote address (needs Windows verification)
`windows/install.ps1:74-75`

The rule is limited to the Private profile, which is good, but has no `-RemoteAddress`. Adding
`-RemoteAddress LocalSubnet` keeps the app reachable only from the troop Wi-Fi subnet, even if a
VPN or USB tethering connection is also classed as Private.

A related point for the guide's troubleshooting section: if anyone ran `npm start` by hand and clicked
**Cancel** on the "Windows Security Alert" for node.exe, Windows creates **Block** rules for node.exe.
Block wins over our Allow rule. Add "Windows Defender Firewall → Allow an app → remove/allow Node.js
JavaScript Runtime" to the troubleshooting.

### Nit

- **N1** `npm run set-pin -- --pin 1234` shows the PIN on screen, because npm echoes
  `> node scripts/set-pin.js --pin 1234` (verified). It also ends up in shell history. `install.ps1`
  doesn't use `--pin` (good). Mention this in the `--help` text, or accept the PIN from stdin instead.
- **N2** Token signatures are decoded with the lenient `Buffer.from(sig, 'base64url')`, so `token + "!"`
  is still accepted (verified 204). This is not a forgery, but compare the canonical form: re-encode
  `got` and require it to equal `sig`.
- **N3** `loginSchema` accepts `pin` as a JSON number, so `0123` can never work and `123` counts as a
  wrong try. Accept strings only.
- **N4** `server.log` is only rotated when the server (re)starts (`start.bat:25-31`). A server that runs
  for months never rotates. Output is small today, so this is low risk.
- **N5** A missing static file (`/assets/missing.js`, `/favicon.ico`) returns Express's default HTML
  404 page. This leaks nothing, but a short plain-text 404 would be tidier.
- **N6** `createItem`/`updateItem` race → `SQLITE_CONSTRAINT_UNIQUE` maps to a generic "Duplicate item
  code or barcode" without `details.field`, unlike the checked path.
- **N7** `HOST` now defaults to `0.0.0.0` for `npm run dev` too, so a developer's laptop serves the API
  to its whole network. Consider `0.0.0.0` only when `NODE_ENV=production`.
- **N8** Guide: mention that the Google Drive copy only syncs while someone is logged in to the laptop.
  The `$RepoRoot` path goes through `Resolve-Path`, which treats `[ ]` as wildcards; this is fine for
  the recommended `C:\eTroop`.

### Verified as correct (no action)

**Write protection**
- Every write needs the token, and I tried them all. Without a token, these return **401**:
  - `POST /items`, `POST /items/`, `PUT /items/1`, `DELETE /items/1`, `DELETE /items/1/`,
    `PATCH /items/1`, `OPTIONS /items`, `DELETE /items`
  - `POST /ITEMS` and `POST //items`
  - `POST /import?dryRun=true` (with a file) and `POST /import` (empty)
- Auth runs **before** multer, so unauthenticated uploads are never parsed.
- With a valid token, writes succeed. `bearer` is case-insensitive.
- Public endpoints work without a token: GET/HEAD items, template download, `/scan/match`,
  `/auth/status`.

**Tokens and PIN**
- HMAC-SHA256 with a 32-byte random secret, compared with `timingSafeEqual` after a length check.
  An edited payload (`exp` changed) → 401. Expired tokens → 401 with the expired message.
- The secret rotates on `set-pin`, and the running server notices via the stat stamp.
- scrypt N=2^15, r=8, p=1, 16-byte salt and a 32-byte key are appropriate. `verifyPin` is async and
  uses a constant-time compare.
- `config.json` is written atomically with mode 0600 on POSIX. The PIN never appears in server logs.

**Rate limiting (sequential requests)**
- 5 wrong tries → 429 with `Retry-After: 300` and `details.retryAfterSeconds`. The right PIN also gets
  429 while blocked.
- **`X-Forwarded-For` is ignored** (`trust proxy` is off), so spoofing XFF gets no extra tries.

**Static serving and headers**
- No traversal: `/../config.json`, `%2e%2e`, `..%2f`, `..%5c` → 404.
- Dotfiles are never served: `/.env` and `/.git/config` → the SPA `index.html`.
- `/api`, `/api/` and `/api/nope` → JSON 404, never `index.html`. `/assets/missing.js` → 404.
- `.wasm` is served as `application/wasm`. `assets/*` is immutable-cached, other pages are `no-cache`,
  and the API is `no-store`.
- The CSP and other security headers are on every response, as documented. No CSRF exposure: the token
  is a header, not a cookie.

**Migration v2**
- On a real v1 file database, v2 applies once and the version is recorded. Existing rows get
  null brand/model/barcode. `unlocated` works. The unique barcode index gives 409. Reopening is a no-op.

**Backups**
- `.partial` file then rename. Rotation deleted only `store-YYYY-MM-DD.db` files:
  `notes.txt`, `store-backup.db` and `store-2020-01-01.db.bak` were kept.
- `BACKUP_DIR` set to the data folder itself is safe: `store.db` and its `-wal`/`-shm` files are untouched.
- `BACKUP_DIR` pointing at a file, or below one → warning, and the server keeps running.
  Out-of-range `BACKUP_KEEP`/`BACKUP_HOUR` fall back to the defaults.

**Scan matching**
- OCR folding and joining split words work as specified: `TNT - 0 O 4` → `TNT-004`.

**Windows scripts (by reading)**
- PowerShell 5.1 syntax only (no `??`, ternaries or PS 7 cmdlets), plain ASCII with CRLF
  (`.gitattributes`).
- `-LiteralPath` is used throughout, and the scheduled-task argument quoting `/c ""…start.bat""` is
  correct for paths with spaces.
- Task, firewall rule and `.env` handling are idempotent (remove + recreate). The firewall rule is
  Private-only.
- powercfg only changes AC settings. Self-elevation handles a "No" at the UAC prompt.

**Guide**
- The guide is clear and in the right order for a non-technical leader. It covers 64-bit, the
  Private network, DHCP reservation, guest Wi-Fi, "Not secure", Add to Home screen and restore.

### Phase 1.5 verdict
**Changes required before deployment: P1 (Critical) and P2 (Major).**
- **P1** is a few lines in the login path, and its test is easy.
- **P2** is an `icacls` call plus an absolute node path in `start.bat`, which also covers P8. It needs a
  check on a real Windows 10 machine.
- **P3** should be decided when the real item-code format is known.

Everything else is solid: token design, write gating, static serving, headers, migration and backup
rotation all held up under direct testing.

---

## Phase 1.5 verification (commit `29b3df5`)

How I checked:
- I re-ran the P1 and P3 reproductions against a fresh server (`PORT=3101`, temporary DB,
  `CONFIG_PATH` and `BACKUP_DIR`; stopped and deleted afterwards).
- I read every change in `windows/`, `rateLimit.js`, `windowLimiter.js`, `scan.js` and migration v3.
- I ran the vitest suite: 791 of 792 tests pass. The one failure is in the tester's **uncommitted**
  `tests/phase15-fix-tester.test.js` ("search: the scanned UPC with its leading zero…"). I could **not**
  reproduce it through `listItems`: `q=098765432105` finds the item stored as `98765432105`. It probably
  depends on that file's fixtures. The tester should confirm before it counts as a bug.
- Windows points were checked by reading only. They are marked "needs Windows verification".

| # | Status | Evidence |
|---|---|---|
| P1 login burst | **Fixed** | 200 parallel logins → 4 × 401 and 196 × 429 (immediate "at once" message); the correct PIN was **not** found. 1,000 parallel → 4 checks and 996 × 429 in 0.8 s. Sequential: 5 × 401, then a 429 block. Each attempt is now reserved before scrypt (`begin`/`done` in `try/finally`, so nothing leaks on errors). |
| P2 SYSTEM code / data readable | **Fixed** (needs Windows verification) | `Protect-AppFolder`: owner Administrators; inheritance removed; SYSTEM and Admins Full, Users RX; children `/reset`; `backend\data` SYSTEM/Admins only. The approach is correct. On a real laptop, check that `icacls /setowner *S-1-5-32-544` accepts the `*SID` form, and that `/reset` with `root\*` also covers the hidden `.git` folder. |
| P3 numeric/short codes | **Fixed** | Appliance label text gives `TNT-004` 1.0. `2024` only gets 0.35 (whole word). `220` and `220-240V` give no code match. `B O I L` gives no match. `OIL` / `SOS` / `ZOO` give no code match. `Whistle 505` → 0.65, a legitimate whole-word match. `COLEMAN SUNDOME 4P` ranks "Sundome 4P" above "Sundome 4". Spaced `T N T - 0 0 4` and `tnt004` → 1.0. |
| P4 damaged config | **Fixed** | An empty `config.json` → 503 on login **and** status. `--check` exits 2. `set-pin` without `--force` refuses with a clear hint. `--force` repairs it and keeps `config.json.broken-<time>`. The new PIN works immediately. Nothing is logged as a crash. |
| P5 global lock-out | **Fixed** | The global cap is now a slowdown (bucket of 10, refills 1/s). Simulated: 250 hopping IPs over 5 minutes → 309 checks, and a leader on a fresh IP waits about 1 s, not 5 minutes. |
| P6 update/start flow | **Fixed** (needs Windows verification) | `update.ps1` uses try/catch/finally and always runs `Start-StoreRoomTask`, then says honestly whether the app is running. `start-app`, `set-pin`, `settings` and `backup-now` are elevated helpers, and the guide uses them. The restore procedure ends with `start-app.bat`. |
| P7 scan cost | **Fixed** | The index is cached and invalidated via `total_changes()` + `data_version`. Requests are limited to 30/min per IP: the 26th quick request got 429 with `Retry-After: 60`. |
| P8 SYSTEM PATH node | **Fixed** (needs Windows verification) | `Get-SystemNodePath` refuses `C:\Users\…` and `AppData` paths. `node-path.txt` is written with `[IO.File]::WriteAllText` (UTF-8 without BOM, so `set /p` reads it cleanly). `start.bat` uses only that path, quoted, plus an absolute `PING.EXE`, and logs and exits if the path is missing. |
| P9 dry/real barcode | **Fixed** | According to the spec and the code, barcode ownership is planned once for both runs. The tests cover it, and I did not re-test it by hand. |
| P10 firewall | **Fixed** (needs Windows verification) | `-RemoteAddress LocalSubnet` was added. Block rules for node.exe are detected with `Get-NetFirewallApplicationFilter \| Get-NetFirewallRule` (PS 5.1 pipeline), and removed only after a Y/N prompt. |
| N1 / N2 / N3 | **Fixed** | The `--pin` warning is in `--help`. `token + "!"` → 401 (canonical signature only). A barcode sent as a number → 400, and `ß12` → 400. |

### New findings

#### V1 (Minor) — Migration v3 fails on a v2 database where two barcodes differ only by leading zeros, so the server cannot start
`backend/src/db/migrations.js` (v3)

v2 allowed `012345678905` on item A and `12345678905` on item B. v3 creates a UNIQUE index on
`ltrim(barcode,'0')` without cleaning up first. **Verified:** on such a database, `openDb` throws
`SQLITE_CONSTRAINT_UNIQUE … idx_items_barcode_key`. The transaction rolls back, so no data is lost.
But `start.bat` then restarts a crashing server every 10 s, and phones can't connect.

It's Minor only because v2 has probably not been deployed anywhere. If any laptop ran v2 with
imported barcodes, it becomes Major.

**Fix.** Before `CREATE UNIQUE INDEX` in v3, keep the barcode on the lowest id and clear it on the
others, recording it in their notes. For example:
`UPDATE items SET notes = trim(notes || ' [duplicate barcode ' || barcode || ' removed]'), barcode = NULL WHERE barcode IS NOT NULL AND id NOT IN (SELECT MIN(id) FROM items WHERE barcode IS NOT NULL GROUP BY ltrim(barcode,'0'))`.

#### V2 (Nit) — Leftover login risk with IP hopping
With the global bucket at 1 wrong try per second, an attacker who can switch between many LAN IPv4
addresses still gets about 3,600 tries per hour. A 4-digit PIN is then found within about 3 hours;
a 6-digit PIN would take about 12 days. This is acceptable, given the 6-digit recommendation in the
guide. Consider making 6 digits the minimum in `set-pin`, and still accepting existing 4-digit PINs.

#### V3 (Nit) — `settings.ps1` sends the user to `install.bat` after a port change
`install.bat` re-runs the full install (`npm ci` + build, which needs internet) only to update the
firewall rule. `settings.ps1` could recreate the rule itself with the same `New-NetFirewallRule` call.

### Verdict
**Approve for deployment, after V1 and a check on a real Windows 10 laptop.** All of P1–P10 are
fixed. P1 and P3 held up against the original reproductions. The Windows changes are sound and
PowerShell 5.1 compatible as far as can be judged by reading. Before go-live, on a real Windows 10
laptop:
- run `install.bat` twice (to check it can be re-run safely);
- confirm with `icacls C:\eTroop` and `icacls C:\eTroop\backend\data` that a standard user cannot
  write the app or read its data;
- reboot without logging in and open the app from a phone;
- run `update.bat` once with the internet unplugged, to see the failure path.
