# B5 — save result responsiveness

The deployed PR34 retry saved both explicit alternate packs separately. Hosted
read-only checks and Dino's result screenshot confirm 335/347 completed source
rows, 322 current listings, all unavailable, zero usable quotes, and 12 unresolved
source observations retained. No exact browser duration was captured.

## Reproduced work and changes

The modal built editable evidence for every parsed row on every render, including
preview, save and result states. Its saved-listing select repeated all unnumbered
vendor listings for every row. At 347 rows and 322 listings, that select alone
could create 112,081 option elements. The modal also awaited the parent catalog
refresh before showing the already-persisted result.

- Ordinary automatic saving after the manual preview does not construct the
  editable evidence grid. Deliberate Inbox review and stopped-import correction
  retain their editor. Evidence is memoized for unrelated UI state changes.
- A saved-listing picker is expanded for one review row at a time. Opening or
  switching the picker does not recompute unchanged row evidence.
- Final saved/partial results and Done appear before the parent refresh finishes.
  Refresh status is separate; refresh errors retain the actual save result.
  Import Another is disabled until refresh finishes, so it cannot race that refresh.
- Clarify that an unresolved identity belongs to the vendor item; the registered
  vendor ownership remains known.

Matching, billing-unit evidence, purchasing eligibility, row persistence, resume
keys, migrations, Edge Functions, recovery schedules and production are unchanged.
Rows still use serial network writes. This removes unnecessary UI work; it does
not establish improved hosted bulk-write throughput or universal review speed.

## Validation

19/19 rendered upload checks passed, using production modal/parser/services with
simulated browser file reading and persistence. Four added controls exercise:

1. 347-row ordinary import with 322 supplied saved listings: zero editable-evidence
   calls and zero saved-listing selects before/during save and on the result;
   all 347 mocked source-row checkpoints are retained.
2. Persisted successful result and Done visible while parent refresh is gated.
3. Persisted partial result visible before refresh; a later refresh error remains
   separate from the controlled write error and retained original.
4. Deliberate two-row review: initially no expanded listing select; one select
   contains all 323 options when requested; switching rows reuses evidence.

Full npm test including lint, production build, and diff checks passed. The build
retains the existing large-chunk warning. This is local component/executed-test
evidence, not a native-browser timing measurement or hosted write benchmark.

The three implementation/test files match the unreleased draft in Dino's
KERDOS_Aristotle_Review_2026-10-31.zip. This review note is additional documentation.
No deployment or hosted mutation is part of preparing this PR. Review-before-deploy
approval and subsequent live acceptance remain required.
