# A.2 companion browser runtime verification

Companion 0.2.2 now has an automated runtime check in a real Chromium browser.
The first successful run was 41543114813 on November 2, 2026, against the
production popup, background worker, runner, bridge, MOXe provider adapter and
shared handoff receiver. The final workflow uses pinned playwright-core 1.62.1
as temporary test tooling outside application dependencies.

The test opens the native toolbar popup in headed Chromium under a virtual
display and controls its actual browser target. Closing/reopening it preserves
worker progress and the resulting receipt. A second popup does not repeat the
export. The provider creates a real CSV Blob/download; the receiver checks exact
source text and SHA-256 under the closed-over synthetic client/vendor identity.
A fresh preparation transfers changed synthetic prices as different bytes.
Closing the receiver prevents another supplier export.

All supplier and app pages are synthetic, intercepted before network access.
There is no signed-in supplier, Supabase, saved catalog price or private storage
in this check. Earlier PR109–111 checks used fixture-origin host grants for automated popup
opening. The current harness uses the exact shipped manifest, confirms its
granted origin list starts empty, and invokes Chromium's native toolbar action
on the selected tab. This exercises temporary activeTab authorization without
adding host grants. The browser-control flag is restricted to the disposable CI
profile and is never shipped to clients. The companion remains activeTab/
scripting/storage only. Human installed-client acceptance,
supplier authentication/MFA, fresh saved prices and private-original download
verification remain open. Passing this check does not complete A.2.

KERDOS software, companions and adapters must work without AI calls, model
services or AI runtime dependencies. This test uses fixed assertions and browser
automation; it neither adds an application dependency nor uses an AI service.
It introduces no credentials, supplier orders, paid service or runtime AI.
Universal desktop/browser delivery remains a separate unfinished task.

The public-repository workflow has read-only permissions, no secrets, an
8-minute timeout and paths limited to the companion, handoff and test harness.
No KERDOS app, schema, data, hosted worker or original ZIP was changed.

References:
- https://playwright.dev/docs/chrome-extensions
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle


## Shipped-permission test boundary

Opening a popup programmatically did not grant activeTab in the native test.
The harness now drives Extensions.triggerAction for the selected tab, allowing
Chromium to perform its ordinary toolbar action and temporary grant. The suite
retains its stop/restart, cancellation, expiry and interrupted-tab assertions.
There is no test fallback to fixture-origin host grants. Browser actions remain
automated against synthetic pages; supplier login, client installation and live
price persistence remain separate acceptance requirements. These test changes
add no production permission, model service, AI dependency or paid service.

Browser-control command reference:
https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-triggerAction
