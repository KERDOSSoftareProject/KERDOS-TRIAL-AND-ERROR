# Module A — Interaction Gate Results

Application: KERDOS → Division I · Procurement → Module A · Pre-Ingestion  
Governing task list: v64, October 29, 2026 Eastern  
Repository baseline: main through PR #23, merge `45b9cd35b95afaf300bf901b2cd267bbfcb3a293`  
Environment: kerdos-test `gwtnaudjfoxjermhvhpx`

## Current decision

**Task2 shared HTTPS-export implementation is deployed and passed controlled hosted acceptance.** On-demand import saved two catalog-linked items and exact41.25/51.75 CASE prices; replay and the08:15Eastern scheduled re-pull preserved all IDs/counts. The source is now disabled, its credential removed and its Task2 cron unscheduled. Schema/function remain installed. The actual supplier authentication/portal acceptance remains open because no real vendor endpoint or credentials have been supplied.

**Whole Task1 and whole Module A remain open.** A1.3 copying is configuration-dependent; A1.5 sender/date/clarification/status-only display was observed and its time fix is deployed, but signed-in visual time re-observation remains unverified. These UI limits are not changed by Task2 backend acceptance.

This reconciliation preserves the existing A1.1–A1.7 numbering. The original reconciliation changed documentation only. Follow-on deployments are identified separately below. Earlier draft/unexecuted entries are historical and superseded by this current decision where noted. A passing code/database checkbox does not certify its separate live browser observation.

## A1.1–A1.7 under their actual labels

| Number | Governing responsibility | Passing evidence | Remaining live/scope boundary |
|---|---|---|---|
| A1.1 | Automatically provision receiving addresses identifying client, vendor and document type | PR #8: 12 PostgreSQL provisioning/permissions/lifecycle checks and 4 rendered context/no-client-write checks; deployed trigger/config migration; actual tagged Postmark routes preserve receipt ownership/type | Owned production domains/DNS are deferred and do not block testing. No claim of owned-domain delivery. |
| A1.2 | Automatically process emailed attachments using registered client/vendor/type | Receipt snapshot/immutability/permissions 17 database checks; durable handoff and active/stale lease checks; actual CSV price-sheet/invoice delivery; new/existing item/catalog retention; validated atomic invoice; PR #18 images, #19 PDF and #20 mixed hosted acceptance | XLSX reader coverage is executed local code evidence, not a hosted XLSX email pass. Image/PDF/mixed hosted results are not new real-email sends. |
| A1.3 | Client can provide routing address to vendors | Clipboard code checks cover exact address, success after clipboard resolution and honest failure | **CONFIGURATION-DEPENDENT:** Dino’s signed-in Price Sheets view shows no address/Copy control while future domains are unconfigured. Exact copy remains unverified; no invented address, domain purchase or client setup is required to continue other work. |
| A1.4 | Optional forwarding copy to client email | 19 code checks; processing/forwarding exception handoff tests | Actual outbound copy is OPTIONAL/UNVERIFIED; not an automatic intake blocker. |
| A1.5 | Inbox displays received email, timestamp, sender and processing state | Routing/service tests and mounted production adapter checks; PR #17 automatic receipts are status-only without manual import controls | Dino’s signed-in Inbox screenshot confirms sender/date/filename/clarification and no manual import controls. **Time absent:** PR #22 supplies date/time/seconds/timezone; 7 mounted/full-suite/lint/build local passes. Merged/deployed under PR22/run75; not signed-in live observed. |
| A1.6 | Link manually imported attachment to document and retain audit trail | 9 database audit-link checks; actual-modal reservation/resolution tests; rolled-back completion guard rejects premature success | Live manual-review save/correction is OPTIONAL separate manual work. It is not required for zero-action automatic intake. |
| A1.7 | Partial import recovery | Same linked document, saved row:N keys only, retained unresolved source, active/stale lease distinction, duplicate-safe deployed CSV/image/PDF replay; scheduled recovery via existing cron/Vault | Scheduled 15:35 recovery passed with Dino-attested tab closure. Agent did not independently observe tabs; fresh-email closure timing is not claimed. |

