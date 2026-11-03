# A.2 Refresh prices — companion 0.2.7

## Result and scope

After the user enables provider-specific companion access once, the selected
saved connection offers **Refresh prices** in KERDOS. The app saves/verifies its
account/list selection and creates a fresh one-use handoff internally. The
companion pairs that exact nonce, finds one verified matching vendor list,
reserves the export through the existing admission check, captures its CSV and
delivers through the unchanged hash/ownership/ingestion path. Repeated toolbar
Pair and Send actions are no longer needed for this supported flow.

One active saved browser connection is selected on page load; multiple active
connections still require explicit vendor/provider choice. Account/list labels
remain organization/vendor/provider/request scoped. The legacy toolbar/manual
transfer remains available for older clients or declined optional access.

## Permissions and boundaries

The shipped Chrome host retains activeTab/scripting/storage for the legacy
flow. A static isolated content script runs only in the top frame of the approved
KERDOS deployment. Its page control channel accepts a fresh nonce only, never
credentials, source bytes or client/vendor IDs. The worker checks its own
extension sender, top frame and both sender/tab approved URLs. Pairing returns
the app-owned assignment, and its nonce must match the command before any vendor
navigation or export. Replayed, cancelled or superseded tickets cannot claim a
successor. Existing selection-revision checks run at pair/export/receive.

Optional host access is requested synchronously from a user click in the
extension popup, for the KERDOS hosting origin and the selected registered vendor
origin only. Chrome applies host grants at origin scope; code still restricts
the KERDOS repository path. There is no all-sites grant, tabs/cookies/debugger
permission, credential extraction, auth-token storage or new server endpoint.
Declined/revoked access stops refresh and directs the user to one-time setup;
it never silently falls back to exporting through a different tab.

Provider DOM/route knowledge stays in approved provider metadata/adapters. The
portable runner receives a host source-resolution capability and keeps the
claim/delivery protocol. Other hosts/providers can implement that capability;
this increment does not deliver a desktop/Safari/Firefox host or scheduling.

## List discovery, reopening and verification

The host inspects at most ten tabs on the exact provider origin without export
clicks. It requires one exact visible account/list match; multiple matches stop.
After a verified match it retains only the approved list pathname under a key
containing organization/vendor/provider/account/list. No CSV, query string,
fragment, credentials or full navigation URL is stored. A route hint belonging
to a different client/vendor/account/list cannot be reused.

If no matching tab exists, a verified saved route can be reopened automatically.
An initial connection without a route opens the approved portal for direct
sign-in/list selection. Reopening is bounded by 20 seconds and ticket expiry;
it pauses on visible login/MFA, wrong account/list or unreadable pages. It never
selects an account by guess, enters passwords/codes, performs order actions or
continues unattended after a verification failure. The user completes the vendor
step and explicitly clicks Refresh prices again. Failed exports consume the
pairing; restarts retain uncertainty and never replay exports automatically.

This is user-started refresh using an existing browser session, not unattended
account login, a schedule or proof of supplier API authorization. The existing
claim, exact-byte hashing, retained original read-back, duplicate handling,
source history, grouping and purchasing policies are unchanged. No database
schema/data reset, paid service, runtime model/AI or Order Guide/basket changes.

## Verification

Controlled portable/host tests cover a single refresh through pair → claim →
export → delivery, denied grants before pairing/vendor access, stale expected
nonce, competing commands, revoked admission, duplicate tabs, scoped route hints,
unsafe route rejection and a sign-in pause. Content/worker tests reject wrong
origins, frames and senders; the popup test verifies the synchronous narrow
permission request. The actual rendered Vendor Connect page exercises saved
selection, one-click preparation through the real handoff, permission guidance
and late completion after a selection change. Existing manual/restart/expiry/
quote/import regressions remain in test:a2 and the full suite.

The native Chromium harness uses the exact shipped manifest and actual content
script/worker/provider execution with synthetic app/vendor pages. Initial optional
access is denied; declared origins are then preauthorized through Chrome's management API **only in the disposable test profile**, activated by the actual companion permission button, and revoked through Chrome's permissions API. This is native permission
and one-click execution evidence, not an observation of human prompt approval.
It checks pairing/export/delivery without toolbar clicks, duplicate-tab refusal,
saved-route reopening and a sign-in pause. No fixture network request reaches a
real supplier or database. Installed-user acceptance with 0.2.7 remains separate
from the successful real 0.2.6 transfer already recorded in the task list.

Native fixture transport note: external DNS is blocked in the disposable browser. Chrome can start an extension-created navigation before Playwright attaches interception; the harness serves the same saved route through its controlled navigation once attached, while the real companion performs its bounded discovery/export. This is synthetic portal-response setup, not installed-user supplier evidence.
