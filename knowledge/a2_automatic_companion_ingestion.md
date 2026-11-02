# Task 2: automatic ingestion after companion retrieval

Dino's November 2 live pilot showed installed/enabled companion 0.2.1, successful
supplier-to-app transfer and all 87 rows reaching the importer. The app still
asked about five descriptive columns and required Save Import. Dino rejected
that as a manual client workflow and cancelled before this repeat was saved.
Do not label that observation as duplicate-safe saved/repriced acceptance.

Companion payloads now explicitly select the automatic price-ingestion path.
Manual upload and deliberate Inbox review retain their existing controls. The
normal companion path does not show a column/Continue/preview/Save dialog. A
small processing notice reports progress; successful processing refreshes data,
reports received or already up to date, and dismisses the notice automatically.
The wire acknowledgement remains received_for_review for 0.2.1 compatibility;
it is acceptance into ingestion, never proof that prices were committed.

The same parser, source/document storage, source snapshots, resume verification,
per-row quote/catalog logic and RLS run. Existing confirmed layout answers are
respected; automatic ingestion does not invent or persist layout confirmations.
Recognized descriptive metadata (line/group/customer-reference/class/storage
headings) is retained using the existing supplier-independent vocabulary.
Unresolved headings, unlabelled columns and headerless roles are carried with
source rows as review flags and cannot establish usable new quotes. An incoming
unknown field cannot retire an existing accepted quote. Profiled parts hold the
document conservatively for review. All originals/parsed source remain retained.

Original file upload and immutable companion evidence precede price writes.
Empty/unreadable/wrong-type sources are retained as partial exceptions without
price or invoice writes. Missing storage/evidence schema and refresh failures
report exceptions, never success. Completed exact duplicates finish with no new
original/document/quote/mapping writes; changed source follows a distinct source
record and the existing known-item/quote policy. Pending partials still require
exact source/position proof. Workspace unmount fences later document/row writes
and success callbacks; an already-issued request cannot be retracted.

Rendered production tests use the actual reader/structurer/parser/importer and
controlled persistence. They cover zero-action receipt-to-save, 87 source rows
and metadata (including the old false-header trigger), same-source replay,
changed-price provenance, unknown-field holds and existing-quote preservation,
retained nonpricing/read exceptions, original/evidence failure, refresh failure
without resubmission, and unmount during original preservation. Manual/Inbox
regressions remain covered. This is not new installed-browser/database evidence.

App-only rollout; installed companion 0.2.1 requires no replacement. No schema,
hosted worker, scheduling, credentials/MFA automation, paid service, runtime AI,
Order Guide or financial operation is changed. The existing user-started vendor
sign-in, prepare/pair and retrieval pilot remains; unattended supplier access and
universal distribution are separate open work. Next live check is receipt to
automatic saved/unchanged result without column or Save clicks, then read-only
verification of original, ownership, exact prices and duplicate-safe counts.
