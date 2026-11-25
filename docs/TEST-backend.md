# Backend test report (Phase 1)

Run: `cd backend && npm test` (Vitest 5 + Supertest, Node 22). Every test uses an in-memory SQLite DB
(`createApp(openDb(':memory:'))` per test or per `describe`). `backend/data/store.db` was never opened
(I checked its sha256 before and after). No real server was started.

## Result

**359 tests: 349 passed, 10 failed.** All 10 failures are **app bugs** (2 root causes). None are test bugs.

| File | Tests | Pass | Fail |
|---|---:|---:|---:|
| `tests/smoke.test.js` (existing, unchanged) | 3 | 3 | 0 |
| `tests/location.test.js` | 83 | 76 | 7 |
| `tests/lib.test.js` | 102 | 102 | 0 |
| `tests/items.api.test.js` | 51 | 50 | 1 |
| `tests/search.api.test.js` | 39 | 37 | 2 |
| `tests/categories-racks.api.test.js` | 19 | 19 | 0 |
| `tests/import.api.test.js` | 62 | 62 | 0 |
| **Total** | **359** | **349** | **10** |

`tests/helpers.js` holds the shared helpers: fresh app/db, shape assertions, and xlsx/csv builders that use exceljs.
`package.json` was not changed, because Vitest and Supertest were already there.

## What is covered

- **Health and general errors.** `GET /api/health` returns `{ok:true}`. Unknown `/api` route gives a JSON 404, malformed JSON gives 400 and a body over 100 kb gives 413. Every error is checked for the `{ error: { message, details? } }` shape.
- **POST /api/items**
  - Defaults are applied, the code is uppercased and trimmed, the location is normalised and the full Item shape is checked key by key. All 4 conditions are accepted.
  - An odd location is kept as text. Body `id`, timestamps, `rack`, `shelf` and `bin` are ignored. `''` and `null` become `null` or the default. A numeric code or quantity string is coerced.
  - 400 with `details[].path` for: missing or blank code, missing or blank name, negative, fractional or text quantity, bad condition, code or name too long, an object as the name, an empty body and an array body.
  - 409 for a duplicate code, compared case- and whitespace-insensitively.
- **GET, PUT and DELETE /api/items/:id**
  - GET returns 200, 404 for an unknown id and 400 for `abc`, `0`, `-1` and `1.5`.
  - PUT: partial update, `updatedAt` moves while `createdAt` stays, and a changed location re-derives rack, shelf and bin. Clearing the location works with `null` and `''`. A whole Item can be sent back, and an empty body returns the item unchanged.
  - PUT also covers code case, 409 on another item's code, 400 for invalid patches (the item stays unchanged), 404 and 400.
  - DELETE: 204 with an empty body, then 404 on GET and on a second DELETE, and the code can be reused afterwards.
- **GET /api/items search and filters**
  - No `q` returns everything sorted by code (seed data), and a blank `q` does the same.
  - Matching works on code, name, category, location text and notes, case-insensitively. Several words must all match.
  - `%` and `_` are taken literally, and SQL-like input is harmless. `q` over 200 characters and a repeated `q` both give 400.
  - Coordinate-like `q` (`r3-b`, `R3 B`, `R3 A 1`, `3-a-10`, `r3`) matches the normalised location.
  - **Ranking:** exact code, then code prefix, then name prefix, then the rest, with ties broken by name (case-insensitive). The exact code beats a longer code that starts with it. Also checked on the seed data.
  - Filters: `category` (case-insensitive exact). `rack` accepts `3`, `r3`, `R03`, `R3` and `03`, `1` does not match R10, and an unknown rack returns an empty list. `condition` works, `''` means no filter and an invalid value gives 400. Filters combine with each other and with `q`.
