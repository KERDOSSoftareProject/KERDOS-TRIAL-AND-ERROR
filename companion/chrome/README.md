# Vendor Connect local browser pilot — 0.2.1

This unpacked Chrome prototype adds a preflight-reserved one-use transfer to a signed-in KERDOS
tab. The app changes and database drafts must be deployed before testing it.
The previous 0.1.0 export-only pilot remains historical evidence; installing
0.2.1 alone does not upgrade the live KERDOS application.

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
   export. Keep the popup open until it reports a result.
5. Return to KERDOS for the normal import review/save result. A receipt means
   received for review, not that prices were saved.

This pilot still requires installing/reloading the unpacked extension through
chrome://extensions. That is a developer pilot process, not a finished client
installation experience.

## Boundaries

Permissions are activeTab, scripting and storage. Pairing metadata lives in
chrome.storage.session, which is restricted to trusted extension contexts by
default. There are no cookies, download-history, background, all-sites or
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
no new site access, background process or credential storage is requested.
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
