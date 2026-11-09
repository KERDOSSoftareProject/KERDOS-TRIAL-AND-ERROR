# Module G review disposition and scoped verification

This pass changes tests and this evidence note only. It does not change runtime
ordering policy, layout, basket controls, database schemas or customer data.
The reviewed source base is PR119 / 42322e609050b430efa4fcd222a397aedc80d692.
Signed-in customer/supplier acceptance remains separate from automated checks.

## Review disposition

| Review claim/question | Source and verification |
| --- | --- |
| `solveOrder` has no unit tests | Retracted: `src/core/ordering-test.mjs` already covers exact/held/forced selection, same-vendor listing choice, split lines, pack comparison, case/each ranking and dollar/unit minimum fills. This pass adds cheaper evacuation (path B), locked fill candidates, locked short baskets, competing minimums and an infeasible cap-reaching fixture. |
| App normalization has no integration protection | Existing rendered App tests execute real source assessment, option construction, controls and baskets, including independent dimensions and timer expiry. New three-vendor case has two comparable packs ($20/10 LB vs $12/4 LB) and a $1 offer with missing pack. The $20 whole pack wins on unit cost; the $1 listing remains held and cannot silently substitute another supplier. Quantity survives held selection; restoring the ready choice restores its basket. |
| Proportional dollar-premium fallback | New ordering-core assertion exercises an explicit cost override on a common measurement and verifies a $10 equivalent-quantity premium. This is not evidence that unrelated raw dimensions are inherently comparable. |
| Concurrent price edits unprotected | Retracted: `prepareCatalogCorrection` passes `vendorItem.row_revision` as `expectedRevision`; the Supabase adapter passes `p_expected_revision`; migration_010 locks the row and rejects stale revisions. Existing `catalog-row-sql-test.mjs` rejects a stale `{price:8}` write and verifies that the original price remains 3.83. No save-layer change needed. |
| Concurrent estimated order submission untested | Retracted: `scripts/task2-receiving-races.mjs`, invoked by `test_task2_concurrency.mjs`, exercises identical submissions after commit/rollback, a different actor and cancellation before/after submission. Independent PostgreSQL sessions and an observed lock wait are required; one submission/header/line survives. This is distinct from embedded SQL serial-retry tests. |
| Historical estimate recalculation | Confirmed compatibility dependency, not a demonstrated corrupt current record. See version-1 contract below. |
| Receipt SQL suite not reviewed | Reviewed: `estimated-receipts-sql-test.mjs` covers explicit source links/cases, measurement conversion, expected/actual charge variance, partial/final results, duplicate-source prevention, overdelivery, rollback, corrections/reversals and access isolation. |
| One display group | Intentional current presentation: one flat, filterable, sorted product list. It does not collapse the underlying KERDOS item identities or vendor listings. New mixed ready/held vendor-filter test proves visibility does not grant purchasing eligibility. No multi-category layout redesign. |
| Export disclaimer | Records and text exports retain `deliveryStatus: not_sent`; generating a text export does not claim vendor receipt or send an order. Legal obligations were not assessed by this source review. |

## G1.5 function boundaries

1. App assesses each source listing and constructs its purchasing flags and
   comparison measurements. Approved product groups may retain independently
   valid offers with different packs/dimensions; grouping is not price proof.
2. `rankVendorOffers` consumes those flags and supplied measurements. With a
   common eligible measurement it ranks by unit cost; the actual pack charge
   remains separate. It is not an independent source-row validator. Broad,
   approved unlike-dimension choices remain governed by existing policy; this
   pass does not introduce a blanket same-pack/dimension requirement.
3. `solveOrder` allocates the selected quantities and eligible choices, honors
   explicit supplier/listing or price locks, and attempts minimum optimization.
   The iteration bound guarantees termination, not a globally optimal solution
   or proof that every vendor minimum is feasible. A returned `unorderable`
   flag concerns offer eligibility/selection, not minimum satisfaction.
4. App derives vendor dollars/units from actual assignments and displays minimum
   shortfalls separately. The rendered locked-$20/$100-minimum test verifies
   `$80.00 to go`; it does not fabricate a minimum guarantee or move a lock.
5. Price edits use the catalog correction service and revision-guarded persistence.
   Regular order recording and the reviewed estimated-order submission are
   separate persistence actions; rendering/ranking does not record or send.

The infeasible fixture has vendor B requiring $130 although all its available
lines total only $90, and C requiring $120 although its offers total only $75.
Diagnostic tracing of the current allocator reaches all 12 iterations. The
regression asserts termination, one assignment per requested item, eligible
source prices, exact line charges, unchanged inputs and a remaining shortfall;
it deliberately does not freeze the arbitrary last allocation as optimal.
No evidence here establishes a convergence bug on a feasible input.

## Version-1 historical estimate compatibility

`validateEstimatedOrder` checks a version-1 recorded snapshot, totals, source
terms and identity, then recalculates the line estimate using `estimateCaseCost`.
`recover` and `estimatedOrderExport` call that validator. They do not reread the
current source listing to replace historical terms. A source revision change
alone therefore need not invalidate an already accepted order.

A future calculator/pack-parser/unit-conversion/rounding change that produces a
different result for stored terms can reject **affected** v1 records. It does
not necessarily invalidate every historical order, and the record itself is
not deleted. This is a future release compatibility constraint, not a reason
to remove source-term/tamper validation now.

The release rule is: preserve accepted v1 computations, or add explicitly
versioned validation/migration support before changing historical meanings.
No new estimate version or migration is implemented in this test-only pass.
Literal golden historical fixtures now verify recovery/export for range packs,
nominal variable weights and ounce-to-pound rate conversion. A self-consistent
alteration of line and order totals still fails source-term validation, and an
unknown order version is rejected. These representative fixtures do not prove
every possible historical input against every hypothetical future algorithm.

## Evidence and limits

Local: ordering core, groups, rendered App, estimated-order service and embedded
estimated-order SQL checks pass; catalog-row/receipt SQL checks were also rerun
during review. Existing suites remain in the main npm test sequence. New tests
are appended to existing suites; no new runtime dependency or AI/provider call.
Separate-session concurrency is verified by the existing PostgreSQL CI workflow,
not simulated with parallel calls against one embedded session. PR/main CI run
identities are recorded in the governing task list after success.

Module G's existing completed features remain intact. G1.5's scoped boundary
verification is ready for code checkmarks after CI. Signed-in end-to-end live
acceptance, a global optimization proof and future estimate-version migrations
are not claimed complete. Module F's broader override-staleness work remains
open under F; it is not silently closed by this review.
