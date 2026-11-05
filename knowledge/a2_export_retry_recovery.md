# A.2 export-dialog retry recovery — Companion 0.2.8

## Observed failure and reproduced defect

The installed 0.2.7 attempt reported: "The vendor page could not be verified for
this export. Reopen the selected account and list. No file was sent to KERDOS."
The supplier screenshot showed its list's CSV download dialog still open. This
shared message represents ambiguous controls, a changed page or unavailable page
execution. It does not establish which substep stopped the initial attempt.

A separate controlled regression reproduces an explicit retry while that dialog
is open. The page Download control and modal Download control both have client
rectangles. Version 0.2.7 searches the whole document first and returns
`ambiguous_control` before proceeding. The regression fails against 0.2.7 and
passes with this change. Earlier fixtures hid the dialog before every attempt.

## Change

After checking origin, account and selected-list identity, reuse one matching
visible download dialog; open a new one only when none matches. Nested wrappers
for the same dialog are deduplicated, while multiple separate matching dialogs
stop. Likewise reuse one already visible Product Prices checkbox and preserve
its checked state; do not toggle an already open options panel. Ambiguous pricing
checkboxes stop without a final download.

Known fixed outcomes distinguish download-dialog, Download Options, Product
Prices and final Download failures. They reveal no raw error, page text, account
data or source bytes. The first installed failure remains unclassified until an
updated installed attempt returns its specific outcome.

This does not add automatic retries. Each attempt still requires a fresh
user-started handoff and pre-export reservation. Exact origin/account/list,
permissions, one-use claims, CSV checks, byte capture, hook cleanup and receiver
ownership remain enforced. No app layout, schema, customer data, purchasing,
schedule, credential or runtime-model change is included.

## Verification and remaining acceptance

Controlled regressions exercise the open dialog, already visible/checked pricing
option, missing options, ambiguous checkbox/dialog and download-exception cleanup.
Portable-runner tests check all four new fixed messages, consumed pairing,
failure notice, no delivery and no automatic retry. The native Chromium fixture
now issues a fresh app-side refresh while the prior real DOM dialog and checked
Product Prices control remain open; it expects one additional export/delivery.
Existing recovery, wrong-scope, permissions, duplicate-tab and UTF-8 cases stay
in their existing suites.

These fixtures are synthetic. Real installed 0.2.8 supplier execution, exact saved
prices, duplicate handling and private-original verification remain separate
acceptance. Reload the complete 0.2.8 folder and refresh the KERDOS tab before the
next supervised attempt; a website refresh alone does not update the extension.
