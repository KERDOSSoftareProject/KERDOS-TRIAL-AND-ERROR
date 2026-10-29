# A1.2.h automatic image reader — deployment review

Status: deployed and verified on kerdos-test after Dino explicitly approved staged
conditional deployment. Hosted reader checks passed before the attachment worker
was updated. Current versions: image-text v3 and process-attachment v12. The first
deployment attempt had been rejected by approval review; the subsequent explicit
approval resolved that blocker. No production project was changed.

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

- English upright PNG/JPEG, single-frame PNG; no scanned-PDF or HEIC claim.
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

The staged hosted acceptance below passed. Other A1.2.h formats and live delivery
claims remain separate; this does not close all of Task 1.
Rollback of the importer means redeploying the known-good v10 source; no schema
rollback is involved. The new helper is never callable using a client user token
because the handler additionally requires the exact service-role bearer value.


## Hosted acceptance (synthetic; not real email)

- Reader request422: actual PNG and JPEG, eight sections, exact codes12345/12346,
  CASE units,40/50 prices, source confidence above95; malformed input422.
- Expanded reader request428: PNG/JPEG plus blurred source image,12 sections,
  all passed. Visible unreadable ink produces explicit zero-confidence source
  evidence; the later50.00 row remains readable. Timings are wall time, not CPU.
- Initial import request424 exposed missing quote-history filename; grouping now
  carries the original name. No historic probe rows were edited to simulate a pass.
- Final import request429 posted one fixed Postmark-shaped synthetic payload twice.
  PNG document9f18b294-c576-4a8b-ae21-fb9f368e1b43 and JPEG document
  a59cc3be-28c0-4eae-afd5-c420eb38d4a9 each completed with exactly2quotes.
  Every quote retains its filename, original Storage path and row key.
- Blurred image document7beb2c0f-4f5d-4f17-96e0-a074bf80dbe7 saved the readable
  turkey row at50.00 and stayed partial with one quote and an explicit unreadable
  source reason. Unreadable content cannot silently disappear from final status.
- Nonpricing PNG stayed retained/flagged with no import document and no prices.
- Exact delivery replay created no extra message, attachment, document or quote.
- Recovery request430 reprocessed the complete PNG and partial blurred image;
  same document links and quote counts were preserved, and uncertainty stayed open.
- Requests431/432 rejected missing/invalid helper authentication with401.
- Deployed source comparison: all3 helper files and40 processor files matched.
- Temporary fixed-fixture verifier retired to JWT-protected unconditional410, no
  database/credential access. Deletion housekeeping is separate (no delete tool).
- Final local validation:9actual OCR checks,14worker checks,full npm test/lint,
  production build and Edge entry-point bundling. No new secrets or migration.

Original images and recognized text are retained; no client upload, selection,
Save or completion action was used. The test was backend synthetic intake; it
is not fresh real-email delivery or independently observed browser-closed evidence.


## Image invoice acceptance

- Request434: low-confidence invoice image correctly stayed needs_review before
  any invoice/document write. This is a guard pass, not a successful import.
- Request436: clear one-line invoice image imported automatically and exact
  delivery replay returned200 without a duplicate. Document
  721faf46-07af-4113-ac58-48ca37f942b6 is complete. Invoice123456789 dated
  2026-10-28 has one line2 CASE ×40.00=80.00, retained original invoice.png,
  explicit pricing-unit-header billing evidence and the same source-document link.
- The 9 local OCR checks include actual image→invoice preparation, plus the
  low-confidence invoice fixture; confidence thresholds were not weakened.
