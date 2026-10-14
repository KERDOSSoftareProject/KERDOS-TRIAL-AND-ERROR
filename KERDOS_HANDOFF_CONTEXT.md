> **v5 update, September 27, 2026:** Read `READ_FIRST_NEW_THREAD.md` and
> `V5_CHANGES_AND_TEST_RESULTS.md` first. v4 deployment was verified; the owner
> reported revised migration 015 success. This source contains v5, packaged
> but not deployed by this session. No new migration is required. Older status
> statements below are historical. Preserve the shared 90% field gate and do
> not assume missing quotation units from price plausibility.

# KERDOS — HANDOFF CONTEXT (as of September 27, 2026)

Read `HANDOFF_TO_CHATGPT_2026-09-27.md` first for the latest state, then
this for the whole project. This replaces every older context document.

---

## 1. What KERDOS is

A universal SaaS procurement and price-comparison platform. Any business
that buys from multiple vendors imports vendor price sheets and invoices,
KERDOS maps every vendor's proprietary item to one client-owned catalog
item, normalizes price per unit, and shows the cheapest vendor for each
item in an Order Guide with plus/minus ordering.

- Owner: Spiro. Not a programmer. Treat him as the end user and the
  product owner. He makes design decisions; you write and verify code.
- Live test client: Hornet's Nest Deli, Branford CT. Vendors: Minore's
  Meats, Ferraro Foods, US Foods, Carbonella & DeSarbo, WB Mason, Mina
  Foods, Cityline Foods. Cityline and Carbonella have no vendor item codes.
- Core value: price comparison and ordering FIRST. Importing and
  record-keeping are supporting plumbing, not the product.
- Long-term: multi-industry, large client base. Nothing may be hardcoded
  for the deli, the food industry, or any specific client.

## 2. Non-negotiable decisions (do not re-raise these)

1. **No AI at runtime.** All matching and classification is deterministic
   code. An AI-fallback classifier (Supabase Edge Function calling the
   Claude API) was built and explicitly reverted. Do not propose it again.
   Classification is driven by per-industry keyword dictionaries stored in
   the database (culinary/restaurant v1 exists; other industries get built
   the same way when a client arrives).
2. **Universal-client model.** Configuration lives in the database
   (catalog_categories with keywords, industry templates), never in code.
3. **Vendor independence.** KERDOS must not depend on Supabase or GitHub
   specifically. The UI never imports Supabase; all provider access goes
   through `src/backend/contract.js` and `src/backend/supabase.js`.
4. **Verification standard.** Every code change must be actually tested
   with real runs before being presented as done. Never guess. If you
   don't know, read the code. State explicitly what was verified and what
   was not.
5. **Branding** is the plain owl mark. Coin designs were rejected.
6. **Scope discipline.** Never advertise a feature that doesn't exist.
7. **Code style.** Modular, compartmentalized, simple. One shared
   implementation over two that can drift apart. "If it needs
   explanation it is too complicated."

## 3. How Spiro works (communication and workflow)

- Short, direct communication. No step-by-step walkthroughs, no
  card-style UI, no micro-guidance. "Let me know when you're done."
- Corrects course fast and expects corrections taken at face value.
- No file downloads per intermediate step. Files only when ready to
  deploy, packaged so they can be dropped straight into the repo.
- **He works only in the GitHub web editor. No terminal.** Deploys happen
  by uploading files through "Add file > Upload files" on github.com.
  Dragging a folder (e.g. `src`) into the upload page preserves paths and
  replaces matching files in one commit.
- Known upload pitfalls (all hit today):
  - Files renamed by the Mac downloads folder (`App (2).jsx`) create
    duplicates in the repo instead of replacing.
  - Dot-files (`.env.example`) are hidden by macOS and never get uploaded.
    Create them with "Add file > Create new file" instead.
  - Uploading from the repo root puts files in the root, not `src/core`.
- GitHub Desktop was suggested as a better workflow; not adopted yet.

## 4. Stack and infrastructure

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite, single-page app |
| Backend | Supabase (Postgres + auth + storage + RPCs) at antpbtorhqghrjqzftub.supabase.co |
| Document parsing | Local in the browser: pdfjs-dist, SheetJS (xlsx), tesseract.js OCR (assets bundled under `public/ocr`) |
| Hosting | GitHub Pages via GitHub Actions |
| Repo | github.com/KERDOSSoftareProject/KERDOS-SOFTWARE-PROJECT-CHAT-CLAUDE (the older `KERDOS` repo is obsolete) |
| Live URL | https://kerdossoftareproject.github.io/KERDOS-SOFTWARE-PROJECT-CHAT-CLAUDE/ |

Deploy workflow (`.github/workflows/deploy-pages.yml`): on every push to
main it runs `npm ci`, `npm test`, `npm run build`, then publishes `dist`.
A red run means nothing was deployed. Base path is derived automatically
from the repo name. Secrets required: `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`.

## 5. Source layout

