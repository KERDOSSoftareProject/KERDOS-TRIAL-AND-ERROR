# A1.2 — automatic PDF ingestion

## Deployed to kerdos-test; scoped acceptance passed

PDF attachments now enter the same background price-sheet and atomic invoice pipeline as CSV/XLSX and images. A client does not select a vendor/type, open a browser, upload, save, or complete an import. The immutable receiving-address context remains authoritative.

The new service-only `pdf-text` function reads one bounded PDF page per call using pinned `@hyzyla/pdfium@3.0.0` (MIT wrapper, PDFium). It extracts positioned embedded text and reconstructs columns. Side-by-side Product/Price tables remain separate. Pages with images, unmapped text, rotated glyphs or no text are rendered to PNG and passed through the existing hosted `image-text` OCR service. A text header cannot hide scanned rows below it. PDF scripts and links are not executed or followed.

Existing source-confidence, billing-unit, identity, arithmetic, row-hold, duplicate, lease and atomic invoice checks apply. All pages are read before any document/price/invoice write. A temporary later-page failure retries the attachment without saving a falsely complete document. Original source bytes/path/name remain in the existing retention path.

## Local evidence

- 16/16 executed PDF checks: actual PDFium on two text pages, side-by-side lanes, scanned sheet and invoice, mixed text/image pages, retained invoice number/date and explicit CASE evidence, atomic importer handoff (2 × 40 = 80), unreadable-region preservation with a later valid row, nonpricing document, password/corrupt/excessive-page rejection, lost lease, transient/permanent failure split, incomplete responses, failure before writes concurrent request isolation and fresh engine recovery after a failed raster attempt.
- 15/15 attachment worker checks, including PDF adapter → price writes with original filename.
- Existing 9/9 actual PNG/JPEG OCR checks remain passing.
- Full `npm test` (including lint), production build and `git diff --check` passed.
- Fixtures are committed under `scripts/fixtures/pdf/`; checks run in `scripts/test_a1_pdf.mjs`, included in `test:a1`.

These are local executed tests with in-memory write adapters. They are not deployed database, real-email PDF delivery or independently observed browser-closure evidence.

## Deployment sequence

1. Deploy **only `pdf-text`** to kerdos-test `gwtnaudjfoxjermhvhpx`, with gateway JWT verification enabled and exact service-role Bearer authorization enforced by its handler.
2. Run hosted fixed-fixture probes: both text pages, side-by-side source, scanned price sheet, scanned invoice, corrupt/password source, missing/wrong auth. Check embedded columns and rendered PNG output against fixtures; send rendered page through the existing OCR function. Runtime compatibility, 256 MB memory and per-request CPU limits must be established by hosted success; local timing is not hosted CPU evidence.
3. Only after helper probes pass, update `process-attachment` with this source and its relative dependencies. `image-text`, `inbound-email`, `recovery-sweep` and database schema need no changes.
4. Submit controlled Postmark-shaped synthetic PDF attachments to the existing isolated fixture organization through `inbound-email`; verify saved values, original names/bytes, complete vs partial state, duplicate delivery and same-document recovery. Keep real-email transport evidence separate. No additional email send is required for these checks.
5. Record hosted evidence before merging/closing the scoped PDF gate. Keep whole Task 1 open until its governing checks are met.

## Bounds and dependencies

- Source ≤5 MiB, 1–20 pages, ≤50,000 extracted characters per page.
- Scanned output ≤4 million pixels, 2400 wide/4000 high, up to 2× scale. Oversized physical pages requiring downscaling below 1× are visible exceptions.
- ≤24 combined PDF page/OCR band calls per attachment, reserving room below the hosted nested-call limit. Longer scanned documents remain retained exceptions; no silent page truncation.
- English OCR with existing confidence ≥90 policy. Password-protected/corrupt/over-limit PDFs remain visible source exceptions. HEIC remains outside scope.
- PDFium's pinned WASM is fetched from `https://cdn.jsdelivr.net/npm/@hyzyla/pdfium@3.0.0/dist/pdfium.wasm`, SHA-256 `beeaf5bbff216d555fecec7cd486072838c4632a2272d31b52ef1fd05008fe7c`. Only the engine asset is downloaded; document bytes never go to that CDN. Missing/altered engine assets cause retryable errors, not accepted imports.
- No paid OCR provider, AI API, new account, secret, migration, client UI or routing heuristic.

