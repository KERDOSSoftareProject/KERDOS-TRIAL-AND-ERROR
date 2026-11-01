# Estimated order recording and export

Saved estimated drafts can now be reviewed and recorded as purchase orders.
Recording and exporting do not send anything to a vendor. The existing scalar
basket and its Order Guide layout stay intact. Mixed fixed/estimated baskets
remain open; this increment records approved variable-weight draft lines.

## Fresh review and stable recording

The provider-neutral estimatedOrders capability offers review, submit and
recovery by saved draft. Review reloads authoritative source terms, approvals,
listing revisions and vendor delivery minimums. The service checks that the
returned review still matches the saved draft. Recording requires separate
explicit consent and repeats the authoritative review inside the transaction.
A cancelled draft cannot be submitted. Owners/managers can record a member's
draft; employees can record their own. The exact submitting actor is retained.

Each draft has at most one submission and one purchase order. A draft row lock
serializes recording with cancellation and competing submissions. An identical
retry by the same actor returns the original immutable order snapshot, even
when current source terms have since changed. A changed review or different
submitting actor cannot reuse that submission. Read-only recovery is available
to organization members. Unknown outcomes remain recoverable from the durable
saved draft across remount; no replacement draft ID is automatically generated.

## Shared history and immutable snapshots

An invoker-only, RLS-protected submission table links the source draft to the
existing purchase_orders and purchase_order_lines tables. Its BEFORE INSERT
trigger validates consent-related minimum flags and authoritative review, then
creates a server snapshot. Its AFTER INSERT trigger writes the shared header
and all lines. A deferred FK and transaction rollback prevent orphaned or
partial submission/header/line sets. Direct submission inserts execute the same
checks; clients cannot supply the generated snapshot or actor/time fields.

Header/line triggers require exact canonical snapshots and protect estimated
orders against editing, appending fabricated lines, moving ordinary lines into
estimated orders, clearing their type or deleting their history. Clients cannot
update/delete the linking submission. Once recorded, draft cancellation is
rejected. Fixed-price records retain their existing behavior.

Each recorded line has a stable order/line ID, kind estimated_purchase_line,
whole-case quantity, approval/source/mapping snapshot, listing revision, quoted
rate/unit/pack and labeled estimate. Source client/vendor names are retained.
Header total_amount, line unit_price and line_total stay null for estimated
orders; actual charges remain null. Existing history displays typed estimates
and uses retained product descriptions, avoiding a false $0 or fixed final
total. Recorded status explicitly leaves vendor sending/receipt unconfirmed.

## Delivery minimums and export

Whole-case minimum quantities are checked against the saved order quantity.
A short case minimum blocks recording. A monetary minimum remains unknown when
the final charge depends on delivered weight, regardless of the estimate or
range endpoints. Recording it requires an explicit acknowledgement. The order
retains the reviewed minimum terms and leaves meets_delivery_minimum null for
unknown monetary minimums. Concurrent vendor-configuration changes still need
separate-session acceptance; the terms are snapshotted at the server review.

Text export uses the immutable recorded order, including IDs, customer/vendor,
case quantities, original vendor codes, packs, stated rates (including precision
beyond cents), per-line and total estimate/ranges, unknown final charge and
unconfirmed sending status. Export is a local user action and does not send
email or submit an order to a vendor portal.

## Validation and remaining work

Actual-SQL tests apply all required migrations twice. They cover source/revision
and minimum changes, forged review, consent, unknown-minimum acknowledgement,
short minimums, manager/employee/outsider/anonymous boundaries, cancelled drafts,
full rollback on line failure, stable retries, immutable records, blocked late
line insertion and null final charges. Service tests verify scopes, exact review
snapshots, malformed responses, auth, consent, export text and fixed/estimated
history formatting. Rendered controls verify review, separate acknowledgement,
recording, a lost response, recovery and reopening the same order after remount.
These are controlled local checks, not signed-in or concurrent hosted acceptance.

Hosted kerdos-test migration installation and rollback-only verification passed.
The fixture follows the existing category/item-number rules, simulates an
existing authenticated owner in an isolated temporary organization, approves
source terms, saves a draft, reviews and records it, retries the same submission,
checks the shared header/line and null total, rejects draft cancellation and
header mutation, and forces deferred FK checks before rollback. Final counts
remain zero approvals, drafts, submissions, headers, lines and fixture
organizations. All new functions are SECURITY INVOKER with anonymous execution
revoked; the linking table has RLS and no client UPDATE/DELETE grants. No security
advisor finding names the new objects. This is database role simulation, not
real browser sign-in, concurrency or vendor delivery.

Open: signed-in review/record/reload/export, actual separate-session races,
mixed fixed/estimated orders, vendor delivery confirmation, explicit invoice
matching, actual delivered-weight charges, partial receipts and reconciliation.
No real client draft, approval, purchase order or vendor message is created by
local tests. Rollback should hide new recording controls while retaining the
schema, canonical history and immutability guards for already-recorded orders.
