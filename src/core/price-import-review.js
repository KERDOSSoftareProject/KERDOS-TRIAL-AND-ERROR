import {brandsMatch,casePriceFromQuote,compareProductIdentity,comparePurchasingPack,parsePackSize} from "../procurement.js";
import {knownItemChanges} from "./catalog-fields.js";
import {prepareImportRow} from "./import-row.js";
import {resolveQuoteBasis,inferQuoteBasis,resolveFromInvoiceArithmetic} from "./quote-basis.js";

const sameText=(a,b)=>String(a||"").trim().toLowerCase().replace(/\s+/g," ")===String(b||"").trim().toLowerCase().replace(/\s+/g," ");

// Called only after organization/vendor-scoped identity lookup. A changed or
// incomplete row is reviewable data, not a failed database write. The caller
// retains its listing and catalog association, and stages the incoming quote
// without overwriting the accepted quote when requiresReview is true.
export function preparePriceImport(source,prior=null,mapping=null,issues=[],invoices=[],scope=null){
  let row=source;
  const reasons=[...issues];
  let changes=[];
  if(prior&&(source.code?String(source.code)!==String(prior.vendor_item_code):!!prior.vendor_item_code))
    throw new Error("The incoming vendor item code does not belong to this saved listing.");
  try{row=prepareImportRow(source,{prior,mapping,invoices});}
  catch(error){reasons.push(error.message);changes=prior?knownItemChanges(source,prior):[];}
  changes=row.changes||changes;
  reasons.push(...(row.conflicts||[]));
  if(prior&&!row.knownVendorItem){
    const change=(field,before,after,reason)=>{
      reasons.push(reason);
      if(!changes.some(c=>c.field===field))changes.push({field,before,after,reason});
    };
    if(row.description&&prior.description&&!sameText(row.description,prior.description)){
      const identity=compareProductIdentity(row.description,prior.description);
      if(identity.status!=="same")change("description",prior.description,row.description,`Product needs review: ${identity.reason}.`);
    }
    if(row.brand&&prior.brand&&!brandsMatch(row.brand,prior.brand))
      change("brand",prior.brand,row.brand,`Brand changed from “${prior.brand}” to “${row.brand}”.`);
    if(row.packSize&&prior.pack_size&&!sameText(row.packSize,prior.pack_size)){
      const comparison=comparePurchasingPack(row.packSize,prior.pack_size);
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
  if(!parsePackSize(row.packSize)?.parsed)reasons.push(row.packSize?
    "Pack quantity or unit is unreadable; correct the pack field.":"Pack quantity and unit are missing.");
  let resolved=resolveQuoteBasis(row,prior);
  // When no explicit unit and no prior, try invoice billing unit evidence.
  // The UOM column on a matching invoice row identifies the basis.
  // Arithmetic reconciliation confirms consistency but does not identify the basis alone.
  if(!resolved&&!String(row.sellingUnit||'').trim()&&invoices.length){
    const arithmetic=resolveFromInvoiceArithmetic(row,invoices,scope);
    if(arithmetic){
      if(arithmetic.conflict){
        // Invoices disagree — flag for review, do not resolve
        reasons.push('Invoice billing units conflict ('+arithmetic.reason+'). Confirm the correct basis.');
      } else {
        // Agreed billing unit from invoice — source evidence, no review needed for basis
        resolved=arithmetic;
      }
    }
  }
  // When no explicit unit, no prior, and no invoice arithmetic, try inference.
  if(!resolved&&!String(row.sellingUnit||'').trim()){
    const inferred=inferQuoteBasis(row);
    if(inferred){
      if(inferred.inferenceLevel==='supported'){
        // Strong evidence — populate automatically, no review needed for the basis alone
        resolved=inferred;
      } else if(inferred.inferenceLevel==='suggested'){
        // Plausible but not confirmed — set as resolved so price math works,
        // but mark the row for review so the client can confirm or change it.
        // Write sellingUnitSource="inferred" so catalogRowEvidence can distinguish
        // this from document-stated units and show it as unconfirmed.
        resolved={...inferred,sellingUnitSource:'inferred'};
        row={...row,sellingUnitSource:'inferred'};
        reasons.push(`Pricing basis "${inferred.sellingUnit}" suggested but not confirmed: ${inferred.inferenceReason}`);
      }
      // 'conflicting' → resolved stays null, falls through to "Quoted unit is unresolved"
      // with additional context from the conflict
      if(inferred.inferenceLevel==='conflicting'){
        reasons.push(`Pricing basis unclear: ${inferred.inferenceReason}`);
      }
    }
  }
  if(!row.priceUnavailable){
    if(!resolved)reasons.push("Quoted unit is unresolved.");
    else if(parsePackSize(row.packSize)?.parsed&&casePriceFromQuote(row.price,resolved.basis.basis,resolved.basis.unit||resolved.sellingUnit,row.packSize)==null)
      reasons.push("The quoted amount, unit and pack cannot produce a valid case price.");
  }
  if(row.priceNeedsReview&&!reasons.length)reasons.push("The incoming price basis needs review.");
  const quoteBasisEvidence=resolved?.invoiceArithmetic?{source:resolved.source,unit:resolved.sellingUnit,references:resolved.invoiceReferences}:null;
  return {row:{...row,changes,...(quoteBasisEvidence?{quoteBasisEvidence}:{})},resolved,requiresReview:reasons.length>0,reasons:[...new Set(reasons)],reviewFields:priceReviewFields({reasons,changes,row,prior})};
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
