import {getProcurementContext} from "../procurement.js";

// Read only explicit price units. A pack's measurement is not a price unit.
export function canonicalQuoteUnit(value, procurement=getProcurementContext()){
  const basis=procurement.priceBasisFor(String(value||"").trim().replace(/[.)]+$/,""));
  return basis?.basis==="case"?"CASE":basis?.basis==="each"?"EACH":basis?.unit||null;
}
export function unitInPrice(value, procurement=getProcurementContext()){
  const match=String(value||"").trim().match(/^\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:\/|per\s+)?\s*([a-z][a-z .]*)$/i);
  return match?canonicalQuoteUnit(match[1], procurement):null;
}
export function unitInPriceHeader(value, procurement=getProcurementContext()){
  const header=String(value||"").trim();
  const prefix=header.match(/^(case|cases|cs|cse|each|ea|piece|pieces|pc|pcs|pce)\s+(?:price|cost|rate)$/i);
  if(prefix)return canonicalQuoteUnit(prefix[1], procurement);
  const match=header.match(/^(?:unit\s+)?(?:price|cost|rate)\s*(?:per\s+|\/|\(\s*)([a-z][a-z .]*?)\s*\)?$/i);
  return match?canonicalQuoteUnit(match[1], procurement):null;
}
export function documentQuoteUnit(text, procurement=getProcurementContext()){
  const declarations=[...String(text||"").matchAll(/\ball\s+prices\s+(?:(?:are|quoted|shown|listed)\s+)*(?:per\s+|by\s+the\s+)([a-z]+(?:\s+ounces)?)/gi)]
    .map(match=>canonicalQuoteUnit(match[1], procurement));
  // Multiple sections with contradictory or unknown declarations cannot
  // establish one basis for the document.
  return declarations.length&&declarations.every(unit=>unit&&unit===declarations[0])?declarations[0]:null;
}
export function applySourceUnits(row,{priceCell,priceHeader,documentUnit}={}, procurement=getProcurementContext()){
  // An ordering-unit column does not state what the quoted price covers.
  if(/^(?:order(?:ing)? unit|order uom|type)$/i.test(row.sellingUnitHeader||'')&&!['price cell','price header','document note','manual'].includes(row.sellingUnitSource))row={...row,orderingUnit:row.orderingUnit||row.sellingUnit,sellingUnit:null,billingUnitEvidence:null,sellingUnitSource:null};
  const clues=[
    row.sellingUnit&&{unit:canonicalQuoteUnit(row.sellingUnit, procurement),source:row.sellingUnitSource||"column"},
    {unit:unitInPrice(priceCell, procurement),source:"price cell"},
    {unit:unitInPriceHeader(priceHeader, procurement),source:"price header"},
  ].filter(clue=>clue?.unit);
  if(new Set(clues.map(clue=>clue.unit)).size>1)return {...row,priceNeedsReview:true,
    issues:[...(row.issues||[]),"The price column and row state different quoted units."],quoteUnitEvidence:clues};
  // Row/table declarations take precedence over a document-wide default.
  const clue=clues[0]||(!row.sellingUnit&&documentUnit?{unit:documentUnit,source:"document note"}:null);
  return clue?{...row,sellingUnit:row.sellingUnit||clue.unit,sellingUnitSource:clue.source,quoteUnitEvidence:row.quoteUnitEvidence||(clues.length?clues:[clue])}:row;
}
