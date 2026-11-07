import {packFromDescription,parsePackSize,priceBasisFor,comparePurchasingPack} from '../procurement.js';
import {canonicalQuoteUnit,documentQuoteUnit} from './source-units.js';
import {resolveFromInvoiceArithmetic} from './quote-basis.js';
import {calculatedUnitCost} from './quote-controls.js';

const normalized=value=>String(value||'').replace(/['’]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const readablePack=value=>{const p=parsePackSize(value);return p?.parsed&&(p.dimension!=='unknown'||/^#\d+(?:\.\d+)? CAN$/.test(p.unit));};
const field=(value,source,step=1,extra={})=>({value:value||null,status:value?(step===1?'stated':'shared'):'not-stated',source,step,...extra});

// Read each field independently. Ordering units and price units differ.
export function directSourceFields(row,{columnMap={},headerFound=false}={}){
  const fields={};
  if(headerFound&&columnMap.brand!==undefined)fields.brand=field(row.brand||null,'brand column');
  else if(!row.brand&&!row.details?.length)fields.brand=field(null,'no brand supplied');
  else fields.brand=field(null,'brand has no identified source column',1,{status:'unresolved'});
  const cells=row.sourceLine?.split('\t');
  const pack=headerFound&&columnMap.packSize!==undefined&&cells?.length>1?cells[columnMap.packSize]:row.packSource==='column'?row.originalPackRaw||row.packSize:row.originalPackRaw;
  fields.pack_size=readablePack(pack)?field(pack,'pack cell',1,{caseCountKnown:true}):field(null,'pack not stated');
  const conflicting=row.quoteUnitEvidence?.length>1&&new Set(row.quoteUnitEvidence.map(e=>canonicalQuoteUnit(e.unit)).filter(Boolean)).size>1;
  const unit=!conflicting&&(row.billingUnitEvidence?.kind==='pricing-unit-header'||['price cell','price header'].includes(row.sellingUnitSource))?canonicalQuoteUnit(row.sellingUnit):null;
  fields.selling_unit=unit?field(unit,row.sellingUnitSource||'price unit header'):field(null,conflicting?'quoted units conflict':'quoted unit not stated',1,conflicting?{status:'conflict'}:{});
  return fields;
}

// References are drawn only from direct brand columns, never from fallback results.
export function sourceBrandReferences(sources){
  const references=sources.flatMap(({row,columnMap,headerFound,sourceDocumentId})=>headerFound&&columnMap?.brand!==undefined&&row.brand?[{value:row.brand,sourceDocumentId,sourceLine:row.sourceLine}]:[]).sort((a,b)=>String(a.sourceDocumentId).localeCompare(String(b.sourceDocumentId))||String(a.sourceLine).localeCompare(String(b.sourceLine)));
  return [...new Map(references.map(reference=>[normalized(reference.value),reference])).values()].filter(reference=>!sources.some(({row,headerFound,columnMap})=>headerFound&&columnMap?.brand!==undefined&&row.brand&&normalized(row.brand)!==normalized(reference.value)&&(' '+normalized(row.description)+' ').includes(' '+normalized(reference.value)+' ')));
}

export function sharedSourceFields(row,direct,{brandReferences=[],documentText='',standards=[],scope={},prior=null,invoices=[]}={}){
  const shared={};
  if(!direct.brand.value&&direct.brand.status!=='conflict'){
    const ownTexts=(row.details?.length?row.details:[row.description]).map(text=>' '+normalized(text)+' ');
    const matches=brandReferences.filter(reference=>normalized(reference.value).length>=3&&ownTexts.some(text=>text.endsWith(' '+normalized(reference.value)+' ')));
    const names=[...new Set(matches.map(reference=>normalized(reference.value)))];
    if(names.length===1)shared.brand=field(matches[0].value,'printed brand matched to direct brand field',2,{references:matches});
    else if(names.length>1)shared.brand=field(null,'multiple printed brand matches',2,{status:'conflict',references:matches});
  }
  if(!direct.pack_size.value&&direct.pack_size.status!=='conflict'){
    const candidates=[];
    const primary=row.packSource==='column'&&readablePack(row.packSize)?row.packSize:null;
    for(const original of (primary?[primary]:[row.originalPackRaw,row.packSize,...(row.details||[]),row.description]).filter(Boolean)){
      const text=original.replace(/(\d)\s*([a-z])\s+([a-z])\b/gi,(whole,n,a,b)=>canonicalQuoteUnit(a+b)?n+' '+a+b:whole);
      if(/\d\s*["″]/.test(text))continue; // A second dimension cannot be silently discarded.
      if(readablePack(text)){candidates.push(text);continue;}
      const tail=packFromDescription(text);if(tail&&readablePack(tail))candidates.push(tail);
      for(const match of text.matchAll(/(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[\/x×-]\s*(?:\d+(?:\.\d+)?|\.\d+)){0,3}\s*(?:#[\d.]+\s*(?:CN|CAN)\b|[a-z]+\b)/gi))if(readablePack(match[0]))candidates.push(match[0]);
    }
    const unique=candidates.filter((candidate,index)=>!candidates.slice(0,index).some(prior=>comparePurchasingPack(prior,candidate).status==='same'));
    const ambiguousCount=!primary&&unique.length===1&&parsePackSize(unique[0])?.dimension==='count'&&unique[0].includes('/')&&!/\b(?:case|pack)\b|[x×]/i.test(row.description||'');
    if(unique.length===1&&!ambiguousCount)shared.pack_size=field(unique[0],'pack expression in the same row',2,{caseCountKnown:!!primary||/[\/x×]/i.test(unique[0])});
    else if(ambiguousCount)shared.pack_size=field(null,'count notation could describe alternate sizes',2,{status:'unresolved',candidates:unique});
    else if(unique.length>1)shared.pack_size=field(null,'multiple pack expressions need reconciliation',2,{status:'conflict',candidates:unique});
  }
  if(!direct.selling_unit.value&&direct.selling_unit.status!=='conflict'){
    const clues=[];
    const note=documentQuoteUnit(documentText)||(row.sellingUnitSource==='document note'?canonicalQuoteUnit(row.sellingUnit):null);
    if(note)clues.push({unit:note,source:'document-wide price statement'});
    for(const standard of standards)if(standard.confirmedBy&&scope.organizationId&&scope.vendorId&&standard.organizationId===scope.organizationId&&standard.vendorId===scope.vendorId&&(!standard.documentId||standard.documentId===scope.documentId)&&canonicalQuoteUnit(standard.unit))clues.push({unit:canonicalQuoteUnit(standard.unit),source:'confirmed vendor standard',reference:standard});
    const pack=direct.pack_size.value||shared.pack_size?.value;
    if(prior?.id&&scope.listingId===prior.id&&prior.organization_id===scope.organizationId&&prior.vendor_id===scope.vendorId&&prior.field_resolutions?.selling_unit?.confirmedBy&&comparePurchasingPack(pack,prior.pack_size).status==='same'){
      const unit=canonicalQuoteUnit(prior.field_resolutions.selling_unit.value);if(unit)clues.push({unit,source:'client-confirmed unit for this listing'});
    }
    if(scope.organizationId&&scope.vendorId&&invoices.length){
      const invoice=resolveFromInvoiceArithmetic({...row,sellingUnit:null,packSize:pack},invoices,scope);
      if(invoice?.conflict)clues.push({unit:null,source:'conflicting invoice evidence'});
      else if(invoice)clues.push({unit:canonicalQuoteUnit(invoice.sellingUnit),source:'matched invoice billing unit',references:invoice.invoiceReferences});
    }
    if(clues.length&&clues.every(clue=>clue.unit)&&new Set(clues.map(clue=>clue.unit)).size===1)shared.selling_unit=field(clues[0].unit,clues[0].source,2,{references:clues});
    else if(clues.length)shared.selling_unit=field(null,'shared quoted-unit evidence conflicts',2,{status:'conflict',references:clues});
  }
  return shared;
}

export function twoStepSourceCompletion(row,options={}){
  const direct=directSourceFields(row,options),shared=sharedSourceFields(row,direct,options);
  return {direct,shared,fields:{...direct,...shared}};
}
export function sourceFieldCompletion(row,options={}){return twoStepSourceCompletion(row,options).fields;}

export function trialSourceCanCalculate(row,{packEdited=false,unit}={}){
  return !!(packEdited||row.field_resolutions?.pack_size||priceBasisFor(unit)?.basis!=='case'||row.import_row?.baseFieldCompletion?.fields?.pack_size?.caseCountKnown!==false);
}

export function sourceTrialUnitCost(row,{pack,unit,packEdited=false,industry=''}={}){
  if(!trialSourceCanCalculate(row,{packEdited,unit}))return null;
  const cost=calculatedUnitCost({...row,pack_size:pack,selling_unit:unit,field_resolutions:{...row.field_resolutions,unit_cost_override:null}},{industry});
  if(cost)return cost;
  const parsed=parsePackSize(pack),basis=priceBasisFor(unit),price=Number(row.price);
  // A stated can-size class supplies a container count, never its contents' weight.
  if(parsed?.parsed&&/^#\d+(?:\.\d+)? CAN$/.test(parsed.unit)&&price>0&&Number.isFinite(price)&&!row.unit_cost_unit){
    if(basis?.basis==='case')return {price:price/parsed.total,unit:parsed.unit};
    if(basis?.basis==='each')return {price:price/parsed.unitQty,unit:parsed.unit};
  }
  return null;
}

export function trialSourceValue(row,key,{visible=false}={}){
  if(visible||row.field_resolutions?.[key])return row[key]??'';
  if(['description','price'].includes(key)&&!Object.hasOwn(row.import_row?.baseFieldCompletion?.fields||{},key))return row[key]??'';
  return row.import_row?.baseFieldCompletion?.fields?.[key]?.value??'';
}

// Trial identifiers never rewrite a vendor code or allocate production identities.
export function trialListingLabel(row,fallback='NVIN pending'){
  const label=row.import_row?.baseFieldCompletion?.trialIdentifier?.label||fallback||'NVIN pending';
  return String(label).replace(/^NVIM(?=-|\b)/,'NVIN');
}
