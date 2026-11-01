# Task 2: replace a reversed receipt with a different saved source

Invoice Review can replace a reversed estimated-order receipt using a different,
already-saved invoice line. An owner/manager chooses the reversed receipt, enters
a reason, reviews the new invoice source and received whole cases, then separately
confirms the invoice/order link, physical case count and source replacement.
Changing selection, cases or reason invalidates review/consent. It uses the same
source evidence, product/vendor checks, arithmetic, mass conversion and case
quota rules as regular receiving. No source values or case counts are guessed.

This operation creates a new receipt and a unique append-only lineage link to
the reversed predecessor in one transaction. The old receipt remains reversed;
both invoice lines stay permanently reserved and immutable. A replacement can
later be reversed and replaced again, forming a retained chain. This does not
undo a reversal, change the original invoice, correct cases against the same
reserved invoice line, allocate an invoice line across receipts, create a vendor
credit or settle an invoice. The corrected source must already exist as a saved
invoice line with valid retained source evidence.

The database locks the same order line used by receipt saving/reversal, confirms
the predecessor is reversed in the same organization/order line, and uses the
existing authoritative receipt save before creating the audit link. A late audit
failure rolls back the new receipt and new invoice reservation too. A predecessor
has one successor and a receipt has one predecessor. The identical authenticated
actor/review/source/cases/reason replay returns the same receipt and link; changed
requests reject. Historical retry cannot reactivate a reversed middle receipt.
Direct lineage insertion runs the same guards, checks a different active source
for the same line, the saving actor and creation after predecessor reversal.

New lineage table RLS allows organization-member reads and owner/manager inserts
only; column grants protect derived identity/audit fields. Anonymous execution,
client UPDATE/DELETE and worker INSERT/UPDATE/DELETE are denied. New functions
are SECURITY INVOKER. Originals and all linked invoice sources retain their
existing immutability guards. No worker, domain, secret or vendor-send change.

One server SQL statement returns receipts, reversals and replacements in a
consistent history snapshot. The service independently checks source reviews,
lineage scope/references, reversal identity, actor/time, duplicate edges and
cycles. Charge/case summaries still count only active receipts; lineage itself
adds no charge. UI history retains old/new receipt identities, reason and actor.
Uncertain save responses freeze source/reason and preserve identical retries;
refresh and remount recover server history. An unavailable history after a known
write keeps the original request pending rather than clearing it.

Validation: actual SQL migration rerun, independent summary parity, separate
consents/reason, unauthorized/direct insert denial, wrong order line, unique
successor/predecessor, duplicate/conflicting retry, late transactional rollback,
immutable history, permanently reserved invoice sources, repeated replacement
chains and historical retry passed. Rendered production controls test review /
consent invalidation, updated totals, saved audit/remount, lost request/response,
identical retry, permission failures, tampered responses and history-fetch failure
after a successful write. Full local npm test and production build passed; final
added history-recovery test and lint passed.

Hosted kerdos-test migration and rollback-only fixture passed: original $56 and
$70 receipts, reversal of $56, new different-source $84 receipt and lineage, stable
replay, 2 active cases/$154, audit deletion denied, deferred FKs checked. Rollback
left 0 replacements/reversals/receipts/orders/fixture organizations; original
8 invoices/8 lines retained. RLS/privilege/function metadata checked; no new
security-advisor finding names these objects.

Still open: signed-in role acceptance and true separate-session races; clarification
or quantity correction against the same reserved invoice line; reversal undo;
split allocations, received-case attachments, mixed fixed/estimated orders;
additional lines, credits, tax/freight and complete invoice settlement; supplier
end-to-end acceptance. Task 1 remains code/database complete awaiting domains.
