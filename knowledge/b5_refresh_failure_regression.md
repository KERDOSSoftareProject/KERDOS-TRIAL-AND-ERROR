# B5 — clean-save refresh failure must not emit success

Aristotle identified a missing PR35 regression case: a clean price-list save
followed by a rejected parent refresh. The modal displayed the refresh warning,
then still called onFinished because cleanFinish described the save, not refresh.

In the main application onFinished sets a success toast; it does not directly
close the modal. Other consumers may close or advance their own workflow. The
confirmed defect is the success signal after refresh failure; no lost data or
observed main-app modal dismissal is claimed.

Only emit completion after onDone succeeds. Keep the already-persisted result
visible during refresh, keep the warning and Done visible on failure, and do not
repeat any original/document/quote write. Existing delayed-success and partial
failure checks remain, with one added clean-save/rejected-refresh rendered case.

No database, matching, billing-unit, purchasing-eligibility, worker or schedule
changes. Hosted failure injection is unnecessary; component evidence is separate
from Dino's earlier live report of a noticeably faster result screen.

Validation: the added test failed against deployed PR35 (one success callback
after refresh rejection) and passes with the fix (zero callbacks, warning and
Done retained, one original/document/quote write only). All20 rendered upload
checks, full npm test including lint, production build, and diff checks pass.
These are local rendered tests with simulated persistence; no live refresh
failure or hosted data mutation is claimed. Deployment awaits review/approval.
