# Frontend test report (Phase 1)

Tester: Frontend Tester · Date: 2026-11-25 · Scope: `frontend/` against `docs/SPEC.md` (with the backend implementation notes)

## Summary

| Suite | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Vitest (unit + component, jsdom, API client mocked) | 172 | 170 | **2** | 0 |
| Playwright e2e (real backend + temp DB + seed, Vite dev server; projects `desktop` 1280 px and `mobile-360`) | 34 | 31 | **2** | 1 |

There are 4 failures, and all of them are **app bugs**. They come from 2 distinct bugs: Bug 1 fails 1 Vitest test and 2 e2e tests (one per viewport), and Bug 2 fails 1 Vitest test. No failure is caused by a test bug. `npm run typecheck` passes, test files included.
The 1 skipped e2e test is the 360-px layout test, which is skipped on purpose in the `desktop` project.
The 14 Vitest tests and 2 Playwright smoke tests that were already there still pass.

### How to run

```bash
cd frontend
npm test                                    # vitest
# e2e on non-default ports with a throw-away DB (ports are now env-configurable; defaults unchanged)
E2E_BACKEND_PORT=3401 E2E_WEB_PORT=5473 E2E_DB_PATH=/tmp/etroop-e2e.db npx playwright test --trace off
```

`playwright.config.ts` change: new optional env vars `E2E_BACKEND_PORT` (default `3001`) and `E2E_WEB_PORT` (default `5173`). The backend web server gets `PORT`. The Vite server gets `--port` and `BACKEND_URL`, so the `/api` proxy follows the backend port. Nothing else changed, and app source was not modified.

## Bugs found

### Bug 1 (medium, navigation): after saving an edit, the detail page's **Back** link goes back to the edit form
- Failing tests:
  - `tests/itemForm.test.tsx` › *Edit item form › after saving, the detail page Back link does not return to the edit form*
  - `e2e/store.spec.ts` › *add / edit / delete › after saving an edit, Back on the detail page returns to the search (not the edit form)*. This fails in both `desktop` and `mobile-360`.
- Steps:
  1. Search `?q=<code>`.
  2. Open the item.
  3. Click **Edit item**.
  4. Change the quantity and click **Save changes**. You land on the detail page with "Changes saved."
  5. Click **‹ Back**.
- Expected: you return to the search results (`/?q=<code>`), which is the documented purpose of the Back link ("keeps the previous search text").
- Actual: you land on `/items/:id/edit` again, a reloaded edit form. History is `/?q → /items/:id → /items/:id/edit → /items/:id`, and `navigate(-1)` lands on the edit entry.
- Cause: `ItemFormPage` navigates after an edit with `replace: !item`. That is a push for edits and a replace only for new items. The likely fix is `replace: true` for edits as well, or navigating back to the existing detail entry.
- Verdict: **app bug**.

### Bug 2 (low, validation and a11y): backend errors for **Category** and **Location** are not shown on those fields
- Failing test: `tests/itemForm.test.tsx` › *Add item form › shows backend errors for category / location inline on those fields too*.
- Steps: submit the form when the backend answers 400 with `details: [{path:'category',…},{path:'locationCode',…}]`. The real backend does this for a category or location over 100 characters.
- Expected: like code, name, quantity, unit and notes, the field gets `aria-invalid="true"`, the inline message and `aria-describedby`.
- Actual: the messages only appear in the summary at the top. The Category and Location inputs have no inline error, no `aria-invalid` and no description. `fieldError('category' | 'location')` is never rendered.
- Verdict: **app bug** (minor).

### Observations (not failing tests, low priority, for the developer to decide)
1. **Tab bar on the edit page:** on `/items/:id/edit` no tab is marked active. `NAV.isActive` for Search only matches `/items/\d+$`.
2. **Search tab does not clear the search:** clicking the **Search** tab while on `/?q=tent` keeps the search. The component keeps its `text` state and re-writes `?q=tent` to the URL.
3. **Bad rack URLs:** `/racks/abc` shows the generic "Couldn't load this rack" error (backend 400) with a **Try again** button. Retrying can never help, so a not-found-style message would be friendlier.
4. **No test id on the empty location badge:** `LocationBadge` for an item with no location ("No location yet") has no `data-testid="location-badge"`. This is fine, but it is not consistent with the other badge states.

