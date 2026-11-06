# Companion 0.2.12 · Refresh prices

The MOXē adapter also recognizes the published two-pane download modal by its exact selected-list title, including wrappers without their own layout box. Multiple matching dialogs still stop the export.

Discovery now preserves fixed account-recognition, list-recognition and page-
inspection failures for a single already-open approved list page. It no longer
reports every failure as an instruction to open that list. A verified match
always wins over other tabs; failed or ambiguous pages cannot export or cache
a route. No raw page content or errors are reported or stored. This improves
failure classification; it does not prove the installed recognition issue is fixed.

## Connect after enabling — 0.2.10

Enabling Refresh prices now reconnects already-open approved KERDOS tabs using
the shipped control channel. A page reload is unnecessary when attachment
succeeds. Repeating enable does not install a second command listener. Access
denial touches no tabs; a closed/inaccessible app tab gives reload guidance.
This action never prepares, exports, delivers or retries pricing. It does not
add scheduling, keep-alive behavior, host permissions or automatic supplier access.

## Product Prices labels — 0.2.9

Version 0.2.9 recognizes the Product Prices checkbox by its own primary label,
including the nested Ionic label, before considering its enclosing text. A
parent containing several download options no longer hides an exact label.
After a click, confirmation re-reads the current unique labelled control so a
replaced component host does not leave the check waiting on a detached node.
Exact matching and ambiguity guards remain; other export options are untouched.
Reload the complete folder, then refresh KERDOS before installed acceptance.

## Export-dialog recovery — 0.2.8

Version 0.2.8 reuses one open download dialog for the selected list and leaves an
already enabled Product Prices option enabled. A fresh explicit retry no longer
mistakes the page and modal Download buttons for ambiguous controls. Multiple
matching dialogs or pricing checkboxes still stop the export. Fixed guidance now
identifies download-dialog, Download Options, Product Prices or final Download
failures without recording page content or raw diagnostics. A failure never
automatically retries. Reload the complete folder, then refresh KERDOS; existing
site permissions, client/vendor binding and one-use handoff remain unchanged.

The first installed 0.2.7 failure was reported with a shared generic message;
its precise export substep is not established. The open-dialog retry defect is
reproduced separately. Synthetic tests are not real-supplier acceptance.

Install the complete folder including adapters and core. Enable only this version, then refresh the KERDOS tab. In the K popup, choose the provider and click **Enable Refresh prices** once to grant access to the KERDOS host and that vendor portal. Open the correct account/list with the vendor for initial setup. Later use **Refresh prices** in KERDOS; preparation, pairing, export and processing run through the existing checked handoff. The verified list route can reopen when its tab is closed. Login/MFA pauses for the user; no password/code is read or stored.

This is user-started Chrome-host refresh, not unattended login, scheduling or a delivered universal desktop host. Legacy manual instructions below remain a fallback.

# Vendor Connect local browser pilot — 0.2.6

This unpacked Chrome prototype adds a preflight-reserved one-use transfer to a signed-in KERDOS
tab. It uses the existing deployed protocol-v2 KERDOS app and its connection checks.
The previous 0.1.0 export-only pilot remains historical evidence; installing
0.2.6 does not change the live KERDOS application.

The client signs into the vendor directly and completes verification there.
The selected client/vendor comes from KERDOS, with account/list labels entered
for this transfer. No account numbers, list IDs or client names are constants.
No AI calls, paid service, login automation or order actions are involved.

## Reviewed pilot workflow

1. In KERDOS Vendor Connect, select the vendor/provider and prepare its setup.
2. Enter the vendor's displayed account and list names, then Prepare browser
   transfer. This creates an in-memory ten-minute, one-use assignment.
3. Click K on that KERDOS tab and Pair this KERDOS tab.
4. Open the signed-in selected vendor pricing list. Click K, then Send pricing
   to KERDOS. The companion first reserves the still-valid app ticket. A closed,
   reloaded, cancelled, expired or incompatible receiver stops before vendor
   export. The companion continues the bounded transfer if its popup closes; reopen K to see the current result. Keep the KERDOS and vendor tabs open.
5. Return to KERDOS for the automatic import result. A receipt means
   received for review, not that prices were saved.

This pilot still requires installing/reloading the unpacked extension through
chrome://extensions. That is a developer pilot process, not a finished client
installation experience.

## Boundaries

