# Task 2: audited estimated receipt reversal

Invoice Review in a recorded estimated order supports append-only reversal by an
organization owner or manager. The user chooses an active receipt, supplies a
10–500 character reason and separately confirms removal from case/charge totals.
Editing the reason or selection clears consent. Original receipt, source invoice
link, original quote/order estimate and all audit records remain immutable.
The same invoice line stays permanently reserved, including after reversal.
This is an accounting-link correction; it does not return goods, create credit,
change invoice status, send a vendor order or settle an invoice.

`estimated_receipt_reversals` has one reversal per receipt with RLS member reads,
owner/manager-only inserts, server-derived scope/actor/time and a canonical
snapshot. Authenticated and worker update/delete are denied; worker insertion
is denied. A trigger validates direct inserts too. All new functions are invoker
security, with anonymous execution revoked. A reason is trimmed before sending;
the API rejects untrimmed input and requires explicit confirmation.

Reversal and new receipt saving lock the same recorded order line. Review sums
only receipts without a reversal and saving repeats the exact review under that
lock. A change to remaining cases invalidates prior reviews. The unique receipt
constraint makes reversal race-safe; the identical actor/receipt/reason retry
returns the existing reversal, while changed requests reject. Original receipt
save replay returns its historical receipt without removing a reversal.

One RPC returns original receipts and reversal audit records in one SQL statement
so both sets share a database snapshot. Service validation checks scope, audit,
known receipt references and duplicate records. Only active receipts count toward
case quotas and charge summaries. Reversing a completed line makes the final
charge unknown again until all ordered cases are covered by active receipts.

The UI blocks changed requests after an uncertain response. Refresh recovers a
saved reversal or retains the identical retry. A remount reads the server audit;
no browser-generated audit or destructive overwrite is used. Missing history
leaves totals unknown, and history-fetch failure after a known write does not
mistakenly clear the pending request.

Validation: actual-SQL fixture applies the migration twice, exercises owner and
employee/outsider/anonymous rules, direct insertion, consent/reason guards,
replay/conflicts, immutable audit/source, permanent invoice reservation, restored
case capacity, stale reviews, and independent core summaries. Rendered production
controls cover consent invalidation, short reason, zero-active-receipt totals,
response loss, request loss, identical retry, refresh, remount and permission
failure. The existing normal full test chain includes both suites.

Hosted kerdos-test migration and rollback-only verification passed: two linked
receipts ($56 and $70), one reversal with stable replay, one active case/$70,
immutable invoice reservation and denied reversal deletion. Deferred FKs checked.
After rollback: 0 reversals, 0 receipts, 0 orders, 0 fixture organizations; original
8 invoices/8 lines retained. RLS on, client UPDATE/DELETE and worker INSERT denied;
four new functions invoker-only with anonymous execution denied. No new security
advisor finding names these objects. No edge worker, domain, secret or delivery
change.

Still open: signed-in owner/manager/employee acceptance and true separate-session
save/reversal races; reversal cancellation/undo; replacement or corrected source
for the same invoice line; split allocations, case attachments, mixed fixed and
estimated orders, taxes/freight/credits/additional lines and complete settlement;
full supplier acceptance. Task 1 remains code/database complete awaiting domains.
