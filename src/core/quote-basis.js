import {listingSourceForField,quotedUnitOrigin,quotedUnitLocation} from './listing-provenance.js';
import {getProcurementContext} from "../procurement.js";
import {billingUnitEvidence} from "./billing-unit-evidence.js";
import {parseAssignedMoney} from "./assigned-numbers.js";
import {unitLabel} from "./unit-labels.js";
import {hasPrintedQuoteUnit,printedQuoteEvidence,unitInPrice,unitInPriceHeader} from "./source-units.js";

// Interpret only bound source prices. Each amount keeps its own header
// and coordinates, independent of calculations or later client edits.
export function interpretStatedQuotePair(bindings, procurement=getProcurementContext()){
  const primary=bindings?.price,parallel=bindings?.parallelPrice;
  if(!primary||!parallel||primary.columnIndex===parallel.columnIndex||
    primary.evidence==="inferred"||parallel.evidence==="inferred")return [];
  const fields=[primary,parallel].map(source=>({source,sellingUnit:unitInPriceHeader(source.header, procurement)}));
  const units=fields.map(field=>field.sellingUnit);
  if(!units.includes("CASE")||!units.includes("EACH"))return [];
  return fields.flatMap(({source,sellingUnit})=>{
    const price=parseAssignedMoney(source.rawValue);
    const cellUnit=unitInPrice(source.rawValue, procurement);
    return price>0&&(!cellUnit||cellUnit===sellingUnit)?[{source,sellingUnit,price}]:[];
  });
}


// Pack contents describe possible price bases, not a vendor's actual offer.
// These unranked examples support clarification; no amount or product prior
// participates, and none may become a resolved unit without further evidence.
export function quoteBasisAlternatives(row, procurement=getProcurementContext()){
  const pack=procurement.parsePackSize(row.packSize);
  if(!pack?.parsed||pack.dimension==='unknown'||!(pack.caseQty>0)||!(pack.unitQty>0))return [];
  const choices=[
    {sellingUnit:'CASE',label:`the full pack (${pack.caseStr})`},
    {sellingUnit:'EACH',label:`one package (${pack.eachStr})`},
  ];
  if(procurement.priceBasisFor(pack.unit)?.basis==='measure')
    choices.push({sellingUnit:pack.unit,label:`by ${unitLabel(pack.unit).toLowerCase()}`});
  return choices;
}

