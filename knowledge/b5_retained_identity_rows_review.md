# B5 — retain unresolved source rows and separate explicit pack options

PR33's deployed browser recovery reached a terminal partial result: 333/347
source-row checkpoints, 320 current vendor listings, all unavailable, zero usable
quotes. The original file, immutable 347-row source proof, and same document ID
were preserved. The user supplied screenshots of the progress counter and result.
These are browser observations plus direct hosted read-only database checks.

The remaining 14 source observations were rejected by the unnumbered-listing
identity guard. A read-only replay against retained source/listing evidence found
two explicit, physically different pack offerings and twelve identities without
enough pack evidence. Similar product wording cannot safely establish identity.

## Changes

- Manual import may create a separate offering when every similar unnumbered
  listing has a provably different physical pack and compatible brand evidence.
  Missing/unreadable packs, repeated compatible candidates, and a contradictory
  shared barcode remain blocked. Default worker and Inbox review policy stay
  unchanged. No vendor or billing-unit inference is added.
- Item Catalog displays unlinked observations directly from partial documents'
  immutable source proof, excluding completed row keys. Repeated descriptions
  with different amounts keep their separate source ordinals, pages and amounts.
  These are retained observations, not asserted vendor/catalog identities and
  never purchasing quotes. They require no second upload or Save to be visible.
- Reads are organization-scoped and paginated through the existing service and
  table RLS. Organization switches hide stale rows, search only filters display,
  and a read failure remains visible. No schema change or hosted repair is needed.

## Limits and verification

Local: eight executed core/service checks, four rendered retained-row checks,
and fifteen rendered upload checks, including the new separate-pack save.
Full npm test (including lint and the new suites), production build, and diff\nchecks passed. Read-only replay of the retained hosted evidence projects all14\nunlinked source observations separately. No additional hosted writes were made.

The 12 unresolved identities are not resolved by this change. Their source is
already retained, while listing assignment remains pending. This adds visibility
without relaxing identity safeguards or falsely completing the partial document.
No worker, scheduler, automatic-email, production, or live data change is included.
Bulk save throughput remains open; this is not a speed fix. Deployment and fresh
browser acceptance require Dino's review under the existing deployment preference.
