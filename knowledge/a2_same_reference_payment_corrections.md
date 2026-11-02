# Task 2: same-reference correction of a reversed payment

Invoices → Reconcile → Payment records can correct the latest reversed record
under its existing check/transaction reference. An owner/manager selects that
record, enters corrected amount/date/method and a required reason, chooses current
accounting approval, reviews the balance, and separately confirms payment facts
and correction. Reference is retained from the predecessor rather than edited.
Changing details/reason invalidates review and both confirmations.

The original payment and reversal remain immutable. A new payment records its
predecessor, reversal identity, correction reason, actor/time and approved source.
Only active records contribute to balances. A corrected record can itself be
reversed and corrected, creating one linear chain. An original payment-save or
old correction retry returns historical identity without restoring a reversed
record or counting it again. No transfer, refund or bank verification is performed.

The invoice_payments table gains a protected unique predecessor FK and correction
confirmation input. Root reference uniqueness becomes a unique partial index;
original references remain reserved for one root per invoice. Corrections must
retain the exact predecessor invoice/reference, require its reversal, have no
existing successor, and find no active record for that reference. Unique
predecessors and existing immutable records prevent branches/cycles. A full
invoice index retains query/FK coverage after the reference-index change.

The independent review core reuses current non-withdrawn approval, exact source,
cent/date/method/reference validation, remaining-balance and ledger-revision gates.
Save locks order lines then invoice header, repeats exact review and requires
both payment and correction confirmations. Direct inserts run the same guard;
regular save cannot create a correction without the extra consent. Derived
predecessor fields cannot be client-inserted, existing RLS and mutation denials
remain. Three new functions are invoker-only and anonymous/worker execution is
revoked. No new table, worker, domain, secret or approved Order Guide change.

An identical actor/request/review replay returns the same new record. Changed
requests, stale balances/history, withdrawn approval, wrong invoice, changed
reference, active predecessor, attempted branch and overpayment reject. A late
failure rolls back the new record and predecessor association. Historical replay
after a later correction/reversal does not reactivate the old amount.

Service validation independently checks predecessor and reversal references,
retained invoice/reference, chronology, unique successor, cycles and single
active exact reference. DTO top-level shape remains compatible with older
readers, which still include every payment/reversal and count only active records.
Legacy regular recording continues to reject an existing reference; correction
is an explicit reviewed operation rather than a new unrelated payment.

The UI shows correction history with original record, reason, actor/time and
amount. Pending requests freeze details and both consents, use identical retry,
and recover through refresh/remount. A missing history response after a known
write retains the pending request. No write happens on reading or selecting a
record. Payment reversal and new submissions retain the shared working guard.

Validation: SQL migration rerun, owner/manager creation, employee/direct-insert
rejection, double confirmation, wrong invoice/reference, active predecessor,
reason and amount bounds, one-successor chain, late rollback, same/conflicting
retry and historical replay passed. Independent ledger checks verify only active
corrected charges. Rendered production tests cover locked reference, reason and
consent invalidation, updated balances/history/remount, lost request/response,
identical retry, history-after-write failure, SQL rejection and tampered lineage.
Full local tests/build passed; final focused SQL/UI, lint and build passed.

Hosted kerdos-test migrations and rollback-only fixture passed: $20 payment plus
reversed $36, same-reference $35 correction giving $55 recorded total, reversal
of that correction and a new same-reference $36 correction restoring $56. Exact
replay/lineage and active sums verified; old history retained and deferred FKs
checked. After rollback: 0 payments/reversals/other fixture audit/order records;
original 8 invoices/8 lines unchanged. Hosted derived-column/consent permissions
and invoker/anonymous/worker checks passed with no new related security finding.

Still open: signed-in and true separate-session correction/payment/approval races;
bank evidence and settlement, refunds/credits and cross-invoice allocations;
missing/ambiguous invoice-summary correction, same-source quantity correction,
mixed fixed/estimated receipt coverage and supplier end-to-end acceptance. Task 1
stays code/database complete awaiting domains; Task 2/universal delivery stays open.
