// Completion describes persistence, not whether a saved quote needs review.
export function priceDocumentStatus({failedRows,failuresBeforeGroup,completedKeys,rowCount}){
  return failedRows===failuresBeforeGroup&&completedKeys.size===rowCount?"complete":"partial";
}
