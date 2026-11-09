# A2.b.vi: receipt-bound completion

No schedule is enabled and no application path calls these RPCs yet. This
migration extends the inactive schedule foundation; it does not certify a
supplier login, verify an object-storage download, or change manual ingestion.

An import may cite `attempt_token` in its immutable retrieval evidence. An
AFTER INSERT trigger validates the server-owned token, organization, vendor,
request revision, current schedule version and exact adapter/account/list/origin
before stamping the attempt with that document ID and hash. Validation and the
stamp share the insert transaction: rejection rolls everything back. Untagged
manual and existing browser imports pass unchanged. A token cannot label a
second document. Cancellation/reconnection cannot revive a token.

The server derives completion from the bound record: `complete` means saved;
`partial` means received, with work retained for review; `processing` cannot be
finished as success. Evidence admitted before cancellation can still be
resolved afterward. A newly received, valid cited document may also resolve an
expired Unknown operation; lease expiry never grants another export.

Unchanged retrieval instead cites an earlier completed browser document plus
the current hash, with matching client/vendor/account/list/provider/origin.
This preserves the old document's immutable evidence. Its timestamp is only a
negative guard against substituting a newly created uncited document; the
identity checks use token, document ID and hash, never a timestamp window.
The current hash remains a client assertion under the existing browser-session
trust model, not supplier-authenticated evidence. This completion requires a
still-current claim; old unrelated content cannot clear an expired Unknown.

Failure/verification outcomes accept no success status and cannot replace a
stamped document or close an expired Unknown without evidence. Finished attempts
are immutable; an identical completion reply can be recovered without a write.
The historical document ID is deliberately not a cascading foreign key, so
existing Delete & re-import behavior remains available. It records which import
was received; it does not guarantee that the original still exists after a user
subsequently deletes that price sheet.

Public RPCs are invoker wrappers; private delegates explicitly authorize the
owner/manager and serialize on request then attempt. Private table grants stay
closed. Tests execute exact migrations on embedded and isolated PostgreSQL:
transaction rollback, cross-client/vendor/selection rejection, untagged imports,
reused citation rejection, immutable evidence and finish, exact replay hashes,
late resolution, cancelled/reopened requests and retained deletion identity.

Remaining A2.b.vi work: owner-readable history with accurate Missed/Unknown
reporting, frontend receipt propagation/completion, schedule controls and
bounded open-tab due checking, followed by live acceptance. The extension and
hosted supplier runner are unchanged.
