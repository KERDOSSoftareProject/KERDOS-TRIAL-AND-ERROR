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

The tabular parser studies the layout before assigning fields. `identifyRowFields` binds each assigned field to the supplied row and column, preserves its raw value, and records whether the role came from the header, a remembered answer, or inference. The description anchor distinguishes identified, inferred, missing, and ambiguous cells. Repeated table headers supply fresh evidence and side-by-side blocks retain their column offsets.

The tabular parser retains a priced observation with a missing or ambiguous description and preserves its other assigned fields. The existing draft #192 import guards retain that observation for review, keep it out of quote and catalog writes, and let valid neighbors save. Retrying an older background import with unverified row positions stays in review.

B5 owns validation. The existing numeric, unit, and pack checks still run after B4 field placement. Source readers and geometric structuring still supply the input, and their provenance remains attached. Grouping and purchasing use their existing rules.

## Verification and remaining work

- Field-binding checks cover raw values, evidence origins, reordered and repeated headers, wrapped cells, ignored columns, and missing or conflicting description roles.
- Existing manual upload and background attachment checks cover held rows, valid neighboring rows, and safe retries.
- Review of the B5 draft #131, hosted verification, and signed-in acceptance remain open. Any release must coordinate the web app and the attachment worker, which share the parser.

## Other responsibility boundaries

C.1 should share separate description, pack and semantic helpers. C.2 should distinguish group identity from purchasing comparability. C.3 should distinguish proposals, confidence and decisions. D keeps field repair and group review separate on the same screen. E persists decisions rather than interpreting source fields again. F consumes field evidence once for readiness. G separates quotation ranking, basket optimization and order recording. These wider refactors remain planned.

## Earlier retained B3 observations

The screenshot labelled `B3 LAYOUT VERIFY — disposable` and `Saved incoming rows · 12 not yet linked` shows retained observations from an earlier structuring test. It is not a new grouping-trial result. Preserve those records. A recognizable product description, a unique supplier-listing identity, group membership and valid purchasing fields are separate questions. A separate D1.7 task tracks clearer review reasons and source inspection; this branch does not delete, hide or reassociate the old fixture rows.
