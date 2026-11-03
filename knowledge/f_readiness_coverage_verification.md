# Module F scoped readiness verification

No production behavior, purchasing policy, layout, database or customer data is
changed. This pass maps the external review to existing tests and adds only
specific missing independence and actual-App boundary checks.

## Coverage disposition

| Proposed case | Existing/new evidence |
| --- | --- |
| M01: complete offer with incomplete peer | New purchasing-independence tests plus real App render/select/add/basket case; incomplete peer is separately blocked |
| M02: no borrowing field values | New peer mutation tests compare the assessed offer's product/pack/unit/price/unit-cost evidence, preserve original inputs and retain its own values |
| M03: tentative association | Existing product-group SQL/readiness tests and new conflicting-peer review mapping case; do not assert every low-confidence mapping is unconditionally blocked when independent evidence can verify it |
| M04: pack disagreement penalty | New explicit comparison_mode exact case; client exact-pack policy may hold disagreement. This is not the rule for broad approved groups |
| M05: approved groups with different packs/dimensions | Existing product-association readiness and rendered Order Guide cases; new complete-to-incomplete peer transition and basket evidence |
| M06: identifier corroboration | New matching-GTIN/same-pack case proves pack accuracy improves while pack and price values stay on the assessed listing |
| M07: standalone qualification | Existing import-to-order-guide first-import/standalone cases and purchasing-readiness tests; no duplicate test |
| M08: listing-local manual override | New one-listing unit-cost override and incomplete peer case; the peer cannot inherit it. Pack-change override invalidation remains a separate open design question |
| M09: variable weight/unconvertible basis | Existing purchasing-readiness, power-ranked, catalog-fields and quote-controls tests. A valid measured-rate quote is not automatically an estimated unit cost; distinguish exact rate from unconfirmed case charge |
| M10: expired cheapest does not anchor order | Existing 24 eligibility/22 power-ranked checks; new actual App expiry refresh proves disabled expired selection, current alternative and actual current basket charge |

## Actual assessment-to-ordering boundary

The existing App calls quoteStatus and orderGuideAssessment for each saved
listing, builds match/expired/unavailable/invoice/brand/unverified flags, applies
explicit comparison restrictions and calculates per-unit values. The ordering
core consumes those option fields; it does not independently read source rows
or acquire a freshness clock. Group identities do not supply missing fields.

The rendered regression executes the actual App and backend snapshot adapter
fixture rather than reconstructing option flags in the test. It selects a valid
approved offer alongside an incomplete offer, checks plus-button eligibility
and the exact vendor/charge in the basket, then separately selects the held offer
and confirms it remains visible but cannot be added.

At a controlled later date, it invokes the actual one-minute App interval
callback. An earlier-valid quotation becomes expired and its add control is
disabled. The still-current alternative remains enabled and produces its own
$40 basket charge instead of the expired $20 quote. This is a controlled clock
refresh test, not proof of instantaneous expiry or real operating-system timer
scheduling. There is no signed-in customer/supplier acceptance implied.

## Closure and remaining work

F2.1 code verification covers independently assessed offers, different
packs/dimensions within approved groups, no borrowed evidence and no purchasing
approval from identity alone. Coverage mapping and the actual App boundary are
now verified by automated tests. F1.6 evidence consolidation/refactoring is not
implemented or claimed complete: some quote/comparison checks still live in App.

Manual override staleness after a source/pack change, timestamp-at-save behavior,
full live verification and any broader consolidation remain open. An existing
source-compatible manual override must not be removed merely because a test
writer prefers a different policy. Preserve explicit restrictions and accepted
Order Guide/basket behavior. Module F is not marked complete as a whole, and
A.2 live supplier acceptance remains open.