- **GET /api/categories.** Empty DB; distinct names with counts; null and blank are excluded; grouping ignores case. Also checked against the seed data and after a delete.
- **GET /api/racks.** Empty DB. Racks are sorted by number (R02 < R10 < R100), shelves are distinct and sorted, and `itemCount` counts every item including rack-only ones. `unlocated` counts unparsed and empty locations. A rack-only rack has `shelves: []`. Seed data covers R01 to R06.
- **GET /api/racks/:rack.** Items are grouped by shelf and sorted by bin, with no-bin items last. The `unshelved` list is present. `r3`, `3`, `R3`, `R003` and `Rack 3` are all accepted. 404 for a rack with no items, 400 for `abc`, `R03-B`, `R` and `R1234`.
- **Location parser**
  - Every format in the spec, plus `R3B2`, `.`, `_`, `\`, `:` and `,` separators, `R003-B-02`, `Rack 3 Shelf B Bin 2`, `Rak 3 B 2`, non-breaking spaces and numeric input.
  - Garbage is kept as typed (trimmed) with rack, shelf and bin set to null: free text, `B-2`, `R03-BB-2`, `R3-B-2-5`, `R1234`, emoji, HTML and so on.
  - `normalizeRack`, `formatRack` and `combineLocation` are tested directly.
- **Import (files generated in the tests with exceljs and as raw CSV)**
  - Full response shape, including `headerRow`, `columns`, `ignoredColumns` and the `row`/`action`/`id` fields in preview.
  - `dryRun` is true when omitted, `1` and `0` work, and an invalid value gives 400. **A dry run writes nothing**, even when the file has errors.
  - A real import gives the same counts and preview as the dry run.
  - Header aliases: the full Malay set, 5 English and Malay alias mixes, ignored columns, and title rows above the header.
  - Missing code or name columns give 400 with `details.missingColumns` and `details.headersFound`.
  - **Separate Rack, Shelf and Bin columns.** They are combined for all of these: numbers, partial values, `Rack 2`/`01`, Malay `Rak`/`Tingkat`/`Petak`, and shelf or bin without a rack (kept as text, with a warning). A filled Location column wins over them.
  - **Condition mapping.** English and Malay values work. A blank value becomes `good`, and an unknown value becomes `good` with a warning; the row is not skipped.
  - **Rows missing code or name** are skipped, and the error carries the row number. **Blank and whitespace-only rows are ignored.**
  - **Quantity.** `5 pcs` becomes quantity 5 with unit pcs, and `1,200` becomes 1200. Text, negative and fractional values give a warning and the default of 1. Over 1M is a row error.
  - Other value handling:
    - An odd location gives a warning. A code or name that is too long is a row error.
    - Rich text, formula, formula error and hyperlink cells are read. A numeric code is read as text.
    - A code that appears twice: the later row wins, with a warning, in both dry and real runs.
    - Errors are sorted by row. The preview is capped at 20 rows, but the counts cover the whole file.
  - **Upsert by code.** The match ignores case. **Only fields whose column exists are overwritten**, so `createdAt` is kept. A dry-run update preview shows the merged item while the DB is untouched. A bad quantity leaves the existing quantity alone. Running the same import twice is idempotent.
  - **Transaction rollback.** A SQLite trigger aborts the insert on row 4. The response is 500, the update made on row 2 and the insert on row 3 are both rolled back: the item count is unchanged, KEEP still has its original values and NEW-1 does not exist.
  - CSV handling: `;` with a BOM, CRLF and quoted `;` and newlines; tab-separated files; Windows-1252 text; an upper-case `.CSV` extension; and blank lines, where row numbers still match the file lines.
  - Workbook handling: hidden and cover sheets are skipped and the first visible sheet with code and name headers is used. An empty workbook gives 400, and a file with only a header row gives 200 with zero counts.
  - **File validation**
    - No file, no `file` field or the wrong field name: 400.
    - Wrong type gives 400 for `.txt`, `.xls` (with a "Save As .xlsx" hint), `.pdf`, `.json` and no extension.
    - A text file named `.xlsx` gives 400, as do a corrupt zip and an empty `.csv`.
    - **Over 5 MB gives 413** and writes nothing; a file just under 5 MB is accepted. More than 20,000 rows gives 400.
- **Template.** It returns 200 with the xlsx content type and `attachment; filename="item-template.xlsx"`. The body starts with the `PK` zip signature and **opens with exceljs**. The header row is `Code, Name, Category, Location, Quantity, Unit, Condition, Notes`, followed by exactly 2 example rows. Importing the template back works: 2 created, no errors, and the locations and condition map correctly.
- Pure helpers are tested directly:
  - `mapCondition`, the header aliases (`mapHeaders`, `findHeaderRow`, `normalizeHeader`), the CSV parser and encoding fallback.
  - `parseQuantity`, `cellText` and `buildImportPlan`.

## Failures (all app bugs)

### Bug 1 — a shelf or bin word followed by a number is read as a rack (medium)

Location: `src/lib/location.js`, `stripWords()` and `parseLocation()`. `stripWords` deletes the words SHELF, LEVEL, BIN, POSITION, POS, SLOT, TINGKAT, PARA, PETAK and NO before matching. When there is no rack in front of them, the number that is left over is read as the rack.

This goes against the spec rule that input which cannot be parsed is kept as-is, with rack, shelf and bin set to null. Typical free-text locations in a real spreadsheet, such as "Tingkat 2", "Shelf 3" or "Bin 2", get the wrong rack and show up on the map in that rack.

| Test | Input | Expected | Actual |
|---|---|---|---|
| location.test.js "Bin 2" does not invent a rack | `parseLocation('Bin 2')` | `{locationCode:'Bin 2', rack:null, shelf:null, bin:null}` | `{locationCode:'R02', rack:'R02', …}` |
| … "Shelf 3" | `parseLocation('Shelf 3')` | kept as text | `R03` |
| … "Level 2" | `parseLocation('Level 2')` | kept as text | `R02` |
| … "Slot 4" | `parseLocation('Slot 4')` | kept as text | `R04` |
| … "Position 7" | `parseLocation('Position 7')` | kept as text | `R07` |
| … "Tingkat 2" | `parseLocation('Tingkat 2')` | kept as text | `R02` |
| … "No. 5" | `parseLocation('No. 5')` | kept as text | `R05` |
| items.api.test.js "Shelf 3" names no rack | `POST /api/items {code:'X2', name:'Box', locationCode:'Shelf 3'}` | 201, `locationCode:'Shelf 3', rack:null` | 201, `locationCode:'R03', rack:'R03'` (the user's text is lost) |
| search.api.test.js "bin 2" in q is words | `GET /api/items?q=bin 2` (items "Bin liner" in R05 with notes "2 rolls", and "Pot" in R02-A-1) | `['BIN-001']` | `['BIN-001','POT-001']`: the coordinate branch turns `bin 2` into R02 and returns every item in rack 2 |

Suggested fix: strip these words only when a rack number has already been found, for example only after a leading `R`, `RACK` or `RAK` token. Otherwise treat the input as unparseable.

### Bug 2 — search ignores case only for ASCII letters (low)

Location: `src/services/items.js`, `listItems()`. Matching uses SQLite `lower()` and `instr()`, and SQLite's `lower()` without ICU only folds A–Z. JavaScript, on the other hand, lowercases the whole query, so the two sides no longer match for non-ASCII capitals.

| Test | Request | Expected | Actual |
|---|---|---|---|
| search.api.test.js "case-insensitive for non-ASCII letters too" | item name `Ölfass (Öl drum)`, then `GET /api/items?q=öl` | `['MSC-001']` | `[]` |

This matters little for Malay or English names, but it is a gap against the spec's "case-insensitive" rule. Possible fixes: register a JS `lower` function with `db.function(...)`, or store a lower-cased search column.

## Observations (not failing tests, for the developer or reviewer to decide)

1. **A blank Condition cell resets an existing item to `good` on upsert.** Example: `TNT-004` is `damaged`, and a file with a `Condition` column leaves that cell empty. The item becomes `good` without any warning. Blank Quantity and Unit cells leave the existing value alone, so this is inconsistent and can hide damaged items. It follows the letter of "overwrite fields whose column exists", but leaving a blank condition unchanged on update (and using `good` only for new items) seems safer. Blank Category, Notes and Location cells also clear the existing values, which is arguably intended.
2. **A location over 100 characters is rejected.** On the API it gives a 400. On import, the whole row is skipped ("locationCode: Too big…; row skipped"). The spec says never to reject an item for an odd location. Long free-text locations ("Under the stairs, in the big blue box next to…") are plausible in the real file, so consider truncating with a warning, or raising the limit.
3. A header that matches an alias but loses to a higher-priority alias (for example `Description` next to `Name`, or `Remarks` next to `Notes`) is silently dropped. It is not listed in `ignoredColumns`, so the user isn't told that column was skipped.
4. A coordinate-like `q` such as `R03-A-1` also returns `R03-A-10` and `R03-A-11`, because it is a plain substring match on the location text, and the exact location does not rank higher. This is within the spec. A future improvement could rank an exact location match first.

---

## Round 2

Run: `cd backend && npm test`. I tested `b27ebb9` first, then retested the working tree once the developer's follow-up fixes landed; those fixes are now committed as `462d2b1`. As in Round 1, every test uses in-memory or `os.tmpdir()` databases, and the process tests delete their temp folders. The `data/store.db` sha256 is the same before and after, and I did not start a real server. I changed no app source and made no commits.

### Result

**484 tests: 484 passed, 0 failed** against `462d2b1`.

| File | Tests | Pass |
|---|---:|---:|
| smoke.test.js | 3 | 3 |
| location.test.js | 83 | 83 |
| lib.test.js | 102 | 102 |
| items.api.test.js | 51 | 51 |
| search.api.test.js | 39 | 39 |
| categories-racks.api.test.js | 19 | 19 |
| import.api.test.js | 62 | 62 |
| round2.test.js (developer) | 52 | 52 |
| **round2-tester.test.js (new, mine)** | 73 | 73 |
| **Total** | **484** | **484** |

The 10 Round 1 failures (Bug 1, shelf/bin words read as a rack; Bug 2, case folding for non-ASCII letters) now pass and were not edited. `tests/zip.js` is a new helper: a small zip reader and writer for building hostile `.xlsx` files.

### Were the developer's 3 test adjustments legitimate? Yes, all 3.

| Test | Change | Verdict |
|---|---|---|
| `helpers.js` `IMPORT_KEYS` | added `unchanged` | Legitimate: this is the new response field the lead decided on. |
| import.api "re-importing the same file is idempotent" | first run `updated:1` → `unchanged:1`; second run `updated:2` → `unchanged:2` | Legitimate. The existing item already has name "Old tent", so the row changes nothing. The test still checks idempotence (2 items, nothing created on the second run). |
| search.api coordinate `r03-a-1` | `['ROP-010','ROP-011']` → `['ROP-010']` | Legitimate. The lead decided coordinate search is exact (R03-A-1 does not match R03-A-10). |

The test bodies weren't weakened in any other way: assertions were changed only where a decision changed the expected values.

### New coverage (`tests/round2-tester.test.js`)

- **Regression for my Round 1 observations and review findings not already in round2.test.js**
  - Whitespace-only and non-breaking-space-only cells count as blank, so an existing item is reported `unchanged`.
  - A blank Condition never resets `damaged`, in both dry and real runs.
  - An over-long location built from Rack/Shelf/Bin columns gives a warning, and the row is still imported. Through the API, an over-long location is still a 400.
  - English `Description` next to `Name` becomes notes.
  - `ID` next to `Code` is listed as a duplicate column, and its values are not used as codes.
- **Duplicate codes and `unchanged`**
  - An existing item edited on two rows that end where it started is counted `unchanged` and is not written: `updatedAt` stays the same.
  - A dry run and a real run give the same response (apart from ids) for a mix of create, update, unchanged, duplicate and skipped rows.
- **Mixed queries**
  - `tent r1`, `r1 tent`, `tent R01-A-1`, `tent 1-a`, `tent r1 b`, `tent r01–b–2` (en dash) and `stove r4` all return the right items. `r1 r3` and `tent r9` return nothing.
  - `r3` matches only R03, not R30. `r1` also matches a code containing `r1`.
  - An exact location ranks above a notes match whose name sorts earlier.
  - With more than 8 words, every word must still match. Repeated words and extra spaces make no difference.
- **Unicode**
  - Search finds emoji, CJK and Tamil text, matches `KHEMAH` case-insensitively, and matches `CAFÉ` and `café`.
  - Codes like `ö-1` are uppercased and duplicates are detected regardless of case, on POST (409) and on import (update).
  - Tamil text survives an xlsx round trip.
  - `/api/categories` groups `Ölzeug` and `ölzeug` together, consistent with the category filter.
- **xlsx guard**
  - A 200 MB sheet compressed to about 200 KB is rejected with 400 in under 3 s.
  - An entry that declares 10 bytes but inflates to 100 MB gives 400.
  - More than 2000 entries gives 400.
  - Stored (uncompressed) entries import normally.
  - An OLE container (password-protected Excel) gives 400, and so does a zip that is not a workbook.
  - **Fuzzing:** 300 randomly corrupted workbooks plus every 97-byte truncation only ever give 200 or 400, never 500.
  - Sheet entries renamed to `/xl/worksheets/sheet1.xml` or `xl/worksheets/sheet1.xml.bak` are still counted. One test also confirms that ExcelJS really does import a sheet whose name starts with `/`.
- **CSV limits**
  - 19,000 rows × 13 mostly-empty columns are accepted.
  - Exactly 20,000 data rows are accepted.
  - A file with 1,000,000 lines gets 400 within 5 s.
- **Malformed multipart** – 400 for each of these:
  - garbage with a boundary
  - a part without headers
  - a 100 KB part header
  - an empty boundary
  - `multipart/mixed`
  - `file` sent as a text field
  - two files
  - more than 10 fields

  Odd but valid filenames (`../../etc/items.csv`, `stör ☃.csv`, a Windows path) are accepted.
- **JSON bodies**
  - UTF-16 and gzip-encoded JSON are accepted.
  - Corrupt gzip gives 400 and an unknown `Content-Encoding` gives 400. A gzip bomb (50 MB inflated) gives 413.
  - `null`, `"abc"`, `42` and 5000-deep arrays give 400.
  - `__proto__` and `constructor` keys pollute nothing.
- **Item ids:** `00001` and `%31` return 200. `999999999999999` returns 404. `9999999999999999`, `1abc`, `1%20` and `-0` return 400.
- **Process level**
  - A child process that imports `src/app.js` and calls `createApp` does not create the `DB_PATH` file (n4).
  - 4 processes opening the same fresh DB file at once all succeed, and `schema_version` has exactly one row (n3).
- **Import concurrency:** 8 simultaneous uploads each get 200 or 429 (the observed run gave 3 × 200 and 5 × 429), never 500, and the next import works.

### Bugs found in Round 2, all fixed in `462d2b1` before this report

Against `b27ebb9` these tests failed. All of them pass against `462d2b1`.

| # | Severity | Bug (at `b27ebb9`) | Test | Fixed by |
|---|---|---|---|---|
| R2-T1 | Medium | **The xlsx guard could be bypassed by renaming entries.** It counted rows only in `^xl/worksheets/[^/]+\.xml$`. ExcelJS strips a leading `/` and matches sheets with an unanchored regex. **Measured:** a 3 MB workbook (310k rows) with the sheet named `/xl/worksheets/sheet1.xml` passed the guard as `rows: 0` and ExcelJS loaded it all: 3.3 s and 684 MB RSS, against 0.3 s / 252 MB with the normal name. The reviewer found the same thing independently (R2-1). | "rows in a sheet entry named …" | The guard now counts tags in every entry, normalises names, and allows any tag spelling. Imports are also serialised, with 429 beyond the queue. |
| R2-T2 | Low | An existing item changed on one row and changed back on a later row was reported `unchanged`, but it was written twice and `updatedAt` changed. | "edited on two rows that end where it started" | The import now works out the final state in memory, then does one write per code. |
| R2-T3 | Low | Only the first 8 search words were used, so `…8 matching words… zzz` still returned the item. | "every word must match, even with more than 8 words" | The token cap was removed. |
| R2-T4 | Low | `/api/categories` grouped case-insensitively only for ASCII letters (`Ölzeug` and `ölzeug` were listed separately), while the filter matched both. | "categories are grouped case-insensitively for non-ASCII letters too" | Grouping now folds case in JS. |
| R2-T5 | Nit | The CSV import applied the 240,000-cell cap, so 19,000 rows × 13 columns were rejected although under the 20,000-row limit. This is the reviewer's R2-2. | "a CSV under the 20,000-row limit is not rejected…" | The CSV cell cap was dropped; SPEC.md now says "CSV has no cell cap". |

**Remaining app bugs: none found.**

### Observations (not bugs under the current spec)

1. Search does not apply Unicode normalisation. NFC `café` and NFD `cafe` + U+0301 don't find each other. This only matters for text pasted from macOS or PDFs.
2. `tent rack 1` / `rack 1 tent` return nothing, because `rack` and `1` are separate words. Only a single coordinate word like `r1` works inside a mixed query, which is what the spec says.
3. Invalid UTF-8 in a JSON body is stored as U+FFFD replacement characters, with no error.
4. Full case folding is not done: `STRASSE` does not find `Straße`, and Turkish dotted `İ` behaves as JavaScript's `toLowerCase` dictates.
5. Review n6 (numeric shelves in separate columns) is still deferred, as agreed.
