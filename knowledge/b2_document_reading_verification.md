# B2 — Document Reading

Baseline: main `c45ae4e986214859e2406878517edb20723651e3` (PR #28).
Scope: Division I → Module B → Task 2. Local code evidence only.

## Changes

The manual reader now returns a structured reading alongside its compatible text:
PDF page numbers, viewport dimensions and original text transforms/width/height;
local OCR blocks, confidence and coordinate scale; and every workbook worksheet's
name, range, cell address, row/column, typed value, cached formatted value and
formula. Empty worksheets remain represented. CSV text remains byte-for-text
unchanged, including CRLF and quoted newlines, while parsed cells are also retained.

Both file-picker/drop and retained-file loading keep this reading on their import
groups for B3. Existing parsing still uses the same text adapter. No schema,
Supabase function, email, scheduler, catalog or price-write change is included.

PDF recognition is chosen per page. Previously, sufficient native text anywhere
caused the reader to return before recognizing scanned pages. Scanned pages now
reach local OCR even after a readable native page. Native text positions and OCR
boxes remain available instead of being discarded. OCR blocks use scale-2 render
coordinates, explicitly labeled for B3. PDF pages, loading tasks and OCR workers
are released on completion/failure.

## Executed evidence

`npm run test:b2` runs eight checks against the production reading engine:

1. Actual PDF.js reads both native pages with their original positioned items,
   code/pack/unit/price text and dimensions.
2. Actual invoice PDF reading retains invoice number and stated quantity/charges.
3. Actual mixed native/scanned PDF dispatches the scanned page to an injected OCR
   recognizer and retains its supplied boxes/confidence/scale. This does not prove
   browser OCR accuracy; the existing A1 OCR/PDF suites cover their separate engine.
4. Actual side-by-side PDF retains both lanes and their original positioned items.
5. Actual SheetJS reads CSV quoted commas/newlines and leading-zero codes while
   the text adapter returns the exact original source text.
6. A real serialized XLSX is read across three worksheets, including an empty tab,
   offset cells, numeric prices, leading-zero codes and a cached formula value.
7. Page/document cleanup occurs on successful and failed OCR reads; a failed page
   rejects the read rather than returning an apparently successful incomplete file.
8. Corrupt PDF rejection does not prevent a subsequent valid PDF read.

The suite is included in `npm test`. B1's nine rendered checks remain unchanged
and pass. Full tests including lint and production build pass. No hosted/browser
B2 verification, database mutation or deployment is claimed here.

## Demonstrated B3 gaps — not B2 acceptance passes

The current flattened PDF text feeds a pack weight into the price field on the
retained `text-prices.pdf` and `side-by-side.pdf` fixtures (20 instead of 40/50).
Concatenating worksheets with differing column offsets can also cause the parser
to omit the first sheet's row. The new reader retains the data needed to fix both,
but does not claim that the existing structuring/parser now handles them.

B3 must consume positioned PDF/OCR records and individual native worksheet cells,
then prove exact product/pack/unit/price pairings and all-sheet row preservation.
Until then, B2 is locally verified reading work; broader live acceptance and
B3–B5 remain open. Native text plus scanned regions on the same PDF page is not
established by the mixed-page check. No client correction or new Save step is added.
