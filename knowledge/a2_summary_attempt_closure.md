# Task 2: permanent closure of an unconfirmed summary save

An owner/manager can now close a retained summary-classification request even
when its predecessor is still current. The recovery form requires separate
confirmation. The server binds the original actor and exact review/request,
then returns either its already-saved historical result or an immutable closed
attempt. Closing never changes classified source, invoice evidence, approval,
payment or the classification revision chain.

invoice_summary_closed_attempts preserves the request, original review, actor and
time. Member reads and owner/manager inserts use RLS. Only reviewed inputs can be
inserted; audit fields are protected and update/delete are denied. Org/request
uniqueness and an invoice index cover request lookups and the parent FK. The new
functions are invoker-only and anonymous/worker access is revoked.

Closure and save acquire order-line locks, invoice-header lock and the same
request advisory lock. BEFORE INSERT guards cover classifications and closed
attempts, including legacy save RPCs and direct inserts. Once closure commits,
late saves of that request reject permanently. If save commits first, closure
returns its exact original record and never creates a contradictory marker.
Identical closure retry preserves identity; changed actor/review/scope rejects.
A late failure rolls the marker and fence back together.

Fresh recovery context includes closed attempts separately from classified
source/history. Clients independently check scope, original review, actor,
duplicates and saved/closed exclusivity. A known marker settles the local journal
without resubmitting. Closure with an unknown response keeps the original request
for refresh/remount or identical closure retry. A saved response is recovered as
history and cannot reactivate an earlier revision. A first SQL save rejection now
also keeps its canonical request; closing explicitly fences any retry in another
tab before different details are reviewed. Settled legacy failed markers can be
upgraded by verified server results; closed markers dominate local supersession.

The UI shows closed-attempt history. Superseded requests retain the earlier local
proof-based closure, while a still-current request uses the new server fence.
Storage failures and failed history reads keep recovery data. Neither closing nor
reading creates a classification, approval, invoice payment or supplier message.

Validation covers role/actor/confirmation, exact/conflicting closure retry,
legacy/direct late-save denial, protected audit fields, immutable records,
already-saved recovery, unchanged reconciliation evidence and late rollback.
Rendered tests cover explicit close consent, SQL-rejected saves, lost close
request/response, history-after-close failure, reload without automatic writes,
identical retry and a delayed save winning before closure. Six real PostgreSQL
races extend 42 to 48: close/save in both orders through commit/rollback, and exact
closure commit/rollback replay. Every race proves a lock wait and independently
checks that saved and closed outcomes cannot coexist. The hosted rollback fixture
checks closure/replay, both late-save paths, historical recovery and unchanged
financial gates before removing all fixture rows.

This closes the unconfirmed summary request lifecycle without requiring an
artificial newer classification. Actual signed-in hosted/browser/supplier
acceptance, further race combinations, remaining source/amount/receipt corrections,
credits/allocations and bank evidence/settlement remain open. Task1 remains
code/database complete awaiting domains; Task2 remains open.
