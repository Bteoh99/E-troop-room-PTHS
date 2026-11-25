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
