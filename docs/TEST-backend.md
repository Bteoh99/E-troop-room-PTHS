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

---

## Phase 1.5

Run: `cd backend && npm test`, against commit `599115c`. Everything ran on in-memory or `os.tmpdir()` databases, with temp `CONFIG_PATH`, `BACKUP_DIR` and dist folders. `data/store.db` has the same sha256 as before, and none of these tests wrote to `data/config.json` or `data/backups/`. That folder's `store-2026-11-26.db` comes from someone else's running server, not from the tests. I started no server, changed no app source and made no commits.

### Result

**723 tests: 722 passed, 1 failed.** The failure is an **app bug**. I ran the full suite 3 times and got the same result each time; no test was flaky.

| File | Tests | Pass |
|---|---:|---:|
| `phase15-tester.test.js` (new, mine) | 191 | 190 |
| `phase15.test.js` (developer) | 47 | 47 |
| all earlier files (smoke, location, lib, items, search, categories-racks, import, round2, round2-tester) | 485 | 485 |
| **Total** | **723** | **722** |

### What is covered (`tests/phase15-tester.test.js`)

- **Auth on every write.** The writes are `POST /api/items`, `PUT` and `DELETE /api/items/:id`, `POST /api/import` as a dry run and as a real import.
  - Each one returns 401 for 11 bad authorisation variants:
    - no header
    - `Bearer ` with nothing after it
    - the `Basic` scheme
    - a garbage token
    - a tampered payload (expiry pushed out a year)
    - a tampered signature
    - a token from another install
    - an extra `.segment`
    - two tokens
    - a 600-character token
    - a token without the scheme
  - Every 401 uses the exact message, sends `WWW-Authenticate: Bearer` and writes nothing.
  - An expired token gets 401 with the "session expired" message.
  - A valid token works, including with lower-case `bearer`.
  - The 401 is returned before body validation runs.
  - PATCH and OPTIONS also need a token.
  - Reads, scan, the template, health and status stay public even with a garbage token.
  - `auth/status` reports leader only for a valid, unexpired token.
- **Login and tokens**
  - Login returns `{token, expiresAt}` 30 days ahead. The PIN may be sent as a number.
  - Missing, array or over-long `pin` gives 400.
  - Malformed PINs (`123`, `abcd`, `" 2468"`) get 401 `Wrong PIN.`
  - With a fake clock, a token still works 1 minute before 30 days and gets 401 "expired" 1 second after.
  - Changing the PIN, through `setPin` or through the `set-pin` script running as a separate process, kills every token on the running app. The old PIN then fails and the new one works. The script never prints the PIN.
  - `config.json` holds only the scrypt hash and salt.
- **Rate limiting**, using the default limiter with a faked `Date` and a per-request client IP:
  - 5 wrong tries give 429 with `Retry-After: 300` and `details.retryAfterSeconds`, even for the right PIN.
  - Retry-After counts down (180, then 1) and the block lifts after 5 minutes.
  - The limit is per IP: another IP can still log in, and that doesn't unblock the first.
  - Wrong tries spread over more than 5 minutes don't block. A correct PIN resets the count.
  - **Global cap:** 4 wrong tries each from 5 IPs (none blocked on its own) blocks a sixth, never-seen IP for 5 minutes.
  - 400s are not counted. A valid token keeps working for writes while that IP is blocked from logging in.
- **Setup needed and damaged config**
  - With no config file, all 4 kinds of write and the login return 403 with the exact message, and status shows `pinSet:false`. Reads, template and scan still work.
  - A config with a PIN but no token secret counts as "not set".
  - Setting the PIN while the server runs ends setup mode without a restart.
  - A damaged `config.json` (`{broken` or an empty file) gives **503 on every write, with or without a token**. Reads still work, and everything recovers after `set-pin`.
- **Brand, model and barcode**
  - They default to null and are part of the Item shape. Brand and model are trimmed, `""` and null clear them, and more than 100 characters gives 400.
  - Barcode normalisation: spaces, tabs and newlines are removed, letters upper-cased, and numbers become strings.
  - Barcodes with `-`, `.`, `é`, full-width or Arabic-Indic digits, `<x>`, or 65 characters give 400. 64 characters is accepted.
  - Uniqueness: 409 with `details {field:"barcode", code}` on create and on update, ignoring spaces and case. An item can re-send its own barcode, clearing a barcode frees it, and many items can have no barcode.
- **Search**
  - An exact barcode ranks top, also when typed with spaces, ahead of a code-prefix match and a notes match.
  - Brand, model and part of a barcode are searchable.
  - `unlocated=true|1` returns items with no rack or an unparseable location, sorted by code. `false`, `0` and `""` return everything, and `yes`, `TRUE` and `2` give 400.
  - `unlocated` combines with `q` (normal ranking) and with `rack`.