// Deeper inference uses only this client's current, source-backed quotes for
// the same product and pack. A single peer or an amount alone is insufficient.
// The 25% window is a similarity bound for an inferred, non-orderable quote.
// For a saved basis, require an outlier against every reference before replacing it.
export function inferCrossVendorQuoteBasis(row,listings=[],scope=null,procurement=getProcurementContext(),{currentUnit,linkedPeerIds,settings,now}={}){
  if(!scope?.organizationId||!scope.vendorId||(!currentUnit&&String(row.sellingUnit||'').trim())||row.priceUnavailable||!(Number(row.price)>0))return null;
  const pack=procurement.parsePackSize(row.packSize);
  if(!pack?.parsed||pack.catchWeight||pack.dimension==='unknown')return null;
  const byVendor=new Map();
  const newestFirst=[...listings].sort((a,b)=>String(b.last_updated||'').localeCompare(String(a.last_updated||''))||
    String(a.id||'').localeCompare(String(b.id||'')));
  for(const peer of newestFirst){
    if(!peer.id||peer.organization_id!==scope.organizationId||!peer.vendor_id||peer.vendor_id===scope.vendorId)continue;
    if(byVendor.has(peer.vendor_id)||procurement.quoteStatus(peer,settings,now)!=='current'||peer.import_row?.reviewRequired)continue;
    const origin=quotedUnitOrigin(peer,procurement);
    if(origin.status!=='confirmed')continue;
    const confirmation=origin.confirmation?.value;
    const confirmedUnit=confirmation||origin.row.sellingUnit||origin.evidence.sellingUnit;
    if(!confirmedUnit)continue;
    const stated=procurement.priceBasisFor(confirmedUnit),basis=procurement.priceBasisFor(peer.selling_unit);
    if(!stated||!basis||JSON.stringify(stated)!==JSON.stringify(basis)||peer.price_basis!==basis.basis)continue;
    if(procurement.comparePurchasingPack(row.packSize,peer.pack_size).status!=='same')continue;
    if(!linkedPeerIds?.has(peer.id)){
      if(procurement.compareProductIdentity(row.description,peer.description).status!=='same')continue;
      if(row.brand&&peer.brand&&!procurement.brandsMatch(row.brand,peer.brand))continue;
      if(row.gtin&&peer.gtin&&row.gtin!==peer.gtin||row.manufacturerCode&&peer.manufacturer_code&&row.manufacturerCode!==peer.manufacturer_code)continue;
    }
    const casePrice=procurement.casePriceFromQuote(peer.price,basis.basis,basis.unit||peer.selling_unit,peer.pack_size);
    if(!(casePrice>0))continue;
    byVendor.set(peer.vendor_id,{vendorItemId:peer.id,vendorId:peer.vendor_id,sourceDocumentId:origin.sourceDocumentId||null,
      description:peer.description,packSize:peer.pack_size,price:Number(peer.price),sellingUnit:peer.selling_unit,casePrice,confirmationSource:confirmation?'client confirmation':'document',confirmedBy:origin.confirmation?.confirmedBy||null,confirmedAt:origin.confirmation?.confirmedAt||null});
  }
  if(byVendor.size<2)return null;
  const references=[...byVendor.values()].sort((a,b)=>a.vendorItemId.localeCompare(b.vendorItemId));
  const caseCharge=unit=>{
    const basis=procurement.priceBasisFor(unit);
    return basis?procurement.casePriceFromQuote(row.price,basis.basis,basis.unit||unit,row.packSize):null;
  };
  const withinRange=(charge,peer)=>Math.abs(charge-peer.casePrice)/peer.casePrice<=0.25;
  const currentCharge=caseCharge(currentUnit);
  if(currentCharge>0&&references.some(peer=>withinRange(currentCharge,peer)))return null;
  const plausible=quoteBasisAlternatives(row,procurement).filter(option=>{
    const charge=caseCharge(option.sellingUnit);
    return charge>0&&references.every(peer=>withinRange(charge,peer));
  });
  // When package and case cover the same quantity, do not invent a distinction.
  if(plausible.length!==1)return null;
  const sellingUnit=plausible[0].sellingUnit;
  return {value:sellingUnit,kind:'inferred',source:'cross-vendor comparison',accuracy:70,
    reason:`Likely ${sellingUnit}: the same product and pack has source-backed quotes from ${references.length} other vendors. Only this basis puts the equivalent case charge within 25% of every reference. Confirm before using it.`,
    evidence:{packSize:row.packSize,price:Number(row.price),relativeTolerance:0.25,references,
      ...(currentCharge>0&&{previousUnit:currentUnit,previousCasePrice:currentCharge,inferredCasePrice:caseCharge(sellingUnit)})}};
}

// Project a saved quote for comparison and display. The saved quote and its
// evidence stay available, and an inferred projection never becomes orderable.
export function normalizeCatalogQuote(listing,peers,{item,mapping,groupMappings,settings,now,procurement=getProcurementContext()}={}){
  if(peers.length<2||listing.quoteBasisInference||listing.price_source==='invoice'||
    listing.field_resolutions?.unit_cost_override?.value||
    item?.brand_locked&&!procurement.brandsMatch(listing.brand,item.locked_brand))return listing;
  const approval=listing.field_resolutions?.row_approval;
  if(approval?.catalogItemId===item?.id&&approval?.confirmedAt&&
    Date.parse(approval.confirmedAt)===Date.parse(listing.last_updated))return listing;
  const origin=quotedUnitOrigin(listing,procurement);
  const amountSource=listingSourceForField(listing,'price');
  if(origin.root?.source==='sheet'||origin.root?.source==='invoice'||origin.confirmation?.documentConfirmation||
    !amountSource.sourceDocumentId||Number(amountSource.row.price)!==Number(listing.price)||
    printedQuoteEvidence(amountSource.row,procurement).present)return listing;
  const group=listing.field_resolutions?.product_group;
  const sameGroup=item&&mapping?.catalog_item_id===item.id&&
    (mapping.comparison_track==='exact'&&mapping.confidence_score===100||
      mapping.match_method==='manual'&&group?.confirmed===true&&group.catalogItemId===item.id&&
      procurement.compareProductIdentity(group.description,listing.description).status!=='different');
  const linkedPeerIds=sameGroup?new Set((groupMappings||[]).filter(peerMapping=>peerMapping.catalog_item_id===item.id&&
    peerMapping.comparison_track==='exact'&&peerMapping.confidence_score===100).map(peerMapping=>peerMapping.vendor_item_id)):null;
  const row={...amountSource.row,description:listing.description,packSize:listing.pack_size,price:listing.price,
    brand:listing.brand,gtin:listing.gtin,manufacturerCode:listing.manufacturer_code,sellingUnit:listing.selling_unit,
    // A retained amount may be held because its basis is under review. The
    // original availability and review fields still govern ordering.
    priceUnavailable:amountSource.row.priceUnavailable};
  const comparisonPeers=item?.brand_locked?peers.filter(peer=>procurement.brandsMatch(peer.brand,item.locked_brand)):peers;
  const inference=inferCrossVendorQuoteBasis(row,comparisonPeers,{organizationId:listing.organization_id,vendorId:listing.vendor_id},
    procurement,{currentUnit:listing.selling_unit,linkedPeerIds,settings,now});
  if(!inference)return listing;
  const source=amountSource.row;
  const statedPack=source.originalFields?.packSize||source.originalPackRaw||source.packSize;
  const unitPack=statedPack||procurement.packFromDescription(source.description);
  const unit=procurement.parsePackSize(unitPack);
  const savedPack=procurement.parsePackSize(listing.pack_size);
  // A price inferred per inner unit establishes only the unit the vendor
  // described. A peer's outer case count is not evidence for this vendor.
  const matchesInnerUnit=inference.value==='EACH'&&unit?.parsed&&unit.caseQty===1&&
    !unit.catchWeight&&savedPack.caseQty>1&&unit.dimension===savedPack.dimension&&
    procurement.comparePurchasingPack(unitPack,savedPack.eachStr).status==='same';
  if(matchesInnerUnit){
    inference.packSize=unitPack;
    inference.reason+=` The source describes ${unitPack}. The saved outer case count has no matching source evidence.`;
  }
  return {...listing,pack_size:inference.packSize||listing.pack_size,
    selling_unit:inference.value,price_basis:procurement.priceBasisFor(inference.value).basis,quoteBasisInference:inference};
}

