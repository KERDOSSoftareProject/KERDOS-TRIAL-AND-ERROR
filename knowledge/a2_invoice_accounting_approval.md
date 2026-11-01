# Task 2: evidence-bound invoice accounting approval

Invoices → Reconcile now includes Accounting approval. An organization owner or
manager explicitly confirms the reviewed invoice amounts and receipt evidence;
a trimmed optional note (up to 500 characters) may be retained. Editing the note
clears confirmation. Employees and other members may read audit history but do
not receive approval controls. This records accounting approval only. It does
not record, initiate or send payment, mark the invoice paid, or settle a balance.

Approval requires a clean invoice-wide review: explicit supported subtotal, tax,
freight and credit evidence, exact line/adjustment/printed/recorded totals, one
active receipt per invoice line and no unresolved ordered-rate or weight flag.
A new independent SQL gate repeats these checks from authoritative source data.
It never accepts client eligibility as authority and conservatively holds
unsupported monetary source, repeated labels, missing amounts and precision
issues. The service independently runs the existing core review and rejects a
server-eligible result that disagrees with retained source evidence.

An append-only invoice_accounting_approvals row records server-derived actor/time,
request identity, note, the complete reviewed source snapshot and successful gate.
RLS allows organization-member reads and owner/manager inserts only. Column grants
protect generated scope/audit fields. Direct inserts use the same guard; client
UPDATE/DELETE and worker table mutation are denied. All six new functions are
SECURITY INVOKER with anonymous and worker execution revoked. No worker, domain,
secret, external messaging or payment integration is changed.

Saving locks associated recorded order lines in deterministic order before the
invoice header. This matches receipt save/reversal lock ordering; the header
UPDATE lock also fences referencing invoice-line inserts. The transaction reloads
the full source, compares it exactly to the confirmed snapshot, reruns the SQL
gate and atomically stamps the audit. Stale evidence rejects. A unique organization
/request key returns the same saved approval for the same actor/invoice/source/
note. Changed requests reject. A late failure rolls back the whole audit insert.
A historical identical retry can return a previous approval after evidence changes;
it never declares that previous approval current again.

Audit records cannot be overwritten or deleted. The current status is derived
by comparing each retained source snapshot to the freshly read invoice/receipt
source and gate. A later reversal or evidence change preserves the earlier
approval while displaying Needs reapproval. Receipt reversal remains possible;
this feature does not freeze an inaccurate receipt merely because it was approved.
Fresh review is required before approving new evidence. Status changes unrelated
to invoice evidence do not rewrite approval history.

The UI shows current versus earlier evidence, approver, time and note. It freezes
an uncertain request, retains identical retry, recovers from server history after
response loss or remount, and does not clear a pending request on a history error
after a known write. Conflicting recovery evidence is held rather than adopted.
Refreshing the parent reconciliation view refreshes the accounting source too.
No approval is created on mount or by reading an invoice.

Validation: actual SQL applies the migration twice and exercises independent gate
parity, source/money/unit/coverage holds, owner approval, employee/direct-insert,
outsider/anonymous denial, explicit confirmation, stale/tampered evidence, note
rules, immutable audit, duplicate/conflicting replay, late rollback and reversal
invalidation. Independent service and rendered production controls test role and
consent/note invalidation, current/history/remount, lost request/response, exact
retry, history-after-write recovery, SQL/offline/auth failures and tampered server
results. Normal npm test includes the approval UI/service suite.

Hosted kerdos-test migration and rollback-only check passed: a clean $56 invoice
with explicit zero adjustments was approved; identical retry returned its same
audit. Later receipt reversal retained the audit, made the gate ineligible and
blocked a new approval. Audit deletion denied, deferred FKs checked. Rollback
left 0 approvals/receipts/reversals/replacements/orders/fixture organizations;
original 8 invoices/8 lines retained. Hosted RLS, table privileges and six
invoker-only anonymous/worker-denied functions verified; no new related security
advisor finding.

Still open: signed-in owner/manager/employee acceptance and true separate-session
approval/save/reversal races; audited approval withdrawal; correction of missing
or ambiguous invoice summary evidence; standalone credit notes/credit allocation,
mixed fixed/estimated receipt coverage and split allocations; payment recording,
payment reversal and complete settlement; supplier end-to-end acceptance. Task 1
remains code/database complete awaiting domains.
