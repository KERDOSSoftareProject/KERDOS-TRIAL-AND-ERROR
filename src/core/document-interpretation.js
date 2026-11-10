import {normalizeColumnPack,unmangleExcelDatePack} from "./pack-column.js";
import {getProcurementContext} from "../procurement.js";
import {parseAssignedMoney} from "./assigned-numbers.js";
import {analyzeRow} from "./cell-analysis.js";
import {withoutDescriptionFormatting} from "./field-identification.js";
import {assessBoundFields,withRowValidation} from "./field-validation.js";
import {applySourceUnits,documentQuoteUnit} from "./source-units.js";

function sourceInference(field,value,source,accuracy,evidence){
  return {[field]:{value,kind:"inferred",source,accuracy,evidence}};
}

export function inferDetailBrand(row,knownBrands,procurement=getProcurementContext()){
  if(row.brand)return row;
  const found=row.details?.find(detail=>knownBrands.some(known=>procurement.brandsMatch(known,detail)));
  return found?{...row,brand:found,brandSource:"details",
    fieldInference:{...row.fieldInference,...sourceInference("brand",found,"unlabeled source cell",70,{rawValue:found,sourceLine:row.sourceLine})}}:row;
}

function packInference(pack,description,row){
  return sourceInference("packSize",pack,"source description",90,{
    rawValue:description,
    sourceLine:row.sourceLine,
    ...(row.fieldIdentification?.anchor&&{columnIndex:row.fieldIdentification.anchor.columnIndex}),
  });
}

function interpretTabularRow(row,placement,procurement){
  const {sourceHeaders,descriptionColumn}=placement;
  const fields=row.fieldIdentification;
  let description=withoutDescriptionFormatting(row.description);
  const columnPack=normalizeColumnPack(unmangleExcelDatePack(row.packSize||""),procurement)||null;
  const descriptionPack=columnPack?null:procurement.packFromDescription(description);
  if(descriptionPack){
    const packPosition=description.lastIndexOf(descriptionPack);
    if(packPosition>4)description=description.slice(0,packPosition).replace(/[,\s]+$/,"").trim();
  }
  // An unlabeled token can suggest a code only before the description.
  // A labeled note stays a detail, even when it resembles a code.
  const candidate=!row.code&&fields.bindings.code===undefined&&Number.isInteger(descriptionColumn)
    ?placement.details.find(({value,index})=>index<descriptionColumn&&
      !/^(?:(?:item|product)\s+)?(?:notes?|details?|comments?|remarks?)$/i.test(sourceHeaders[index]?.trim()||"")&&
      /^[A-Z0-9][A-Z0-9\-\/.]{2,15}$/i.test(value)&&/\d/.test(value)&&
      !/^\d+(?:\.\d+)?[/-]\d+(?:\.\d+)?$/.test(value)&&!procurement.parsePackSize(value)?.parsed):null;
  const inferredCodeColumn=candidate?fields.anchor.columnIndex-descriptionColumn+candidate.index:undefined;
  const details=placement.details.filter(cell=>cell!==candidate).map(cell=>cell.value);
  const fullDescription=placement.missingDescription?"":[description,...details.filter(detail=>!description.toLowerCase().includes(detail.toLowerCase()))].join(" ").trim();
  const {fields:quality,cellIssues}=assessBoundFields(fields,procurement);
  const issues=[...row.issues,...["qty","amount"].filter(role=>cellIssues[role]).map(role=>({
    kind:"invalid-assigned-field",field:role,message:cellIssues[role],
  }))];
  const analyzed=analyzeRow(placement.analysisCells,placement.headerHints,row.priceHeader,new Set(placement.confirmedColumns),procurement);
  const price=analyzed.resolved.price;
  const fieldInference={
    ...(descriptionPack&&packInference(descriptionPack,row.description,row)),
    ...(candidate&&sourceInference("code",candidate.value,"unlabeled source cell",70,{
      rawValue:candidate.value,sourceLine:row.sourceLine,columnIndex:inferredCodeColumn,
    })),
  };
  return applySourceUnits({
    ...row,
    description:fullDescription.slice(0,120),
    sourceDescription:row.description,
    details,
    code:candidate?.value??row.code,
    codeSource:candidate?"details":row.codeSource,
    gtin:procurement.normalizeGtin(row.gtin),
    manufacturerCode:procurement.normalizeManufacturerCode(row.manufacturerCode),
    packSize:columnPack||descriptionPack||null,
    packSource:columnPack?"column":descriptionPack?"description":null,
    ...(Object.keys(fieldInference).length&&{fieldInference}),
    originalPackRaw:analyzed.resolved.pack?.originalRaw||null,
    priceUnavailable:row.priceUnavailable||price?.priceUnavailable||false,
    requiresReview:row.requiresReview||price?.requiresReview||false,
    fieldValidation:{...row.fieldValidation,fields:quality},
    cellIssues:Object.keys(cellIssues).length?cellIssues:undefined,
    cellUnresolved:analyzed.unresolved.length?analyzed.unresolved:null,
    cellConflicts:analyzed.conflicts.length?analyzed.conflicts:null,
    issues,
  },{priceCell:placement.priceRaw,priceHeader:row.priceHeader},procurement);
}

