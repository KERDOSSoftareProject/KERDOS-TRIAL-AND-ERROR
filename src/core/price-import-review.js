import {getProcurementContext} from "../procurement.js";
import {knownItemChanges} from "./catalog-fields.js";
import {prepareImportRow} from "./import-row.js";
import {resolveQuoteBasis,quoteBasisAlternatives,resolveFromInvoiceArithmetic,interpretStatedQuotePair} from "./quote-basis.js";

const sameText=(a,b)=>String(a||"").trim().toLowerCase().replace(/\s+/g," ")===String(b||"").trim().toLowerCase().replace(/\s+/g," ");

// Called only after organization/vendor-scoped identity lookup. A changed or
// incomplete row is reviewable data, not a failed database write. The caller
// retains its listing and catalog association, and stages the incoming quote
// without overwriting the accepted quote when requiresReview is true.
export function preparePriceImport(source,prior=null,mapping=null,issues=[],invoices=[],scope=null, procurement=getProcurementContext()){
  let row=source;
  const reasons=[...issues];
  let changes=[];
  if(prior&&(source.code?String(source.code)!==String(prior.vendor_item_code):!!prior.vendor_item_code))
    throw new Error("The incoming vendor item code does not belong to this saved listing.");
  const scopedInvoices=scope?invoices.filter(entry=>
    entry.organizationId===scope.organizationId&&entry.vendorId===scope.vendorId):invoices;
  try{row=prepareImportRow(source,{prior,mapping,invoices:scopedInvoices}, procurement);}
  catch(error){reasons.push(error.message);changes=prior?knownItemChanges(source,prior, procurement):[];}
  changes=row.changes||changes;
  reasons.push(...(row.conflicts||[]));
  if(prior&&!row.knownVendorItem){
    const change=(field,before,after,reason)=>{
      reasons.push(reason);
      if(!changes.some(c=>c.field===field))changes.push({field,before,after,reason});
    };
    if(row.description&&prior.description&&!sameText(row.description,prior.description)){
      const identity=procurement.compareProductIdentity(row.description,prior.description);
      if(identity.status!=="same")change("description",prior.description,row.description,`Product needs review: ${identity.reason}.`);
    }
    if(row.brand&&prior.brand&&!procurement.brandsMatch(row.brand,prior.brand))
      change("brand",prior.brand,row.brand,`Brand changed from “${prior.brand}” to “${row.brand}”.`);
    if(row.packSize&&prior.pack_size&&!sameText(row.packSize,prior.pack_size)){
      const comparison=procurement.comparePurchasingPack(row.packSize,prior.pack_size);
      if(comparison.status!=="same")change("packSize",prior.pack_size,row.packSize,
        comparison.status==="different"?`Pack changed from “${prior.pack_size}” to “${row.packSize}”.`:
          "The incoming and saved packs cannot yet be compared; verify the quantity and unit.");
    }
    for(const [field,saved,label] of [["gtin","gtin","Barcode"],["manufacturerCode","manufacturer_code","Manufacturer code"]]){
      if(row[field]&&prior[saved]&&String(row[field])!==String(prior[saved]))
        change(field,prior[saved],row[field],`${label} differs from the saved vendor item.`);
    }
    row={...row,description:row.description||prior.description,brand:row.brand||prior.brand||"",packSize:row.packSize||prior.pack_size};
  }
  if(!procurement.parsePackSize(row.packSize)?.parsed)reasons.push(row.packSize?
    "Pack quantity or unit is unreadable; correct the pack field.":"Pack quantity and unit are missing.");
  let resolved=resolveQuoteBasis(row,prior, procurement);
  let invoiceConflict=false;
  if((!String(row.sellingUnit||"").trim()||resolved?.source==="confirmed vendor item")&&scopedInvoices.length){
    // Compare invoice evidence against the incoming product and pack wherever
    // stated, even when the saved catalog display uses the remembered fields.
    const arithmetic=resolveFromInvoiceArithmetic({...row,sellingUnit:"",
      description:source.description||row.description,packSize:source.packSize||row.packSize},scopedInvoices, undefined, procurement);
    if(arithmetic?.conflict){
      reasons.push(`Quoted unit needs review because invoice evidence conflicts. ${arithmetic.reason}.`);
      invoiceConflict=true;
    }else if(arithmetic&&resolved&&
      (arithmetic.basis.basis!==resolved.basis.basis||arithmetic.basis.unit!==resolved.basis.unit)){
      reasons.push(`Quoted unit differs between the saved listing (${resolved.sellingUnit}) and invoice evidence (${arithmetic.sellingUnit}).`);
      invoiceConflict=true;
    }else if(arithmetic&&!resolved){
      resolved=arithmetic;
      row={...row,sellingUnit:arithmetic.sellingUnit,sellingUnitSource:"invoice"};
    }
    if(invoiceConflict){
      resolved=null;
      row={...row,sellingUnit:"",sellingUnitSource:null};
    }
  }
  // A price amount or an industry prior cannot establish what is being sold.
  // Without source or confirmed listing evidence, retain the quote for review
  // and leave its basis unresolved in both preview and persistence.
  if(!row.priceUnavailable){
    if(!resolved)reasons.push("Quoted unit is unresolved.");
    else if(procurement.parsePackSize(row.packSize)?.parsed&&procurement.casePriceFromQuote(row.price,resolved.basis.basis,resolved.basis.unit||resolved.sellingUnit,row.packSize)==null)
      reasons.push(procurement.parsePackSize(row.packSize)?.catchWeight?
        "Average or ranged pack weight does not establish an exact case charge; the quoted rate is retained for review.":
        "The quoted amount, unit and pack cannot produce a valid case price.");
  }
  if(row.priceNeedsReview&&!reasons.length)reasons.push("The incoming price basis needs review.");
  const quoteBasisEvidence=resolved?.invoiceArithmetic?{source:resolved.source,unit:resolved.sellingUnit,references:resolved.invoiceReferences}:null;
  const quoteBasisReview=!resolved&&!row.priceUnavailable&&!invoiceConflict?{
    status:'unresolved',
    reason:'Confirm what the quoted price covers. Pack contents alone do not establish the quoted unit.',
    alternatives:quoteBasisAlternatives(row,procurement),
  }:null;
  const statedPriceQuotes=interpretStatedQuotePair(source.fieldIdentification?.bindings, procurement);
  return {row:{...row,changes,quoteBasisReview,...(quoteBasisEvidence?{quoteBasisEvidence}:{}),
    ...(statedPriceQuotes.length?{statedPriceQuotes}:{})},resolved,requiresReview:reasons.length>0,reasons:[...new Set(reasons)],reviewFields:priceReviewFields({reasons,changes,row,prior})};
}

// Review is tracked per field. Confirming one cell cannot accept unrelated
// incoming changes. Unknown conflicts require explicit review of each field.
export function priceReviewFields({reasons=[],changes=[],row={},prior=null}={}){
  const fields=new Set();
  const names={packSize:"pack_size",sellingUnit:"selling_unit",manufacturerCode:"identifiers",gtin:"identifiers"};
  for(const change of changes)fields.add(names[change.field]||change.field);
  for(const reason of reasons){
    const text=String(reason);
    if(/barcode|manufacturer code|gtin/i.test(text))fields.add("identifiers");
    else if(/^quoted unit/i.test(text))fields.add("selling_unit");
    else if(/pack/i.test(text))fields.add("pack_size");
    else if(/sellingUnit|quoted unit|price basis|selling unit|quoted units/i.test(text))fields.add("selling_unit");
    else if(/brand/i.test(text))fields.add("brand");
    else if(/product|description|wording/i.test(text))fields.add("description");
    else if(/price|amount/i.test(text))fields.add("price");
    else for(const key of ["description","brand","pack_size","selling_unit","price"])fields.add(key);
  }
  if(reasons.length&&prior&&Number(row.price)!==Number(prior.price))fields.add("price");
  return [...fields];
}
