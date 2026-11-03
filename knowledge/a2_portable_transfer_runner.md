# A.2 portable transfer runner — companion 0.2.4

The production Chrome pilot now delegates transfer rules to
`companion/chrome/core/transfer-runner.mjs`. This source is browser-independent;
it stays inside the self-contained extension folder for packaging. Chrome's
host adapter is `companion/chrome/transfer-runner.mjs`.

## Host contract

| Host method | Responsibility |
| --- | --- |
| validTarget(id), getTarget(id) | Validate host-owned handles and obtain current execution target |
| isReceiver(target) | Admit only an approved KERDOS receiver |
| supportsSource(target, pairing) | Bind source execution to the approved adapter and origin |
| readStatus(), writeStatus(snapshot) | Persist only progress/result, with host isolation |
| readPairing(), savePairing(ticket), clearPairing() | Retain and consume one-use metadata; never CSV/credentials |
| pair(target) | Obtain the prepared receiver's ticket; return {ok,ticket} |
| reserve(pairing, claimId) | Ask the exact receiver to authorize one export |
| retrieve(target, pairing) | Run the approved provider and return its outcome/artifact |
| deliver(pairing, claimId, artifact) | Send exact captured bytes to the reserved receiver |

The core binds receiverId to the selected receiver target, overriding any ticket
value for that handle. The Chrome adapter maps receiverId to the existing tabId
storage field, retaining compatibility with 0.2.3 session state. Protocol v2,
approved origins/providers, source account/list checks, request claims, raw-byte
validation and app-owned organization/vendor assignments remain unchanged.

Execution ownership is reserved before asynchronous work. One command wins;
pairing is consumed before supplier execution; completion releases ownership
before publishing terminal status. A persisted busy status recovers as
unconfirmed and clears pairing without automatically repeating an operation.
A receipt still means received_for_review, not confirmed saved prices.

A host is trusted application code and must supply isolated storage, approved
execution and receiver transport. Implementing this interface is not itself
proof of authentication or tenant isolation. No arbitrary plugin registry,
credential capture, cross-origin proxy or browser permission is added.

## Verification and limits

The existing actual-popup and persistence-boundary tests run through the Chrome
adapter and portable core. A separate browser-free host uses string target IDs
and two synthetic providers/clients, checking independent state, exact receiver
binding, competing commands, one-use operation, denied/expired claims,
verification stop and interrupted-state recovery. Browser globals are absent.
The native Chromium workflow must also pass against the full 0.2.4 package.

This completes a reusable runner foundation, not universal companion delivery.
A desktop host, Safari/Firefox integration, secure local transport and packaging
are not implemented here. Real supplier sessions, installed-client acceptance,
fresh/changed saved prices and private stored-original verification remain open.
Existing automatic ingestion is reused; the app UI, database and customer data
are not changed. No runtime AI/model dependency, paid service, scheduler,
automatic resend or supplier order is introduced.
