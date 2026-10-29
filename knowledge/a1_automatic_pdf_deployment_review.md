# A1.2 — automatic PDF ingestion

## Change ready for staged kerdos-test deployment

PDF attachments now enter the same background price-sheet and atomic invoice pipeline as CSV/XLSX and images. A client does not select a vendor/type, open a browser, upload, save, or complete an import. The immutable receiving-address context remains authoritative.

The new service-only `pdf-text` function reads one bounded PDF page per call using pinned `@hyzyla/pdfium@3.0.0` (MIT wrapper, PDFium). It extracts positioned embedded text and reconstructs columns. Side-by-side Product/Price tables remain separate. Pages with images, unmapped text, rotated glyphs or no text are rendered to PNG and passed through the existing hosted `image-text` OCR service. A text header cannot hide scanned rows below it. PDF scripts and links are not executed or followed.

Existing source-confidence, billing-unit, identity, arithmetic, row-hold, duplicate, lease and atomic invoice checks apply. All pages are read before any document/price/invoice write. A temporary later-page failure retries the attachment without saving a falsely complete document. Original source bytes/path/name remain in the existing retention path.

## Local evidence

- 15/15 executed PDF checks: actual PDFium on two text pages, side-by-side lanes, scanned sheet and invoice, mixed text/image pages, retained invoice number/date and explicit CASE evidence, atomic importer handoff (2 × 40 = 80), unreadable-region preservation with a later valid row, nonpricing document, password/corrupt/excessive-page rejection, lost lease, transient/permanent failure split, incomplete responses, failure before writes and concurrent request isolation.
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

## Review boundary

Dino's earlier review-before-deploy instruction applies to new code. His explicit staged deployment approval for PR #18 is completed and is not recorded as approval for this new PDF change. This PR is concrete and locally verified for review; no PDF function or worker deployment has occurred in this change.
