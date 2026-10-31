# B3 retained-document layout checks

Baseline: main through PR #31, merge `aaf4b8300bdc070d9ac1ad01aaf5049c34bd1928`. This work is local and read-only against retained private source documents. No customer document, private manifest, full extracted contents or screenshot is included in this repository.

## Demonstrated failures

- A two-page invoice had five genuine product lines and an explicit customer-copy page. Before this draft, structuring returned eight non-product rows from minimum-order notices, service charges and footer text, while missing the five genuine products. Compact U/M and pack headings were merged; a fixed-width PDF text item spanning quantity/unit/pack was assigned as one cell. Later non-product sections polluted header/delimiter inference.
- A five-page, two-column price sheet retained a plausible row count while assigning centered prices to wrapped description fragments or combining adjacent product names. Counts alone did not prove correct pairing.
- A retained vendor workbook supplied 157 source product codes and prices as a preservation control.

## Changes

Preserve the PDF reader's font-family evidence. Split a native text item across established columns only when its source font is explicitly monospace, retaining original text, transform and character spans. Keep compact U/M and pack headings separate without declaring U/M a billed-price unit. Use tab separation for cells already established by B3 instead of sniffing a new delimiter from their sparse serialization.

Keep long descriptions in their column until the next heading boundary. In two-column product/price tables, associate description words with the nearest vertically centered price, retaining unmatched content. Exclude explicit category headings and non-product stock/balance/footer sections; a subsequent explicit product header can start another table.

Deduplicate repeated invoice page rows only when invoice identity and every retained line value match, and an explicit large customer/office/merchant copy watermark is present on one page. Preserve duplicate-page provenance on the retained rows. Identical unmarked pages, changed values or different invoice identities remain separate.

## Local evidence

| Source/check | Result |
| --- | --- |
| Retained two-page invoice | 5 genuine lines, exact codes/quantities/packs/prices/extended amounts; 1 explicit copy page linked as provenance; no footer products |
| Retained five-page price sheet | 342 product rows, page counts 83/75/79/79/26; selected wrapped labels and exact prices checked |
| Independent PDF inspection | pdfplumber found 343 monetary cells in printed price lanes, including one fuel surcharge; parser product count excludes that non-product charge |
| Retained workbook | All 157 source product codes and numeric prices checked against source cells |
| Repeat parsing | Deterministic and source-reading objects unchanged |
| Regression tests | 14 existing B3 + 6 new layout regressions; rendered upload checks; full npm test including lint; production build |

No billing unit is inferred from pack, ordered U/M, weight or arithmetic. In particular, this is invoice *structuring* evidence, not proof that the retained invoice is eligible for automatic billing acceptance. Service charges remain in the retained original; invoice header/fee-total acceptance is outside this parser-only check.

Run the private source acceptance with:

```bash
node scripts/verify_b3_retained_sources.mjs /absolute/path/to/private-manifest.json
```

The private manifest supplies source SHA-256 fingerprints, expected counts/page counts, independently reviewed product fields and forbidden non-product descriptions. Keep that manifest and source documents outside git. This command performs no network, application, database, storage or scheduler writes.

## Acceptance limits

No deployment or hosted/browser/database acceptance of this draft is claimed. Existing controlled B2 acceptance remains recorded separately. B3 stays open until review, deployment and appropriate live verification. A successful finite source set does not establish universal document recognition.
