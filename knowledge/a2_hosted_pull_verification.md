# Module A · Task 2 — hosted controlled acceptance PASS

October29,2026, kerdos-test only. Dino explicitly approved the staged persistent
test installation, controlled pulls/replay, one scheduled observation and cleanup.
PR23 source52fe65b merged45b9cd3; clean GitHub run76/40870901451 passed full tests,
lint, build and Pages. Actual migration20261029120659_a2_vendor_price_pull and
vendor-price-pullv1 are installed. Machine evidence: `a2_hosted_pull_results.json`.

## Observed results

- Missing/wrong function credentials returned401 (requests585/586). Authorized
  empty-source request587 returned200. Private claim RPC excludes client roles.
- Public controlled170-byte CSV exactly matches repository SHA256
  48bd73af0ac95696ab75be1be7b6dd8c710935deac0f7cd4a0da3281b50d9151.
- First on-demand request589 returned200/auto_imported. One vendor_pull receipt
  preserved organization/vendor/pricelist snapshot, original and filename;
  one complete documentbf0d090a-7e8a-4a70-b6fc-216f6783e483 has row:0,row:1.
- Two new vendor items and catalog mappings saved exactly41.25 and51.75 per
  CASE /2/10 LB, with two price-history rows linked to that source. No client
  upload, selection, Save, email send or manual worker invocation was required.
- Request590 replay returned200/skipped. Every receipt/attachment/document/item/
  mapping/quote/storage-object ID and value stayed unchanged. Existing-original
  download/byte-comparison in retainExport also passed on the duplicate path.
- Private scheduler job2/run556 fired08:15:00Eastern, queued HTTP591 and removed
  its own schedule. HTTP591 returned200/skipped at the same attachment; finished
 08:15:05Eastern. No data duplicated. This proves scheduled re-pull/replay, not
  a fresh changed export or an independent browser-closure observation.
- Existing A1 recovery job1/run557 also succeeded at08:15; all pre-existing
  function versions/bundle hashes remain unchanged. No claim about general
  capacity/load testing follows from this one coexistence observation.
- Production Order Guide assessment on actual saved records computes2.0625/lb
  and2.5875/lb. Both remain in the holding category with category as sole blocker;
  items are stored without fabricating category approval or Guide eligibility.

## Verified cleanup

Source43c7f7eb-5e2a-4076-bea1-9f5a91e979b0 disabled; its generated synthetic Vault
credential removed; zero active Task2 sources and zero Task2 cron jobs. Original,
receipt, completed document, items, mappings and prices are retained. Existing
A1 recovery job and its Vault secret are preserved. Schema/function stay installed.

Automatic review rejected a broader cleanup proposal that also deleted source,
dispatch/origin rows and deactivated the fixture vendor. None of those broader
changes ran. Cleanup was narrowed to the explicitly approved disable/credential/
unschedule actions and passed. Setup/audit metadata remain; no recurring Task2
job fires on an empty source list. Reactivation requires a fresh credential.

## Evidence boundary

This is hosted synthetic HTTPS export → worker → actual catalog/prices evidence.
The fixture is public and does not authenticate the disposable upstream bearer;
real supplier authentication/portal integration is unverified. No real vendor
credentials or API path have been supplied. Interactive/MFA/cookie portals remain
outside this first adapter. A1.3 configured-address copying and signed-in A1.5 time
observation are separate open UI checks. Whole Module A is not signed off.
