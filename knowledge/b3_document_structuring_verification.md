# B3 — Document Structuring

Scope: Division I → Module B → Task 3, built on B2/PR #29.
This follow-up is included in the same review so the reader and its consumer can
be assessed together. It changes the separate manual-upload path; the inbox's
existing partial-review parser/row-ordinal contract is retained.

## Result

Positioned PDF/OCR tables become independent tabular parts, including two lanes
side by side. Worksheet cells are read independently across different offsets,
column orders and repeated table headers. Every part stays within one original
file group/document, retaining the original fingerprint and original upload.
Each table keeps its own header fingerprint and remembered answers.

Native PDF transforms and OCR boxes remain attached to parsed rows with filename,
page/table/source lines; native cells retain worksheet, address, row/column and
original typed values. Rendered persistence checks confirm this metadata reaches
`applyQuote.importRow.row.sourceProvenance`. Those writes are simulated locally,
not actual database proof. Invoice rows retain their source line/original file;
this change adds no invoice geometry column.

Nearby description-only continuations join their description column and retain
both source line references. Totals/tax/page furniture remain outside product rows.
Content outside a recognized table remains available to freeform parsing.

Three consistently aligned unlabelled rows establish columns, not confirmed
field meanings. A unique decimal-money column may be proposed as price; those
rows are explicitly flagged for review. A pack measurement never supplies a
quoted-per basis. Ambiguous columns, ragged layouts, rotated text and absent OCR
boxes keep the existing freeform fallback. Recognition below 90% is flagged;
readable values and their source evidence remain retained, not silently qualified.

## Executed local evidence

`npm run test:b3`: 14 checks against the production reader/structurer/parser:

- Real PDF.js reads the retained two-page price PDF: code 12345/12346, pack 20 LB,
  explicit CASE, exact prices 40/50. Previously flattened parsing returned 20/20.
- The retained side-by-side PDF yields Chicken 40 and Turkey 50, with no invented unit.
- The retained invoice yields quantity 2, explicit CASE, unit price 40 and total 80.
- A serialized/re-read XLSX retains both 41.25/51.75 rows across different offsets
  and column orders; blank worksheets introduce no rows.
- Quoted comma/newline CSV descriptions remain one product with original cell values.
- Wrapped descriptions, separate tables and total/tax/page furniture are controlled.
- Headerless aligned columns preserve uncertainty; integer item codes cannot become prices.
- Ragged/rotated/missing-geometry inputs keep the freeform fallback.
- Controlled OCR boxes prove coordinate conversion, original-box retention and
  low-confidence flags; this is not real browser OCR accuracy evidence.
- Independent remembered headers, document-wide explicit quoted units and stable
  replay/non-mutation are checked.

`npm run test:b1`: 12 rendered checks (nine prior B1 plus three B3 checks):

1. The production upload modal saves PDF price 40 with 20-LB pack and source geometry.
2. Two offset worksheets save 41.25/51.75 under one source document/original;
   reopening/replaying causes no second quote/document/upload in simulated persistence.
3. Two distinct worksheet layouts receive and apply their own header answers.

The full suite including lint, production build and `git diff --check` pass.
No database/schema change, deployed worker change, email send, scheduler change
or hosted/browser B3 acceptance is claimed.

## Acceptance limits

These retained PDF fixtures and controlled geometry/workbooks are local regression
evidence. B2/B3 remain open for deployed reading/structuring observations and varied
actual vendor documents before replacing the deployed manual path. Pages mixing
native text with scanned regions on the same page, vertical/rotated tables and
unlabelled changing layouts are not established as supported by these checks.
The fallback retains their source without claiming reliable automatic extraction.

B4 field identification and B5 extraction/validation remain their own tasks.
Module A automation and its existing recovery contract are unchanged.
