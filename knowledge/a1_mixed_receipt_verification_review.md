# A1.2 — mixed CSV + PNG receipt verification

## Current state — hosted synthetic PASS

Dino explicitly approved deploying the scoped, expiring runner for this fixed mixed receipt, running it, then retiring it immediately with application functions unchanged. Supabase request **455**, HTTP200, passed **all 10 deployed assertions**. Runner v15 was immediately retired to v16: unconditional410, gateway JWT restored, no credential/data access. Retirement was verified from deployed source; it is not a deletion.

The earlier automatic approval rejection is historical and superseded by that explicit approval. No bypass occurred. Application versions and deployment hashes were checked before/after and stayed identical: inbound-email v6, process-attachment v13, image-text v3. No schema or frontend changes.

Receipt `73904e71-b920-401e-9175-fb332c0ee4f2` contains the PNG first and CSV second. CSV attachment `b9a37935-0785-448c-8bf8-76e73502b37f` automatically completed source document `f9eaf4f7-5f64-4649-b1d2-70c4ec99ea12`, keys row:0/row:1, exactly **41.25 and 51.75 per CASE** with correct filenames. PNG attachment `a1f11a55-5d48-4fea-94bd-66fe3212521c` ended in needs_review with no document or false price. Both originals byte/SHA256-match the fixed inputs (PNG2905bytes, CSV114bytes).

Identical message replay preserved every receipt, attachment, source document, quote and vendor-item ID/value/state and both original hashes. Existing vendor items were reused; database inspection confirms the same two item mappings remain present. No client action or new email send. Machine evidence: `scripts/fixtures/mixed/hosted-results.json`.

This closes the controlled hosted mixed CSV+PNG interaction check. It is **not new real-email mixed delivery** or a new browser-closure observation. Whole Task1 remains open pending reconciliation of its remaining governing checks; forwarding stays optional.

## Fixed executed check

One fixed Postmark-shaped message, `a1-mixed-csv-png-20261028-001`, sent to the existing isolated test route through `inbound-email`:

1. `incidental.png` first: existing nonpricing PNG fixture.
2. `mixed-prices.csv` second: Chicken Breast / code12345 /20LB /CASE /41.25 and Turkey Breast /code12346 /20LB /CASE /51.75.

Expected: one receipt, correct immutable vendor/type, PNG terminal exception with no false prices/document, CSV automatic completion with exactly two named source quotes, both originals matching fixture bytes/SHA-256. Replay the identical message and require identical receipt/attachment/document/price/item IDs, values and terminal states.

The fixed target is kerdos-test `gwtnaudjfoxjermhvhpx`, isolated organization `ab0f7ada-83ad-43eb-a513-6a8c5bd43a09`, fixture vendor `110e43fc-5788-47c2-ad9d-21b18a28be80`. Normal customer data is outside the check.

## Confirmed schema

Inspected `information_schema.columns` before writing queries. Uses `inbound_messages`, `inbound_attachments`, `import_documents`, `price_history`, `vendor_items`. Attachment names/paths are `filename`/`storage_path`; document names/paths are `file_name`/`file_path`. No `import_attachments` table is assumed. HTTP 200 is only receipt acceptance; database terminal states and exact saved values decide success.

## Run without deployment

`node scripts/verify_a1_mixed_receipt.mjs`

Requires environment-only `SUPABASE_URL` (must equal kerdos-test), `SUPABASE_SERVICE_ROLE_KEY`, `POSTMARK_WEBHOOK_USERNAME`, `POSTMARK_WEBHOOK_PASSWORD`. Do not paste credentials into chat, commit them or print them. The CLI prints evidence and exits nonzero on failure. No direct process-attachment invocation is used.

Those credentials are not available locally; approved execution used the fixed server-side runner instead. The fixed MessageID already exists now: rerunning the direct CLI intentionally fails its fresh-fixture precondition. Use retained evidence for this completed run.

## Approved temporary runner — retired

`scripts/a1-hosted-mixed-receipt.ts` archives the exact fixed, expiring runner used after approval. It used existing server-side credentials to submit only the fixed message and inspect only its isolated fixture data. It accepts no caller-supplied payload, IDs, destination or credentials. A POST shared-secret check is enforced; gateway JWT would be disabled only while that diagnostic is active because the caller uses the existing recovery secret, not a JWT. The risk is briefly enabling a privileged service-role diagnostic endpoint, even with those constraints.

Completed: deployed only diagnostic v15, invoked once, recorded results and immediately retired to unconditional410 v16 with gateway JWT restored and no secret/data access. Application functions stayed unchanged. Retired diagnostic deletion is separate housekeeping.

## Local quality evidence only

`node scripts/test_a1_mixed_verifier.mjs` — **10/10** checks passed using mocked HTTP: expected single mixed receipt + exact replay; rejected HTTP error, schema/query error, wrong ownership/type, pending PNG, wrong price, altered original, replay duplicate, false PNG price, and wrong environment/missing credentials. Direct CLI missing-environment run exits1. Fixed runner and CLI syntax/bundle checks passed.

These tests establish that the verifier rejects incorrect outcomes. They do not establish deployed ingestion behavior. Hosted results are recorded separately above; local quality tests alone were not used to close the hosted check. No new email send is needed for this synthetic check.
