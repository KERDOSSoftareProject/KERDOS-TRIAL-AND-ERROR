import {getProcurementContext} from '../procurement.js';
import {isOrderingHeader,isOrderingQuoteUnit} from './source-units.js';

const own=(value,key)=>Object.hasOwn(value||{},key);
const valueFields=['description','brand','pack_size','selling_unit','price','price_basis','gtin','manufacturer_code','unit_cost_unit'];

// One active source observation, retained once while a newer observation waits
// for review. Pending row/evidence remain untouched in the existing import_row.
// A successfully applied quote replaces import_row and naturally drops this copy.
export function captureRetainedSource(listing){
  const saved=listing.import_row||{};
  if(own(saved,'retainedSource'))return saved.retainedSource||{values:{}};
  return {
    values:Object.fromEntries(valueFields.map(key=>[key,listing[key]??null])),
    row:saved.row||{},evidence:saved.evidence||saved.row||{},
    sourceDocumentId:saved.sourceDocumentId||null,sourceFileName:saved.sourceFileName||null,
  };
}

// Provenance belongs to the field value, not to whichever document arrived last.
// A changed value cannot borrow proof from an older retained observation.
export function listingSourceForField(listing,field){
  const saved=listing.import_row||{};
  if(own(saved,'retainedSource')){
    const source=saved.retainedSource;
    if(source&&own(source.values,field)&&Object.is(source.values[field]??null,listing[field]??null))
      return {row:source.row||{},evidence:source.evidence||source.row||{},sourceDocumentId:source.sourceDocumentId||null,sourceFileName:source.sourceFileName||null,bound:true};
    return {row:{},evidence:{},sourceDocumentId:null,sourceFileName:null,bound:false};
  }
  return {row:saved.row||{},evidence:saved.evidence||saved.row||{},sourceDocumentId:saved.sourceDocumentId||null,sourceFileName:saved.sourceFileName||null,bound:null};
}

const sameUnit=(left,right,procurement)=>{
  const a=procurement.priceBasisFor(left),b=procurement.priceBasisFor(right);
  return !!a&&!!b&&a.basis===b.basis&&(a.unit||null)===(b.unit||null);
};
const identity=listing=>({organizationId:listing.organization_id||null,vendorId:listing.vendor_id||null,
  vendorItemCode:listing.vendor_item_code||null,description:listing.description||'',
  packSize:listing.pack_size||'',brand:listing.brand||null,gtin:listing.gtin||null,
  manufacturerCode:listing.manufacturer_code||null});

