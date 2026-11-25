# e-Troop Store Room: Team Summary (Phase 1)

**Status:** Phase 1 is finished, reviewed and tested. Both reviewers approved after their final checks, and the frontend developer fixed the last batch of small findings. I then ran every test suite myself.

**Final results** (run by the lead after the last fix):
| Check | Result |
|---|---|
| Backend tests (Vitest + Supertest) | **484 / 484 pass** |
| Frontend component tests (Vitest) | **252 / 252 pass** |
| Frontend browser tests (Playwright, desktop + 360 px phone) | **69 pass, 1 skipped** (a phone-only test that is skipped on desktop by design) |
| TypeScript type check and production build | Pass |

**How the team worked:**
1. **Build:** the two developers built the app in parallel against one shared contract (`docs/SPEC.md`).
2. **Check:** reviewers and testers checked the work.
3. **Fix:** developers fixed what they found.
4. **Re-check:** reviewers and testers checked again, until nothing important was left.

Reviewers and testers never edit app code. They only report.

---

## 1. Backend developer
**Job:** build the server, database and Excel import (`backend/`).

**Round 1, the build:**
- **API:** search, add/edit/delete items, categories, and the rack list and rack contents (all endpoints are in `docs/SPEC.md`).
- **Database:** SQLite, with a simple upgrade system ready for Phase 2 tables (members, check-in/out).
- **Location reader:** understands `R03-B-2`, `r3-b-2`, `R3 B 2`, `3/B/2`, `Rak 3 B 2` and `R03–B–2`, and stores them all as `R03-B-2`. Odd text is kept as typed, never rejected.
- **Excel/CSV import:**
  - Accepts English and Malay column names (Kod, Nama, Koordinat, Lokasi, Kuantiti, Keadaan, Catatan…).
  - Accepts separate Rack/Shelf/Bin columns.
  - Skips title rows above the header.
  - Always shows a dry-run preview first and writes nothing until you confirm.
  - Saves everything in one go, or nothing.
- **Sample data:** 28 sample scout items, plus a downloadable import template.

**Round 2, fixes from the review and tests:**
- "Bin 5", "Shelf 3" or "Tingkat 2" are no longer mistaken for racks.
- Blank Excel cells never wipe existing data.
- Search works with non-English letters.
- Location search is exact (`R03-B-1` no longer finds `R03-B-10`).
- Protection against harmful or oversized Excel files.
- Broken uploads give a clear error instead of crashing.

**Round 3, final hardening:**
- Closed two ways to bypass the file-size guard.
- Only one import runs at a time; others wait or are told "try again in a moment".
- An unknown condition word in Excel keeps the item's current condition.

## 2. Frontend developer
**Job:** build the screens (`frontend/`). React + TypeScript, phone-first.

**Round 1, the build:**
| Screen | What it does |
|---|---|
| **Search** (home) | Type and results appear instantly, each with a big **📍 R03-B-2** badge. A category filter is included. |
| **Item detail** | A drawing of the rack with the exact shelf and bin highlighted, the store-room map with the rack highlighted, all details, and Edit/Delete. |
| **Map / Rack** | All racks with item counts; tap a rack to see every shelf and its items. |
| **Add / Edit** | A form with friendly checks and a live preview of the cleaned-up location code. |
| **Import** | Upload Excel/CSV, see a preview (new, updated, unchanged, problems, warnings), then confirm. |

**Round 2, fixes:**
- Back after editing now returns to your search.
- The rack drawing stays readable on phones even with many bins.
- Clear error messages under each field.
- Stronger contrast for outdoor use.
- Proper "not found" pages.
- Keyboard and screen-reader support.
- The browser tests now use their own temporary database, so they can never touch real data.

**Round 3, final polish:**
- Back works correctly from bookmarked edit pages.
- Bin 0 is accepted and drawn.
- The Search tab always clears the search.
- Wide racks show "more bins ▶" hints.
- The Location column appears next to Code in the import preview.
- Clearer wording if the connection drops during an import.

