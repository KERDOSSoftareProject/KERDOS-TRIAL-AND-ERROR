# Task 2: durable recovery of summary-classification saves

An unconfirmed classification request is retained in browser recovery storage
before its save RPC starts. Each user, organization and request has a separate
entry; invoice filtering prevents unrelated requests entering the form. Exact
reviewed source, mappings, reason, predecessor, request ID and requesting actor
survive reload. No authentication tokens are stored. Read-only review/history
remain available if recovery storage cannot be used, but saving is held. A quota,
blocked write or failed read-back prevents a new RPC from starting.

The service attaches the authenticated actor to read contexts and prepared
requests. Retried requests must belong to the same currently signed-in user,
checked before the RPC and again against auth.uid() in an additive invoker-only
save wrapper. The original save RPC and database review payload stay compatible.
An account switch after browser preflight cannot persist under another actor. The recovery journal validates scope/identity/evidence, keeps
independent tab requests, refuses conflicting request reuse and detects malformed
entries. Settled entries become small result markers without retained invoice
text. Failed settlement never removes the pending request.

On opening or refreshing a classification, fresh complete history resolves each
retained request. An exact saved actor/request/review is settled locally without
another write, including an older record followed by later revisions. A missing
request remains unresolved while its predecessor is still current. Changing
source text alone never proves permanent closure: it could change back and the
original request could still apply. Reconfirmation is required before an exact
retry; no reading, mounting or recovery-list action sends a save automatically.

A missing request whose immutable predecessor has permanently been superseded
can be closed through Close superseded classification attempt. Clicking it reads
history again, validates actor and full lineage, and proves the old request can
never meet the current predecessor CAS. A later reset creates another identity;
it cannot restore an old predecessor. Closing records only a local result marker,
never a server revision, approval or payment. A failed read keeps the attempt.
If the request is found saved instead, recovery preserves its historical identity.
All pending attempts must resolve before this browser starts another classification
on that invoice. Multiple requests from racing tabs cannot overwrite one another.

Rendered tests cover unconfirmed save/remount/exact retry, no automatic writes,
lost-response recovery from history, superseded close/reload, failed fresh-read
closure, quota-before-RPC and read-only operation with storage unavailable.
Service/store checks cover user/client/invoice/request isolation, request/evidence
conflicts, full history validation, source-change non-proof, historical identity,
settlement compaction, corrupted storage and failed reads/writes. Actual SQL shows
an old request can apply after source-only reversion, but cannot apply after
successive immutable classification revisions; switching actors rejects before
RPC. The 42-session PostgreSQL suite now also exercises that closure proof.

An additive actor-bound save wrapper is the only database change; anonymous and
worker execution is revoked. No new table, credential, domain, worker or supplier/
bank operation is introduced. It reuses deployed immutable classification history and predecessor
checks. Browser storage may be cleared externally; recovery cannot preserve data
after external deletion or transfer unsaved requests between devices. Actual
signed-in browser/supplier acceptance, missing invoice source, remaining source
corrections/allocations and bank settlement stay open. Task1 remains code/database
complete awaiting domains; Task2 remains open.

Current follow-on: a still-current unconfirmed request can now be closed with
separate consent through a persistent server fence. A committed save is recovered
instead; late legacy/direct saves cannot bypass closure. SQL save rejections keep
the canonical request until saved, closed or superseded proof resolves it. See
a2_summary_attempt_closure.md.
