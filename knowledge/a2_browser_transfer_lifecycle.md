# Task 2: Chrome pilot transfer lifecycle

Pilot acceptance is the active priority; further accounting expansion is paused.
The native row-86 heading defect was already fixed in PR59, followed by Dino's
87-row Chrome transfer and save. Preserve that repair and its repeated-header,
multi-table and 347-row controlled-document evidence. Do not reopen it as a
current blocker or equate first-save acceptance with the remaining lifecycle work.

The receiver previously enforced expiry/replay but left the app displaying
Transfer ready after expiry or rejection. The receiver now publishes ready,
receiving, received, rejected, expired and cancelled states. A bounded timer
expires the ten-minute ticket even without incoming messages, and delivery also
checks wall-clock expiry so throttled background timers cannot extend acceptance.
No state automatically prepares, pairs, exports, retries or saves another import.

The page reports expiry/rejection with explicit prepare-and-pair recovery. It
reports received only for import review, never saved prices. Selection, account,
list, backend, role or transfer-eligibility changes cancel the old receiver;
inactive vendors and removed import callbacks revoke eligibility. A per-transfer
generation prevents late callback results from changing a newer transfer's state.
Unmount removes the receiver and timer. Expiry/cancellation during hashing cannot
enter the importer. Cancellation after an importer callback has already been
admitted cannot retract that review: its receipt remains received_for_review,
but it cannot overwrite the cancelled/new page state or claim saved prices.

The deployed app remains compatible with the installed 0.2.0 companion; no
extension package, permissions, registry, vendor adapter, database, worker or
Order Guide change is required. No new AI call, paid service, stored credential,
OTP handling or supplier order action is introduced.

Executed controlled tests cover proactive and message-observed expiry, hashing
interruption, replay rejection, receiving/rejected/received distinctions, timer
cleanup, late admitted completion after cancel/reprepare, vendor deactivation,
selection change, latest import callback, tenant/role boundaries and unmount.
Real-reader/segmenter regression still checks all 87 synthetic product rows and
genuine repeated/reordered tables. These are code/rendered tests, not installed
Chrome or supplier-session acceptance.

Live continuation requires the signed-in test KERDOS tab and the user's installed
Chrome companion. The available cloud browser currently displays KERDOS Sign In.
Repeat/changed-price retrieval, expired supplier session/MFA, cancellation, closed
app tab and interrupted popup remain open until observed with that environment.
No supplier fixture or pilot price is changed by this repair.
