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
