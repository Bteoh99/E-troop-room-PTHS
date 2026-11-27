# Frontend Review: Phase 1

Reviewer: Frontend Code Reviewer. Scope: everything in `frontend/src`, plus `vite.config.ts`, `tsconfig.json`, `playwright.config.ts`, `index.html` and the README. Checked against `docs/SPEC.md`, including the backend implementation notes.

## How this was verified

- `npx tsc --noEmit` passes. `vite build` (to a temp dir) passes: 210 kB JS, 67 kB gzip.
- I ran the real backend (`PORT=3301`, temp seeded DB) and Vite on :5373 with `BACKEND_URL` pointed at it. I then drove the app with Playwright at **360×740** and **1280×800** (deviceScaleFactor 1). Screenshots are in `/tmp/fe-review-shots/`.
- No page scrolls horizontally at 360 px (`/`, `/?q=tent`, `/items/2`, `/map`, `/racks/r1`, `/items/new`, `/import`, 404, a bad item id, a bad rack). The only console errors were the expected 400s for the bad id and bad rack.
- `src/lib/location.ts` is regex-for-regex identical to `backend/src/lib/location.js` (`stripWords`, `PATTERN`, `RACK_PATTERN`, `formatRack`), so the live preview and the saved value agree.
- No XSS sinks: there is no `dangerouslySetInnerHTML`, `innerHTML` or `eval`, and every server string (including import messages and preview cells) is rendered as React text.
- `useAsync` aborts the previous request and ignores late responses, so fast typing in search cannot show stale results out of order. I confirmed this with a delayed route: old results stay dimmed with `aria-busy` until the new response arrives.

Every finding below was reproduced in the running app unless it says otherwise.

---

## Major

### M1. After "Save changes", the detail page's **Back** button returns to the edit form
`src/pages/ItemFormPage.tsx:182-185` together with `src/pages/ItemDetailPage.tsx:59-68`

**Problem.** Saving an edit does `navigate('/items/:id', { replace: !item })`. For an edit, `replace` is `false`, so it pushes a second detail entry after the edit form. The detail page's Back link calls `navigate(-1)` whenever `location.key !== 'default'`, which is always true after an in-app navigation.

**Scenario (verified).** Go to `/?q=dome`, open "4-man dome tent", click Edit item, then Save changes. Tap **Back** and you land on `/items/2/edit` ("Edit TNT-004") instead of the search results. Tap Back again and you get the detail page again. The quartermaster's main loop (find, fix, back to search) breaks on every edit.

**Fix.** After a successful edit, go back to the existing detail entry instead of stacking a new one. Either:
- `navigate(-1)` when the form was opened from the detail page, with the flash passed some other way (a small flash context or `sessionStorage`); or
- `navigate(\`/items/${id}\`, { replace: true, state: { flash } })`, plus a Back link that skips a previous entry which is the same item.

The simplest robust option: the detail Back link should navigate to an explicit "return to" (the search URL stored in `location.state.from` when the card was opened) rather than relying on `navigate(-1)`. Add an e2e test for edit → save → Back.

### M2. The highlighted bin shrinks to a sliver, and its 📍 is clipped, once a rack has about 7 or more bins
`src/components/RackDiagram.tsx:28-31, 55, 66`, CSS `src/styles/index.css:936-958` (`.rack__bin { overflow: hidden }`, `minmax(0, 1fr)` columns)

**Problem.** The diagram draws one equal-width column per bin from 1 to `maxBin` in a single row, with no minimum width. The parser and backend allow bins up to 4 digits. At 360 px:

| bins in row | width of highlighted bin | 📍 (20 px) |
|---|---|---|
| 5 | 28.9 px | ok |
| 6 | 23.4 px | ok |
| 7 | 19.5 px | **clipped** |
| 8 | 16.5 px | clipped |
| 10 | 12.4 px | clipped |
| 12 | 9.7 px | clipped, a thin green bar (`/tmp/fe-review-shots/rack-bin12-360.png`) |
| 40 | 4 px | invisible (6.8 px even at 1280) |

**Scenario.** A shelf labelled with bins 1–12 is entirely realistic. The item's bin, the core "where is it" answer, is then unreadable on a phone. The "◀ here" row marker still shows the shelf, but the bin no longer shows. The same squeeze hits the whole rack on `/racks/:rack`, because one item with a high bin widens every row.

**Fix.** Give bins a minimum width, e.g. `repeat(n, minmax(28px, 1fr))`, and let `.rack__bins` scroll horizontally (`overflow-x: auto`), scrolling the hit bin into view. Alternatively, above roughly 8 bins, switch to a compact representation: show the hit bin as a labelled chip, "Bin 12 of 12", with neighbours collapsed. Also cap `maxBin` defensively so a typo like `R01-A-500` can't render 500 cells.

---

## Minor

