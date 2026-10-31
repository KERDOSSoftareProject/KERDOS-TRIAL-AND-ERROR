# Manual import interruption — recovery review

The B3 live fixture preview correctly read 347 source rows. The browser-driven save was slow and displayed only a spinner. Dino refreshed while it was running. Read-only inspection confirmed the document remained processing with 230 completed keys, 220 current vendor listings, no usable price-history quotes, and its original PDF retained.

These counts mean different things: repeated source observations can update the same vendor listing. They do not establish 230 distinct items, completion, or a B3 save pass. Eleven completed keys no longer have a *current* listing row reference. Current listings can also include a write that finished before its progress checkpoint.

## Demonstrated recovery defect

Resume validation obtains evidence from price_history and each vendor listing's latest import_row. Unconfirmed quotes correctly produce no price_history entry. When several source rows refer to the same listing, later import_row values overwrite earlier references. The strict guard therefore rejects a valid interrupted source rather than risking an ordinal mismatch. Freeform rows can also lack a sourceLine, so a line-only proof is insufficient.

## Proposed fix

- Capture immutable, versioned source-row proof on import_documents before saving a new manual price sheet's first row. Proof includes identities, prices, quantities, pack/unit evidence and source positions, independently of current catalog rows.
- Validate completed and surviving in-flight row ordinals against this proof on resume. Changed identities, prices, packs, positions, malformed versions and inconsistent saved source lines fail closed. Legacy documents without proof keep their existing strict guard.
- Keep the original source path when resuming the same document.
- Show a saved-row counter with failures separately, in a child component whose state updates do not rerender the entire import table.

The nullable source_rows migration adds no roles, grants or policies, changes no existing record contents, and uses an invoker trigger to prevent replacing or clearing retained proof. The trigger fires only when source_rows is explicitly updated. Existing row security applies to the new column. Lock, statement and idle-transaction timeouts bound installation.

## Interrupted test-document repair — separate approval

A private, read-only preparation script reconstructs the snapshot from the retained original under the deployed B3 parser, verifies exact original_text and SHA-256 fingerprint equality, and compares all 220 surviving listing proofs against their source positions. All match; no quote or ordering eligibility is changed by this preparation.

After approval, apply the migration to kerdos-test, recheck the private baseline, and add proof only to the identified interrupted document where organization/vendor, fingerprint, processing status, completed-key array and NULL proof all still match. Preserve status, all completed keys, listings, mappings, quotes and the original file. This update must not finalize the document or invoke a worker. The customer then resumes the same file/vendor through the reviewed UI.

The private repair payload and full customer baseline are excluded from git. The helper prepares data; it never executes SQL or sends a network request. A different document state must stop the repair for review.

## Validation and limits

Local actual-SQL tests cover format validation, one-time capture, immutability, ordinary progress/finalization and existing row security. Rendered production handlers cover progress after the first saved row and resuming an interrupted staged listing whose latest row reference replaced an earlier one, with one source document/original and unchanged quote calls. A clean full run and live recovery remain required.

This improves recovery and progress visibility. It does **not** claim that bulk saving is fast: serial per-row requests remain a separate measured performance issue. No migration, source repair or deployment has been performed by this draft. No automatic-email worker, scheduler, Vault or production setting is changed.
