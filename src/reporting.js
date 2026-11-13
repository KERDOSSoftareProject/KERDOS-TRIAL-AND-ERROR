import {blockReason,orderable} from "./core/ordering.js";
import {formatMoney} from "./localization.js";
import {PRODUCT_LABEL_METHOD} from "./core/label-association.js";

function csvEscape(value){const text=String(value??"");return /[",\n\r]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;}
function rowsToCSV(rows){return rows.map(row=>row.map(csvEscape).join(",")).join("\r\n");}

export function downloadTextFile(filename,content,mimeType){
  const url=URL.createObjectURL(new Blob([content],{type:`${mimeType};charset=utf-8;`}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download=filename;
  document.body.appendChild(anchor);anchor.click();anchor.remove();URL.revokeObjectURL(url);
}

export function buildCatalogExportCSV(productList,vendors){
  const rows=[["Item","Category","Best Price","Best Vendor","Best Per Unit","Status","Confidence",...vendors.map(vendor=>vendor.name)]];
  for(const item of productList){
    const cheapest=item.options.filter(orderable)[0]||item.options[0]||null;
    let status="No price on file",confidence="";
    if(cheapest){
      if(!orderable(cheapest))status=blockReason(cheapest);
      else if(cheapest.matchMethod===PRODUCT_LABEL_METHOD){status="Product label";confidence=`${cheapest.matchConfidence}%`;}
      else status="100% matched";
    }
    const vendorCells=vendors.map(vendor=>{const option=item.options.find(candidate=>candidate.vendorId===vendor.id);return option?.casePrice?formatMoney(option.casePrice):"";});
    const best=cheapest&&orderable(cheapest)?cheapest:null;
    rows.push([item.name,item.category,best?formatMoney(best.casePrice):"",best?best.vendorName:"",best?.perUnit?`${formatMoney(best.perUnit.price)}/${best.perUnit.unit}`:"",status,confidence,...vendorCells]);
  }
  return rowsToCSV(rows);
}

export function buildVarianceReportCSV(invoices,vendors){
  const vendorMap=new Map(vendors.map(vendor=>[vendor.id,vendor]));
  const rows=[["Date","Vendor","Invoice #","Item","Quoted Price","Quoted Date","Charged Price","Difference","Line Total Impact"]];
  for(const invoice of invoices)for(const line of invoice.invoice_lines||[]){
    if(line.price_variance==null||Math.abs(line.price_variance)<0.005)continue;
    const impact=line.price_variance*(line.line_total&&line.unit_price?line.line_total/line.unit_price:1);
    // Use the stored quoted rate (set at import time from the actual price-sheet row).
    // Legacy rows (imported before provenance was added) lack quoted_rate; label the
    // evidence unavailable rather than reconstructing it by arithmetic, which would
    // present a computed value as if it were a recorded quote.
    // price_variance itself is genuinely recorded and remains valid.
    const quotedPrice=line.quoted_rate!=null?line.quoted_rate:null;
    const quotedDate=line.quoted_effective_date||"";
    rows.push([invoice.invoice_date||"",vendorMap.get(invoice.vendor_id)?.name||"",invoice.invoice_number||"",line.description,quotedPrice!=null?formatMoney(quotedPrice):"",quotedDate,formatMoney(line.unit_price),formatMoney(line.price_variance),formatMoney(Math.round(impact*100)/100)]);
  }
  return rowsToCSV(rows);
}

export {buildVarianceReport,buildComparisonReportCSV} from './core/variance-report.js';
