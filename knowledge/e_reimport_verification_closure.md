# Module E scoped verification closure

This pass adds regression proof only. No production code, schema, data, mapping,
price, numbering or UI behavior changes. Module A.2 remains open for installed
supplier acceptance. Module E is not marked complete as a whole.

## Closed code-verification scope

E Task 2 checks for manual-confirmation persistence, vendor-link/history
preservation and correction persistence are supported by the existing four
reimport cases, two new orchestration cases and focused field-contract checks.

The new accepted-quote case executes importPriceRow and checks that a fresh
accepted quote removes stale amount and unit-cost overrides, retains product
corrections/rejections, keeps mapping/catalog identity and adds one price
observation without replacing the old observation. Existing mapping bypasses
matchOrCreate and confirmMappings; its review status is not auto-promoted.

The held-source case supplies an explicitly conflicting pack in both raw source
and interpreted row. It checks that the imported source remains reviewable,
while saved overrides, pack, catalog/mapping and price history remain unchanged.
No applyQuote may run. A source conflict is caught by preparePriceImport and
retained for review, not an unhandled import failure.

Pure field tests distinguish an unconfirmed remembered-field conflict (throws)
from exact mapping behavior (manual or rule-based): retain the saved field and
flag source review. A new explicit edit remains authoritative. Serialization
never mutates prior evidence, removes old quote overrides, and permits a new
explicit manual price resolution after removal of the old price record.

These tests use controlled persistence doubles. Separate executed PGlite suites
cover actual explicit-association and product-group SQL. Neither is a signed-in
or hosted Module E acceptance claim.

## Review disposition

| Review item | Evidence/disposition |
| --- | --- |
| M1: first import with needsBasis and no prior item | Existing import-to-order-guide-test case beginning doc-8, ex:null, asserts successful retained listing and needsBasis; avoid duplicate test |
| M2: rememberImportRow conflict | New pure conflicting-pack cases and real importPriceRow held-source orchestration; confirmed mapping restores and flags review, while unconfirmed correction throws and importer catches it |
| M3: stale price and unit-cost override | New pure plus accepted/held orchestration checks; removal applies to a fresh accepted quotation, not a held source that must preserve the old quotation |
| M4: split cleanup fails | OPEN: non-atomic split cleanup failure and orphan recovery need a concrete fault test/design; no claim of solved recovery |
| M5: existing mapping not engine-promoted | New accepted-quote case forbids matchOrCreate/confirmMappings and verifies the existing review mapping is unchanged; automatic promotion policy is not expanded |
| M6: description invalidates approval | Already asserted by test_product_associations using productGroupApproved before/after a changed description |
| M7: concurrent first imports | OPEN: independent sessions, actual constraints, canonical creation and mapping races require a separate database concurrency audit; a read-before-insert lookup is not atomic |

Additional corrections to the preliminary review:
- rememberImportRow exact/100 path does not require match_method manual.
- importResolutions spreads first, deletes old price/override, then may add a new
  explicit price resolution. It does not unconditionally delete every price edit.
- kerdos_match_vendor_item removes automatic_group and preserves other prior
  resolution keys; it does not create or update row_approval as an engine action.
- Keeping a history row through unlink proves preservation by that action, not
  universal append-only enforcement of every possible write.
- Category service assignItem writes a displayed number; the database allocator
  decides the authoritative number. Stable UUID and reserved prior numbers are
  distinct from a never-changing displayed number.
- Current product-group persistence is kerdos_associate_product_group, with
  request-id replay, listing revision/association checks, audit and guarded
  restore. It is not fully described by the older alternatives RPC alone.

## Remaining boundaries

E1.4 broader action/write ownership, confirm freshness with unchanged target,
split orphan failure recovery, independent-session deduplication and hosted/live
acceptance remain open. E3 local SQL evidence does not close hosted database
acceptance. The historical Task 2 number-permanence checkbox is left open: it
needs wording that distinguishes stable identity, category renumbering and
number reservation before it can honestly be closed.
