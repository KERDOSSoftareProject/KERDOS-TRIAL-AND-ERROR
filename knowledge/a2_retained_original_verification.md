# Retained companion original verification

The pilot record retains browser-companion transfer SHA-256 and byte length.
Storage metadata and the extracted source-text hash are not proof that the
private stored binary can be retrieved intact. The available management tools
cannot return those private file bytes; no binary-retrieval live pass is claimed.
The signed-in app now performs that read-back through its normal storage access.

On automatic companion ingestion, KERDOS retains the original and source record,
then downloads the stored object before applying any new quote. It compares the
actual raw bytes with the retained transfer digest and length, using Web Crypto
SHA-256. Exact completed companion repeats also read back their existing original
before reporting success. This is a read-only repeat: no new object, document,
quote, progress/status or mapping write. It never substitutes extracted text for
binary evidence. Blob size is checked before reading into memory and the limit
matches the existing 5 MiB companion-transfer limit. Ownership and vendor/path
checks precede any download. The Supabase adapter uses the existing authenticated
Storage download endpoint with browser cache disabled; no signed/public URL,
service key, new endpoint or storage policy is introduced.

Missing/denied, truncated or same-size changed originals stop new quote writes
and retain a new/incomplete source as partial for review. A failed verification
of an already complete source leaves its existing status, price and history
unchanged and does not emit success. Missing or malformed transfer-byte evidence
cannot produce a verification claim. A completed manual/legacy duplicate keeps
its previous unchanged-import behavior without claiming a binary verification.
Partial legacy sources without byte proof remain for review. Workspace unmount
fences later price/progress writes and success; a read already issued may finish.

Only a successful hash/length check adds "Stored original verified." to the
normal automatic result. No column, confirmation, Save or extra client action is
added. The provider-neutral document service uses a download capability; a
provider without it reports unavailable instead of pretending a check passed.
Manual Upload and deliberate Inbox review retain their existing behavior.

Local tests cover BOM/CRLF/Unicode raw bytes, altered/truncated content, invalid
proof, cancellation, owned paths, unavailable/denied storage and the adapter's
no-store request. All 38 rendered production importer checks use controlled
storage; new cases cover failed read then successful resume without duplicate
writes, corruption before a first quote and on a completed repeat, explicit
legacy non-claims and unmount during download. These tests are not installed-
browser evidence. The next actual signed-in same-list repeat should show both
already up to date and Stored original verified; that observation is still open.
Fresh/changed supplier pricing and other installed lifecycle checks also remain
open. Companion 0.2.1 is compatible. No database/worker/Order Guide change,
accounting expansion, supplier order/payment, runtime AI or paid service.
