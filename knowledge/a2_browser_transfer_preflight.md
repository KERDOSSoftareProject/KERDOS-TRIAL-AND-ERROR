# Task 2: companion pre-export reservation

The 0.2.0 popup began the supplier export before discovering that its paired
KERDOS page was closed, reloaded, cancelled or expired. The app already rejected
late delivery, but could not prevent that wasted export. Companion 0.2.1 asks the
isolated bridge to reserve the app's exact one-use nonce before calling any
supplier adapter. The app serially accepts one fresh UUID claim, returns only a
ready_for_export acknowledgement, and requires that claim on delivery. Legacy
unclaimed delivery remains compatible only when no reservation exists. Claiming
neither hashes/imports a file nor extends the ticket lifetime.

The page displays exporting separately from receiving, receipt, failure and
expiration. Existing generation fencing, timer cancellation and tenant-selected
ownership remain in force. A rejected/missing receiver stops before supplier
export. A ticket from an older app version is discarded with refresh/prepare/
pair guidance. Pairing is removed before supplier execution so popup reopening
cannot silently repeat an export. Interruption after claiming can still leave a
used ticket: prepare a new transfer. No automatic retry or saved-price claim.

The MOXe adapter now checks visible password/one-time-code fields before its
list/account checks, including redirects away from a list. It never reads those
field values or enters credentials. Unsupported or changed verification markup
still stops safely through the existing context checks; universal session/MFA
recognition is not claimed.

Controlled tests execute the actual popup module with Chrome API doubles and the
real receiver/isolated bridge. Cases include closed/rejected/expired/old receiver,
claim-before-export order, exact claim delivery, competing reservations, wrong
nonce/claim, legacy-bypass denial, sender isolation, popup reopen after pairing
consumption, verification guidance and original Blob capture/cleanup. The
installed Chrome/supplier acceptance gate remains open. Further accounting
expansion remains paused; use the existing US Foods list for the next live check.

No new extension permission, background worker, scheduler, paid service, runtime
AI, stored credential, supplier order, database mutation or approved Order Guide
change is introduced. The app and extension update are a reviewed pair; users
must reload their own unpacked companion to obtain the new preflight behavior.

The reservation is a point-in-time check. If the app closes or is cancelled
after the acknowledgement, supplier export may already be underway; the
existing nonce/expiry/cancellation fences still prevent an invalid import.
