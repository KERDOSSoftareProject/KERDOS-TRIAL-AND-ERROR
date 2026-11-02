# Pending browser transfer revocation

A prepared transfer previously depended on its tab's cached setup state. A
cancellation in another tab could leave that ticket usable. Checking only the
current state would also allow cancellation followed by reopening the same
setup to revive an old ticket.

Each owned connection now has a monotonic transfer_revision. Actual changes to
setup state or saved account/list labels advance it; saving identical labels
does not. Clients retain their existing narrow update grants and cannot set or
reset this revision. Existing rows begin at revision zero without changing their
labels or setup state.

A read-only authenticated RPC verifies the exact organization/vendor/request,
provider, revision, account/list labels and portal origin against current rows.
It also checks current owner/manager membership, active vendor and available
local-browser provider. The function is security invoker with fixed search path;
PUBLIC/anonymous execute is revoked. The SDK uses its normal authenticated RPC
POST, without credentials, codes, session tokens or new extension permissions.

The prepared binding is an immutable copy of scalar values, including for local
providers returning live row objects. Later row mutations cannot refresh its
revision. The updated app validates after saving a preparation, then the handoff validates
again before pairing, before granting the export claim, and after hashing the
returned file but before ingestion admission. A cancelled/reopened connection,
changed selection/provider, lost role or unavailable service rejects the pending
transfer. The export claim is reserved before awaiting validation, so competing
claims cannot both start exports. Expiry and local cancellation are checked after
asynchronous validation; a late result cannot revive the ticket. Legacy unclaimed
delivery also goes through the admission check. No rejected transfer reaches the
app importer.

These are boundary checks, not an atomic transaction with a supplier browser.
A cancellation after an export was authorized cannot retract a request already
issued to the supplier. A cancellation after ingestion admission cannot retract
an already-issued import write. Existing row/quote recovery and role/RLS rules
remain. There is no claim of instant push cancellation, unattended supplier
access or installed-browser acceptance. Open KERDOS tabs must load this app
version; installed companion 0.2.1 needs no replacement. Older 0.2 clients do not
have the pre-export claim, but cannot bypass the updated receiver's admission
check.

Controlled handoff tests cover fresh success, rejected/offline validation,
cancel/reopen, pre-export/pre-admission rejection, duplicate claims/deliveries,
cancellation/expiry during an outstanding check and legacy delivery. Rendered
production tests simulate another tab cancelling and reopening an unchanged
setup before the stale ticket claims export. Actual embedded SQL tests apply
migrations twice and verify revision progression, no-op stability, restricted
revision writes, stale revisions, role/client isolation and vendor/origin changes.
These do not establish actual supplier login, MFA, installed-popup lifecycle or
stored-binary acceptance. Task1, approved Order Guide, hosted worker, supplier
orders/payments and accounting scope are unchanged.
