# A2 export → importer interaction — local executed PASS

October29,2026. `npm run test:a2` now runs26 checks; the last four compose
the production export adapter with the actual source SQL in PGlite and the
production `processAttachmentInBackground`, parser, price importer, catalog
service and Order Guide assessment. No upload/Save component is invoked.

- Fresh downloaded CSV creates one vendor item, catalog item and mapping;
  saves80/CASE for4/10 LB; completes and links the source; retains exact bytes.
- Identical consecutive pull leaves one quote call, document, item and mapping.
- 80 → 90 → 80 produces three source documents/fingerprints and quote calls while
  preserving one vendor item/catalog mapping and all three original observations.
- Final identical replay remains stable. Unit cost returns to2/lb; the holding
  category remains the sole Order Guide blocker, with no fabricated approval.

HTTP/DNS, object storage and price/catalog database writes are test doubles.
This is local executed interaction evidence, not hosted persistence or real
vendor acceptance. The earlier approved actual-database rollback proof is
separate and unchanged in `a2_live_schema_check_results.json`.

The original A1 new-item regression uses the same extracted test persistence
fixture and remains passing. Full npm test (including lint) and production build
pass. The built controlled hosted CSV is byte-identical to its repository source:
SHA25648bd73af0ac95696ab75be1be7b6dd8c710935deac0f7cd4a0da3281b50d9151.

Next-stage exact scope: `a2_hosted_pull_deployment_review.md`. It is prepared,
not executed, and requires authorization beyond the prior rollback-only test.
