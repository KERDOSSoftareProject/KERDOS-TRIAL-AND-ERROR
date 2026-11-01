# Estimated purchase drafts

This increment saves variable-weight purchasing drafts. It does not submit a
purchase order, send an email, enable ordering, or establish an actual charge.
The existing fixed-price purchase-order tables, submission transaction and
approved Order Guide interface remain unchanged.

## Saved boundary

`prepareEstimatedPurchaseDraft` requires explicit consent, a stable request ID,
current approved source terms, whole cases, unique vendor listings and one
organization/vendor. It reuses the existing purchasing-line contract. A nominal
average remains an estimate; a range keeps both endpoints. A draft with any
range has no scalar total. Mixed totals include nominal components at their
stated average, so neither endpoint is a guaranteed delivery charge. Monetary
sums are accumulated as safe integer cents. Final charges remain null.

The optional `estimatedDrafts` backend capability offers save, scoped retrieval,
request recovery and cancellation. The independent service authenticates the
creator, checks the returned record and line snapshots, and labels retrieved
history as requiring fresh validation. Keep the original request ID before
sending a save. Recover a lost response by that ID; do not create another ID to
retry an unknown outcome. Historic recovery does not attest to current source
terms or revive a cancelled draft.

## Authoritative transaction

The SECURITY INVOKER transaction checks purchasing membership and vendor scope,
serializes each organization/request ID, and locks all listings in stable order
before their approvals. It reloads exact mapping/source terms and active
approvals, checks revisions, and calculates each estimate on the server. The
client's estimate and complete intent must match. Insert policies repeat these
checks, including line identities and totals, to protect direct table writes.
All lines, approval/source snapshots and aggregate estimates save together.

Members may take a locked read of approvals. The approval UPDATE policy's
WITH CHECK still restricts revocation to owners/managers, and the immutable
approval trigger still protects its snapshot. Tests explicitly reject employee
revocation after this change. Anonymous calls and cross-organization reads are
blocked. Draft cancellation is limited to its creator or an owner/manager;
snapshots and history cannot be edited, deleted or resurrected through the
client role. Identical saved requests are idempotent even after cancellation or
source revocation; altered request reuse fails.

Saved lines use `estimated_purchase_draft_line`, distinct from a submitted
`estimated_purchase_line`. The invoice receipt contract rejects draft lines.
No draft can supply a final charge, pretend to be a submitted order, or clear a
vendor quote/review hold.

## Validation and remaining acceptance

Local actual-SQL tests run the migration twice with owner, manager, employee,
peer employee, outsider and anonymous roles. They cover scoped source/approval
and revision checks, forged estimates and charges, direct-write RLS, invalid
quantities, duplicates, mixed average/range batches, unchanged source holds,
revocation, cancellation and safe sequential retry recovery. Server calculations
are compared to the shared core across nested packaging and compatible mass
units. Independent adapter tests cover consent, auth, malformed responses,
recovery and immutable inputs.

Real concurrent database-session acceptance remains open; sequential tests and
written locking rules do not establish live concurrency behavior. Also open:
client basket/draft controls, fresh validation before submission, mixed exact
and estimated order presentation, final order persistence/export, delivery
minimum semantics, explicit invoice matching, partial receipts and final-charge
reconciliation. No real client approvals or drafts are created by local tests.