Catalog mapping/confidence evidence belongs to A1.2. Recovery dispatch/scheduling evidence supports A1.2 handoff and A1.7 recovery. Neither is substituted for A1.3 copying, A1.4 forwarding, A1.5 Inbox or A1.6 manual audit linkage.

## Evidence categories

- **Static review:** source inspection only.
- **Local executed tests:** actual parser/OCR/components or local PostgreSQL-compatible fixtures. Mock HTTP verifier-quality checks belong here. Neither is a hosted pass.
- **Database checks:** actual kerdos-test SQL or saved records; identify rolled-back fixtures where relevant.
- **Hosted synthetic:** controlled webhook/worker calls against deployed kerdos-test; distinguish from direct worker-only checks.
- **Real email:** actual Postmark transport → webhook → worker → saved data.
- **Browser observation:** identify observer. User-attested closure is not independent agent tab observation.

The 9 OCR, 16 PDF, 15 worker and 10 verifier-quality checks are **local executed suites**; hosted acceptance has its own requests/results below. GitHub run74 (`40800340673`) passed the repository's full checks/build; the separately run 10-check mixed verifier suite is not claimed to be wired into that full npm command.

## Closed scoped processing interactions

| Evidence | Result |
|---|---|
| Real CSV price sheet, Oct28 05:42:52 Eastern | Message `1ba5eaef-e497-4370-b613-397e8594f08e`; original retained; complete document; exact10.37 quote; no manual import. |
| Real CSV invoice, Oct28 05:51:02 Eastern | Message `c0e28153-05d0-49b7-a047-23f43fd448c2`; original retained; complete document; one2×10.37=20.74 CASE line. |
| PR #18 hosted PNG/JPEG | Helper requests422/428; webhook429; complete sheets40/50, valid later row50 retained beside unreadable source, no nonpricing false price; invoice436 saved2CASE×40=80; duplicate/recovery counts stable; auth enforced. |
| PR #19 hosted PDF | Helper446 passed before processorv13 update. Webhook448/449 saved text/scanned sheets and invoices; originals and names retained; corrupt/password exceptions honest; recovery450 preserved2/1quote counts and complete/partial document identities. |
| PR #20 mixed CSV + PNG | Request455 passed10 hosted assertions: one receipt `73904e71-b920-401e-9175-fb332c0ee4f2`, nonpricing PNG first, valid CSV second; complete document `f9eaf4f7-5f64-4649-b1d2-70c4ec99ea12`, exact41.25/51.75 CASE quotes; byte/SHA256-matched originals; exact replay unchanged. |
| A1.7 closed-app scheduled recovery | Controlled retained attachment queued15:34:02; cron356 fired15:35; HTTP371 returned200; same partial document,2items,2mappings,1quote. Dino confirmed all KERDOS tabs closed. Earlier15:30 closure claim withdrawn. |

Detailed durable evidence: `a1_image_ocr_deployment_review.md`, `a1_automatic_pdf_deployment_review.md`, `a1_mixed_receipt_verification_review.md`, `scripts/fixtures/ocr/hosted-results.json`, `scripts/fixtures/pdf/hosted-results.json`, `scripts/fixtures/mixed/hosted-results.json`.

The real forwarded horn.txt source has94 retained/mapped rows, no confirmed quoted-per basis, zero usable quotes and partial status. That is unresolved source evidence, not permission to guess units or require a client completion button. New mixed synthetic acceptance does not rewrite its historical outcome.

## Remaining required live observations — existing task only

1. **A1.3:** exact copying remains unverified because the signed-in view has no receiver/Copy control while future platform domains are unconfigured. Clipboard code checks pass. This is a future configuration dependency, not failed intake or a request to buy domains.
2. **A1.5:** October28 21:54 Eastern screenshot observes visible mixed fixture `295b5376-797e-4339-a478-160179d9298f`: sender a1-test@example.invalid, date10/28/2026, A1_Review_Mixed_Test.csv, Processed — clarification flagged, explicit quoted-per uncertainty and retained Item Catalog evidence; no Save/Complete Import/Review & Import. Exact time is absent. PR #22 commit `0c8cea93e85d1d6bfe09f18f87ef49d19ac8f2bf` adds it, with 7 mounted/full-suite/lint/build local passes. Deployment passed under PR22/run75; signed-in live time observation remains unverified. No new email, upload, Save, reassignment, reviewer correction or isolated-org membership change occurred.

