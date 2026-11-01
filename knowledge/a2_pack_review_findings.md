# Live companion pack review: investigation, 2026-11-01

The diagnosis below is retained. Nested-pack support has now been implemented
and checked locally; the average-weight follow-up remains open. This is not
acceptance of previously held database quotes.

The retained live import has 87 saved rows, 76 usable quotes, nine pack-review
holds and two separate products without a quoted price. Replaying the original
CSV through `createDocumentReader`, `parseStructuredDocument` and
`preparePriceImport` reproduces exactly nine holds, without database writes.

## Confirmed causes

- Two case-priced rows use three numeric packaging levels. `parsePackSize`
  accepts at most two; its complete-specification guard rejects the remaining
  slash component. Synthetic examples of this grammar are `3/4/200 ML` and
  `5/6/2 OZ`.
- Six pound-priced rows have a numeric pack ending in `LBA`. The parser accepts
  the spelling as an unknown unit, not pounds. `casePriceFromQuote` cannot
  reconcile a pounds quote with that unknown dimension.
- One pound-priced row also contains a weight range. It fails the pack grammar
  before the same unknown-unit conversion issue can be evaluated.

US Foods' own *Product Content Specification Guidelines*, version 5.8,
October 24, 2025, page 75, explicitly defines `lba.` as pounds average:
https://www.usfoods.com/content/dam/usf/pdf/general/USF_ProductContentSpecification_Guidelines.pdf

That establishes the abbreviation, not the actual delivered weight or a fixed
case charge. A range must not be turned into a single exact weight.

## Required implementation boundaries

1. Preserve every packaging level, raw source text and average/range evidence.
   Do not merely flatten a nested pack into an equal total: procurement pack
   comparison and the catalog pack editor currently assume two levels.
2. Support average-weight vocabulary through the shared vocabulary/adapter
   interface. Keep the source billing unit separate from nominal package weight.
3. A valid price per pound should be distinguishable from an exact case price.
   Existing `casePriceFromQuote` multiplies recognized average-weight packs by
   nominal weight; copying that behavior for a newly recognized abbreviation
   would make a nominal case estimate indistinguishable from an exact result.
   Resolve this representation and its ordering/display consumers before
   automatically accepting the seven weight-based holds.
4. Persisted review flags do not disappear merely because parsing changes.
   Resolution must use the normal scoped review/import path, preserve original
   evidence and history, and avoid creating duplicate listings.

## Acceptance for the follow-up

- Synthetic nested packs retain topology through parsing, editing and reload;
  equal totals with different case configurations do not become interchangeable.
- Average and ranged packs retain their uncertainty. Pound quotes remain pound
  quotes; estimates and delivered-weight charges are clearly distinguished.
- All 87 source rows remain accounted for, the two unquoted items remain
  unquoted, and saved ownership/evidence remains unchanged.
- Preserve the controlled 347-row source proof with 335 completed and 12
  unresolved rows; run the existing procurement and import checks.
- Verify saved review resolutions separately from a successful parser replay.

No catalog records, source values or quote availability were changed during
this investigation. Recurring Vendor Connect automation is a separate open
deliverable; the successful one-time transfer does not enable it.

## Nested-pack implementation

The shared parser now reads three or more explicitly separated packaging
levels, retains their hierarchy, computes measured totals, and keeps raw source
text. Pack comparison distinguishes equal totals with different inner packages.
The catalog editor exposes each intermediate count; complete and incomplete
edits round-trip without flattening levels. Numeric weight ranges are excluded
from the new grammar, including ranges that existing dash cleanup might
otherwise turn into slash-separated numbers.

Focused tests cover conversion, topology, invalid counts, incomplete edits,
range rejection and rendered catalog fields. A read-only replay retains all 87
live rows with seven average-weight review holds and two unquoted products.
The 347 controlled source proofs still deep-match the retained snapshot;
335 completed keys and 12 unresolved records remain unchanged. Existing saved
review flags require the normal scoped review path; this change does not
rewrite database records or enable recurring retrieval.

## Average/range-weight calculation boundary

The shared parser recognizes the documented `LBA` spelling as pounds average,
retains the original source text and average marker, and represents an explicit
variable mass range with separate minimum/maximum values. A range has no single
unit quantity, total or base total; its midpoint is never invented. The pack
editor retains both endpoints through complete and incomplete edits.

`casePriceFromQuote` now rejects a measured-rate-to-case conversion when case
weight is variable. `measuredQuoteRate` converts a stated measured rate directly
between compatible measurements, without multiplying and dividing by a nominal
case weight. `quotePriceOnBasis` uses that direct route for like-basis invoice
comparisons; a variable measured quote cannot be compared to a case-billed
invoice as an exact charge. Registered custom units retain same-unit arithmetic.

`estimateCaseCost` is a separate, explicitly estimated result. A stated average
gives a nominal amount; a range gives two bounds and a null single amount.
Item Catalog displays that estimate with the delivered-weight qualification.
A fixed case quote divided by average weight produces an estimated unit cost
at 70% confidence, which cannot enter Order Guide without an explicit supported
resolution. A direct stated per-pound rate is not downgraded merely because
case weight is variable.

The seven real-source weight-based rows now have readable pack evidence and
exact retained per-pound rates, but remain review holds for case purchasing.
Order Guide does not substitute the raw per-pound price for a missing case
charge. A held variable-weight row cannot establish a basket amount. No saved
review was cleared, no delivered weight guessed, and no automatic recurring
retrieval enabled. Completing variable-weight purchasing still requires an
explicit workflow for estimated orders and their final delivered-weight charge,
or a confirmed vendor quote on a supported purchasing basis.
