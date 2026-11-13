import {getProcurementContext} from "../procurement.js";
import {enrichFromInvoices} from "./invoice-evidence.js";
import {rememberImportRow} from "./catalog-fields.js";
import {resolveQuoteBasis} from "./quote-basis.js";
import {applySourceUnits,isOrderingQuoteUnit} from "./source-units.js";

// Preview and persistence take the same path, retaining the unmodified
// input separately in import_row.row for later source comparisons.
export function prepareImportRow(source,{prior=null,mapping=null,invoices=[],rawSource=source}={}, procurement=getProcurementContext()){
  const input=isOrderingQuoteUnit(source)?applySourceUnits(source,{},procurement):source;
  let row=enrichFromInvoices(input,invoices, procurement);
  if(prior)row={...row,resolvedVendorItemId:prior.id};
  row=rememberImportRow(row,prior,mapping, procurement);
  const resolved=resolveQuoteBasis(row,prior,procurement,rawSource);
  if(resolved)row={...row,sellingUnit:resolved.sellingUnit,
    sellingUnitSource:resolved.source==="confirmed vendor item"?"remembered":row.sellingUnitSource||"document",
    ...(resolved.unitRoot?{fieldEvidence:{...row.fieldEvidence,sellingUnit:resolved.unitRoot}}:{})};
  return row;
}
