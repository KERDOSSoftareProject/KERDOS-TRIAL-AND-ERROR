# B4 — Field Identification review

The manual import dialog could overwrite its first confirmed column layout when a second layout was confirmed before parent settings refreshed. Its temporary answers were keyed only by header fingerprint, allowing an answer from vendor A to affect vendor B in the same open dialog. Already remembered layouts also caused unnecessary settings updates on later reads.

The dialog now reads answers from a current organization-settings snapshot, retaining vendor and layout keys and merging subsequent successful confirmations. Unchanged answers do not write settings again. An unsuccessful settings update leaves the current preview usable, shows a warning that the choice was not remembered, and permits a later confirmation to retry. This is not a multi-session settings concurrency or atomic JSON-merge change.

The parser's existing one-keyword/text-only exception contradicted B4's two-recognized-column requirement. Header detection now requires at least two hits; the controlled one-hit document falls back to profiling and retains both genuine product rows and their prices. Header vocabulary and column-role scoring are otherwise unchanged.

## Evidence

- Regression baseline at deployed PR36: four of the initial six new checks fail (one-hit header promotion, earlier-layout overwrite, unnecessary repeat settings write, vendor-answer leakage). The same-window reuse and ordinary explicit-header controls pass on that baseline.
- Fixed: two parser checks plus five rendered component checks pass, using the actual parser, dialog, organization service and records adapter with mocked persistence and file reading. The extra rendered check exercises settings-update failure, warning and retry.
- Existing sheet-layout core suite: 12 checks pass.
- Full `npm test`, standalone lint, production build and `git diff --check` pass. Existing bundle-size build warning remains.
- No live browser or hosted database B4 acceptance is claimed. These tests do not prove real settings RLS or persistence across an actual signed-in reload.

## Deployment boundaries

Review required before deployment. No migration, hosted SQL, new secret, scheduler change or email send. Parser source is shared by automatic ingestion, so its local automatic-import regressions are included in the full suite; existing deployed Edge Functions are unchanged and are not redeployed by a Pages merge. The new manual header questions do not add client actions to normal automated email intake.

B3/B5 remain open, including the 12 source identity conflicts, broader source-layout coverage and serial bulk-write throughput. PR36 live refresh-failure observation remains separate and open. The welcome-screen discussion and initial-scroll-top housekeeping items are unaffected.
