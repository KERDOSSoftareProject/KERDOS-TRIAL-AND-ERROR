# A.2 installed Refresh prices acceptance

This procedure proves the installed, user-started supplier refresh. Existing
portable, rendered importer and synthetic native-browser tests remain separate
evidence. It does not enable unattended login, scheduling or a new browser host.

## Before the user action

1. Record the app commit and installed Companion version. Current supported
   Chrome pilot is 0.2.7; an installed version must be observed, not assumed
   from the repository manifest. Confirm the selected client/vendor/account/list
   in the app and supplier. Do not put credentials or verification codes in evidence.
2. Run `scripts/snapshot_a2_refresh.sql` with the selected organization and vendor
   UUIDs. Keep the returned private snapshot outside git. The owned-vendor check
   must pass; an empty or wrong scope is not a valid baseline. No reset, synthetic
   source, price edit or supplier order is needed.
3. Preserve the current complete source and its transfer hash/length, source-row
   count and completion status. Counts are observations, never constants in the
   implementation. Keep independent client corrections visible in the baseline.

## Installed-browser action

Use the existing saved connection's **Refresh prices**. After one-time Companion
access is already enabled, the normal supported flow must not need repeated Pair,
Send, column-selection, preview, Continue or Save Import actions. If login or MFA
returns, the user completes it directly with the supplier and explicitly refreshes
again. Do not call a sign-in pause a completed refresh.

Observe the final KERDOS pricing result. A Companion receipt, export click or
`received_for_review` acknowledgement alone does not establish saved prices.
Observe **Stored original verified.** separately; transfer evidence stored in the
database does not prove the private stored bytes were successfully read back.

## After the result

Run the same read-only snapshot for exactly the same scope. Compare with the
baseline, and classify the actual source before judging the changes:

| Actual outcome | Required evidence |
| --- | --- |
| Same complete source | Already-up-to-date result; stored-original verification; unchanged item, mapping, quotation and document counts and hashes. |
| New or changed supplier source | Retained original and complete source-row accounting; exact source fields and prices checked against the retrieved document; accepted rows linked to that document; new source history retained; no duplicate item or mapping for an existing identity. |
| Incomplete or unresolved source | Clear needs-attention result; retained original/unresolved rows; no fabricated price/basis and no false saved-success claim. |
| Expired session, wrong account/list, failed download or cancelled attempt | Clear stopped/verification-needed result; last accepted prices retained; no automatic replay or cross-scope import. |

A new export can legitimately contain missing prices or additional/removed products.
Account for those explicitly. Do not require one quotation-history row per source
row: unavailable or held quotes may create no usable quotation. A same-source
repeat must not manufacture new history. A fresh accepted quote follows the existing
quote/correction policy; do not demand that an old manual price override survive
every genuinely newer quote. Preserve accepted non-price client corrections and
classify any intentional/concurrent client edit before attributing a hash change
to the refresh.

Use existing parser/source proofs for exact row comparisons. A stored source-row
count alone does not prove its values, and a text digest does not substitute for a
raw-byte storage read-back. The snapshot intentionally reports installed refresh
and binary read-back as unobserved; an operator must attach the actual UI evidence.

## Acceptance boundary

Record each case independently as observed pass, observed failure or not run.
Same-source success does not close changed-source, MFA/session expiry, cancellation,
unattended scheduling, desktop/Safari/Firefox delivery, or whole-module acceptance.
Keep Item Catalog, Base fields trial, Order Guide layout and purchasing rules intact.