// Reuse a confirmed vendor-specific quote basis for a repeat import only.
// A null basis on an old record is legacy "case" and is not evidence that
// a new document with an omitted unit also quotes cases.
export function resolveQuoteBasis(row,prior=null, procurement=getProcurementContext(),source=row){
  if(row.sellingUnitSource==='inferred')return null;
  const explicit=procurement.priceBasisFor(row.sellingUnit);
  if(explicit&&row.sellingUnitSource==='remembered'){
    const origin=quotedUnitOrigin({...prior,description:row.description,pack_size:row.packSize,
      selling_unit:row.sellingUnit,import_row:{row:{},evidence:row}},procurement);
    return origin.status==='confirmed'&&origin.root&&canReuseDocumentUnit(origin.root,source,procurement)?{basis:explicit,sellingUnit:row.sellingUnit,
      source:'confirmed vendor item',unitRoot:origin.root}:null;
  }
  if(explicit)return {basis:explicit,sellingUnit:row.sellingUnit,source:row.sellingUnitSource==="remembered"?"confirmed vendor item":row.sellingUnitSource==="manual"?"manual selection":row.sellingUnitSource==="invoice"?"invoice evidence":"document"};
  if(String(row.sellingUnit||"").trim()||row.changes?.length)return null;
  const origin=prior?quotedUnitOrigin(prior,procurement):null;
  if(!prior?.price_basis||!prior.selling_unit||prior.price_source==="invoice"||prior.import_row?.reviewRequired||origin.status!=="confirmed"||!origin.root)return null;
  const coded=row.code&&String(prior.vendor_item_code)===String(row.code);
  // The caller must resolve one unique NVIN first, within this vendor.
  const uncoded=!row.code&&!prior.vendor_item_code&&!!prior.id&&row.resolvedVendorItemId===prior.id;
  if(!coded&&!uncoded)return null;
  if(row.brand&&prior.brand&&!procurement.brandsMatch(row.brand,prior.brand))return null;
  if(row.gtin&&prior.gtin&&row.gtin!==prior.gtin)return null;
  if(row.manufacturerCode&&prior.manufacturer_code&&row.manufacturerCode!==prior.manufacturer_code)return null;
  const normalizedDescription=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
  const sourceDescription=normalizedDescription(source.description);
  // A verified listing can repeat the exact source wording even when the
  // industry dictionary still considers one of its abbreviations ambiguous.
  const sameConfirmedWording=origin.root.confirmation?.documentConfirmation&&
    sourceDescription&&sourceDescription===normalizedDescription(prior.description);
  if((!sameConfirmedWording&&procurement.compareProductIdentity(row.description,prior.description).status!=="same")||
     procurement.comparePurchasingPack(row.packSize,prior.pack_size).status!=="same")return null;
  if(!canReuseDocumentUnit(origin.root,source,procurement))return null;
  const learned=procurement.priceBasisFor(prior.selling_unit);
  return learned?.basis===prior.price_basis?{basis:learned,sellingUnit:prior.selling_unit,source:"confirmed vendor item",unitRoot:origin.root}:null;
}

