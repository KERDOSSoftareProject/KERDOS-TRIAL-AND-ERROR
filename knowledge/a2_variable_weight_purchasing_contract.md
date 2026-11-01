# Variable-weight purchasing: core contract

I · Procurement → A · Automated Ingestion → Task 2 · Vendor Integration.
The same rules support Manual Ingestion, Item Catalog and Order Guide.

This increment implements provider-neutral, offline preparation and reconciliation
rules in `src/core/variable-weight-purchasing.js`. It contains no client/vendor
branches, network requests or AI calls. It does **not** enable variable-weight
ordering in the application, authenticate a user, clear saved reviews, or install
new database tables. Authentication and atomic persistence remain adapter work.

## Lifecycle

| Core operation | Required evidence | Result |
| --- | --- | --- |
| Prepare approval | Explicit confirmation, exact catalog link, current stated rate/unit/pack, source document and row, scoped client/vendor | Approval intent requiring authenticated persistence |
| Prepare order line | Saved approval with matching source terms; whole case quantity | Nominal estimate or two range endpoints; actual charge remains null |
| Prepare receipt | Saved order snapshot; explicitly linked same-client/vendor/product invoice; billed unit, billed quantity evidence and checked line arithmetic | Receipt intent retaining printed invoice facts, measured-rate variance and received case count when known |
| Summarize saved receipts | Unique saved receipt/invoice-line identities and known received case quantities | Pending/partial/complete; final charge only when all ordered cases are accounted for |

An intent is deliberately a different kind from a saved authorization or receipt.
It cannot be passed back as a saved record to advance the lifecycle. Checks of
IDs, snapshots and record kinds are data-integrity checks, **not** a replacement
for authenticated server authorization.

Average weights produce nominal estimates without invented guaranteed bounds.
Ranges retain both endpoints and never become a midpoint. Estimates remain
separate from actual charges after reconciliation. An invoice is not reused as
a price quotation. A rate change and a weight outside the stated range are
reported without rewriting the printed charge or discarding legitimate delivery
evidence. Billed pounds alone do not establish the number of cases received.

Scope, source/row, product, pack, rate, unit, validity and source-update changes
invalidate an old approval. Automatic expiry policy is respected. An unavailable
quote can enter this preparation only when its sole retained review field is the
variable pack; other source conflicts and unconfirmed associations stay blocked.
Source unit declaration evidence is required; arithmetic alone cannot establish
what the supplier billed.

## Local validation

Synthetic contract tests cover changed and revoked approvals, expiry, unsupported
purchasing units, missing source declarations, source and scope mismatches,
average/range estimates, incompatible measurements, invoice arithmetic, explicit
links, partial receipts, absent received case counts, duplicate invoice/receipt
identities, over-delivery, rate and range variances, compatible measurement
conversion, preserved source values, and mass-based purchasing outside the
restaurant industry. The tests run in the normal `npm test` chain.

This is not live database, browser, email, supplier or saved-review acceptance.
The existing 87-row import and its nine saved review holds are not modified.

## Integration acceptance still open

1. Add server-side approval/estimated-order/receipt records with client/vendor
   ownership checks, actor authorization, revocation and revision protection.
   Reload authoritative source/mapping records inside each transaction; do not
   trust arbitrary request JSON to establish an approval or its scope.
2. Preserve source proofs and link receipt records uniquely so retries cannot
   charge or count the same invoice line twice. Confirm partial-delivery and
   concurrent-receipt behavior against real database transactions and RLS.
3. Connect explicit Item Catalog purchasing approval, estimated basket/order
   displays, and invoice receipt matching. Label all estimates and ranges, and
   preserve confirmed exact-price ordering and its existing client interface.
4. Keep raw measured rates, estimates, invoice charges and final charges separate
   in persistence, reporting and exported orders. Do not make scalar-only order
   totals stand in for a range or an unreceived charge.
5. Verify the retained live source, unchanged controlled 335/12 baseline and
   normal scoped saved-review resolutions before enabling the seven held
   variable-weight offers. Recurring retrieval and universal executor delivery
   remain separate existing open tasks.
