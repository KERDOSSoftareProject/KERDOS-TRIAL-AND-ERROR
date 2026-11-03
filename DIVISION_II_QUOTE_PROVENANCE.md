# Division II — invoice quote evidence

Prepared on 2026-11-03 from main `b82b47dda58223694079a1a67e78e735af531409`, integrating Aristotle's handoff into current source rather than replacing whole pages with older copies.

Both interactive and automatic imports now retain the actual historical quote's identifiers, original and compared rates, source basis and date, and an explicit reason when comparison was not performed. Shared lookup handling preserves `lookup_error` in the stored interactive result as well as its UI warning. Zero variance remains distinct from an absent comparison. CSV uses retained quote values and leaves legacy missing evidence blank.

The independent invoice review floor is 60%; automatic acceptance keeps its existing 90% minimum and identity/pack gates. The existing interactive refresh window is preserved and recorded as `client_window_exceeded` when it suppresses a comparison. Whether the automatic path should use that preference remains a requirement question; this patch does not redefine that policy.

The completed migration adds eight columns and updates **both** invoice RPCs from their actual kerdos-test definitions inspected on November 3. Existing authorization, mapping, quantity evidence, receipt fencing, atomic completion and duplicate handling are retained. Supplied quote identifiers are checked against organization/listing/document and the retained original values. Unperformed comparisons cannot carry a variance; compared rates must reconcile with variance. Historical invoices are not backfilled with invented quotes.

Validation completed locally:

- Full `npm test`, including existing application/database suites and the new `test:invoice-quotes` command.
- `npm run lint` and `npm run build`.
- Quote resolver: 37 actual assertions. Removed a blocked persistence placeholder that the handoff previously counted as a passing check.
- Invoice matching: 12 checks, including an identity-approved interactive-only example and caller wiring.
- New JavaScript + PostgreSQL integration: 18 checks of both RPCs, persistence/reload, zero/negative variance, missing/failed lookup distinction, source ownership, atomic rejection, role access, and replay preservation after later price changes.
- Existing atomic invoices: 30 checks; PDF: 16; image OCR: 9. These previously blocked suites executed using already-installed dependencies.

PostgreSQL integration uses PGlite with the real RPC definitions and an isolated synthetic schema. It is database evidence, not hosted Supabase acceptance or independent-session concurrency proof. The migration has not been applied to kerdos-test; frontend/worker deployment and signed-in report acceptance remain open. The existing PR56 report preview has now been integrated locally with the retained evidence; hosted and signed-in report acceptance remain open.

Release order: recheck deployed RPC drift; apply the additive migration to kerdos-test; verify schema and rolled-back fixture persistence/reload through both writers; deploy the matching frontend and process-attachment bundle; check the authenticated report. Existing clients may omit the new optional fields during this transition.

Rollback: restore the prior frontend/worker and prior RPC bodies from the pre-change baseline; keep the additive columns and any saved evidence. Do not drop evidence columns or rewrite historical invoice rows as a rollback shortcut.

## Report integration

The Price Variance Report button now opens the existing movable preview pattern before export. Every client vendor is retained. A vendor with compared zero-variance lines shows “0 variances found”; one without completed comparisons says so explicitly. Uncompared lines and their reasons remain visible beside zero and nonzero results. The report shows the exact retained quote and document metadata, source row, original versus converted rate/basis, invoice file/date/number and a link to the stored original where available. Legacy missing evidence stays unavailable.

Full organization history is read in bounded pages; related source metadata is read with organization/listing/vendor checks. Report loading errors cannot masquerade as clean zero results. Stale responses after a client switch are ignored. CSV exports the same selected date range and all comparison outcomes, including vendors without comparisons. Line impact uses stated billed quantity exactly once; it is unavailable when that quantity is absent. Basket markup remains byte-identical to the earlier commit.

Additional validation: nine report model/service scenarios, two rendered report workflows, existing imported-document/reconciliation checks, full npm test, lint and production build passed. Independent-session concurrency remains unexecuted here because no loopback PostgreSQL server is available. GitHub publication was blocked by automatic approval review pending explicit user authorization; no alternative publication route was attempted.