Permissions are activeTab, scripting and storage. Pairing metadata lives in
chrome.storage.session, which is restricted to trusted extension contexts by
default. The extension uses a module service worker for the explicitly started transfer. There are no cookies, download-history, all-sites or
remote-script permissions. Storage contains no passwords, auth tokens or CSV.
No permanent content script or externally_connectable endpoint is registered.
The approved KERDOS deployment URL is in bridge.mjs; other installations require
an explicit reviewed allowlist change. There is no arbitrary URL input.

The MOXē adapter detects visible password/verification fields before list/account
checks, then checks the account/list, CSV choice and Product Prices. In the
page's MAIN world it temporarily observes URL.createObjectURL during that export
and copies an eligible bounded CSV Blob only when its object URL is used by
a download anchor whose CSV filename matches the selected list. It restores the URL/anchor hooks on
success, failure or ten-second timeout. The ordinary browser download still
occurs; the client does not need to select the downloaded file for upload.
If MOXē uses another export mechanism or its markup changes, capture stops
without sending anything. This mechanism is locally tested, not live verified.
Unrelated CSV Blobs and mismatching download filenames are ignored. The
page could still supply misleading bytes; this is not a vendor signature. Page-controlled bytes are a user-approved browser claim,
not a supplier signature or trusted server vendor_pull message.

The isolated KERDOS bridge accepts extension-internal messages only. The app
checks same-window/origin messages, nonce, expiry, byte limit, UTF-8 and CSV shape;
reserves the ticket before asynchronous work; computes SHA-256; and assigns only
its closed-over organization/vendor. The artifact cannot override ownership.
Cancel, selection change, page unmount/sign-out and expiry invalidate the job.
Leaving this Vendor Connect page before delivery requires a new transfer.
The existing importer retains the original file and immutable retrieval evidence
before applying new prices; missing evidence schema blocks saving. Existing
manual documents are not relabelled. Existing duplicate/import-resume rules apply.

## Open acceptance

The first 0.2.0 live transfer saved 87 rows after PR59; repeat/lifecycle and
0.2.1 preflight acceptance are still separate. Test installed 0.2.1 against the real supplier and deployed KERDOS, comparing
source bytes and resulting scoped records. Test wrong account/list, cancellation,
closed app tab, MFA, changed portal markup, interrupted popup and repeat delivery.
The local controlled DOM/Blob/bridge/SQL tests do not establish these live passes.

