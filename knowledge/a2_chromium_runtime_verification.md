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
in this check. Only the temporary extension copy has fixture-origin host grants
to permit automated actions. The shipped companion remains activeTab/scripting/
storage only. Human activeTab authorization, installed client acceptance,
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