Generic catalog confidence and eligibility counts already have Dino's screenshot evidence. A specific test item appearing in the rendered Order Guide has not been claimed. Independent fresh-email browser-closure timing and real-email image/PDF/mixed delivery remain unclaimed limitations, not new mandatory tests added by this reconciliation.

## Optional, deferred and housekeeping

- A1.4 outbound forwarding: optional live check.
- A1.6 and A1.7 reviewer resolution: optional live manual exception workflow.
- Owned receiving domains/DNS: deferred future platform configuration.
- HEIC: future format coverage, outside current scope.
- Historical branch reconciliation and retired diagnostic deletion: housekeeping.

Current A1 versions: inbound-emailv6, process-attachmentv13, recovery-sweepv5, image-textv3, pdf-textv1. Task2 vendor-price-pullv1 added; all existing A1 versions/hashes preserved. PR #20 did not change application deployment versions/hashes. Diagnostic `a1-review-fixture-seed` is retiredv16: unconditional410, JWT restored, no imports/credential/data access; not deleted.

## Sign-off boundary

No whole-Task1, Task2 or whole-module sign-off is made. The scoped automatic handoff evidence stands; the specific remaining A1.3/A1.5 boundaries above remain open. Task2 is in progress, not tabled. Do not rename/renumber tasks or reopen completed ingestion tests because of historical wording.

## Task 2 — Vendor Integration, original three requirements

| Requirement | Current implementation evidence | Remaining boundary |
|---|---|---|
| Store client vendor credentials securely per vendor | Actual Vault encryption/permissions/rotation/cleanup checks; deployed worker used generated synthetic source credential | Real customer/vendor enrollment and supplier authentication unverified |
| Scheduled or on-demand pricing pull | Hosted requests589/590 and job2/run556/HTTP591 passed; Task2 schedule removed after one observed run | Public controlled export, not an authenticated supplier portal |
| Automatically route pulled data into ingestion | Two new items/catalog links, exact41.25/51.75 CASE quotes, complete source/original, stable replay | Real supplier acceptance remains open; no whole-Task2 sign-off |

PR23 source52fe65b merged45b9cd3, CI76 successful. Migration20261029120659 installed and vendor-price-pullv1 ACTIVE.26 local checks/full suite/lint/build pass. Earlier actual rollback-database checks remain separate. Current hosted evidence and cleanup are in `a2_hosted_pull_results.json` and `a2_hosted_pull_verification.md`.

### Historical October29 follow-on — superseded where noted

PR22 merged/deployed as5a545ff; GitHub run75/40857406527 passed, public asset HTTP200 contains the new timestamp formatter/time element. This is deployment/asset verification, not a signed-in observation.

Task2 revision ea4747f fixes returning price-sheet A→B→A suppression with atomic source revisions and distinct import fingerprints. Immediate identical replay remains duplicate-safe.22 local checks and full npmtest/lint pass.

A proposed rollback-only live Task2 schema/Vault/replay check was rejected by automatic approval review. Reason: extensive temporary DDL, function/grant/trigger changes and synthetic data/Vault writes in shared kerdos-test still carry lock/side-effect/failure risk; explicit approval for applying the draft SQL live was absent. No SQL ran, no workaround/retry was attempted, and a read-only follow-up confirmed the draft source table/claim RPC remain absent. Explicit approval is needed before that exact live check; no hosted Task2 schema pass is recorded.

## Approved actual Task2 database test — PASS, October29

October29,2026 — APPROVED ACTUAL DATABASE TEST PASS for Task2. Dino explicitly approved rollback-only test with lock_timeout3s,statement_timeout15s,idle_in_transaction_session_timeout10s. First transport attempt returned expiredrequestState; unchanged baseline checked; identical approved retry succeeded. Actual kerdos-test assertions verified source organization/vendor ownership, immutable receipt values/source kind, immediate duplicate identity,A→B→A newrevision,service/client grants,finish and Vault credential cleanup. Full rollback independently verified: draft source table and claim RPC absent,source_kind column absent,isolated message count17/attachmentcount34 unchanged,zero vendor secrets,zero idle transactions,existing recovery cron active. No email/storage/network/worker/cron changes or permanent migration/function deployment. Evidence knowledge/a2_live_schema_check_results.json and exactSQL SHA2567b5a70d42c29ff1c2795519ddd808dbd6a69961d5d4b1fcf0025ba12d0307282. This supersedes the earlier approval rejection only for this approved test. Task2 live export-to-catalog/vendor acceptance remains open; no full-module completion claim.