Official API references: [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting),
[storage.session](https://developer.chrome.com/docs/extensions/reference/api/storage),
[activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).


## Update from 0.2.0

Use the new reviewed 0.2.1 folder for the existing unpacked pilot and reload it
on Chrome's Extensions page. Permissions remain activeTab, scripting and storage;
no new site access or credential storage is requested. Version 0.2.2 adds the bounded transfer service worker described below.
Refresh the deployed KERDOS app, then prepare and pair again. Old pairing metadata
is not upgraded automatically. This developer pilot update is not a universal
extension installation/update experience.

The pre-export claim binds a fresh random attempt ID to the app's original nonce.
Only one attempt may reserve that transfer; delivery must carry the same ID.
Closing/reopening the popup cannot reuse a consumed pairing. Once a new companion
has claimed a transfer, an old unclaimed delivery cannot bypass its reservation.
A read receipt still means import review only, never saved prices. Older 0.2.0
companions can continue unclaimed delivery to the upgraded app, but do not gain
the 0.2.1 preflight protection until updated. A 0.2.1 companion requires the
upgraded app's protocol acknowledgement and stops safely against older app tabs.

The reservation is a point-in-time check. If the app closes or is cancelled
after the acknowledgement, supplier export may already be underway; the
existing nonce/expiry/cancellation fences still prevent an invalid import.


## Popup-independent transfer — 0.2.2

Replace the existing pilot folder with this complete 0.2.2 folder and reload the
unpacked extension. No KERDOS app, database, worker endpoint or provider setup
change is needed. Refreshing the website alone does not update the companion.

An explicitly started pair/export is now owned by the extension service worker.
The popup sends a command and observes session-stored status. Closing/reopening
the popup neither cancels nor resends the operation. Only one command can own the
executor at a time; a second popup sees its current status. Provider execution,
pre-export app reservation, one-use claim, source checks and delivery remain the
same. The worker accepts commands only from this extension's exact popup URL;
content scripts and other extensions cannot direct it.

Only status text and the existing pairing metadata are retained in session
storage. CSV bytes stay in memory during delivery; passwords, cookies, MFA codes
and session tokens are not read or stored. The manifest retains only activeTab,
scripting and storage permissions. This is still the Chrome pilot behind the
shared transfer contract, not the completed universal desktop companion.

The browser may stop the service worker. On restart, an unfinished status becomes
an unconfirmed result and any pairing is removed. It does not resume or resend
an export or claim prices saved. Check KERDOS before preparing another transfer;
existing import replay protection remains responsible for an admitted file.
There is no keep-alive, scheduler or unattended supplier access. Closing the app
or vendor tab is different from closing the popup and may stop the operation.

Controlled tests use the real worker, runner and popup modules: closure/reopen,
status/result continuity, concurrent commands, restart uncertainty, sender
restrictions, rejected/closed/expired receiver and MFA guidance. All A.2 tests
pass locally. Actual installed 0.2.2 popup closure and supplier acceptance remain
open, as do fresh/changed-price and private original-byte live checks.

Implementation references:
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/develop/concepts/messaging


## Completion ownership — 0.2.3

Version 0.2.2 could publish a ready/terminal status while its previous execution
lock was still held. An immediate Pair command could see the old busy state and
leave the popup disabled. Version 0.2.3 releases that ownership before publishing
ready, returns an immutable status snapshot, and never clears a newer command's
lock from an older command's completion.

Replace/reload the complete 0.2.3 pilot folder before installed acceptance.
Permissions, app protocol, provider export, one-use claims and storage boundaries
are unchanged. No KERDOS website, database or hosted-worker update is needed.
A deterministic regression reacts immediately to the terminal storage event and
pairs again before the old write promise resolves; it fails against 0.2.2.
The native Chromium suite also uses the exact shipped manifest and native toolbar
activation, with no fixture-origin host grants. Actual signed-in supplier and
installed-client acceptance remain separate from synthetic browser tests.


## Portable runner foundation — 0.2.4

`core/transfer-runner.mjs` owns one-use orchestration, status ownership and
restart recovery without using browser APIs or a provider registry. The Chrome
`transfer-runner.mjs` adapter supplies targets, session persistence, approved
provider dispatch, pairing, reservation and delivery. Existing stored pairing
keys, message protocol, permissions, CSV handling and status wording remain
compatible. The portable core is inside this folder so the complete unpacked
Chrome package remains self-contained.

A browser-free synthetic host with string handles and two provider identities
checks reuse; it is not an implemented desktop companion. Desktop, Safari and
Firefox hosts, secure transport, client installation, supplier authentication
and any scheduler still require their own implementation and acceptance. No
background retrieval or automatic resend is introduced. Replace/reload the
complete 0.2.4 folder for installed acceptance; include the `core` subfolder.


## Export failure guidance — 0.2.5

Known adapter outcomes now explain account/list mismatch, missing CSV format,
concurrent or unavailable capture, unsupported text encoding, invalid CSV and
changed/unverifiable pages. Messages are fixed application text; raw adapter
diagnostics are never displayed or retained as status. Unknown outcomes keep
the generic failure guidance. No failure automatically retries or delivers a
file, and a new prepared/paired transfer is required after the attempt.

The MOXe adapter now reports unsupported encoding explicitly instead of
mislabeling a strict UTF-8 decode failure as an unavailable page. It does not
replace characters, convert bytes, or add Windows-1252 support. Keep the original
file for review. Protocol, narrow permissions, successful transfer handling and
the app-owned client/vendor assignment are unchanged. Reload the complete 0.2.5
folder (including core) for installed acceptance.


## Failed-export receiver recovery — 0.2.6

Updated KERDOS tickets advertise exportFailureNotice. After an accepted claim,
a failed capture or pre-delivery execution error sends a nonce/claim-bound
notice so that exact receiver clears its exporting state immediately. The app
uses its existing rejected state and Prepare control. No diagnostic text, CSV
or credentials are sent in the notice. Once byte processing or delivery starts,
this notice cannot retract admitted work or rewrite a received result.

The host callback is optional; old app tickets skip it. Missing/closed receivers
do not turn a failed export into success. No automatic retry is introduced.
Refresh the KERDOS page and reload the complete 0.2.6 companion folder to use
the matched recovery behavior. App tabs or companions on earlier versions retain
their prior cancellation/expiry behavior.
