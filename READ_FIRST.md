# KERDOS — build of 2026-09-23 (afternoon), NOT yet deployed

Read `KERDOS_HANDOFF_CONTEXT.md` for the whole project. This file covers
only what changed in this build and how to deploy it.

## What this build contains

ChatGPT's afternoon work (matching rules, Mapped/Not mapped catalog,
order eligibility, invoice-as-history, error boundary, ESLint, portable
adapter, PDF layout reader) plus two completions by Claude:

### 1. Price basis, end to end
The flagged risk was: a vendor quoting per pound could be ranked as if
the price were per case, and invoice variances compared unlike bases.

- `knowledge/migration_009_price_basis.sql` — `selling_unit`,
  `price_basis` (`case` | `each` | `measure`), `gtin` and
  `manufacturer_code` on `vendor_items` (basis also on `price_history`);
  `kerdos_apply_price_quote` gains four defaulted params.
- `src/procurement.js` — `priceBasisFor(sellingUnit)`,
  `casePriceFromQuote(price,basis,unit,pack)`,
  `quotePriceOnBasis(quote,target)`. Industry-neutral word lists; unknown
  selling units record no basis and are treated as the pack price, which
  is exactly how every existing row already behaves.
- `src/pages/ImportModal.jsx` — price-sheet import records the basis;
  invoice variance is computed on the basis the invoice bills in, and a
  quote that cannot be expressed that way records no variance plus a note.
- `src/App.jsx` — every option's `casePrice` is the converted full-pack
  price; hovering a price shows the vendor's original quote and unit.
- `src/core/ordering.js` — `basisUnconvertible` blocks ordering with a
  reason that says what to fix.

### 2. Bulk confirm for single-vendor listings
Under the new rules a single-vendor product stays Not mapped until the
client confirms it, which would empty the Order Guide on day one.
`readyToConfirm()` in `src/services/catalog.js` lists the unverified
single-vendor mappings that already pass the same verification a
one-at-a-time confirm runs (readable pack, identity agrees, no other
vendor on the item). Item Catalog shows one button: "Confirm N ready
single-vendor products", with a preview and a confirm dialog. Anything
shared by two vendors, or missing a pack, is never bulk-confirmed.

### 3. More engine 100%s with zero client effort
- **Identifiers.** Price-sheet columns named UPC / GTIN / EAN / barcode
  and Mfr # / manufacturer item / part no are now captured (GTIN check
  digit validated, so phone and account numbers are rejected). Migration
  009 stores them on `vendor_items`. In matching, a GTIN already linked
  under a catalog item by a *different* vendor proves identity without
  any wording comparison: same pack → exact 100%; different pack →
  review with both packs named. Manufacturer code does the same, but
  only when both listings carry the same brand.
- **Pack from the description.** When the pack column is empty and the
  description ends in a readable pack ("OIL CANOLA 35#", "CHICKEN BREAST
  4/10 LB"), that pack is used and marked `packSource: "description"`.
  The description itself is never altered. Nothing is invented: "PEPPERS
  2 CHICKEN" yields no pack.
- **Pack from the vendor's own invoice.** When an invoice line matches a
  vendor item by the vendor's code, the product is the same, and the
  vendor item has no pack, the invoice's pack fills it. It records the
  pack only and never confirms a mapping. The import summary says how
  many were filled.
- **Why-not-100% reasons.** Every unverified mapping gets one fixed code
  (`mappingGap` in `src/services/catalog.js`): pack missing, pack
  unreadable, single vendor ready, single vendor wording differs, brand
  conflict, pack conflict, wording. The Not mapped view shows a count per
  reason as clickable filters and sorts the list by reason, so one parser
  fix or one bulk confirm clears a whole group.
- **Auto-verify rate.** Every price-sheet import now reports "N of M
  verified automatically", so the effect of each improvement is visible.

### 4. Second pass (same day): learning, catch weight, engine re-check
- **Learning from confirmations.** When a client confirms or moves a
  listing onto an item that other vendors also carry, the abbreviation
  pairs between the wordings ("brst"→"breast", "bnls"→"boneless") are
  saved to the organization vocabulary as synonyms. Only spelling pairs
  are saved: a short word that starts with the same letter and whose
  letters appear in order in the long word. "breast"/"thigh" and
  "sauce"/"paste" never pair, so a confirmation can teach wording but
  never product equality. Learning happens before the refresh, so the
  next comparison already reads it. (`abbreviationPairs`,
  `catalogService.learnAbbreviations`.)
- **Catch weight.** "4/10 LBAV", "4/10 LB AVG", "2/10# AVG", "30 LB AVG",
  "10 LB RW" now parse as mass with `catchWeight: true`. A catch-weight
  pack and a fixed-weight pack of the same nominal size compare as
  review, not same. "#10" after a slash is a can size ("6/#10 CN" = six
  #10 cans), and "50#BAG" is 50 LB.
- **Engine re-check.** `engineVerifiable()` lists review mappings that
  now pass every check with a second vendor's listing as witness (after
  learned wording or a corrected pack). Item Catalog shows "Apply N
  engine-verified matches"; one click records them as engine-selected
  100% matches. Single-vendor mappings are never included.

### 5. New products land in a category, not the holding pen
`suggestCategory()` in `src/procurement.js` adds a best-guess tier below
`classifyCategory()`'s confident decision: a vocabulary hit that lost a
tie, a weaker resemblance to items already in a category, or a category
name sharing a defining word. A confident placement files the item as
before. A guessed placement files it in that category with
`category_review = true` and the reason (migration 009 adds both columns
to `catalog_items`). Only a product resembling nothing goes to
Uncategorized. Item Catalog shows "Category suggested — confirm or move"
on those items with a "Looks right" link, plus one "Accept N suggested
categories" button for the lot; moving an item with the normal category
control clears the flag. Admin's "reclassify uncategorized" uses the same
two tiers.

## Verified
- Full suite passes: 88 regression, 28 ingestion, 24 price-basis (new),
  27 identifier (new), 10 catalog-browse, plus ordering, catalog,
  categories, organization,
  service-boundaries, session, backend-contract, portable-provider,
  offline-store and deployment tests.
- Zero undefined names in every source file; bundle resolves.
- Deployment test now also checks that every parameter the adapter
  passes to an RPC exists in a migration, so a frontend/database
  signature mismatch fails CI instead of failing in production.
- Not run here (no package install in this environment): ESLint and
  `records-test.mjs`. CI runs both.
- Not run: a browser click-through. Do the four checks after deploy.

## Deploy order (matters)
1. Supabase → SQL editor → run `KERDOS_DATABASE_UPDATE_CLEAN.sql`.
   Idempotent. The old frontend keeps working after it.
2. Upload this source to the repo (drag `src`, `knowledge`, `scripts`,
   `package.json`, `package-lock.json`, `eslint.config.js`,
   `KERDOS_DATABASE_UPDATE_CLEAN.sql`, and the four `.md` files).
   `.env.example` and the workflow are unchanged.
3. Green run → hard refresh → sign in → Item Catalog → press
   "Confirm N ready single-vendor products" → Order Guide fills back in.

## Do not
- Apply `migration_008_manual_price.sql`; it is unused and excluded from
  the generated update on purpose.
- Compare unit costs across bases anywhere new; go through
  `casePriceFromQuote` / `quotePriceOnBasis`.