### m1. The Search tab and the brand link can't get back to "all items"
`src/pages/SearchPage.tsx:16, 23-28`

`text` is initialised from `?q=` only once (in `useState`). When the user is on `/?q=tent` and taps **Search** in the tab bar or the brand logo, the route element stays mounted and `text` is still "tent". The URL-sync effect then writes `?q=tent` straight back.

Verified: after both clicks the URL stays `/?q=tent` and the input still reads `tent`. The user has to notice and use the input's native ✕.

Fix: derive state from the URL when it changes externally, e.g. `useEffect(() => { if ((params.get('q') ?? '') !== query) setText(params.get('q') ?? '') }, [params])`, guarding against the debounce loop. Or key the page on `location.key` when the navigation came from the nav.

### m2. Server validation is not mirrored client-side, and some server errors are not shown on the field
`src/pages/ItemFormPage.tsx:51-59, 191-193, 273-331`

The backend limits are code 50, name 200, category 100, locationCode 100, unit 30, notes 2000 and quantity ≤ 1,000,000 (`backend/src/lib/itemSchema.js:8`). The form has no `maxLength` and no quantity maximum.

Verified: a 120-character location produces a summary titled "Validation failed" with the raw zod text "Too big: expected string to have <=100 characters". The location field gets no inline error and no `aria-invalid`, because `fieldError()` is only rendered for code, name, quantity, unit and notes. Category and condition have the same gap. A quantity of 2,000,000 passes client validation and only fails on the server.

Fix:
- Add `maxLength` to the inputs and the same limits to `validate()`, including `quantity <= 1_000_000`.
- Render `fieldError` and `aria-invalid` for every field that can receive a server error (location, category, condition).
- Replace the generic "Validation failed" title with "Please fix the highlighted fields".

### m3. A category in the URL that isn't in the dropdown shows "All categories" while the list is filtered
`src/pages/SearchPage.tsx:17, 72-79`

The `<select>` is controlled by `?category=` but only has options for categories that `/api/categories` returned. Verified: `/?category=NoSuchCat` shows **All categories** in the select, yet the page says "No items in this category".

The same mismatch happens briefly on every load of `/?category=Tents` before categories arrive. It also happens permanently when the last item of a category is deleted or the category is renamed and the user comes Back.

Fix: if `category` is not among the loaded options, render an extra `<option value={category}>{category} (0)</option>`, or clear the param once categories have loaded.

### m4. No focus management on route change
`src/components/Layout.tsx:91` (`<main tabIndex={-1}>` exists but is never focused)

Verified: open an item from the results with the keyboard (Enter on a card) and `document.activeElement` becomes `BODY`. Screen-reader users get no announcement of the new page, and keyboard users restart from the top of the document.

