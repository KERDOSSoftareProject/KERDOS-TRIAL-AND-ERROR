/**
 * attachment-state.mjs
 *
 * Predicates and constants over inbound_attachments rows.
 * Imported by attachment-processor.mjs and its test suite.
 */

/**
 * Valid outcomes that process-attachment may return on success.
 * Any other outcome (including null or missing) is treated as a failure
 * that triggers Postmark retry.
 */
export const VALID_OUTCOMES = ["auto_imported", "needs_review", "skipped"];

/**
 * Returns true when an existing inbound_attachments row should trigger
 * a fresh process-attachment dispatch.
 *
 * Conditions that must all hold:
 *   - row is not null/undefined
 *   - processing_status is "pending"  (not already picked up)
 *   - no ingest_error                 (not a permanent decode failure)
 *   - storage_path is present         (file was actually uploaded)
 *
 * A "needs_review" row is NOT dispatchable because it was already
 * processed — a human decision is required.  A "processing" row is
 * not dispatchable because another worker holds the lease.  An
 * "auto_imported" row is terminal.
 */
export function isDispatchable(row) {
  return (
    row != null &&
    row.processing_status === "pending" &&
    !row.ingest_error &&
    row.storage_path != null
  );
}

/**
 * Returns true when the attachment has reached a terminal state and
 * no further automatic processing will be attempted.
 *
 * Both "auto_imported" and "needs_review" are terminal:
 *   - auto_imported: fully processed by the automatic pipeline.
 *   - needs_review:  stopped mid-import; awaiting a human resume action.
 */
export function isTerminal(status) {
  return status === "auto_imported" || status === "needs_review";
}
