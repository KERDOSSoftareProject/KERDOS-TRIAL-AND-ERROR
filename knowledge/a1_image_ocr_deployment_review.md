# A1.2.h automatic image reader — deployment review

Status: implemented and locally tested; NOT deployed. Automatic approval review
rejected the first kerdos-test deployment because the earlier review-before-deploy
instruction was still considered active. No existing deployed worker was changed.

## Behavior

PNG/JPEG attachments stay in the original Storage path. The existing attachment
worker calls a same-project, service-role-only `image-text` function in bounded
200-pixel sections with overlap. Reconstructed lines feed the existing parser;
client/vendor/type still come exclusively from receipt snapshots. No browser,
upload, vendor selection, Save, external OCR account, or paid OCR API is required.

The current attachment lease is renewed before each section and after extraction.
A lost lease, temporary outage, or incomplete response stops before import writes.
Unsupported, corrupt, animated or oversized sources remain visible exceptions.
Logos are not discarded by name; an image with no parsed product rows creates no
price entries. Original bytes and recognized text are retained.

Each parsed row retains OCR engine and source confidence. Header/row evidence
below 90 holds that row without accepting its incoming quote. Later supported
rows can still save. Invoice image evidence is checked before atomic recording.
OCR confidence is an engine estimate, not a measured guarantee of field accuracy;
existing identity, unit, arithmetic, price, duplicate and lease checks still apply.

## Scope and limits

- English PNG/JPEG, single-frame PNG; no scanned-PDF or HEIC claim.
- At most 5 MiB compressed, 4 million pixels, 2400 wide, 4000 high.
- No automatic correction of characters, units, vendors or document types.
- Pinned Tesseract core 7.0.0, upng-js 2.1.0, jpeg-js 0.4.4; lockfile retained.
- Existing KERDOS-hosted English language asset is SHA-256 checked before use.
- Supabase's hosted runtime has a 2-second CPU limit and 256 MB memory limit:
  https://supabase.com/docs/guides/functions/limits
- A local full-page probe used 5.75 seconds CPU for 80 rows. A separate 25-row
  probe processed all rows across six sections, each about 0.38–1.08 seconds CPU.
  These are Node measurements, not deployed Edge-runtime acceptance evidence.

## Local validation

- Actual PNG and JPEG text → existing parser: exact codes, CASE units, 40/50 prices,
  both rows preserved across section boundaries, source confidence at least 90.
- Nonpricing image: no product or price rows.
- Lease loss prevents OCR calls; temporary failures retry and corrupt inputs flag.
- Malformed, excessive dimensions, wrong section and incomplete responses reject.
- Importer: confident image rows save automatically; uncertain-first row is held
  while the later valid row saves; recognized text and OCR provenance retained.
- Existing worker regression suite and full npm test including lint pass; build
  and Edge entry-point syntax/bundling pass.

## Proposed test deployment

1. Deploy `image-text` to kerdos-test with verify_jwt=true and exact service-role
   handler authorization; no new secrets or schema migrations.
2. Run a controlled same-project PNG/JPEG extraction against the hosted runtime.
   Measure limits and validate every source row and field; do not use real email.
3. Only after that succeeds, deploy the updated process-attachment worker.
4. Run original → catalog/qualified quote and duplicate/recovery checks using
   controlled retained originals, including uncertain and nonpricing images.
5. Record local, hosted extraction, and deployed importer evidence separately.

If runtime acceptance fails, retain current deployed worker and keep A1.2.h open.
Rollback of the importer means redeploying the known-good v10 source; no schema
rollback is involved. The new helper is never callable using a client user token
because the handler additionally requires the exact service-role bearer value.