## What is covered

### Vitest (`frontend/tests/`)

Shared helpers:
- `apiMock.ts` mocks every `api.*` method with defaults.
- `helpers.tsx` provides `makeItem`, `renderApp(path | history[])` using `MemoryRouter` with `routerFuture`, and `currentLocation()`.

| File | Tests | Covers |
|---|---:|---|
| `search.test.tsx` | 13 | Labelled search box has autofocus. All items show on load. Result card shows code, name link, quantity and unit, category, condition text, the 📍 location badge and its description. Items with no location or a non-coordinate location are handled. **Debounce** is checked with fake timers: fast typing sends only `q=tent`, and only after `SEARCH_DEBOUNCE_MS`. Query is trimmed and synced to `?q=`. Initial `?q=` pre-fills the box. No-match empty state. Empty-store state with add and import links. Error state, then **Try again** recovers. Category filter is sent to the API and stored in the URL. Live-region result count. A stale slow response is ignored. Clicking a card opens the detail page. |
| `itemDetail.test.tsx` | 19 | All fields shown, plus the document title. **Rack diagram highlights exactly one bin (`data-shelf=B`, `data-bin=2`)**, with shelf A on top, the "here" text marker, a bin count sized to the rack, and an SR summary. **Store map highlights only R03**, with a "Here" label and an aria-label. Shelf-only (`R03-B`) and rack-only (`R03`) locations. No location, and a non-coordinate location. 404 not-found. 500 then retry. Rack request fails, so the diagram falls back to the item. Edit link. **Delete confirmation**: dialog has `aria-modal` and focus on Cancel; Cancel restores focus; Escape and a backdrop click cancel; Tab focus trap; busy state disables the buttons; confirm calls `deleteItem(id)`, navigates to `/` and shows the flash; a failed delete shows an alert. Back link uses history (keeps `?q=`) and falls back to `/`. |
| `itemForm.test.tsx` | 22 | Pure `validate` and `toInput`: required fields, whole-number quantity ≥ 0, uppercase code, canonical location, defaults. Default form values and condition options. **Validation:** summary gets focus, links point to the fields, `aria-invalid` and `aria-describedby` are set, and errors clear live once fixed. Fractional quantity is rejected. **Live location preview** for 4 loose inputs, plus a warning for non-coordinates (still saved as typed). Create sends a normalised payload, then shows the detail page with a flash. Submit is disabled while saving. 409 shows an error on the code field, which clears when the code is edited. 400 details are mapped to fields. Network error keeps the typed values. Edit form: pre-filled, `updateItem` payload, clearing the location sends `null`, unknown id shows not-found, Back after save (**Bug 1**). Inline Category and Location errors (**Bug 2**). |
| `import.test.tsx` | 14 | `checkFile` (type and the 5 MB limit), warning vs problem split, friendly error wording. Template link. Wrong type and over 5 MB are rejected on the client with no API call. **Dry run starts automatically** with `importFile(file, true)` while showing "Checking…" with the input disabled. Shows counts, the problems table, the warnings table (with "Warning:" stripped), ignored columns and preview rows. **Confirm import** sends `importFile(file, false)` and shows the finished summary and links, then "Import another file". Confirm is disabled when there is nothing to import. "Choose a different file". 400 `missingColumns` shows a hint, the template link and no retry. 413 message. A network failure during the real import says nothing was saved, and retry repeats the real import. Step indicator uses `aria-current`. |
| `mapRack.test.tsx` | 16 | Map tiles show counts, a shelf span and links. Unlocated-items note (plural and singular). Empty state. Error, then retry. Tap a tile to open the rack view. Rack param `r3`, `3`, `R03` and `R3` all become `R03`. Items grouped by shelf in bin order, "No bin", an unshelved section and links. Occupied bins are marked. 404 empty state. Layout: skip link, labelled nav with 4 tabs, `aria-current`. 404 route. Flash message has a live region and can be dismissed. |
| `components.test.tsx` | 14 | `ConditionChip` shows text plus a symbol for all 4 conditions (never colour alone). `LocationBadge` states. `RackDiagram` sizing, highlight and defaults. `StoreMap` highlight and non-link mode. `describeLocation`, `shelfRange`. |
| `apiClient.test.ts` | 10 | Query building (skips empty filters). Signal pass-through. POST, PUT and DELETE (204). List unwrapping. URL encoding. Multipart import with no JSON content type and the `dryRun` flag. Error envelope becomes `ApiError(message, status, details)`. Non-JSON errors. Network failure gives status 0. AbortError is re-thrown. |
| `locationParity.test.ts` | 50 | The frontend `parseLocation` and `normalizeRack` give **identical output to the backend parser** (`backend/src/lib/location.js`, read-only) for 40 + 10 inputs, including loose, Malay-word, odd-separator, out-of-range and garbage inputs. This guarantees the form preview shows exactly what will be saved. All pass. |
| `location.test.ts`, `App.smoke.test.tsx` | 13 + 1 | Existing tests, unchanged. |