## Rollback

Until worker deployment, the helper is unreachable from normal intake. After worker deployment, redeploy the PR #18 worker source from `69747b3254f8f5300a7f18180c8472a0e74f19ac` (processor v12 baseline). PDF sources return to retained unsupported exceptions; CSV/XLSX/PNG/JPEG paths stay at their prior baseline. Remove/retire the new service helper separately. No schema rollback is involved.

## Approval and hosted outcome

Dino explicitly approved PR #19 deployment: deploy the PDF helper first and update the attachment worker only if hosted PDF checks pass. That sequence was followed.

- `pdf-text` **v1** ACTIVE, JWT + exact service-role auth. Its three deployed source files match approved source `20e8d37d42dae5076c9d150ad7b43c348d408c9a`.
- Hosted helper request **446**, HTTP 200, passed before worker update: two embedded-text pages, independent side-by-side tables, scanned price sheet and invoice through real hosted OCR, unreadable region retention, password/corrupt rejection (422), and missing/wrong/anon Bearer rejection (401).
- `process-attachment` **v13** ACTIVE only after that pass. All **42** deployed source files match approved source. No changes to image-text, inbound-email, recovery-sweep or schema.
- Synthetic price webhook request **448** posted identical payload twice, both HTTP 200. Text PDF document `58d9abe5-b14c-40e8-8ca1-d25e4a68f752` and scanned PDF document `836dec51-8684-43ad-8973-b928d87b2ccc` each completed with exactly two quotes, **40 and 50 per CASE**, original filenames retained in all four history rows.
- Blurred PDF document `44c48d6c-7c4d-4358-9d5b-eaaeac24046b` saved its readable **50** quote and remained partial with an explicit unreadable-source flag. Nonpricing and encrypted PDFs retained originals, created no document/quote, and exposed specific exception reasons.
- Synthetic invoice webhook request **449** repeated the same payload, both HTTP 200. Text invoice `c4c75cc0-0a60-4b31-8c3d-e6911cf6ac63` (number `PDF-123456789`) and scanned invoice `80830c18-2047-4be0-8ec7-36b47d972136` (number `123456789`) each saved one line **2 CASE × 40 = 80**, explicit Price Unit billing evidence, date 2026-10-28, original PDF and complete source document. Exactly two invoices/two lines after replay.
- Recovery request **450**, HTTP 200, replayed the complete scanned sheet and partial blurred sheet. Same document IDs, 2/1 quote counts and complete/partial states remained. This is an explicitly triggered recovery check, not a new scheduled/browser-closed observation.
- Isolated fixture vendor `110e43fc-5788-47c2-ad9d-21b18a28be80` has exactly **2 vendor items / 2 catalog mappings / 5 source documents / 2 invoices / 2 invoice lines**. All **7 originals** retained. No real client organization or existing receipt assignment changed.
- Temporary fixed-fixture runner `a1-review-fixture-seed` retired as **v14**, unconditional **410**, gateway JWT restored, no imports/secret/data access. It is retired, not deleted; deletion remains housekeeping.

Full machine-readable evidence: `scripts/fixtures/pdf/hosted-results.json`. Fixed probes archived in `scripts/a1-hosted-pdf-check.ts` and `scripts/a1-hosted-pdf-import.ts`. All document payloads are synthetic; no new email sends or client actions. Do not label this real-email PDF delivery. Task 1 remains open beyond this scoped PDF acceptance; optional forwarding is not a core ingestion blocker.
