# B2/B3 — Mixed PDF OCR geometry correction

Baseline: main `6f25975fde492ba40b9121a536437f3e70e6c01e` / PR #29.
Scope: manual PDF reading/structuring, not Module A worker or database changes.

## Observed failure

Dino uploaded the diagnostic mixed PDF after the local failure had been recorded.
Actual kerdos-test document `cc7bdadc-8181-4d9f-8c44-d5d065a2f8df` saved both rows.
Native page1 retained code730001, 20 LB, CASE, 46.75. Scanned page2 fell back to
freeform and retained description730, missing code/pack/unit, candidate price2,
amount57.85. The document is complete under the manual path's retain-with-issues
contract; that status is not evidence that every field was read correctly.

The bad item `12f35ab6-f1ac-444b-8429-30ad069ae0f7` is price_unavailable=true,
reviewRequired=true, with no price_basis/unit/pack. It did NOT create a price
history quote. Only native row0 created quote `1dad9622-fec5-49da-8b33-90d7bc856182`
at46.75 on item `c8a96cf1-00af-428f-9893-423b440c3a6e`. Original object
`2aacdcae-31b9-49dd-865a-a36e9066d132` is retained (actual uploaded metadata
size78828 bytes). No database repair, deletion or backfill is included.

## Cause and fix

OCR word boxes end at different glyph heights. In the captured header, Description
ends at pixel242 while the other header words end at234. Treating every box bottom
as a common baseline split this one header into two rows, preventing table mapping.
OCR words can now join a line when their vertical boxes overlap by at least half
the smaller height. Native PDF baseline grouping stays unchanged. Original OCR
coordinates/confidence remain unchanged. Separate product lines remain separate.

The freeform money tokenizer also matched the trailing002 inside730002 and treated
it as price2. It now rejects monetary matches that begin inside another digit run.
This does not assign an item-code role or guess a billing unit.

## Executed evidence

- 6 new captured-real-OCR regressions: exact codes/pack/CASE/46.75/57.85;
  confidence retention; varying descenders; separate following product; deterministic
  non-mutating replay; and no fragment-of-code monetary price in freeform fallback.
- Actual local PDF.js render → Tesseract7 → production reader/structurer passes via
  `npm run test:b2-ocr`, with the retained two-page fixture and exactly one OCR call.
- 13 rendered manual-upload checks pass, including a new actual-capture path that
  sends exact46.75/57.85 to the importer while leaving the uncertain scanned row
  price-unavailable/review-required and retaining its page2/boxes/unit evidence.
- Existing 8 B2 reader checks and14 B3 structuring checks pass.
- Full `npm test` including lint, production build and `git diff --check` pass.

The scanned description/pack has genuine low-confidence OCR; its read text is
preserved and flagged, not replaced by fixture-specific corrections. No confidence
threshold bypass or guessed CASE is introduced. These new passing results are
LOCAL evidence; fresh deployed-browser acceptance remains open.

## Review/deployment and verification plan

Frontend only; no schema/Edge Function/Vault/scheduler changes. Review the diff
before deployment under Dino's existing preference. Rollback is redeploying PR29
main6f25975 without changing retained test records.

Preserve the failed live fixture as historical evidence. After approved deployment,
use a fresh controlled disposable vendor for this same retained PDF so completed
fingerprint protection does not bypass the new parser. Verify code730001/46.75 and
code730002/57.85, CASE and20-LB source evidence, retained OCR boxes/flags, original
and repeat protection. A still-uncertain row must remain unqualified. Do not delete
old data or overwrite history just to obtain a passing screenshot.
