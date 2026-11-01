# Task 2 downstream reconciliation: linked invoice receipts

Invoice Review is available inside a reopened recorded estimated order in Item
Catalog. It lists same-client/vendor/product invoice lines, retains their source
text and billing evidence, and requires a separate explicit invoice/order link
and attestation of physically received whole cases. It never infers cases from
billed weight. Invoices without confirmed case counts remain unlinked; invoice
intake itself is unaffected. Generic or ambiguous billed quantities still need
source clarification before receipt matching.

## Authoritative receipt transaction

The optional provider-neutral estimatedReceipts capability offers paginated
candidate reading, fresh review, immutable save and full order receipt history.
The server reloads the actual recorded order-line snapshot and invoice header /
line. It checks organization, vendor, vendor product, stated product code and
invoice match confidence (90–100), canonical billed quantity/unit/source proof,
printed rate/amount evidence, nonnegative reconciled invoice arithmetic and
compatible mass units. An unambiguous printed price and extended-amount column
or recognized goods-invoice price tail must agree with stored invoice fields.
Unsupported/ambiguous printed money needs clarification; calculation alone
cannot manufacture source evidence.

Review compares billed charges with the retained ordered rate, converts mass
units, preserves rate variance and flags delivered weight outside a stated
estimated range without rewriting the actual invoice charge. Saving requires
both confirmations and repeats that exact review under locks. The order line
locks first to serialize all its partial receipts; invoice header and line locks
pin source and serialize competing links. Changed source or remaining cases
rejects a stale review. Cumulative received cases cannot exceed ordered cases.

Each invoice line can belong to one receipt across all orders. Same actor,
order-line, case count and exact review replay return the same receipt. A
changed/reassigned request is rejected. The unique key remains stable after
response loss and across remount. A receipt and its canonical immutable source
snapshot save together; late failures roll back the whole insert. Direct inserts
use the same validation trigger and explicit consent fields. RLS isolates client
rows; purchasing roles can save; anonymous execution and client update/delete
are denied. The service role has read-only receipt-table access for source
protection; no worker automatically creates receipts.

Linked invoice lines become immutable. Their invoice header can change status,
but its source/ownership/financial fields and deletion are protected. Recorded
estimated orders/lines and their original estimates remain immutable. Correction,
void/reversal and source-replacement workflows require a later audited design;
this increment does not silently rewrite existing receipts.

## Client behavior and charges

Changing an invoice, order line or case count invalidates review and consent.
Double-clicks have an in-flight guard. A lost response holds the identical review
for explicit retry or history recovery; a definitive first transaction rejection
permits fresh review. An unknown earlier outcome is not cleared by a rejected
retry. Reopening reads server history and the same invoice identity prevents a
second receipt. Saved receipt snapshots are checked independently with the pure
variable-weight receipt contract, including source calculations and audit fields.

Partial receipts show confirmed cases and recorded charges, with final charge
unknown until every ordered case on every line is accounted for. Summaries use
safe integer cents and never replace retained estimates with actual amounts.
Final linked item charges are sums of confirmed invoice lines; taxes, freight,
other invoice lines and full invoice settlement remain separate work. Current
purchase-order history/export retain the original quoted estimate. Receipt
history and final linked item charges are shown in Invoice Review.

## Validation and limits

Actual-SQL tests apply migrations twice and compare review/receipt calculations
with the independent core/service. They cover partial and complete charges,
ounces/pounds conversion and rate variance, out-of-range weight, source/rate
changes, stale remaining cases, one invoice across different orders, replay,
overdelivery, late rollback, immutable invoice/order records, viewer/outsider/
anonymous boundaries and unchanged scalar order totals. Rendered production
controls plus the independent service cover confirmations, quantity invalidation,
lost request/response, stable retry, remount/history recovery, SQL/offline/auth
failure, duplicates and tampered receipt responses. These are controlled tests,
not real supplier or signed-in/concurrent-session acceptance.

A hosted rollback-only verification script creates an isolated, category-valid
fixture organization and invoice/order sources, records two partial receipts,
checks replay, exact charges/variance and immutable sources, forces deferred
constraints and rolls back all fixtures. No vendor message, original Storage
upload, paid service, new secret, domain or automatic-ingestion change is needed.

Still open: signed-in source review/receipt save/reload; true separate-session
receipt races; source clarification for ambiguous invoices; audited receipt
correction/reversal; received-case supporting attachments; mixed exact/estimated
orders; remaining invoice charges/credits/taxes/freight and complete invoice
settlement; full supplier-to-invoice end-to-end acceptance. Task 1 remains
implementation-complete awaiting domains and related verification. Whole Task 2
and universal delivery remain open.
