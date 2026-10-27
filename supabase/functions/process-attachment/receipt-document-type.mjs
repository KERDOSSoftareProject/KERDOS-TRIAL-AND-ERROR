/**
 * receipt-document-type.mjs
 *
 * Read the document type captured at receipt time (from the routing address
 * registration), never re-inferred from email content or filename.
 *
 * Returns null when the snapshot guard column (vendor_snapshot_at) is absent —
 * which means the message predates migration_038 and has no reliable receipt
 * snapshot. Those attachments go to manual review.
 *
 * Mirrors the shape of receipt-vendor.mjs so both values come from the same
 * guarded snapshot row.
 */

/** @param {object|object[]|null} message — the inbound_messages join result */
export function receiptDocumentType(message) {
  const row = Array.isArray(message) ? message[0] : message;
  return row?.vendor_snapshot_at ? row.receipt_document_type ?? null : null;
}
