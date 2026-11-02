# Product association trial

This experimental Item Catalog process groups saved vendor listings by product
identity across different brands and purchasing packs. It does not change the
Automated/Manual Ingestion entry paths. The Engine produces a read-only preview;
Item Catalog reviews it; Mapping saves the accepted identity. Purchasing
Readiness still assesses each offer's own fields and quotes.

The universal engine is `src/core/product-associations.js`. Restaurant knowledge
is data in `src/knowledge/restaurant-associations.js`; another industry can supply
the same profile contract. No AI requests, supplier-specific rules, extra paid
service, or fixed source/group counts are used. Previews work with the app's
cached data; shared writes require an available authorized database connection.

Item Catalog opens in **Product groups**. Expand groups and search vendor
listings on that screen. **Apply product groups to catalog** replaces the old
association organization with engine-proposed groups, including splits where
old catalog identities mixed products. Such memberships remain at 70% review
confidence, rather than pretending the client verified them. **Confirm this
product identity** is a separate deliberate review action and approves identity only. It does not add confirmations to the listing's
pack, brand, selling unit, quote amount or category. Existing field evidence and
financial history are preserved. Explicit client decisions, restrictions and
rejected pairs are protected in the proposal process. Existing grouping/editing
tools remain available.

Each save carries the exact source mapping IDs/revisions and a stable request
ID. The database checks current scope, role, memberships and restrictions in one
transaction. Previously used catalog IDs and numbers remain as alias records.
Retries return the original result without writing a second group. The saved
history supports restoring the preceding mappings when no later changes would
be overwritten. Lost replies can be retried with the same request while the
screen remains open; after reload, the saved history and current mappings give
the persisted result. This is not a general offline write queue.

## Evidence and limits

- Reference PDF: 869 listings, 357 judgment-based groups, 83 unresolved rows.
- First deterministic version on the same saved assortment: 501 proposed groups
  (including singletons), 110 multi-listing groups, 23 unresolved rows; every row
  is represented once. The counts differ from the PDF and are not a claim that
  the code reproduces every judgment-based membership.
- Pomace oil: three listings in one proposal. Honey mustard: four in one proposal.
- All proposals require review; shared concepts can have remaining differences.
  This first vocabulary does not fully cover every product in the assortment.
- Code/service/readiness, actual rendered controls and PostgreSQL role/RLS tests
  pass using `npm run test:associations`.
- Full existing `npm test`, lint and production build passed during development.
- The additive migration was applied to `kerdos-test`. Hosted rollback-only
  testing used the real honey-mustard source rows: stale-save rejection, atomic
  association, idempotent retry, unchanged source/quote fields and price-history
  counts, and restoration of original mapping evidence passed. Simulated JWT
  claims test database authorization; they do not prove a browser sign-in.

The full regrouping was exercised in a hosted rollback-only test: 126 changes
covering 469 listings produced 524 saved catalog identities: 501 product groups
plus 23 unresolved listings. All source fields and price-history hashes were
unchanged, and repeated requests were idempotent. Committing that bulk batch was
blocked by automatic approval review pending explicit approval of the full
proposal batch; no permanent catalog regrouping has been performed. The schema
and functions are installed in the test project. Equivalence between grouped
products is not asserted. Code, hosted database, publication and observed live user-interface
results must be recorded separately.
