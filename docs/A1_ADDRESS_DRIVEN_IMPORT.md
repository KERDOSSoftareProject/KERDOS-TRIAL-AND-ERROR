# Division I / Module A / Task 1 — address-driven import

Work branch: `codex/a1-address-driven-import`, based on Claude's `99891ea`.

## Behavior and scope

The registered receiving address supplies organization, vendor and document
kind. Example names and domains are not deployment settings. New messages
snapshot vendor and type; later registration edits do not reassign old mail.
Registration chooses the processing path, while contradictory content still
requires review. Legacy untyped routes retain the existing narrow content
fallback for identified price sheets; untyped invoices require registration.

Retained Claude's type registration, snapshot helper and webhook/processor
wiring. Replaced its document-only invoice success path with validated invoice
persistence. Existing stored routes can now have their document type set for
future receipts. Address validation accepts configurable domain names and
extensions, rejects whitespace and multiple @ signs. Domain ownership and mail
provider routing still require actual operator configuration.

The invoice preparer reuses the existing document parser, identity/pack rules,
billed-unit evidence and invoice matcher. Known products with sufficient
identity, pack, quantity, price and arithmetic evidence import automatically.
Conflicting or unmatched products, missing fields, parser issues, credits and
unexplained totals require review with the original preserved. No catalog
association is guessed to force an invoice through. New-product/catalog review
is an exception, not a universal manual step. This change does not implement a
new invoice-derived quote policy or overwrite current price-sheet quotes.

`kerdos_auto_record_invoice` is service-role-only, SECURITY INVOKER, and checks
organization, receipt vendor/type, original path/name and the live attachment
lease while holding its row lock. Header, invoice lines, import document and
attachment status commit in one transaction. Persisted lines retain quantity,
unit price, extended amount, billed unit, pack, source line and unit evidence.
Replay and separate copies of the same numbered invoice reuse the linked
record. Changed content under an existing number goes to reconciliation.
A lost response remains recoverable; a local lease assertion alone is not used
as the write fence. Unknown transport outcomes do not force a committed or
retryable invoice into manual review.

## Local verification (October 27, 2026)

- Routing/service checks: 165 passed.
- Source interaction checks: 13 passed (source evidence only).
- Executed classification/importer exceptions: 13 passed.
- Existing price-sheet processor regression: 11 passed with explicit registered
  price-sheet type in fixtures.
- Lease/handoff checks: 29 passed, including invoice token transport and unknown
  commit-result handling.
- Invoice parser/importer + PostgreSQL (PGlite): 28 passed. Exercises actual
  migration SQL, saved header/line values, original/document linkage, role
  denial, snapshot immutability, wrong token/org/product, arithmetic rejection,
  manual reservation, replay, changed-number-content conflict, final-write
  rollback and successful retry. Fixture database is local, not kerdos-test.
- Rendered preview/Save checks: 4 passed, local component evidence.
- Full `npm test` (including lint), production build and `git diff --check`
  passed. Existing bundle-size warning remains.

## Database artifacts and remaining verification

Apply order for a reviewed test rollout:
1. `knowledge/migration_039_routing_document_type.sql` (DRAFT, updated with
   receipt-type/snapshot consistency check).
2. `supabase/migrations/20261027205000_a1_atomic_background_invoice.sql` (DRAFT).
3. Deploy processor before inbound webhook; frontend uses the same schema.

The timestamped migration was generated with the Supabase CLI. The older
combined database-update builder does not include these files; do not use that
combined bundle as this rollout's migration source. No database migration or
function/frontend deployment was performed for this implementation.

Before the deployment recommendation: verify draft migrations against the
actual test schema and check the current deployed environment. After test
rollout, verify actual mail receipt and saved invoice/price-sheet data in the
Trial and Error app, including a closed browser, duplicate delivery and
manual-review exceptions. Real receiving domains/addresses must be supplied
and configured; illustrative addresses are not treated as live. Supported
background readers remain the existing text/CSV/XLSX readers; PDF/OCR support
has not been added by this change. Task 1 and its interaction gate stay open.

The approved five-minute recovery scheduler is existing deployed behavior;
this change neither recreates it nor asks for another approval.
