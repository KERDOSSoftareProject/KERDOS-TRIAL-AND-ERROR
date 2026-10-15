import {priceBasisFor} from "../procurement.js";

// Read only explicit price units. A pack's measurement is not a price unit.
export function canonicalQuoteUnit(value){
  const basis=priceBasisFor(String(value||"").trim().replace(/[.)]+$/,""));
  return basis?.basis==="case"?"CASE":basis?.basis==="each"?"EACH":basis?.unit||null;
}
export function unitInPrice(value){
  const match=String(value||"").trim().match(/^\$?\d[\d,]*(?:\.\d+)?\s*(?:\/|per\s+)?\s*([a-z][a-z .]*)$/i);
  return match?canonicalQuoteUnit(match[1]):null;
}
export function unitInPriceHeader(value){
  const match=String(value||"").trim().match(/^(?:unit\s+)?(?:price|cost|rate)\s*(?:per\s+|\/|\(\s*)([a-z][a-z .]*?)\s*\)?$/i);
  return match?canonicalQuoteUnit(match[1]):null;
}
export function documentQuoteUnit(text){
  const declarations=[...String(text||"").matchAll(/\ball\s+prices\s+(?:(?:are|quoted|shown|listed)\s+)*(?:per\s+|by\s+the\s+)([a-z]+(?:\s+ounces)?)/gi)]
    .map(match=>canonicalQuoteUnit(match[1]));
  // Multiple sections with contradictory or unknown declarations cannot
  // establish one basis for the document.
  return declarations.length&&declarations.every(unit=>unit&&unit===declarations[0])?declarations[0]:null;
}
export function applySourceUnits(row,{priceCell,priceHeader,documentUnit}={}){
  // An ordering-unit column does not state what the quoted price covers.
  if(/^(?:order(?:ing)? unit|order uom|type)$/i.test(row.sellingUnitHeader||'')&&!['price cell','price header','document note','manual'].includes(row.sellingUnitSource))row={...row,orderingUnit:row.orderingUnit||row.sellingUnit,sellingUnit:null,billingUnitEvidence:null,sellingUnitSource:null};
  const clues=[
    row.sellingUnit&&{unit:canonicalQuoteUnit(row.sellingUnit),source:row.sellingUnitSource||"column"},
    {unit:unitInPrice(priceCell),source:"price cell"},
    {unit:unitInPriceHeader(priceHeader),source:"price header"},
  ].filter(clue=>clue?.unit);
  if(new Set(clues.map(clue=>clue.unit)).size>1)return {...row,priceNeedsReview:true,
    issues:[...(row.issues||[]),"The price column and row state different quoted units."],quoteUnitEvidence:clues};
  // Row/table declarations take precedence over a document-wide default.
  const clue=clues[0]||(!row.sellingUnit&&documentUnit?{unit:documentUnit,source:"document note"}:null);
  return clue?{...row,sellingUnit:row.sellingUnit||clue.unit,sellingUnitSource:clue.source,quoteUnitEvidence:row.quoteUnitEvidence||(clues.length?clues:[clue])}:row;
}