// A root is one field-evidence record, never a linked list of remembered rows.
// Source coordinates are retained when available; older text sources keep
// their original document, header and source line rather than invented cells.
function sheetRoot(listing,source,procurement){
  const raw=source.row,e=source.evidence;
  const stated=sameUnit(raw.sellingUnit,listing.selling_unit,procurement)&&
    !isOrderingQuoteUnit(raw)&&
    !['remembered','inferred'].includes(raw.sellingUnitSource)?raw:
    sameUnit(e.sellingUnit,listing.selling_unit,procurement)&&
    !isOrderingQuoteUnit(e)&&(!isOrderingQuoteUnit(raw)||e.sellingUnitSource&&e.sellingUnitSource!=='document')&&
    !['remembered','inferred','invoice'].includes(e.sellingUnitSource)?e:null;
  if(!stated||!source.sourceDocumentId)return null;
  return {source:'sheet',value:listing.selling_unit,...identity(listing),
    documentIds:[source.sourceDocumentId],reference:source.sourceFileName||source.sourceDocumentId,
    sourceLine:stated.sourceLine||null,statedSource:stated.sellingUnitSource||'document',
    ...quotedUnitLocation(stated)};
}
export function quotedUnitLocation(row){
  const unitBinding=row.fieldIdentification?.bindings?.sellingUnit;
  const binding=unitBinding&&!isOrderingHeader(unitBinding.header)?unitBinding:null;
  const provenance=row.sourceProvenance;
  const cells=binding?provenance?.cells?.[binding.columnIndex]?.cells:[];
  return {binding,locator:{worksheet:provenance?.worksheet||null,page:provenance?.page??null,
    table:provenance?.table??null,lines:provenance?.lines||[],addresses:(cells||[]).map(c=>c.address).filter(Boolean)}};
}
function clientRoot(listing,confirmation){
  const document=confirmation.documentConfirmation;
  return {source:'client confirmation',value:listing.selling_unit,...identity(listing),
    ...(document&&{listingId:document.listingId,packSize:document.packSize}),
    documentIds:document?[document.documentId]:[],reference:'Client confirmation',confirmedBy:confirmation.confirmedBy||null,
    confirmedAt:confirmation.confirmedAt||null,confirmation:{...confirmation}};
}
export function documentUnitConfirmationMatches(confirmation,listing,procurement=getProcurementContext()){
  const document=confirmation?.documentConfirmation;
  return !!document?.operationId&&!!document.documentId&&!!document.documentFingerprint&&
    !!document.rowKey&&/^[a-f0-9]{64}$/.test(document.observationHash||'')&&
    !!confirmation.confirmedBy&&Number.isFinite(Date.parse(confirmation.confirmedAt))&&
    !!listing.id&&document.listingId===listing.id&&
    !!listing.organization_id&&document.organizationId===listing.organization_id&&
    !!listing.vendor_id&&document.vendorId===listing.vendor_id&&
    sameUnit(confirmation.value,listing.selling_unit,procurement)&&
    procurement.comparePurchasingPack(document.packSize,listing.pack_size).status==='same';
}
function invoiceRoot(listing,source,procurement){
  const proof=source.evidence.quoteBasisEvidence;
  if(!sameUnit(proof?.unit,listing.selling_unit,procurement)||proof.source!=='invoice billing unit'||
    !proof.references?.length||proof.references.some(r=>!r.documentId||!r.billingUnitEvidence))return null;
  return {source:'invoice',value:listing.selling_unit,...identity(listing),
    documentIds:[...new Set(proof.references.map(r=>r.documentId))],
    reference:proof.references.map(r=>r.number||r.date||r.documentId).join(', '),
    references:proof.references};
}
const orderingSheetRoot=root=>root?.source==='sheet'&&
  isOrderingQuoteUnit({sellingUnitHeader:root.binding?.header,sellingUnitSource:root.statedSource});
function rootMatches(root,listing,procurement){
  if(!root||!sameUnit(root.value,listing.selling_unit,procurement))return false;
  for(const [key,field] of [['organizationId','organization_id'],['vendorId','vendor_id'],['vendorItemCode','vendor_item_code']])
    if((root[key]||listing[field])&&String(root[key]||'')!==String(listing[field]||''))return false;
  if(!root.description||!root.packSize)return false;
  if(root.description!==listing.description&&procurement.compareProductIdentity(root.description,listing.description).status!=='same')return false;
  if(root.packSize!==listing.pack_size&&procurement.comparePurchasingPack(root.packSize,listing.pack_size).status!=='same')return false;
  if(root.brand&&listing.brand&&!procurement.brandsMatch(root.brand,listing.brand))return false;
  if(root.gtin&&listing.gtin&&root.gtin!==listing.gtin||root.manufacturerCode&&listing.manufacturer_code&&root.manufacturerCode!==listing.manufacturer_code)return false;
  if(root.source==='client confirmation'){
    const document=root.confirmation?.documentConfirmation;
    if(document)return documentUnitConfirmationMatches(root.confirmation,listing,procurement)&&
      root.listingId===document.listingId&&root.packSize===document.packSize&&
      root.documentIds?.length===1&&root.documentIds[0]===document.documentId&&
      root.confirmedBy===root.confirmation.confirmedBy&&root.confirmedAt===root.confirmation.confirmedAt;
    return sameUnit(root.confirmation?.value,listing.selling_unit,procurement)&&!!(root.confirmedBy||root.confirmedAt);
  }
  if(!root.documentIds?.length||root.documentIds.some(id=>!id))return false;
  if(root.source==='invoice')return !!root.references?.length&&root.references.every(r=>r.documentId&&sameUnit(r.billingUnitEvidence?.unit,listing.selling_unit,procurement))&&root.references.every(r=>root.documentIds.includes(r.documentId));
  if(root.source!=='sheet'||orderingSheetRoot(root)||!root.binding&&!root.sourceLine&&!root.statedSource)return false;
  return !root.binding||root.binding.evidence==='stated'&&sameUnit(root.binding.rawValue,listing.selling_unit,procurement);
}

