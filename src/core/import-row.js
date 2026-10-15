import {enrichFromInvoices} from "./invoice-evidence.js";
import {rememberImportRow} from "./catalog-fields.js";
import {resolveQuoteBasis} from "./quote-basis.js";

// Preview and persistence take the same path, retaining the unmodified
// input separately in import_row.row for later source comparisons.
export function prepareImportRow(source,{prior=null,mapping=null,invoices=[]}={}){
  let row=enrichFromInvoices(source,invoices);
  if(prior)row={...row,resolvedVendorItemId:prior.id};
  row=rememberImportRow(row,prior,mapping);
  const resolved=resolveQuoteBasis(row,prior);
  if(resolved)row={...row,sellingUnit:resolved.sellingUnit,
    sellingUnitSource:resolved.source==="confirmed vendor item"?"remembered":row.sellingUnitSource||"document"};
  return row;
}
