import {packFromDescription,parsePackSize} from '../procurement.js';
import {canonicalQuoteUnit} from './source-units.js';

// Read each field independently. Ordering units and price units differ.
export function sourceFieldCompletion(row,{columnMap={},headerFound=false}={}){
  const fields={};
  const stated=(value,source)=>({value,status:value?'stated':'not-stated',source});
  if(headerFound&&columnMap.brand!==undefined)fields.brand=stated(row.brand||null,'brand column');
  else if(!row.brand&&!row.details?.length)fields.brand=stated(null,'no brand supplied');
  else fields.brand={value:null,status:'unresolved',source:'brand has no identified source column'};
  const pack=row.originalPackRaw||row.packSize||packFromDescription(row.description);
  const parsed=pack&&parsePackSize(pack);
  fields.pack_size=parsed?.parsed&&parsed.dimension!=='unknown'?stated(pack,row.packSize?'pack cell':'description'):stated(null,'pack not stated');
  const unit=row.billingUnitEvidence?.kind==='pricing-unit-header'||['price cell','price header','document note'].includes(row.sellingUnitSource)?canonicalQuoteUnit(row.sellingUnit):null;
  fields.selling_unit=unit?stated(unit,row.sellingUnitSource||'price unit header'):stated(null,'quoted unit not stated');
  return fields;
}

export function trialSourceValue(row,key,{visible=false}={}){
  if(visible||row.field_resolutions?.[key])return row[key]??'';
  return row.import_row?.baseFieldCompletion?.fields?.[key]?.value??'';
}
