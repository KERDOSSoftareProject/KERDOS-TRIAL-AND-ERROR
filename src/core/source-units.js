import {getProcurementContext} from "../procurement.js";

export const isOrderingHeader=value=>/^(?:order(?:ing)?\s+(?:unit|uom)|type)$/i.test(String(value||'').trim().replace(/:$/,'').trim());
const directPriceSources=new Set(['price cell','price header','document note','manual']);
export const PRICE_UNIT_CONFLICT_REASON="The price column and row state different pricing bases.";
const orderingHeader=row=>[
  row.fieldIdentification?.bindings?.sellingUnit?.header,
  row.sellingUnitHeader,
  String(row.sellingUnitSource||'').replace(/^header:\s*/i,''),
].some(isOrderingHeader);

export function isOrderingQuoteUnit(row){
  return orderingHeader(row)&&!directPriceSources.has(row.sellingUnitSource)&&row.sellingUnitSource!=='invoice';
}

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
export function documentQuoteEvidence(text, procurement=getProcurementContext()){
  const declarations=[...String(text||"").matchAll(/\ball\s+prices\s+(?:(?:are|quoted|shown|listed)\s+)*(?:per\s+|by\s+the\s+)([a-z]+(?:\s+ounces)?)/gi)]
    .map(match=>canonicalQuoteUnit(match[1], procurement));
  // Multiple sections with contradictory or unknown declarations cannot
  // establish one basis for the document.
  return {
    present:declarations.length>0,
    unit:declarations.length&&declarations.every(unit=>unit&&unit===declarations[0])?declarations[0]:null,
  };
}
export function documentQuoteUnit(text, procurement=getProcurementContext()){
  return documentQuoteEvidence(text,procurement).unit;
}
// A raw token can be vendor evidence even when we do not recognize its unit.
// An ordering-unit column is a separate field and cannot state a quote basis.
export function hasPrintedQuoteUnit(row, procurement=getProcurementContext()){
  return printedQuoteEvidence(row,procurement).present;
}
export function printedQuoteEvidence(row,procurement=getProcurementContext()){
  const present=value=>String(value??'').trim()!=='';
  const retained=row.originalFields||{};
  const binding=row.fieldIdentification?.bindings?.sellingUnit;
  const price=row.fieldIdentification?.bindings?.price;
  const header=price?.header||row.priceHeader||'';
  const value=String(price?.rawValue??'').trim();
  const ordering=orderingHeader(row);
  const clues=Array.isArray(row.quoteUnitEvidence)?row.quoteUnitEvidence.filter(clue=>!ordering||directPriceSources.has(clue?.source)):[];
  const direct=[!ordering?retained.sellingUnit:null,
    binding?.evidence!=='inferred'&&!ordering?binding?.rawValue:null,
    !isOrderingQuoteUnit(row)&&!['inferred','remembered','invoice'].includes(row.sellingUnitSource)?row.sellingUnit:null,
    ...clues.map(clue=>clue?.unit),
  ].filter(present);
  const cellUnit=unitInPrice(value,procurement),headerUnit=unitInPriceHeader(header,procurement);
  const units=[...direct.map(unit=>canonicalQuoteUnit(unit,procurement)),...[cellUnit,headerUnit].filter(Boolean)];
  // A unit written after a rate or in its header still counts as evidence
  // when no interpretation exists for it yet.
  if(!cellUnit&&/^\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:\/|per\s+)\s*[a-z][a-z .]*$/i.test(value))units.push(null);
  if(!headerUnit&&/^(?:unit\s+)?(?:price|cost|rate)\s*(?:per\s+|\/|\(\s*)[a-z][a-z .]*\)?$/i.test(header.trim()))units.push(null);
  return {present:units.length>0,unit:units.length&&units.every(unit=>unit===units[0])?units[0]:null};
}
export function applySourceUnits(row,{priceCell,priceHeader,documentUnit}={}, procurement=getProcurementContext()){
  // An ordering-unit column does not state what the quoted price covers.
  let independentClues=[];
  if(isOrderingQuoteUnit(row)){
    const boundPrice=row.fieldIdentification?.bindings?.price;
    priceCell??=boundPrice?.rawValue;
    priceHeader??=boundPrice?.header??row.priceHeader;
    if(Array.isArray(row.quoteUnitEvidence))independentClues=row.quoteUnitEvidence.filter(clue=>directPriceSources.has(clue?.source));
    row={...row,orderingUnit:row.orderingUnit||row.sellingUnit,sellingUnit:null,billingUnitEvidence:null,sellingUnitSource:null,
      quoteUnitEvidence:independentClues.length?independentClues:undefined};
  }
  const clues=[
    row.sellingUnit&&{unit:canonicalQuoteUnit(row.sellingUnit, procurement),source:row.sellingUnitSource||"column"},
    {unit:unitInPrice(priceCell, procurement),source:"price cell"},
    {unit:unitInPriceHeader(priceHeader, procurement),source:"price header"},
    ...independentClues,
  ].filter(clue=>clue?.unit);
  if(new Set(clues.map(clue=>clue.unit)).size>1)return {...row,priceNeedsReview:true,
    issues:[...(row.issues||[]),PRICE_UNIT_CONFLICT_REASON],quoteUnitEvidence:clues};
  // Row/table declarations take precedence over a document-wide default.
  const clue=clues[0]||(!row.sellingUnit&&documentUnit?{unit:documentUnit,source:"document note"}:null);
  return clue?{...row,sellingUnit:row.sellingUnit||clue.unit,sellingUnitSource:clue.source,quoteUnitEvidence:row.quoteUnitEvidence||(clues.length?clues:[clue])}:row;
}
