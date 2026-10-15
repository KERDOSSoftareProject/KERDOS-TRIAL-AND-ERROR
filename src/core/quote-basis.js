import {compareProductIdentity,comparePurchasingPack,priceBasisFor,brandsMatch} from "../procurement.js";
import {inferPricingBasis} from "./infer-pricing-basis.js";
import {billingUnitEvidence} from "./billing-unit-evidence.js";

// Reuse a confirmed vendor-specific quote basis for a repeat import only.
// A null basis on an old record is legacy "case" and is not evidence that
// a new document with an omitted unit also quotes cases.
export function resolveQuoteBasis(row,prior=null){
  const explicit=priceBasisFor(row.sellingUnit);
  if(explicit)return {basis:explicit,sellingUnit:row.sellingUnit,source:row.sellingUnitSource==="remembered"?"confirmed vendor item":row.sellingUnitSource==="manual"?"manual selection":row.sellingUnitSource==="invoice"?"invoice evidence":"document"};
  if(String(row.sellingUnit||"").trim())return null;
  if(!prior?.price_basis||!prior.selling_unit||prior.price_source==="invoice"||prior.import_row?.reviewRequired)return null;
  const coded=row.code&&String(prior.vendor_item_code)===String(row.code);
  // The caller must resolve one unique NVIM first, within this vendor.
  const uncoded=!row.code&&!prior.vendor_item_code&&!!prior.id&&row.resolvedVendorItemId===prior.id;
  if(!coded&&!uncoded)return null;
  if(row.brand&&prior.brand&&!brandsMatch(row.brand,prior.brand))return null;
  if(row.gtin&&prior.gtin&&row.gtin!==prior.gtin)return null;
  if(row.manufacturerCode&&prior.manufacturer_code&&row.manufacturerCode!==prior.manufacturer_code)return null;
  if(compareProductIdentity(row.description,prior.description).status!=="same"||
     comparePurchasingPack(row.packSize,prior.pack_size).status!=="same")return null;
  const learned=priceBasisFor(prior.selling_unit);
  return learned?.basis===prior.price_basis?{basis:learned,sellingUnit:prior.selling_unit,source:"confirmed vendor item"}:null;
}

// Invoice billing evidence is reusable only for a consistent vendor listing.
// Arithmetic validates the source; the explicit billed unit identifies its basis.
export function resolveFromInvoiceArithmetic(row,invoices=[],scope=null){
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
    const reference={documentId:entry.id||null,number:entry.number||null,date:entry.date||null,sourceLine:invoice.sourceLine||null};
    const label=entry.number||entry.date||'invoice';
    const fail=reason=>conflicts.push(`${label}: ${reason}`);
    if(!description||!normalize(invoice.description)){
      fail('Product description is missing');continue;
    }
    if(description!==normalize(invoice.description)&&compareProductIdentity(row.description,invoice.description).status!=='same'){
      fail('Product description identity is different or unresolved for this item code');continue;
    }
    if(!row.packSize||!invoice.packSize||comparePurchasingPack(row.packSize,invoice.packSize).status!=='same'){
      fail('Purchasing pack differs, is missing, or cannot be confirmed');continue;
    }
    if(row.gtin&&invoice.gtin&&row.gtin!==invoice.gtin||row.manufacturerCode&&invoice.manufacturerCode&&row.manufacturerCode!==invoice.manufacturerCode){
      fail('Product identifier differs');continue;
    }
    const evidence=billingUnitEvidence(invoice);
    const basis=priceBasisFor(invoice.sellingUnit);
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

export function inferQuoteBasis(row) {
  if (String(row.sellingUnit||'').trim()) return null; // explicit unit already present
  const result = inferPricingBasis(row);
  if (!result.basis) return null;
  return {
    basis: result.basis,
    sellingUnit: result.sellingUnit,
    source: 'inferred',
    inferenceLevel: result.level,   // 'supported'|'suggested'|'conflicting'
    inferenceReason: result.reason,
    inferenceEvidence: result.evidence,
    inferenceConflicts: result.conflicts,
  };
}
