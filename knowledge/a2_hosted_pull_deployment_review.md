# Task 2 — controlled hosted pull acceptance

Prepared for review; not executed or deployed. The previous approval covered
only the rollback database test and does not approve permanent deployment.

## Fixed target and source

- Only kerdos-test `gwtnaudjfoxjermhvhpx`; existing isolated fixture organization
  `ab0f7ada-83ad-43eb-a513-6a8c5bd43a09`, with no user memberships.
- Create a disposable vendor/source in that organization, not Dino's normal one.
- Operator-approved origin `https://kerdossoftareproject.github.io`.
- Fixed export path
  `/KERDOS-TRIAL-AND-ERROR/fixtures/a2/vendor-prices.csv`.
- Two controlled CASE prices: A2-HOSTED-001 Chicken Breast41.25 and
  A2-HOSTED-002 Turkey Breast51.75, each2/10 LB.
- This file is intentionally public synthetic data. Store only a generated
  disposable credential in Vault for the source. GitHub Pages does not validate
  that credential: this test cannot certify real supplier authentication.
  Local header/auth checks and actual Vault/permission checks remain separate.

## Proposed staged execution

1. Apply the reviewed Task2 SQL as a permanent test migration, without enabling
   a cron job or enrolling any active real-vendor source. Check schema, grants
   and advisors. The rollback test has already validated its database contract.
2. Deploy `vendor-price-pull` plus its exact relative auth dependencies to
   kerdos-test. Application A1 workers remain unchanged. Verify missing/wrong
   authentication rejection before any source enrollment.
3. Merge PR23 and let the repository's clean-install/test/lint/build/Pages
   workflow publish the controlled CSV. Verify the actual hosted fixture bytes
   before configuring its source; no owned email domains or email send needed.
4. Enroll only the isolated source with a generated synthetic Vault credential,
   issue one authenticated on-demand pull using the existing operations secret
   internally, and inspect its durable source receipt/attachment, terminal
   document and exact two saved prices/catalog links. Retain the original and
   keep unsupported qualification flags honest; no customer upload or Save.
5. Repeat the same source pull; compare receipt/document/item/mapping/quote IDs
   and values. There must be no additional price observations for an unchanged
   consecutive export. The A→B→A behavior has local composed and actual
   rollback-database evidence and is not claimed as a hosted HTTP test here.
6. After the pull passes, configure only the isolated test scheduler using the
   existing Vault operations-secret reference. Observe one scheduled due pull
   with no direct worker invocation. Then disable the disposable source and
   remove its credential; preserve receipts/originals for audit. Record request
   IDs, timing and results. Never return decrypted credentials in chat or logs.

## Scope and rollback

This is hosted synthetic vendor-export transport → existing worker → saved
catalog/prices acceptance, not a real vendor portal test, email delivery or a
signed-in browser observation. A real vendor still requires an authorized
export endpoint/credential and, where applicable, a vendor-specific adapter.

Rollback starts by disabling the new Task2 cron/source, then retiring/deleting
only vendor-price-pull. Preserve its receipts and original files. Do not restore
the routing-address NOT NULL rule while source_kind=vendor_pull receipts exist.
Existing A1 functions and the five-minute A1 recovery job are unchanged.

The concrete approval scope is permanent Task2 test schema/function deployment,
PR23 merge/fixture publication, isolated synthetic enrollment/on-demand/replay,
one scheduled observation and cleanup. It exceeds the earlier rollback-only
approval. No real vendor or production operation is included.
