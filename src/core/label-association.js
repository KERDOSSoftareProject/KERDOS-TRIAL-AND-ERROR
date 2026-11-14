export const PRODUCT_LABEL_METHOD = 'product_label';

export function productLabelLinked(mapping) {
  return mapping?.match_method === PRODUCT_LABEL_METHOD &&
    mapping.comparison_track === 'exact' && mapping.confidence_score > 0;
}

export function manuallyConfirmedLink(mapping) {
  return mapping?.match_method === 'manual' && mapping.comparison_track === 'exact' && mapping.confidence_score === 100;
}

export function productIdentityPending(item, mapping) {
  return !!item?.concept_review_required && !manuallyConfirmedLink(mapping);
}

export function productLabelOrderPath(item, mapping, listing) {
  return productLabelLinked(mapping) || (!!item?.concept_key && manuallyConfirmedLink(mapping) &&
    listing.field_resolutions?.row_approval?.catalogItemId === item.id);
}
