# KERDOS deploy v7 — 2026-09-27 (supersedes v6; includes everything in v6)

## Upload (one commit)
At the repo root: Add file → Upload files. Drag in:
- the `src` folder (as a folder)
- `package.json`

The upload preview must show these paths before you commit:
  src/pages/ImportModal.jsx
  src/pages/DocumentPages.jsx
  src/pages/document-pages-test.mjs
  src/core/import-status.js
  src/core/import-status-test.mjs
  src/core/sheet-layout.js
  src/core/sheet-layout-test.mjs
  src/ingestion.js
  src/ingestion-test.mjs
  package.json
If any path appears without `src/` in front of it, cancel and drag the folder, not the files.

No database migration.

## What this changes
1. Header-first reading. Every column's meaning is settled from the header row before
   any row is read. A heading KERDOS doesn't recognise is asked about ONCE, in the
   import screen ("Tell KERDOS what these columns are — once"), with a dropdown per
   column. The answer is remembered for that vendor's header layout in the
   organization's settings; the same sheet next week asks nothing.
2. Every cell is checked against its column's meaning (price = money, pack = pack,
   unit = unit, barcode = valid barcode, item number = item number). A failing cell
   is flagged on its row with the reason; the row still saves.
3. From v6: "Import incomplete" only when a row actually failed; "N rows checkpointed";
   Excel-mangled date packs read back; "CASE"/"BOX" alone = one of that packaging;
   a bare count = a count.

## Test it
Import a sheet whose headings KERDOS won't know (Minore's "Sell" column is one). The
column question appears once. Answer it, and the import runs through. Import the same
vendor's sheet again: no question.

## Cleanup (after the upload is green) — delete these at the repo ROOT only
Loose copies that the app never reads (the real ones are inside src/):
  App.jsx, CatalogRows.jsx, ImportModal.jsx, catalog-fields.js, deployment-test.mjs,
  identifier-test.mjs, ingestion-test.mjs, ingestion.js
Misplaced folders from wrong-place uploads (their contents are now in src/):
  core/, pages/, services/, ui/
Old packages and build output (the deploy builds its own dist/):
  dist/, KERDOS_CLEAN_MODULAR_DEPLOY (4).zip, KERDOS_DEPLOYMENT_TEST_FIX.zip,
  KERDOS_DEPLOY_v4_2026-09-27 (2).zip, KERDOS_GITHUB_PAGES_BLANK_SCREEN_FIX.zip,
  files (15).zip, kerdos-autosave-fix.zip, kerdos-import-flow-fix (4).zip
Stale notes:
  CLEANUP_VERIFICATION.md, KERDOS_IMPORT_REPAIR_READ_FIRST.txt, REVIEW_STATUS.md,
  WORKFLOW_2026_09_25.md, DEPLOY_READ_FIRST.md, READ_FIRST.md
Keep everything else.
