/** Read the value captured when the message arrived, never a later route assignment. */
export function receiptVendorId(message) {
  const row = Array.isArray(message) ? message[0] : message;
  return row?.vendor_snapshot_at ? row.receipt_vendor_id ?? null : null;
}