### Playwright (`frontend/e2e/store.spec.ts` + existing `smoke.spec.ts`)

The suite starts the real backend with a fresh temp SQLite DB and `npm run seed`, plus the Vite dev server. Every test runs in **both** projects, `desktop` and `mobile-360` (360×740, touch). Tests that create data use codes unique to each project and run.

- **search → detail → map:** search "dome" (URL becomes `?q=dome`). The card badge shows `R01-B-2`. The detail page has exactly one highlighted bin (shelf B, bin 2, "here") and the map highlights R01. Back returns to the same search. "See everything on rack R01" opens the rack page with shelf B listed.
- Coordinate search `?q=r3-b`: every badge contains `R03-B`.
- No-match empty state.
- Map page: 6 rack tiles. Tap R03 to open the rack page. `/racks/r3` is accepted.
- Unknown item id shows not-found.
- **Add item:** an empty submit shows the summary, which gets focus. Lower-case code. Location `r6 c 3` previews as `R06-C-3`. Category, quantity and condition. Save leads to the flash and the detail page highlighting bin 3, and the item can be found by search.
- Duplicate code `tnt-004` gives a 409 message and `aria-invalid` on the code field.
- **Edit item:** location `2/d/4` previews as `R02-D-4`. Quantity and notes are changed, and the detail page and map highlight R02. Also verified through the API.
- Back after saving an edit (**Bug 1**, fails).
- **Delete:** the dialog puts focus on Cancel, Escape keeps the item, confirm deletes it and shows the flash. Verified through the API.
- **Import a generated .xlsx** (made with exceljs). It has a title row above the header, Malay headers (Kod/Nama/Lokasi/Kategori/Qty/Keadaan) and an unknown "Colour" column. Rows: a new item, an update of an existing code, a row with no name (problem) and an unknown condition (warning). The dry run shows 2 added, 1 updated, 1 skipped, 1 problem and 1 warning, ignores "Colour", and shows the preview row as `R02-B-3` with Update/Add new. Nothing is written by the dry run. **Confirm** gives the finished counts, and the data is verified through the API: a new item and the updated item (same id). The imported item is then found through the search UI.
- CSV without code and name columns gets the friendly "couldn't find the … column" message, the headings found ("Barang") and the template link.
- A `.xls` file is refused on the client.
- Template download is `item-template.xlsx` and is a real zip/xlsx (starts with `PK`).
- Main screens and the detail and edit pages produce **no page errors and no `console.error`** (React warnings included).
- **360 px** (mobile project only): on `/`, `/?q=tent`, `/map`, `/racks/R01`, `/items/new`, `/import` and an item detail page, the page has no horizontal scroll, the tab bar is pinned to the bottom, every tab is at least 44 px tall, and the Delete button can be scrolled clear of the tab bar. All of these pass.

## Notes
- E2E servers ran on backend `:3401` and Vite `:5473` with temp DBs. All servers were stopped afterwards.
- Failure screenshots from the last run are in `frontend/test-results/`, which is gitignored.
- Tests import the backend's `location.js` and `exceljs` read-only. Nothing in `backend/` was modified.

---

## Round 2 (re-test after commit 74d6d68)

Date: 2026-11-25. E2E ran on backend `:3401` and Vite `:5473`, each run with a fresh temp DB and `--trace off`. All servers were stopped afterwards.

### Results

