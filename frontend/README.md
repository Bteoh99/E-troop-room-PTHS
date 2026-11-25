# e-Troop Store Room — Frontend

React 18 + TypeScript (strict) + Vite + React Router 6, plain CSS. Mobile first (works from 360 px).
The API contract is in [`../docs/SPEC.md`](../docs/SPEC.md).

## Run it

```bash
# 1. backend (port 3001) — see backend/README or:
cd ../backend && npm install && npm run seed && npm start

# 2. frontend (port 5173, proxies /api -> http://localhost:3001)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. To point the proxy at another backend: `BACKEND_URL=http://host:port npm run dev`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server on :5173 with `/api` proxy |
| `npm run build` | `tsc --noEmit` then production build to `dist/` |
| `npm run preview` | serve the build on :4173 (same `/api` proxy) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest (jsdom + Testing Library), files in `tests/**/*.test.ts(x)` |
| `npm run e2e` | Playwright (`e2e/`), trace off. Always starts its **own** backend on :3901 with a brand-new temp DB (`npm run seed && npm start` in `../backend`) and Vite on :5901; it never reuses a running server, so it can't write into real data. Override with `E2E_BACKEND_PORT`, `E2E_WEB_PORT`, `E2E_DB_PATH` (scratch file only); `E2E_NO_SERVER=1` + `E2E_BASE_URL` to use servers you started yourself. Projects: `desktop` (1280×800) and `mobile-360`. |

Chromium is preinstalled (`PLAYWRIGHT_BROWSERS_PATH`); never run `playwright install`.
`@playwright/test` is pinned to the preinstalled browser build (1.63.0).

## Screens

| Route | Screen |
|---|---|
| `/` | Search — autofocused search box, debounced (200 ms) live results, category filter. Each card shows code, name, condition chip, quantity and the big **📍 location badge**. `?q=` is kept in the URL so Back returns to the same search. |
| `/items/:id` | Item detail — big location badge, mini rack diagram (shelf A on top, item's shelf/bin highlighted), store-room map with the rack highlighted, all fields, Edit and Delete (with a confirm dialog). |
| `/map` | Store-room map — one tile per rack with item count; tap → rack view. Shows how many items have no location. |
| `/racks/:rack` | Rack view — diagram plus items grouped by shelf, sorted by bin; items with a rack but no shelf (`unshelved`) are listed separately. Accepts `r3` / `3` / `R03`. |
| `/items/new`, `/items/:id/edit` | Add / edit form with validation messages, error summary, and a live preview of the normalised location code. |
| `/import` | Choose .xlsx/.csv → automatic dry-run preview (added / updated / already up to date / skipped counts, problems vs. warnings, ignored columns with reasons, first 20 rows with Add new / Update / No change) → **Confirm import** (`dryRun=false`). Template download link. Friendly messages for missing columns (400), too-large files (413), another import running (429, with retry) and a file that changed on disk after picking. |

Navigation is a bottom tab bar on phones and a top bar from 768 px.

## Code layout

```
src/
  api/        types.ts (contract types), client.ts (typed fetch client: `api.*`, `ApiError`)
  lib/        location.ts (parser, regex-for-regex copy of backend/src/lib/location.js — keep in sync),
              conditions.ts, flash.ts (one-off "saved" messages), history.ts (root-entry aware Back),
              routeFocus.ts (focus the new page's h1 on route change)
  hooks/      useAsync (abort + stale-response safe), useDebouncedValue, useDocumentTitle
  components/ Layout (nav + flash), LocationBadge, ConditionChip, RackDiagram, StoreMap,
              ItemCard, ConfirmDialog, PageHeading (every page's h1), StatusViews (Loading / ErrorState / EmptyState)
  pages/      one file per screen
  styles/     index.css (design tokens at the top)
  App.tsx     `AppRoutes` + `routerFuture`; wrap in BrowserRouter (main.tsx) or MemoryRouter (tests)
tests/        unit/component tests (setup.ts loads jest-dom)
e2e/          Playwright specs
```

### Testing notes

- Mock the API by mocking `src/api/client` (see `tests/App.smoke.test.tsx`): every call goes through the `api` object.
- Render routes with `<MemoryRouter initialEntries={[...]} future={routerFuture}><AppRoutes /></MemoryRouter>`.
- Useful hooks for queries: `data-testid="item-card" | "location-badge" | "location-badge-none" | "rack-diagram" | "store-map" | "location-preview" | "import-counts" | "import-problems" | "import-warnings" | "import-preview"`; highlighted rack tile / bin carry `data-highlighted="true"` and `data-rack` / `data-shelf` / `data-bin` attributes.
- Search debounce is exported as `SEARCH_DEBOUNCE_MS` from `src/pages/SearchPage.tsx`.

## Navigation and history

- Back on an item returns to where you came from (search keeps its `?q=`). Saving an edit returns to the item's existing history entry, so no edit form or deleted item is left behind in history.
- The Search tab and the logo clear the current search.
- After an in-app route change, focus moves to the new page's `<h1>`. The autofocused search box keeps focus and the page title is announced instead.

## Accessibility

Labels on every input, skip link, `aria-current` on the active tab, live regions for result counts and the location preview, focus moved to the error summary after a failed submit, modal dialog with focus trap + Escape, 44 px+ tap targets. Condition is always shown as text plus a symbol (✓ ! ✕ –), never colour alone; highlighted rack/bin also carry a 📍 / "here" text marker.
