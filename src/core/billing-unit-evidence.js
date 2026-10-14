// A field value alone does not establish what the vendor billed.
// Preserve the exact header; inferred column roles never become source evidence.
export function pricingUnitHeader(header){
  return /^(?:selling unit|price unit|price uom|pricing unit|pricing basis|price basis|unit of sale|quoted per)$/i.test(String(header||'').trim());
}

export function billingUnitEvidence(row){
  const evidence=row.billingUnitEvidence;
  if(evidence?.kind==='goods-invoice-billed-unit'&&evidence.header==='UOM'&&evidence.unit===row.sellingUnit)return evidence;
  if(evidence?.kind==='pricing-unit-header'&&pricingUnitHeader(evidence.header)&&evidence.unit===row.sellingUnit)return evidence;
  // Explicit price-cell/header/document declarations are preserved by source-units.
  const clue=row.quoteUnitEvidence?.find(value=>['price cell','price header','document note'].includes(value.source));
  return clue&&row.sellingUnitSource===clue.source?{kind:'explicit-price-unit',header:row.priceHeader||null,unit:row.sellingUnit,source:clue.source}:null;
}
