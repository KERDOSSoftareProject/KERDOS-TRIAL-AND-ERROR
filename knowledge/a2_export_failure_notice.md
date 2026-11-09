# A.2 failed-export receiver recovery — companion 0.2.6

## Defect and result

After pre-export reservation, an adapter failure previously completed the popup
with safe guidance but left the KERDOS receiver exporting until cancellation or
expiry. The receiver now advertises exportFailureNotice on protocol-v2 tickets.
The updated companion reports a pre-delivery failure to the exact nonce/claim;
the app enters its existing rejected state, disposes expiry and clears armed UI.
A fresh transfer can be prepared without waiting for the old expiry.

## Boundaries

The new export-failed message is accepted only for an active exporting receiver
with an accepted non-null claim, exact nonce/claim match and no reserved byte
processing. Unclaimed, wrong, stale, expired or duplicate notices cannot stop a
transfer. Once deliver reserves byte work, failure notices cannot interrupt
hashing, validation or an admitted import, or downgrade a received result.
The notice reduces capability and performs no import/database operation, so it
does not need an additional network admission check.

The isolated bridge accepts export failure messages only from its own extension
and forwards nonce/claim, with no artifact or diagnostic. The Chrome host sends
kerdos-export-failed; the portable core calls its optional reportFailure only
when the ticket explicitly advertises support. Old tickets skip the notice.
A disappeared receiver or failed notice does not replace the original failure
with a success. No notice is sent after delivery has begun: a lost receipt may
represent an admitted import and must remain uncertain, not be retracted.

## Verification

Receiver tests cover unclaimed/wrong/stale notices, rejected late file delivery,
a successor reservation protected from an old notice, hashing and admitted review
protected, plus the real isolated sender guard and no diagnostic forwarding.
Portable-host tests cover failed outcomes, thrown capture, unavailable receiver,
legacy compatibility and ambiguous delivery. Rendered Vendor Connect verifies
armed controls clear and Prepare remains available. Native Chromium asserts
rejected app state after wrong-account and verification failures, with zero new
exports/receipts and all existing transfer/recovery tests retained.

Refresh the app and reload the complete 0.2.6 companion folder to use the matched
behavior. Earlier versions remain compatible with their prior cancel/expiry
path. No app layout, purchasing rules, database/schema/customer-data, permissions,
credential handling, automatic retries, scheduling, paid service or runtime AI
change is introduced. Installed supplier/fresh saved-price/original acceptance
remains open; native synthetic execution is separate evidence.