function canReuseDocumentUnit(root,source,procurement){
  const document=root.confirmation?.documentConfirmation;
  if(!document)return true;
  const printedPack=Object.hasOwn(source.originalFields||{},'packSize')?source.originalFields.packSize:source.packSize;
  return !source.cellConflicts?.length&&!source.issues?.length&&!source.requiresReview&&!hasPrintedQuoteUnit(source,procurement)&&
    procurement.comparePurchasingPack(printedPack,document.packSize).status==='same';
}

// Invoice billing evidence is reusable only for a consistent vendor listing.
// Arithmetic validates the source; the explicit billed unit identifies its basis.
export function resolveFromInvoiceArithmetic(row,invoices=[],scope=null, procurement=getProcurementContext()){
  if(String(row.sellingUnit||'').trim())return null;
  const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const code=String(row.code||'').trim(),description=normalize(row.description);
  const usable=[],conflicts=[];
  for(const entry of invoices){
    if(scope&&(entry.organizationId!==scope.organizationId||entry.vendorId!==scope.vendorId))continue;
    const invoice=entry.row;
    if(!invoice)continue;
    const invoiceCode=String(invoice.code||'').trim();
    const codeMatch=!!code&&code===invoiceCode;
    const uncodedMatch=!code&&!invoiceCode&&!!description&&description===normalize(invoice.description);
    if(!codeMatch&&!uncodedMatch)continue;
    const reference={documentId:entry.id||null,number:entry.number||null,date:entry.date||null,sourceLine:invoice.sourceLine||null,...quotedUnitLocation(invoice)};
    const label=entry.number||entry.date||'invoice';
    const fail=reason=>conflicts.push(`${label}: ${reason}`);
    if(!description||!normalize(invoice.description)){
      fail('Product description is missing');continue;
    }
    if(description!==normalize(invoice.description)&&procurement.compareProductIdentity(row.description,invoice.description).status!=='same'){
      fail('Product description identity is different or unresolved for this item code');continue;
    }
    if(!row.packSize||!invoice.packSize||procurement.comparePurchasingPack(row.packSize,invoice.packSize).status!=='same'){
      fail('Purchasing pack differs, is missing, or cannot be confirmed');continue;
    }
    if(row.gtin&&invoice.gtin&&row.gtin!==invoice.gtin||row.manufacturerCode&&invoice.manufacturerCode&&row.manufacturerCode!==invoice.manufacturerCode){
      fail('Product identifier differs');continue;
    }
    const evidence=billingUnitEvidence(invoice);
    const basis=procurement.priceBasisFor(invoice.sellingUnit);
    if(!evidence||!basis){fail('Explicit billed-unit evidence is missing or ambiguous');continue;}
    if(invoice.requiresReview||invoice.priceNeedsReview||invoice.issues?.length||invoice.cellConflicts?.length){
      fail('Invoice has unresolved issues or conflicting billing evidence');continue;
    }
    const {qty,price,amount}=invoice;
    if([qty,price,amount].some(value=>value==null||value===''||!Number.isFinite(Number(value))||Number(value)<=0)){
      fail('Billed quantity, unit price, or line total is missing or invalid');continue;
    }
    if(Math.abs(Number(qty)*Number(price)-Number(amount))>0.025){
      fail('Billed quantity × unit price does not reconcile with line total');continue;
    }
    usable.push({basis,unit:basis.basis==='case'?'CS':basis.basis==='each'?'EA':basis.unit,reference,evidence});
  }
  if(conflicts.length)return {conflict:true,reason:conflicts.join('; '),invoiceReference:conflicts.join('; ')};
  if(!usable.length)return null;
  const first=usable[0];
  if(usable.some(value=>value.unit!==first.unit||value.basis.basis!==first.basis.basis))return {conflict:true,reason:'Invoices disagree on billing unit',invoiceReferences:usable.map(value=>value.reference)};
  return {basis:first.basis,sellingUnit:first.unit,source:'invoice billing unit',invoiceArithmetic:true,
    invoiceReference:usable.map(value=>value.reference.number||value.reference.date||'invoice').join(', '),
    invoiceReferences:usable.map(value=>({...value.reference,billingUnitEvidence:value.evidence}))};
}
