# KERDOS v5 — September 27, 2026

This release implements the import/percentage improvements and the imported-document page cleanup. It builds on the reviewed v4 source. The 90% placement threshold has not been lowered.

## Deployment

1. Unzip `KERDOS_DEPLOY_v5_2026-09-27.zip`.
2. Open its `KERDOS_DEPLOY_v5_2026-09-27` folder. Upload the **contents** to the GitHub repository root, merging the folders and replacing the matching files. Do not upload the ZIP itself or its outer folder.
3. Commit and wait for the GitHub Pages workflow to finish. Refresh the app after deployment.

Repository: https://github.com/KERDOSSoftareProject/KERDOS-SOFTWARE-PROJECT-CHAT-CLAUDE

**No new Supabase migration is required.** This release uses the reviewed migration 015 that the owner reported running successfully. Do not run a reset script. The complete-source ZIP is the full application and handoff for future work; the deployment ZIP contains the changes from the supplied complete v4 source.

## Process and industry boundaries

The production engine contains no rules tied to Hornet’s Nest, a client name or a particular vendor. Unit extraction, field evidence, history reuse, invoice cross-checks, eligibility, diagnostics and resume checks are shared process rules. Food terminology is supplied only by the optional Restaurant profile. Existing construction/custom-unit behavior remains covered by the regression suite, and new tests verify automatic qualification of steel bolts, adhesive and rope with that profile disabled. Client information is a source of reusable learning: recurring column layouts, unit notation and pack shorthand become general parsing rules or industry vocabulary with regression examples. Item-specific prices, associations and remembered quote units remain scoped to their original vendor listing. Customer names and particular quotes never become global defaults. Customer documents provide replay evidence for these improvements. The replay command currently supplies the bundled Restaurant category vocabulary; the application uses the organization's actual categories and vocabulary.

## Implemented

- One shared field-evidence calculation for import preview, saved catalog and Order Guide eligibility. Source statements and client entries start at 90; independent matching trade identifiers can corroborate identity fields to 100. Contradictory original values lower confidence. Missing values stay blank.
- Explicit quoted units survive extraction from price cells (`$3.50/LB`), price headers (`Price per LB`, `Price (case)`), labeled price-unit columns and unambiguous document notes. Repeated table headers reset their unit. Contradictory units require review.
- Confirmed quote units can be reused for one uniquely matched, same-vendor NVIM as well as a printed vendor code. Product, physical pack, brand and stated identifiers must agree. Legacy null bases and invoice charges are not learned quotations.
- Consistent prior invoices can fill missing physical packs and brands, with source references. Their charges never replace prices. Billed units are suggestions only when the current quotation omits its unit; compatible case-versus-pound billing does not itself create a conflict.
- Restaurant pack descriptors such as `SLICING12LB`, `10 LB FRESH`, `7 LB IMP` and `8 LB DOMEST` are readable. Their qualifiers remain part of the pack comparison. Missing dimensions, extra pack components and fresh/frozen disagreements remain unresolved. CSV escaped quotes are read correctly.
- Numeric grades/count ranges such as `18/22`, `16/20` and `80/20` remain product details when unlabeled, rather than becoming inferred vendor item numbers. Explicitly labeled codes remain codes.
- Restaurant context recognizes preserved spreads, edible wraps, soup bases and cheese varieties without routing them by an incidental ingredient word. This stays in the optional Restaurant profile. Customer categories and brand-lock policy are preserved.
- The catalog has a compact expandable qualification count with specific blockers. Row Details shows why a row is held. The Order Guide uses the same eligibility checks, including current quotes, source conflicts and locked brands.
- Automatic placement failures are visible and have a retry button. Changed row evidence can be retried; automatic associations are recorded as rule based. An already verified catalog item can keep its customer name.
- There is no global market-price minimum/maximum that penalizes cheap fasteners or expensive industrial goods. Positive finite calculations, source discrepancies and compatible dimensions supply the universal checks.
- Client price changes are compared with the source even when migration 015 did not create a price field-resolution record. Import edits retain their original prices, and a later genuine quote replaces old amount-edit evidence.
- Resume still uses the fingerprinted file and row ordinal, with per-row checkpoints and migration 015's unique history index. Before resuming, saved source lines are checked against the current parser so an upgrade cannot silently apply an old checkpoint to a different row. A mismatch stops that document with a review message and preserves its data. Vendor-history lookup is paginated.
- Price Sheets lists actual imported documents, with original-file/source access and earlier-document pagination. Catalog corrections remain history records and no longer appear as invented source files. Item price controls and history remain available under the vendor.

## Validation

`npm ci`, `npm test` and `npm run build` succeeded. No dependencies were changed. The test suite includes lint, existing procurement/import/provider tests, database migration/atomic-correction tests, document-page rendering, catalog qualification rendering and new import qualification regressions. Vite still reports the existing large-bundle warning; the production build succeeds.

The 16 synthetic import fixtures have explicit expected outcomes. On the v4 parser/gate they produced 0 ready rows; v5 produces **9 ready without edits, 7 correctly held and 0 incorrect outcomes**. Separate tests cover safe NVIM reuse, duplicate candidates, vendor isolation, invoice evidence, source disagreements, expired quotations, locked brands, retained qualifiers, price-edit conflicts, resume source checks and three non-food industry cases. This is a regression set, not a measured production error rate.

Read-only replay of the available `HORNET'S NEST.xlsx` copy:

| Measure | v4 | v5 |
| --- | ---: | ---: |
| Product rows extracted | 85 | 85 |
| Readable physical packs | 73 | 78 |
| Explicit quote units supplied by the sheet | 0 | 0 |
| Automatically eligible in a fresh catalog, without vendor history | 0 | 0 |

The replay is **not a count of the live catalog**. All 85 rows still lack a stated quote unit. In v5, 7 also need pack details and 25 need stronger category evidence; blockers overlap. Inferring every price as a case or pound would inflate the result and can create wrong orders, so the code does not do that. Confirmed vendor-item history can resolve units on repeat imports. A genuinely mixed-unit first sheet still needs additional source evidence.

Run `npm run replay:imports` for the fixed regression set, or `npm run replay:imports -- "/path/to/vendor.xlsx"` for a fresh-catalog Restaurant replay of another document. Neither connects to the database or writes customer data.

## Deployment and remaining limits

This package has not been deployed by this coding session. The prior v4 deployment was verified at commit `a949a996e184d23ebc7b629a8d3f1dc8aabdd2e8`; migration 015's successful execution was reported by the owner. No production database was queried or modified for these changes.

Parser/enrichment changes apply to incoming imports. Deploying does not rewrite every old source row, replace client edits or automatically recategorize existing saved items. Existing readable rows are re-evaluated by the shared gate when loaded. An already completed source file is still protected against duplicate import. Review existing catalog fields before choosing Delete & re-import.

A complete import row is still not one server transaction across quotation, catalog creation, mapping and checkpoint. The orphan-item interruption window and concurrent-import lease remain server-side work. UI rendering and production bundling were checked; no authenticated live-browser workflow was exercised in this session.
