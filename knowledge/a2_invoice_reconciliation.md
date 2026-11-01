# Task 2: invoice-wide reconciliation review

Invoices now offer a separate Reconcile action alongside opening the original
file. The review accounts for every saved item line, active or reversed estimated
order receipt, printed subtotal, explicitly stated taxes, freight/delivery,
credits/discounts, other supported charges and printed invoice total. It compares
item sums plus stated adjustments against the printed total, separately flags a
recorded header total that differs, and exposes exact retained summary lines.
Adjustments stay at invoice level; they are not allocated to individual orders.

The distinction matters because existing intake often records an item-line sum
as total_amount. That is not proof of the printed invoice total. This change does
not backfill source evidence, overwrite original totals, broaden automatic import
acceptance, or silently treat an omitted tax/freight/credit amount as zero.
Unsupported, missing, repeated or ambiguous summary fields remain held for review.
Explicit zero amounts are accepted as source evidence. The parser recognizes
labelled whole summary lines rather than guessing monetary values from prose.

Supported summary labels are centralized in the pure core: subtotal/item or
merchandise subtotal; tax/sales tax/VAT/GST/HST; freight/shipping/delivery charges;
credits/discounts; fuel surcharge/service charge/handling fee/other charges; and
invoice/grand/amount-due/total. Multiple subtotal/total entries, repeated labels,
unclassified monetary source lines and unsupported money formats are flagged.
Credits subtract their absolute stated amount. Supported negative credit or
parenthesized credit amounts remain negative. Negative totals/tax/freight and
standalone credit notes need clarification rather than automatic reconciliation.
A summary row also recorded as an item line is flagged against double counting.

Money is converted to integer cents from exact decimal forms. Missing or
fraction-cent/unsafe amounts stay unknown, and aggregate precision is checked.
Very large JSON numeric amounts require exact decimal strings because precision
may already be lost in transport. Unknown source lines block a clean result.
Tax, freight and credit amounts plus a subtotal and total must be explicit for
a balanced-source conclusion; absent individual fields are never inferred zero.

Receipt coverage is separate from amount balancing. Every saved line shows
linked, reversed or unlinked status and any retained ordered-rate variance or
weight-range flag. Only active receipts count as linked charges. Full review
shows Reconciled amounts and receipt links only when source arithmetic balances,
the recorded and printed totals agree, every item line has an active receipt,
and no rate/weight flag remains. This is a computed review, not a payment,
settlement, accounting approval or persistent invoice-status update.

A new optional provider-neutral invoiceReconciliation.review capability calls a
read-only SECURITY INVOKER RPC. Organization membership and existing RLS apply;
anonymous and worker execution are denied. One SQL statement aggregates the
full invoice header, all lines, matching receipt snapshots and reversals, avoiding
client row-limit truncation and inconsistent multiple-query reads. No new table,
write privilege, mutation API, worker deployment, domain or secret is introduced.
The service validates scope, unique identities, canonical receipt snapshots,
current invoice product/unit/quantity/rate/charge/source and reversal references.

The Invoices tab preserves original-file, vendor/search and existing edit/delete
controls. Employees can open the review without gaining write permissions.
The panel refreshes authoritative evidence, clears stale results during refresh
or failure, ignores late responses for a previous invoice and exposes source
issues. The approved Order Guide is untouched.

Validation: pure core/service tests cover explicit summary amounts and credit
signs, integer cents, omitted/ambiguous/unknown summary evidence, subtotal/header/
total differences, linked/reversed/unlinked coverage, scope/unit/source tampering,
duplicate history and authenticated read-only access. Actual SQL migration rerun
and core parity test a fully covered invoice, reversals, 1,002-line full reading,
missing/cross-client invoices and anonymous denial. Rendered production tests
cover source/line review, original-file route preservation, employee access,
refresh errors/recovery and stale response isolation. Normal full test chain now
includes the core/service and UI suites.

Hosted kerdos-test migration and rollback-only review check passed: full retained
$84 item line, printed/recorded $90 invoice total, $5 tax, $2 freight and $1 credit,
active receipt snapshot, no reversed receipt for that invoice, and unchanged
receipt count. Deferred FKs checked. After rollback: zero fixture organizations,
orders/receipts/reversals/replacements; existing 8 invoices/8 lines retained.
Hosted function invoker-only, authenticated execution allowed, anonymous/worker
execution denied; no new related advisor finding.

Still open: signed-in acceptance and separate-session races; supported correction
and confirmation of missing/ambiguous invoice summary evidence; standalone credit
notes and credit allocation; mixed fixed/estimated receipt coverage and split
allocations; explicit accounting approval, payment and complete settlement;
supplier end-to-end acceptance. Task 1 stays code/database complete awaiting domains.