export function quotedUnitOrigin(listing,procurement=getProcurementContext()){
  const source=listingSourceForField(listing,'selling_unit');
  const same=value=>sameUnit(value,listing.selling_unit,procurement);
  if(listing.quoteBasisInference?.kind==='inferred'&&same(listing.quoteBasisInference.value))
    return {...source,status:'inferred',confirmation:null,source:'inferred',root:null};
  const stored=source.evidence.fieldEvidence?.sellingUnit;
  const carried=rootMatches(stored,listing,procurement)?stored:null;
  const confirmation=listing.field_resolutions?.selling_unit;
  const confirmed=confirmation?.documentConfirmation
    ? documentUnitConfirmationMatches(confirmation,listing,procurement)
    : confirmation&&same(confirmation.value)&&(confirmation.confirmedBy||confirmation.confirmedAt);
  if(confirmed){
    const root=carried?.source==='client confirmation'&&
      carried.confirmedBy===(confirmation.confirmedBy||null)&&carried.confirmedAt===(confirmation.confirmedAt||null)&&
      carried.confirmation?.documentConfirmation?.operationId===confirmation.documentConfirmation?.operationId
      ?carried:clientRoot(listing,confirmation);
    return {...source,status:'confirmed',confirmation,source:'client confirmation',root};
  }
  if(!procurement.priceBasisFor(listing.selling_unit))return {...source,status:null,confirmation:null,source:null,root:null};
  const inference=source.evidence.fieldInference?.sellingUnit;
  const inferredFlag=source.evidence.sellingUnitSource==='inferred'&&(!source.evidence.sellingUnit||same(source.evidence.sellingUnit));
  if(inferredFlag||inference?.kind==='inferred'&&same(inference.value))
    return {...source,status:'inferred',confirmation:null,source:'inferred',root:null};
  const remembered=source.evidence.sellingUnitSource==='remembered';
  const stated=sheetRoot(listing,source,procurement);
  const direct=rootMatches(stated,listing,procurement)?stated:null;
  if(source.evidence.sellingUnitSource==='invoice'){
    const root=invoiceRoot(listing,source,procurement);
    return {...source,status:root?'confirmed':'inferred',confirmation:null,source:root?'invoice':'inferred',root,missingRoot:!root};
  }
  if(!direct&&!carried&&(same(source.row.sellingUnit)&&isOrderingQuoteUnit(source.row)||
    same(source.evidence.sellingUnit)&&isOrderingQuoteUnit(source.evidence)||
    same(stored?.value)&&orderingSheetRoot(stored))){
    return {...source,status:null,confirmation:null,source:null,root:null,orderingUnitOnly:true};
  }
  if(remembered){
    const root=direct||carried;
    return {...source,status:root?'confirmed':'inferred',confirmation:null,source:root?'remembered':'inferred',root,
      missingRoot:!root};
  }
  if(same(source.evidence.sellingUnit)||same(source.row.sellingUnit)){
    // Direct source fields retain their existing display policy. Automatic
    // reuse additionally requires the durable source-document root below.
    return {...source,status:'confirmed',confirmation:null,
      source:same(source.evidence.sellingUnit)?source.evidence.sellingUnitSource||'document':'document',root:direct};
  }
  return {...source,status:null,confirmation:null,source:null,root:null};
}

export function quotedUnitRootReason(origin){
  const root=origin.root;
  if(!root)return 'Original confirmation evidence is missing; review the pricing basis';
  const at=root.source==='client confirmation'&&root.confirmedAt?` on ${root.confirmedAt}`:'';
  const cell=root.locator?.addresses?.join(', ');
  const header=root.binding?.header;
  const place=[header,cell].filter(Boolean).join(', ');
  const label=root.source==='client confirmation'?`Client confirmation${at}`:
    root.source==='invoice'?`Verified invoice ${root.reference}`:`Stated on ${root.reference}${place?` (${place})`:''}`;
  return `${label}, reused`;
}

// Called only by the scoped writer, after interpretation. Module B's original
// row remains separate. The root uses the existing per-field evidence model.
export function retainQuotedUnitRoot(row,listing,procurement=getProcurementContext()){
  const origin=quotedUnitOrigin(listing,procurement);
  return origin.root?{...row,fieldEvidence:{...row.fieldEvidence,sellingUnit:origin.root}}:row;
}
