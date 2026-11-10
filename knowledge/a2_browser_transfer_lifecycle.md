# Task 2: browser connection lifecycle

A2.a.iv is the active lifecycle check. A2.c.iv's installed, user-started US Foods
pilot passed on November 6, 2026: one new source completed automatic ingestion,
then the unchanged source returned already-up-to-date without duplicate records.
Both final app results reported stored-original verification. This does not prove
unattended access, universal browser delivery or actual supplier-session recovery.

## Existing boundaries

The receiver publishes ready, receiving, received, rejected, expired and cancelled
states. Its bounded timer expires a ten-minute ticket; delivery also checks
wall-clock expiry, so background timer throttling cannot extend admission. A
receipt acknowledges ingestion admission, not saved prices. Final saved-price and
stored-original results belong to the app importer.

No expiry, verification stop, permission change, restart or view reopening starts
another export automatically. A fresh explicit command must establish its current
selection and authorization. Selection, backend, role or transfer-eligibility
changes cancel the old receiver. Generation checks prevent late results from
changing a newer page state; unmount removes the receiver and timer.

Connection cancellation also advances an owned connection's transfer revision.
The authenticated selection check validates current ownership, membership,
provider, account/list, origin and revision at preparation, pairing, export claim
and ingestion admission. Cancel/reopen cannot revive a stale ticket. See
[pending transfer revocation](a2_pending_transfer_revocation.md).

A supplier request already authorized cannot be retracted by later cancellation.
Likewise, cancellation after ingestion admission does not undo an already-issued
write. These limits must not be presented as instant transaction cancellation.

## Three distinct kinds of access

| Boundary | Meaning |
| --- | --- |
| KERDOS connection | Client/vendor-scoped setup and immutable transfer revision. Cancellation blocks the revoked pending connection; prior imports remain. |
| Companion host permission | The browser profile's grant for an approved site origin. Revocation prevents execution. Restoring it does not itself run an export. It is not a per-client supplier login. |
| Supplier session | Sign-in and verification controlled by the supplier in the user's browser. A sign-in stop is not successful retrieval. The client completes it with the supplier, then explicitly retries. |

Cancelling one KERDOS connection must not be confused with signing out of the
supplier or removing a shared origin permission for every client in that browser.
The current Chrome pilot does not provide isolated unattended supplier sessions.
No credential, one-time-code or cookie extraction is introduced by these checks.

## Evidence and remaining acceptance

| Check | Evidence boundary |
| --- | --- |
| New source and duplicate-safe repeat, original verification | Installed pilot and scoped database comparison passed November 6. All 87 rows retained; 78 accepted quotes exactly matched source values; 7 pack/basis reviews and 2 unavailable prices were explicitly accounted for. Repeat preserved the complete database graph. |
| Expiry, cancel/reprepare, late hashing/admission, role/client guards | Controlled receiver/rendered tests. |
| Revision fencing, no-op stability, narrow grants, cross-client/role isolation | Executed embedded PostgreSQL migration/service tests, including repeated migration. |
| Closed receiver, interrupted worker/popup and no automatic replay | Native Chromium with the shipped extension and synthetic pages/transport. |
| Verification stop followed by completed sign-in and a fresh retrieval | Native recovery scenario restores the synthetic selected-list page, verifies no automatic export, then requires an explicit app command. It does not authenticate to a real supplier. |
| Permission revocation and restoration | Native recovery scenario removes/regrants only the declared host in a disposable profile; prior artifacts remain and no export resumes until a fresh app command. |
| Actual supplier expiry/MFA/reconnect and client-visible disconnect/reconnect | Still requires installed acceptance. Do not mark A2.a.iv complete from synthetic recovery alone. |
| Unattended scheduling and other execution hosts | Separate existing tasks. No schedule or source is activated by this work. |

The recovery tests never use the live supplier, signed-in KERDOS data or a real
credential. Their received-artifact assertions are not database persistence
claims. The live 87-row and duplicate-safe pilot evidence remains a separate
observation; it must not be used to infer untested lifecycle outcomes.
