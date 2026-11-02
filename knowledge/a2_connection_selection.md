# Vendor connection account/list labels

The browser pilot previously kept account/list inputs in unscoped component
state. A rendered regression reproduced one vendor's account name appearing
after switching to another vendor. Labels were also lost after refresh, so
clients had to type the same selections repeatedly.

Drafts now belong to an organization/vendor/provider/request scope. Data from
another organization or backend is excluded immediately while the next context
loads. A different connection gets its own saved labels or empty inputs.
Preparing a browser transfer remembers the trimmed display account and list
labels on that exact active setup request, then creates the one-use ticket.
No extra Save button or client confirmation is added. Selecting the connection
after remount restores its saved labels; unsaved text is never used across a
workspace boundary. The adapter still checks the visible supplier account/list.
These are display labels, not credentials, account-verification proof or a
supplier session. Available-list discovery and unattended access remain open.

The service forwards only the two label columns and scopes the update by
organization, vendor, adapter, request ID and setup_requested state. It requires
one returned row with those exact bindings and labels before ticket creation.
The existing owner/manager RLS and identity-column restrictions remain. A small
migration adds nullable paired labels with nonblank/length checks, grants UPDATE
only for those columns, and rejects cancelled or non-browser provider edits.
Existing selections are not inferred/backfilled from imported files. Cancel and
reprepare retain labels without claiming authenticated supplier access.

A save may finish for the user's original explicit selection after navigation,
but its result cannot arm a transfer or appear in the next workspace. Editing
while a save is pending invalidates the captured transfer; later preparation
saves the current edit. Pending responses after unmount are fenced. Normal
expiry, callback, source-ingestion and cancellation behavior remains covered.
No labels, credentials, tokens or codes are stored in browser persistence.

Tests first reproduced the cross-vendor carryover. Rendered production checks
cover vendor/provider/client isolation, remount persistence, exact write scope,
pending navigation/edit rejection, saved ticket labels, failure and unmount.
Actual embedded SQL tests apply the migration twice, then exercise nullable,
length and Unicode whitespace rules, owner/manager access, separate clients on
the same provider, employee/anonymous denial, identity grants, cancellation,
reprepare and inactive/provider rejection. They do not establish real supplier
login, pricing-list enumeration, installed-session or binary-original acceptance.
No supplier order/payment, worker, approved Order Guide, runtime AI or paid
service is added. Accounting remains paused; Task1 remains awaiting domains.
