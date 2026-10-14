# Import-to-Order Guide risk register

This is an audit of the current source, not a certification of live data. Priorities distinguish incorrect purchasing decisions from incomplete coverage. The client-specific KERDOS catalog item remains the only comparison identity.

| Priority | Failure path | What happens | Status / next control |
| --- | --- | --- | --- |
| Critical | Two invoice products have the same code, description, or near-identical match score | An arbitrary product receives an invoice charge and a misleading variance | Fixed in this review: ambiguous code/description and tied fuzzy matches remain historical invoice lines without an item link. Verify in live invoice UI. |
| Critical | A nonempty selling unit cannot be interpreted | Each or measure prices can masquerade as case prices | Fixed in this review: hold that price-sheet row before changing the current quote; invoice variance is withheld for unknown units. Unit vocabulary remains a required configuration path. |
| Critical | One witness agrees with a candidate but another linked item has a conflicting product, brand, identifier, or pack | Incorrect vendors compete under one KERDOS number | Fixed in prior review: evaluate every peer. Needs live data verification. |
| Critical | Quote persists, then brand write, catalog creation, or mapping write fails | Price exists without a catalog home; whole-file fingerprint prevents ordinary retry | Open: replace multi-step writes with a transactional, resumable import operation and explicit row checkpoints. A warning alone does not repair the missing mapping. |
| High | Existing mapping or vendor listing changes meaning after a new sheet | Old exact mapping remains exact while product or pack is different | Implemented oversight after the item-number lookup: changed supplied fields hold the incoming quote while preserving the link and prior accepted source. Catalog corrections to defining fields return the association to review. |
| High | Missing selling unit means unknown basis on a new document | Price defaults to legacy case interpretation | Implemented: unknown incoming basis is held with its source; catalog cells let the client resolve it. A confirmed vendor item reuses its saved unit. |
| High | Similar products get separate numbered catalog items | Correct vendor comparisons never appear together | Open: persist candidate evidence and revisit automatically when new identifiers or packs arrive; do not force an uncertain merge. |
| High | Two eligible offers describe a different grade, state, brand, or pack despite similar words | False savings and wrong substitute | Partially guarded by product and pack checks; expand industry profile attributes and corpus tests from actual vendor files. |
| High | Source parser skips a product or mistakes a subtotal/price column for a quote | Coverage loss or a fabricated price | Review gating exists for some ambiguous rows; add document-level reconciliation: extracted, skipped, rejected, saved, and unmatched counts must balance. |
| High | Invoice date, quote expiry, or quoted unit is wrong | False overcharge/undercharge or stale order offer | Some time and basis checks exist; test date boundary, timezone, and historical quote selection against real invoices. |
| Medium | A different vendor repeats another vendor's item code | Identity is inferred from a vendor-local identifier | Current matching scopes lookup to vendor and organization; preserve that boundary in all subsequent matching. |
| Medium | Client switches industry or category vocabulary evolves | Product category guesses drift | Current profile suggests and flags older placements; add versioned classification evidence and bulk review instead of silent rewrite. |
| Medium | Import contains hundreds of uncertain rows | Client faces item-by-item busywork | Open: group exceptions by shared cause and offer batch resolution; measure automatic placement, confirmed association, and review rates separately. |
| Medium | Duplicate file is blocked after a partial import | Failed rows cannot be recovered through ordinary reupload | Open: resumable per-row document state, idempotency keys, and repair command. |

## Release gates

1. No row can become an orderable multi-vendor comparison unless product identity, purchasing pack, and current price basis are established for that client item.
2. Every extracted row must have a durable outcome: saved and mapped, saved for review, skipped with reason, or failed with a retry path. Counts must reconcile with the source.
3. Partial imports must be repairable without duplicating prices, history, catalog numbers, or invoice lines.
4. Exercise the flow on actual vendor documents and the live schema in a staging project before a deployment decision.

Accuracy and coverage are distinct: assigning each uncertain listing its own client number is traceable placement, but it is not proof that all vendors for a product have been associated.

## Supplied vendor document: `horn(1).txt`

The existing parser extracted 96/96 data rows with vendor codes, brands, descriptions, packs, and quoted numbers, and skipped no data rows. Every row lacks a selling-unit column. A few small quoted amounts beside multi-pound packs could be per pound, while other quotes could be per case: the file itself does not establish a universal basis. Do not assign CASE to all 96 rows or turn the quote numbers into unverified unit costs. A repeat import may inherit an earlier *explicitly confirmed* vendor-specific price basis if code, product identity, and pack agree. New rows without a basis can now enter the catalog with their original quoted amount but cannot be ordered or compared until the client confirms a basis in Item Catalog. An unresolvable new quote for an existing item leaves the previously confirmed current quote untouched. Batch guessing from price magnitude is unsafe. Four packs omit the leading zero on fractions (for example `200/.5OZ`, `4/.5 GAL`); parsing of those packs is now fixed with regression tests.
