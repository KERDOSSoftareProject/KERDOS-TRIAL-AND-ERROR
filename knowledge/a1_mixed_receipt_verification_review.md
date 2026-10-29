# A1.2 — mixed CSV + PNG receipt verification

## Current state

Prepared and locally checked; **hosted check has not run**. No application function, database schema or frontend code changed. No test message was submitted and no ingestion check can be closed from this work.

Automatic approval review rejected deployment of the temporary fixed-fixture runner because the earlier no-deployment instruction remained active. It also rejected the follow-on invocation. The rejected runner has NOT replaced the retired function. No bypass was attempted.

## Exact proposed check

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

Those credentials are not available in this local environment. No live execution claim is made.

## Optional temporary runner requiring explicit approval

`scripts/a1-hosted-mixed-receipt.ts` is the concrete fixed, expiring runner that was rejected before deployment. It would use existing server-side credentials to submit only the fixed message and inspect only its isolated fixture data. It accepts no caller-supplied payload, IDs, destination or credentials. A POST shared-secret check is enforced; gateway JWT would be disabled only while that diagnostic is active because the caller uses the existing recovery secret, not a JWT. The risk is briefly enabling a privileged service-role diagnostic endpoint, even with those constraints.

If approved: refresh its short expiration; deploy only the diagnostic runner, invoke it once, record results, then immediately retire it to unconditional410 with gateway JWT restored and no secret/data access. Application functions stay unchanged. Retired diagnostic deletion is separate housekeeping.

## Local quality evidence only

`node scripts/test_a1_mixed_verifier.mjs` — **10/10** checks passed using mocked HTTP: expected single mixed receipt + exact replay; rejected HTTP error, schema/query error, wrong ownership/type, pending PNG, wrong price, altered original, replay duplicate, false PNG price, and wrong environment/missing credentials. Direct CLI missing-environment run exits1. Fixed runner and CLI syntax/bundle checks passed.

These tests establish that the verifier rejects incorrect outcomes. They do not establish deployed ingestion behavior. Task list remains v57 and the mixed-receipt hosted check remains open. No new email send is needed for this synthetic check.
