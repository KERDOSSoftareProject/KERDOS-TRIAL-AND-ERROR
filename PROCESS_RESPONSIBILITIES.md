# Shared processing responsibilities

Approved November 2, 2026. Existing Division I modules and task numbers remain. Automated and Manual Ingestion share the processing stages below.

| Stage | Owner | Output and boundary |
| --- | --- | --- |
| Source extraction | B.2 Document Reading | Original source, text, native cells and positions. No Item Catalog placement or grouping. |
| Physical structure | B.3 Document Structuring | Source-linked rows, cells and evidenced wrapped-line relationships. No field meanings or group decisions. |
| Sheet understanding | B.4 Field Identification | Header meanings, remembered column roles and inferred layout evidence, established before placement. |
| Field placement | B.4 Field Identification | Description-anchored row bindings, raw values and source-cell references. No grouping or value-quality validation. |
| Field validation | B.5 Row Extraction and Validation | Missing/uncertain fields, confidence and conflicts. No substitution, grouping or persistence. |
| Product grouping | C.4 Association Trial | Product identity candidates from the assigned description; listing brand/pack/price details remain independent. |
| Review and persistence | D Item Catalog / E Mapping | Separate field repair and membership review actions; E saves accepted decisions with audit and revision protection. |
| Purchasing readiness | F | Consume validation evidence for eligibility. A group does not prove every listing can be ordered. |

One source-linked listing provides continuity. Missing purchasing fields need not prevent an identifiable product from being grouped. A missing description remains an observation rather than becoming a brand-named item.

## B4 implementation checkpoint

`src/ingestion.js` previously chose a replacement description by taking the longest nonnumeric cell when the mapped description was blank. This could promote the brand column into the product description. The tabular row routine also combined binding, value interpretation and validation.

`identifyRowFields` now owns raw field binding using the studied column map. It exposes an identified, inferred, missing or ambiguous description anchor and same-row/cell evidence. It does not import procurement vocabulary, grouping, readers, persistence or purchasing logic. A separate B5 admission check, `requireItemDescription`, prevents a missing anchor from reaching quote/catalog/mapping writes.

The parser retains priced rows with missing descriptions and their original values. Manual import keeps them partial for review while processing valid rows. Automatic import treats a missing description as a held source observation, rather than an operational database failure, and continues valid rows. New automatic source documents retain the existing source-row proof format; existing proofs are checked, not overwritten, when resuming.

Source readers, geometric structuring, grouping rules, purchasing rules and the deployed application are unchanged by this prepared source branch. Legacy parsing of unlabelled descriptive details remains for compatibility; broader separation of interpretation/validation belongs to subsequent explicit tasks. No paid services or runtime AI calls are added.

## Verification and remaining work

- Full local `npm test` and production build passed. Existing SQL tests execute against local PostgreSQL fixtures; they are not hosted database acceptance.
- Focused checks cover reordered columns, long brands beside short descriptions, absent/ambiguous anchors, raw source bindings, repeated headers and wrapped cells provided by readers.
- Rendered manual import and actual automatic-import orchestration use mocked persistence to verify partial source retention, valid-row saves, replay safety and no brand-named product creation.
- Existing B3/B4/B5 tests cover structure, remembered/unknown headings, source proof and retained-row display.
- Reader, structuring, product-grouping and ordering source files were compared with the base commit and remain unchanged.
- Code is prepared for review. Hosted schema compatibility/write-path verification and signed-in acceptance remain open. Any eventual release must publish the frontend and shared `process-attachment` worker together; no new schema migration is included.

## Other responsibility boundaries

C.1 should share separate description, pack and semantic helpers. C.2 should distinguish group identity from purchasing comparability. C.3 should distinguish proposals, confidence and decisions. D keeps field repair and group review separate on the same screen. E persists decisions rather than interpreting source fields again. F consumes field evidence once for readiness. G separates quotation ranking, basket optimization and order recording. These wider refactors remain planned.

## Earlier retained B3 observations

The screenshot labelled `B3 LAYOUT VERIFY — disposable` and `Saved incoming rows · 12 not yet linked` shows retained observations from an earlier structuring test. It is not a new grouping-trial result. Preserve those records. A recognizable product description, a unique supplier-listing identity, group membership and valid purchasing fields are separate questions. A separate D1.7 task tracks clearer review reasons and source inspection; this branch does not delete, hide or reassociate the old fixture rows.
