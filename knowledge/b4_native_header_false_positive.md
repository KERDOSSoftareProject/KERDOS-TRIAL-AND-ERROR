# B4 — native table boundary false positive

## Confirmed failure

The November 1 Chrome companion delivered the supplier CSV to the shared import
review with the selected vendor/account/list. That receipt is transfer evidence,
not proof of saved catalog prices.

Replaying the retained 16,165-byte CSV through the production reader, table
structuring and field identification reproduced the review error. Reading retained
88 native rows: one heading row and all 87 products. Direct parseDocument returned
87 products. The native worksheet segmenter returned two tables and the composed
parser returned 85 products.

The segmenter accepted a single cell as both description and price heading. The
brand at product 85 contains PRODUCT, which matches description's product alias
and price's short pr alias. worksheetSegments split the table at product 85;
findHeaderRow then chose product 86 as the second table's heading. This explains
the displayed numeric headings without assuming the reader lost a row.

The previous export regression called parseDocument directly. It did not exercise
the native reader/segmenter used by the real upload. That coverage gap is closed.

## Targeted change

Reuse the existing parser's repeated-header safeguards in a shared isTableHeader
predicate. Description and price must occupy separate cells. Neither the
candidate price-heading cell nor the established table's price cell may contain
a parsed amount. Zero and price/unit amounts count as data.

The worksheet segmenter retains the active confirmed heading map and applies
this predicate before starting another table. It no longer repeatedly evaluates
prior product rows as possible heading evidence. Genuine repeated headings,
reordered tables, independent worksheets and PDF table detection remain enabled.
No client, account, vendor or list identifiers are part of the rule.

## Verification

- Real-source composed CSV replay: 87 products, one table, 522 field comparisons
  with zero mismatches after trimming exterior whitespace, numeric price parsing
  and empty-unit normalization. Item numbers, descriptions, brands, packs, prices
  and selling units retain their source meaning. Only the five actual metadata
  column headings require the existing layout confirmation.
- Retained 347-row controlled PDF: all 347 source proofs match the saved snapshot
  exactly, including row keys, source lines, twelve values, billing-unit evidence
  and page/table/line/cell positions. Hosted read-only evidence still records
  335 completed keys and 12 unresolved observations. No replay writes were made.
- Synthetic export regression now uses the real native reader and composed
  parser, including the adversarial product brand. Separate tests cover numeric
  price, zero, price/unit values and genuine repeated/reordered native headings.
- Rendered production importer regression checks that the 87-row companion file
  asks only about its five genuine metadata headings and advances to an 87-row
  read-only preview. Persistence remains mocked in this test.
- Full npm test (including lint) passed; 23 rendered upload checks and 16 B3
  structure checks passed. Production build and GitHub Pages base-path checks
  passed. The existing bundle-size warning remains.

The installed companion does not need changing for this parser repair. After
publication, a fresh browser transfer and explicit save are still required for
live retained-original, quote/catalog and ownership acceptance. This does not
complete universal browser delivery, unattended retrieval or MFA automation.

The actual test organization is KERDOS TRIAL AND ERROR; the portal account label
is Hornets Nest Deli. Those are distinct facts. Existing organization records
were not renamed or reassigned to make the pilot label match.