| Suite | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Vitest (all files, incl. developer's `round2.test.tsx` and my `round2-tester.test.tsx`) | 245 | 241 | **4** | 0 |
| Playwright (`smoke`, `store`, developer's `round2`, my `round2-tester`; desktop and mobile-360) | 68 | 63 | **4** | 1 (360-px-only test on desktop) |

`npm run typecheck` passes.

All 8 failures are **app bugs**. They come from 3 distinct bugs plus 1 minor race (R2-1 to R2-4 below). No failure is caused by a test bug.

### Round 1 bugs: both fixed
- **Bug 1 (Back after saving an edit goes back to the form): fixed.** The round-1 tests now pass: vitest *after saving, the detail page Back link…* and e2e *after saving an edit, Back…* (desktop and 360). New tests also pass:
  - browser Back after save
  - two edit/save cycles in a row
  - Cancel after a failed (409) save
  - Forward after Back
- **Bug 2 (no inline errors on Category and Location): fixed.** Both fields now get `aria-invalid` and an inline message.

### The 2 assertions the developer changed in `tests/itemForm.test.tsx`
Both changes are **legitimate**:
1. The summary for a backend 400 now reads "Please fix the highlighted fields." instead of the raw "Validation failed". This follows the lead's decision on friendlier wording, and the per-field messages are still asserted.
2. The Category message is now "Category can be at most 100 characters" instead of raw zod text ("Too big: …"). The developer also added stricter checks: a matching Location message, and no raw "Too big" or "expected string" text anywhere in the summary.

Neither change weakens what the tests check.

### New bugs found in round 2

**R2-1 (medium, history): an edit form opened directly (first history entry) leaves itself behind in history**
- Failing tests:
  - vitest *edit opened directly (first entry) → Cancel → Back does not reopen the cancelled form*
  - vitest *… → "Back to item" → Back does not reopen the form*
  - e2e *edit opened by URL → Cancel → Back does not reopen the cancelled form* (desktop and 360)
- Steps:
  1. Open `/items/5/edit` directly, for example from a bookmark, a shared link or a new tab.
  2. Click **Cancel** or **‹ Back to item**. The detail page opens.
  3. Click **‹ Back**.
- Expected: you go to the search (`/`), like after *saving* a directly opened edit, which works.
- Actual: you go back to `/items/5/edit`, the form you just cancelled.
- Cause: `backToItem` only intercepts the click when the entry is not the root entry. On the root entry the `<Link>` *pushes* `/items/5` without `{ root: true }` state. On the new entry `isRootEntry` is false, so the detail page's Back runs `navigate(-1)`.
- Fix idea: in the root case, `navigate('/items/5', { replace: true, state: replaceState(location) })`. This is what the save path already does.

**R2-2 (low): bin 0 is accepted but never highlighted**
- Failing tests:
  - vitest *bin 0 (accepted by the parser, e.g. "R03-B-0") is highlighted*
  - e2e *bin 0 … is still highlighted on the detail page* (desktop and 360)
- Steps: save an item with location `r6-a-0`. Both parsers accept it as `R06-A-0` with bin 0. Then open the item.
- Expected: the rack diagram marks the item's bin, or the location is refused or warned about.
- Actual: shelf A gets "◀ here", but no bin carries the 📍. The screen-reader summary still says "Highlighted: shelf A, bin 0". The bug is in `binColumns`, which always draws bins from 1 upwards.
- This needs a product decision. Either draw a bin 0 column, or have the frontend and backend parsers reject bin 0.

**R2-3 (low, race): the Search tab does not clear a query typed less than 200 ms before**
- Failing test: vitest *Search tab clicked while a just-typed query is still debouncing also clears it*.
- Steps:
  1. On `/`, type `rope`.
  2. Click the **Search** tab within the 200 ms debounce.
- Expected: the box is empty and the URL is `/`.
- Actual: the box keeps `rope`, and when the debounce fires the URL becomes `/?q=rope`.
- Cause: the URL→box sync only runs when `?q=` *changes*. It was already empty, so clicking the tab changes nothing that the page sees.
- Rare in practice, but it is the case where "Search clears" visibly fails.

### Re-test checklist
| Area | Result |
|---|---|
| Back after edit (link and browser Back, repeated saves, failed save then Cancel, Forward) | Pass |
| Back after an edit opened directly: **save** | Pass |
| Back after an edit opened directly: **Cancel / Back to item** | **Fail: R2-1** |
| Back after delete (browser Back never shows "not found"); Back after add skips the add form | Pass |
| Flash shown once only (not again after Back) | Pass |
| Rack diagram with many bins at 360 px: 30 bins plus a highlight on bin 27; also 40 bins and bin 9999 | Pass. Highlighted bin stays in the viewport and ≥ 24 px wide, no sideways page scroll on detail or rack pages, gap collapsed for 9999 |
| Rack diagram, bin 0 | **Fail: R2-2** |
| Search tab and logo clear the query and category; browser Back restores the query | Pass |
| Search tab inside the debounce window | **Fail: R2-3** |
| Unknown category in the URL, `&` and spaces round-trip, category kept while typing | Pass |
| Focus on route change: h1 after link and tab clicks; search box keeps focus when going to Search; no focus move on first load; typing and category changes never steal focus; failed submit focuses the summary; error page parks focus on `<main>` then the h1 after retry; h1 after save via Back; not-found h1; Tab from the h1 reaches the first rack tile (real browser) | Pass |
| `/items/abc`, `/1.5`, `/-1`, `/7abc`, `/%20`: not-found with no API call and no Try again; `/items/0` (400) and `/items/abc/edit` not-found; 500 still offers Try again | Pass |
| `/racks/foo`, `R1000`, `R03-B`, `rack`, emoji: "isn't a rack" with no API call and a map link; `/racks/9` (404) shows the empty-rack message | Pass |
| Import: re-pick the same file (after a preview and after a 400) runs a fresh check; 429 gives a friendly message and Try again works; unchanged count shows "Already up to date" and "Unchanged"; "No change" rows; unknown action shown as-is; an all-unchanged file disables Confirm with the right text; no unchanged stat when the backend omits it | Pass |
| Real backend: re-importing the same CSV shows "Already up to date 2", Confirm is disabled, request sequence is `dryRun=true,true,false,true` | Pass |

**Test bug fixed along the way:** my first e2e focus test pressed Tab before the map had loaded, so focus fell off the end of the page. It now waits for the map, and also checks that the h1 *keeps* focus after the data loads.

### New and changed test files (round 2)
- `frontend/tests/round2-tester.test.tsx` (49 tests).
- `frontend/e2e/round2-tester.spec.ts` (14 tests × 2 projects).
- `frontend/tests/helpers.tsx` now has hidden Back/Forward history buttons and `browserBack()`, which simulate the browser's buttons in `MemoryRouter` tests.
- The developer's own `tests/round2.test.tsx` and `e2e/round2.spec.ts` were not changed, and they pass.

---

## Phase 1.5 (commit f23f178): leader mode, Scan, Needs a location

Dates: 2026-11-26 and 27.
- Dev-mode e2e ran with backend `:3401` and Vite `:5473`, a fresh temp DB and PIN 2468 (set by global-setup), with `--trace off`.
- **Production mode** was also run. I built the frontend with `vite build --outDir <tmp>`; the repo's `dist/` was not touched. The backend then served it with `NODE_ENV=production FRONTEND_DIST=<tmp> HOST=127.0.0.1 PORT=3401` and its own temp DB and config. The whole Playwright suite ran against it with `E2E_NO_SERVER=1 E2E_BASE_URL=http://localhost:3401 E2E_PROD=1`.
- All servers were stopped afterwards and the temp build was deleted.

### Results

| Suite | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Vitest, all files (new: `tests/phase15-tester.test.tsx`, 62 tests) | 345 | 342 | **3** | 0 |
| Playwright, dev mode, all specs (new: `e2e/phase15-tester.spec.ts`, 23 tests × 2 projects) | 124 | 117 | **2** | 5 |
| Playwright, **production build**, all specs | 124 | 121 | **2** | 1 |

- The 5 dev-mode skips are the 2 production-only tests in each of the 2 projects, plus the 360-px-only layout test on desktop.
- In production mode only that 360-px skip remains.
- `npm run typecheck` passes.
- All 5 failing tests are **app bugs**, 3 distinct ones (P15-1 to P15-3 below). None is a test bug.
- All tests from earlier rounds and the developer's `phase15` tests pass.

### App bugs

**P15-1 (medium, a11y/mobile): after a wrong PIN, the PIN box loses focus.**
- Failing tests:
  - vitest *wrong PIN: message, input cleared and focused…*
  - e2e *wrong PIN keeps the dialog open… PIN box ready to type again*, which fails on desktop and 360 px, in both dev and production mode.
- Steps:
  1. While locked, tap a gated action, or the 🔒 Leader button.
  2. Enter a wrong PIN and tap **Unlock**.
- Expected: "That PIN isn't right" is shown and the cleared PIN box has focus, so the user can type again (the code even calls `inputRef.current?.focus()` for this).
- Actual: focus is on nothing (`<body>`). On a phone the numeric keyboard closes and the user has to tap the box again. The same happens after a 429 or a network error.
- Cause: the input is `disabled={busy}`. `setBusy(false)` and `focus()` run in the same tick, so `focus()` runs while the input is still disabled. Fix: focus in an effect after `busy` turns false, or use `readOnly` instead of `disabled`.

**P15-2 (medium): unlocking does nothing when localStorage reads work but writes throw.**
- This happens with a full storage quota, older Safari private mode, or some locked-down Android WebViews.
- Failing test: vitest *localStorage where only writes fail…*.
- Steps: `localStorage.setItem` throws (`QuotaExceededError`) while `getItem` works. Enter the right PIN.
- Expected: leader mode turns on, keeping the token in memory as the README promises ("in-memory fallback").
- Actual: the dialog closes and the action carries on, but `getToken()` is `null` and the button still says "Leader".
  - The write goes out without a token and gets a 401, which re-prompts for the PIN.
  - Re-entering the PIN fails the same way, so the user sees "Leader PIN required" after two PIN entries.
- Cause: `readStorage()` only falls back to `memory` when `getItem` *throws*. Here `getItem` returns `null`, so the in-memory token is never used.
- The "everything throws" case works and has a passing test.

**P15-3 (low): leaving the Scan page mid-scan does not stop the scan.**
- Failing test: vitest *leaving the page mid-scan abandons the scan…*.
- Steps: pick a photo, then tap another tab while it is "Reading text…".
- Expected: the abandoned scan stops; at least, no `/api/scan/match` request is sent afterwards.
- Actual: when the OCR finishes in the background, the match request is still sent. The unmounted page then updates its state, which is harmless in React 18.
- Cause: `runId` is only bumped by a new scan, not on unmount. Bumping it in an unmount cleanup fixes it. There is nothing visible to the user; it wastes battery and a request on old phones.

### Test-harness finding (not an app bug; for whoever owns `playwright.config.ts`)
- `use.extraHTTPHeaders: { Authorization: Bearer <leader token> }` is applied by Playwright to **browser** requests too, not only to the `request` fixture.
- This **overrides the app's own Authorization header** on every page request. A forged or stale token in the app, and a "locked" page's writes, all reach the backend with the valid e2e token.
- My first runs of *stored token the server no longer accepts is dropped* and *401 mid-session* failed for this reason. Those were test-environment failures, not app bugs.
- My leader-mode tests now run with `extraHTTPHeaders: {}` and pass the token explicitly to API helper calls. After that change both pass against the real backend.
- Other specs that check locked/401 behaviour in the browser should do the same, or the token should be given only to the `request` fixture.

### What is covered (all passing unless listed above)

**Leader mode (vitest, API mocked)**
- Every gated action, locked: Add tab, Import tab, Edit, Delete (PIN first, then the delete confirmation, then the delete), Save on the add and edit forms opened by URL, choosing an import file (PIN before the dry run, then Confirm), and Save on `/locate`. Each one shows PIN → action continues, and Cancel/Escape does nothing.
- The same actions while unlocked never open the dialog or call login.
- The 🔒 hints and the leader-button names change with the state.
- PIN dialog:
  - `inputmode=numeric`, `autocomplete=off`, masked input, non-digits removed, maximum 8 digits.
  - A PIN under 4 digits is refused without asking the server.
  - Wrong PIN, then the right PIN, continues the action.
  - 429 shows "wait 5 minutes", and Cancel then runs nothing.
  - A 403 on login shows the setup-needed dialog, which has focus on OK.
  - A 403 on a write shows the same setup dialog.
  - A network error is shown in the dialog.
  - Focus goes back to the opener.
- 401 mid-session:
  - The token is cleared and the dialog explains the session ended. After unlocking, the save is retried exactly once.
  - **No loop:** a second 401 shows an error without a third prompt; login is called once and the write twice.
  - Cancelling keeps the form values.
  - A 401 on delete re-prompts, then deletes.
  - A 401 on the real import retries the real import (`true,false,false`), not the dry run.
- Token checks:
  - A server status of `leader:false` drops the token.
  - An offline status check keeps it.
  - Lock clears both storage and memory.
  - An expired token counts as no token.
  - A bare string or garbage stored value is handled.
  - localStorage that throws on every call works from memory.
  - Only-writes-throw storage fails (**P15-2**).

**Leader mode (e2e, real PIN backend)**
- Locked Edit → PIN → edit form; then Lock clears `localStorage`.
- Wrong PIN fails on focus (**P15-1**). Only the desktop project sends a real wrong PIN, to stay under the 5-tries limit; the mobile project uses a mocked 401.
- 429 and 403 (mocked responses): the wording is right.
- A forged stored token is dropped on start.
- **Real 401 mid-session:** a stale token makes the save get 401, the dialog asks again, and the PIN makes it 200. The PUT statuses are exactly `[401, 200]` and the data is saved.
- Locked import shows the PIN, then the dry run.

**Scan (vitest, `src/scan/engine` mocked)**
- Works while locked.
- Shows "Looking for a barcode…" with the inputs disabled.
- A barcode hit skips OCR: one `scanMatch({barcode})` and a card with 📍 and "Matched on: barcode".
- A barcode with no match falls back to OCR and sends `text` and `barcode` together.
- OCR text is cleaned, and several matches are shown best first with "Matched on".
- Text is cut to 2000 characters.
- Editable text: "Search with this text" is disabled when empty, and searching again replaces the results.
- Empty OCR gives the no-match screen without calling the API, and "Try another photo" clicks the camera input.
- OCR failure shows an error; the next photo then works.
- Image-preparation errors are shown.
- A failed match keeps the text for a retry.
- The same photo can be picked twice.
- Leaving mid-scan still sends the match request (**P15-3**), but coming back gives a fresh, idle page.
- The 📷 button and the Scan tab go to `/scan`.

**Scan (e2e, real tesseract.js and zxing; all non-localhost requests blocked and recorded)**

All photos are PNGs drawn in the browser canvas.
- A "COLEMAN / SUNDOME 4P / Made in China" label is read by OCR. It finds the item created with that brand and model ("Matched on: brand…", 📍 R06-D-2), and the editable text contains COLEMAN.
- A noisy, tilted "TNT-OO4" label (with the letter O) finds **TNT-004 first** ("Matched on: item code", R01-B-2).
  - I tuned the noise: with 900 specks plus a 2° tilt Tesseract read "© nroos", which is a limit of the test image; with 300 specks plus the tilt it reads `TNT-004`.
- A blurry photo with no text gives the friendly no-match screen.
- A **real EAN-13** is drawn by a small encoder in the test, with a valid check digit and a different barcode per project. It finds the item by barcode, and **no `/ocr/` file is ever requested**, which proves OCR was skipped.
- Fixing the text to "tnt 0O4 dome" and searching again finds TNT-004.
- No external request was attempted in any scan test, and there were no console errors.

**Needs a location**
- Vitest:
  - Rows show code, name and quantity, with a live normalised preview.
  - Enter saves, focus walks down the list, the last row's focus goes up, and the list ends in the empty state.
  - Rack prefix ("rack 3" + `b-2` gives `R03-B-2`); a full coordinate wins over the prefix; an invalid prefix is flagged.
  - Empty or non-coordinate text is refused: focus stays, `aria-invalid` is set, the error clears on typing and nothing is saved.
  - A save error stays on its row.
  - Current non-coordinate locations ("Now: “shed corner”") are shown.
  - List load error, then retry, then the empty state.
  - Unlocking from the page note saves without a second prompt.
  - The Map note links to `/locate`.
- E2e (real backend):
  - Enter saves, the row disappears and focus moves to the next box.
  - Rack prefix `r7` + `c-2` saves `R07-C-2`.
  - "behind the door" is refused with focus kept.
  - The items' locations are checked through the API afterwards.
  - Locked: Enter → PIN (submitted with Enter) → saved, with focus on the next box.
  - Empty state.
  - The Search badge and the Map note both lead to `/locate`.

**Deep links**
- Vitest: `/scan`, `/locate`, `/items/7`, `/items/7/edit` and `/import` render while locked, without a dialog.
- Vitest: brand, model and barcode appear on the detail page.
- E2e: `/scan`, `/locate`, `/items/new`, `/import` and `/racks/r1` load directly and after a reload, with no console errors. They also pass against the production server through its SPA fallback.

**Production mode (E2E_PROD=1)**
- The CSP includes `'wasm-unsafe-eval'`, and `X-Frame-Options: DENY` is set.
- `index.html` is served `no-cache` and has no inline script. Hashed assets are `immutable`. `/assets/does-not-exist.js` returns a real 404. `/locate` falls back to `index.html`. `/api/*` responses are `no-store`.
- `/ocr/worker.min.js`, the SIMD core and `eng.traineddata.gz` are all served.
- **OCR scan under the production CSP works** (a TNT-004 label found TNT-004), with no CSP violation, no console error and no external request.
- The entire existing suite also passes in production mode, except P15-1.

### Files
- New: `frontend/tests/phase15-tester.test.tsx` and `frontend/e2e/phase15-tester.spec.ts`.
- No app source, backend or Playwright config was changed, and nothing was committed.

---

## Phase 1.5 fix verification (commit 46f3f3e)

Date: 2026-11-27. E2E ran in dev mode (backend `:3401`, Vite `:5473`, fresh temp DB, PIN 246810, `--trace off`). Servers were stopped afterwards.

| Suite | Tests | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Vitest, all files | 382 | 382 | 0 | 0 |
| Playwright, dev mode, all specs | 132 | 127 | 0 | 5 |

The 5 skips are the 2 production-only tests in each project plus the 360-px-only test on desktop.

**Earlier failures, all now passing:**
- P15-1, PIN box focus after a wrong PIN: the vitest test and the e2e test on desktop and 360 px pass.
- P15-2, writes-only storage failure: passes.
- P15-3, leaving the Scan page mid-scan: passes.

**The developer's adjustments to my tests are legitimate:**
- In `phase15-tester.test.tsx`, PIN `2468` became `246810`, and the too-short message became "The PIN is 6 to 8 digits." This follows the lead's 6–8 digit rule.
- In `phase15-tester.spec.ts`, only the default PIN changed.
- Nothing was removed or loosened:
  - The 429 test still asserts "wait 5 minutes".
  - The no-loop and 401 tests are unchanged.
  - My spec still sends its own explicit token header; it matches `e2e/leader.ts`.
- `use.extraHTTPHeaders` was removed from `playwright.config.ts`. That resolves the harness finding from the Phase 1.5 run.

**New regression tests (all pass):**
- `frontend/tests/phase15-fixcheck-tester.test.tsx` (13 tests):
  - OCR language file fails to load: clear "text reader couldn't load … eng.traineddata.gz" error, no match request is sent, and the next photo retries and works.
  - PIN 429 wording for Retry-After of 300, 120 and 45 seconds, 1 second ("wait a moment") and none. Also `details.retryAfterSeconds`. The PIN box keeps focus.
  - Scan 429 wording for 30 and 90 seconds and none. The recognised text is kept.
  - 503 damaged-settings dialog, both on login (focus on OK; the action does not run) and on a `/locate` save (the row is kept).
  - Short-PIN notice: shown after unlocking with `2468` (an old 4-digit PIN is still sent), can be dismissed, and blocks nothing. Not shown for a long-enough PIN.
- `frontend/e2e/phase15-fixcheck-tester.spec.ts` (4 tests × 2 projects):
  - The first `eng.traineddata.gz` download is aborted with real tesseract. The error is shown, and the next photo finds TNT-004.
  - A real `Retry-After: 30` header on scan gives "wait 30 seconds".
  - `Retry-After: 120` on PIN login gives "wait 2 minutes".
  - Login 503 opens the repair dialog.

**Remaining app bugs: none found.**
