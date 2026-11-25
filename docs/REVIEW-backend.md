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
