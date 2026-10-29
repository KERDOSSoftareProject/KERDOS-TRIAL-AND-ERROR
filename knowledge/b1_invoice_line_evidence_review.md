# B1 invoice upload — stated line evidence

Observed October 29, 2026 Eastern in the deployed manual upload path.

## Actual result and defect

The controlled invoice `B1-MANUAL-20261029-001` was saved at 09:37:25 Eastern as
`1fdbb47a-65a5-487a-abc4-c95705014942`. Its original 192-byte file is retained.
Line `0c911459-bcb4-4ebb-9054-f5fc7383bcb6` correctly records unit price 43.25,
line amount 86.50, code match and variance 2.00. The prior 41.25 vendor quote
and both price-history rows remain unchanged. These are actual database results.

However, quantity, selling unit, pack, source line and billed-unit evidence were
NULL. The modal omitted quantity/unit/source evidence from its payload; the manual
`kerdos_record_invoice` RPC also ignored these existing columns, including pack.
This is manual invoice evidence loss, not an automatic-email worker defect.

## Proposed correction

- Pass stated quantity, selling unit, source line and `billingUnitEvidence(row)`
  beside the already-passed pack. Preserve missing values as NULL.
- Replace only the existing manual invoice RPC, persisting those five existing
  line columns. Preserve authentication, organization/vendor/catalog ownership,
  invoker security, catalog linking and authenticated-only permissions.
- `knowledge/b1_invoice_line_evidence.sql` is the exact database draft, bounded by
  lock timeout 3 seconds, statement timeout 15 seconds and idle-transaction timeout
  10 seconds. No columns/tables, grants to new roles, schedules or credentials added.
- Do not backfill or rewrite historical invoices. A fresh controlled invoice is
  required after deployment to establish hosted acceptance of the correction.
- Apply the database function in kerdos-test before deploying the frontend payload
  update. The old payload remains compatible with the amended RPC.

## Verification and limits

The rendered regression failed first with `undefined !== 2`, reproducing the
missing quantity. The nine rendered B1 checks now also assert quantity 2, CASE,
2/10 LB, exact source row and explicit pricing-unit evidence on the invoice call.
These are local tests with simulated file-reading and persistence boundaries.

The executed PGlite SQL test applies the exact replacement RPC and verifies all
stated fields survive; absent evidence remains absent; invoice recording leaves
the quote unchanged; invalid quantity atomically rolls back its header; anonymous
execution is denied and authenticated execution remains allowed. This extends
the existing catalog-link SQL suite in `npm test`; it is not a hosted SQL pass.

Whole B1 live invoice acceptance stays open until a fresh signed-in upload saves
the stated evidence in the actual database. The current preview already has a
saved invoice behind it; Cancel avoids an unnecessary duplicate attempt.

## Rollback

Restore the prior function body from `knowledge/migration_013_invoice_mapping.sql`
with the same bounded timeouts, and redeploy the preceding frontend if necessary.
Preserve all invoice rows, prices and originals. No historical-data cleanup is
part of this change.

## Approved kerdos-test application — October 29

Dino explicitly approved the function update and PR #28 deployment. Applied migration `20261029134730_b1_manual_invoice_line_evidence`; its repository filename comes from actual Supabase history. An authenticated-role call to the actual RPC preserved quantity 2, CASE, 2/10 LB, source line and explicit billing-unit evidence. The accepted 41.25 quote and its price-history count stayed unchanged. All verification writes rolled back: zero B1-RPC-ROLLBACK-CHECK rows, the original invoice count remains one, both prior quote IDs/values remain, and Task 1 recovery job 1 remains active every five minutes.

The function remains SECURITY INVOKER. The authenticated grant is retained. An explicit/inherited anonymous EXECUTE privilege was already present before this migration and remains present; this deployment does not claim to remove it. The function still rejects missing authentication and enforces owner/manager organization and vendor checks. The fresh local SQL test’s denied-anonymous-execution result does not describe this pre-existing hosted ACL. Historical invoice rows were not backfilled. Fresh signed-in frontend acceptance remains open.
