import {industryUnitCostDefaults} from "../knowledge/category-profiles.js";
import {priceBasisFor,measurement,getProcurementContext} from '../procurement.js';
import {listingSourceForField,quotedUnitOrigin} from './listing-provenance.js';
import {printedQuoteEvidence} from './source-units.js';
import {parseAssignedMoney} from './assigned-numbers.js';
const MASS=['LB','OZ','KG','G'];
const VOLUME=['GAL','QT','PT','FLOZ','L','ML'];
export const QUOTE_GROUPS=[{value:'case',label:'Case'},{value:'each',label:'Each'},{value:'weight',label:'Weight'},{value:'volume',label:'Volume'}];
export function quoteGroup(value){
  if(value==='WEIGHT')return 'weight';if(value==='VOLUME')return 'volume';if(value==='MEASURE')return 'measure';
  const basis=priceBasisFor(value);
  if(!basis)return '';
  if(basis.basis==='case'||basis.basis==='each')return basis.basis;
  const dimension=measurement(1,basis.unit)?.dimension;
  return dimension==='mass'?'weight':dimension==='volume'?'volume':'measure';
}
export function quoteMetrics(group){return group==='weight'?MASS:group==='volume'?VOLUME:[];}
export function chooseQuoteGroup(group,previous){
  if(group==='case')return 'CASE';if(group==='each')return 'EACH';
  if(quoteGroup(previous)===group)return previous;
  return group==='weight'?'WEIGHT':group==='volume'?'VOLUME':group==='measure'?'MEASURE':'';
}
export function comparisonUnits(packSize,procurement=getProcurementContext()){
  const pack=procurement.parsePackSize(packSize);
  if(!pack?.parsed)return [];
  const units=pack.dimension==='mass'?MASS:pack.dimension==='volume'?VOLUME:procurement.unitsForDimension(pack.dimension).filter(u=>u!=='CT');
  return [...new Set([...units,pack.dimension==='unknown'?pack.unit:'EA',...(/^#\d/.test(pack.unit||'')?['EA']:[])])];
}
export function defaultComparisonUnit(packSize,industry='',procurement=getProcurementContext()){
  const pack=procurement.parsePackSize(packSize);
  if(!pack?.parsed)return '';
  return industryUnitCostDefaults(industry)[pack.dimension]||(pack.dimension==='count'?'EA':pack.unit);
}

// A retained source can establish a pack price even if the legacy unit
// field was never populated. Match the evidence to the active quote.
export function verifiedFullPackPrice(row,procurement=getProcurementContext()){
  const price=Number(row.price);
  const basis=procurement.priceBasisFor(row.selling_unit);
  if(!(price>0)||!Number.isFinite(price)||row.price_source==='invoice'||row.quoteBasisInference||
    (basis?basis.basis!=='case':String(row.selling_unit||'').trim())||
    (row.price_basis&&row.price_basis!=='case'))return null;
  if(!row.price_unavailable&&basis&&quotedUnitOrigin(row,procurement).root)return price;
  const source=listingSourceForField(row,'price');
  const original=source.row;
  const originalPack=original.originalFields?.packSize??original.originalPackRaw??original.packSize;
  const conflicts=row.import_row?.conflicts||[];
  const basisOnlyHold=conflicts.length&&conflicts.every(reason=>/^(?:Quoted unit|Pricing basis) is unresolved\.$/i.test(reason));
  if(!source.sourceDocumentId||parseAssignedMoney(original.price)!==price||!originalPack||
    original.priceUnavailable||original.priceNeedsReview||original.cellConflicts?.length||
    (row.price_unavailable&&!basisOnlyHold)||
    procurement.comparePurchasingPack(row.pack_size,originalPack).status!=='same')return null;
  return printedQuoteEvidence(original,procurement).unit==='CASE'?price:null;
}

export function verifiedPackEachCost(row,procurement=getProcurementContext()){
  if(row.field_resolutions?.unit_cost_override?.value)return null;
  const pack=procurement.parsePackSize(row.pack_size);
  if(!pack?.parsed||!row.field_resolutions?.pack_size&&row.import_row?.baseFieldCompletion?.fields?.pack_size?.caseCountKnown===false)return null;
  const count=pack.dimension==='count'&&pack.levels.length===1?pack.baseTotal:pack.caseQty;
  if(!Number.isSafeInteger(count)||count<1)return null;
  const price=verifiedFullPackPrice(row,procurement);
  return price===null?null:price/count;
}

export function calculatedUnitCost(row,{industry='',procurement=getProcurementContext()}={}){
  const override=row.field_resolutions?.unit_cost_override?.value;
  if(override&&Number(override.price)>0&&Number(override.packPrice)>0&&procurement.priceBasisFor(override.unit))return {price:Number(override.price),unit:override.unit,manual:true};
  const pack=procurement.parsePackSize(row.pack_size);
  const basis=procurement.priceBasisFor(row.selling_unit)||
    (verifiedFullPackPrice(row,procurement)!==null?procurement.priceBasisFor('CASE'):null);
  if(!pack?.parsed||!basis)return null;
  const target=row.unit_cost_unit||defaultComparisonUnit(row.pack_size,industry,procurement);
  if(!comparisonUnits(row.pack_size,procurement).includes(target))return null;
  // A stated measured rate does not depend on estimated case weight.
  if(basis.basis==='measure'){
    const direct=procurement.measuredQuoteRate(row.price,basis.unit||row.selling_unit,target);
    if(direct&&direct.dimension===pack.dimension)return direct;
  }
  const full=procurement.casePriceFromQuote(row.price,basis.basis,basis.unit||row.selling_unit,row.pack_size);
  if(full==null)return null;
  if(target==='EA'&&pack.dimension!=='count')return {price:Math.round(full/pack.caseQty*10000)/10000,unit:'EA'};
  const per=procurement.pricePerUnit(full,row.pack_size,target);
  return per&&pack.catchWeight?{...per,estimated:true}:per;
}
