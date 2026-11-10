# A.2 Product Prices control — Companion 0.2.9

## Evidence

The installed 0.2.8 result specifically reported `product_prices_unavailable`.
The supplier screenshot showed Download Options open and Product Prices not
selected. This identifies the failing stage, not whether lookup or selected-state
confirmation failed.

US Foods' public application bundle was inspected directly from its index's
declared resources, without credentials, account access or an authenticated DOM:

- Index: https://order.usfoods.com/
- Declared resource: https://order.usfoods.com/main.2546bdbb02606b10.js
- Published multi-select component: `app-multi-select-checkbox`.
- Its option is an `ion-checkbox` with a nested primary label and optional
  secondary/disabled text. The checkbox's checked property is bound to selection.

The old adapter reads only the ARIA label or enclosing element's text. It never
reads the checkbox's own primary label. A controlled regression with an exact
own label and an enclosing multi-option container fails against 0.2.8 with
`product_prices_unavailable`; the revised adapter passes. The public bundle is
not proof of the exact DOM in Dino's already-open session. No private portal
markup, account/list identifiers or vendor source bundle is shipped with KERDOS.

## Change

Use the existing exact ARIA label when present; otherwise read the control's
nested primary label, then its own text, with the old parent fallback retained
for a plain input. Match exactly Product Prices. Do not use substring matching,
an arbitrary option index, a customer/list constant or another option's text.
Multiple matching controls continue to stop.

After clicking once, re-read the current unique labelled checkbox for checked
state. A controlled component can replace its host; a detached old node is not
proof that the current option remains unchecked. Do not click repeatedly.

Only the MOXe adapter and the Companion version/package instructions change.
The app-owned scope, pre-export reservation, origin/account/list checks, CSV and
byte validation, existing dialog recovery, fixed error guidance and no-automatic-
retry behavior remain. No permissions, website layout, ingestion/grouping rules,
schema, customer records, schedule, credentials or runtime-model dependency change.

## Verification boundary

The original failing-label regression is recorded before the fix. Controlled
cases cover own labels without ARIA, nested labels with secondary text, replaced
hosts and rejection of a different own label despite a misleading parent label.
The native Chromium fixture now uses DOM custom checkbox hosts with nested labels,
multiple options in their container and host replacement after a selection.
Its existing full transfer/retry/permission/recovery assertions run with that DOM.

Local and hosted check results are recorded in the PR. These are synthetic
fixtures; real installed supplier acceptance and private-original read-back are
still required. A website refresh alone cannot replace installed extension files.
