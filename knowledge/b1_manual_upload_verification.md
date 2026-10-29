# Division I · Module B · Task 1 — Manual Upload

Baseline: main `5826ec1d90439e8eabe65490436c8f1262ef4840`.
Date: October 29, 2026 Eastern.

## Defect and correction

An uploaded invoice whose original-file upload failed still proceeded to catalog
matching/creation and invoice recording. A rendered production-modal check
reproduced this: the failed source retention produced one invoice instead of zero.
The invoice upload error now stops that file before catalog or invoice writes.
Other files in a batch remain independently eligible for processing. No schema,
automatic-email worker, receiving-address or scheduler change is included.

## Executed local evidence

`npm run test:b1` renders the production `PasteModal` and exercises its actual
drop, file-picker, vendor, preview, cancel and Save handlers. The real parser,
import service, price importer and catalog service execute. The filesystem reader
boundary and persistence are simulated; this does not prove native browser drop,
Supabase writes, storage permissions or database duplicate enforcement.

Nine checks pass:

1. Drop previews the filename and expected row count without writes; Cancel stays read-only.
2. Missing/invalid initial vendor disables Save until a valid vendor is selected.
3. Save retains the exact original bytes/name, organization/vendor and source linkage,
   one complete document, catalog mapping and exact 41.25 CASE quote. Reopening
   the modal and replaying through the picker creates no second upload/document/quote/mapping.
4. The picker uses the same preview/save path and retains its source filename.
5. A reader exception is visible and cannot write a document or quote.
6. Invoice mode records invoice charges and retains its original without applying a vendor quote.
7. Failed invoice-original retention prevents invoice and catalog creation (regression for the defect).
8. An invoice in price-sheet mode is blocked without quote writes.
9. Failed price-sheet-original retention also prevents document/catalog/quote writes.

The new suite is included in `npm test`. Full tests including lint, production
build, and `git diff --check` pass. The build retains its existing large-chunk
advisory; no build failure occurred.

## Remaining live acceptance

All B1 live checkboxes remain open: isolated kerdos-test frontend, real browser
drag/drop and picker, visible preview/cancel/vendor gate, actual original retention,
document/item/price counts and repeat protection, plus separate invoice filing.
No live import, email send, deployment or production data change occurred here.
Module A automatic intake remains zero-action; this modal is the separate manual path.