Fix: in `Layout`, on `location.pathname` change (not search-param changes, so typing isn't disturbed), focus the page `<h1>` or `#main`. React Router's `useNavigationType` lets you skip `REPLACE`.

### m5. Import: the file input keeps its value, so re-choosing the same (edited) file does nothing
`src/pages/ImportPage.tsx:96-106`

The input is only cleared on a client-side rejection or on "Choose a different file". Verified: after a dry run, `input.value` is still `C:\fakepath\inv.csv`.

Typical flow: the dry run shows problems, the user fixes the spreadsheet in Excel and saves it under the same name, then picks it again from the still-visible input. Browsers fire no `change` event for an identical selection, so the old preview stays on screen. If they press **Confirm import** instead, the `File` object now points at a file modified after selection. Chrome then fails the upload with a read error, which `request()` reports as "Can't reach the store-room server". (I confirmed the retained value. The no-`change` and modified-file read failure are standard browser behaviour and were not reproduced in Playwright, because `setInputFiles` always fires `change`.)

Fix: capture the `File`, then set `e.target.value = ''` in every `onFileChange` path.

### m6. An invalid item id or rack in the URL gives a generic error with a useless "Try again"
`src/pages/ItemDetailPage.tsx:21-32`, `src/pages/ItemFormPage.tsx:119-129`, `src/pages/RackPage.tsx:32-46`

The backend answers 400 for `/api/items/abc` and `/api/racks/foo`. The pages only treat 404 as "not found". Verified (`bad-rack-360.png`): the page shows "Couldn't load this rack" plus a **Try again** button that can never succeed. `/items/abc` behaves the same way.

Fix: treat 400 (or a non-numeric id, or `normalizeRack(raw) === null`) like 404 and show the friendly not-found state, or validate the param before fetching.

### m7. Non-text contrast below WCAG 1.4.11 (3:1)
`src/styles/index.css:1202` (input, select and textarea border `--sand-300` #d3c4a8 on white = **1.72:1**) and `:947-952` (occupied bin #efe3c8 vs empty white bin = **1.27:1**)

On a bright phone screen in a store room, field outlines are hard to see. "This bin has something in it" is shown only by a faint fill plus bold digits. The whole diagram is `aria-hidden`, which is fine because there is a textual summary, but sighted users get no non-colour cue.

Fix: darken input borders (e.g. `--wood` #8a6a46 gives about 5:1). Give occupied bins a stronger border or a small dot or count marker.

### m8. The e2e config can run against the developer's real backend and database
`frontend/playwright.config.ts` (committed version, webServer `reuseExistingServer: !process.env.CI`)

If a developer already has `npm start` running on :3001 with the real store-room DB, `npm run e2e` silently reuses it. The temp `DB_PATH` is then ignored, and e2e create/edit/delete/import steps write into real data. The Vite dev server is also reused with whatever proxy target it was started with.

Fix: default `reuseExistingServer` to `false` for the backend, or have the backend webServer use a dedicated port. The tester's uncommitted edit adds `E2E_BACKEND_PORT`, which helps, but the default is still 3001 with reuse. Note: the frontend tester is currently editing this file, so coordinate with them.

---

## Nit

- **n1** `ItemDetailPage.tsx:49`: after a delete, `navigate('/', …)` pushes a new entry, so browser Back shows "We couldn't find that item" (verified). Use `{ replace: true }`.
- **n2** `ItemFormPage.tsx:227`: the error-summary links are plain `href="#:r1:-code"` anchors. They do focus the field (verified), but each click adds a history entry (`/items/new#:r1:-code`). Use `onClick={e => { e.preventDefault(); document.getElementById(id)?.focus(); }}`.
- **n3** `ItemDetailPage.tsx:177-182`: if `getRack` fails, `WhereDiagrams` silently draws a diagram containing only this item (shelves A up to its shelf) with no error. Show a small error with retry, as the map block does.
- **n4** `ImportPage.tsx:273`: "The import did not finish — nothing was saved" is also shown for status 0 (network drop or timeout), when the server may already have committed. Use softer wording for status 0 ("We lost the connection — check the search page before trying again"). Re-running is upsert-safe, so the risk is low.
- **n5** `ImportPage.tsx:210`: `role="status"` wraps the whole Done card (tables and buttons), so screen readers read the full card. Put the live region on the heading or the counts only.
- **n6** `ImportPage.tsx:404-442`: at 360 px the preview table (min-width 620 px) hides **Location**, the most important column, off-screen, with no scroll affordance (`import-preview-360.png`). Move Location next to Code, or add a scroll shadow or hint.
- **n7** `MapPage.tsx:22-29`: when there are no racks but `unlocated > 0`, the page says "No racks yet" and hides the "N items have no rack location" note. Show the note in the empty state too.
- **n8** `index.css:1107` (`.shelf__item .chip`): below 640 px the condition chip stretches across the whole grid column (visible in `rack-360.png`). Add `justify-self: start`.
- **n9** `index.css:1432-1456`: an appended block of overrides (`.stats` is redefined from 4 to 5 columns, `.rack` max-width, `.table--wide`, warning caption colours) belongs with its sections. Fold these back in to keep the stylesheet maintainable.
- **n10** `index.css:671`: placeholder colour #8a7e70 on white is 3.96:1. The placeholder carries the format example ("TNT-004, R03…"). Use `--muted` (about 6:1).
- **n11** `Layout.tsx:13-16`: no tab is marked active on `/items/:id/edit`. Consider counting it under Search like the detail page.

---

## What's good

- Contract types (`api/types.ts`) match SPEC and the backend additions (`unshelved`, import `row`/`action`/`id`, `headerRow`/`columns`/`ignoredColumns`, `Warning:` handling, 400 `missingColumns`/`headersFound`, 413). `dryRun` is always sent explicitly.
- Strict TypeScript with `noUncheckedIndexedAccess`. There is no `any`, and `ApiError` is typed with status 0 for network failures.
- Accessibility basics are solid: labels on every input, skip link, `aria-current` tabs, live regions for result count and location preview, error summary that receives focus, confirm dialog with focus trap, Escape and focus return (verified), 44 px targets, and condition always shown as symbol plus text.
- The location badge is clear at both widths, and the 1280 detail layout is well balanced.

## Verdict

**Approve with changes.** No critical issues: data flows, contract handling and security are sound. Fix the two Major issues before Phase 1 is called done, because both hit the app's core purpose:
- **M1**: Back after an edit returns to the edit form.
- **M2**: the bin highlight is unreadable at 360 px on racks with 7 or more bins.

m1 to m6 are quick, low-risk fixes worth doing in the same pass.

---

## Round 2 verification (commit 74d6d68)

**How I checked it.**
- `npx tsc --noEmit` passes, and `npx vitest run` passes (11 files, 196 tests).
- I re-ran the real backend (`PORT=3301`, fresh seeded temp DB) and Vite on :5373, and re-drove every finding with Playwright at 360×740 and 1280×800. Screenshots are in `/tmp/fe-review-shots/r2/` and `/tmp/fe-review-shots/r2-*.png`.
- No page scrolls horizontally at either width. There are no console errors apart from the expected 404/429 responses.
- `src/lib/location.ts` is still regex-for-regex identical to the updated `backend/src/lib/location.js`.

| # | Status | Evidence |
|---|---|---|
| **M1** Back after edit | **Fixed** | Search `dome` → item → Edit → Save gives `/items/2` with the "Changes saved." flash and fresh data. **Back** then goes to `/?q=dome` with the box still showing "dome". Cancel then Back also gives `/?q=dome`. Deep links: `/items/3` → Edit → Save → Back gives `/`, and `/items/3/edit` → Save → Back gives `/`. Add from Map → Back gives `/map`. Delete gives the flash, and browser Back skips the deleted item (`/map`). The error-summary link focuses the field without adding a `#hash` (URL stays `/items/new`). The new flow (`navigate(-1)` when the edit form isn't the root entry, otherwise `replace` with `root` state kept) is sound, because the only links to `/items/:id/edit` are on that item's page. |
| **M2** Rack diagram width | **Fixed** | At 360 px the highlighted bin is now ≥ 34 px, shows both 📍 and the number, and is scrolled into view inside the diagram, with no page overflow: 7, 12 and 24 bins give 34 px each; 40 and 500 bins collapse to `1 … 40` (59 px). At 1280 with 40 bins it is 192 px. The shelf label stays sticky on the left and "◀ here" on the right. A typo'd bin 500 is capped by the collapse (> 24 bins). See the new finding R2-1 for the rack page. |
| **m1** Search tab/logo clear search | **Fixed** | Search tab gives `/` with an empty box and "All items (28)". The logo does the same. Typing still syncs `?q=` and keeps `category`. |
| **m2** Limits/server errors | **Fixed** | Client limits mirror backend `LIMITS`. The summary reads "Location can be at most 100 characters. / Category can be at most 100 characters. / Quantity must be a whole number from 0 to 1,000,000." Location and category now get inline errors and `aria-invalid`. Raw zod text is mapped through `friendlyServerMessage`. |
| **m3** Unknown category | **Fixed** | `/?category=NoSuchCat` shows "NoSuchCat (0)" selected. |
| **m4** Route-change focus | **Fixed** | Map → rack puts focus on the h1 "Rack R03". Tab → Import puts it on the h1 "Import from Excel". Search → item puts it on the h1 "4-man dome tent". Tab → Search keeps focus in the autofocused box and announces "Find an item" through the polite live region. |
| **m5** File input reset | **Fixed** | `input.value` is `""` right after a pick, so re-picking the same file fires `change` again. Not reproducible in Playwright: a file that changed on disk now gives `FileReadError` (via a 1-byte `FileReader` probe) instead of "can't reach server". The code reads correctly. |
| **m6** Invalid id/rack | **Fixed** | `/items/abc`, `/items/abc/edit` and `/items/99999` show "We couldn't find that item". `/racks/foo` shows "“foo” isn't a rack". None of them has a Try again button, and the invalid ones make no request. |
| **m7** Contrast | **Fixed** | Field borders (`--field-border` #93785a) are 4.14:1 on white and 3.87:1 on sand-50. Occupied bins now have a solid wood border (4.96:1) plus a dot marker, so the cue is not colour alone. |
| **m8** e2e reuses real backend | **Fixed** | Dedicated ports :3901/:5901, `reuseExistingServer: false`, and a unique temp DB per run. |
| n1 delete history | Fixed | See M1. |
| n2 summary `#hash` | Fixed | See M1. |
| n3 silent `getRack` failure | Fixed | There is now an inline "Couldn't load the other items on this rack…" message with Try again. Verified by code reading only. |
| n4 "nothing was saved" on status 0 | **Not fixed** | Verified: an aborted `dryRun=false` request still shows "The import did not finish — nothing was saved" + "Can't reach the store-room server". The server may already have committed. Still a Nit, because re-running is upsert-safe. |
| n5 Done card live region | Fixed | `role="status"` now wraps only the heading. |
| n6 Preview table at 360 | Partially | A "swipe sideways to see every column" hint was added (shown below 700 px). Location is still the 5th column, off-screen at 360. |
| n7 Map unlocated note | Fixed | |
| n8 Chip stretch | Fixed | `justify-self: start` (see `rack-360.png`). |
| n9 Appended CSS | Fixed | Overrides folded into their sections. `.stats` is now `auto-fit, minmax(130px, 1fr)`. |
| n10 Placeholder | Fixed | 6.72:1. |
| n11 Tab on edit page | Fixed | |

### New findings (round 2)

**R2-1 (Minor): on `/racks/:rack`, wide racks hide every occupied bin off-screen with no cue.**
`src/components/RackDiagram.tsx:78-84` and CSS `.rack__scroll`.

Without a highlight, the scroller starts at `scrollLeft = 0`. Verified with rack R07 holding items at A-24, B-7 and C-12 (`/tmp/fe-review-shots/r2-rackpage-R07-360.png`): the lead says "3 items", but the diagram shows bins 1–6 on every row, all empty. Mobile overlay scrollbars give no hint that more columns exist, so the diagram looks wrong. The same applies to the other rows on the item page, where only the highlighted bin is scrolled into view.

Fix: one of
- add an edge fade or a "scroll →" cue (like the import table hint);
- when there is no highlight, scroll to the first occupied bin;
- when a row has more bins than fit, show "bins 1–24, scroll for more" in the rack title.

**R2-2 (Nit): duplicate React keys in the ignored-columns list.**
`src/pages/ImportPage.tsx` `IgnoredColumns`, `key={c}`.

The backend reports repeated unknown headers separately: a file with `Colour,Colour` gives `['Colour','Colour','ID (duplicate code column; …)']`. Verified: React logs "Encountered two children with the same key". Use `key={`${i}-${c}`}`.

**R2-3 (Nit): the file input says "No file chosen" while a preview or error for that file is shown.**
This is a side effect of the m5 reset (`r2-import-choose-after-pick-360.png`). The preview card names the file, so this is only mildly confusing. Optionally show "Selected: inv.csv" next to the input, or relabel the button "Choose another file" once a file is loaded.

**New code reviewed, no further problems found:**
- `lib/history.ts`: root-entry detection survives `replace`.
- `lib/flash.ts`: the module-level queue is consumed on the next `location.key`, and was verified for save via `navigate(-1)`, add, and delete.
- `lib/routeFocus.ts` + `PageHeading.tsx`: layout-effect marking runs before child effects, and the fallback focus on `<main>` only fires while no heading has taken focus.
- `SearchPage` URL↔box sync: the ref guards prevent the debounce loop.
- `ItemFormPage` error mapping (`friendlyServerMessage`, ordered summary).
- ImportPage: 429 shows "Another import is running — please try again in a moment." with Try again. Already-imported files show "Already up to date 3", "No change" rows, a disabled Confirm, and "Every item in it already matches the store-room list." `FileReadError` is treated as fixable.
- `playwright.config.ts`.

### Round 2 verdict

**Approve.** Both Majors and all eight Minors are fixed and verified in the running app, with no regressions. What remains is one new Minor, R2-1 (a scroll cue for wide racks on the rack page), plus the Nits n4, n6 (partial), R2-2 and R2-3. None of them blocks Phase 1.

---

## Phase 1.5 review (commit f23f178, frontend)

**Scope.** Leader mode (`src/leader/`, `src/lib/auth.ts`, `api/client.ts`), the gating of every write path, the Scan pipeline (`src/scan/*`, `pages/ScanPage.tsx`, `scripts/copy-ocr-assets.mjs`), `/locate`, brand/model/barcode in the form, cards and import, and the production build served by the backend. The checks are SPEC §F plus the Phase 1.5 backend notes.

### How it was verified

- **Build.** `tsc` passes. `vite build` (to a temp dir): the main chunk `index-*.js` is 236 kB (75 kB gzip) and contains **no** tesseract or zxing code (grep). `ScanPage-*.js` is 414 kB (113 kB gzip). OCR assets land in `dist/ocr/`: worker 0.1 MB, two LSTM cores of 3.9 MB each, `eng.traineddata.gz` 2.9 MB.
- **Server.** The backend ran on `PORT=3301` with `NODE_ENV=production`, `FRONTEND_DIST=<temp dist>`, a temp DB and a temp `CONFIG_PATH`, with the PIN set via `npm run set-pin -- --pin 2468`. The CSP header was exactly as in SPEC. Deep links `/scan`, `/locate` and `/items/:id/edit` return 200 HTML. A missing `/assets/x.js` returns 404.
- **Browser runs.** Playwright Chromium at 360×740 and 1280×800, deviceScaleFactor 1. Screenshots are `/tmp/fe-review-shots/p15-*.png`. No page scrolls horizontally at 360 px (`/`, `/scan`, `/locate`, `/map`, item detail and edit, `/import`, `/items/new`).
- **Scan, production build.**
  - Nothing scan-related loads on `/`. The chunk loads when the Scan page opens. `/ocr/*` loads only on the first OCR.
  - Only `worker.min.js`, `tesseract-core-simd-lstm.wasm.js` and `eng.traineddata.gz` are fetched, all from our origin. **Zero external requests and zero CSP violations.** The CDN URLs that tesseract.js bundles as defaults are overridden and never used.
  - A synthetic EAN-13 photo is decoded by the bundled zxing (headless Chromium has no `BarcodeDetector`) and matches "Head torch (LED)" on barcode.
  - A label photo ("COLEMAN / Sundome 4P …") is OCR'd correctly and matches the Coleman items on brand and model.
  - A 4000×3000 (12 MP) JPEG is downscaled, OCR'd ("PETZL / Tikkina") and matched.
  - A blank photo gives "No matching item found".
  - Editing the text and pressing "Search with this text" works.
- **Leader mode, production build.**
  - Locked Add, Import, Edit, Delete and `/locate` Save all open the PIN dialog first and carry on after unlocking. The import **dry run** is also gated: no `/api/import` request is sent before the PIN.
  - A 401 clears the token, re-asks for the PIN and retries once (2 PUTs). An "always 401" server stops after exactly 2 PUTs and shows the error, so it **cannot loop**.
  - A garbage stored token is cleared by `/api/auth/status` on load.
  - Lock removes `etroop.leaderToken`.
  - The token never appears in a URL or the console.
  - With `localStorage` fully throwing, the in-memory fallback works.
  - Mocked 429 shows "Too many wrong tries — wait 5 minutes…". Mocked 403 switches to the "Leader PIN not set up" dialog with focus on OK.
- **Unit tests.** The concurrent tester's `tests/phase15-tester.test.tsx` (untracked) currently has 3 failing tests. They match P1, P4 and P5 below independently.

### Major

**P1. After a wrong PIN, focus is lost: Escape and the focus trap stop working, and the phone keyboard closes.**
`src/leader/PinDialog.tsx:48-56` with `:125`.

The catch block calls `setBusy(false)` and then immediately `inputRef.current?.focus()`. At that moment the input is still `disabled={busy}`, because React has not re-rendered yet, so `focus()` does nothing and focus falls to `<body>`.

Verified: after a wrong PIN, `document.activeElement` is BODY. Four Tabs land on the page's "Search" tab link outside the dialog. **Escape does nothing**, because the `onKeyDown` handler sits on the dialog and focus is no longer inside it. On a phone, the numeric keyboard closes after every wrong try, so the leader has to tap the box again. The same happens after 429 and network errors.

Fix: move focus in an effect after re-render (e.g. `useEffect(() => { if (!busy && error) inputRef.current?.focus(); }, [busy, error])`), or use `readOnly` instead of `disabled` while checking. Also attach the Escape handler at `document` level while the dialog is open.

**P2. If the OCR language data or core fails to load mid-way, the scan hangs forever, and every later scan in that tab hangs too.**
`src/scan/ocr.ts:18-37`, `src/pages/ScanPage.tsx:84-89`.

Verified with requests aborted in a fresh browser context:

| Blocked file | Result |
|---|---|
| `eng.traineddata.gz` | Spinner stays on "Starting the text reader… (the first time can take a while)" for over 60 s and never ends. The only signal is an uncaught `Error: TypeError: Failed to fetch` page error. Both photo buttons stay disabled (`busy`), so the user can't retry. |
| core or `worker.min.js` | Fails properly, but only with the generic "Something went wrong while reading the photo." |

Because `workerPromise` is cached while still pending, it never resolves or rejects. Every later scan in the tab therefore hangs at the same step, even after the Wi-Fi recovers, until a full page reload.

Real triggers:
- flaky troop Wi-Fi during the one-time ~7 MB download;
- a laptop `dist/` built without the `ocr/` files (e.g. `vite build` run directly, skipping `prebuild`).

Fix:
- Wrap worker creation and `recognize` in a timeout (e.g. 60–90 s for loading, then per job). On timeout or error, `terminate()` the worker and reset `workerPromise`.
- Listen for tesseract's `errorHandler` option, or worker `error` events, so load failures reject.
- Map failures to a clear message: "The text reader couldn't load from the laptop — check the Wi-Fi and try again", plus "Type to search". Keep any barcode result already found.
- Make `copy-ocr-assets` failures fail the build, which `prebuild` already does. Also make the backend or `start.bat` warn when `dist/ocr/` is missing.

### Minor

**P3. Tesseract worker is never terminated; scans aren't cancelled when the user leaves.**
`src/scan/ocr.ts:15-49`, `src/pages/ScanPage.tsx:41-113` (there is no unmount cleanup).

The worker (wasm heap plus language model, tens of MB) lives for the whole session, even after the user leaves Scan. Verified: Playwright's worker `close` event never fires after navigating to `/map` mid-OCR. On the old Android phones in the brief, this memory competes with Chrome's tabs.

The running job also isn't cancelled:
- `runId` isn't bumped on unmount, so the pipeline still sends `/api/scan/match` after the page has closed (the tester's failing "leaving the page mid-scan" test).
- `progressListener` is module-global, so a job abandoned on one visit drives, and then nulls (`finally`), the progress of the next visit's job, which also has to queue behind it.

Fix:
- On unmount, `runId.current++`.
- Terminate the worker after N minutes idle, or on unmount when a job was running (`worker.terminate()` + `workerPromise = null`).
- Pass the progress callback per job, or check the job id in the logger.

**P4. `localStorage` that can be read but not written loses the token, so leader mode can never turn on.**
`src/lib/auth.ts:17-35, 51-58`.

`setToken` falls back to `memory` when `setItem` throws, but `readStorage` only returns `memory` when `getItem` *throws*. When writes fail but reads work (quota full, old private modes), `getItem` returns `null` and the in-memory token is ignored.

Verified: the user enters the PIN, the save fails with 401, they are asked for the PIN again, and then they get "Leader PIN required. Unlock leader mode first." The button stays 🔒. (The tester's failing quota test shows the same.)

Fix: in `readStorage`, return `memory` when storage has no value (`if (!raw) return memory;`). Alternatively keep a "storage writable" flag.

**P5. `/locate`: after the last item is saved, focus drops to `<body>`.**
`src/pages/LocatePage.tsx:88-92`.

`next` is `undefined` for the final row, so nothing is focused. The row is removed and the empty state appears. Verified: `activeElement` is BODY, and the announcement is only "Saved UNL-005 at R03-D-1.".

Fix: when there is no next row, focus the empty state's heading (render it with `pageHeading` or a `tabIndex={-1}` heading) and announce "Every item has a location."

The rest of the flow works well (verified):
- A locked Enter opens the PIN dialog; after unlocking, the save goes through and focus jumps to the next box.
- The announcement reads "Saved UNL-001 at R01-A-3. Next: Unlocated thing 2.".
- Rack prefix `R03` + `b-4` gives `R03-B-4`. An invalid entry keeps focus and shows an inline error.
- The server confirms 0 unlocated items afterwards.

**P6. Peak memory with 12 MP photos: the full-size image is decoded twice.**
`src/scan/imagePrep.ts:13-31`, `src/pages/ScanPage.tsx:58, 190`.

`createImageBitmap(file)` decodes at full resolution: about 48 MB for 4000×3000 RGBA, before the 1600 px downscale. At the same time, the 120 px thumbnail `<img src={objectURL of the original}>` makes the browser decode the full 12 MP image again. Together with the canvas and `getImageData` (about 10 MB), the peak is roughly 100 MB on the main thread on phones that may have 2–3 GB RAM. (Desktop Chromium copes: the 12 MP test finished in about 1.1 s. I couldn't measure memory on a real low-end phone here.)

Fix:
- Decode downscaled: read the dimensions first, then `createImageBitmap(file, { resizeWidth, resizeHeight, resizeQuality: 'medium', imageOrientation: 'from-image' })`.
- Show the prepared canvas as the thumbnail (`canvas.toBlob` → object URL), not the original file.
- Release the canvas (`canvas.width = 0`) once the scan is done.

**P7. Scan error messages are generic.**
`src/pages/ScanPage.tsx:108-111`.

Tesseract rejects with non-`Error` values or terse network errors, so the user sees "Something went wrong while reading the photo." for a missing core, a worker 404 or a network drop. Map these to actionable text (see P2) and log the detail to the console for the maintainer.

### Nit

- **N1** `Layout.tsx:120`: the leader button's accessible name ("Leader mode on. Lock") doesn't contain the visible text "Leader on · Lock" (WCAG 2.5.3, label in name). Use the visible text plus extra context, e.g. "Leader on · Lock (leave leader mode)". Locking gives no confirmation; consider `announce('Leader mode off')`.
- **N2** `PinDialog.tsx:52`: the 429 text is hard-coded to "5 minutes". The server sends `Retry-After` and `details.retryAfterSeconds` (and the backend is changing its rate limits), so show the real wait time.
- **N3** `ScanPage.tsx:259`: `<h2 role="status">` replaces the heading role, so "Found N matches" is no longer a heading. Wrap the h2 in a `div role="status"` instead, as the no-match branch already does.
- **N4** `ItemFormPage.tsx` (barcode input): `inputMode="numeric"` gives Android a digits-only keypad, but SPEC allows letters (Code 39/128). Use `inputMode="text"` with `autoCapitalize="characters"`, or add a hint.
- **N5** `SearchPage.tsx:95`: at 360 px the camera button cuts the placeholder to "Search tent, TNT-00" (`p15-search-locked-360.png`). Shorten it, e.g. "Tent, TNT-004, R03…".
- **N6** `auth.ts` / `LeaderContext.tsx`: the `leader` state isn't updated when the token expires while the app is open (30 days), or when another tab locks (no `storage` event listener). Writes still re-ask correctly, but the button can show "Leader on" while locked.
- **N7** Locked Edit and Delete show a 🔒 that is `aria-hidden`, so screen-reader users only learn about the PIN when the dialog opens. Consider "Edit item (needs leader PIN)" as visually-hidden text.
- **N8** `/ocr/*` is served `no-cache`, so it is revalidated on every first OCR per page load (a 304 is cheap) and isn't fingerprinted. Fine for now. If the files ever move under `assets/` with hashes, they get the immutable cache.

### Not frontend (for the backend dev; noting only)

- Scan ranking for the label "COLEMAN / Sundome 4P / 4 PERSON DOME TENT" put **TNT-004 "Sundome 4"** above **TNT-030 "Sundome 4P"**, which is the exact model. Both were "Matched on: model, brand, name". The exact model token should outrank a partial one. (`backend/src/lib/scanMatch.js` is being changed right now, so please re-check after that lands.)

### Phase 1.5 verdict

**Approve with changes.**
- Token handling is sound: storage wrapped, retry-once can't loop, token never in URLs or logs, lock clears it.
- Every write path is gated, including the import dry run and `/locate` saves.
- Lazy loading really keeps tesseract and zxing out of the main bundle.
- OCR and barcode run fully offline under the production CSP, with no CDN requests.

Fix before handing the laptop over:
- **P1**: PIN dialog focus after a wrong PIN.
- **P2**: OCR hangs forever if its assets fail to load.

P3–P5 are small and worth doing in the same pass. P6 matters mainly on the oldest phones.

---

## Phase 1.5 verification (commit 46f3f3e)

**Setup.**
- Built to a temp dist: `tsc` passes. The main chunk is 240 kB with no tesseract or zxing code; `ScanPage` is a separate 418 kB chunk.
- Served by the backend with `NODE_ENV=production`, `PORT=3301`, a temp DB and `CONFIG_PATH`, and the PIN set to `246810`.
- Driven with Playwright at 360×740, deviceScaleFactor 1.

| # | Status | Evidence |
|---|---|---|
| **P1** PIN focus | **Fixed** | Wrong PIN, mocked 429 and an aborted (network) login all leave focus in the PIN box (`readOnly` while checking, focus restored in an effect). Five Tabs stay inside the dialog, and Escape closes it, returning focus to the trigger. The 429 now reads "wait 2 minutes", from `Retry-After`. The right PIN unlocks. |
| **P2** OCR language file blocked | **Fixed** | With `eng.traineddata.gz` aborted, the error appears after **0.5 s**: "The text reader couldn't load — check you're on the store-room Wi-Fi and try again. The English language file (ocr/eng.traineddata.gz) did not load." Both photo buttons are enabled again. After unblocking, a new scan in the **same tab** succeeds in 1.4 s, so the failed start is not cached. There are no page errors, and no requests leave the origin (only a same-origin `blob:`). There are also 45 s and 60 s timeouts for start-up and reading. |
| **P3** Worker / cancellation | **Fixed** | Leaving `/scan` mid-OCR terminates the worker (Playwright `close` fired), and no `/api/scan/match` request is sent after leaving. Coming back and scanning again works. The worker is also terminated after 2 minutes idle (code). |
| **P4** Read-OK / write-fail storage | **Fixed** | With `setItem` throwing QuotaExceeded: one PIN entry, one PUT, saved, and the button shows "Leader mode on". `setToken` now verifies the write and falls back to a memory-only token. |
| **P5** `/locate` last item | **Fixed** | Focus moves to the h2 "Every item has a location". The announcement is "Saved UNL-002 at R02-B-1. Every item has a location." |
| **P6** 12 MP memory | **Fixed** (code review) | The photo is decoded once, already downscaled (`createImageBitmap` with `resizeWidth`/`resizeHeight`, size read first). The thumbnail is a 240 px canvas (`role="img"`, `aria-label="Your photo"`), so the original is never shown or decoded again. The working canvas is released after the scan. |
| **P7** Error messages | **Fixed** | `OcrError` gives friendly text that names the missing part (worker, core, language file or start-up), plus messages for a read timeout and a failed read. The details go to `console.warn` for the maintainer. |
| Nits | Fixed | N1: the visible text "Leader mode on · Lock" now matches the name. N2: 429 uses `Retry-After`. N3: the results h2 is wrapped in a `div role="status"`. N4: the barcode field is `inputMode="text"`. N5: placeholder shortened to "Tent, TNT-004, R03…". |

**New issues:** none found in this focused pass.

**Note:** `PinDialog` still accepts 4–5 digits on purpose (legacy PINs; the server decides), while the hint and validation message say "6 to 8 digits". This is fine, but the message for 1–3 digits says "6 to 8" even though 4 would be sent.

**Verdict:** P1–P7 and the Nits are all fixed. **Phase 1.5 frontend approved.**
