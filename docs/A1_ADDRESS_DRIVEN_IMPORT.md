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

Both draft migrations were subsequently executed inside a rolled-back
transaction against the actual kerdos-test schema. Compilation, service-only
function grants and snapshot consistency checks passed. Follow-up inspection
confirmed neither migration remained applied. This is real schema-compatibility
evidence, not deployed invoice-processing evidence. The invoice changes are
ready for a controlled Trial and Error test rollout. After that rollout,
verify actual mail receipt and saved invoice/price-sheet data in the
Trial and Error app, including a closed browser, duplicate delivery and
manual-review exceptions. Real receiving domains/addresses must be supplied
and configured; illustrative addresses are not treated as live. Supported
background readers remain the existing text/CSV/XLSX readers; PDF/OCR support
has not been added by this change. Task 1 and its interaction gate stay open.

The approved five-minute recovery scheduler is existing deployed behavior;
this change neither recreates it nor asks for another approval.

## Test rollout update — October 27, 2026

Migration 039 applied to kerdos-test as 20261027212428; atomic invoice migration
applied as 20261027212432. Processor and webhook deployed ACTIVE v6 with
unchanged authentication. Recovery remains ACTIVE v5 and the approved cron
job remains active. Six unauthenticated rejection probes passed.

The existing scheduled recovery worker processed synthetic Storage-backed
fixtures in organization ab0f7ada-83ad-43eb-a513-6a8c5bd43a09. The invoice saved
quantity 2, unit price 10, line/header total 20, CASE unit and billing evidence,
and a complete linked source document. The price sheet saved one price of 10.
A second invoice attachment reused the same invoice and document. Incorrect
arithmetic produced needs_review with no document. This exercises deployed
processing/recovery; it does not establish actual Postmark delivery.
Three synthetic CSV files remain in test Storage for this verification workflow.
No user pricing data was modified by the fixture tests.

That deployed check exposed truncation of long alphanumeric invoice numbers
by the shared parser. The parser now preserves complete numbers, including
slashes/dots, with a regression distinguishing matching prefixes. Local invoice
checks now total 29. Integration with the latest Trial and Error main preserves
its Inbox adapter, test receiving-address configuration and movable dialogs.
Combined npm test/lint and build passed. Frontend deployment and verification
of the parser update against deployed fixtures follow this source checkpoint.

## Zero-action registration correction

The client-facing routing setup was the wrong entry point. Receiving addresses
are now provisioned by vendor lifecycle triggers, not by a form or a page visit.
The authenticated organization supplies the client; the vendor row supplies
the vendor. Provisioning creates both document registrations. Invoices and
Price Sheets each display the correct receiving address for their context.
The Inbox overview is read-only. There is no Add Address, vendor-assignment,
document-type or Save control in the receiving UI. Existing manual upload
features remain available as their separate ingestion path.

Platform configuration is private and service-only. Actual delivery-ready
price-sheet and invoice domains are deployment settings, with arbitrary
company names and domain extensions. No illustrative domain is activated.
When platform domains become delivery-ready, existing vendors are backfilled;
new vendors get both addresses immediately. Inactive vendors lose active
receivers; reactivation reuses them. Name collisions cannot cross tenants,
and renaming a vendor does not silently change its established addresses.
Client roles can read their own automatic registrations, but cannot insert,
edit, deactivate or reassign them. Receipt snapshots remain unchanged.

Validation: 12 PostgreSQL provisioning/access/lifecycle checks, four rendered
context checks, full npm test/lint and build passed. A transaction against the
actual kerdos-test schema verified automatic registration, address/type
ownership and client write denial, then rolled back. Real receiving domains
have not been supplied; mail-provider/DNS readiness must be established by the
platform operator, never delegated to each client through setup dropdowns.


### Existing Postmark receiver: continue Task 1 without owned domains

Owned domains are future platform delivery configuration, not a prerequisite for
automatic-ingestion acceptance in kerdos-test. Two explicit test-only routing rows
now target the existing isolated organization/vendor fixture:

- Price sheet: `aa55b9cf38e8fab147fc4c8b7e914e7d+a1-prices@inbound.postmarkapp.com`
- Invoice: `aa55b9cf38e8fab147fc4c8b7e914e7d+a1-invoices@inbound.postmarkapp.com`
- Organization: `ab0f7ada-83ad-43eb-a513-6a8c5bd43a09`
- Vendor: `4a5f0cca-680c-4a9b-88ab-bf3372b25035`

The original receiver and historical receipt snapshots were not reassigned.
These are database test configuration, not application rules or production domains.
The webhook already performs exact registered-recipient lookup, preserving plus tags.
Postmark documents plus addressing and OriginalRecipient preservation.

`verify_a1_real_email.mjs` defaults to this test-receiver mode. Supply
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `A1_ORGANIZATION_ID`, `A1_VENDOR_ID`,
`A1_PRICE_ADDRESS` and `A1_INVOICE_ADDRESS` privately. Optional
`POSTMARK_SERVER_TOKEN` inspects its server; no account token is needed. The script
is restricted to kerdos-test, does not require private-schema REST access, and
withholds webhook credentials. Missing checks return exit 2; failures return exit 1.
`A1_RECEIVER_MODE=custom-domain` explicitly opts into future domain configuration
inspection. No domain purchase is requested for test-receiver mode.

The inspector is read-only and never sends email. Its executed provider-stub tests
verify test-mode readiness, missing evidence, ownership/type setup, exact webhook
target, server-token usage and credential-safe output. Those local tests do not
establish real-email delivery.

Acceptance requires automatic receipt-to-save with the browser closed: correct
organization/vendor/type snapshots, stored original, complete linked document,
and exact expected prices or invoice lines. Inbox arrival and auto_imported status
alone are insufficient. A valid fixture reaching needs_review is not a pass.
Then verify duplicate delivery and expired-worker recovery without resetting an
active lease. Scope all evidence to the isolated fixture.

At test registration time, both tagged addresses had zero received messages and
the fixture had zero 10.37 quotes. Real-email acceptance remains open until a real
message reaches this path. A direct HTTP Postmark-format request is synthetic
webhook evidence and must not be labeled real-email evidence.
