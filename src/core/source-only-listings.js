// A reviewed document heading, charge, or broken fragment is retained source
// evidence rather than a client product. A genuine single listing stays valid.
export function sourceOnlyListings(rows=[]){
 return rows.length>0&&rows.every(row=>{
  const decision=row?.field_resolutions?.source_classification;
  return !!decision?.confirmedBy&&['document_metadata','document_charge','non_product_fragment','unresolved_product_identity'].includes(decision.kind);
 });
}