## Task2 composed local import proof and staged deployment review

October29,2026 — Task2 composed export-to-importer LOCAL PASS, PR23 revision43a1bef93cd5fab0f94fb413bec5acaddc8c4b48.26 local executed checks now include production export adapter + actual source SQL in PGlite + real background importer/parser/catalog service. Fresh80CASE/4x10LB source creates one item/catalog/mapping,complete linked document and retained bytes. Identical replay produces no second quote/document/item/mapping.80→90→80 produces3source documents/fingerprints/quote calls on the same item/catalog link; all originals retained. Final unitcost2/lb; category remains the sole Order Guide blocker, no fabricated qualification. HTTP/storage/price-catalog writes are simulated, so this is LOCAL interaction evidence, not hosted saving or a real-vendor pass. Original A1 new-item checks remain passing using shared test persistence fixture. Full npmtest/lint/build PASS. Prepared fixed hostedCSV41.25/51.75 CASE,builtbyteidentical SHA25648bd73af0ac95696ab75be1be7b6dd8c710935deac0f7cd4a0da3281b50d9151; hosted deployment/isolated source/replay/scheduled test review in knowledge/a2_hosted_pull_deployment_review.md. That staged permanent test schema/function/cron scope exceeds earlier rollback-only approval; no new deployment/network/email/client action performed. Actual approved database rollback evidence remains separate. Task2 staysopen.

## Task2 staged hosted acceptance — current status, PASS

October29,2026 — Task2 staged HOSTED SYNTHETIC PASS. Explicit approval covers installed schema/function,PR23merge,controlled pulls/replay,one scheduled observation and exactcleanup. Migration20261029120659_a2_vendor_price_pull installed withlock3s/statement15s/idle10s; vendor-price-pullv1ACTIVE sha256bc0f06f3ba5888416d06da830fe884f6b5cf9ec4b4b455c13a3f4a5440edd533. PR23source52fe65b merged45b9cd35b95afaf300bf901b2cd267bbfcb3a293; clean CI76/40870901451 passed. Missing/wrong auth585/586401, authorizedempty587200. Public170byteCSV verifiedSHA25648bd73af0ac95696ab75be1be7b6dd8c710935deac0f7cd4a0da3281b50d9151. Freshrequest589200/auto_imported:receipt efc4029e-fc67-42ed-83e4-ebcf13e9bec1,attachment4cc0904b-bc4b-4ee3-893f-2c361c4c91e6,completedocbf0d090a-7e8a-4a70-b6fc-216f6783e483,row:0/row:1;2newitems/2catalogmappings/2quotes exactly41.25/51.75CASE,2/10LB,sourcefilename/originalretained. Replay590200/skipped preservedallIDs/values/counts and existingoriginal bytecomparison. Job2/run556fired08:15Eastern,HTTP591200/skipped,sameIDs/no duplicates; jobself-unscheduled. A1job1/run557also succeeded at08:15; allpre-existingfunctionversions/hashesunchanged. Actualrecordsreadinessunitcosts2.0625/lb/2.5875/lb;bothholdingcategorysoleblocker,nofalseGuideapproval. Cleanupverifiedsourceoff,syntheticcredentialremoved,zeroactiveTask2sources/Task2jobs,A1Vaultsecret/cronpreserved,alloriginals/dataretained. Automaticreviewrejectedbroader deletion/deactivation cleanup;noneofthoseextrachangesran;exactapprovedcleanupcompleted. Source/origin/dispatch/vendor metadata remain. Hostedpublicfixturedoesnotauthenticateupstreambearer,soNOTrealvendoracceptance/email/browserclosure. Details knowledge/a2_hosted_pull_results.json and a2_hosted_pull_verification.md. Remaining realvendorendpoint/authacceptance and A1.3/A1.5UIevidence stayopen.