```
src/
  main.jsx                 entry
  App.jsx                  shell, session, data loading, Order Guide, nav
  pages/                   one file per screen or modal
    AccessPages.jsx        landing / org gate
    DocumentPages.jsx      Invoices and Price Sheets history pages
    ImportModal.jsx        paste/upload import flow
    ItemCatalogPanel.jsx   client catalog + review/mapping actions
    CatalogAdminPanel.jsx  category management
    TeamPanel.jsx          team/roles
    VendorDetail.jsx       per-vendor page
    RecordModals.jsx       invoice edit, add vendor
  services/                named KERDOS operations (catalog, categories,
                           documents, imports, operations, organization,
                           vendors); the only place provider queries live
  backend/                 contract.js (the KERDOS backend contract),
                           supabase.js (the only Supabase code), index.js
  core/
    ordering.js            basket/order solver, vendor minimums
    catalog-browse.js      shared search + sort helpers (NEW today)
  procurement.js           unit parsing, pack-size normalization, price per
                           unit, product identity, safeProductScore matching
  ingestion.js             price-sheet/invoice text extraction
  document-reader.js       file-type routing (pdf, xlsx, csv, eml, html, ocr)
  reporting.js             CSV exports (catalog export, price variance report)
  localization.js          currency/date formatting
  offline-store.js         last-synced snapshot for outages
  session.js               session controller
  ui/styles.js             palette and shared style helpers
  *-test.mjs               one test file per module, all run by `npm test`
knowledge/                 SQL migrations 003–007, vocabulary, restaurant
                           dictionary v1
KERDOS_DATABASE_UPDATE_CLEAN.sql   migrations 003–007 combined (generated,
                           do not hand-edit)
```

Nav: Order Guide (default after sign-in), Import, Item Catalog (badge =
review count), Records, Admin. Roles: owner / manager / employee.

## 6. Key database tables

catalog_categories; catalog_items (brand_locked, locked_brand,
matching_behavior, canonical_unit, master_item_number); invite_codes;
invoice_lines (match_confidence); invoices (file_path, file_name, status);
item_mappings (confidence_score, match_method, comparison_track);
like_product_groups; locations; organization_members; organizations
(settings jsonb incl. price_refresh_days, logo_url); price_history;
profiles; purchase_order_lines; purchase_orders; vendor_items
(vendor_item_code, price_source).

## 7. Matching system (how it works today)

- One shared size-aware scorer, `safeProductScore` in `procurement.js`,
  used for both catalog matching and invoice-line matching. Two separate
  engines were merged after they drifted and one silently merged
  "Chicken Breast 40lb" with "Chicken Thighs 40lb".
- Confidence tiers: Confirmed (exact) / High (85%+) / Needs review
  (50–84% catalog, 60–84% invoice) / No match → new item. Invoice
  matching uses the stricter floor plus a size-token conflict check
  because a wrong invoice match creates a false overcharge alert.
- comparison_track "new" = a single vendor introducing a product = clean
  100%, not flagged. Only "similar" (fuzzy merge across vendors) is real
  uncertainty and gets flagged.
- Review happens inside Item Catalog: Confirm (bump to exact) or Remap
  (point at another item, or split into a new item).
- An invoice line matching nothing auto-creates a vendor_item with
  price_source 'invoice'; it graduates to 'price_list' when a real price
  sheet confirms it. Prefer a visible duplicate over a silent wrong match.
- last_updated bumps on every price-sheet appearance; stale prices
  (past org's price_refresh_days) show $0 and are excluded from cheapest
  pick and vendor-minimum fill.
- Category keyword matching is plural-tolerant (prefix comparison).

## 8. Timeline since September 23

- **Sept 23:** white-screen fix deployed; ENGINE v3 (price basis,
  identifiers, learning, category placement) built and deployed; 009 run.
- **Sept 24:** per-tab sign-in; Item Catalog field repair; the onboarding
  model agreed (rows land in Item Catalog with per-cell status; no
  number until commit).
- **Sept 25:** ChatGPT's integrated builds: per-field resolutions on
  vendor_items (010), New/Mapped/Oversight lanes keyed on the vendor
  item number, document deletion (011), vendor NVIM numbering (012),
  invoice mapping (013), editable catalog grid.
- **Sept 26:** discovered 010 had never been run (all imports failing
  silently); ran it. Data reset twice for a clean first run. Price-sheet
  gate removed; automatic Order Guide placement; import UX (Select
  vendor, sheet basis, success screen, drachma); chrome trimmed.
- **Sept 27:** Item name vs vendor description (014); every cell
  writable; "Undetermined" unit cost. Then ChatGPT's six review items
  built (015): resumable idempotent imports, one-write Apply, all
  worksheets, dead code removed, accuracy percentages that mean accuracy
  with a ≥90 placement rule.

## 9. Settled decisions added Sept 26–27

See `HANDOFF_TO_CHATGPT_2026-09-27.md` §2. In short: no double steps;
solved rows place themselves; single-vendor is normal; price sheets
never wait; invoices do; item name is the client's, description is the
vendor's; every cell writable except the KERDOS number.

## 10. Open items

See `HANDOFF_TO_CHATGPT_2026-09-27.md` §6.

## 11. Rules for any assistant working on this

- Read the actual code before answering questions about it.
- Test every change with real runs. Say exactly what you verified.
- Package deploys as files that drop straight into the repo at the right
  paths, and say which files are new vs. replaced. List every migration
  the build needs.
- Never propose runtime AI, a Supabase- or GitHub-specific dependency, or
  anything hardcoded for one client or industry.
- Keep replies short. Spiro has no patience for walkthroughs, and he's
  right not to.