- **Import**
  - Five header sets map the new columns: `Brand/Model/Barcode`, `Jenama/No Model/Kod Bar`, `Pengeluar/Model No/EAN`, `Manufacturer/Model Number/UPC`, and `Make/MODEL/barcode`.
  - Numeric 13- and 14-digit EAN cells in xlsx keep every digit.
  - These invalid barcodes give a warning, the row is still imported and the barcode stays unset: `9.31235E+12` (Excel's CSV scientific notation), `ABC-123`, and 65 characters.
  - A barcode already owned by another item, in the DB or earlier in the file, gives a warning and is not moved. Dry and real runs agree on this.
  - Blank brand, model and barcode cells never change an existing item. Changing a barcode through import counts as an update.
- **Migration v1 → v2.** A populated v1 file database upgrades in place:
  - Every v1 value is unchanged and the new columns are null.
  - `schema_version` gets a 2 while v1's `applied_at` is kept.
  - The API works on the upgraded database: list, PUT with barcode and brand while keeping `createdAt`, and 409 for a duplicate barcode.
  - Re-opening the database is a no-op.
- **Scan matching**
  - The response shape is as documented.
  - An exact barcode, with spaces ignored, returns that item alone with score 1 even if the text points elsewhere. A barcode equal to an OCR-folded code also counts as exact. An unknown barcode alone returns `[]`; with text, text matching is used.
  - These OCR-noisy codes all give score 1 on `code`: `TNT-OO4`, `tnt 0O4`, `tnt004`, `TNT 004`, `TNT - 0 0 4`, `TNT_O04`, and the code inside a multi-line label.
  - These brand/model typos all match on brand and model: `Colernan Sundorne` (rn→m), `Co1eman`, `Colemam`, `Campingas Bistr0`, `Petz1 Tikina`.
  - Results are sorted best first and capped at 10.
  - Noise-only text returns `[]`: label boilerplate, stopwords, punctuation, `®©™`, single letters.
  - 9 kinds of invalid body give 400. 2000 characters is accepted, and GET is a 404.
  - **Performance:** with 5,000 items and a 2,000-character noisy text, the median of 3 runs is under 300 ms. A separate timing run gave about 50–100 ms per request.
- **Static serving** from a temp dist:
  - SPA fallback works for 9 client routes and with query strings. Those pages get `no-cache` and every security header, and no HSTS.
  - `/api`, `/api/nope`, `/api/items/999` and `/api/racks/R99` return JSON 404 with `no-store`, never `index.html`.
  - Missing `.js`, `.png` and `.wasm` files are real 404s.
  - Cache and content types are right: assets are immutable, `.wasm` is `application/wasm`, `.mjs` is JavaScript, `.webmanifest` is the manifest type, and `favicon.svg` and `index.html` are `no-cache`.
  - **14 path traversal and dotfile attempts** never leak a file outside dist or a dotfile, and never give 500. They include encoded `..`, `%5c` backslash, overlong UTF-8, `%00`, `//` and `/.secret`.
  - POST to a page path gets 404 and HEAD works.
  - `resolveStaticDir` serves only in production or with `SERVE_FRONTEND=1`, honours `FRONTEND_DIST`, and needs `index.html`.
- **Backups** in temp dirs:
  - Rotation keeps the N newest by date, whatever order they were created in.
  - It **never deletes other files**: `notes.txt`, `store-latest.db`, `Store-…`, `store-2020-1-1.db`, `.bak`, `.partial`, `my-store-…`, `.sqlite` and a subfolder all survive.
  - Each backup is a readable copy that passes `integrity_check`, and no `.partial` is left behind.
  - An unusable folder (a file in the way, or the target name taken by a folder) gives exactly one warning, no exception, and no `.partial`.
  - With a fake clock, `scheduleBackups` backs up now, replaces the file at 21:00 the same day and runs again the next day. A failing day only warns and the following day works. `stop()` ends the schedule.

### Failure: app bug

**P15-1 (low/medium): a code spelled out letter by letter is not found.** The test is "a fully letter-spaced code "T N T - 0 0 4" (6 OCR words) finds TNT-004".

- **Request:** `POST /api/scan/match {"text":"T N T - 0 0 4"}`, with item `TNT-004` in the DB.
- **Expected:** TNT-004 as the top match on `code`. You asked for this case in the round brief.
- **Actual:** `{"matches":[]}`. `T N T 0 0 4` behaves the same way.

**Cause.** `analyzeText` in `src/lib/scanMatch.js` joins at most `MAX_WINDOW = 5` neighbouring words. `T N T - 0 0 4` is 6 words, because the `-` is dropped. So a 7-character code that OCR reads as separate characters can never be rebuilt. This happens with stencilled or widely spaced labels. `TNT - 0 0 4` (4 words), the example in the spec note, does work.

**Suggested fix.** Limit the window by the folded length instead of the word count. For example, keep joining words until the folded string is longer than the longest item code (up to about 20 characters).

### Observations (not failing tests)

1. **A damaged `config.json` makes `POST /api/auth/login` return 403 "Leader PIN not set. Run set-pin on the laptop.", and `/api/auth/status` reports `pinSet:false`.** Writes correctly return 503. A leader whose PIN *is* set would be told it isn't. The fix (run set-pin) is the same, but a 503 "settings file is damaged" on login and status would be clearer.
2. **Leading zeros in barcodes:**
   - A 12-digit UPC with a leading zero (`012345678905`) stored in a **numeric** Excel cell imports as `12345678905`. Scanning the real barcode then won't match exactly.
   - A barcode sent as a JSON *number* larger than 2^53 is already rounded by the time it reaches the server.
   - Possible fixes: compare barcodes ignoring leading zeros (GTIN-style), or warn on numeric cells shorter than 12 digits.
3. Barcode `ß12` becomes `SS12`, because `toUpperCase` expands ß. Harmless.
4. The SPA fallback skips any path whose last segment contains a dot (e.g. `/items/1.5` → 404). Current routes are not affected.
5. The scan text limit is 2000 characters. A dense label can produce more OCR text than that, so the frontend should truncate before sending rather than get a 400.
6. A one-character transposition in a brand (`Peztl` for `Petzl`) is 2 edits and is not matched. This is per the spec (≤1 edit).

---

## Phase 1.5 fix verification (commit `29b3df5`)

**792 tests: 791 passed, 1 failed (an app bug).** The run used in-memory or temp databases, configs and dist folders. The `data/store.db` checksum is unchanged.

### The developer's adjustments to `phase15-tester.test.js`: all legitimate

Only 4 places were changed, and each follows a lead decision.

1. **Global cap → global slowdown (decision 2).** 10 wrong tries from 5 IPs now give a new IP 429 with `Retry-After ≤ 1`, and a correct login 1 s later gives 200. The per-IP 5-minute block tests are unchanged.
2. **Barcodes (decision 11).**
   - The JSON number `9312345678901` moved from "normalized" to "400", and `ß12` was added to the 400 list.
   - The other normalization and rejection cases are unchanged.
3. **Migration test.** The expected versions now come from `migrations`, because v3 was added. The data-intact assertions are unchanged.
4. **Scan (decision 12).** The 2001-character "400" case was removed because long text is now truncated. A replacement test is in my new file.

Nothing else was weakened. **The spaced-code test (`T N T - 0 0 4`) now passes.**

### New regression tests (`tests/phase15-fix-tester.test.js`, 30 tests)

- **Parallel login burst:**
  - 60 parallel wrong PINs from one IP give at most 5 PIN checks (401). The rest get 429 in the standard error shape with `Retry-After`.
  - After that the IP is blocked for about 5 minutes (Retry-After between 200 and 300).
  - Another IP is only slowed down: it logs in 15 s later.
  - 20 parallel right PINs only ever get 200 or 429.
- **Scan throttle:**
  - The 31st request in a minute from one IP gets 429, with `Retry-After` equal to `details.retryAfterSeconds`. Invalid bodies count towards the 30.
  - Other IPs are unaffected, and the throttled IP works again after a minute.
  - Text over 2000 characters gets 200, and words past character 2000 are ignored.
- **Leading-zero barcodes:**
  - `12345678905`, `0012345678905` and `0 1234 5678 905` give 409 naming the owner, on POST and on PUT.
  - The owner can re-send its barcode without the zero.
  - Search with the shorter form, and scan with either form, find the item.
  - Import gives a warning and leaves the owner untouched.
- **Damaged `config.json`:** `null`, `42`, `"text"`, `[]`, `{broken` and an empty file all give 503 "damaged" (never "not set") on login, status and writes. Reads still work.
- **Dotted page paths:**
  - `/items/1.5`, `/racks/R03.B`, `/v1.2/page`, `/search.results`, `/items/TNT-004.v2` and `/x.php` get `index.html`.
  - Missing `.js`, `.css`, `.traineddata`, `.html`, `.PNG` and `.wasm` files get a plain-text 404.

### Failure: app bug

**PF-1 (low/medium): search with a leading zero doesn't find a barcode stored without it.** The test is "search: the scanned UPC with its leading zero finds an item whose Excel barcode lost the zero".

- **Setup:** item `XL-1` has barcode `98765432105`, i.e. Excel dropped the leading zero of UPC `098765432105`.
- **Request:** `GET /api/items?q=098765432105`.
- **Expected:** `["XL-1"]`. The spec says leading zeros are ignored "for 409s, search ranking and scan matching".
- **Actual:** `[]`. A query with extra zeros (`0012345678905` for a stored `012345678905`) also finds nothing.

**Cause.** In `listItems` (`src/services/items.js`), the rank clause compares `ltrim(barcode,'0') = ltrim(@bc,'0')`. But the WHERE filter only does substring matching, so the row is excluded before it can be ranked. Scan and 409 handle this correctly; only the search box misses it.

**Fix.** Add `OR (barcode IS NOT NULL AND ltrim(barcode,'0') = ltrim(@bc,'0'))` to the WHERE clause, the same way the coordinate match is OR-ed in.
