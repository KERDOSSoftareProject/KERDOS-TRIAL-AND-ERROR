# Task 2: audited records of payments made elsewhere

Invoices → Reconcile includes Payment records. An owner/manager selects a current
accounting approval and explicitly enters amount, actual payment date, method and
external check/transaction reference. Nothing is defaulted as an actual payment.
The user reviews exact cents and the remaining balance, then separately confirms
that payment was made elsewhere for this invoice. KERDOS does not initiate a
transfer, contact a bank, issue refunds or verify bank settlement.

The invoice_payments ledger and invoice_payment_reversals are append-only with
organization-member reads and owner/manager inserts. Input column grants protect
server-derived financial/audit fields; direct inserts run the same guards.
Client UPDATE/DELETE and worker mutations are denied. Eight new functions are
SECURITY INVOKER with anonymous/worker execution revoked. No worker/domain/secret
or approved Order Guide change. No invoice status is silently marked paid.

Payment review requires a clean, current, non-withdrawn accounting approval whose
retained source equals the authoritative invoice/receipt source. A positive exact
cent amount may not exceed the remaining approved total. Method and real calendar
date are explicit inputs. Request identity prevents duplicate retries; trimmed,
case-insensitive reference identity is unique within an invoice, including
reversed history, so remounting or using a new request cannot duplicate that
reference. A reference stays reserved for its chain. Audited same-reference correction is
now documented in `a2_same_reference_payment_corrections.md`; unrelated duplicate
records remain denied.

Saving locks all associated recorded order lines in deterministic order before
the invoice header, matching approval/receipt lock order. It reloads current
approval/source, paid total and append-only ledger counters and compares the
exact reviewed plan. Changed source, balance or history rejects, including a
payment-plus-reversal change that restores the previous balance. This prevents
a stale review from silently allocating a different remainder. Server actor,
recording time, actual entered payment date, reference and approval/source review
are retained together. Late failures roll back the entire insert. Same actor /
request / exact review replay returns the same original payment identity.

Payment reversal requires an owner/manager, reason and explicit confirmation.
It serializes on the invoice header, retains the original payment and creates
one immutable reversal. Identical actor/payment/reason replay returns the same
reversal; changed retries reject. Reversal is permitted after approval withdrawal
or receipt changes so an incorrect ledger record can still be corrected. It does
not reverse a bank transaction. Historical payment replay never reactivates a
reversed record; only active payment records count toward the balance.

The server aggregates full payment/reversal arrays without client row-limit
truncation. Independent service validation checks cents, dates, approved totals,
exact canonical saved plans, scope, known historical approvals, unique identities,
reversal amounts and chronology. Summaries distinguish no record, partial record,
full recorded coverage, no payment due, and needs current accounting review.
Approval withdrawal or source changes preserve the recorded paid amounts and
show historical-basis balances with a review hold. Full recorded coverage is not
bank-confirmed settlement. Differing unknown historical total bases stay unknown.

UI controls invalidate review/consent on changes, freeze uncertain requests and
recover through identical retry, refresh and remount. History failure after a
known write preserves the request. Pending payment and reversal actions block
one another. Approval changes in the parent panel refresh payment eligibility
without erasing payment history. Reading or opening a ledger creates no writes.

Validation: actual SQL migration rerun, source/approval/role/direct-insert gates,
exact partial/full sums, overpayment and duplicate reference denial, late payment
and reversal rollback, stale ledger counters, immutable audit, historical replay,
post-withdrawal payment retention, manager reversal, employee/outsider/anonymous
isolation passed. Rendered/service tests cover exact input/calendar checks,
consent and invalidation, partial/full/reversed balances and remount, request /
response loss, stable retry, history-after-write recovery, auth/role/offline and
tampered ledgers. A parent-panel integration test verifies approval withdrawal
refreshes payment eligibility while preserving paid records. Full local tests
and build passed; final additional SQL/UI/integration tests, lint and build passed.

Hosted kerdos-test migration and rollback-only fixture passed: $20 partial plus
$36 full coverage of an approved $56 invoice, stable request identity, reversal
of $36, duplicate reversed-reference and overpayment denial, and a new distinct
$36 record restoring $56 active coverage. Receipt reversal retained payment
history while blocking new eligible approval. Payment deletion denied and deferred
FKs checked. After rollback: 0 payment records/reversals and all other fixture
audit/order rows; original 8 invoices/8 lines unchanged. Hosted RLS/privilege and
eight invoker-only anonymous/worker-denied functions verified with no new related
security-advisor finding. No actual payment, refund or external-bank call occurred.

Still open: signed-in and true separate-session payment/approval/reversal races;
same-reference correction acceptance; bank evidence /
verification, refunds/credits and cross-invoice allocations; missing/ambiguous
invoice-summary correction and mixed fixed/estimated coverage; complete supplier
end-to-end and bank settlement acceptance. Task 1 stays code/database complete
awaiting domains; Task 2/universal delivery remains open.
