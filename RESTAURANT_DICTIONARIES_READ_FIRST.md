# KERDOS run 73 correction — 2026-09-27

This ZIP contains only changed files for GitHub commit
048668b483e13fdb363ae27c8161690fafa6afda (failed Actions run 73).
The source was retrieved directly from KERDOSSoftareProject /
KERDOS-SOFTWARE-PROJECT-CHAT-CLAUDE. No current source ZIP is needed from the user.

## What failed

The earlier update used an older local baseline. The repository already had
newer import qualification logic from successful commit
b69f14d1981ee8669612afa26130e5d06fd9c5d6 (run 72). Mixing them caused the field
accuracy test to receive 100 where the current rules correctly expected 90.
The npm test step failed; build and deployment steps were skipped.

## What this correction preserves

The dictionary and universal pack improvements have been merged into the
successful version's architecture. Source statements and manual choices do not
become 100% accurate merely by being present. Import previews and saved catalog
rows keep the same evidence-based field rules. The original expected percentages
were retained; checks were not lowered to make the deployment pass.

The update also retains qualification/blocker summaries, automatic placement
retry, invoice evidence, explicit source price units, NVIM quote-basis reuse,
source-row checks before resuming imports, document pagination, and restaurant
pack qualifiers. The newer automatic-import and page-rendering suites have
been restored to the test command alongside the new dictionary and pack tests.

Repeat-import review retains saved associations and quotations. Incoming changes
and unclear packs remain visible for review. Preview and saving use the same
review preparation; a changed manually corrected field no longer throws away
its preview. Invoice pack evidence remains available.

## Industry and client data

Pack punctuation and recognized unit formats are industry neutral. Restaurant
terms remain in the Restaurant profile. Client/vendor names, item lists, quoted
prices and the supplied workbook are not bundled as application rules or fixtures.
Organization-specific vocabulary remains database data.

## Verified

The complete current npm test command passed, including accuracy, automatic
imports, invoice evidence, NVIM persistence, import resumption, document/catalog
rendering and database transaction tests. Production build and GitHub Pages asset
path checks passed. Dependency versions and database migrations are unchanged.

A read-only replay of the 157-row supplied sheet read 120 packs. With a fresh
catalog, no saved vendor history and the bundled category configuration, 65 rows
met the qualification checks and 92 had blockers. This is a local diagnostic,
not a live Order Guide count or an accuracy percentage. Existing associations,
manual corrections and invoices may change live results. The supplied workbook
is not included in the ZIP.

## Upload

1. Extract this newly corrected ZIP.
2. At the repository root, upload its src folder, package.json and the two
   documentation/manifest files, preserving folders. Commit once.
3. Wait for the new Actions run to succeed before testing the app.
4. Refresh the app and retry the same incomplete price sheet. Keep company,
   vendors, catalog and mappings. No SQL or data clearing is needed.

Completed source rows remain checkpointed. Rows already saved for manual review
should be finished in Item Catalog; genuinely failed rows can resume. This patch
does not merge previously separate catalog IDs, and it cannot certify missing
supplier specifications. No changes have been pushed to GitHub or written to
Supabase by the assistant.