function interpretContextualRow(row,procurement){
  const pack=procurement.packFromDescription(row.description);
  const index=pack?procurement.normalizeMixedFraction(row.description).lastIndexOf(pack):-1;
  const split=index>4;
  return {...row,sourceDescription:row.description,
    description:(split?row.description.slice(0,index).replace(/[,\s]+$/,"").trim():row.description).slice(0,120),
    packSize:split?pack:null,packSource:split?"description":null,
    originalPackSize:split?row.description.slice(index).replace(/[.,\s]+$/,"").trim():null,
    ...(split&&{fieldInference:packInference(pack,row.description,row)})};
}

function interpretGoodsInvoiceRow(row,placement,procurement){
  const measure=procurement.measurement(1,placement.uom);
  const measured=["mass","volume","length"].includes(measure?.dimension);
  const weight=measured&&placement.weight!==null?Number(placement.weight):null;
  const product=measured&&placement.measuredProduct?placement.measuredProduct:row;
  const qty=measured?weight:row.deliveredQty;
  const issues=[];
  if(!product.description)issues.push("Product description could not be identified");
  if(!product.packSize)issues.push("Pack size needs review");
  if(measure?.dimension==="unknown"&&!/^(?:CS|CASE|BX|BOX|PK|PACK|CT|CARTON|PALLET)$/i.test(placement.uom))issues.push("Selling unit is not recognized; verify the billed quantity basis");
  if(qty===null||!Number.isFinite(qty))issues.push("Measured billed quantity is missing for this selling unit");
  else if(Math.abs(qty*row.price-row.amount)>0.025)issues.push("Billed quantity and unit price do not reconcile with extended total");
  return {...row,description:product.description.slice(0,120),packSize:product.packSize,qty,weight,
    quantitySource:weight===null?null:{kind:"goods-invoice-weight",header:placement.headerLine.match(/\b(Weight|Billed\s+Quantity)\b/i)[1],rawValue:placement.weight,headerLine:placement.headerLine},
    priceBasis:measured?"measure":"selling-unit",issues};
}

function interpretPlacedRow({placement,...row},procurement){
  if(placement?.kind==="tabular")return interpretTabularRow(row,placement,procurement);
  if(placement?.kind==="contextual")return interpretContextualRow(row,procurement);
  if(placement?.kind==="goods-invoice")return interpretGoodsInvoiceRow(row,placement,procurement);
  if(placement?.kind==="freeform-label")return {...row,sourceDescription:row.description,description:row.description.slice(0,120)};
  return row;
}

function reviewUncertainRows(rows,documentKind){
  return rows.map(row=>{
    const issues=[...(row.issues||[])];
    const bindings=row.fieldIdentification?.bindings;
    const amountField=bindings?.amount;
    const priceField=bindings?.price;
    const amountIsPriceCell=amountField?.columnIndex===priceField?.columnIndex;
    const explicitTotal=/^(?:total\b|ext(?:ended)?\b|line\s+(?:total|amount)\b)/i.test(amountField?.header?.trim()||"");
    const amountWithoutUnitPrice=amountField&&row.amount!=null&&
      (amountIsPriceCell||parseAssignedMoney(priceField?.rawValue)===null);
    const isInvoice=documentKind==="invoice";
    if(amountWithoutUnitPrice&&(isInvoice||explicitTotal||bindings.qty||priceField)){
      issues.push(isInvoice?"Invoice unit price is missing; the extended amount cannot be used as a unit price":
        "The row's extended amount is not a stated unit price; verify the quoted price");
      const validation=row.fieldValidation;
      row={...row,price:null,priceUnavailable:isInvoice?row.priceUnavailable:true,requiresReview:true,fieldValidation:{
        ...validation,priceStatus:'missing-unit-price',fields:{...validation.fields,
          price:validation.fields.price??{status:'missing',columnIndex:null,evidence:'missing',accuracy:0}},
      }};
    }
    if(isInvoice){
      // An invoice line must be fully understood before it can touch a
      // quote; unlabeled cells on it still need a person.
      if(row.details?.length)issues.push(`Unlabeled invoice details need identification: ${row.details.join(" | ").slice(0,100)}`);
      if(row.qty==null)issues.push("Invoice quantity or selling unit could not be verified from the source line");
      if(!row.code&&/^\d+[\s\-]/.test(row.description||""))issues.push("Vendor item code may have been included in the product description");
      if(row.qty!=null&&row.amount!=null&&row.price!=null&&Math.abs(row.qty*row.price-row.amount)>0.02)
        issues.push("Invoice quantity, unit price and extended total do not reconcile");
    }else if(documentKind==="pricelist"&&row.amount!=null&&row.price!=null&&row.amount!==row.price){
      issues.push("Two different prices were read from one line; verify that adjacent columns were not combined");
    }
    return {...row,issues};
  });
}

// Interpret only after the document has committed its structural placements.
export function interpretDocumentFields(document,procurement=getProcurementContext()){
  const {placementText,...result}=document;
  const documentUnit=documentQuoteUnit(placementText,procurement);
  const interpreted=result.rows.map(row=>interpretPlacedRow(row,procurement));
  const rows=["service-invoice","goods-invoice"].includes(result.mode)?interpreted:reviewUncertainRows(interpreted,result.documentKind);
  return {...result,rows:rows.map(row=>withRowValidation(applySourceUnits(row,{documentUnit},procurement)))};
}
