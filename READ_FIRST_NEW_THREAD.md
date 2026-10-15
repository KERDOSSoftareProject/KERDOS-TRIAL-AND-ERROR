# KERDOS — current complete source, v5 (September 27, 2026)

Read this file, then `V5_CHANGES_AND_TEST_RESULTS.md`, then
`KERDOS_HANDOFF_CONTEXT.md`. Earlier handoff files remain for history.
When dates/status conflict, this v5 note takes precedence.

Run `npm ci`, `npm test`, `npm run build`, and `npm run replay:imports`.
Explain the current state before making unrelated changes.

## Current status

- v4 was deployed successfully to the repository and GitHub Pages; verified
  commit: `a949a996e184d23ebc7b629a8d3f1dc8aabdd2e8`.
- The owner reported that the revised Supabase migration 015 ran successfully.
- This complete source includes the v5 import/percentage fixes and document-page
  cleanup. v5 is packaged for deployment; this session did not deploy it.
- There is no new SQL migration. Preserve migration 015 and existing customer data.
- Source/manual evidence starts at 90; independent corroboration can raise fields
  to 100. All required fields at 90 plus a verified association/current quote
  allow automatic Order Guide placement. A suggestion is not established evidence.
- Keep quiet refresh, drafts on other rows, one-write Apply, all worksheets,
  original documents, resumable imports and quote deduplication.
- The actual available 85-row sheet replay improves readable packs from 73 to 78,
  but has no stated quote units. Do not claim production automatic placement
  improved based only on this file. Synthetic fixtures and repeat-vendor tests
  verify the new evidence paths. See the release notes for results and limits.
- Full-row server transactions and a concurrent-import lease remain open work.

## Prior v4 handoff (historical; current status above takes precedence)

# KERDOS — START HERE (new thread, September 27, 2026)

You are picking up KERDOS mid-stream. This zip is the complete current
source. Read in this order:

1. This file (5 minutes).
2. `KERDOS_HANDOFF_CONTEXT.md` — the whole project: what it is, the
   settled decisions, how the owner works, stack, layout, tables, engine.
3. `HANDOFF_TO_CHATGPT_2026-09-27.md` §2, §5b, §5c — the decisions and
   work of the last two days.
4. `CLAUDE_READ_FIRST.md` and `REVIEWED_CHANGES_2026-09-27.md` — your own
   previous thread's notes on this exact source (it is your reviewed
   build, adopted by Claude as the base).

Then run `npm ci && npm test && npm run build`. All pass on this source.

## Where things stand

- **Live site:** the repo `KERDOSSoftareProject/KERDOS-SOFTWARE-PROJECT-
  CHAT-CLAUDE`, deployed by GitHub Actions to
  https://kerdossoftareproject.github.io/KERDOS-SOFTWARE-PROJECT-CHAT-CLAUDE/
- **Pending deploy:** `KERDOS_DEPLOY_v4_2026-09-27` (this source's
  changed files) plus **migration 015** in Supabase. Spiro may or may
  not have done this yet; ask, or check Actions and the `pg_proc` query
  below.
- **Database:** migrations 003–007, 009–014 applied. 015 pending unless
  Spiro says otherwise. Check: `select proname, pronargs from pg_proc
  where proname like 'kerdos_%'` — `kerdos_apply_price_quote` at 21
  parameters means 015 is in.
- **Data:** Hornet's Nest was reset twice on Sept 26; it holds one or two
  freshly imported sheets. `knowledge/KERDOS_TEST_CLIENT_RESET.sql`
  clears imported data for the org without touching org/members/
  vendors/categories/vocabulary.

## The process as the owner defines it (do not drift from this)

Import a vendor file → every product row lands in Item Catalog under its
category with the boxes KERDOS could fill already filled → the owner
fills the rest at their own pace, each cell with the right control →
a row whose required cells are all ≥ 90% places itself in the Order
Guide. No confirm buttons, no double steps. Item name is the client's
word; vendor description is the vendor's. Price sheets never wait on a
person; invoices do. Single-vendor products are normal and stay single
forever if nobody else carries them (house brands).

Percentages mean **estimated accuracy of the value**, never
completeness and never who entered it. Empty cells show "Empty". A
stated or typed value is 90; independent corroboration raises to 100;
contradictions lower it and the reason says why.

## Open items, in order

1. Live acceptance run after 015: import, close the tab mid-way,
   re-import the same file, confirm it resumes with no duplicates; then
   a second vendor sheet to watch matching products join.
2. Make a price-sheet row one server-side transaction (quote + listing
   + catalog item + mapping + checkpoint), with a lease against two
   concurrent uploads of the same file. Resumable-and-idempotent is in;
   atomic is not. Test browser interruption after each step.
3. Brand policy — Spiro's decision pending: record brand always; let it
   block a match only when the item is marked "brand matters"
   (`brand_locked` exists). Build only after he decides.
4. Import Invoice should recognise a price sheet and offer to switch.
5. RLS / role enforcement (`ACCESS_POLICY_REVIEW.md`).

## Working rules

- One assistant on the code at a time; land in GitHub before switching.
- Every package gets a unique, versioned name (`KERDOS_DEPLOY_vN_date`).
- Every deploy note lists every migration the build needs.
- After each deploy, one real import on the live site before any further
  change.
- Verify with real runs; say exactly what was and was not verified.
- Nothing hardcoded for a client, a vendor, or an industry.
