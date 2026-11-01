# Task 2: audited accounting approval withdrawal

Invoices → Reconcile → Accounting approval allows an owner/manager to select one
approval record, enter a reason of 10–500 Unicode code points and separately
confirm withdrawal. Changing selection/reason clears withdrawal consent. Only the
selected approval is withdrawn; other valid approvals keep their own status.
Stale historical approvals can be withdrawn too. The original approval and its
reviewed source remain immutable, and withdrawal records retain actor/time/reason.
This does not change invoice amounts, receipt cases, credits or payment status.

The new append-only invoice_approval_withdrawals table has a unique approval FK,
server-derived invoice/organization/actor/time and canonical audit snapshot. RLS
allows organization-member reads and owner/manager inserts; input column grants
protect generated fields. Direct insert uses the same guard as the RPC. Client
UPDATE/DELETE and worker mutation are denied. Five new functions are invoker-only
with anonymous/worker execution revoked. The reason validator explicitly matches
JavaScript's Unicode edge whitespace trim and counts database Unicode characters,
so a server-valid reason remains readable in audit history.

Withdrawal serializes on the invoice header lock shared with approval saving;
it does not acquire order-line locks afterward. One withdrawal can exist per
approval. An identical actor/approval/reason retry returns the same audit identity;
a changed request rejects, and a late failure rolls back the whole insert. It
needs no clean-current-source gate because an incorrect or stale approval must
remain withdrawable. Existing membership and explicit consent still apply.

The new full-audit RPC reads approval and withdrawal arrays together. Service
validation checks scope, unique identities, known approval references and audit
chronology. Current approvals must match fresh source/gate evidence and have no
withdrawal. All-withdrawn history shows Approval withdrawn; a surviving matching
approval still shows Approval current. Old approval-save replay returns the
historical record without undoing withdrawal. Reapproval requires a new request
and the existing fresh evidence comparison and independent SQL gate.

The previous review RPC remains for cached/older clients, filtering withdrawn
approvals so they cannot count a withdrawn record as current after refresh. New
clients use the full-audit endpoint and retain complete approval/withdrawal
history. The legacy filtering does not remove any stored audit record or change
eligibility of a genuinely new clean approval.

The UI retains an uncertain withdrawal request and freezes its target/reason.
Explicit retry, refresh and remount recover from the server. A failure loading
history after a known write leaves the request pending. A concurrent confirmed
withdrawal discovered in history resolves the pending target with its actual
saved audit. Unresolved approval saves and withdrawals block each other's new
submissions. Both use the same working guard, and notes/consents cannot silently
change a pending request. No write happens on read or mount.

Validation: actual SQL migration rerun, owner/manager/employee/outsider/anonymous
and direct-insert boundaries, confirmation and Unicode reason rules, immutable
audit, late rollback, same/conflicting retry, legacy filtering, historical replay
and fresh reapproval passed. Service/rendered tests cover reason/consent
invalidation, saved audit/remount, reapproval, two-current-approval selection,
request/response loss, exact retry, history-after-write failure, explicit rollback
and invalid history references. Existing normal full test chain includes these
suites. Full local npm test and production build passed; final added focused UI
case and lint passed.

Hosted kerdos-test migration and rollback-only fixture passed: clean $56 approval,
stable withdrawal replay, full audit retained, legacy exclusion, historical-save
replay without restoration, and a distinct fresh reapproval. Withdrawal deletion
was denied and deferred FKs checked. All fixtures rolled back: 0 withdrawals,
approvals/orders/receipts/reversals/replacements/fixture organizations; original
8 invoices/8 lines retained. Hosted RLS/table privileges and five invoker-only
anonymous/worker-denied functions checked; no new related security-advisor finding.
No worker, domain, secret, delivery, payment or approved Order Guide change.

Still open: signed-in owner/manager/employee acceptance and true separate-session
approval/withdrawal/save/reversal races; missing/ambiguous invoice-summary
correction, same-source quantity correction and reversal undo; standalone credit
notes/credit allocation, mixed fixed/estimated receipt coverage and split
allocations; payment recording/reversal and complete settlement; supplier
end-to-end acceptance. Task 1 stays code/database complete awaiting domains.