## 3. Backend code reviewer
**Job:** read the backend code and find problems without changing it. Report: `docs/REVIEW-backend.md`.
- **Round 1:** 0 Critical, 2 Major, 6 Minor, 7 Nit. The Major issues were:
  - "Bin 5" was being read as rack 05.
  - Re-importing a file with blank cells erased existing condition, location or notes.
- **Round 2 verification:** 13 findings were confirmed fixed and 2 were deferred by design. It found 1 new Minor (a way around the file-size guard) and 2 Nits.
- **Final verdict:** **Approve.** The new issues were fixed in round 3 and confirmed by the test suite.

## 4. Frontend code reviewer
**Job:** read the frontend code and use the app at phone and desktop sizes. Report: `docs/REVIEW-frontend.md`.
- **Round 1:** 0 Critical, 2 Major, 8 Minor, 11 Nit. The Major issues were:
  - Back after saving an edit went to the edit form.
  - The highlighted bin became unreadable on phones for racks with many bins.
- **Round 2 verification:** all Major and Minor issues were confirmed fixed, with no regressions. It found 1 new Minor (wide racks hid occupied bins) and 2 Nits.
- **Final verdict:** **Approve.** The new issues were fixed in round 3 and covered by new tests.

## 5. Backend tester
**Job:** write and run automated tests for the API. Report: `docs/TEST-backend.md`.
- **Round 1:** wrote 359 tests; 10 failed because of 2 real bugs (shelf/bin words read as racks, and non-English search).
- **Round 2:** added 73 more tests covering harmful files, 300 randomly corrupted workbooks, broken uploads, simultaneous imports, Unicode text and mixed searches like `tent r1`. It found 5 more bugs, all fixed.
- **Final:** 484 tests, all pass. It also confirmed the developer only adjusted tests where the lead had changed the expected behaviour.

## 6. Frontend tester
**Job:** write and run screen tests plus full click-through browser tests at desktop and phone size. Report: `docs/TEST-frontend.md`.
- **Round 1:** wrote 172 component tests and 34 browser tests; 4 failed because of 2 real bugs (Back after edit, and missing error messages on two fields).
- **Round 2:** added 49 component tests and 14 browser tests that try to break history, focus, imports and wide racks. It found 3 more bugs, all fixed in round 3.
- **Covered end to end:** search → item → map, add, edit, delete, duplicate codes, importing an Excel file with Malay headers, the template download, and a phone layout with no sideways scrolling.
- **Final:** 252 component tests and 69 browser tests, all pass.

---

## Decisions the lead made (please check you agree)
| Question | Decision |
|---|---|
| Tech stack | React web app + Node.js + SQLite. Works in a phone browser, no paid services. |
| Blank cell in Excel for an existing item | Keep the current value. Clear a field on the Edit screen instead. |
| Location text the app can't understand | Keep it as typed. The item still imports, but won't appear on the map. |
| Same item code twice in one Excel file | Later rows win, with a warning. |
| Bin number 0 | Allowed and drawn on the rack. |
| Very long location (>100 characters) | The import gives a warning and leaves the location unchanged. The form rejects it with a message. |

## Known limits / later work
- **Search wording:** "tent rack 1" finds nothing; type "tent r1" instead. This is easy to improve.
- **Numeric shelves:** shelves must be letters (A, B, C…). If your Excel uses numbered shelves, we'll adjust when it arrives.
- **Deleting is permanent:** Phase 2 should switch to "write-off" so history is kept.
- **Not built yet (Phase 2+):** check-in/out log, members, login/roles, maintenance log, QR labels, stocktake.

## Next step
**Upload your Excel file.** We'll try an import as a dry run (nothing saved), check that your column names and coordinate format are recognised, and adjust if needed.

## Where things are
| What | Path |
|---|---|
| Shared contract | `docs/SPEC.md` |
| Review reports | `docs/REVIEW-backend.md`, `docs/REVIEW-frontend.md` |
| Test reports | `docs/TEST-backend.md`, `docs/TEST-frontend.md` |
| Screenshots | `docs/screenshots/` |
| Subagent role files | `.claude/agents/*.md` |
| How to run | `backend/README.md`, `frontend/README.md` |
