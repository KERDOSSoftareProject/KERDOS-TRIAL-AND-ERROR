# Module A — Interaction Gate Results

Application: KERDOS → Division I · Procurement → Module A · Pre-Ingestion  
Governing task list: v60, October 29, 2026 UTC / October 28 Eastern  
Repository baseline: main through PR #20, merge `147af6053241c1963230b11cf12d929cf9166ada`  
Environment: kerdos-test `gwtnaudjfoxjermhvhpx`

## Current decision

Scoped automatic processing evidence remains passing. **Whole Task 1 remains open**: A1.3 live copying depends on a displayed receiver after deferred platform configuration; A1.5 sender/date/clarification/status-only presentation is now observed, but received time was absent. PR #22 fixes that time display and passes local checks; it is not deployed. **Task 2 is now authorized and has a tested implementation draft in PR #23**, with no real vendor endpoint/credentials or hosted acceptance yet.

This reconciliation preserves the existing A1.1–A1.7 numbering. The original reconciliation changed documentation only. The follow-on code drafts are separately identified below; neither changes the deployed app, schema or workers. A passing code/database checkbox does not certify its separate live browser observation.

## A1.1–A1.7 under their actual labels

| Number | Governing responsibility | Passing evidence | Remaining live/scope boundary |
|---|---|---|---|
| A1.1 | Automatically provision receiving addresses identifying client, vendor and document type | PR #8: 12 PostgreSQL provisioning/permissions/lifecycle checks and 4 rendered context/no-client-write checks; deployed trigger/config migration; actual tagged Postmark routes preserve receipt ownership/type | Owned production domains/DNS are deferred and do not block testing. No claim of owned-domain delivery. |
| A1.2 | Automatically process emailed attachments using registered client/vendor/type | Receipt snapshot/immutability/permissions 17 database checks; durable handoff and active/stale lease checks; actual CSV price-sheet/invoice delivery; new/existing item/catalog retention; validated atomic invoice; PR #18 images, #19 PDF and #20 mixed hosted acceptance | XLSX reader coverage is executed local code evidence, not a hosted XLSX email pass. Image/PDF/mixed hosted results are not new real-email sends. |
| A1.3 | Client can provide routing address to vendors | Clipboard code checks cover exact address, success after clipboard resolution and honest failure | **CONFIGURATION-DEPENDENT:** Dino’s signed-in Price Sheets view shows no address/Copy control while future domains are unconfigured. Exact copy remains unverified; no invented address, domain purchase or client setup is required to continue other work. |
| A1.4 | Optional forwarding copy to client email | 19 code checks; processing/forwarding exception handoff tests | Actual outbound copy is OPTIONAL/UNVERIFIED; not an automatic intake blocker. |
| A1.5 | Inbox displays received email, timestamp, sender and processing state | Routing/service tests and mounted production adapter checks; PR #17 automatic receipts are status-only without manual import controls | Dino’s signed-in Inbox screenshot confirms sender/date/filename/clarification and no manual import controls. **Time absent:** PR #22 supplies date/time/seconds/timezone; 7 mounted/full-suite/lint/build local passes. Draft, not deployed/live observed. |
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
2. **A1.5:** October28 21:54 Eastern screenshot observes visible mixed fixture `295b5376-797e-4339-a478-160179d9298f`: sender a1-test@example.invalid, date10/28/2026, A1_Review_Mixed_Test.csv, Processed — clarification flagged, explicit quoted-per uncertainty and retained Item Catalog evidence; no Save/Complete Import/Review & Import. Exact time is absent. PR #22 commit `0c8cea93e85d1d6bfe09f18f87ef49d19ac8f2bf` adds it, with 7 mounted/full-suite/lint/build local passes. Deployment/live time observation remains unverified. No new email, upload, Save, reassignment, reviewer correction or isolated-org membership change occurred.

Generic catalog confidence and eligibility counts already have Dino's screenshot evidence. A specific test item appearing in the rendered Order Guide has not been claimed. Independent fresh-email browser-closure timing and real-email image/PDF/mixed delivery remain unclaimed limitations, not new mandatory tests added by this reconciliation.

## Optional, deferred and housekeeping

- A1.4 outbound forwarding: optional live check.
- A1.6 and A1.7 reviewer resolution: optional live manual exception workflow.
- Owned receiving domains/DNS: deferred future platform configuration.
- HEIC: future format coverage, outside current scope.
- Historical branch reconciliation and retired diagnostic deletion: housekeeping.

Final application versions: inbound-emailv6, process-attachmentv13, recovery-sweepv5, image-textv3, pdf-textv1. PR #20 did not change application deployment versions/hashes. Diagnostic `a1-review-fixture-seed` is retiredv16: unconditional410, JWT restored, no imports/credential/data access; not deleted.

## Sign-off boundary

No whole-Task1, Task2 or whole-module sign-off is made. The scoped automatic handoff evidence stands; the specific remaining A1.3/A1.5 boundaries above remain open. Task2 is in progress, not tabled. Do not rename/renumber tasks or reopen completed ingestion tests because of historical wording.

## Task 2 — Vendor Integration, original three requirements

PR #23 (`0050403774bfac2d8a1e6bc4489782c211f0d4a4`) implements a draft for private per-organization/vendor Vault credentials; due/on-demand leased read-only HTTPS export pulls; and retained original/content-keyed receipt/automatic A1 worker handoff. Twenty local executed adapter/SQL checks pass, including actual entrypoint auth, rejected login pages/private networks/oversize sources, duplicate identity, byte conflicts, stale leases, credential rotation/removal and scheduler dispatch SQL. Full npm test, lint and build pass locally.

Actual kerdos-test Vault encryption/decryption assertions also passed with a disposable synthetic secret in a rolled-back transaction; removal was confirmed. Local Vault/HTTP tests remain simulated and are not hosted portal acceptance.

Schema/function/cron are NOT deployed. The first adapter supports an explicitly approved read-only HTTPS export with Basic/Bearer auth; arbitrary interactive/MFA/cookie portal login is not implemented. No real vendor endpoint or authorized credentials have been supplied. No vendor API is invented and no actual vendor integration is marked complete. Deployment sequence, limits and rollback are in PR #23 knowledge/a2_vendor_integration_review.md. Existing application function versions and earlier evidence remain unchanged.
